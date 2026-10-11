"""Filesystem tools merged into the everything-search MCP.

Read/stat/write/list/edit/tree/search operations on paths, with an optional
root allowlist (env EVERYTHING_MCP_ROOTS, ';'-separated). Empty = unrestricted
read/write, same trust level as the reference filesystem MCP.
"""

from __future__ import annotations

import difflib
import fnmatch
import os
import shutil
import sys
import time


def allowed_roots() -> list[str]:
    raw = os.environ.get("EVERYTHING_MCP_ROOTS", "").strip()
    if not raw:
        return []
    return [os.path.normcase(os.path.abspath(p)) for p in raw.split(";") if p.strip()]


def _check(path: str, write: bool = False) -> str:
    p = os.path.abspath(path)
    roots = allowed_roots()
    if roots:
        np = os.path.normcase(p)
        ok = False
        for r in roots:
            if np == r or np.startswith(r if r.endswith(os.sep) else r + os.sep):
                ok = True
                break
        if not ok:
            raise PermissionError(f"path outside allowed roots: {p}")
    return p


def _long(p: str) -> str:
    # \\?\ prefix enables >260 char paths on Windows
    if p.startswith("\\\\?\\") or p.startswith("\\\\"):
        return p
    return "\\\\?\\" + p


def fs_read_file(path: str, max_bytes: int = 1 << 20, encoding: str = "utf-8") -> dict:
    p = _check(path)
    size = os.path.getsize(_long(p))
    with open(_long(p), "rb") as f:
        data = f.read(max_bytes + 1)
    truncated = len(data) > max_bytes
    data = data[:max_bytes]
    try:
        text = data.decode(encoding)
        binary = False
    except (UnicodeDecodeError, LookupError):
        text = data.decode("utf-8", "replace")
        binary = True
    return {"path": p, "size": size, "truncated": truncated,
            "binary": binary, "content": text}


def fs_list_directory(path: str, max_entries: int = 1000) -> dict:
    p = _check(path)
    entries = []
    truncated = False
    with os.scandir(_long(p)) as it:
        for i, e in enumerate(it):
            if i >= max_entries:
                truncated = True
                break
            try:
                st = e.stat()
                entries.append({
                    "name": e.name,
                    "dir": e.is_dir(follow_symlinks=False),
                    "size": st.st_size if e.is_file(follow_symlinks=False) else None,
                    "mtime": st.st_mtime,
                })
            except OSError:
                entries.append({"name": e.name, "dir": e.is_dir(follow_symlinks=False), "size": None, "mtime": None})
    return {"path": p, "truncated": truncated, "entries": entries}


def fs_get_info(path: str) -> dict:
    p = _check(path)
    st = os.stat(_long(p))
    return {
        "path": p, "exists": True, "dir": os.path.isdir(_long(p)),
        "size": st.st_size, "mtime": st.st_mtime, "ctime": st.st_ctime,
        "atime": st.st_atime, "readonly": not bool(st.st_mode & 0o200),
        "attributes": oct(st.st_file_attributes) if hasattr(st, "st_file_attributes") else None,
    }


def fs_write_file(path: str, content: str, encoding: str = "utf-8", append: bool = False) -> dict:
    p = _check(path, write=True)
    mode = "ab" if append else "wb"
    parent = os.path.dirname(p)
    if parent:
        os.makedirs(_long(parent), exist_ok=True)
    with open(_long(p), mode) as f:
        n = f.write(content.encode(encoding))
    return {"path": p, "bytes_written": n, "appended": append}


def fs_create_directory(path: str) -> dict:
    p = _check(path, write=True)
    os.makedirs(_long(p), exist_ok=True)
    return {"path": p, "created": True}


def fs_move(source: str, destination: str, overwrite: bool = False) -> dict:
    src = _check(source, write=True)
    dst = _check(destination, write=True)
    if os.path.exists(_long(dst)) and not overwrite:
        raise FileExistsError(f"destination exists: {dst}")
    shutil.move(_long(src), _long(dst))
    return {"source": src, "destination": dst, "moved": True}


def fs_delete(path: str, recursive: bool = False) -> dict:
    p = _check(path, write=True)
    if os.path.isdir(_long(p)) and not os.path.islink(_long(p)):
        if not recursive:
            os.rmdir(_long(p))
        else:
            shutil.rmtree(_long(p))
    else:
        os.remove(_long(p))
    return {"path": p, "deleted": True}


