"""Tests du mode watch stream de beacon_ingest (T-071).

On mocke `pipe_client` (le module réel exige pywin32 + le daemon hphe-indexd)
et `beacon_ingest.ingest_once` pour vérifier, sans dépendance externe :

1. que le filtre `_event_touches_log` ne retient que les événements du
   journal Beacon ;
2. que le `_DebounceTrigger` regroupe plusieurs événements rapprochés en un
   seul appel d'ingest (debounce) ;
3. que `run_watch` bascule en `_poll_loop` (fallback poll) quand le pipe est
   absent, et déclenche l'ingest via les événements quand le pipe répond.

Lancés avec `python -m pytest tests/test_beacon_ingest_watch.py -v`.
"""

import argparse
import asyncio
import sys
from pathlib import Path

import pytest

# Rendre le module beacon_ingest importable (il vit dans .agent/rag/).
REPO_ROOT = Path(__file__).resolve().parents[1]
RAG_DIR = REPO_ROOT / ".agent" / "rag"
sys.path.insert(0, str(RAG_DIR))
sys.path.insert(0, str(REPO_ROOT))  # pour `import pipe_client` (mocké ci-dessous)

import beacon_ingest as bi  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakePipeClientModule:
    """Remplace le module `pipe_client` pour isoler les tests."""

    def __init__(self, pipe_available: bool = True):
        self.pipe_available = pipe_available
        self.instances = []
        self.connect_should_fail = False

    def is_pipe_available(self, *a, **k):
        return self.pipe_available

    def HphePipeClient(self):
        client = FakeHphePipeClient(self)
        self.instances.append(client)
        return client


class FakeHphePipeClient:
    """Faux client pipe : enregistre watch/unwatch et connect/disconnect."""

    def __init__(self, module: FakePipeClientModule):
        self._module = module
        self.connected = False
        self.disconnected = False
        self.watch_calls = []
        self.unwatch_calls = 0
        self._callback = None

    def connect(self, *a, **k):
        if self._module.connect_should_fail:
            raise RuntimeError("pipe down")
        self.connected = True

    def disconnect(self, *a, **k):
        self.disconnected = True

    def watch(self, callback, volume=None):
        self.watch_calls.append({"callback": callback, "volume": volume})
        self._callback = callback

        def unwatch():
            self.unwatch_calls += 1
            self._callback = None

        return unwatch

    # --- helpers de test (pas dans l'API réelle) ---
    def emit(self, event):
        if self._callback is not None:
            self._callback(event)


class RecordingIngest:
    """Remplace `beacon_ingest.ingest_once` et compte les appels."""

    def __init__(self):
        self.calls = []

    async def __call__(self, log_path, limit=20, dry_run=False, reset=False):
        self.calls.append({
            "log_path": str(log_path),
            "limit": limit,
            "dry_run": dry_run,
            "reset": reset,
        })
        return {"events": 0, "indexed": 0, "failed": 0,
                "no_activity": True, "offset_advanced": False}


def _make_args(**over):
    """Construit un Namespace argparse-like pour run_watch."""
    defaults = dict(
        watch=True, watch_interval=30.0, debounce=2.0, dry_run=False,
        limit=20, reset=False, log_path=None, once=False,
    )
    defaults.update(over)
    return argparse.Namespace(**defaults)


# ---------------------------------------------------------------------------
# 1. Filtre d'événements
# ---------------------------------------------------------------------------

