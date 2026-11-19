#!/usr/bin/env node
// tribu-calumet — conseil tribal séquentiel. Le Grand Chef passe le calumet à
// chaque advisor dans l'ordre : chacun parle EN ENTENDANT les paroles déjà
// prononcées (accord, contradiction, complément). Transcript → calumet.md.
// Usage : node tribu-calumet.mjs "QUESTION" [--cwd ROOT]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.argv.includes('--cwd')
  ? process.argv[process.argv.indexOf('--cwd') + 1]
  : 'C:/data-sys/hephaistos2-kit';
const QUESTION = process.argv.slice(2).find(a => !a.startsWith('--') && a !== ROOT);
if (!QUESTION) { console.error('usage: tribu-calumet.mjs "QUESTION"'); process.exit(1); }

const cfg = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors-tribu.json'), 'utf8'));
const BRIDGE = join(ROOT, '.agent/agent-bridge/acp-inject.js');
const STORE = join(ROOT, '.agent/chats/sessions.json');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const slug = QUESTION.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').slice(0, 45) + '-' + Math.random().toString(36).slice(2, 8);
const DIR = join(ROOT, 'council', new Date().toISOString().slice(0, 10), 'tribu-' + slug);
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'question.md'), '# QUESTION DE LA TRIBU\n\n' + QUESTION + '\n');

function assistantMsgs(sessionId) {
  try {
    const s = JSON.parse(readFileSync(STORE, 'utf8')).sessions || [];
    const e = s.find(x => x.id === sessionId);
    return (e?.messages || []).filter(x => x.role === 'assistant' && (x.text || '').trim());
  } catch { return null; }   // store en cours d'écriture → on repolle
}

let transcript = '';
const results = [];
for (const a of cfg.advisors) {
  const t0 = new Date().toISOString();
  const prompt = `[TRIBU — ${a.role}] Le Grand Chef te passe le calumet.\n\nQUESTION: ${QUESTION}\n` +
    (transcript ? `\nPAROLES DÉJÀ PRONONCÉES AUTOUR DU FEU:\n${transcript}\nTu as entendu les anciens : accorde, contredis ou complète.\n` : '\nTu parles le premier.\n') +
    `\nTa lentille: ${a.lens}\nRéponds en 5 lignes max.`;
  try {
    let sent = false;
    for (let r = 0; r < 4 && !sent; r++) {          // retry : file ACP saturée = échec transitoire
      try {
        const out = execFileSync('node', [BRIDGE, '--provider', 'hephaistos', '--session', a.session,
          '--prompt', prompt, '--cwd', ROOT, '--wait', 'turn', '--timeout', '300'], { stdio: 'pipe' }).toString();
        try { directText = JSON.parse(out).text || JSON.parse(out).agentText || null; } catch { directText = null; }
        sent = true;
      } catch { if (r < 3) { console.log(`  retry ${a.role} (${r + 1}/3) — session occupée`); sleep(20000); } else throw new Error('inject refusé'); }
    }
    const before = (assistantMsgs(a.session) || []).length;
    let text = directText || null;
    for (let i = 0; i < 80 && !text; i++) {
      sleep(3000);
      const cur = assistantMsgs(a.session);
      if (cur && cur.length > before) text = cur[cur.length - 1].text;
    }
    if (text) {
      transcript += `**${a.role}** prend le calumet :\n${text}\n\n`;
      writeFileSync(join(DIR, 'calumet.md'), transcript);
      results.push({ role: a.role, ok: true });
      console.log(`calumet OK: ${a.role}`);
    } else { results.push({ role: a.role, ok: false }); console.log(`calumet SILENCE: ${a.role}`); }
  } catch (e) { results.push({ role: a.role, ok: false }); console.log(`calumet ECHEC: ${a.role}`); }
}
console.log(`tribu: ${results.filter(r => r.ok).length}/${results.length} paroles → ${DIR}/calumet.md`);
console.log('Étape suivante : injecter calumet.md au Grand Chef pour le tranchage final.');
