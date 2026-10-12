"""Unit and integration tests for HphePipeClient.

Tests the full Windows named pipe NDJSON roundtrip against a threaded
fake pipe server implemented using win32pipe / win32file / win32event.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
import uuid
from typing import Any

import pywintypes
import win32event
import win32file
import win32pipe

from pipe_client import (
    HphePipeClient,
    HphePipeConnectionError,
    HphePipeNotFoundError,
    HphePipeResponseError,
    HphePipeTimeoutError,
    is_pipe_available,
)


def make_test_pipe_name() -> str:
    """Generate a unique pipe name for each test run to avoid collisions."""
    unique_id = uuid.uuid4().hex[:8]
    return rf"\\.\pipe\hphe-test-{os.getpid()}-{unique_id}"


class FakeHpheDaemon:
    """Threaded Windows Named Pipe server emulating hphe-indexd using overlapped I/O."""

    def __init__(self, pipe_name: str, delay: float = 0.0) -> None:
        self.pipe_name = pipe_name
        self.delay = delay
        self.running = False
        self.thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self.client_connected = threading.Event()
        self.requests_handled: list[dict] = []
        self._active_pipe_handle: Any = None
        self._pipe_lock = threading.Lock()

    def start(self) -> None:
        self.running = True
        self._stop_event.clear()
        self.thread = threading.Thread(target=self._server_loop, daemon=True)
        self.thread.start()
        time.sleep(0.05)

    def stop(self) -> None:
        self.running = False
        self._stop_event.set()
        with self._pipe_lock:
            h = self._active_pipe_handle
            if h is not None:
                try:
                    win32file.CancelIo(h)
                except Exception:
                    pass
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.5)

    def emit_event(self, event_data: dict) -> None:
        """Broadcast an arbitrary NDJSON event frame to the connected client."""
        payload = (json.dumps(event_data, ensure_ascii=False) + "\n").encode("utf-8")
        with self._pipe_lock:
            h = self._active_pipe_handle
            if h is not None:
                self._write_bytes(h, payload)

    def _write_bytes(self, handle: Any, payload: bytes) -> None:
        ov = pywintypes.OVERLAPPED()
        ov.hEvent = win32event.CreateEvent(None, True, False, None)
        try:
            try:
                win32file.WriteFile(handle, payload, ov)
            except pywintypes.error as e:
                if e.winerror != 997:
                    return
            rc = win32event.WaitForSingleObject(ov.hEvent, 2000)
            if rc == win32event.WAIT_OBJECT_0:
                win32file.GetOverlappedResult(handle, ov, True)
        finally:
            try:
                win32file.CloseHandle(ov.hEvent)
            except Exception:
                pass

    def _server_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                pipe = win32pipe.CreateNamedPipe(
                    self.pipe_name,
                    win32pipe.PIPE_ACCESS_DUPLEX | win32file.FILE_FLAG_OVERLAPPED,
                    win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT,
                    win32pipe.PIPE_UNLIMITED_INSTANCES,
                    65536,
                    65536,
                    1000,
                    None,
                )
            except Exception:
                break

            with self._pipe_lock:
                self._active_pipe_handle = pipe

            ov_connect = pywintypes.OVERLAPPED()
            ov_connect.hEvent = win32event.CreateEvent(None, True, False, None)
            connected = False

            try:
                win32pipe.ConnectNamedPipe(pipe, ov_connect)
            except pywintypes.error as e:
                if e.winerror == 535:  # ERROR_PIPE_CONNECTED
                    connected = True
                elif e.winerror == 997:  # ERROR_IO_PENDING
                    pass
                else:
                    win32file.CloseHandle(pipe)
                    win32file.CloseHandle(ov_connect.hEvent)
                    continue

            if not connected:
                while not self._stop_event.is_set():
                    rc = win32event.WaitForSingleObject(ov_connect.hEvent, 100)
                    if rc == win32event.WAIT_OBJECT_0:
                        connected = True
                        break

            try:
                win32file.CloseHandle(ov_connect.hEvent)
            except Exception:
                pass

            if self._stop_event.is_set() or not connected:
                with self._pipe_lock:
                    self._active_pipe_handle = None
                try:
                    win32file.CancelIo(pipe)
                    win32file.CloseHandle(pipe)
                except Exception:
                    pass
                break

            self.client_connected.set()

            # Read client frames with overlapped I/O
            buf = bytearray()
            ov_read = pywintypes.OVERLAPPED()
            ov_read.hEvent = win32event.CreateEvent(None, True, False, None)
            read_buffer = win32file.AllocateReadBuffer(65536)

            try:
                while not self._stop_event.is_set():
                    win32event.ResetEvent(ov_read.hEvent)
                    try:
                        win32file.ReadFile(pipe, read_buffer, ov_read)
                    except pywintypes.error as e:
                        if e.winerror != 997:
                            break

                    while not self._stop_event.is_set():
                        rc = win32event.WaitForSingleObject(ov_read.hEvent, 100)
                        if rc == win32event.WAIT_OBJECT_0:
                            break

                    if self._stop_event.is_set():
                        break

                    try:
                        bytes_read = win32file.GetOverlappedResult(pipe, ov_read, True)
                    except Exception:
                        break

                    if bytes_read == 0:
                        break

                    buf.extend(bytes(read_buffer[:bytes_read]))
                    while b"\n" in buf:
                        line, _, rest = buf.partition(b"\n")
                        buf = bytearray(rest)
                        line_str = line.decode("utf-8", errors="replace").strip()
                        if not line_str:
                            continue
                        req = json.loads(line_str)
                        self.requests_handled.append(req)

                        if self.delay > 0:
                            time.sleep(self.delay)

                        resp = self._handle_request(req)
                        resp_bytes = (json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8")
                        self._write_bytes(pipe, resp_bytes)

            finally:
                try:
                    win32file.CloseHandle(ov_read.hEvent)
                except Exception:
                    pass
                with self._pipe_lock:
                    self._active_pipe_handle = None
                try:
                    win32file.CancelIo(pipe)
                    win32pipe.DisconnectNamedPipe(pipe)
                    win32file.CloseHandle(pipe)
                except Exception:
                    pass

    def _handle_request(self, req: dict) -> dict:
        req_id = req.get("id", 0)
        method = req.get("method", "")

        if method == "ping":
            return {
                "id": req_id,
                "result": {
                    "version": "1.0.0",
                    "uptime_ms": 12345,
                    "timestamp": 1700000000,
                },
            }

        if method == "stats":
            return {
                "id": req_id,
                "result": {
                    "total_entries": 1_250_000,
                    "file_count": 1_000_000,
                    "dir_count": 250_000,
                    "total_size": 500_000_000_000,
                    "memory_usage_bytes": 100_000_000,
                    "build_time_ms": 1200,
                    "avg_name_length": 18.2,
                },
            }

        if method == "search":
            query = req.get("query", "")
            limit = int(req.get("limit", 100))
            offset = int(req.get("offset", 0))

            entries = [
                {
                    "row": offset + i,
                    "frn": 1000 + offset + i,
                    "parent_frn": 500,
                    "name": f"result_{query}_{offset + i}.txt",
                    "path": rf"C:\data\result_{query}_{offset + i}.txt",
                    "size": 1024 * (i + 1),
                    "is_dir": False,
                    "created": 13300000000,
                    "modified": 13300050000,
                    "accessed": 13300090000,
                    "attributes": 32,
                }
                for i in range(min(limit, 5))
            ]
            return {
                "id": req_id,
                "result": {
                    "total": 5,
                    "entries": entries,
                    "has_more": False,
                    "offset": offset,
                    "limit": limit,
                },
            }

        if method == "resolve":
            row = int(req.get("row", 0))
            return {
                "id": req_id,
                "result": {
                    "path": rf"C:\resolved\entry_{row}.dat",
                    "row": row,
                    "frn": 5000 + row,
                },
            }

        if method == "watch":
            subscribe = bool(req.get("subscribe", False))
            volume = req.get("volume")
            return {
                "id": req_id,
                "result": {
                    "subscribed": subscribe,
                    "volume": volume,
                },
            }

        if method == "trigger_error":
            return {
                "id": req_id,
                "error": {
                    "code": "INVALID_PARAMS",
                    "message": "Simulated error from daemon",
                    "context": {"key": "value"},
                },
            }

        return {
            "id": req_id,
            "error": {
                "code": "METHOD_NOT_FOUND",
                "message": f"Unknown method: {method}",
            },
        }


class TestHphePipeClient(unittest.TestCase):
    """Test suite for HphePipeClient."""

    def setUp(self) -> None:
        self.pipe_name = make_test_pipe_name()
        self.server = FakeHpheDaemon(self.pipe_name)
        self.server.start()

    def tearDown(self) -> None:
        self.server.stop()

    def test_pipe_availability_helper(self) -> None:
        """Test is_pipe_available helper on active and non-existent pipes."""
        self.assertTrue(is_pipe_available(self.pipe_name))
        self.assertFalse(is_pipe_available(r"\\.\pipe\definitely-not-existing-pipe-xyz"))

    def test_ping_roundtrip(self) -> None:
        """Test ping health check method."""
        client = HphePipeClient(pipe_name=self.pipe_name, timeout=2.0)
        self.assertTrue(client.connect())
        self.assertTrue(client.is_connected())

        res = client.ping()
        self.assertEqual(res["version"], "1.0.0")
        self.assertEqual(res["uptime_ms"], 12345)
        self.assertEqual(res["timestamp"], 1700000000)

        client.disconnect()
        self.assertFalse(client.is_connected())

    def test_stats_roundtrip(self) -> None:
        """Test stats method returning index statistics."""
        with HphePipeClient(pipe_name=self.pipe_name, timeout=2.0) as client:
            st = client.stats()
            self.assertEqual(st["total_entries"], 1_250_000)
            self.assertEqual(st["file_count"], 1_000_000)
            self.assertEqual(st["dir_count"], 250_000)
            self.assertEqual(st["total_size"], 500_000_000_000)

    def test_search_roundtrip(self) -> None:
        """Test search method returning rows matching query."""
        with HphePipeClient(pipe_name=self.pipe_name, timeout=2.0) as client:
            rows = client.search("notes", limit=5)
            self.assertEqual(len(rows), 5)
            self.assertEqual(rows[0]["name"], "result_notes_0.txt")
            self.assertEqual(rows[0]["path"], r"C:\data\result_notes_0.txt")
            self.assertEqual(rows[0]["size"], 1024)
            self.assertFalse(rows[0]["is_dir"])

    def test_resolve_roundtrip(self) -> None:
        """Test resolve method returning resolved path."""
        with HphePipeClient(pipe_name=self.pipe_name, timeout=2.0) as client:
            path = client.resolve(99)
            self.assertEqual(path, r"C:\resolved\entry_99.dat")

    def test_watch_streaming_and_unwatch(self) -> None:
        """Test watch subscriptions and streaming event handling."""
        with HphePipeClient(pipe_name=self.pipe_name, timeout=2.0) as client:
            received_events = []
            event_received_flag = threading.Event()

            def on_event(ev: dict) -> None:
                received_events.append(ev)
                event_received_flag.set()

            unwatch = client.watch(on_event, volume="C")

            # Emit simulated USN event from server
            test_event = {
                "volume": "C",
                "frn": 123456,
                "reason": 1,
                "name": "created_file.txt",
                "path": r"C:\created_file.txt",
                "is_dir": False,
            }
            self.server.emit_event(test_event)

            self.assertTrue(event_received_flag.wait(timeout=2.0))
            self.assertEqual(len(received_events), 1)
            self.assertEqual(received_events[0]["name"], "created_file.txt")

            # Unsubscribe
            unwatch()

    def test_error_response_raises_exception(self) -> None:
        """Test that server error responses raise HphePipeResponseError."""
        with HphePipeClient(pipe_name=self.pipe_name, timeout=2.0) as client:
            with self.assertRaises(HphePipeResponseError) as ctx:
                client.call("trigger_error", {})
            self.assertEqual(ctx.exception.code, "INVALID_PARAMS")
            self.assertIn("Simulated error", ctx.exception.message)

    def test_unknown_method_raises_exception(self) -> None:
        """Test that calling an unknown method raises HphePipeResponseError."""
        with HphePipeClient(pipe_name=self.pipe_name, timeout=2.0) as client:
            with self.assertRaises(HphePipeResponseError) as ctx:
                client.call("non_existent_method")
            self.assertEqual(ctx.exception.code, "METHOD_NOT_FOUND")

    def test_request_timeout(self) -> None:
        """Test that slow response causes HphePipeTimeoutError."""
        delayed_pipe = make_test_pipe_name()
        delayed_server = FakeHpheDaemon(delayed_pipe, delay=0.5)
        delayed_server.start()
        try:
            client = HphePipeClient(pipe_name=delayed_pipe, timeout=0.1)
            client.connect()
            with self.assertRaises(HphePipeTimeoutError):
                client.ping()
            client.disconnect()
        finally:
            delayed_server.stop()

    def test_pipe_absent_raises_not_found(self) -> None:
        """Test that connecting to a non-existent pipe raises HphePipeNotFoundError when fallback is disabled."""
        client = HphePipeClient(
            pipe_name=r"\\.\pipe\non-existent-pipe-test-12345",
            connect_timeout=0.2,
            fallback_to_everything=False,
        )
        with self.assertRaises(HphePipeNotFoundError):
            client.connect()

    def test_pipe_absent_with_fallback(self) -> None:
        """Test that connecting to a non-existent pipe with fallback=True marks fallback active."""
        client = HphePipeClient(
            pipe_name=r"\\.\pipe\non-existent-pipe-test-12345",
            connect_timeout=0.2,
            fallback_to_everything=True,
        )
        connected = client.connect()
        self.assertFalse(connected)
        self.assertTrue(client.is_fallback_active())

    def test_auto_reconnect(self) -> None:
        """Test auto-reconnection when the server restarts."""
        client = HphePipeClient(
            pipe_name=self.pipe_name,
            timeout=2.0,
            connect_timeout=2.0,
            auto_reconnect=True,
        )
        client.connect()
        res1 = client.ping()
        self.assertEqual(res1["version"], "1.0.0")

        # Restart server
        self.server.stop()
        time.sleep(0.1)
        self.server = FakeHpheDaemon(self.pipe_name)
        self.server.start()

        # Next call should auto-reconnect
        res2 = client.ping()
        self.assertEqual(res2["version"], "1.0.0")
        client.disconnect()

    def test_concurrent_calls(self) -> None:
        """Test multiple concurrent calls across threads."""
        client = HphePipeClient(pipe_name=self.pipe_name, timeout=5.0)
        client.connect()

        results = []
        errors = []

        def worker(idx: int) -> None:
            try:
                r = client.resolve(idx)
                results.append((idx, r))
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0)
        self.assertEqual(len(results), 10)
        client.disconnect()


if __name__ == "__main__":
    unittest.main()
