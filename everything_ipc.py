"""Everything IPC client - queries the live index of the running
Everything.exe via WM_COPYDATA (the official QUERY2 protocol used by the
GUI and the Everything SDK).

Replaces the old self-built NTFS index: no admin rights needed, no SQLite,
no USN journaling, no rebuilds - Everything's own service keeps the index
up to date continuously. Queries return in milliseconds.

Requires Everything.exe (1.4.1+) to be running.
"""

import ctypes
import ctypes.wintypes as w
import os
import struct
import threading
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

WM_COPYDATA = 0x004A
WM_USER = 0x0400
SMTO_ABORTIFHUNG = 0x0002
HWND_MESSAGE = -3
EVERYTHING_WNDCLASS = "EVERYTHING_TASKBAR_NOTIFICATION"

# COPYDATA dwData
EVERYTHING_IPC_COPYDATA_QUERY2W = 18

# search_flags
MATCHCASE = 0x01
MATCHWHOLEWORD = 0x02
MATCHPATH = 0x04
REGEX = 0x08
MATCHACCENTS = 0x10
MATCHPREFIX = 0x40
MATCHSUFFIX = 0x80

# request flags
REQ_NAME = 0x01
REQ_PATH = 0x02
REQ_FULL_PATH_AND_NAME = 0x04
REQ_EXTENSION = 0x08
REQ_SIZE = 0x10
REQ_DATE_CREATED = 0x20
REQ_DATE_MODIFIED = 0x40
REQ_DATE_ACCESSED = 0x80
REQ_ATTRIBUTES = 0x100

ALLRESULTS = 0xFFFFFFFF

# sort types
SORT = {
    "name": 1,
    "path": 3,
    "size": 5,
    "ext": 7,
    "extension": 7,
    "date_created": 11,
    "date_modified": 13,
    "date": 13,
    "attributes": 15,
    "run_count": 19,
    "date_recently_changed": 21,
    "date_accessed": 23,
}

# WM_USER (EVERYTHING_WM_IPC) query codes - plain SendMessage, lParam=0
IPC_GET_MAJOR_VERSION = 0
IPC_GET_MINOR_VERSION = 1
IPC_GET_REVISION = 2
IPC_GET_BUILD_NUMBER = 3
IPC_GET_TARGET_MACHINE = 5
IPC_IS_DB_LOADED = 401
IPC_IS_DB_BUSY = 402
IPC_IS_ADMIN = 403
IPC_REBUILD_DB = 405
IPC_SAVE_DB = 407

FILETIME_EPOCH_DELTA = 116444736000000000  # 1601 -> 1970 in 100ns units

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, w.HWND, w.UINT, w.WPARAM, w.LPARAM)

user32.DefWindowProcW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.SendMessageTimeoutW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPCVOID,
                                     w.UINT, w.UINT,
                                     ctypes.POINTER(ctypes.c_size_t)]
user32.SendMessageTimeoutW.restype = LRESULT
user32.SendMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
user32.SendMessageW.restype = LRESULT
user32.FindWindowW.argtypes = [w.LPCWSTR, w.LPCWSTR]
user32.FindWindowW.restype = w.HWND
user32.CreateWindowExW.restype = w.HWND
user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
user32.GetWindowThreadProcessId.restype = w.DWORD
kernel32.QueryFullProcessImageNameW.argtypes = [
    w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
kernel32.QueryFullProcessImageNameW.restype = w.BOOL
kernel32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel32.OpenProcess.restype = w.HANDLE
kernel32.CloseHandle.argtypes = [w.HANDLE]

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def find_everything_exe() -> str | None:
    """Locate Everything.exe wherever it was installed.

    Resolution order: the running process's own image path (works for any
    custom install dir), the EVERYTHING_EXE env var, the uninstaller's
    InstallLocation registry keys, then the stock install paths.
    """
    hwnd = user32.FindWindowW(EVERYTHING_WNDCLASS, None)
    if hwnd:
        pid = w.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if h:
            try:
                buf = ctypes.create_unicode_buffer(1024)
                n = w.DWORD(len(buf))
                if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                    return buf.value
            finally:
                kernel32.CloseHandle(h)
    env = os.environ.get("EVERYTHING_EXE", "").strip()
    if env and os.path.exists(env):
        return env
    import winreg
    for root, view in (
        (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_CURRENT_USER, 0),
    ):
        try:
            with winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Everything",
                                0, winreg.KEY_READ | view) as k:
                loc = winreg.QueryValueEx(k, "InstallLocation")[0]
            exe = os.path.join(loc, "Everything.exe")
            if os.path.exists(exe):
                return exe
        except OSError:
            pass
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                 os.environ.get("LOCALAPPDATA")):
        if base:
            exe = os.path.join(base, "Everything", "Everything.exe")
            if os.path.exists(exe):
                return exe
    return None


