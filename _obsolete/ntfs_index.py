"""NTFS index engine - same technique as Everything.

Reads the NTFS USN journal via FSCTL_ENUM_USN_DATA (admin required) to build
a complete file index of local NTFS volumes without directory traversal,
then applies incremental deltas via FSCTL_READ_USN_JOURNAL.

Pure stdlib + ctypes. No external dependencies.
"""

from __future__ import annotations

import ctypes
import os
import sqlite3
import struct
import sys
import threading
import time
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ---------------------------------------------------------------------------
# Win32 constants
# ---------------------------------------------------------------------------

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
FILE_SHARE_DELETE = 0x00000004
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064
FSCTL_ENUM_USN_DATA = 0x000900B3
FSCTL_READ_USN_JOURNAL = 0x000900BB
FSCTL_QUERY_USN_JOURNAL = 0x000900F4
FSCTL_CREATE_USN_JOURNAL = 0x000900E7

ERROR_HANDLE_EOF = 38
ERROR_INVALID_FUNCTION = 1
ERROR_JOURNAL_NOT_ACTIVE = 1179

FILE_ATTRIBUTE_DIRECTORY = 0x00000010
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_ATTRIBUTE_TEMPORARY = 0x00000100

# USN reason bits
USN_REASON_BASIC_INFO_CHANGE = 0x00008000
USN_REASON_CLOSE = 0x80000000
USN_REASON_DATA_EXTEND = 0x00000002
USN_REASON_DATA_OVERWRITE = 0x00000001
USN_REASON_DATA_TRUNCATION = 0x00000004
USN_REASON_FILE_CREATE = 0x00000100
USN_REASON_FILE_DELETE = 0x00000200
USN_REASON_HARD_LINK_CHANGE = 0x00010000
USN_REASON_NAMED_DATA_EXTEND = 0x00000020
USN_REASON_NAMED_DATA_OVERWRITE = 0x00000010
USN_REASON_NAMED_DATA_TRUNCATION = 0x00000040
USN_REASON_RENAME_NEW_NAME = 0x00002000
USN_REASON_RENAME_OLD_NAME = 0x00001000
USN_REASON_REPARSE_POINT_CHANGE = 0x00100000
USN_REASON_SECURITY_CHANGE = 0x00000800
USN_REASON_STREAM_CHANGE = 0x00200000
USN_REASON_ALL = 0xFFFFFFFF

# FILETIME epoch offset (1601 -> 1970) in 100ns units
_FILETIME_EPOCH_DELTA = 116444736000000000


def filetime_to_epoch(ft: int) -> float:
    if ft <= 0:
        return 0.0
    return (ft - _FILETIME_EPOCH_DELTA) / 10_000_000.0


def _err() -> int:
    return ctypes.get_last_error()


def _raise_win(msg: str) -> None:
    code = _err()
    raise OSError(f"{msg} (winerror {code})")


# ---------------------------------------------------------------------------
# Structures
# ---------------------------------------------------------------------------


class MFT_ENUM_DATA_V0(ctypes.Structure):
    _fields_ = [
        ("StartFileReferenceNumber", ctypes.c_ulonglong),
        ("LowUsn", ctypes.c_longlong),
        ("HighUsn", ctypes.c_longlong),
    ]


class READ_USN_JOURNAL_DATA_V0(ctypes.Structure):
    _fields_ = [
        ("StartUsn", ctypes.c_longlong),
        ("ReasonMask", wintypes.DWORD),
        ("ReturnOnlyOnClose", wintypes.DWORD),
        ("Timeout", ctypes.c_ulonglong),
        ("BytesToWaitFor", ctypes.c_ulonglong),
        ("UsnJournalID", ctypes.c_ulonglong),
    ]


class CREATE_USN_JOURNAL_DATA(ctypes.Structure):
    _fields_ = [
        ("MaximumSize", ctypes.c_ulonglong),
        ("AllocationDelta", ctypes.c_ulonglong),
    ]


