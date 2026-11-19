#!/usr/bin/env node
// tipi.mjs — cercle de parole : chaque advisor prend le calumet, parle devant
// tous (transcript partage), passe au voisin. Chairman juge a la fin.
// Usage: node .agent/council/tipi.mjs "question"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = 'C:/data-sys/hephaistos2-kit';
const cfg = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors.json'), 'utf8'));
// noms de guerre : merge advisors-tribu.json (cle = session ou role)
try {
  const tribu = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors-tribu.json'), 'utf8'));
  const noms = new Map();
  if (tribu.grandChef?.nom) noms.set(tribu.grandChef.role || 'Grand-Chef', tribu.grandChef.nom);
  for (const t of tribu.advisors || []) { noms.set(t.session, t.nom); noms.set(t.role, t.nom); }
  for (const a of cfg.advisors) a.nom = noms.get(a.session) || noms.get(a.role) || a.role;
} catch { for (const a of cfg.advisors) a.nom = a.role; }
const sessions = JSON.parse(readFileSync(join(ROOT, '.agent/chats/sessions.json'), 'utf8'));
const live = new Set((Array.isArray(sessions) ? sessions : sessions.sessions || []).map(s => s.id));
const ASSIGNED = new Set(cfg.advisors.map(a => a.session));
const BACKUP = (Array.isArray(sessions) ? sessions : sessions.sessions || []).filter(x => !ASSIGNED.has(x.id) && (x.messages||[]).length > 0).map(x => x.id);
const QUESTION = process.argv[2];
if (!QUESTION) { console.error('usage: tipi.mjs "question"'); process.exit(1); }
const DAY = new Date().toISOString().slice(0, 10);
const SLUG = QUESTION.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now().toString(36);
const DIR = `council/${DAY}/${SLUG}`;
const CALUMET = `${DIR}/calumet.md`;   // transcript partage — le baton de parole
mkdirSync(join(ROOT, DIR), { recursive: true });
writeFileSync(join(ROOT, '.agent/council/current-Q.txt'), `${DAY}/${SLUG}`);
writeFileSync(join(ROOT, CALUMET), `# 🔥 CALUMET — cercle de parole\n\nQuestion du feu : "${QUESTION}"\n\nChacun parle a son tour, tous entendent. Le chef juge a la fin.\n\n`);
const log = (m) => { console.log(m); appendFileSync(join(ROOT, DIR, 'supervision.log'), m + '\n'); };

function pingPresence(sessionId, ms = 45000) {
  const c = (Array.isArray(sessions)?sessions:sessions.sessions||[]).find(x=>x.id===sessionId);
  const before = c ? (c.messages||[]).length : 0;
  const ok = inject(sessionId, "PING : reponds uniquement PONG", 60);
  if (!ok) return false;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const cur = JSON.parse(readFileSync(join(ROOT, ".agent/chats/sessions.json"), "utf8"));
      const s2 = (Array.isArray(cur)?cur:cur.sessions||[]).find(x=>x.id===sessionId);
      if (s2 && (s2.messages||[]).length > before + 1) return true;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  return false;
}

function inject(sessionId, prompt, timeout = 150) {
  try {
    execFileSync(process.execPath, [join(ROOT, '.agent/agent-bridge/acp-inject.js'),
      '--provider', 'hephaistos', '--session', sessionId, '--cwd', ROOT,
      '--prompt', prompt, '--wait', 'delivered', '--timeout', String(timeout)], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const spoken = (role) => existsSync(join(ROOT, DIR, `speech-${role}.md`));

// --- le cercle : ordre fixe, tours sequentiels ---
const circle = cfg.advisors.filter(a => live.has(a.session));
const absent = cfg.advisors.filter(a => !live.has(a.session));
for (const a of absent) log(`${a.role}: absent du cercle (${a.agent})`);

for (const a of circle) {
  let sid = a.session; let sub = '';
  if (live.has(sid) && !pingPresence(sid)) { log(`${a.role}: ${a.agent} SILENCIEUX au ping`); sid = '_dead_'; }
  while (sid === '_dead_' || !live.has(sid)) {
    const bkp = BACKUP.find(b => live.has(b) && pingPresence(b));
    if (!bkp) { log(`${a.role}: AUCUN provider vivant — silence force`); sid=null; break; }
    sid = bkp; sub = ` (suppleant ${bkp.slice(0,12)} pour ${a.agent})`;
    log(`${a.role}: ROTATION -> ${sid} (presence verifiee)`); break;
  }
  if (!sid) continue;
  if (!live.has(sid)) {
    const bkp = BACKUP.find(b => live.has(b));
    if (!bkp) { log(`${a.role}: PAS DE SUPPLEANT — silence`); continue; }
    sid = bkp; sub = ` (suppleant ${bkp.slice(0,12)} pour ${a.agent})`;
    log(`${a.role}: ROTATION -> ${sid}`);
  }
  const prompt = `CERCLE TIPI ${DAY}/${SLUG} — NOUVELLE QUESTION. "${QUESTION}"
Tu es ${a.nom}, ${a.role} de la tribu. Lis ton historique ${ROOT}/.agent/council/history/${a.agent}.md (tes interventions passes). Le calumet circule : LIS ${ROOT}/${CALUMET} — tu ENTENDS les paroles de ceux qui ont deja parle.
Prends le calumet a ton tour : exprime ton point de vue sous ton angle (8-15 lignes), tu peux accorder ou contredire ceux qui ont parle avant — cite-les par leur nom de guerre.
Ecris ta parole dans ${ROOT}/${DIR}/speech-${a.role}.md : commence par "**${a.nom}** a parle :" puis ta parole (8-15 lignes), puis APPENDS {from:"${a.agent}",type:"calumet-done"} dans ${ROOT}/.agent/announce-${a.agent}.jsonl.`;
  log(`${a.nom} (${a.role} / ${a.agent}): calumet injecte`);
  const ok = inject(a.session, prompt);
  log(`  delivered: ${ok}`);
  // attendre que la parole soit ecrite (deadline 3 min)
  for (let i = 0; i < 9 && !spoken(a.role); i++) await sleep(20000);
  if (spoken(a.role)) { appendFileSync(join(ROOT, CALUMET), '\n**' + a.nom + '** (' + a.role + (sub ? ' ' + sub : '') + ') prend le calumet :\n' + readFileSync(join(ROOT, DIR, 'speech-' + a.role + '.md'), 'utf8') + '\n'); }
  log(`  parole: ${spoken(a.role) ? 'ENTENDUE dans le transcript' : 'SILENCE — calumet passe au suivant'}`);
}
console.log('CERCLE clos — transcript:', CALUMET);
