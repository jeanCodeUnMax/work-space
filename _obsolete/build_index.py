"""Elevated index builder for everything-mcp.

Run as administrator (e.g. via a scheduled task). Refreshes the persisted
SQLite index: per volume, applies USN journal deltas when the journal is
still valid, otherwise falls back to a full MFT re-enumeration. Exits when
done - the MCP server keeps serving the persisted db meanwhile.

Self-heal: a volume whose meta row survives but whose files rows were lost
(e.g. a crashed/concurrent build resumed it while still empty) is detected
and force-rebuilt - a plain resume would otherwise keep it empty forever.

Single instance: a byte-range lock on build.lock makes concurrent builders
exit immediately instead of racing DELETE/INSERT cycles against each other.
"""

import atexit
import msvcrt
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ntfs_index import NtfsIndex, _DEFAULT_DB

BASE = os.path.dirname(os.path.abspath(__file__))
LOCK_PATH = os.path.join(BASE, "build.lock")
LOG_PATH = os.path.join(BASE, "build.log")

_lock_fp = None


class _Tee:
    def __init__(self, fp):
        self._fp = fp

    def write(self, s):
        self._fp.write(s)
        self._fp.flush()
        return len(s)

    def flush(self):
        self._fp.flush()


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [pid {os.getpid()}] {msg}"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    print(line, flush=True)


def acquire_lock():
    global _lock_fp
    fp = open(LOCK_PATH, "a+b")
    try:
        fp.seek(0)
        msvcrt.locking(fp.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        fp.close()
        return False
    _lock_fp = fp
    atexit.register(release_lock)
    return True


def release_lock():
    global _lock_fp
    fp, _lock_fp = _lock_fp, None
    if fp is None:
        return
    try:
        fp.seek(0)
        msvcrt.locking(fp.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    fp.close()


def main() -> int:
    if not acquire_lock():
        log("another builder holds the lock; exiting")
        return 0

    t0 = time.time()
    log("build started")
    # capture ntfs_index's stderr progress prints into the log
    _logfp = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
    sys.stderr = _Tee(_logfp)
    try:
        # db_path is mandatory: without it NtfsIndex builds a :memory:
        # index - millions of rows in RAM, nothing persisted to disk
        idx = NtfsIndex(
            db_path=os.environ.get("EVERYTHING_MCP_DB") or _DEFAULT_DB,
            autobuild=True,
        )
        stats = idx.stats()
        log(f"after refresh: {stats.get('total')} entries; volumes={list(stats.get('volumes', {}))}; errors={stats.get('errors') or 'none'}")

        counts = {
            v: c for v, c in
            idx.db.execute("SELECT vol, COUNT(*) FROM files GROUP BY vol")
        }
        broken = []
        for vol, expected in idx.db.execute(
            "SELECT vol, rows_expected FROM meta"
        ):
            have = counts.get(vol, 0)
            # expected=None means the rows were never counted by a full
            # rebuild - distrust them (e.g. deltas re-added a few rows to a
            # wiped volume); rebuild once to establish the baseline
            if have == 0 or expected is None or have < expected * 0.5:
                broken.append(vol)
        if broken:
            log(f"volumes lost most of their rows, force rebuild: {broken}")
            idx.reindex(sorted(broken))
            stats = idx.stats()

        total = stats.get("total", 0)
        errors = stats.get("errors", {})
        log(f"done in {time.time() - t0:.0f}s: indexed {total} entries; errors: {errors or 'none'}")
        return 1 if errors and not total else 0
    except Exception:
        log("build crashed:\n" + traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
