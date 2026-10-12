#!/usr/bin/env python3
"""
Beacon Ingest - Pont local Beacon -> mémoire unifiée Hephaistos.

Lit le journal Beacon (~/.beacon/endpoint/logs/runtime.jsonl), distille les
sessions d'agents en documents synthétiques, puis les injecte dans le pipeline
RAG (chunking, tagging, embeddings zvec/qdrant, relations KG memory_mcp.db).

100 % local : aucun appel réseau, aucune clé API requise (contrairement à
`beacon memory evaluations run` qui exige le service Jev de TypeSafe).

Traitement incrémental : un fichier d'état mémorise l'offset JSONL pour ne
traiter que les nouveaux événements à chaque run.

Usage:
    python beacon_ingest.py --once            # run unique (défaut)
    python beacon_ingest.py --watch           # watch stream USN (T-071)
    python beacon_ingest.py --dry-run         # aperçu sans écriture
    python beacon_ingest.py --limit 10        # max N sessions par run
    python beacon_ingest.py --reset           # repartir de zéro
    python beacon_ingest.py --log-path X      # chemin runtime.jsonl alternatif

Mode --watch (T-071) : au lieu d'un scan périodique par offset, l'ingest est
piloté par le watch stream USN du daemon hphe-indexd (pipe nommé). Les
événements touchant runtime.jsonl déclenchent un ingest incrémental avec
debounce (2s). Si le pipe est absent, bascule gracieuse en polling 30s.
"""

import argparse
import asyncio
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

STATE_FILE = Path(__file__).resolve().parent.parent / "scripts" / ".beacon-offset.json"
DEFAULT_LOG = Path.home() / ".beacon" / "endpoint" / "logs" / "runtime.jsonl"
MAX_SESSIONS_DEFAULT = 20
MAX_MSG_CHARS = 300
MAX_SESSION_DOC_CHARS = 8000


def _env_db_root(project_root: Path) -> None:
    """Charge AGENT_DB_ROOT depuis le .env du projet (comme start-workspace.ps1)."""
    env_file = project_root / ".env"
    if env_file.exists() and not os.environ.get("AGENT_DB_ROOT"):
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "AGENT_DB_ROOT" and value.strip():
                os.environ["AGENT_DB_ROOT"] = value.strip().strip('"').strip("'")


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            state.setdefault("done", [])
            return state
        except (json.JSONDecodeError, OSError):
            pass
    return {"offset": 0, "done": []}


def _save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _iter_events(log_path: Path, offset: int):
    """Itère les événements JSONL à partir de l'offset. Retourne (events, new_offset)."""
    events = []
    with open(log_path, "rb") as f:
        f.seek(offset)
        for raw in f:
            line = raw.decode("utf-8", errors="ignore").strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        new_offset = f.tell()
    return events, new_offset


def _distill_sessions(events: list) -> dict:
    """Groupe les événements par session.id et construit un résumé par session."""
    sessions = defaultdict(lambda: {
        "harness": None, "repository": None, "cwd": None,
        "t_start": None, "t_end": None,
        "prompts": [], "commands": [], "files": set(), "tools": defaultdict(int),
        "mcp": defaultdict(int), "errors": [],
    })
    for e in events:
        sess = e.get("session") or {}
        sid = sess.get("id") or "unknown"
        s = sessions[sid]
        s["harness"] = s["harness"] or (e.get("harness") or {}).get("name")
        s["repository"] = s["repository"] or e.get("repository")
        s["cwd"] = s["cwd"] or sess.get("working_directory")
        ts = e.get("timestamp")
        if ts:
            s["t_start"] = ts if not s["t_start"] or ts < s["t_start"] else s["t_start"]
            s["t_end"] = ts if not s["t_end"] or ts > s["t_end"] else s["t_end"]
        action = (e.get("event") or {}).get("action", "")
        msg = (e.get("message") or "")[:MAX_MSG_CHARS]
        # "high" est la severity réelle des session.error (cline/devin) ;
        # on capture aussi tout event portant error.type.
        if (e.get("severity") in ("error", "critical", "warning", "high")
                or (e.get("error") or {}).get("type")) and msg:
            s["errors"].append(msg)
        if action == "prompt.submitted":
            prompt = (e.get("prompt") or {}).get("content") or msg
            if prompt:
                s["prompts"].append(prompt[:MAX_MSG_CHARS])
        elif action == "command.executed":
            cmd = ((e.get("raw") or {}).get("command") or msg)
            if cmd:
                s["commands"].append(cmd[:MAX_MSG_CHARS])
        elif action in ("file.modified", "file.read"):
            fp = (e.get("file") or {}).get("path")
            if fp and action == "file.modified":
                s["files"].add(fp)
        elif action == "tool.invoked":
            name = (e.get("tool") or {}).get("name") or "unknown"
            s["tools"][name] += 1
        elif action == "mcp.tool_invoked":
            name = (e.get("mcp") or {}).get("tool") or "unknown"
            s["mcp"][name] += 1
    return sessions