def fs_read_multiple_files(paths: list[str], max_bytes: int = 1 << 20,
                           encoding: str = "utf-8") -> dict:
    """Read several files in one call; per-file failures don't stop the batch."""
    results, errors = [], {}
    for path in paths:
        try:
            r = fs_read_file(path, max_bytes, encoding)
            results.append({"path": r["path"], "content": r["content"],
                            "truncated": r["truncated"], "binary": r["binary"]})
        except OSError as e:
            errors[path] = f"{type(e).__name__}: {e}"
    return {"files": results, "errors": errors}


def _unified_diff(old: str, new: str, path: str) -> str:
    a = old.splitlines(keepends=True)
    b = new.splitlines(keepends=True)
    return "".join(difflib.unified_diff(
        a, b, fromfile="a/" + path, tofile="b/" + path, lineterm=""))


def fs_edit_file(path: str, edits: list[dict], dry_run: bool = False,
                 encoding: str = "utf-8") -> dict:
    """Exact-match line edits: each edit replaces the FIRST occurrence of
    oldText with newText. Returns a git-style diff; dry_run writes nothing."""
    p = _check(path, write=True)
    with open(_long(p), "rb") as f:
        original = f.read().decode(encoding)
    modified = original
    applied = []
    for i, edit in enumerate(edits):
        old, new = edit.get("oldText", ""), edit.get("newText", "")
        if old not in modified:
            raise ValueError(
                f"edit #{i}: oldText not found "
                f"({len(old)} chars): {old[:80]!r}")
        modified = modified.replace(old, new, 1)
        applied.append(i)
    diff = _unified_diff(original, modified, p)
    if not dry_run and modified != original:
        with open(_long(p), "wb") as f:
            f.write(modified.encode(encoding))
    return {"path": p, "edits_applied": len(applied), "dry_run": dry_run,
            "diff": diff}


def fs_directory_tree(path: str, max_depth: int = 8,
                      max_entries: int = 10_000) -> dict:
    """Recursive JSON tree. Bounded by max_depth / max_entries."""
    p = _check(path)
    counter = [0]

    def node(dpath: str, name: str, depth: int) -> dict:
        counter[0] += 1
        e = {"name": name}
        try:
            isdir = os.path.isdir(_long(dpath)) and not os.path.islink(_long(dpath))
        except OSError:
            isdir = False
        if not isdir:
            e["type"] = "file"
            return e
        e["type"] = "directory"
        e["children"] = []
        if depth >= max_depth or counter[0] >= max_entries:
            e["truncated"] = True
            return e
        try:
            with os.scandir(_long(dpath)) as it:
                entries = sorted(it, key=lambda x: (not x.is_dir(follow_symlinks=False),
                                                    x.name.lower()))
        except OSError:
            e["truncated"] = True
            return e
        for child in entries:
            if counter[0] >= max_entries:
                e["truncated"] = True
                break
            e["children"].append(node(child.path, child.name, depth + 1))
        return e

    return {"tree": node(p, os.path.basename(p.rstrip("\\/")) or p, 0),
            "entries": counter[0],
            "max_depth": max_depth, "max_entries": max_entries}


def fs_search_files(path: str, pattern: str,
                    exclude_patterns: list[str] | None = None,
                    max_results: int = 1000) -> dict:
    """Recursive case-insensitive partial-name search (traversal fallback).

    Slow by design - it walks the tree live. Prefer everything_search for
    name-based queries; this exists for parity / non-indexed locations.
    """
    p = _check(path)
    pat = pattern.lower()
    excl = exclude_patterns or []
    hits, scanned = [], 0
    t0 = time.time()
    stack = [p]
    while stack and len(hits) < max_results:
        dpath = stack.pop()
        try:
            with os.scandir(_long(dpath)) as it:
                entries = list(it)
        except OSError:
            continue
        for e in entries:
            scanned += 1
            nl = e.name.lower()
            if any(fnmatch.fnmatch(nl, x.lower()) for x in excl):
                continue
            try:
                isdir = e.is_dir(follow_symlinks=False)
            except OSError:
                isdir = False
            if isdir:
                stack.append(e.path)
            if pat in nl:
                hits.append(e.path[4:] if e.path.startswith("\\\\?\\") else e.path)
                if len(hits) >= max_results:
                    break
    return {"path": p, "pattern": pattern, "matches": hits,
            "count": len(hits), "truncated": len(hits) >= max_results,
            "scanned": scanned,
            "elapsed_ms": round((time.time() - t0) * 1000, 1)}


def fs_list_allowed_roots() -> dict:
    roots = allowed_roots()
    return {"allowed_roots": roots,
            "unrestricted": not roots,
            "env_var": "EVERYTHING_MCP_ROOTS"}