def test_event_touches_log_matches_path_and_dir():
    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    # Chemin complet du journal
    assert bi._event_touches_log(
        {"path": r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl"}, log)
    # Même répertoire, séparateurs mixtes
    assert bi._event_touches_log(
        {"path": "C:/Users/x/.beacon/endpoint/logs/runtime.jsonl"}, log)
    # Nom seul identique
    assert bi._event_touches_log({"name": "runtime.jsonl"}, log)


def test_event_touches_log_rejects_unrelated():
    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    assert not bi._event_touches_log({"path": r"C:\Users\x\other\file.py"}, log)
    assert not bi._event_touches_log({"name": "runtime.jsonl.bak"}, log)
    assert not bi._event_touches_log({"path": r"C:\x\notbeacon\runtime.jsonl"}, log)
    # Événement vide / sans champ pertinent
    assert not bi._event_touches_log({}, log)
    assert not bi._event_touches_log({"path": None}, log)


def test_volume_of_windows_path():
    assert bi._volume_of(Path(r"C:\Users\x\logs\runtime.jsonl")) == "C"
    assert bi._volume_of(Path(r"F:\promgramation\logs\runtime.jsonl")) == "F"
    # Pas de lettre de lecteur -> défaut C
    assert bi._volume_of(Path(r"\unc\share\logs\runtime.jsonl")) == "C"


# ---------------------------------------------------------------------------
# 2. Debounce
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_debounce_coalesces_burst_into_single_ingest(monkeypatch):
    """Une rafale d'événements < debounce ne produit qu'un ingest."""
    recorder = RecordingIngest()
    monkeypatch.setattr(bi, "ingest_once", recorder)

    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    args = _make_args(debounce=0.2, log_path=str(log))
    trigger = bi._DebounceTrigger(debounce=0.2, log_path=log, args=args)

    ev = {"path": str(log), "name": "runtime.jsonl"}
    # 5 événements rapprochés.
    for _ in range(5):
        trigger.on_event(ev)
        await asyncio.sleep(0.02)

    # On laisse le debounce s'écouler.
    await asyncio.sleep(0.4)

    assert len(recorder.calls) == 1, recorder.calls


@pytest.mark.asyncio
async def test_debounce_ignores_unrelated_events(monkeypatch):
    recorder = RecordingIngest()
    monkeypatch.setattr(bi, "ingest_once", recorder)

    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    args = _make_args(debounce=0.1, log_path=str(log))
    trigger = bi._DebounceTrigger(debounce=0.1, log_path=log, args=args)

    trigger.on_event({"path": r"C:\Users\x\unrelated\file.py"})
    trigger.on_event({"name": "other.jsonl"})
    await asyncio.sleep(0.3)

    assert recorder.calls == []


# ---------------------------------------------------------------------------
# 3. run_watch — fallback poll + chemin watch
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_watch_falls_back_to_poll_when_pipe_absent(monkeypatch):
    """Pipe absent -> _poll_loop (fallback) ; ingest initial + au moins un poll."""
    monkeypatch.setattr(bi, "ingest_once", RecordingIngest())

    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    args = _make_args(watch_interval=0.05, log_path=str(log))

    fake_module = FakePipeClientModule(pipe_available=False)
    monkeypatch.setattr(bi, "_resolve_pipe_client", lambda: fake_module)

    poll_calls = {"n": 0}
    real_poll_loop = bi._poll_loop

    async def counting_poll_loop(log_path, a, interval):
        poll_calls["n"] += 1
        # Sort immédiatement pour ne pas boucler à l'infini dans le test.
        return 0

    monkeypatch.setattr(bi, "_poll_loop", counting_poll_loop)

    rc = await bi.run_watch(args)
    assert rc == 0
    assert poll_calls["n"] == 1, "le fallback poll doit être déclenché"


@pytest.mark.asyncio
async def test_run_watch_pipe_up_triggers_ingest_on_event(monkeypatch):
    """Pipe dispo -> souscription watch ; un événement pertinent déclenche l'ingest."""
    recorder = RecordingIngest()
    monkeypatch.setattr(bi, "ingest_once", recorder)

    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    args = _make_args(debounce=0.05, watch_interval=0.05, log_path=str(log))

    fake_module = FakePipeClientModule(pipe_available=True)
    monkeypatch.setattr(bi, "_resolve_pipe_client", lambda: fake_module)

    # On borne la boucle while True de run_watch : dès qu'un ingest débouncé
    # a eu lieu (>= 2 appels : passe initiale + événement), on sort.
    real_sleep = asyncio.sleep
    fired = {"n": 0}

    async def short_watch_loop_sleep(sec):
        # Le keepalive de run_watch dort 0.5s ; on le raccourcit pour que le
        # test ne traîne pas. Le debounce (0.05s) utilise ce même sleep, on
        # préserve donc un vrai petit délai pour lui.
        if sec and sec >= 0.5:
            if len(recorder.calls) >= 2:
                raise asyncio.CancelledError()
            await real_sleep(0.02)
        else:
            await real_sleep(sec)

    monkeypatch.setattr(asyncio, "sleep", short_watch_loop_sleep)

    # On émet l'événement pertinent juste après la souscription, en
    # programmant son émission via une tâche concurrente.
    async def emit_soon():
        await real_sleep(0.01)
        fake_module.instances[-1].emit(
            {"path": str(log), "name": "runtime.jsonl"})

    async def driver():
        emit_task = asyncio.ensure_future(emit_soon())
        rc = await bi.run_watch(args)
        return rc

    rc = await driver()

    # Le client pipe a été créé, connecté, et watch souscrit sur le bon volume.
    assert len(fake_module.instances) == 1
    client = fake_module.instances[0]
    assert client.connected
    assert len(client.watch_calls) == 1
    assert client.watch_calls[0]["volume"] == "C"

    # Passe initiale (1) + ingest débouncé déclenché par l'événement (>=1 de plus).
    assert len(recorder.calls) >= 2, recorder.calls
    assert rc == 0
    # unwatch + disconnect appelés dans le finally.
    assert client.unwatch_calls == 1
    assert client.disconnected


@pytest.mark.asyncio
async def test_run_watch_pipe_connect_fails_falls_back(monkeypatch):
    """Pipe annoncé dispo mais connect() lève -> fallback poll."""
    monkeypatch.setattr(bi, "ingest_once", RecordingIngest())

    log = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")
    args = _make_args(watch_interval=0.05, log_path=str(log))

    fake_module = FakePipeClientModule(pipe_available=True)
    fake_module.connect_should_fail = True
    monkeypatch.setattr(bi, "_resolve_pipe_client", lambda: fake_module)

    poll_calls = {"n": 0}

    async def counting_poll_loop(log_path, a, interval):
        poll_calls["n"] += 1
        return 0

    monkeypatch.setattr(bi, "_poll_loop", counting_poll_loop)

    rc = await bi.run_watch(args)
    assert rc == 0
    assert poll_calls["n"] == 1, "doit basculer en fallback poll après échec connect"


# ---------------------------------------------------------------------------
# 4. Compatibilité : ingest_once reste appelable et retourne un dict
# ---------------------------------------------------------------------------

def test_ingest_once_returns_report_dict(monkeypatch, tmp_path):
    """Sans journal, ingest_once renvoie un rapport no_activity (pas d'exception)."""
    missing = tmp_path / "does_not_exist.jsonl"

    async def _run():
        return await bi.ingest_once(log_path=missing, limit=5)

    report = asyncio.run(_run())
    assert isinstance(report, dict)
    assert report["no_activity"] is True
    assert report["events"] == 0