def _session_to_doc(sid: str, s: dict) -> str:
    """Rend un document markdown distillé pour une session."""
    lines = [
        f"# Agent session digest: {sid}",
        f"- Harness: {s['harness'] or 'unknown'}",
        f"- Repository: {s['repository'] or 'unknown'}",
        f"- Working dir: {s['cwd'] or 'unknown'}",
        f"- Period: {s['t_start'] or '?'} -> {s['t_end'] or '?'}",
        "",
    ]
    if s["prompts"]:
        lines.append("## User prompts")
        lines += [f"- {p}" for p in s["prompts"][:20]]
        lines.append("")
    if s["files"]:
        lines.append("## Files modified")
        lines += [f"- {f}" for f in sorted(s["files"])[:30]]
        lines.append("")
    if s["tools"]:
        top = sorted(s["tools"].items(), key=lambda x: -x[1])[:15]
        lines.append("## Tools used")
        lines += [f"- {n} x{c}" for n, c in top]
        lines.append("")
    if s["mcp"]:
        top = sorted(s["mcp"].items(), key=lambda x: -x[1])[:15]
        lines.append("## MCP calls")
        lines += [f"- {n} x{c}" for n, c in top]
        lines.append("")
    if s["errors"]:
        lines.append("## Errors / warnings observed")
        lines += [f"- {e}" for e in s["errors"][:15]]
        lines.append("")
    if s["commands"]:
        lines.append("## Commands executed")
        lines += [f"- `{c}`" for c in s["commands"][:25]]
    return "\n".join(lines)[:MAX_SESSION_DOC_CHARS]


