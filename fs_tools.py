"""Filesystem tools merged into the everything-search MCP.

Read/stat/write/list operations on paths, with an optional root allowlist
(env EVERYTHING_MCP_ROOTS, ';'-separated). Empty = unrestricted read/write,
same trust level as the reference filesystem MCP.
"""

from __future__ import annotations

import os
import shutil
import sys


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


def find_by_frn(index, vol: str, frn: int) -> str | None:
    row = index.db.execute(
        "SELECT path FROM files WHERE vol=? AND frn=?", (vol, frn)
    ).fetchone()
    return (vol + "\\" + row[0]) if row else None
