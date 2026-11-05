#!/usr/bin/env python3
# council-run.py — orchestre le concile SWAT via acp-inject (fenetres bleubites reelles).
# Phases : 1 avis paralleles -> 2 revue anonymisee -> 3 debat chaine x2 -> transcript + verdict data.
import json, os, subprocess, sys, threading, time, random

ROOT = os.environ.get("HPHE_WORKSPACE", r"C:\Program Files\Projet-complet\VIdo_Prod")
INJECT = os.path.join(ROOT, ".agent", "agent-bridge", "acp-inject.js")
SESSIONS = os.path.join(ROOT, ".agent", "chats", "sessions.json")
REPORTS = os.path.join(ROOT, ".agent", "reports")
ROSTER = os.path.join(ROOT, ".agent", "workspace-roster.json")
os.makedirs(REPORTS, exist_ok=True)
LIVE = os.path.join(REPORTS, "concil-live-bleubites.md")
TIMEOUT = 300

roster = json.load(open(ROSTER, encoding="utf-8"))
wf = roster["workflow"]
ENTRY = wf["entrySessionId"]
nodes = {n["sessionId"]: n for n in wf["nodes"]}
chairman = nodes[ENTRY]
QUESTION = " ".join(sys.argv[1:]).strip() or (chairman.get("question") or "").strip() or "Problematique non precisee."
ADVISORS = [n for n in wf["nodes"] if n["sessionId"] != ENTRY]

def read_session(sid):
    try:
        data = json.load(open(SESSIONS, encoding="utf-8"))
        for s in (data if isinstance(data, list) else data.get("sessions", [])):
            if s.get("id") == sid:
                msgs = [m for m in s.get("messages", []) if m.get("role") == "assistant" and (m.get("text") or "").strip()]
                return msgs[-1]["text"].strip() if msgs else ""
    except Exception:
        return ""
    return ""

def inject(sid, prompt):
    p = subprocess.run(
        ["node", INJECT, "--provider", "hephaistos", "--session", sid,
         "--prompt", prompt, "--wait", "turn", "--timeout", str(TIMEOUT)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT, timeout=TIMEOUT + 60)
    return (p.stdout or "")[-500:] + (p.stderr or "")[-200:]

transcript = []  # {role, sid, phase, text, label}

def write_live():
    lines = [f"# Concile bleubites — {wf.get('activeSchema','Concile')}", "",
             f"**Question** : {QUESTION}", ""]
    for t in transcript:
        tag = f" (reponse {t['label']})" if t.get("label") else ""
        lines.append(f"## [{t['phase']}] {t['role']}{tag}\n\n{t['text']}\n")
    open(LIVE, "w", encoding="utf-8").write("\n".join(lines))

def fmt_ts():
    return "\n\n".join(f"[{t['phase']}] {t['role']}{' ('+t['label']+')' if t.get('label') else ''}:\n{t['text']}" for t in transcript)

def skills_of(n):
    s = ", ".join(n.get("skills") or [])
    return f" Competences: {s}." if s else ""

def phase(name, items, prompt_fn, parallel):
    def work(node):
        before = read_session(node["sessionId"])
        prompt = prompt_fn(node)
        out = inject(node["sessionId"], prompt)
        time.sleep(2)
        reply = read_session(node["sessionId"])
        if reply == before or not reply:
            reply = f"[echec inject] {out[-200:]}"
        transcript.append({"role": node["role"], "sid": node["sessionId"], "phase": name, "text": reply})
        write_live()
    if parallel:
        th = [threading.Thread(target=work, args=(n,)) for n in items]
        [t.start() for t in th]; [t.join() for t in th]
    else:
        for n in items:
            work(n)

log = lambda m: (print(m, flush=True))
log(f"Question: {QUESTION[:80]}")
write_live()

# Phase 1 — avis independants paralleles
phase("Avis", ADVISORS, lambda n:
      f"[CONCILE — avis independant]\nTu es {n['role']}, conseiller siégeant au concile.{skills_of(n)}\n"
      f"Ton angle de pensée : {n['task']}\n\nQUESTION À TRANCHER:\n{QUESTION}\n\n"
      "Réponds depuis ton angle uniquement — direct, spécifique, sans complaisance ni fausse balance. "
      "Pousse ta perspective à fond : les autres conseillers couvrent les angles que tu ne traites pas. "
      "Entre 150 et 300 mots, sans préambule.", True)
log("phase1 done")

# Phase 2 — revue anonymisee parallele
letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
opinions = [t for t in transcript if t["phase"] == "Avis"]
random.shuffle(opinions)
for i, t in enumerate(opinions):
    t["label"] = letters[i]
anon_map = {t["label"]: t["role"] for t in opinions}
write_live()
anon_txt = "\n\n".join(f"**Réponse {t['label']} :**\n{t['text']}" for t in opinions)
phase("Revue", ADVISORS, lambda n:
      f"[CONCILE — revue par les pairs]\nTu es {n['role']}, conseiller siégeant au concile.{skills_of(n)}\n\n"
      f"{len(opinions)} conseillers ont répondu indépendamment à cette question :\n\n---\n{QUESTION}\n---\n\n"
      f"Voici leurs réponses, anonymisées :\n\n{anon_txt}\n\n"
      "Réponds à ces trois questions en citant les lettres :\n"
      "1. Quelle réponse est la plus forte, et pourquoi ?\n"
      "2. Quelle réponse a le plus gros angle mort, et que manque-t-il ?\n"
      "3. Qu'est-ce que TOUTES les réponses ont raté et que le concile doit considérer ?\n\n"
      "Moins de 200 mots. Direct.", True)
log("phase2 done")

# Phase 3 — debat ouvert chaine, 2 tours
for rnd in (1, 2):
    phase(f"Débat", ADVISORS, lambda n:
          f"[CONCILE — débat ouvert, tour {rnd}/2]\nTu es {n['role']}, conseiller siégeant au concile.{skills_of(n)}\n"
          f"Ton angle de pensée : {n['task']}\n\nQUESTION À TRANCHER:\n{QUESTION}\n\n"
          f"DÉLIBÉRATION COMPLÈTE JUSQU'ICI (avis dé-anonymisés, revues, répliques):\n{fmt_ts()}\n\n"
          "L'anonymat est levé : réplique aux désaccords en citant les conseillers par leur rôle, "
          "renforce ou nuance ta position, et indique si tu converges vers un consensus — lequel. "
          "Concis et tranché, 150-250 mots.", False)
    log(f"debate round {rnd} done")

mapping = ", ".join(f"{k}={v}" for k, v in sorted(anon_map.items()))
payload = {"question": QUESTION, "mapping": mapping, "transcript": transcript}
out = os.path.join(REPORTS, "concil-bleubites-transcript.json")
json.dump(payload, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
log(f"DONE transcript={out}")
