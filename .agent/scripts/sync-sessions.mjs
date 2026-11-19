#!/usr/bin/env node
// sync-sessions — miroir continu sessions.json + council/ vers les workspaces ouverts.
import { watch, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
const SRC = process.argv[2] || 'C:/data-sys/hephaistos2-kit';
const DSTS = process.argv.slice(3).length ? process.argv.slice(3) : ['C:/data-sys/llm-council-skill'];
const SRC_CHATS = join(SRC, '.agent/chats/sessions.json');
const SRC_COUNCIL = join(SRC, 'council');
let t;
function syncFile(src, dst) { try { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); } catch {} }
function syncAll() {
  clearTimeout(t); t = setTimeout(() => {
    for (const d of DSTS) {
      syncFile(SRC_CHATS, join(d, '.agent/chats/sessions.json'));
      const walk = (dir) => { try { for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p); else syncFile(p, join(d, 'council', relative(SRC_COUNCIL, p)));
      } } catch {} };
      walk(SRC_COUNCIL);
    }
  }, 250);
}
syncAll();
watch(SRC_CHATS, syncAll);
watch(SRC_COUNCIL, { recursive: true }, syncAll);
console.log(`sync: ${SRC_CHATS} + ${SRC_COUNCIL}/ -> ${DSTS.join(', ')}`);