class COPYDATASTRUCT(ctypes.Structure):
    _fields_ = [
        ("dwData", ctypes.c_size_t),
        ("cbData", w.DWORD),
        ("lpData", ctypes.c_void_p),
    ]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", w.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", w.HINSTANCE),
        ("hIcon", w.HANDLE),
        ("hCursor", w.HANDLE),
        ("hbrBackground", w.HANDLE),
        ("lpszMenuName", w.LPCWSTR),
        ("lpszClassName", w.LPCWSTR),
    ]


class EverythingError(RuntimeError):
    pass


def _filetime_to_epoch(ft: int) -> float:
    return (ft - FILETIME_EPOCH_DELTA) / 10_000_000.0


class EverythingIPC:
    """One hidden message window on a daemon thread; queries are serialized
    (Everything cancels a previous query on the same reply window anyway)."""

    _instance = None
    _inst_lock = threading.Lock()

    @classmethod
    def get(cls) -> "EverythingIPC":
        with cls._inst_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def __init__(self, timeout: float = 15.0):
        self._timeout = timeout
        self._hwnd = None
        self._ready = threading.Event()
        self._query_lock = threading.Lock()
        self._reply_event = threading.Event()
        self._reply_id = 0
        self._reply_data = None
        self._wndproc_cb = WNDPROC(self._wndproc)
        self._thread = threading.Thread(target=self._window_thread,
                                        daemon=True,
                                        name="everything-ipc")
        self._thread.start()
        if not self._ready.wait(10):
            raise EverythingError("failed to create IPC reply window")

    # -- window thread --------------------------------------------------------

    def _wndproc(self, hwnd, msg, wp, lp):
        if msg == WM_COPYDATA:
            cds = COPYDATASTRUCT.from_address(lp)
            if cds.dwData == self._reply_id:
                self._reply_data = ctypes.string_at(cds.lpData, cds.cbData)
                self._reply_event.set()
                return 1
        return user32.DefWindowProcW(hwnd, msg, wp, lp)

    def _window_thread(self):
        hinst = ctypes.windll.kernel32.GetModuleHandleW(None)
        wc = WNDCLASSW()
        wc.lpfnWndProc = self._wndproc_cb
        wc.hInstance = hinst
        wc.lpszClassName = "EverythingMcpIpc"
        if not user32.RegisterClassW(ctypes.byref(wc)):
            err = ctypes.GetLastError()
            if err != 1410:  # ERROR_CLASS_ALREADY_EXISTS
                self._ready.set()
                return
        self._hwnd = user32.CreateWindowExW(0, "EverythingMcpIpc", "", 0,
                                            0, 0, 0, 0, w.HWND(HWND_MESSAGE),
                                            None, hinst, None)
        self._ready.set()
        msg = w.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0):
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    # -- protocol -------------------------------------------------------------

    @staticmethod
    def _everything_hwnd():
        h = user32.FindWindowW(EVERYTHING_WNDCLASS, None)
        if not h:
            raise EverythingError(
                "Everything.exe is not running (no EVERYTHING_TASKBAR_NOTIFICATION window)"
            )
        return h

    def ipc_call(self, code: int, lparam: int = 0) -> int:
        """Plain EVERYTHING_WM_IPC SendMessage - version, db status, rebuild."""
        ehwnd = self._everything_hwnd()
        r = user32.SendMessageTimeoutW(ehwnd, WM_USER, code, lparam,
                                     SMTO_ABORTIFHUNG, 5000, None)
        return int(r)

    def version(self) -> str:
        return ".".join(str(self.ipc_call(c)) for c in (
            IPC_GET_MAJOR_VERSION, IPC_GET_MINOR_VERSION,
            IPC_GET_REVISION, IPC_GET_BUILD_NUMBER))

    def status(self) -> dict:
        return {
            "version": self.version(),
            "db_loaded": bool(self.ipc_call(IPC_IS_DB_LOADED)),
            "db_busy": bool(self.ipc_call(IPC_IS_DB_BUSY)),
            "everything_is_admin": bool(self.ipc_call(IPC_IS_ADMIN)),
        }

    def rebuild_db(self) -> None:
        self.ipc_call(IPC_REBUILD_DB)

    def save_db(self) -> None:
        self.ipc_call(IPC_SAVE_DB)

    def query(self, search: str, max_results: int = 100, offset: int = 0,
              search_flags: int = 0, request_flags: int = REQ_FULL_PATH_AND_NAME,
              sort_type: int = 1) -> dict:
        """Send a QUERY2 and parse the LIST2 reply.
        Returns {'total': int, 'results': [item, ...]} where each item is a
        dict with the requested fields."""
        ehwnd = self._everything_hwnd()
        with self._query_lock:
            self._reply_event.clear()
            self._reply_data = None
            self._reply_id = (self._reply_id + 1) & 0x7FFFFFFF or 1

            text = search.encode("utf-16-le") + b"\x00\x00"
            qsize = 28 + len(text)
            buf = (ctypes.c_char * qsize)()
            ctypes.memmove(ctypes.addressof(buf) + 28, text, len(text))
            ctypes.memmove(
                buf,
                struct.pack("<7I", int(self._hwnd), self._reply_id,
                            search_flags, offset, max_results,
                            request_flags, sort_type),
                28,
            )
            cds = COPYDATASTRUCT(EVERYTHING_IPC_COPYDATA_QUERY2W, qsize,
                                 ctypes.addressof(buf))
            ok = user32.SendMessageTimeoutW(ehwnd, WM_COPYDATA, self._hwnd,
                                            ctypes.byref(cds), SMTO_ABORTIFHUNG,
                                            int(self._timeout * 1000), None)
            if not ok:
                raise EverythingError(
                    f"Everything rejected the query (err {ctypes.GetLastError()})"
                )
            if not self._reply_event.wait(self._timeout):
                raise EverythingError("timed out waiting for Everything reply")
            data = self._reply_data

        return self._parse(data, request_flags)

    @staticmethod
    def _parse(data: bytes, request_flags: int) -> dict:
        tot, num, off, _req, _sort = struct.unpack_from("<5I", data, 0)
        pos = 20
        items = []
        for _ in range(num):
            iflags, data_off = struct.unpack_from("<2I", data, pos)
            pos += 8
            p = data_off
            item = {"folder": bool(iflags & 1)}
            if request_flags & REQ_NAME:
                n = struct.unpack_from("<I", data, p)[0]; p += 4
                item["name"] = data[p:p + n * 2].decode("utf-16-le"); p += n * 2 + 2
            if request_flags & REQ_PATH:
                n = struct.unpack_from("<I", data, p)[0]; p += 4
                item["path"] = data[p:p + n * 2].decode("utf-16-le"); p += n * 2 + 2
            if request_flags & REQ_FULL_PATH_AND_NAME:
                n = struct.unpack_from("<I", data, p)[0]; p += 4
                item["full_path"] = data[p:p + n * 2].decode("utf-16-le"); p += n * 2 + 2
            if request_flags & REQ_EXTENSION:
                n = struct.unpack_from("<I", data, p)[0]; p += 4
                item["ext"] = data[p:p + n * 2].decode("utf-16-le"); p += n * 2 + 2
            if request_flags & REQ_SIZE:
                item["size"] = struct.unpack_from("<q", data, p)[0]; p += 8
            if request_flags & REQ_DATE_CREATED:
                item["date_created"] = _filetime_to_epoch(
                    struct.unpack_from("<q", data, p)[0]); p += 8
            if request_flags & REQ_DATE_MODIFIED:
                item["date_modified"] = _filetime_to_epoch(
                    struct.unpack_from("<q", data, p)[0]); p += 8
            if request_flags & REQ_DATE_ACCESSED:
                item["date_accessed"] = _filetime_to_epoch(
                    struct.unpack_from("<q", data, p)[0]); p += 8
            if request_flags & REQ_ATTRIBUTES:
                item["attributes"] = struct.unpack_from("<I", data, p)[0]; p += 4
            items.append(item)
        return {"total": tot, "offset": off, "results": items}


_DEFAULT_REQ = (REQ_FULL_PATH_AND_NAME | REQ_SIZE
                | REQ_DATE_MODIFIED | REQ_ATTRIBUTES)


def search(text: str, max_results: int = 100, offset: int = 0,
           sort: str = "name", descending: bool = False,
           search_flags: int = 0) -> dict:
    """Convenience wrapper used by server.py."""
    sort_base = SORT.get(sort.lower(), 1)
    sort_type = sort_base + 1 if descending else sort_base
    return EverythingIPC.get().query(
        text, max_results=max_results, offset=offset,
        search_flags=search_flags, request_flags=_DEFAULT_REQ,
        sort_type=sort_type,
    )


def count(text: str, search_flags: int = 0) -> int:
    return int(EverythingIPC.get().query(
        text, max_results=1, search_flags=search_flags,
        request_flags=REQ_NAME, sort_type=1,
    )["total"])