class USN_JOURNAL_DATA_V1(ctypes.Structure):
    _fields_ = [
        ("UsnJournalID", ctypes.c_ulonglong),
        ("FirstUsn", ctypes.c_longlong),
        ("NextUsn", ctypes.c_longlong),
        ("LowestValidUsn", ctypes.c_longlong),
        ("MaxUsn", ctypes.c_longlong),
        ("MaximumSize", ctypes.c_ulonglong),
        ("AllocationDelta", ctypes.c_ulonglong),
        ("MinSupportedMajorVersion", wintypes.WORD),
        ("MaxSupportedMajorVersion", wintypes.WORD),
        ("Flags", wintypes.DWORD),
        ("RangeTrackChunkSize", ctypes.c_ulonglong),
        ("RangeTrackFileSizeThreshold", ctypes.c_longlong),
    ]


# USN_RECORD_V2 layout
# DWORD RecordLength; WORD MajorVersion; WORD MinorVersion;
# DWORDLONG FileReferenceNumber; DWORDLONG ParentFileReferenceNumber;
# USN Usn; LARGE_INTEGER TimeStamp; DWORD Reason; DWORD SourceInfo;
# DWORD SecurityId; DWORD FileAttributes; WORD FileNameLength; WORD FileNameOffset;
_USN_V2_MIN = 60
_FRN_MASK = (1 << 48) - 1  # low 6 bytes = MFT index


class UsnRecord:
    __slots__ = ("frn", "parent_frn", "usn", "timestamp", "reason", "attrs", "name")

    def __init__(self, frn, parent_frn, usn, timestamp, reason, attrs, name):
        self.frn = frn
        self.parent_frn = parent_frn
        self.usn = usn
        self.timestamp = timestamp
        self.reason = reason
        self.attrs = attrs
        self.name = name

    @property
    def is_dir(self) -> bool:
        return bool(self.attrs & FILE_ATTRIBUTE_DIRECTORY)


def _parse_usn_v2(buf: bytes, off: int) -> UsnRecord | None:
    (record_len, major, minor) = struct.unpack_from("<IHH", buf, off)
    if major != 2 or record_len < _USN_V2_MIN:
        return None
    frn, parent, usn, ts = struct.unpack_from("<QQqQ", buf, off + 8)
    reason = struct.unpack_from("<I", buf, off + 40)[0]
    attrs = struct.unpack_from("<I", buf, off + 52)[0]
    name_len, name_off = struct.unpack_from("<HH", buf, off + 56)
    if name_len <= 0 or name_off + name_len > record_len:
        return None
    name = buf[off + name_off : off + name_off + name_len].decode("utf-16-le", "replace")
    return UsnRecord(
        frn=frn & _FRN_MASK,
        parent_frn=parent & _FRN_MASK,
        usn=usn,
        timestamp=ts,
        reason=reason,
        attrs=attrs,
        name=name,
    )


def _device_io(handle, code, inbuf: bytes, out_size: int) -> tuple[bytes, int]:
    outbuf = (ctypes.c_byte * out_size)()
    returned = wintypes.DWORD(0)
    inarr = (ctypes.c_byte * len(inbuf)).from_buffer_copy(inbuf) if inbuf else None
    ok = kernel32.DeviceIoControl(
        handle,
        code,
        inarr,
        len(inbuf),
        outbuf,
        out_size,
        ctypes.byref(returned),
        None,
    )
    return ctypes.string_at(ctypes.addressof(outbuf), returned.value), (0 if ok else _err())


def open_volume(letter: str):
    path = "\\\\.\\" + letter[0].upper() + ":"
    h = kernel32.CreateFileW(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        0,
        None,
    )
    if h == INVALID_HANDLE_VALUE or h == 0:
        return None
    return h


def close_handle(h) -> None:
    if h:
        kernel32.CloseHandle(h)


def query_usn_journal(h) -> USN_JOURNAL_DATA_V1 | None:
    out, code = _device_io(h, FSCTL_QUERY_USN_JOURNAL, b"", ctypes.sizeof(USN_JOURNAL_DATA_V1))
    if code != 0 or len(out) < ctypes.sizeof(USN_JOURNAL_DATA_V1):
        return None
    return USN_JOURNAL_DATA_V1.from_buffer_copy(out[: ctypes.sizeof(USN_JOURNAL_DATA_V1)])