async def ingest_once(
    log_path: Path,
    limit: int = MAX_SESSIONS_DEFAULT,
    dry_run: bool = False,
    reset: bool = False,
) -> dict:
    """Effectue une passe d'ingest incrémentale sur le journal Beacon.

    Fonction réutilisable — appelée par le mode périodique historique ET par
    le mode watch stream (T-071). Retourne un petit rapport dict :

        {"events": N, "indexed": N, "failed": N, "no_activity": bool,
         "offset_advanced": bool}
    """
    report = {
        "events": 0, "indexed": 0, "failed": 0,
        "no_activity": False, "offset_advanced": False,
    }
    if not log_path.exists():
        print(f"[beacon] Pas de journal Beacon: {log_path} — rien à faire.")
        report["no_activity"] = True
        return report

    state = {"offset": 0, "done": []} if reset else _load_state()
    done = set(state["done"])
    events, new_offset = _iter_events(log_path, state["offset"])
    report["events"] = len(events)
    if not events:
        print("[beacon] Aucun nouvel événement depuis le dernier run.")
        report["no_activity"] = True
        return report

    sessions = _distill_sessions(events)
    # On ignore les sessions vides (pas de prompt/fichier/commande)
    # et celles déjà indexées lors d'un run précédent
    sessions = {
        sid: s for sid, s in sessions.items()
        if (s["prompts"] or s["files"] or s["commands"]) and sid not in done
    }
    if not sessions:
        print(f"[beacon] {len(events)} événements lus, aucune session nouvelle significative.")
        if not dry_run:
            state["offset"] = new_offset
            _save_state(state)
            report["offset_advanced"] = True
        report["no_activity"] = True
        return report

    ordered = sorted(sessions.items(), key=lambda kv: kv[1]["t_start"] or "")
    to_process = ordered[-limit:]
    backlog = len(ordered) - len(to_process)
    print(f"[beacon] {len(events)} événements, {len(sessions)} sessions nouvelles, "
          f"{len(to_process)} à indexer (limite {limit}, backlog {backlog}).")

    if dry_run:
        for sid, s in to_process:
            print(f"--- {sid} [{s['harness']}] repo={s['repository']} "
                  f"prompts={len(s['prompts'])} files={len(s['files'])}")
        return report

    from pipeline import RAGPipeline
    pipeline = RAGPipeline()
    ok, fail = 0, 0
    for sid, s in to_process:
        doc = _session_to_doc(sid, s)
        try:
            index_report = await pipeline.index_document(
                content=doc,
                doc_type="markdown",
                source_file=f"beacon://{s['harness'] or 'unknown'}/{sid}",
                metadata={
                    "source": "beacon",
                    "harness": s["harness"],
                    "session_id": sid,
                    "repository": s["repository"],
                    "period_start": s["t_start"],
                    "period_end": s["t_end"],
                },
            )
            if index_report.get("status") == "success":
                ok += 1
                done.add(sid)
                print(f"[beacon] session {sid}: {index_report['chunks_created']} chunks, "
                      f"{index_report['memory_relations']} relations mémoire")
            else:
                fail += 1
                print(f"[beacon] session {sid}: erreurs {index_report['errors'][:2]}")
        except Exception as e:
            fail += 1
            print(f"[beacon] session {sid}: exception {e}")

    # L'offset n'avance que si tout le backlog a été traité — sinon le prochain
    # run relit les événements et retrouve les sessions restantes via `done`.
    if backlog == 0 and fail == 0:
        state["offset"] = new_offset
        report["offset_advanced"] = True
    state["done"] = sorted(done)[-500:]
    _save_state(state)
    report["indexed"] = ok
    report["failed"] = fail
    print(f"[beacon] Terminé: {ok} sessions indexées, {fail} en échec.")
    return report


async def run(args) -> int:
    """Point d'entrée du mode périodique historique (--once, défaut).

    Conservé pour compatibilité ascendante : délègue à `ingest_once`.
    """
    project_root = Path(__file__).resolve().parents[2]
    _env_db_root(project_root)

    log_path = Path(args.log_path).expanduser() if args.log_path else DEFAULT_LOG
    report = await ingest_once(
        log_path=log_path,
        limit=args.limit,
        dry_run=args.dry_run,
        reset=args.reset,
    )
    return 0 if report.get("failed", 0) == 0 else 1


# ---------------------------------------------------------------------------
# Mode watch stream (T-071) — ingestion incrémentale pilotée par le watch USN
# ---------------------------------------------------------------------------

# Nombre de secondes de debounce : après un événement touchant le journal
# Beacon, on attend ce délai pour laisser l'écriture se calmer avant d'ingérer
# (évite les tempêtes d'événements quand un harness écrit plusieurs lignes).
DEFAULT_DEBOUNCE_SECONDS = 2.0
# Intervalle de fallback en mode polling quand le pipe hphe-indexd est absent.
DEFAULT_WATCH_INTERVAL_SECONDS = 30.0


