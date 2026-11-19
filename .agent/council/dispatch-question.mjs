#!/usr/bin/env node
// Dispatche une question a tous les advisors via acp-inject (prompt generique,
// adapte aux skills de chaque agent). Usage: node dispatch-question.mjs "question"
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { advisorPrompt } from './build-prompts.mjs';
const cfg = JSON.parse(readFileSync(new URL('./advisors.json', import.meta.url), 'utf8'));
const Q = process.argv[2]; if (!Q) { console.error('usage: dispatch-question.mjs "question"'); process.exit(1); }
const sessions = JSON.parse(readFileSync('.agent/chats/sessions.json', 'utf8'));
const byAgent = Object.fromEntries((sessions.sessions || []).map(s => [s.agent || s.name, s]));
for (const a of cfg.advisors) {
  const sess = byAgent[a.agent]?.sessionId || a.agent;
  try {
    execFileSync(process.execPath, ['.agent/agent-bridge/acp-inject.js', '--provider', 'hephaistos', '--session', sess, '--prompt', advisorPrompt(a, Q).replaceAll('${Q}', Date.now().toString(36)), '--wait', 'turn', '--timeout', '180'], { stdio: 'inherit' });
    console.log(`${a.agent}: injected`);
  } catch (e) { console.log(`${a.agent}: FAILED`); }
}