_JOURNAL_MAX = 256 << 20    # 256 MB - large enough to survive weeks of deltas
_JOURNAL_DELTA = 64 << 20   # 64 MB allocation delta


def create_usn_journal(h) -> bool:
    data = CREATE_USN_JOURNAL_DATA(_JOURNAL_MAX, _JOURNAL_DELTA)
    out, code = _device_io(
        h, FSCTL_CREATE_USN_JOURNAL, bytes(data), 0
    )
    return code == 0


def enum_usn_records(h, journal: USN_JOURNAL_DATA_V1, callback, chunk: int = 1 << 22) -> int:
    """Enumerate every USN record on the volume. Returns record count."""
    buf_size = chunk
    start = 0
    count = 0
    in_size = ctypes.sizeof(MFT_ENUM_DATA_V0)
    while True:
        med = MFT_ENUM_DATA_V0(start, 0, journal.NextUsn)
        out, code = _device_io(h, FSCTL_ENUM_USN_DATA, bytes(med), buf_size)
        if code != 0 and code != ERROR_HANDLE_EOF:
            if code == ERROR_JOURNAL_NOT_ACTIVE:
                raise JournalError("journal not active")
            _raise_win("FSCTL_ENUM_USN_DATA failed")
        if len(out) < 8:
            break
        start = struct.unpack_from("<Q", out, 0)[0]
        pos = 8
        found = 0
        while pos + _USN_V2_MIN <= len(out):
            record_len = struct.unpack_from("<I", out, pos)[0]
            if record_len < _USN_V2_MIN or pos + record_len > len(out):
                break
            rec = _parse_usn_v2(out, pos)
            if rec is not None:
                callback(rec)
                count += 1
                found += 1
            pos += record_len
        if found == 0 or code == ERROR_HANDLE_EOF:
            break
    return count


def read_journal_deltas(h, journal: USN_JOURNAL_DATA_V1, start_usn: int, callback, chunk: int = 1 << 20) -> int:
    """Read journal records after start_usn. Returns last consumed usn."""
    last = start_usn
    while True:
        rjd = READ_USN_JOURNAL_DATA_V0(
            StartUsn=last,
            ReasonMask=USN_REASON_ALL,
            ReturnOnlyOnClose=0,
            Timeout=0,
            BytesToWaitFor=0,
            UsnJournalID=journal.UsnJournalID,
        )
        out, code = _device_io(h, FSCTL_READ_USN_JOURNAL, bytes(rjd), chunk)
        if code != 0 and code != ERROR_HANDLE_EOF:
            _raise_win("FSCTL_READ_USN_JOURNAL failed")
        if len(out) < 8:
            break
        last = struct.unpack_from("<q", out, 0)[0]
        pos = 8
        found = 0
        while pos + _USN_V2_MIN <= len(out):
            record_len = struct.unpack_from("<I", out, pos)[0]
            if record_len < _USN_V2_MIN or pos + record_len > len(out):
                break
            rec = _parse_usn_v2(out, pos)
            if rec is not None:
                callback(rec)
                found += 1
            pos += record_len
        if found == 0:
            break
    return last


class JournalError(Exception):
    pass


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

_ROOT_FRN = 5  # $MFT root directory "."


def _ext_of(name: str) -> str:
    i = name.rfind(".")
    return name[i + 1 :].lower() if 0 < i < len(name) - 1 else ""


def _norm_drive(letter: str) -> str:
    return letter.rstrip(":\\").upper() + ":"


_DEFAULT_DB = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
    "everything-mcp", "index.db",
)