def _resolve_pipe_client():
    """Importe `pipe_client` à la racine du repo (reutilise l'existant).

    Retourne le module ou None si l'import échoue (pywin32 absent, etc.).
    """
    try:
        repo_root = Path(__file__).resolve().parents[2]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        import pipe_client  # type: ignore
        return pipe_client
    except Exception as e:  # pragma: no cover - dépend de l'environnement
        print(f"[beacon] Import pipe_client impossible: {e}")
        return None


def _volume_of(path: Path) -> str:
    """Retourne la lettre de volume (ex: 'C') d'un chemin Windows."""
    drive = path.drive  # ex: 'C:'
    return drive[:1].upper() if drive else "C"


def _event_touches_log(event: dict, log_path: Path) -> bool:
    """True si l'événement USN concerne le fichier journal Beacon.

    L'événement expose `path` (chemin complet) et/ou `name`. On matche sur le
    répertoire du journal pour être robuste aux différences de séparateurs
    (`/` vs `\\`).
    """
    log_dir = str(log_path.parent).replace("/", "\\").lower()
    log_name = log_path.name.lower()
    candidates = []
    for key in ("path", "name"):
        val = event.get(key)
        if isinstance(val, str) and val:
            candidates.append(val.replace("/", "\\").lower())
    for cand in candidates:
        if cand.endswith(log_name) and log_dir in cand:
            return True
        # Certains événements ne portent que le nom du fichier : on compare
        # alors directement au nom du journal.
        if cand == log_name:
            return True
    return False


async def run_watch(args) -> int:
    """Mode watch stream : ingest incrémental piloté par les événements USN.

    - Se connecte au pipe hphe-indexd via `pipe_client.HphePipeClient`.
    - Souscrit aux événements watch du volume contenant le journal Beacon.
    - Filtre les événements touchant `runtime.jsonl`.
    - Déclenche `ingest_once` avec un debounce (regroupement d'événements).
    - Fallback gracieux : si le pipe est indisponible, bascule en polling
      périodique (`--watch-interval`, défaut 30s) avec log « fallback poll ».
    """
    project_root = Path(__file__).resolve().parents[2]
    _env_db_root(project_root)

    log_path = Path(args.log_path).expanduser() if args.log_path else DEFAULT_LOG
    debounce = getattr(args, "debounce", None) or DEFAULT_DEBOUNCE_SECONDS
    interval = getattr(args, "watch_interval", None) or DEFAULT_WATCH_INTERVAL_SECONDS

    # Passe initiale pour rattraper le backlog existant.
    print(f"[beacon][watch] Passe initiale sur {log_path}")
    await ingest_once(
        log_path=log_path,
        limit=args.limit,
        dry_run=args.dry_run,
        reset=args.reset,
    )

    pipe_client = _resolve_pipe_client()
    if pipe_client is None:
        print("[beacon][watch] pipe_client indisponible — fallback poll.")
        return await _poll_loop(log_path, args, interval)

    if not pipe_client.is_pipe_available():
        print("[beacon][watch] pipe hphe-indexd absent — fallback poll.")
        return await _poll_loop(log_path, args, interval)

    # --- Chemin watch stream ---
    volume = _volume_of(log_path)
    print(f"[beacon][watch] Connexion pipe + souscription watch (volume {volume}).")
    client = pipe_client.HphePipeClient()
    try:
        client.connect()
    except Exception as e:
        print(f"[beacon][watch] Connexion pipe échouée ({e}) — fallback poll.")
        return await _poll_loop(log_path, args, interval)

    trigger = _DebounceTrigger(debounce, log_path, args)
    try:
        unwatch = client.watch(
            callback=lambda ev: trigger.on_event(ev), volume=volume
        )
    except Exception as e:
        print(f"[beacon][watch] Souscription watch échouée ({e}) — fallback poll.")
        client.disconnect()
        return await _poll_loop(log_path, args, interval)

    print("[beacon][watch] Écoute active. Ctrl-C pour quitter.")
    try:
        # Boucle asynchrone : le trigger planifie l'ingest via create_task ;
        # on garde le watcher en vie et on laisse le debounce s'exécuter.
        while True:
            await asyncio.sleep(0.5)
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\n[beacon][watch] Arrêt demandé.")
    finally:
        try:
            unwatch()
        except Exception:
            pass
        client.disconnect()
    return 0


