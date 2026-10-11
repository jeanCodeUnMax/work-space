"""everything-search MCP server (stdio, NDJSON JSON-RPC).

Thin client over the running Everything.exe: queries go through the
official WM_COPYDATA IPC (QUERY2) protocol, the same one the GUI and the
Everything SDK use. The Everything service keeps its NTFS index live at
all times - no admin rights, no local index, no rebuilds needed here.
Search latency is milliseconds, identical to the Everything GUI.

Zero-dependency: Python 3.11+ stdlib only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import traceback

# MCP stdio requires UTF-8 - Windows pipes default to cp1252 and crash or emit
# invalid bytes on any non-ASCII path (accented/CJK/emoji filenames).
sys.stdin.reconfigure(encoding="utf-8", errors="replace")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from categories import CATEGORIES
import fs_tools
import everything_ipc
from everything_ipc import EverythingIPC, EverythingError

EVERYTHING_EXE = os.environ.get(
    "EVERYTHING_EXE", r"C:\Program Files\Everything\Everything.exe"
)

_ipc: EverythingIPC | None = None


def get_ipc() -> EverythingIPC:
    global _ipc
    if _ipc is None:
        _ipc = EverythingIPC.get()
    return _ipc


# ---------------------------------------------------------------------------
# Query translation: the server's old custom syntax mostly maps 1:1 onto
# Everything's native modifiers. `matchpath:` has no native modifier - it
# becomes the MATCHPATH search flag (match terms against the full path).
# ---------------------------------------------------------------------------

def _translate_query(query: str) -> tuple[str, int]:
    flags = 0
    out = []
    for tok in query.split():
        low = tok.lower()
        if low in ("matchpath:", "matchpath"):
            flags |= everything_ipc.MATCHPATH
        else:
            out.append(tok)
    return " ".join(out), flags


def _basename(full: str) -> str:
    i = full.rfind("\\")
    return full[i + 1:] if i >= 0 else full


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def tool_search(args: dict) -> dict:
    ipc = get_ipc()
    raw = args.get("query", "")
    max_results = min(int(args.get("max_results", 100)), 10_000)
    offset = int(args.get("offset", 0))
    sort = str(args.get("sort", "name"))
    descending = bool(args.get("descending", False))

    query, sflags = _translate_query(raw)
    t0 = time.time()
    r = everything_ipc.search(
        query, max_results=max_results, offset=offset,
        sort=sort, descending=descending, search_flags=sflags,
    )
    results = [
        {
            "path": it["full_path"],
            "name": _basename(it["full_path"]),
            "dir": it["folder"],
            "size": it.get("size"),
            "mtime": it.get("date_modified"),
            "attrs": it.get("attributes"),
        }
        for it in r["results"]
        if fs_tools.path_allowed(it["full_path"])
    ]
    filtered = len(r["results"]) - len(results)
    return {
        "total": r["total"],
        "offset": offset,
        "results": results,
        "filtered_by_policy": filtered or None,
        "query": raw,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
        "backend": "everything-ipc",
    }


def tool_count(args: dict) -> dict:
    get_ipc()
    query, sflags = _translate_query(args.get("query", ""))
    return {"count": everything_ipc.count(query, search_flags=sflags),
            "query": args.get("query", "")}


def tool_categories(_args: dict) -> dict:
    return {"categories": {k: v for k, v in CATEGORIES.items()}}


def tool_index_stats(_args: dict) -> dict:
    ipc = get_ipc()
    st = ipc.status()
    st["total"] = everything_ipc.count("")
    st["backend"] = "everything-ipc"
    st["note"] = (
        "index is maintained live by the Everything service; "
        "no local index, no rebuild, no admin required"
    )
    return st


def tool_refresh(args: dict) -> dict:
    ipc = get_ipc()
    if bool(args.get("full", False)):
        # equivalent of a full re-enumeration, done by Everything itself
        ipc.rebuild_db()
        return {"mode": "full", "rebuild_requested": True,
                "stats": ipc.status()}
    # Everything's service applies USN deltas continuously - nothing to do
    ipc.save_db()
    return {"mode": "none", "stats": ipc.status(),
            "note": "index is always live; save_db requested"}


def tool_open_gui(args: dict) -> dict:
    query = args.get("query", "")
    exe = everything_ipc.find_everything_exe() or EVERYTHING_EXE
    if not os.path.exists(exe):
        return {"error": f"Everything.exe not found at {exe}"}
    cmd = [exe]
    if query:
        cmd += ["-s", query]
    subprocess.Popen(cmd, creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
    return {"launched": True, "exe": exe, "query": query}


def tool_fs_read(args: dict) -> dict:
    return fs_tools.fs_read_file(
        args["path"], int(args.get("max_bytes", 1 << 20)), args.get("encoding", "utf-8")
    )


def tool_fs_list(args: dict) -> dict:
    return fs_tools.fs_list_directory(args["path"], int(args.get("max_entries", 1000)))


def tool_fs_info(args: dict) -> dict:
    return fs_tools.fs_get_info(args["path"])


def tool_fs_write(args: dict) -> dict:
    return fs_tools.fs_write_file(
        args["path"], args.get("content", ""),
        args.get("encoding", "utf-8"), bool(args.get("append", False)),
    )


def tool_fs_mkdir(args: dict) -> dict:
    return fs_tools.fs_create_directory(args["path"])


def tool_fs_move(args: dict) -> dict:
    return fs_tools.fs_move(args["source"], args["destination"], bool(args.get("overwrite", False)))


def tool_fs_delete(args: dict) -> dict:
    return fs_tools.fs_delete(args["path"], bool(args.get("recursive", False)))


def tool_fs_read_multi(args: dict) -> dict:
    return fs_tools.fs_read_multiple_files(
        args["paths"], int(args.get("max_bytes", 1 << 20)),
        args.get("encoding", "utf-8"),
    )


def tool_fs_edit(args: dict) -> dict:
    return fs_tools.fs_edit_file(
        args["path"], args.get("edits", []),
        bool(args.get("dryRun", args.get("dry_run", False))),
        args.get("encoding", "utf-8"),
    )


def tool_fs_tree(args: dict) -> dict:
    return fs_tools.fs_directory_tree(
        args["path"], int(args.get("max_depth", 8)),
        int(args.get("max_entries", 10_000)),
    )


def tool_fs_search(args: dict) -> dict:
    return fs_tools.fs_search_files(
        args["path"], args.get("pattern", ""),
        args.get("excludePatterns"), int(args.get("max_results", 1000)),
    )


def tool_fs_roots(_args: dict) -> dict:
    return fs_tools.fs_list_allowed_roots()


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

def _s(t, **kw):
    d = {"type": t}
    d.update(kw)
    return d


def _props(**kw):
    return {"type": "object", "properties": kw}


TOOLS = [
    {
        "name": "everything_search",
        "description": (
            "Ultra-fast file search across all local NTFS volumes, powered "
            "directly by the running Everything.exe index via its IPC "
            "protocol (same index and speed as the Everything GUI - "
            "typically <50 ms, no admin needed). Supports the full native "
            "Everything query syntax: wildcards *, ?, a|b (OR), !not, "
            "ext:a;b, size:>10mb, dm:today, path:, parent:, regex:, case:, "
            "ww:, startwith:, endwith:, folder:, file:, and categories "
            "audio: video: document: executable: picture: compressed:. "
            "Returns full path, dir flag, size and mtime."
        ),
        "inputSchema": _props(
            query=_s("string", description="Everything query syntax. Empty = everything."),
            max_results=_s("integer", description="Max rows to return (default 100, cap 10000)", default=100),
            offset=_s("integer", default=0),
            sort=_s("string", enum=["name", "path", "ext", "date", "size"], default="name"),
            descending=_s("boolean", default=False),
            stat=_s("boolean", description="Accepted for compatibility; size/mtime already come from the index", default=True),
            refresh=_s("boolean", description="Accepted for compatibility; the index is always live", default=True),
        ),
        "annotations": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "everything_count",
        "description": "Count files/dirs matching an Everything query without returning rows.",
        "inputSchema": _props(query=_s("string", default="")),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "everything_categories",
        "description": "List the Everything-compatible filter categories and their extension sets.",
        "inputSchema": _props(),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "everything_index_stats",
        "description": "Report Everything service status: version, db loaded/busy, total indexed entries.",
        "inputSchema": _props(),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "everything_refresh",
        "description": "Ask Everything to save its db (default) or trigger a full index rebuild (full=true).",
        "inputSchema": _props(
            full=_s("boolean", default=False),
            volume=_s("string", description="Accepted for compatibility; rebuild is all volumes"),
        ),
        "annotations": {"readOnlyHint": False, "idempotentHint": True},
    },
    {
        "name": "everything_open_gui",
        "description": "Launch Everything.exe (optionally pre-filled with a search) to visualize results in the GUI.",
        "inputSchema": _props(query=_s("string", default="")),
        "annotations": {"readOnlyHint": False},
    },
    {
        "name": "fs_read_file",
        "description": "Read a file's content (utf-8 text by default, truncated at max_bytes).",
        "inputSchema": _props(
            path=_s("string"),
            max_bytes=_s("integer", default=1048576),
            encoding=_s("string", default="utf-8"),
            required=["path"],
        ),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_list_directory",
        "description": "List a directory's entries (name, dir flag, size, mtime).",
        "inputSchema": _props(
            path=_s("string"),
            max_entries=_s("integer", default=1000),
            required=["path"],
        ),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_get_info",
        "description": "Stat a path: size, times, attributes, readonly.",
        "inputSchema": _props(path=_s("string"), required=["path"]),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_write_file",
        "description": "Write text content to a file (creates parent dirs; optional append).",
        "inputSchema": _props(
            path=_s("string"),
            content=_s("string"),
            encoding=_s("string", default="utf-8"),
            append=_s("boolean", default=False),
            required=["path", "content"],
        ),
        "annotations": {"destructiveHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_create_directory",
        "description": "Create a directory (parents included, idempotent).",
        "inputSchema": _props(path=_s("string"), required=["path"]),
        "annotations": {"destructiveHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_move",
        "description": "Move/rename a file or directory.",
        "inputSchema": _props(
            source=_s("string"),
            destination=_s("string"),
            overwrite=_s("boolean", default=False),
            required=["source", "destination"],
        ),
        "annotations": {"destructiveHint": True, "idempotentHint": False},
    },
    {
        "name": "fs_delete",
        "description": "Delete a file, or a directory (empty, or recursive=true).",
        "inputSchema": _props(
            path=_s("string"),
            recursive=_s("boolean", default=False),
            required=["path"],
        ),
        "annotations": {"destructiveHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_read_multiple_files",
        "description": "Read several files in one call; individual failures don't stop the batch.",
        "inputSchema": _props(
            paths=_s("array", items={"type": "string"}),
            max_bytes=_s("integer", default=1048576),
            encoding=_s("string", default="utf-8"),
            required=["paths"],
        ),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_edit_file",
        "description": "Exact-match edits: each edit replaces the first occurrence of oldText with newText; returns a git-style diff. dryRun previews without writing.",
        "inputSchema": _props(
            path=_s("string"),
            edits=_s("array", items={"type": "object",
                     "properties": {"oldText": _s("string"), "newText": _s("string")},
                     "required": ["oldText", "newText"]}),
            dryRun=_s("boolean", default=False),
            encoding=_s("string", default="utf-8"),
            required=["path", "edits"],
        ),
        "annotations": {"destructiveHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_directory_tree",
        "description": "Recursive JSON tree of a directory (name/type/children), bounded by max_depth and max_entries.",
        "inputSchema": _props(
            path=_s("string"),
            max_depth=_s("integer", default=8),
            max_entries=_s("integer", default=10000),
            required=["path"],
        ),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_search_files",
        "description": "Recursive traversal search by partial name (case-insensitive). SLOW on large trees - prefer everything_search. Use for off-index locations or exact partial-name parity.",
        "inputSchema": _props(
            path=_s("string"),
            pattern=_s("string"),
            excludePatterns=_s("array", items={"type": "string"}),
            max_results=_s("integer", default=1000),
            required=["path", "pattern"],
        ),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "fs_list_allowed_roots",
        "description": "List the EVERYTHING_MCP_ROOTS allowlist for fs_* tools (empty = unrestricted).",
        "inputSchema": _props(),
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
]

_HANDLERS = {
    "everything_search": tool_search,
    "everything_count": tool_count,
    "everything_categories": tool_categories,
    "everything_index_stats": tool_index_stats,
    "everything_refresh": tool_refresh,
    "everything_open_gui": tool_open_gui,
    "fs_read_file": tool_fs_read,
    "fs_list_directory": tool_fs_list,
    "fs_get_info": tool_fs_info,
    "fs_write_file": tool_fs_write,
    "fs_create_directory": tool_fs_mkdir,
    "fs_move": tool_fs_move,
    "fs_delete": tool_fs_delete,
    "fs_read_multiple_files": tool_fs_read_multi,
    "fs_edit_file": tool_fs_edit,
    "fs_directory_tree": tool_fs_tree,
    "fs_search_files": tool_fs_search,
    "fs_list_allowed_roots": tool_fs_roots,
}


def _fix_schemas():
    # move "required" out of property defs into the object schema
    for t in TOOLS:
        sch = t["inputSchema"]
        req = sch.get("properties", {}).pop("required", None)
        if req:
            sch["required"] = req


_fix_schemas()


# ---------------------------------------------------------------------------
# JSON-RPC stdio loop (NDJSON)
# ---------------------------------------------------------------------------

def _respond(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _tool_result(payload) -> dict:
    if isinstance(payload, str):
        text = payload
        structured = None
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=1)
        structured = payload
    is_err = isinstance(payload, dict) and "error" in payload
    r = {"content": [{"type": "text", "text": text}]}
    if structured is not None:
        r["structuredContent"] = structured
    if is_err:
        r["isError"] = True
    return r


def handle(msg: dict) -> None:
    method = msg.get("method", "")
    msg_id = msg.get("id")

    if method == "initialize":
        _respond(msg_id, {
            "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "everything-search", "version": "2.0.0"},
            "instructions": (
                "Ultra-fast NTFS file search powered by the live "
                "Everything.exe index via IPC (Everything query syntax, "
                "ms latency, no admin). Use everything_search for instant "
                "queries."
            ),
        })
        return
    if method.startswith("notifications/"):
        return
    if method == "ping":
        _respond(msg_id, {})
        return
    if method == "tools/list":
        _respond(msg_id, {"tools": TOOLS})
        return
    if method == "resources/list":
        _respond(msg_id, {"resources": []})
        return
    if method == "prompts/list":
        _respond(msg_id, {"prompts": []})
        return
    if method == "tools/call":
        params = msg.get("params", {})
        name = params.get("name", "")
        args = params.get("arguments", {}) or {}
        fn = _HANDLERS.get(name)
        if fn is None:
            _respond(msg_id, error={"code": -32602, "message": f"unknown tool {name}"})
            return
        try:
            _respond(msg_id, _tool_result(fn(args)))
        except EverythingError as e:
            _respond(msg_id, _tool_result({"error": str(e)}))
        except PermissionError as e:
            _respond(msg_id, _tool_result({"error": str(e)}))
        except Exception as e:  # noqa: BLE001
            _respond(msg_id, _tool_result({
                "error": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc(limit=5),
            }))
        return
    if method in ("shutdown", "exit"):
        if msg_id is not None:
            _respond(msg_id, None)
        os._exit(0)
    if msg_id is not None:
        _respond(msg_id, error={"code": -32601, "message": f"method not found: {method}"})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle(msg)
        except Exception:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
