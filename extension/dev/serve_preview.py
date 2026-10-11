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


IMG_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "gif": "image/gif", "bmp": "image/bmp", "webp": "image/webp",
            "ico": "image/x-icon", "svg": "image/svg+xml"}


def do_preview(body):
    p = body.get("path") or ""
    e = (body.get("ext") or "").lower()
    try:
        size = os.path.getsize(p)
        if e in IMG_MIME:
            if size > 8 * 1024 * 1024:
                return {"path": p, "size": size, "error": "image too large (>8 MB)"}
            import base64
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            return {"path": p, "size": size, "kind": "image",
                    "data": f"data:{IMG_MIME[e]};base64,{b64}"}
        with open(p, "rb") as f:
            raw = f.read(64 * 1024)
        return {"path": p, "size": size, "kind": "text",
                "data": raw.decode("utf-8", errors="replace")}
    except Exception as ex:
        return {"path": p, "error": str(ex)}


def do_create(body):
    parent = body.get("parent") or ""
    name = str(body.get("name") or "").strip()
    import re
    if not parent or not name or re.search(r'[\\/:*?"<>|]', name):
        return {"ok": False, "error": "invalid name or target"}
    target = os.path.join(parent, name)
    try:
        if body.get("kind") == "dir":
            os.mkdir(target)
        else:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            os.close(fd)
        return {"ok": True, "path": target}
    except Exception as ex:
        return {"ok": False, "error": str(ex), "path": target}


def do_browse(body):
    p = body.get("path") or ""
    try:
        if not p:
            # PC level: drive letters (fixed, USB, network) + cloud/shell dirs
            import string
            results = [{"name": L + ":", "path": L + ":\\", "dir": True,
                        "size": 0, "ico": "💾"}
                       for L in string.ascii_uppercase[2:]
                       if os.path.exists(L + ":\\")]
            try:
                import re
                home = os.path.expanduser("~")
                for n in os.listdir(home):
                    fp = os.path.join(home, n)
                    if re.match(r'(?i)^(onedrive|google drive|dropbox|icloud)', n) \
                            and os.path.isdir(fp):
                        results.append({"name": n, "path": fp, "dir": True,
                                        "size": 0, "ico": "☁"})
            except OSError:
                pass
            return {"results": results, "total": len(results)}
        results = []
        with os.scandir(p) as it:
            for e in it:
                fp = e.path
                try:
                    st = e.stat()
                    size, mtime = st.st_size, st.st_mtime
                except OSError:
                    size, mtime = 0, None
                is_dir = e.is_dir()
                results.append({"name": e.name, "path": fp, "dir": is_dir,
                                "size": 0 if is_dir else size, "mtime": mtime})
        results.sort(key=lambda r: (not r["dir"], r["name"].lower()))
        return {"results": results, "total": len(results)}
    except Exception as ex:
        return {"error": str(ex)}


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
            # Inject the shared media/panel.html fragment (same DOM the
            # real webview loads) into the preview shell.
            with open(os.path.join(DEV_DIR, "preview.html"), "r", encoding="utf-8") as f:
                page = f.read()
            with open(os.path.join(MEDIA_DIR, "panel.html"), "r", encoding="utf-8") as f:
                body = f.read()
            page = page.replace("<!--PANEL_BODY-->", body)
            self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
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
        elif self.path == "/api/preview":
            self._send(200, do_preview(body))
        elif self.path == "/api/browse":
            self._send(200, do_browse(body))
        elif self.path == "/api/stat":
            p = body.get("path") or ""
            self._send(200, {"path": p, "dir": os.path.isdir(p)})
        elif self.path == "/api/create":
            self._send(200, do_create(body))
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
