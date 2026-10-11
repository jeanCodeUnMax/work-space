"""Preview server for the extension webview UI.

Serves the real media/panel.{css,js} in a plain browser with a stubbed
acquireVsCodeApi (see preview.html) so the panel can be iterated on outside
the IDE — backed by the REAL Everything index via everything_ipc.

Endpoints:
  GET  /            -> preview.html (panel DOM + vscode API stub)
  GET  /media/*     -> static files from ../media
  POST /api/search  -> {"query","sort","descending","max_results"} -> results payload
  POST /api/act     -> {"type":"open|openContaining|reveal","path","dir"} -> runs the real action

Usage: python extension/dev/serve_preview.py [--port 8787]
"""
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEV_DIR = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.dirname(DEV_DIR)
MEDIA_DIR = os.path.join(EXT_DIR, "media")
REPO_ROOT = os.path.dirname(EXT_DIR)
sys.path.insert(0, REPO_ROOT)

import everything_ipc  # noqa: E402

SORTS = {"name", "path", "ext", "date", "size"}


def _basename(p):
    return p.replace("/", "\\").rstrip("\\").rsplit("\\", 1)[-1]


def do_search(body):
    query = str(body.get("query") or "")
    if not query.strip():
        return {"total": 0, "results": [], "elapsed_ms": 0.0}
    sort = str(body.get("sort") or "name")
    if sort not in SORTS:
        sort = "name"
    max_results = int(body.get("max_results") or 500)
    t0 = time.time()
    raw = everything_ipc.search(
        query,
        max_results=max_results,
        sort=sort,
        descending=bool(body.get("descending")),
    )
    items = raw.get("results", [])
    results = [
        {
            "path": it["full_path"],
            "name": _basename(it["full_path"]),
            "dir": it["folder"],
            "size": it.get("size", 0),
            "mtime": it.get("date_modified"),
        }
        for it in items
    ]
    return {
        "total": raw.get("total", len(results)),
        "results": results,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


def do_act(body):
    p = body.get("path") or ""
    kind = body.get("type")
    if not p or not os.path.exists(p):
        return {"ok": False, "error": "path missing"}
    if kind == "openContaining" or kind == "reveal":
        subprocess.Popen(["explorer.exe", f"/select,{p}"])
    elif kind == "open":
        if body.get("dir"):
            subprocess.Popen(["explorer.exe", p])
        else:
            os.startfile(p)  # noqa: S606 - local preview only
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep stdout readable
        sys.stderr.write("[preview] " + (fmt % args) + "\n")

    def _send(self, code, data, ctype="application/json"):
        raw = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(DEV_DIR, "preview.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
            return
        if self.path.startswith("/media/"):
            name = self.path[len("/media/"):].split("?")[0]
            fpath = os.path.join(MEDIA_DIR, os.path.basename(name))
            if not os.path.isfile(fpath):
                self._send(404, {"error": "not found"})
                return
            ctype = "text/css" if name.endswith(".css") else \
                    "text/javascript" if name.endswith(".js") else \
                    "image/svg+xml" if name.endswith(".svg") else "application/octet-stream"
            with open(fpath, "rb") as f:
                self._send(200, f.read(), ctype)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, {"error": "bad json"})
            return
        if self.path == "/api/search":
            try:
                self._send(200, do_search(body))
            except Exception as e:  # IPC failure surfaces in the panel status bar
                self._send(200, {"total": 0, "results": [], "elapsed_ms": 0, "error": str(e)})
        elif self.path == "/api/act":
            self._send(200, do_act(body))
        else:
            self._send(404, {"error": "not found"})


def main():
    port = 8787
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[preview] http://127.0.0.1:{port} — real panel UI + live Everything index")
    srv.serve_forever()


if __name__ == "__main__":
    main()
