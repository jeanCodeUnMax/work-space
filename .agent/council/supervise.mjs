#!/usr/bin/env node
// supervise.mjs — boucle Chairman : dispatch -> verifie livrable -> failover provider
// Usage: node .agent/council/supervise.mjs "question"
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = 'C:/data-sys/hephaistos2-kit';
const cfg = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors.json'), 'utf8'));
// noms de guerre : merge advisors-tribu.json (cle = session ou role)
const tribuNoms = new Map();
try {
  const tribu = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors-tribu.json'), 'utf8'));
  if (tribu.grandChef?.nom) tribuNoms.set(tribu.grandChef.role || 'Grand-Chef', tribu.grandChef.nom);
  for (const t of tribu.advisors || []) { tribuNoms.set(t.session, t.nom); tribuNoms.set(t.role, t.nom); }
} catch {}
const nomDe = (a, role) => tribuNoms.get(a?.session) || tribuNoms.get(role) || role;
const sessions = JSON.parse(readFileSync(join(ROOT, '.agent/chats/sessions.json'), 'utf8'));
const live = new Set((Array.isArray(sessions) ? sessions : sessions.sessions || []).map(s => s.id));
// Pool de rotation : fenetres live non assignees
const ASSIGNED = new Set(cfg.advisors.map(a => a.session));
const BACKUP = (Array.isArray(sessions) ? sessions : sessions.sessions || [])
  .filter(s => !ASSIGNED.has(s.id)).map(s => s.id);

const QUESTION = process.argv[2];
if (!QUESTION) { console.error('usage: supervise.mjs "question"'); process.exit(1); }
const DAY = new Date().toISOString().slice(0, 10);
const SLUG = QUESTION.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now().toString(36);
const DIR = `council/${DAY}/${SLUG}`;
mkdirSync(join(ROOT, DIR), { recursive: true });

const log = (m) => { console.log(m); writeFileSync(join(ROOT, DIR, 'supervision.log'), m + '\n', { flag: 'a' }); };

function inject(sessionId, prompt, timeout = 120) {
  try {
    execFileSync(process.execPath, [join(ROOT, '.agent/agent-bridge/acp-inject.js'),
      '--provider', 'hephaistos', '--session', sessionId, '--cwd', ROOT,
      '--prompt', prompt, '--wait', 'delivered', '--timeout', String(timeout)], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// recupere les fichiers egares (chemins faux observes : .council/, .agent/council/)
function rehomeStrays(role, targetDir) {
  for (const base of ['.council', '.agent/council']) {
    const walk = (d) => {
      try { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === `advisor-${role}.md` && !p.startsWith(targetDir)) {
          renameSync(join(ROOT, p), join(ROOT, targetDir, e.name));
          log(`rehome: ${p} -> ${targetDir}`); return true;
        }
      } } catch { }
    };
    try { walk(base); } catch { }
  }
  return false;
}

function hasFile(role) {
  rehomeStrays(role, DIR);
  return existsSync(join(ROOT, DIR, `advisor-${role}.md`));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- TOUR 1 : dispatch + supervision + failover ---
const pending = new Map(cfg.advisors.map(a => [a.role, a]));
const announce = (agent) => `${join('.agent', 'announce-' + agent + '.jsonl')}`;

for (const [role, a] of pending) {
  const prompt = `COUNCIL ${DAY}/${SLUG} — NOUVELLE QUESTION (ignore tout contexte precedent). "${QUESTION}" Tu es ${nomDe(a, role)}, ${role} de la tribu. Lis ton historique ${ROOT}/.agent/council/history/${a.agent}.md puis ${ROOT}/.agent/council/roles/${role}.md. Ecris ${ROOT}/${DIR}/advisor-${role}.md : commence par "**${nomDe(a, role)}** a parle :" puis ta parole (8-15 lignes : stance + 3 arguments + 1 assertion falsifiable) puis APPENDS une ligne {type:"advisor-done"} dans ${ROOT}/.agent/announce-${a.agent}.jsonl (cree le fichier si absent — JAMAIS comms.jsonl).`;
  let ok=false;
  for(let push=1;push<=3 && !ok;push++){ok = a.session && live.has(a.session) && inject(a.session, prompt);if(!ok)log(`${role}: push ${push}/3 echec`);}
  log(`${role} (${a.agent}) inject: ${ok ? 'delivered' : 'FAILED/absent'}`);
}

// supervision : deadline 4 min, rotation sur BACKUP si absent
const deadline = Date.now() + 4 * 60 * 1000;
while (pending.size && Date.now() < deadline) {
  await sleep(20000);
  for (const [role, a] of [...pending]) {
    if (hasFile(role)) { log(`${role}: livrable OK`); pending.delete(role); continue; }
  }
}
// failover
for (const [role, a] of pending) {
  let done = false;
  for (const bkp of BACKUP) {
    if (!live.has(bkp)) continue;
    log(`${role}: FAILOVER -> ${bkp}`);
    inject(bkp, `COUNCIL ${DAY}/${SLUG} — NOUVELLE QUESTION. "${QUESTION}" Tu es ${nomDe(null, role)}, ${role} de la tribu (suppleant — la torche t'est passee). Ecris ${ROOT}/${DIR}/advisor-${role}.md (commence par "**${nomDe(null, role)}** a parle :") puis APPENDS {type:"advisor-done"} dans ${ROOT}/.agent/announce-backup.jsonl.`);
    for (let i = 0; i < 9 && !hasFile(role); i++) await sleep(20000);
    if (hasFile(role)) { log(`${role}: livrable via backup ${bkp}`); done = true; break; }
  }
  if (!done) log(`${role}: ECHEC TOTAL — absent du concile`);
}
console.log('TOUR1 termine — livrables:', cfg.advisors.filter(a => hasFile(a.role)).length + '/' + cfg.advisors.length);
