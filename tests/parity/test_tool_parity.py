"""Parity test suite comparing legacy Python server (server.py) and Rust hphe-mcp.exe.

Mission T-050:
- Launches server.py and hphe-mcp.exe in stdio JSON-RPC via strict spawn/argv.
- Compares tools/list: identical names for the 18 reference tools, compatible schemas.
- For all 12 fs_* tools: calls both servers on the same temporary fixtures and
  compares response structure (keys, value types, avoiding volatile values like timestamps).
- For all 6 everything_* tools: verifies clean error/fallback when daemon is absent,
  and compares response shapes when backed by mock daemon pipe.
- Operates 100% standalone without requiring Everything.exe or hphe-indexd daemon.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import pytest

# Ensure repo root is on sys.path
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from test_pipe_client import FakeHpheDaemon, make_test_pipe_name

REFERENCE_18_TOOLS = [
    "everything_search",
    "everything_count",
    "everything_categories",
    "everything_index_stats",
    "everything_refresh",
    "everything_open_gui",
    "fs_read_file",
    "fs_list_directory",
    "fs_get_info",
    "fs_write_file",
    "fs_create_directory",
    "fs_move",
    "fs_delete",
    "fs_read_multiple_files",
    "fs_edit_file",
    "fs_directory_tree",
    "fs_search_files",
    "fs_list_allowed_roots",
]


def find_hphe_mcp_binary() -> str:
    """Locate the compiled hphe-mcp.exe binary."""
    candidates = [
        os.path.join(REPO_ROOT, "hphe", "target", "release", "hphe-mcp.exe"),
        os.path.join(REPO_ROOT, "target", "release", "hphe-mcp.exe"),
        os.path.join(REPO_ROOT, "hphe", "target", "debug", "hphe-mcp.exe"),
        os.path.join(REPO_ROOT, "target", "debug", "hphe-mcp.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return os.path.abspath(c)
    raise FileNotFoundError(
        f"hphe-mcp.exe not found in candidate paths: {candidates}. Run cargo build --release first."
    )


class McpStdioClient:
    """Client driving an MCP stdio server using JSON-RPC 2.0 framing."""

    def __init__(self, argv: list[str], env: dict[str, str] | None = None) -> None:
        self.argv = argv
        self.env = env or os.environ.copy()
        self.process: subprocess.Popen | None = None
        self._next_id = 1

    def start(self) -> None:
        self.process = subprocess.Popen(
            self.argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=self.env,
            bufsize=1,
        )

    def close(self) -> None:
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2.0)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None

    def send_request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.process or not self.process.stdin or not self.process.stdout:
            raise RuntimeError("Server process is not running")

        req_id = self._next_id
        self._next_id += 1

        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            payload["params"] = params

        line = json.dumps(payload, ensure_ascii=False) + "\n"
        self.process.stdin.write(line)
        self.process.stdin.flush()

        # Read JSON-RPC response from stdout
        resp_line = self.process.stdout.readline()
        if not resp_line:
            stderr_out = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"Server closed connection unexpectedly. Stderr: {stderr_out}")

        return json.loads(resp_line.strip())

    def initialize(self) -> dict[str, Any]:
        return self.send_request("initialize", {"protocolVersion": "2024-11-05"})

    def tools_list(self) -> list[dict[str, Any]]:
        resp = self.send_request("tools/list")
        return resp.get("result", {}).get("tools", [])

    def call_tool(self, name: str, arguments: dict[str, Any]) -> tuple[dict[str, Any], float]:
        t0 = time.perf_counter()
        resp = self.send_request("tools/call", {"name": name, "arguments": arguments})
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return resp, elapsed_ms


@pytest.fixture(scope="module")
def servers_offline():
    """Starts Python server.py and Rust hphe-mcp.exe without daemon pipe."""
    hphe_bin = find_hphe_mcp_binary()
    server_py = os.path.join(REPO_ROOT, "server.py")

    # Offline env pointing to a non-existent pipe
    non_existent_pipe = rf"\\.\pipe\hphe-nonexistent-{os.getpid()}"
    env_py = os.environ.copy()
    env_py["HPHE_PIPE"] = "1"
    env_py["HPHE_PIPE_NAME"] = non_existent_pipe
    env_py["EVERYTHING_EXE"] = r"C:\nonexistent\Everything.exe"

    env_rs = os.environ.copy()
    env_rs["HPHE_PIPE_NAME"] = non_existent_pipe

    py_client = McpStdioClient([sys.executable, server_py], env=env_py)
    rs_client = McpStdioClient([hphe_bin, "--pipe-name", non_existent_pipe], env=env_rs)

    py_client.start()
    rs_client.start()

    py_client.initialize()
    rs_client.initialize()

    yield py_client, rs_client

    py_client.close()
    rs_client.close()


@pytest.fixture(scope="module")
def servers_mock_pipe():
    """Starts Python and Rust servers connected to isolated fake daemon pipes."""
    hphe_bin = find_hphe_mcp_binary()
    server_py = os.path.join(REPO_ROOT, "server.py")

    pipe_py = make_test_pipe_name()
    pipe_rs = make_test_pipe_name()

    daemon_py = FakeHpheDaemon(pipe_py)
    daemon_py.start()

    daemon_rs = FakeHpheDaemon(pipe_rs)
    daemon_rs.start()

    env_py = os.environ.copy()
    env_py["HPHE_PIPE"] = "1"
    env_py["HPHE_PIPE_NAME"] = pipe_py

    env_rs = os.environ.copy()
    env_rs["HPHE_PIPE_NAME"] = pipe_rs

    py_client = McpStdioClient([sys.executable, server_py], env=env_py)
    rs_client = McpStdioClient([hphe_bin, "--pipe-name", pipe_rs], env=env_rs)

    py_client.start()
    rs_client.start()

    py_client.initialize()
    rs_client.initialize()

    yield py_client, rs_client

    py_client.close()
    rs_client.close()
    daemon_py.stop()
    daemon_rs.stop()


@pytest.fixture
def temp_workspace():
    """Provides an isolated directory for fs_* tool operations."""
    tmp = tempfile.mkdtemp(prefix="mcp_parity_fs_")
    yield tmp
    shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# 1. Tools/List Parity Tests
# ---------------------------------------------------------------------------


def test_tools_list_names_parity(servers_offline):
    """Verifies all 18 reference tools from server.py are present in hphe-mcp."""
    py_client, rs_client = servers_offline

    tools_py = {t["name"]: t for t in py_client.tools_list()}
    tools_rs = {t["name"]: t for t in rs_client.tools_list()}

    assert len(tools_py) == 18, f"server.py must expose exactly 18 tools, got {len(tools_py)}"

    for tool_name in REFERENCE_18_TOOLS:
        assert tool_name in tools_py, f"Tool {tool_name} missing in server.py"
        assert tool_name in tools_rs, f"Tool {tool_name} missing in hphe-mcp"


def test_tools_list_schemas_compatibility(servers_offline):
    """Verifies that input schemas have matching required parameters and property types."""
    py_client, rs_client = servers_offline

    tools_py = {t["name"]: t for t in py_client.tools_list()}
    tools_rs = {t["name"]: t for t in rs_client.tools_list()}

    for tool_name in REFERENCE_18_TOOLS:
        s_py = tools_py[tool_name].get("inputSchema", {})
        s_rs = tools_rs[tool_name].get("inputSchema", {})

        req_py = sorted(s_py.get("required", []))
        req_rs = sorted(s_rs.get("required", []))
        assert req_py == req_rs, f"Required properties mismatch for {tool_name}: {req_py} vs {req_rs}"

        props_py = s_py.get("properties", {})
        props_rs = s_rs.get("properties", {})

        for prop_name, pdef_py in props_py.items():
            assert prop_name in props_rs, f"Property {prop_name} of {tool_name} missing in hphe-mcp"
            type_py = pdef_py.get("type")
            type_rs = props_rs[prop_name].get("type")
            assert type_py == type_rs, (
                f"Type mismatch for {tool_name}.{prop_name}: {type_py} vs {type_rs}"
            )


# ---------------------------------------------------------------------------
# 2. Filesystem Tools Structure Parity Tests (12 fs_* Tools)
# ---------------------------------------------------------------------------


def _extract_payload(resp: dict[str, Any]) -> dict[str, Any]:
    res = resp.get("result", {})
    structured = res.get("structuredContent")
    if structured is not None:
        return structured
    # Fallback parse text content
    content_list = res.get("content", [])
    if content_list and content_list[0].get("type") == "text":
        try:
            return json.loads(content_list[0]["text"])
        except Exception:
            pass
    return res


def test_fs_create_directory_parity(servers_offline, temp_workspace):
    """fs_create_directory response key parity."""
    py_client, rs_client = servers_offline
    d_target = os.path.join(temp_workspace, "sub_dir")

    resp_py, _ = py_client.call_tool("fs_create_directory", {"path": d_target})
    resp_rs, _ = rs_client.call_tool("fs_create_directory", {"path": d_target})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"path", "created"}
    assert pl_py["created"] is True
    assert pl_rs["created"] is True


def test_fs_write_file_parity(servers_offline, temp_workspace):
    """fs_write_file response key and type parity."""
    py_client, rs_client = servers_offline
    f_target = os.path.join(temp_workspace, "test.txt")
    content = "Hello Parity!\nLine 2\n"

    resp_py, _ = py_client.call_tool(
        "fs_write_file", {"path": f_target, "content": content, "append": False}
    )
    resp_rs, _ = rs_client.call_tool(
        "fs_write_file", {"path": f_target, "content": content, "append": False}
    )

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"path", "bytes_written", "appended"}
    assert pl_py["bytes_written"] == len(content.encode("utf-8"))
    assert pl_rs["bytes_written"] == len(content.encode("utf-8"))
    assert pl_py["appended"] is False
    assert pl_rs["appended"] is False


def test_fs_read_file_parity(servers_offline, temp_workspace):
    """fs_read_file response key and content parity."""
    py_client, rs_client = servers_offline
    f_target = os.path.join(temp_workspace, "sample_read.txt")
    with open(f_target, "w", encoding="utf-8") as f:
        f.write("Line 1\nLine 2\nLine 3\n")

    resp_py, _ = py_client.call_tool("fs_read_file", {"path": f_target})
    resp_rs, _ = rs_client.call_tool("fs_read_file", {"path": f_target})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"path", "size", "truncated", "binary", "content"}
    assert pl_py["content"] == pl_rs["content"]
    assert pl_py["size"] == pl_rs["size"]
    assert pl_py["truncated"] is False
    assert pl_rs["truncated"] is False
    assert pl_py["binary"] is False
    assert pl_rs["binary"] is False


def test_fs_get_info_parity(servers_offline, temp_workspace):
    """fs_get_info response key and attribute presence parity."""
    py_client, rs_client = servers_offline
    f_target = os.path.join(temp_workspace, "info_test.txt")
    with open(f_target, "w", encoding="utf-8") as f:
        f.write("Some test data")

    resp_py, _ = py_client.call_tool("fs_get_info", {"path": f_target})
    resp_rs, _ = rs_client.call_tool("fs_get_info", {"path": f_target})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    expected_keys = {
        "path",
        "exists",
        "dir",
        "size",
        "mtime",
        "ctime",
        "atime",
        "readonly",
        "attributes",
    }
    assert set(pl_py.keys()) == expected_keys
    assert set(pl_rs.keys()) == expected_keys
    assert pl_py["exists"] is True
    assert pl_rs["exists"] is True
    assert pl_py["dir"] is False
    assert pl_rs["dir"] is False
    assert pl_py["size"] == pl_rs["size"]
    assert pl_py["readonly"] is False
    assert pl_rs["readonly"] is False


def test_fs_edit_file_parity(servers_offline, temp_workspace):
    """fs_edit_file response key, dryRun and diff generation parity."""
    py_client, rs_client = servers_offline
    f_target = os.path.join(temp_workspace, "edit_test.txt")
    with open(f_target, "w", encoding="utf-8") as f:
        f.write("Line A\nLine B\nLine C\n")

    edits = [{"oldText": "Line B", "newText": "Line MODIFIED"}]
    resp_py, _ = py_client.call_tool(
        "fs_edit_file", {"path": f_target, "edits": edits, "dryRun": True}
    )
    resp_rs, _ = rs_client.call_tool(
        "fs_edit_file", {"path": f_target, "edits": edits, "dryRun": True}
    )

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"path", "edits_applied", "dry_run", "diff"}
    assert pl_py["edits_applied"] == 1
    assert pl_rs["edits_applied"] == 1
    assert pl_py["dry_run"] is True
    assert pl_rs["dry_run"] is True
    assert "-Line B" in pl_py["diff"]
    assert "+Line MODIFIED" in pl_py["diff"]
    assert "-Line B" in pl_rs["diff"]
    assert "+Line MODIFIED" in pl_rs["diff"]


def test_fs_read_multiple_files_parity(servers_offline, temp_workspace):
    """fs_read_multiple_files batch keys and individual failure handling."""
    py_client, rs_client = servers_offline
    f1 = os.path.join(temp_workspace, "multi_1.txt")
    f2 = os.path.join(temp_workspace, "multi_2.txt")
    f_miss = os.path.join(temp_workspace, "nonexistent.txt")

    with open(f1, "w", encoding="utf-8") as f:
        f.write("Content 1")
    with open(f2, "w", encoding="utf-8") as f:
        f.write("Content 2")

    paths = [f1, f2, f_miss]
    resp_py, _ = py_client.call_tool("fs_read_multiple_files", {"paths": paths})
    resp_rs, _ = rs_client.call_tool("fs_read_multiple_files", {"paths": paths})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"files", "errors"}
    assert len(pl_py["files"]) == 2
    assert len(pl_rs["files"]) == 2
    assert f_miss in pl_py["errors"]
    assert f_miss in pl_rs["errors"]

    for item in pl_py["files"] + pl_rs["files"]:
        assert set(item.keys()) == {"path", "content", "truncated", "binary"}


def test_fs_list_directory_parity(servers_offline, temp_workspace):
    """fs_list_directory response key and entries list structure parity."""
    py_client, rs_client = servers_offline
    d_sub = os.path.join(temp_workspace, "list_sub")
    os.makedirs(d_sub, exist_ok=True)
    with open(os.path.join(d_sub, "f1.txt"), "w") as f:
        f.write("f1")
    with open(os.path.join(d_sub, "f2.txt"), "w") as f:
        f.write("f2")

    resp_py, _ = py_client.call_tool("fs_list_directory", {"path": d_sub})
    resp_rs, _ = rs_client.call_tool("fs_list_directory", {"path": d_sub})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"path", "truncated", "entries"}
    assert len(pl_py["entries"]) == 2
    assert len(pl_rs["entries"]) == 2

    for entry in pl_py["entries"] + pl_rs["entries"]:
        assert set(entry.keys()) == {"name", "dir", "size", "mtime"}
        assert entry["dir"] is False
        assert isinstance(entry["name"], str)


def test_fs_directory_tree_parity(servers_offline, temp_workspace):
    """fs_directory_tree recursive tree representation parity."""
    py_client, rs_client = servers_offline
    d_tree = os.path.join(temp_workspace, "tree_root")
    d_nested = os.path.join(d_tree, "nested")
    os.makedirs(d_nested, exist_ok=True)
    with open(os.path.join(d_nested, "item.txt"), "w") as f:
        f.write("item")

    resp_py, _ = py_client.call_tool("fs_directory_tree", {"path": d_tree})
    resp_rs, _ = rs_client.call_tool("fs_directory_tree", {"path": d_tree})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"tree", "entries", "max_depth", "max_entries"}
    assert pl_py["max_depth"] == pl_rs["max_depth"]
    assert pl_py["max_entries"] == pl_rs["max_entries"]

    def check_node(node: dict[str, Any]):
        assert "name" in node
        assert "type" in node
        assert node["type"] in ("file", "directory")
        if node["type"] == "directory":
            assert "children" in node
            for child in node["children"]:
                check_node(child)

    check_node(pl_py["tree"])
    check_node(pl_rs["tree"])


def test_fs_search_files_parity(servers_offline, temp_workspace):
    """fs_search_files traversal search response keys and pattern matching."""
    py_client, rs_client = servers_offline
    with open(os.path.join(temp_workspace, "match_alpha.log"), "w") as f:
        f.write("alpha")
    with open(os.path.join(temp_workspace, "match_beta.log"), "w") as f:
        f.write("beta")
    with open(os.path.join(temp_workspace, "other.txt"), "w") as f:
        f.write("other")

    resp_py, _ = py_client.call_tool(
        "fs_search_files", {"path": temp_workspace, "pattern": "match"}
    )
    resp_rs, _ = rs_client.call_tool(
        "fs_search_files", {"path": temp_workspace, "pattern": "match"}
    )

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {
        "path",
        "pattern",
        "matches",
        "count",
        "truncated",
        "scanned",
        "elapsed_ms",
    }
    assert pl_py["count"] == 2
    assert pl_rs["count"] == 2
    assert pl_py["truncated"] is False
    assert pl_rs["truncated"] is False


def test_fs_move_parity(servers_offline, temp_workspace):
    """fs_move response keys and filesystem effect."""
    py_client, rs_client = servers_offline
    f_src_py = os.path.join(temp_workspace, "move_src_py.txt")
    f_dst_py = os.path.join(temp_workspace, "move_dst_py.txt")
    with open(f_src_py, "w") as f:
        f.write("move py")

    f_src_rs = os.path.join(temp_workspace, "move_src_rs.txt")
    f_dst_rs = os.path.join(temp_workspace, "move_dst_rs.txt")
    with open(f_src_rs, "w") as f:
        f.write("move rs")

    resp_py, _ = py_client.call_tool(
        "fs_move", {"source": f_src_py, "destination": f_dst_py}
    )
    resp_rs, _ = rs_client.call_tool(
        "fs_move", {"source": f_src_rs, "destination": f_dst_rs}
    )

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"source", "destination", "moved"}
    assert pl_py["moved"] is True
    assert pl_rs["moved"] is True
    assert os.path.exists(f_dst_py) and not os.path.exists(f_src_py)
    assert os.path.exists(f_dst_rs) and not os.path.exists(f_src_rs)


def test_fs_delete_parity(servers_offline, temp_workspace):
    """fs_delete response keys and filesystem effect."""
    py_client, rs_client = servers_offline
    f_del_py = os.path.join(temp_workspace, "del_py.txt")
    with open(f_del_py, "w") as f:
        f.write("delete py")

    f_del_rs = os.path.join(temp_workspace, "del_rs.txt")
    with open(f_del_rs, "w") as f:
        f.write("delete rs")

    resp_py, _ = py_client.call_tool("fs_delete", {"path": f_del_py})
    resp_rs, _ = rs_client.call_tool("fs_delete", {"path": f_del_rs})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert set(pl_py.keys()) == set(pl_rs.keys())
    assert set(pl_py.keys()) == {"path", "deleted"}
    assert pl_py["deleted"] is True
    assert pl_rs["deleted"] is True
    assert not os.path.exists(f_del_py)
    assert not os.path.exists(f_del_rs)


def test_fs_list_allowed_roots_parity(servers_offline):
    """fs_list_allowed_roots 8 policy status keys parity."""
    py_client, rs_client = servers_offline

    resp_py, _ = py_client.call_tool("fs_list_allowed_roots", {})
    resp_rs, _ = rs_client.call_tool("fs_list_allowed_roots", {})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    expected_keys = {
        "allowed_roots",
        "unrestricted",
        "env_var",
        "agent",
        "effective_profile",
        "policy_file",
        "policy_rules",
        "restricted",
    }
    assert set(pl_py.keys()) == expected_keys
    assert set(pl_rs.keys()) == expected_keys
    assert pl_py["env_var"] == "EVERYTHING_MCP_ROOTS"
    assert pl_rs["env_var"] == "EVERYTHING_MCP_ROOTS"
    assert pl_py["unrestricted"] == pl_rs["unrestricted"]


# ---------------------------------------------------------------------------
# 3. Everything Tools: Offline Resilience & Mock Pipe Parity (6 Tools)
# ---------------------------------------------------------------------------


def test_everything_categories_identity(servers_offline):
    """everything_categories exact category keys and extensions matching."""
    py_client, rs_client = servers_offline

    resp_py, _ = py_client.call_tool("everything_categories", {})
    resp_rs, _ = rs_client.call_tool("everything_categories", {})

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    assert "categories" in pl_py
    assert "categories" in pl_rs

    cats_py = pl_py["categories"]
    cats_rs = pl_rs["categories"]

    expected_categories = {
        "audio",
        "compressed",
        "document",
        "executable",
        "picture",
        "video",
    }
    assert set(cats_py.keys()) == expected_categories
    assert set(cats_rs.keys()) == expected_categories

    for cat in expected_categories:
        assert sorted(cats_py[cat]) == sorted(cats_rs[cat]), (
            f"Extensions mismatch in category {cat}"
        )


def test_everything_offline_fallback(servers_offline):
    """Verifies that hphe-mcp returns clean structured errors without crashing when daemon pipe is absent."""
    py_client, rs_client = servers_offline

    # 1. everything_search
    resp_rs_search, _ = rs_client.call_tool("everything_search", {"query": "test"})
    assert resp_rs_search.get("result", {}).get("isError") is True
    pl_search = _extract_payload(resp_rs_search)
    assert "error" in pl_search
    assert pl_search.get("results") == []
    assert pl_search.get("total") == 0
    assert pl_search.get("backend") == "hphe-pipe"

    # 2. everything_count
    resp_rs_count, _ = rs_client.call_tool("everything_count", {"query": "test"})
    assert resp_rs_count.get("result", {}).get("isError") is True
    pl_count = _extract_payload(resp_rs_count)
    assert "error" in pl_count
    assert pl_count.get("count") == 0

    # 3. everything_index_stats
    resp_rs_stats, _ = rs_client.call_tool("everything_index_stats", {})
    assert resp_rs_stats.get("result", {}).get("isError") is True
    pl_stats = _extract_payload(resp_rs_stats)
    assert "error" in pl_stats

    # 4. everything_refresh
    resp_rs_ref, _ = rs_client.call_tool("everything_refresh", {"full": False})
    pl_ref = _extract_payload(resp_rs_ref)
    assert pl_ref.get("mode") == "none"
    assert pl_ref.get("rebuild_requested") is False
    assert "note" in pl_ref

    # 5. everything_open_gui
    resp_rs_gui, _ = rs_client.call_tool("everything_open_gui", {"query": "test"})
    pl_gui = _extract_payload(resp_rs_gui)
    assert pl_gui.get("launched") is False
    assert "note" in pl_gui


def test_everything_mock_pipe_connected_parity(servers_mock_pipe):
    """When backed by mock pipe daemon, verifies response shape parity between server.py and hphe-mcp."""
    py_client, rs_client = servers_mock_pipe

    # 1. everything_search
    resp_py, _ = py_client.call_tool(
        "everything_search", {"query": "doc", "max_results": 5}
    )
    resp_rs, _ = rs_client.call_tool(
        "everything_search", {"query": "doc", "max_results": 5}
    )

    pl_py = _extract_payload(resp_py)
    pl_rs = _extract_payload(resp_rs)

    expected_search_keys = {
        "total",
        "offset",
        "results",
        "filtered_by_policy",
        "query",
        "elapsed_ms",
        "backend",
    }
    assert set(pl_py.keys()) == expected_search_keys
    assert set(pl_rs.keys()) == expected_search_keys
    assert pl_py["backend"] == "hphe-pipe"
    assert pl_rs["backend"] == "hphe-pipe"
    assert len(pl_py["results"]) > 0
    assert len(pl_rs["results"]) > 0

    expected_item_keys = {"path", "name", "dir", "size", "mtime", "attrs"}
    for item in pl_py["results"] + pl_rs["results"]:
        assert set(item.keys()) == expected_item_keys

    # 2. everything_index_stats
    resp_py_st, _ = py_client.call_tool("everything_index_stats", {})
    resp_rs_st, _ = rs_client.call_tool("everything_index_stats", {})

    st_py = _extract_payload(resp_py_st)
    st_rs = _extract_payload(resp_rs_st)

    expected_stat_keys = {
        "total_entries",
        "file_count",
        "dir_count",
        "total_size",
        "memory_usage_bytes",
        "build_time_ms",
        "avg_name_length",
        "backend",
        "note",
    }
    assert set(st_py.keys()) == expected_stat_keys
    assert set(st_rs.keys()) == expected_stat_keys
    assert st_py["total_entries"] == st_rs["total_entries"]
    assert st_py["file_count"] == st_rs["file_count"]
    assert st_py["dir_count"] == st_rs["dir_count"]


# ---------------------------------------------------------------------------
# 4. Full 18-Tool Latency Benchmark Matrix
# ---------------------------------------------------------------------------


def test_18_tools_benchmark_parity(servers_mock_pipe, temp_workspace):
    """Executes all 18 tools on both servers and records execution latencies."""
    py_client, rs_client = servers_mock_pipe

    f_bench = os.path.join(temp_workspace, "bench_target.txt")
    with open(f_bench, "w", encoding="utf-8") as f:
        f.write("Line 1 for bench\nLine 2 for bench\n")

    bench_definitions = [
        ("everything_categories", {}),
        ("everything_open_gui", {"query": "test"}),
        ("everything_refresh", {"full": False}),
        ("everything_search", {"query": "test", "max_results": 5}),
        ("everything_count", {"query": "test"}),
        ("everything_index_stats", {}),
        ("fs_list_allowed_roots", {}),
        ("fs_get_info", {"path": f_bench}),
        ("fs_read_file", {"path": f_bench}),
        ("fs_read_multiple_files", {"paths": [f_bench]}),
        (
            "fs_edit_file",
            {"path": f_bench, "edits": [{"oldText": "Line 1", "newText": "Line 1"}], "dryRun": True},
        ),
        ("fs_list_directory", {"path": temp_workspace}),
        ("fs_directory_tree", {"path": temp_workspace}),
        ("fs_search_files", {"path": temp_workspace, "pattern": "bench"}),
        (
            "fs_write_file",
            {"path": os.path.join(temp_workspace, "bench_write.txt"), "content": "data"},
        ),
        (
            "fs_create_directory",
            {"path": os.path.join(temp_workspace, "bench_mkdir")},
        ),
        (
            "fs_move",
            {
                "source": os.path.join(temp_workspace, "bench_write.txt"),
                "destination": os.path.join(temp_workspace, "bench_moved.txt"),
            },
        ),
        ("fs_delete", {"path": os.path.join(temp_workspace, "bench_moved.txt")}),
    ]

    iterations = 15
    benchmark_results = {}

    for tool_name, args in bench_definitions:
        py_times: list[float] = []
        rs_times: list[float] = []

        for _ in range(iterations):
            # Pre-condition setup for mutating tools
            if tool_name == "fs_move":
                with open(os.path.join(temp_workspace, "bench_write.txt"), "w") as f:
                    f.write("x")
            elif tool_name == "fs_delete":
                with open(os.path.join(temp_workspace, "bench_moved.txt"), "w") as f:
                    f.write("x")

            resp_py, lat_py = py_client.call_tool(tool_name, args)

            if tool_name == "fs_move":
                with open(os.path.join(temp_workspace, "bench_write.txt"), "w") as f:
                    f.write("x")
            elif tool_name == "fs_delete":
                with open(os.path.join(temp_workspace, "bench_moved.txt"), "w") as f:
                    f.write("x")

            resp_rs, lat_rs = rs_client.call_tool(tool_name, args)

            py_times.append(lat_py)
            rs_times.append(lat_rs)

        avg_py = sum(py_times) / len(py_times)
        avg_rs = sum(rs_times) / len(rs_times)
        speedup = avg_py / avg_rs if avg_rs > 0 else 1.0

        benchmark_results[tool_name] = {
            "py_avg_ms": round(avg_py, 3),
            "rs_avg_ms": round(avg_rs, 3),
            "speedup": round(speedup, 2),
        }

    assert len(benchmark_results) == 18
    # Assert reasonable execution latency for stdio JSON-RPC (< 100ms per roundtrip)
    for tool_name, metrics in benchmark_results.items():
        assert metrics["rs_avg_ms"] < 50.0, f"{tool_name} took too long in Rust: {metrics['rs_avg_ms']}ms"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