class NtfsIndex:
    """In-memory/file-backed file index of local NTFS volumes (Everything-style).

    With db_path the SQLite index persists between runs; on startup each
    volume's stored journal ID is compared with the live one and only USN
    deltas are applied (fast) instead of a full MFT re-enumeration.
    """

    def __init__(self, volumes: list[str] | None = None, db_path: str | None = None,
                 autobuild: bool = True):
        self._db_path = db_path
        if db_path:
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._db = self._connect(db_path)
        # WAL: atomic writes - a killed process leaves a clean db instead of
        # corrupting it into another 20-minute rebuild
        self._db.execute(
            "PRAGMA journal_mode=WAL" if db_path else "PRAGMA journal_mode=OFF"
        )
        self._db.execute("PRAGMA synchronous=OFF")
        self._create_schema()
        self._lock = threading.RLock()
        self._volumes = {}
        self._last_usn = {}          # vol -> last consumed USN
        self._handles = {}           # vol -> volume handle
        self._journals = {}          # vol -> USN_JOURNAL_DATA_V1
        self._built_at = 0.0
        self._errors = {}
        self._requested = [_norm_drive(v) for v in volumes] if volumes else None
        self._ready = set()        # vols fully indexed and searchable
        self._building = set()
        if autobuild:
            self.reindex()

    def _create_schema(self) -> None:
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS files(
                vol TEXT, frn INTEGER, parent INTEGER,
                name TEXT, path TEXT, dir INTEGER,
                attrs INTEGER, ts REAL, ext TEXT,
                PRIMARY KEY(vol, frn))"""
        )
        self._db.execute("CREATE INDEX IF NOT EXISTS idx_name ON files(name COLLATE NOCASE)")
        self._db.execute("CREATE INDEX IF NOT EXISTS idx_ext ON files(ext)")
        # partial index: tiny once paths are resolved, speeds the
        # level-by-level path resolution and per-vol DELETE during builds
        self._db.execute("CREATE INDEX IF NOT EXISTS idx_vol ON files(vol)")
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_pending ON files(vol) WHERE path=''"
        )
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS meta(
                vol TEXT PRIMARY KEY, journal_id INTEGER,
                last_usn INTEGER, built_at REAL,
                rows_expected INTEGER)"""
        )
        cols = {r[1] for r in self._db.execute("PRAGMA table_info(meta)")}
        if "rows_expected" not in cols:
            self._db.execute("ALTER TABLE meta ADD COLUMN rows_expected INTEGER")

    @staticmethod
    def _connect(db_path: str | None) -> sqlite3.Connection:
        """Connect, self-healing a corrupted persisted index by rebuilding it.
        A busy (already-owned) database raises instead of being deleted."""
        try:
            db = sqlite3.connect(
                db_path or ":memory:", check_same_thread=False, timeout=10.0
            )
            if db_path:
                # WAL already serializes one writer + many readers; NORMAL
                # lets an elevated builder refresh the db while unelevated
                # server instances keep serving the persisted index
                db.execute("PRAGMA locking_mode=NORMAL")
            db.execute("SELECT COUNT(*) FROM files LIMIT 1").fetchone()
            db.execute("SELECT COUNT(*) FROM meta LIMIT 1").fetchone()
            return db
        except sqlite3.OperationalError as e:
            if "locked" in str(e):
                raise  # owned by a live server - not corruption
            # missing tables / empty husk -> fall through to rebuild
        except sqlite3.Error:
            pass
        if not db_path:
            return sqlite3.connect(":memory:", check_same_thread=False, timeout=30.0)
        try:
            db.close()  # type: ignore[possibly-undefined]
        except Exception:
            pass
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.remove(db_path + suffix)
            except OSError:
                pass
        db = sqlite3.connect(db_path, check_same_thread=False, timeout=30.0)
        db.execute("PRAGMA locking_mode=NORMAL")
        return db

    # -- volume discovery ----------------------------------------------------

    @staticmethod
    def ntfs_volumes() -> list[str]:
        vols = []
        bitmask = kernel32.GetLogicalDrives()
        for i in range(26):
            if not (bitmask >> i) & 1:
                continue
            root = f"{chr(65+i)}:\\"
            fsn = ctypes.create_unicode_buffer(260)
            ok = kernel32.GetVolumeInformationW(
                root, None, 0, None, None, None, fsn, 260
            )
            if ok and fsn.value.upper() == "NTFS":
                vols.append(f"{chr(65+i)}:")
        return vols

    # -- index build ----------------------------------------------------------

    def reindex(self, volumes: list[str] | None = None) -> dict:
        t0 = time.time()
        if volumes is not None:
            vols = [_norm_drive(v) for v in volumes]
        else:
            self._errors = {}
            self._requested = [_norm_drive(v) for v in
                               (self._requested or self.ntfs_volumes())]
            vols = self._requested
        for vol in vols:
            self._building.add(vol)
            print(f"[ntfs_index] {vol}: processing", file=sys.stderr, flush=True)
            try:
                if volumes is None and self._db_path and self._try_resume_volume(vol):
                    self._ready.add(vol)
                    continue
                self._reindex_volume(vol)
                if vol not in self._errors:
                    self._ready.add(vol)
            except Exception as e:  # noqa: BLE001 - one bad volume must not kill the others
                self._errors[vol] = f"{type(e).__name__}: {e}"
                print(f"[ntfs_index] {vol}: reindex failed: {e}", file=sys.stderr)
            finally:
                self._building.discard(vol)
        self._built_at = time.time()
        if self._db_path:
            if any("malformed" in e for e in self._errors.values()):
                self._rebuild_db_file()
            else:
                try:  # reclaim pages freed by DELETE+reinsert cycles
                    self._db.execute("VACUUM")
                except sqlite3.Error:
                    pass
        return self.stats()

    def _rebuild_db_file(self) -> None:
        """The persisted db is corrupt - rebuild it from scratch."""
        print("[ntfs_index] corrupt index file, rebuilding all volumes",
              file=sys.stderr)
        for h in self._handles.values():
            close_handle(h)
        self._handles.clear()
        self._journals.clear()
        self._last_usn.clear()
        try:
            self._db.close()
        except Exception:
            pass
        for suffix in ("", "-wal", "-shm", "-journal"):
            try:
                os.remove(self._db_path + suffix)
            except OSError:
                pass
        self._db = self._connect(self._db_path)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=OFF")
        self._create_schema()
        self._errors = {}
        for vol in self._requested:
            self._building.add(vol)
            try:
                self._reindex_volume(vol)
                if vol not in self._errors:
                    self._ready.add(vol)
            except Exception as e:  # noqa: BLE001
                self._errors[vol] = f"{type(e).__name__}: {e}"
            finally:
                self._building.discard(vol)

    def _open_and_journal(self, vol: str):
        """Open volume handle and query/create its USN journal."""
        h = open_volume(vol)
        if h is None or h == -1:
            self._errors[vol] = "cannot open volume (need administrator)"
            return None, None
        journal = query_usn_journal(h)
        if journal is None:
            if create_usn_journal(h):
                journal = query_usn_journal(h)
        if journal is None:
            self._errors[vol] = "no USN journal and could not create one"
            close_handle(h)
            return None, None
        if journal.MaximumSize < _JOURNAL_MAX:
            # grow the journal so deltas survive longer between restarts
            create_usn_journal(h)
            j2 = query_usn_journal(h)
            if j2 is not None:
                journal = j2
        return h, journal

    def _try_resume_volume(self, vol: str) -> bool:
        """If a persisted index exists and its journal is still valid, apply
        deltas only. Returns True when the volume is ready without reindex."""
        row = self._db.execute(
            "SELECT journal_id, last_usn FROM meta WHERE vol=?", (vol,)
        ).fetchone()
        if row is None:
            return False
        h, journal = self._open_and_journal(vol)
        if h is None:
            return False
        stored_id, last_usn = row
        if journal.UsnJournalID != stored_id:
            print(f"[ntfs_index] {vol}: journal recreated, full rebuild",
                  file=sys.stderr)
            close_handle(h)
            return False
        if last_usn < journal.FirstUsn:
            print(f"[ntfs_index] {vol}: journal wrapped "
                  f"(last={last_usn} < first={journal.FirstUsn}), full rebuild",
                  file=sys.stderr)
            close_handle(h)
            return False
        if journal.NextUsn - last_usn > 256 * 1024 * 1024:
            print(f"[ntfs_index] {vol}: too far behind "
                  f"({journal.NextUsn - last_usn >> 20} MiB of deltas), full rebuild",
                  file=sys.stderr)
            close_handle(h)
            return False
        self._handles[vol] = h
        self._journals[vol] = journal
        self._last_usn[vol] = last_usn
        self._delta_at = 0.0
        try:
            print(f"[ntfs_index] {vol}: resuming, "
                  f"{journal.NextUsn - last_usn >> 20} MiB of deltas",
                  file=sys.stderr, flush=True)
            self.refresh_deltas(max_age=0.0)
        except OSError as e:
            print(f"[ntfs_index] {vol}: delta refresh failed ({e}), full rebuild",
                  file=sys.stderr)
            self._handles.pop(vol, None)
            self._journals.pop(vol, None)
            close_handle(h)
            return False
        return True

    def _reindex_volume(self, vol: str) -> None:
        h, journal = self._open_and_journal(vol)
        if h is None:
            return  # keep existing rows: deleting them first would wipe the
            # persisted index whenever the volume can't be opened (no admin)
        for old in (self._handles.pop(vol, None),):
            close_handle(old)
        with self._lock:
            self._db.execute("DELETE FROM files WHERE vol=?", (vol,))
            self._db.commit()
        self._handles[vol] = h
        self._journals[vol] = journal
        print(f"[ntfs_index] {vol}: enumerating MFT", file=sys.stderr, flush=True)

        # Stream records straight into sqlite: building giant in-memory
        # lists for a whole volume takes GBs of RAM and gets paged out
        # on memory-pressured machines, stalling the build for hours.
        _CHUNK = 50_000
        buf = []
        nrec = 0

        def flush() -> None:
            if not buf:
                return
            with self._lock:
                self._db.executemany(
                    "INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?,?)", buf
                )
                self._db.commit()
            buf.clear()

        def on_record(rec: UsnRecord) -> None:
            nonlocal nrec
            nrec += 1
            if nrec % 1_000_000 == 0:
                print(f"[ntfs_index] {vol}: {nrec} records", file=sys.stderr,
                      flush=True)
            buf.append((vol, rec.frn, rec.parent_frn, rec.name, "",
                        1 if rec.is_dir else 0, rec.attrs,
                        filetime_to_epoch(rec.timestamp), _ext_of(rec.name)))
            if len(buf) >= _CHUNK:
                flush()

        try:
            enum_usn_records(h, journal, on_record)
        except JournalError:
            self._errors[vol] = "journal became inactive during enumeration"
            close_handle(h)
            self._handles.pop(vol, None)
            return
        flush()
        print(f"[ntfs_index] {vol}: {nrec} records, resolving paths",
              file=sys.stderr, flush=True)

        # Resolve paths level by level in SQL: rows whose parent is the
        # root, a self-loop, or absent get path=name; then each pass fills
        # rows whose parent's path is already known. Tiny memory footprint.
        with self._lock:
            self._db.execute(
                """UPDATE files SET path=name
                WHERE vol=? AND path='' AND (
                    parent=? OR parent=frn OR
                    NOT EXISTS (SELECT 1 FROM files p
                        WHERE p.vol=files.vol AND p.frn=files.parent))""",
                (vol, _ROOT_FRN),
            )
            self._db.commit()
        for _ in range(64):
            with self._lock:
                cur = self._db.execute(
                    """UPDATE files SET path=(
                        SELECT p.path || '\' || files.name FROM files p
                        WHERE p.vol=files.vol AND p.frn=files.parent)
                    WHERE vol=? AND path='' AND EXISTS (
                        SELECT 1 FROM files p
                        WHERE p.vol=files.vol AND p.frn=files.parent
                            AND p.path<>'')""",
                    (vol,),
                )
                self._db.commit()
            if cur.rowcount == 0:
                break
        with self._lock:
            self._last_usn[vol] = journal.NextUsn
            cnt = self._db.execute(
                "SELECT COUNT(*) FROM files WHERE vol=?", (vol,)
            ).fetchone()[0]
            self._db.execute(
                "INSERT OR REPLACE INTO meta VALUES(?,?,?,?,?)",
                (vol, journal.UsnJournalID, journal.NextUsn, time.time(), cnt),
            )
            self._db.commit()

    # -- delta refresh --------------------------------------------------------

    def refresh_deltas(self, max_age: float = 15.0) -> int:
        """Apply USN journal deltas newer than the last consumed USN.
        Returns number of applied changes. Cheap (~ms) when journal is quiet."""
        with self._lock:
            if getattr(self, "_delta_at", 0) and time.time() - self._delta_at < max_age:
                return 0
            applied = 0
            for vol, h in list(self._handles.items()):
                journal = self._journals.get(vol)
                if journal is None:
                    continue
                start = self._last_usn.get(vol, journal.NextUsn)

                def on_record(rec: UsnRecord) -> None:
                    nonlocal applied
                    # applied streaming: millions of pending deltas would
                    # otherwise pile up in a list and exhaust memory
                    if rec.reason & USN_REASON_FILE_DELETE:
                        self._db.execute(
                            "DELETE FROM files WHERE vol=? AND frn=?", (vol, rec.frn)
                        )
                    elif rec.reason & (USN_REASON_FILE_CREATE | USN_REASON_RENAME_NEW_NAME | USN_REASON_BASIC_INFO_CHANGE | USN_REASON_HARD_LINK_CHANGE):
                        old = self._db.execute(
                            "SELECT path, dir FROM files WHERE vol=? AND frn=?",
                            (vol, rec.frn),
                        ).fetchone()
                        row = self._db.execute(
                            "SELECT path FROM files WHERE vol=? AND frn=?",
                            (vol, rec.parent_frn),
                        ).fetchone()
                        parent_path = row[0] if row else self._resolve_live(vol, rec.parent_frn)
                        full = parent_path + "\\" + rec.name if parent_path else rec.name
                        self._db.execute(
                            "INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?,?)",
                            (vol, rec.frn, rec.parent_frn, rec.name, full,
                             1 if rec.is_dir else 0, rec.attrs,
                             filetime_to_epoch(rec.timestamp), _ext_of(rec.name)),
                        )
                        # a renamed directory moves all its descendants' paths
                        if rec.is_dir and old and old[1] and old[0] != full:
                            self._db.execute(
                                "UPDATE files SET path = ? || substr(path, ?) "
                                "WHERE vol=? AND path LIKE ? ESCAPE '\\'",
                                (full, len(old[0]) + 1, vol,
                                 old[0].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "\\%"),
                            )
                    applied += 1
                    if applied % 100_000 == 0:
                        self._db.commit()

                try:
                    last = read_journal_deltas(h, journal, start, on_record)
                except OSError:
                    continue
                self._last_usn[vol] = last
            self._db.commit()
            # persist progress so restarts don't replay the same deltas;
            # rows_expected is preserved so the builder can still detect a
            # volume that lost most of its rows
            for vol in self._last_usn:
                j = self._journals.get(vol)
                if j is not None:
                    self._db.execute(
                        "INSERT INTO meta VALUES(?,?,?,?,"
                        "(SELECT rows_expected FROM meta WHERE vol=?)) "
                        "ON CONFLICT(vol) DO UPDATE SET "
                        "journal_id=excluded.journal_id, "
                        "last_usn=excluded.last_usn, "
                        "built_at=excluded.built_at",
                        (vol, j.UsnJournalID, self._last_usn[vol], time.time(), vol),
                    )
            self._db.commit()
            self._delta_at = time.time()
            return applied

    def _resolve_live(self, vol: str, frn: int, depth: int = 0) -> str:
        if depth > 64 or frn in (0, _ROOT_FRN):
            return ""
        row = self._db.execute(
            "SELECT parent, name FROM files WHERE vol=? AND frn=?", (vol, frn)
        ).fetchone()
        if row is None:
            return ""
        base = self._resolve_live(vol, row[0], depth + 1)
        return base + "\\" + row[1] if base else row[1]

    # -- query ----------------------------------------------------------------

    @property
    def db(self) -> sqlite3.Connection:
        return self._db

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    def stats(self) -> dict:
        with self._lock:
            rows = self._db.execute(
                "SELECT vol, COUNT(*), SUM(dir) FROM files GROUP BY vol"
            ).fetchall()
            return {
                "volumes": {
                    v: {"entries": c, "dirs": d} for v, c, d in rows
                },
                "total": sum(c for _, c, _ in rows),
                "errors": dict(self._errors),
                "built_at": self._built_at,
                "age_seconds": round(time.time() - self._built_at, 1) if self._built_at else None,
                "indexed_volumes": sorted(self._ready),
                "building_volumes": sorted(self._building),
            }


def get_default_index() -> NtfsIndex:
    global _default
    try:
        return _default
    except NameError:
        _default = NtfsIndex()
        return _default
