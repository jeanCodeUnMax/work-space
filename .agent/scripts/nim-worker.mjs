#!/usr/bin/env node
/**
 * nim-worker.mjs — worker NIM à protocole DIRECT (pas de CLI intermédiaire).
 * POST OpenAI-compatible vers integrate.api.nvidia.com avec la clé du compte.
 *
 * Usage: node nim-worker.mjs --account <1|2> --model <id> --message "<msg>"
 *          [--task-id <n>]
 *   --account 1 → NVIDIA_API_KEY (NIM1)   --account 2 → NVIDIA_API_KEY_2 (NIM2)
 *
 * Le message peut contenir un chemin de livrable `.agent/xxx.ext` : la réponse
 * du modèle y est écrite (convention orchestrateur — livrable = fichier).
 * Sinon la réponse est imprimée sur stdout (→ log de dispatch).
 * --task-id : clôture la tâche dans orchestrator.db (status completed/failed)
 * — le worker est de l'infra, pas un agent tiers ; seuls devin/agy dispatch.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Résolution DB : env explicite > install standard (%ProgramFiles%\servers) >
// profil user > dernier recours (chemin historique).
const DB_CANDIDATES = [
  process.env.HPHE_ORCH_DB,
  process.env.ORCHESTRATOR_DB,
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'servers', 'hephaistos2-kit', 'data', 'orchestrator.db'),
  process.env.USERPROFILE && join(process.env.USERPROFILE, 'hephaistos2-kit', 'data', 'orchestrator.db'),
  'C:/Program Files/servers/hephaistos2-kit/data/orchestrator.db',
].filter(Boolean);
const DB = DB_CANDIDATES.find((p) => existsSync(p)) || DB_CANDIDATES[DB_CANDIDATES.length - 1];

function closeTask(taskId, status, result) {
  if (!taskId) return;
  try {
    const db = new DatabaseSync(DB);
    db.prepare("UPDATE tasks_todo SET status=?, result=? WHERE id=?").run(status, String(result).slice(0, 4000), +taskId);
    db.prepare("INSERT INTO task_events(task_id,event,detail,ts) VALUES(?,?,?,datetime('now'))")
      .run(String(taskId), status === 'completed' ? 'completed' : 'failed', `nim-worker: ${String(result).slice(0, 500)}`);
    db.close();
  } catch (e) { console.error(`[nim-worker] closeTask ${taskId}: ${e.message}`); }
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};

const account = arg('--account') === '1' ? '1' : '2';
const model = arg('--model') || 'nvidia/nemotron-3.5-lightning-30b-a3b';
const message = arg('--message') || process.argv[process.argv.length - 1];
const taskId = arg('--task-id');
// --expect <regex> : le livrable doit matcher (flag i) sinon tâche 'failed'
// avec le contenu réel en diagnostic — jamais de faux positif.
const expectRe = arg('--expect') ? new RegExp(arg('--expect'), 'i') : null;
const key = process.env[account === '1' ? 'NVIDIA_API_KEY' : 'NVIDIA_API_KEY_2'];
const base = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');

if (!key) { console.error(`NVIDIA_API_KEY${account === '1' ? '' : '_2'} absente`); process.exit(1); }
if (!message || message.startsWith('--')) { console.error('message requis'); process.exit(1); }

// Livrable : premier chemin .agent/xxx.ext présent dans le message.
const m = message.match(/\.agent[\\/][\w.\\/\\-]+\.(?:md|txt|json|js|ts|rs|py|yaml|yml)/i);
const deliverable = m ? m[0].replace(/\\/g, '/') : null;

const started = Date.now();
try {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 300_000);
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: message }],
      max_tokens: 8192,
      temperature: 0.2,
      stream: false,
    }),
    signal: ctl.signal,
  });
  clearTimeout(t);
  if (!r.ok) {
    const body = (await r.text()).slice(0, 500);
    console.error(`NIM${account} HTTP ${r.status}: ${body}`);
    closeTask(taskId, 'failed', `HTTP ${r.status}: ${body.slice(0, 300)}`);
    process.exit(1);
  }
  const d = await r.json();
  const msg = d?.choices?.[0]?.message ?? {};
  // Modèles à raisonnement (nemotron-*-a3b…) : la réponse peut atterrir dans
  // reasoning_content quand content est vide (raisonnement a tout mangé).
  const content = (msg.content ?? '').trim() || (msg.reasoning_content ?? '').trim();
  const finish = d?.choices?.[0]?.finish_reason ?? '';
  if (!content && finish === 'length') {
    console.error('[nim-worker] réponse vide — max_tokens mangé par le raisonnement');
  }
  const ms = Date.now() - started;
  console.log(`[nim-worker] nim${account} ${model} — ${ms}ms`);
  if (deliverable) {
    const path = isAbsolute(deliverable) ? deliverable : join(process.cwd(), deliverable);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content.trim() + '\n');
    console.log(`[nim-worker] livrable écrit: ${path} (${content.trim().length} chars)`);
    if (expectRe && !expectRe.test(content.trim())) {
      closeTask(taskId, 'failed', `format invalide (attendu /${expectRe.source}/i) — sortie: ${content.trim().slice(0, 300)}`);
      process.exit(2);
    }
    closeTask(taskId, 'completed', `livrable ${deliverable} (${content.length} chars, ${ms}ms, ${model})`);
  } else {
    console.log(content);
    if (expectRe && !expectRe.test(content.trim())) {
      closeTask(taskId, 'failed', `format invalide (attendu /${expectRe.source}/i) — sortie: ${content.trim().slice(0, 300)}`);
      process.exit(2);
    }
    closeTask(taskId, 'completed', `réponse ${content.length} chars (${ms}ms, ${model})`);
  }
} catch (e) {
  const why = e.name === 'AbortError' ? 'timeout 300s' : e.message;
  console.error(`[nim-worker] ${why}`);
  closeTask(taskId, 'failed', why);
  process.exit(1);
}
