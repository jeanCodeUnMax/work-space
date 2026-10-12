"""hphe-ipc Named Pipe Client (Windows NDJSON).

Connects to the Hephaistos indexer daemon (hphe-indexd) over the Windows
named pipe (\\\\.\\pipe\\hphe-index). Uses Newline-Delimited JSON (NDJSON)
framing with request-response correlation via unique IDs.

Supports automatic reconnection, timeouts, streaming USN watch subscriptions,
and graceful fallback to Everything.exe via everything_ipc when the pipe is
absent or inactive.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any, Callable

try:
    import pywintypes
    import win32event
    import win32file
    import win32pipe
    HAS_PYWIN32 = True
except ImportError:
    HAS_PYWIN32 = False
    pywintypes = None
    win32event = None
    win32file = None
    win32pipe = None

DEFAULT_PIPE_NAME = os.environ.get("HPHE_PIPE_NAME", r"\\.\pipe\hphe-index")
DEFAULT_CONNECT_TIMEOUT = 3.0
DEFAULT_REQUEST_TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class HphePipeError(Exception):
    """Base exception for all HPHE pipe client operations."""
    pass


class HphePipeNotFoundError(HphePipeError):
    """Raised when the named pipe does not exist (daemon not running)."""
    pass


class HphePipeConnectionError(HphePipeError):
    """Raised when the pipe connection fails or is broken."""
    pass


class HphePipeTimeoutError(HphePipeError):
    """Raised when a connection attempt or request times out."""
    pass


class HphePipeResponseError(HphePipeError):
    """Raised when the daemon returns an error response."""

    def __init__(self, code: str, message: str, context: dict | None = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.context = context or {}


# ---------------------------------------------------------------------------
# Pipe availability check
# ---------------------------------------------------------------------------

def is_pipe_available(pipe_name: str = DEFAULT_PIPE_NAME, timeout_ms: int = 50) -> bool:
    """Check if the named pipe exists and is ready for connections."""
    if not HAS_PYWIN32:
        return False
    try:
        win32pipe.WaitNamedPipe(pipe_name, timeout_ms)
        return True
    except pywintypes.error as e:
        # ERROR_FILE_NOT_FOUND (2) means pipe daemon is not running
        if e.winerror == 2:
            return False
        # ERROR_PIPE_BUSY (231) or ERROR_SEM_TIMEOUT (121) means pipe exists
        if e.winerror in (231, 121):
            return True
        return False
    except Exception:
        return False


# ---------------------------------------------------------------------------
# HphePipeClient
# ---------------------------------------------------------------------------

class HphePipeClient:
    """Windows Named Pipe client communicating with hphe-indexd via NDJSON."""

    def __init__(
        self,
        pipe_name: str = DEFAULT_PIPE_NAME,
        timeout: float = DEFAULT_REQUEST_TIMEOUT,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        auto_reconnect: bool = True,
        fallback_to_everything: bool = False,
    ) -> None:
        if not HAS_PYWIN32:
            raise HphePipeError("pywin32 (win32file/win32pipe) is required for named pipe communication.")

        self.pipe_name = pipe_name
        self.request_timeout = timeout
        self.connect_timeout = connect_timeout
        self.auto_reconnect = auto_reconnect
        self.fallback_to_everything = fallback_to_everything

        self._handle: Any = None
        self._connected = False
        self._fallback_active = False

        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._watch_lock = threading.Lock()
        self._id_lock = threading.Lock()

        self._next_request_id = 1
        self._pending_requests: dict[int, tuple[threading.Event, list[Any]]] = {}
        self._watch_callbacks: list[Callable[[dict], None]] = []

        self._reader_thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    # -----------------------------------------------------------------------
    # Connection Management
    # -----------------------------------------------------------------------

    def is_connected(self) -> bool:
        """Return True if currently connected to the named pipe."""
        return self._connected and self._handle is not None

    def is_fallback_active(self) -> bool:
        """Return True if the client is currently routing queries to Everything.exe."""
        return self._fallback_active

    def connect(self, timeout: float | None = None) -> bool:
        """Connect to the Windows named pipe.

        Args:
            timeout: Maximum seconds to wait for connection. Defaults to connect_timeout.

        Returns:
            True if connected to the pipe, False if fallback is enabled and pipe absent.

        Raises:
            HphePipeNotFoundError: Pipe does not exist and fallback is disabled.
            HphePipeConnectionError: Access denied or connection failure.
            HphePipeTimeoutError: Connection timed out.
        """
        if self.is_connected():
            return True

        timeout_sec = timeout if timeout is not None else self.connect_timeout
        deadline = time.time() + timeout_sec

        while True:
            try:
                handle = win32file.CreateFile(
                    self.pipe_name,
                    win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                    0,
                    None,
                    win32file.OPEN_EXISTING,
                    win32file.FILE_FLAG_OVERLAPPED,
                    None,
                )
                self._handle = handle
                self._connected = True
                self._fallback_active = False
                self._stop_event.clear()

                self._reader_thread = threading.Thread(
                    target=self._reader_loop,
                    args=(handle,),
                    name=f"HphePipeReader-{id(self)}",
                    daemon=True,
                )
                self._reader_thread.start()
                return True

            except pywintypes.error as e:
                # Pipe does not exist (daemon not running)
                if e.winerror == 2:
                    if self.fallback_to_everything:
                        self._connected = False
                        self._fallback_active = True
                        return False
                    raise HphePipeNotFoundError(
                        f"Named pipe not found: {self.pipe_name} (daemon hphe-indexd not running)"
                    ) from e

                # Pipe is busy - wait and retry
                if e.winerror == 231:
                    remaining_ms = max(10, int((deadline - time.time()) * 1000))
                    if remaining_ms <= 0:
                        break
                    try:
                        win32pipe.WaitNamedPipe(self.pipe_name, remaining_ms)
                    except pywintypes.error:
                        pass
                    if time.time() >= deadline:
                        break
                    continue

                # Access denied (ACL)
                if e.winerror == 5:
                    raise HphePipeConnectionError(
                        f"Access denied to named pipe: {self.pipe_name}"
                    ) from e

                # Other Windows errors
                raise HphePipeConnectionError(
                    f"Failed to connect to named pipe {self.pipe_name}: {e.strerror} (code {e.winerror})"
                ) from e

            except Exception as e:
                raise HphePipeConnectionError(f"Unexpected connection error: {e}") from e

        # Timeout reached
        if self.fallback_to_everything:
            self._connected = False
            self._fallback_active = True
            return False

        raise HphePipeTimeoutError(
            f"Timed out after {timeout_sec}s connecting to {self.pipe_name}"
        )

    def disconnect(self) -> None:
        """Close connection and terminate reader thread."""
        self._connected = False
        self._stop_event.set()

        handle = self._handle
        self._handle = None

        if handle is not None:
            try:
                win32file.CancelIo(handle)
            except Exception:
                pass
            try:
                win32file.CloseHandle(handle)
            except Exception:
                pass

        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=1.0)
        self._reader_thread = None

        self._fail_all_pending(HphePipeConnectionError("Pipe disconnected"))

    def _fail_all_pending(self, exc: Exception) -> None:
        """Wake up any pending requests with the given exception."""
        with self._pending_lock:
            for event, holder in self._pending_requests.values():
                holder[0] = exc
                event.set()
            self._pending_requests.clear()

    def _on_connection_lost(self, handle: Any | None = None) -> None:
        """Handle unexpected pipe disconnection."""
        if handle is not None and self._handle != handle:
            return
        if not self._connected and self._handle is None:
            return
        self._connected = False
        old_handle = self._handle
        self._handle = None
        if old_handle is not None:
            try:
                win32file.CancelIo(old_handle)
            except Exception:
                pass
            try:
                win32file.CloseHandle(old_handle)
            except Exception:
                pass
        self._fail_all_pending(HphePipeConnectionError("Connection to daemon lost"))

    # -----------------------------------------------------------------------
    # NDJSON Reader Loop (Overlapped)
    # -----------------------------------------------------------------------

    def _reader_loop(self, handle: Any) -> None:
        """Background thread reading NDJSON frames from pipe via overlapped I/O."""
        buf = bytearray()
        ov = pywintypes.OVERLAPPED()
        ov.hEvent = win32event.CreateEvent(None, True, False, None)
        read_buf = win32file.AllocateReadBuffer(65536)

        try:
            while not self._stop_event.is_set() and self._handle == handle:
                win32event.ResetEvent(ov.hEvent)
                try:
                    hr, _ = win32file.ReadFile(handle, read_buf, ov)
                except pywintypes.error as e:
                    if e.winerror != 997:  # ERROR_IO_PENDING
                        break

                while not self._stop_event.is_set() and self._handle == handle:
                    rc = win32event.WaitForSingleObject(ov.hEvent, 100)
                    if rc == win32event.WAIT_OBJECT_0:
                        break

                if self._stop_event.is_set() or self._handle != handle:
                    try:
                        win32file.CancelIo(handle)
                    except Exception:
                        pass
                    break

                try:
                    bytes_read = win32file.GetOverlappedResult(handle, ov, True)
                except pywintypes.error:
                    break
                except Exception:
                    break

                if bytes_read == 0:
                    break

                chunk = bytes(read_buf[:bytes_read])
                buf.extend(chunk)

                while b"\n" in buf:
                    line, _, rest = buf.partition(b"\n")
                    buf = bytearray(rest)
                    line_str = line.decode("utf-8", errors="replace").strip()
                    if not line_str:
                        continue

                    try:
                        msg = json.loads(line_str)
                    except json.JSONDecodeError:
                        continue

                    self._dispatch_message(msg)
        finally:
            try:
                win32file.CloseHandle(ov.hEvent)
            except Exception:
                pass
            self._on_connection_lost(handle)

    def _dispatch_message(self, msg: dict) -> None:
        """Route parsed NDJSON message to pending request or watch callbacks."""
        msg_id = msg.get("id")

        if msg_id is not None:
            with self._pending_lock:
                pending = self._pending_requests.pop(msg_id, None)
            if pending is not None:
                event, holder = pending
                holder[0] = msg
                event.set()
                return

        # Notification or streaming event (no matching request id)
        with self._watch_lock:
            callbacks = list(self._watch_callbacks)

        for cb in callbacks:
            try:
                cb(msg)
            except Exception:
                pass

    # -----------------------------------------------------------------------
    # Overlapped Write Helper
    # -----------------------------------------------------------------------

    def _write_bytes(self, handle: Any, payload: bytes, timeout_sec: float) -> None:
        """Write bytes to overlapped pipe handle with timeout."""
        ov = pywintypes.OVERLAPPED()
        ov.hEvent = win32event.CreateEvent(None, True, False, None)
        try:
            try:
                win32file.WriteFile(handle, payload, ov)
            except pywintypes.error as e:
                if e.winerror != 997:  # ERROR_IO_PENDING
                    raise

            rc = win32event.WaitForSingleObject(ov.hEvent, max(1, int(timeout_sec * 1000)))
            if rc != win32event.WAIT_OBJECT_0:
                try:
                    win32file.CancelIo(handle)
                except Exception:
                    pass
                raise HphePipeTimeoutError(f"Write timed out after {timeout_sec}s")

            win32file.GetOverlappedResult(handle, ov, True)
        finally:
            try:
                win32file.CloseHandle(ov.hEvent)
            except Exception:
                pass

    # -----------------------------------------------------------------------
    # RPC Core: call(method, params) -> result
    # -----------------------------------------------------------------------

    def call(self, method: str, params: dict | None = None, timeout: float | None = None) -> Any:
        """Call a remote method on the daemon via NDJSON protocol.

        Args:
            method: Method name ('ping', 'stats', 'search', 'resolve', 'watch').
            params: Optional dict of method parameters.
            timeout: Request timeout in seconds. Defaults to request_timeout.

        Returns:
            The 'result' field of the response.

        Raises:
            HphePipeResponseError: Server returned an error object.
            HphePipeTimeoutError: Request timed out.
            HphePipeConnectionError: Disconnected from daemon.
        """
        effective_timeout = timeout if timeout is not None else self.request_timeout

        if not self.is_connected():
            if self.auto_reconnect:
                self.connect(timeout=self.connect_timeout)
            else:
                raise HphePipeConnectionError("Not connected to named pipe daemon")

        with self._id_lock:
            req_id = self._next_request_id
            self._next_request_id += 1

        # Format request with flattened params as per Rust protocol
        req: dict[str, Any] = {"id": req_id, "method": method}
        if params:
            if isinstance(params, dict):
                req.update(params)
                req["params"] = params
            else:
                req["params"] = params

        payload = (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")

        event = threading.Event()
        holder: list[Any] = [None]

        with self._pending_lock:
            if not self._connected or self._handle is None:
                raise HphePipeConnectionError("Pipe disconnected before dispatch")
            self._pending_requests[req_id] = (event, holder)

        # Write to pipe
        try:
            with self._write_lock:
                if not self._connected or self._handle is None:
                    raise HphePipeConnectionError("Pipe disconnected during write")
                self._write_bytes(self._handle, payload, effective_timeout)
        except (pywintypes.error, OSError) as e:
            with self._pending_lock:
                self._pending_requests.pop(req_id, None)
            self._on_connection_lost()
            if self.auto_reconnect:
                try:
                    self.connect(timeout=self.connect_timeout)
                    with self._pending_lock:
                        self._pending_requests[req_id] = (event, holder)
                    with self._write_lock:
                        self._write_bytes(self._handle, payload, effective_timeout)
                except Exception as retry_err:
                    with self._pending_lock:
                        self._pending_requests.pop(req_id, None)
                    raise HphePipeConnectionError(f"Failed to write to pipe after reconnect: {retry_err}") from retry_err
            else:
                raise HphePipeConnectionError(f"Failed to write to pipe: {e}") from e

        # Await correlated response
        signaled = event.wait(effective_timeout)
        if not signaled:
            with self._pending_lock:
                self._pending_requests.pop(req_id, None)
            raise HphePipeTimeoutError(
                f"Request {req_id} (method '{method}') timed out after {effective_timeout}s"
            )

        resp = holder[0]
        if isinstance(resp, Exception):
            raise resp
        if resp is None:
            raise HphePipeConnectionError("Empty response received from daemon")

        # Daemon error
        if isinstance(resp, dict) and resp.get("error") is not None:
            err = resp["error"]
            code = err.get("code", "UNKNOWN_ERROR") if isinstance(err, dict) else str(err)
            message = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            context = err.get("context") if isinstance(err, dict) else None
            raise HphePipeResponseError(code=code, message=message, context=context)

        # Success result
        if isinstance(resp, dict) and "result" in resp:
            return resp["result"]
        return resp

    # -----------------------------------------------------------------------
    # High-level API: ping, stats, search, resolve, watch
    # -----------------------------------------------------------------------

    def ping(self) -> dict:
        """Health check returning daemon uptime, version and timestamp."""
        return self.call("ping", {})

    def stats(self) -> dict:
        """Return index statistics (entry count, volumes, memory usage)."""
        if not self.is_connected():
            try:
                self.connect()
            except HphePipeError:
                if self.fallback_to_everything:
                    return self._fallback_stats()
                raise

        try:
            return self.call("stats", {})
        except HphePipeError:
            if self.fallback_to_everything:
                return self._fallback_stats()
            raise

    def search(self, query: str, limit: int = 100, offset: int = 0) -> list[dict]:
        """Search the NTFS index.

        Args:
            query: Search query pattern.
            limit: Maximum entries to return.
            offset: Pagination offset.

        Returns:
            List of matching file entry dicts (rows).
        """
        if not self.is_connected():
            try:
                self.connect()
            except HphePipeError:
                if self.fallback_to_everything:
                    return self._fallback_search(query, limit, offset)
                raise

        try:
            res = self.call("search", {"query": query, "limit": limit, "offset": offset})
            if isinstance(res, dict) and "entries" in res:
                return res["entries"]
            if isinstance(res, list):
                return res
            return []
        except HphePipeError:
            if self.fallback_to_everything:
                return self._fallback_search(query, limit, offset)
            raise

    def resolve(self, row: int) -> str:
        """Resolve a row index to its full resolved file path.

        Args:
            row: Row index in the index.

        Returns:
            Full file path as a string.
        """
        if not self.is_connected():
            try:
                self.connect()
            except HphePipeError:
                if self.fallback_to_everything:
                    return self._fallback_resolve(row)
                raise

        try:
            res = self.call("resolve", {"row": int(row)})
            if isinstance(res, dict) and "path" in res:
                return res["path"]
            return str(res)
        except HphePipeError:
            if self.fallback_to_everything:
                return self._fallback_resolve(row)
            raise

    def watch(self, callback: Callable[[dict], None], volume: str | None = None) -> Callable[[], None]:
        """Subscribe to live USN journal events.

        Args:
            callback: Function invoked whenever a USN event frame arrives.
            volume: Optional drive letter to filter (e.g. 'C').

        Returns:
            An unwatch callable to unsubscribe and stop receiving events.
        """
        with self._watch_lock:
            if callback not in self._watch_callbacks:
                self._watch_callbacks.append(callback)

        params: dict[str, Any] = {"subscribe": True}
        if volume:
            params["volume"] = volume[0].upper()

        self.call("watch", params)

        def unwatch() -> None:
            with self._watch_lock:
                if callback in self._watch_callbacks:
                    self._watch_callbacks.remove(callback)
            try:
                self.call("watch", {"subscribe": False})
            except Exception:
                pass

        return unwatch

    # -----------------------------------------------------------------------
    # Fallback to Everything.exe (WM_COPYDATA)
    # -----------------------------------------------------------------------

    def _fallback_search(self, query: str, limit: int, offset: int) -> list[dict]:
        """Execute search via Everything.exe IPC as fallback."""
        try:
            import everything_ipc
        except ImportError:
            raise HphePipeNotFoundError(
                f"Pipe {self.pipe_name} unavailable and everything_ipc could not be imported"
            )

        r = everything_ipc.search(query, max_results=limit, offset=offset)
        entries = []
        for i, it in enumerate(r.get("results", [])):
            full = it.get("full_path", "")
            name = it.get("name")
            if not name and full:
                idx = full.rfind("\\")
                name = full[idx + 1:] if idx >= 0 else full
            entries.append({
                "row": i + offset,
                "frn": 0,
                "parent_frn": 0,
                "name": name or full,
                "path": full,
                "size": it.get("size", 0) or 0,
                "is_dir": bool((it.get("attributes") or 0) & 0x10),
                "created": it.get("date_created", 0) or 0,
                "modified": it.get("date_modified", 0) or 0,
                "accessed": it.get("date_accessed", 0) or 0,
                "attributes": it.get("attributes", 0) or 0,
            })
        return entries

    def _fallback_stats(self) -> dict:
        """Get index stats via Everything.exe IPC as fallback."""
        try:
            import everything_ipc
        except ImportError:
            raise HphePipeNotFoundError(
                f"Pipe {self.pipe_name} unavailable and everything_ipc could not be imported"
            )

        ipc = everything_ipc.EverythingIPC.get()
        st = ipc.status()
        st["total"] = everything_ipc.count("")
        st["backend"] = "everything-ipc"
        return st

    def _fallback_resolve(self, row: int) -> str:
        """Fallback resolve (unsupported in Everything.exe)."""
        return ""

    # -----------------------------------------------------------------------
    # Context manager
    # -----------------------------------------------------------------------

    def __enter__(self) -> HphePipeClient:
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.disconnect()


# ---------------------------------------------------------------------------
# Module-level convenience functions
# ---------------------------------------------------------------------------

_default_client: HphePipeClient | None = None
_client_lock = threading.Lock()


def get_client(
    pipe_name: str = DEFAULT_PIPE_NAME,
    fallback: bool = True,
) -> HphePipeClient:
    """Get or create singleton HphePipeClient instance."""
    global _default_client
    with _client_lock:
        if _default_client is None or _default_client.pipe_name != pipe_name:
            _default_client = HphePipeClient(
                pipe_name=pipe_name,
                fallback_to_everything=fallback,
            )
        return _default_client
