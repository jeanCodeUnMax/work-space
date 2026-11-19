#!/usr/bin/env node
// council-broadcast — injecte une question du concil dans le chat de chaque
// advisor SWAT (advisors.json) via acp-inject, puis affiche le verdict.
// Usage : node council-broadcast.mjs "QUESTION" [--cwd ROOT] [--wait delivered|turn]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = process.argv.includes('--cwd')
  ? process.argv[process.argv.indexOf('--cwd') + 1]
  : 'C:/data-sys/hephaistos2-kit';
const WAIT = process.argv.includes('--wait')
  ? process.argv[process.argv.indexOf('--wait') + 1]
  : 'delivered';
let QUESTION = process.argv.slice(2).find(a => !a.startsWith('--') && a !== ROOT && a !== WAIT);
if (QUESTION?.startsWith('@')) QUESTION = readFileSync(QUESTION.slice(1), 'utf8');
if (!QUESTION) { console.error('usage: council-broadcast.mjs "QUESTION" | @fichier'); process.exit(1); }

const advisors = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors.json'), 'utf8')).advisors;
const BRIDGE = join(ROOT, '.agent/agent-bridge/acp-inject.js');

for (const a of advisors) {
  const prompt = `[CONCIL — ${a.role}]\nLens: ${a.lens}\n\nQUESTION: ${QUESTION}\n\nRéponds en 5 lignes max, selon TA lentille.`;
  try {
    execFileSync('node', [BRIDGE, '--provider', 'hephaistos', '--session', a.session,
      '--prompt', prompt, '--cwd', ROOT, '--wait', WAIT, '--timeout', '120'],
      { stdio: 'inherit' });
    console.log(`OK  ${a.agent} (${a.role})`);
  } catch (e) {
    console.log(`FAIL ${a.agent} (${a.role}) : ${e.message.slice(0, 120)}`);
  }
}
console.log('broadcast terminé — lancer workspace-roster.js restore pour rafraîchir les panneaux.');