class _DebounceTrigger:
    """Regroupe les événements USN et déclenche l'ingest après un délai calme.

    Plusieurs événements rapprochés (un harness écrivant plusieurs lignes de
    runtime.jsonl) ne produisent qu'un seul appel d'ingest, une fois le
    debounce écoulé sans nouvel événement pertinent.
    """

    def __init__(self, debounce: float, log_path: Path, args):
        self.debounce = debounce
        self.log_path = log_path
        self.args = args
        self._pending_task: asyncio.Task | None = None

    def on_event(self, event: dict) -> None:
        """Callback appelé depuis le thread reader du pipe (sync)."""
        if not _event_touches_log(event, self.log_path):
            return
        print(f"[beacon][watch] Événement USN sur le journal: "
              f"{event.get('name') or event.get('path')}")
        # Annule synchronement le timer en cours pour garantir le
        # regroupement (debounce) même si plusieurs événements arrivent avant
        # que la boucle d'événements ne reprenne la main.
        self._cancel_pending()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            # Le callback tourne dans un thread ; on repasse sur la loop.
            loop.call_soon_threadsafe(self._schedule)
        else:  # pragma: no cover - environnement sans loop active
            self._schedule()

    def _cancel_pending(self) -> None:
        """Annule le timer debounce en cours s'il n'a pas encore tiré."""
        if self._pending_task is not None and not self._pending_task.done():
            self._pending_task.cancel()
        self._pending_task = None

    def _schedule(self) -> None:
        """Planifie l'ingest après le debounce (le timer est (re)démarré ici)."""
        async def _fire() -> None:
            try:
                await asyncio.sleep(self.debounce)
                await ingest_once(
                    log_path=self.log_path,
                    limit=self.args.limit,
                    dry_run=self.args.dry_run,
                    reset=False,
                )
            except asyncio.CancelledError:
                raise
            finally:
                self._pending_task = None

        self._pending_task = asyncio.ensure_future(_fire())


async def _poll_loop(log_path: Path, args, interval: float) -> int:
    """Boucle de fallback : ingest périodique quand le pipe est absent."""
    print(f"[beacon][fallback poll] ingest toutes les {interval}s sur {log_path}")
    try:
        while True:
            await ingest_once(
                log_path=log_path,
                limit=args.limit,
                dry_run=args.dry_run,
                reset=False,
            )
            await asyncio.sleep(interval)
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\n[beacon][fallback poll] Arrêt demandé.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Beacon -> mémoire unifiée Hephaistos")
    ap.add_argument("--once", action="store_true", help="Run unique (défaut)")
    ap.add_argument("--watch", action="store_true",
                    help="Mode watch stream USN (ingest piloté par événements)")
    ap.add_argument("--watch-interval", type=float, default=DEFAULT_WATCH_INTERVAL_SECONDS,
                    help=f"Intervalle de fallback polling en secondes (défaut {DEFAULT_WATCH_INTERVAL_SECONDS})")
    ap.add_argument("--debounce", type=float, default=DEFAULT_DEBOUNCE_SECONDS,
                    help=f"Délai de debounce watch en secondes (défaut {DEFAULT_DEBOUNCE_SECONDS})")
    ap.add_argument("--dry-run", action="store_true", help="Aperçu sans écriture")
    ap.add_argument("--limit", type=int, default=MAX_SESSIONS_DEFAULT)
    ap.add_argument("--reset", action="store_true", help="Repartir de zéro")
    ap.add_argument("--log-path", default=None, help="Chemin runtime.jsonl")
    args = ap.parse_args()
    if args.watch:
        return asyncio.run(run_watch(args))
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
