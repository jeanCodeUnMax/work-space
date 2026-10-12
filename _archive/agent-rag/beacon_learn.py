#!/usr/bin/env python3
"""
Beacon Learn - Boucle fermée d'apprentissage Beacon -> mémoire unifiée.

Complète beacon_ingest.py (qui distille des digests de sessions) en transformant
les événements bruts en apprentissages approuvés :

    événements JSONL ──▶ signals ──▶ candidates (memory.db beacon)
                                  ──▶ evaluations (rubric déterministe)
                                  ──▶ memories (memory.db beacon)
                                  ──▶ entities/observations/relations + memories
                                      + memory_fts (memory_mcp.db canonique)

Après ce run, `beacon.search_memory` / `get_memory_context` servent les
apprentissages aux autres agents, et memory_search (Memory MCP) aussi.

100 % local : sqlite3 direct (WAL + busy_timeout), aucun appel réseau.
Traitement incrémental : offset JSONL propre (.beacon-learn-state.json) ; la
récurrence est persistée dans `candidates` (memory.db), pas dans le state file.

Usage:
    python beacon_learn.py --once               # run unique (défaut)
    python beacon_learn.py --dry-run            # aperçu sans écriture
    python beacon_learn.py --reset              # repartir de zéro
    python beacon_learn.py --rotations          # inclut runtime.jsonl.{N..1} au 1er run
    python beacon_learn.py --promote-score 0.65 # seuil de promotion
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Réutilise les helpers de beacon_ingest (même dossier .agent/rag/)
from beacon_ingest import DEFAULT_LOG, _env_db_root, _iter_events  # noqa: E402

STATE_FILE = Path(__file__).resolve().parent.parent / "scripts" / ".beacon-learn-state.json"
BEACON_MEMORY_DB = Path.home() / ".beacon" / "endpoint" / "memory.db"
KG_SUBPATH = Path("current_workspace") / "graph" / "memory_mcp.db"

RUBRIC = "beacon-learn-rubric-v1"
RUBRIC_HASH = hashlib.sha256(RUBRIC.encode()).hexdigest()[:16]

PROMOTE_SCORE = 0.60            # seuil standard
CORRECTION_SCORE = 0.45         # corrections utilisateur = signal de vérité
MIN_SESSIONS = 2                # récurrence minimale (hors corrections)
MAX_EVIDENCE = 80               # cap d'evidence par candidate_json
MAX_EXCERPT = 240

SEV_WEIGHT = {"info": 0.2, "warning": 0.5, "high": 0.8, "error": 0.8, "critical": 1.0}
ERROR_SEVERITIES = {"warning", "high", "error", "critical"}
LEARNING_KINDS = {"workflow", "correction", "debugging_pattern", "gotcha", "convention"}

# Marqueurs de correction utilisateur (fr/en) — un prompt court + marqueur
CORRECTION_RE = re.compile(
    r"(?i)\b(non[,! .]|pas ça|c'est pas|ce n'est pas|plutôt|a la place|à la place|"
    r"instead|wrong|not that|en fait|actually|trompé|correction\b)"
)

POLICY_ACTIONS = {"approval.requested", "approval.decided", "policy.violation",
                  "policy.decision", "command.blocked", "tool.blocked"}


# ---------------------------------------------------------------- state file

def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"offset": 0, "run_count": 0}


def _save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(text: str, limit: int = MAX_EXCERPT) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())[:limit]


def _sha16(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8", "ignore")).hexdigest()[:16]


def _slug(text: str, limit: int = 48) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (s[:limit] or "item")


# ---------------------------------------------------------------- sqlite I/O

def _connect(db_path: Path, rw: bool = True):
    """Connexion sqlite WAL-tolérante. Retourne None si indisponible."""
    if not db_path.exists():
        return None
    try:
        uri = f"file:{db_path.as_posix()}" + ("" if rw else "?mode=ro")
        con = sqlite3.connect(uri, uri=True, timeout=8)
        con.execute("PRAGMA busy_timeout=8000;")
        return con
    except sqlite3.Error:
        return None


def _kg_db_path() -> Path:
    root = os.environ.get("AGENT_DB_ROOT") or str(Path.home() / ".hephaistos" / "data")
    return Path(root) / KG_SUBPATH


# ------------------------------------------------------- extraction de signaux

def _session_timelines(events: list) -> dict:
    """Groupe les événements par session, en timeline triée par timestamp."""
    sessions = defaultdict(lambda: {"harness": None, "repository": None, "items": []})
    for e in events:
        sess = e.get("session") or {}
        sid = sess.get("id") or "unknown"
        s = sessions[sid]
        s["harness"] = s["harness"] or (e.get("harness") or {}).get("name")
        s["repository"] = s["repository"] or e.get("repository")
        s["items"].append(e)
    for s in sessions.values():
        s["items"].sort(key=lambda e: e.get("timestamp") or "")
    return sessions


def _is_error_event(e: dict) -> bool:
    ev = e.get("event") or {}
    return (e.get("severity") in ERROR_SEVERITIES
            or bool((e.get("error") or {}).get("type"))
            or ev.get("action") == "session.error")


def _evidence(sid: str, s: dict, e: dict, excerpt: str) -> dict:
    return {
        "session": sid, "ts": e.get("timestamp"), "harness": s["harness"],
        "repository": s["repository"], "severity": e.get("severity") or "info",
        "excerpt": _norm(excerpt),
    }


def _extract_signals(events: list) -> list:
    """
    Détecte les apprentissages candidats dans le batch d'événements.
    Retourne une liste de {signature, kind, title, evidence[]}.
    """
    sessions = _session_timelines(events)
    signals = defaultdict(lambda: {"kind": None, "title": None, "evidence": []})

    # Compteurs trans-sessions pour la récurrence
    recur = defaultdict(lambda: {"sessions": set(), "harnesses": set(),
                                 "repos": set(), "last_ts": "", "example": ""})

    def recur_add(key: str, sid: str, s: dict, ts: str, example: str):
        r = recur[key]
        r["sessions"].add(sid)
        if s["harness"]:
            r["harnesses"].add(s["harness"])
        if s["repository"]:
            r["repos"].add(s["repository"])
        r["last_ts"] = max(r["last_ts"], ts or "")
        if not r["example"]:
            r["example"] = _norm(example)

    for sid, s in sessions.items():
        items = s["items"]
        error_idx = [i for i, e in enumerate(items) if _is_error_event(e)]

        for i, e in enumerate(items):
            ev = e.get("event") or {}
            action = ev.get("action", "")
            cat = ev.get("category") or e.get("category") or ""
            ts = e.get("timestamp") or ""
            msg = e.get("message") or ""

            # --- 1. erreur résolue -------------------------------------
            if i in error_idx:
                later_fix = any(
                    (items[j].get("event") or {}).get("action")
                    in ("file.modified", "command.executed", "tool.invoked")
                    for j in range(i + 1, min(i + 8, len(items))))
                etype = (e.get("error") or {}).get("type") or action or "error"
                sig = "err:" + _sha16(str(etype), _norm(msg or etype, 60))
                kind = "debugging_pattern" if later_fix else "gotcha"
                entry = signals[sig]
                entry["kind"] = kind
                entry["title"] = (f"{'Erreur résolue' if later_fix else 'Erreur récurrente'} "
                                  f"[{etype}] : {_norm(msg, 90) or sig}")
                entry["evidence"].append(_evidence(sid, s, e, msg or str(etype)))
                if later_fix:
                    fix = next((items[j] for j in range(i + 1, min(i + 8, len(items)))
                                if (items[j].get("event") or {}).get("action")
                                in ("file.modified", "command.executed")), None)
                    if fix is not None:
                        fp = (fix.get("file") or {}).get("path") or \
                             ((fix.get("raw") or {}).get("cascade") or {}
                              ).get("tool_info", {}).get("command_line") or ""
                        if fp:
                            entry["evidence"][-1]["fix"] = _norm(str(fp), 160)
                continue

            # --- 2. correction utilisateur ------------------------------
            if action == "prompt.submitted":
                prompt = (e.get("prompt") or {}).get("content") or msg
                if prompt and len(prompt) >= 15 and CORRECTION_RE.search(prompt):
                    sig = "corr:" + _sha16(_norm(prompt, 80))
                    entry = signals[sig]
                    entry["kind"] = "correction"
                    entry["title"] = f"Correction utilisateur : {_norm(prompt, 90)}"
                    entry["evidence"].append(_evidence(sid, s, e, prompt))
                continue

            # --- 3. policy / approval (forward-compatible) --------------
            decision = (e.get("decision") or (e.get("approval") or {}).get("decision")
                        or (e.get("policy") or {}).get("decision") or "")
            if action in POLICY_ACTIONS or cat in ("approval", "policy") or decision:
                rule = _norm(str((e.get("policy") or {}).get("rule")
                                 or (e.get("approval") or {}).get("scope") or msg or action), 80)
                denied = str(decision).lower() in ("denied", "blocked", "rejected") \
                    or action.endswith("blocked") or action == "policy.violation"
                sig = "pol:" + _sha16(rule)
                entry = signals[sig]
                entry["kind"] = "gotcha" if denied else "convention"
                entry["title"] = (f"Policy {'refusée' if denied else 'approuvée'} : {rule}")
                evd = _evidence(sid, s, e, f"{action} decision={decision or 'n/a'} rule={rule}")
                evd["severity"] = "high" if denied else "info"
                entry["evidence"].append(evd)
                continue

            # --- 4. accumulation récurrence -----------------------------
            if action == "command.executed":
                cmd = ((e.get("raw") or {}).get("cascade") or {}).get(
                    "tool_info", {}).get("command_line") or \
                    (e.get("raw") or {}).get("command") or msg
                head = " ".join(str(cmd).split()[:2])
                if head:
                    recur_add(f"cmd:{_slug(head, 40)}", sid, s, ts, f"cmd `{_norm(cmd,120)}`")
            elif action == "tool.invoked":
                name = (e.get("tool") or {}).get("name")
                if name:
                    recur_add(f"tool:{name}", sid, s, ts, f"outil {name}")
            elif action == "mcp.tool_invoked":
                mt = e.get("mcp") or {}
                if mt.get("tool"):
                    recur_add(f"mcp:{mt.get('server','?')}.{mt['tool']}", sid, s, ts,
                              f"mcp {mt.get('server','?')}.{mt['tool']}")
            elif action == "file.modified":
                fp = (e.get("file") or {}).get("path")
                if fp:
                    recur_add(f"file:{_slug(Path(fp).name, 40)}", sid, s, ts, f"fichier {fp}")

    # --- signaux de récurrence (≥ MIN_SESSIONS sessions distinctes) ------
    for key, r in recur.items():
        if len(r["sessions"]) < MIN_SESSIONS:
            continue
        domain = key.split(":", 1)[0]
        kind = "workflow" if domain in ("cmd", "tool") else "convention"
        sig = f"rec:{key}"
        entry = signals[sig]
        entry["kind"] = kind
        entry["title"] = (f"Pattern récurrent ({len(r['sessions'])} sessions) : {r['example']}")
        entry["evidence"].append({
            "session": sorted(r["sessions"])[-1], "ts": r["last_ts"],
            "harness": sorted(r["harnesses"])[0] if r["harnesses"] else None,
            "repository": sorted(r["repos"])[0] if r["repos"] else None,
            "severity": "info",
            "excerpt": f"{r['example']} — {len(r['sessions'])} sessions, "
                       f"harnesses={sorted(r['harnesses'])}, repos={len(r['repos'])}",
            "sessions_count": len(r["sessions"]),
        })

    return [{"signature": sig, **v} for sig, v in signals.items()
            if v["kind"] in LEARNING_KINDS]


# ---------------------------------------------------- candidates (beacon db)

def _upsert_candidate(con: sqlite3.Connection, signal: dict, project_id: str) -> str:
    """Crée ou enrichit un candidat. Retourne candidate_id."""
    cid = "cand_" + _sha16(signal["kind"], signal["signature"])
    now = _now()
    row = con.execute("SELECT candidate_json, state FROM candidates WHERE id=?", (cid,)).fetchone()
    if row:
        try:
            payload = json.loads(row[0])
        except json.JSONDecodeError:
            payload = {}
        seen = {(ev.get("session"), ev.get("excerpt", "")[:80]) for ev in payload.get("evidence", [])}
        for ev in signal["evidence"]:
            k = (ev.get("session"), ev.get("excerpt", "")[:80])
            if k not in seen:
                payload.setdefault("evidence", []).append(ev)
                seen.add(k)
        payload["evidence"] = payload.get("evidence", [])[-MAX_EVIDENCE:]
        payload["signature"] = signal["signature"]
        payload["title"] = signal["title"]
        state = row[1] if row[1] in ("promoted", "rejected") else "detected"
        con.execute(
            "UPDATE candidates SET candidate_json=?, updated_at=?, state=? WHERE id=?",
            (json.dumps(payload, ensure_ascii=False), now, state, cid))
    else:
        payload = {"signature": signal["signature"], "title": signal["title"],
                   "kind": signal["kind"], "evidence": signal["evidence"][:MAX_EVIDENCE],
                   "detector": RUBRIC}
        con.execute(
            "INSERT INTO candidates (id, project_id, state, kind, title,"
            " source_evaluation_id, memory_id, created_at, updated_at, candidate_json)"
            " VALUES (?,?,?,?,?,NULL,NULL,?,?,?)",
            (cid, project_id, "detected", signal["kind"], signal["title"][:200],
             now, now, json.dumps(payload, ensure_ascii=False)))
    return cid


# ------------------------------------------------------------------ rubric

def _evaluate(con: sqlite3.Connection, cid: str) -> dict:
    """Score déterministe d'un candidat. Insère une evaluation, met à jour l'état."""
    row = con.execute("SELECT kind, title, project_id, candidate_json, state"
                      " FROM candidates WHERE id=?", (cid,)).fetchone()
    kind, title, project_id, cjson, state = row
    payload = json.loads(cjson)
    evidence = payload.get("evidence", [])

    sessions = {e.get("session") for e in evidence if e.get("session")}
    # Les signaux de récurrence agrègent des sessions trans-run via sessions_count
    # (une seule entrée evidence porte le total — ne pas sous-compter)
    extra = sum(int(e.get("sessions_count") or 0) for e in evidence)
    n_sessions = max(len(sessions), extra)
    harnesses = {e.get("harness") for e in evidence if e.get("harness")}
    repos = {e.get("repository") for e in evidence if e.get("repository")}
    sev = max((SEV_WEIGHT.get(e.get("severity"), 0.2) for e in evidence), default=0.2)
    last_ts = max((e.get("ts") or "" for e in evidence), default="")

    recurrence = min(n_sessions / 3.0, 1.0) if n_sessions else min(len(evidence) / 3.0, 1.0)
    severity = 0.7 if kind == "correction" else max(sev, 0.3)
    adoption = 1.0 if len(harnesses) >= 2 else (0.6 if len(repos) >= 2 else 0.3)
    try:
        age_days = (datetime.now(timezone.utc)
                    - datetime.fromisoformat(last_ts.replace("Z", "+00:00"))).days
    except (ValueError, AttributeError):
        age_days = 999
    recency = 1.0 if age_days < 7 else (0.6 if age_days < 30 else 0.3)

    score = round(0.40 * recurrence + 0.25 * severity + 0.20 * adoption + 0.15 * recency, 3)
    threshold = CORRECTION_SCORE if kind == "correction" else PROMOTE_SCORE
    enough_evidence = kind == "correction" or n_sessions >= MIN_SESSIONS \
        or len(evidence) >= MIN_SESSIONS
    status = "approved" if (score >= threshold and enough_evidence) else "rejected"

    eval_json = {
        "rubric": RUBRIC, "score": score, "threshold": threshold,
        "criteria": {"recurrence": round(recurrence, 3), "severity": severity,
                     "adoption": adoption, "recency": recency},
        "counts": {"sessions": len(sessions), "harnesses": len(harnesses),
                   "repos": len(repos), "evidence": len(evidence)},
        "status": status,
    }
    eval_id = "eval_" + _sha16(cid, _now())
    # La table impose UNIQUE(project_id, trace_id, rubric_hash) : plusieurs
    # candidats issus de la même session collisionneraient -> trace_id qualifié.
    trace_ref = f"{sorted(sessions)[-1] if sessions else 'global'}|{cid}"
    con.execute(
        "INSERT OR REPLACE INTO evaluations (id, project_id, trace_id, status, created_at,"
        " updated_at, rubric_hash, evaluator, evaluation_json)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (eval_id, project_id, trace_ref,
         status, _now(), _now(), RUBRIC_HASH, "beacon-learn",
         json.dumps(eval_json, ensure_ascii=False)))
    new_state = "promoted" if status == "approved" else ("evaluated" if state != "promoted" else state)
    con.execute("UPDATE candidates SET state=?, source_evaluation_id=?, updated_at=? WHERE id=?",
                (new_state, eval_id, _now(), cid))
    return {"eval_id": eval_id, "cid": cid, "kind": kind, "title": title,
            "project_id": project_id, "payload": payload, "score": score,
            "status": status, "sessions": sorted(sessions), "harnesses": sorted(harnesses),
            "repos": sorted(repos)}


# ---------------------------------------------------------- promotion (writes)

def _try_embed(text: str):
    """Embedding float32 BLOB via MiniLM local si dispo, sinon None (champ nullable)."""
    try:
        import numpy as np
        try:
            from sentence_transformers import SentenceTransformer
            model = SentenceTransformer("all-MiniLM-L6-v2")
            vec = model.encode(text[:2000])
        except ImportError:
            from transformers import AutoTokenizer, AutoModel
            import torch
            tok = AutoTokenizer.from_pretrained("Xenova/all-MiniLM-L6-v2")
            mdl = AutoModel.from_pretrained("Xenova/all-MiniLM-L6-v2")
            with torch.no_grad():
                out = mdl(**tok(text[:2000], return_tensors="pt",
                                truncation=True, padding=True))
            vec = out.last_hidden_state.mean(dim=1)[0].numpy()
        return np.asarray(vec, dtype=np.float32).tobytes()
    except Exception:
        return None


def _memory_body(ev: dict) -> str:
    p = ev["payload"]
    lines = [f"## {ev['title']}", "",
             f"- Kind: `{ev['kind']}` | Score: {ev['score']} | Signature: `{p.get('signature')}`",
             f"- Sessions: {len(ev['sessions'])} | Harnesses: {', '.join(ev['harnesses']) or '?'}",
             f"- Repos: {', '.join(ev['repos']) or '?'}", "", "### Evidence"]
    for e in p.get("evidence", [])[:8]:
        line = f"- `{e.get('ts','?')[:19]}` [{e.get('severity','info')}] {e.get('excerpt','')}"
        if e.get("fix"):
            line += f" → fix: {e['fix']}"
        lines.append(line)
    return "\n".join(lines)[:4000]


def _kg_write(con: sqlite3.Connection, ev: dict, mem_id: str, body: str) -> tuple:
    """Écrit entités learning/decision + observations + relations + entity_scope.
    Retourne (entity_id, entity_refs)."""
    entity_type = "decision" if ev["kind"] in ("convention",) else "learning"
    ent_name = f"{entity_type}:{_slug(ev['kind'], 20)}-{_sha16(ev['cid'])[:8]}"

    def ensure_entity(name: str, etype: str, scope: str = "global",
                      kind: str = "knowledge") -> int:
        con.execute("INSERT OR IGNORE INTO entities (name, entityType) VALUES (?,?)",
                    (name, etype))
        eid = con.execute("SELECT id FROM entities WHERE name=?", (name,)).fetchone()[0]
        con.execute("INSERT OR IGNORE INTO entity_scope (entity_id, scope, kind) VALUES (?,?,?)",
                    (eid, scope, kind))
        return eid

    eid = ensure_entity(ent_name, entity_type)
    for obs in [f"[beacon-learn {RUBRIC}] {ev['title']} (score={ev['score']})",
                body[:1000], f"promoted_from={ev['cid']} memory_id={mem_id}"]:
        if not con.execute("SELECT 1 FROM observations WHERE entity_id=? AND content=?",
                           (eid, obs)).fetchone():
            con.execute("INSERT INTO observations (entity_id, content) VALUES (?,?)", (eid, obs))

    entity_refs = [ent_name]
    for repo in ev["repos"][:3]:
        pname = f"project:{_slug(Path(str(repo)).name, 40)}"
        ensure_entity(pname, "project", "global", "project")
        con.execute("INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType)"
                    " VALUES (?,?,?)", (ent_name, pname, "applies_to"))
        entity_refs.append(pname)
    for h in ev["harnesses"][:3]:
        hname = f"harness:{_slug(h, 30)}"
        ensure_entity(hname, "tool", "global", "tool")
        con.execute("INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType)"
                    " VALUES (?,?,?)", (ent_name, hname, "observed_in"))
        entity_refs.append(hname)
    for sid in ev["sessions"][:3]:
        sname = f"beacon-session:{_slug(sid, 40)}"
        ensure_entity(sname, "beacon_session", "global", "other")
        con.execute("INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType)"
                    " VALUES (?,?,?)", (ent_name, sname, "extracted_from"))
        entity_refs.append(sname)
    return eid, entity_refs


def _promote(con_beacon: sqlite3.Connection, con_kg, ev: dict, user_id: str) -> str:
    """Écrit la mémoire approuvée dans memory.db (beacon) + memory_mcp.db (KG)."""
    mem_id = "blm_" + _sha16(ev["cid"], "memory")
    body = _memory_body(ev)
    now = _now()

    # 1. beacon memory.db — alimente beacon.search_memory / get_memory_context
    memory_json = {
        "kind": ev["kind"], "title": ev["title"], "body": body,
        "signature": ev["payload"].get("signature"), "score": ev["score"],
        "evaluation_id": ev["eval_id"], "evidence": ev["payload"].get("evidence", [])[:12],
        "harnesses": ev["harnesses"], "repositories": ev["repos"],
        "source": "beacon-learn", "rubric": RUBRIC,
    }
    con_beacon.execute(
        "INSERT OR IGNORE INTO memories (id, candidate_id, project_id, kind, title,"
        " created_at, updated_at, superseded_by, memory_json) VALUES (?,?,?,?,?,?,?,NULL,?)",
        (mem_id, ev["cid"], ev["project_id"], ev["kind"], ev["title"][:200],
         now, now, json.dumps(memory_json, ensure_ascii=False)))
    con_beacon.execute("UPDATE candidates SET memory_id=?, state='promoted', updated_at=?"
                       " WHERE id=?", (mem_id, now, ev["cid"]))

    # 2. memory_mcp.db — store canonique (table memories + FTS + graphe)
    if con_kg is not None:
        if not con_kg.execute("SELECT 1 FROM memories WHERE promoted_from=?",
                              (ev["cid"],)).fetchone():
            eid, entity_refs = _kg_write(con_kg, ev, mem_id, body)
            embedding = _try_embed(ev["title"] + "\n" + body)
            importance = min(max(ev["score"], 0.5), 0.95)
            con_kg.execute(
                "INSERT OR IGNORE INTO memories (id, content, user_id, session_id, agent_id,"
                " turn_id, created_at, valid_from, valid_until, category, importance,"
                " supersedes, superseded_by, promoted_from, promotion_chain, access_count,"
                " last_accessed, entity_refs, embedding, metadata)"
                " VALUES (?,?,?,?,?,NULL,?,?,NULL,?,?,NULL,NULL,?,?,0,NULL,?,?,?)",
                (mem_id, body, user_id,
                 ev["sessions"][-1] if ev["sessions"] else None,
                 (ev["harnesses"] or ["beacon-learn"])[0],
                 now, now, ev["kind"], importance, ev["cid"],
                 json.dumps(["session_digest", "candidate", "evaluation", "memory"]),
                 json.dumps(entity_refs), embedding,
                 json.dumps({"source": "beacon", "rubric": RUBRIC, "score": ev["score"],
                             "signature": ev["payload"].get("signature"),
                             "candidate_id": ev["cid"],
                             "embedding_model": "all-MiniLM-L6-v2" if embedding else None},
                            ensure_ascii=False)))
            if not con_kg.execute("SELECT 1 FROM memory_fts WHERE memory_id=?",
                                  (mem_id,)).fetchone():
                con_kg.execute(
                    "INSERT INTO memory_fts (memory_id, content, user_id, session_id, category)"
                    " VALUES (?,?,?,?,?)",
                    (mem_id, body, user_id,
                     ev["sessions"][-1] if ev["sessions"] else None, ev["kind"]))
            # Enfile l'événement pour le bridge zvec→qdrant (partial-replication
            # polle sync_queue toutes les 5s et indexe entity+observations)
            con_kg.execute(
                "INSERT INTO sync_queue (event_data) VALUES (?)",
                (json.dumps({
                    "id": f"evt_{_sha16(ev['cid'], 'sync')}",
                    "tableName": "entities",
                    "recordId": eid,
                    "action": "INSERT",
                    "timestamp": now,
                    "source": "memory",
                    "syncType": "hybrid_indexing",
                }),))
    return mem_id


# ---------------------------------------------------------------------- run

def run(args) -> int:
    project_root = Path(__file__).resolve().parents[2]
    _env_db_root(project_root)

    log_path = Path(args.log_path).expanduser() if args.log_path else DEFAULT_LOG
    if not log_path.exists():
        print(f"[beacon-learn] Pas de journal Beacon: {log_path} — rien à faire.")
        return 0

    state = {"offset": 0, "run_count": 0} if args.reset else _load_state()

    # Optionnel : précharger les rotations au premier run (historique de récurrence)
    events = []
    if args.rotations and state["offset"] == 0:
        for rot in sorted(log_path.parent.glob(log_path.name + ".*"), reverse=True):
            if rot.suffix != ".lock":
                ev, _ = _iter_events(rot, 0)
                events += ev
        print(f"[beacon-learn] rotations préchargées : {len(events)} événements")
    new_events, new_offset = _iter_events(log_path, state["offset"])
    events += new_events

    if not events:
        print("[beacon-learn] Aucun nouvel événement depuis le dernier run.")
        return 0

    signals = _extract_signals(events)
    print(f"[beacon-learn] {len(events)} événements, {len(signals)} signaux candidats.")
    if args.dry_run:
        for s in signals[: args.limit]:
            print(f"--- [{s['kind']}] {s['title']} "
                  f"(evidence={len(s['evidence'])}, sig={s['signature'][:32]})")
        return 0
    if not signals:
        if not args.dry_run:
            state["offset"] = new_offset
            state["run_count"] = state.get("run_count", 0) + 1
            _save_state(state)
        return 0

    con_beacon = _connect(Path(args.memory_db).expanduser() if args.memory_db
                          else BEACON_MEMORY_DB)
    if con_beacon is None:
        print("[beacon-learn] memory.db Beacon inaccessible (verrou ou absent) — abort,"
              " offset non avancé (retry au prochain run).")
        return 1
    con_kg = _connect(Path(args.kg_db).expanduser() if args.kg_db else _kg_db_path())
    if con_kg is None:
        print("[beacon-learn] memory_mcp.db inaccessible — écriture beacon-only.")

    user_id = os.environ.get("USERNAME") or os.environ.get("USER") or "agent"
    promoted = rejected = errors = 0
    try:
        with con_beacon:
            for s in signals:
                try:
                    project = Path(str(s["evidence"][0].get("repository") or "global")).name \
                        or "global"
                    cid = _upsert_candidate(con_beacon, s, project)
                    res = _evaluate(con_beacon, cid)
                    if res["status"] == "approved":
                        mid = _promote(con_beacon, con_kg, res, user_id)
                        promoted += 1
                        print(f"[beacon-learn] PROMU {mid} [{res['kind']}] "
                              f"score={res['score']} :: {res['title'][:90]}")
                    else:
                        rejected += 1
                except Exception as e:
                    errors += 1
                    print(f"[beacon-learn] erreur signal {s['signature'][:24]}: {e}")
        if con_kg is not None:
            con_kg.commit()
    finally:
        con_beacon.close()
        if con_kg is not None:
            con_kg.close()

    state["offset"] = new_offset
    state["run_count"] = state.get("run_count", 0) + 1
    _save_state(state)
    print(f"[beacon-learn] Terminé: {promoted} promus, {rejected} rejetés/évalués,"
          f" {errors} erreurs.")
    return 0 if errors == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Boucle d'apprentissage Beacon -> mémoire unifiée")
    ap.add_argument("--once", action="store_true", help="Run unique (défaut)")
    ap.add_argument("--dry-run", action="store_true", help="Aperçu sans écriture")
    ap.add_argument("--reset", action="store_true", help="Repartir de zéro")
    ap.add_argument("--rotations", action="store_true",
                    help="Précharge runtime.jsonl.* au premier run")
    ap.add_argument("--limit", type=int, default=40, help="Max signaux affichés en dry-run")
    ap.add_argument("--log-path", default=None, help="Chemin runtime.jsonl")
    ap.add_argument("--memory-db", default=None, help="Chemin memory.db Beacon")
    ap.add_argument("--kg-db", default=None, help="Chemin memory_mcp.db canonique")
    ap.add_argument("--promote-score", type=float, default=None,
                    help="Override du seuil de promotion")
    args = ap.parse_args()
    if args.promote_score:
        global PROMOTE_SCORE
        PROMOTE_SCORE = args.promote_score
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
