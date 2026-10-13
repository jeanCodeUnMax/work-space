#!/usr/bin/env node
/**
 * agent-adapters.js — registre des agents CLI intégrés à Devin (ACP).
 *
 * Pour chaque agent : flag de reprise de session (équiv. `agy --conversation`),
 * commande d'export de la réponse, dossier de stockage des sessions.
 * Vérifié par --help le 2026-10-07 ; détails : modifications-infra/ACP-CLIS-SESSIONS-2026-10-07.md
 *
 * Usage :
 *   const a = require('./agent-adapters');
 *   a.resumeArgs('kilo', 'ses_123')   → ['-s', 'ses_123']
 *   a.resumeArgs('opencode', null)    → ['-c']            (dernière session)
 *   a.exportCmd('gemini', 'abc')      → 'gemini --resume abc ...'
 */
'use strict';

const os = require('os');
const path = require('path');
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

/** Binaire d'un agent : override env (<AGENT>_BIN) puis chemin user standard. */
const bin = (envVar, ...parts) => process.env[envVar] || path.join(...parts);

/**
 * sessionFlag: template pour reprendre une session connue.
 *   {flag:'-s'}            → '-s <id>'
 *   {flag:'--resume'}      → '--resume <id>'
 *   {flag:'-c', none:true} → '-c' (continue dernier, pas d'id)
 * continueFlag: flag "dernière session" quand aucun id n'est connu.
 */
const ADAPTERS = {
    agy: {
        bin: bin('AGY_BIN', LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
        headless: ['--dangerously-skip-permissions', '--print'],
        sessionFlag: '--conversation',      // agy --conversation <id>
        continueFlag: '--continue',
        sessionStore: 'hub-local (agy --hub) — conversations listables via GetAllCascadeTrajectories',
        replyVia: 'hub RPC SendUserCascadeMessage + GetCascadeTrajectorySteps (agy-hub.js)'
    },
    kilo: {
        bin: bin('KILO_BIN', APPDATA, 'npm', 'kilo.cmd'),
        headless: ['run', '--auto'],
        sessionFlag: '-s',                  // kilo run -s <id>
        continueFlag: '-c',
        sessionStore: 'projet .kilo/ + ~/.local/share/kilo',
        exportCmd: 'kilo export <sessionID>',  // JSON des messages
        replyVia: 'kilo export <id> | jq messages'
    },
    opencode: {
        bin: bin('OPENCODE_BIN', APPDATA, 'npm', 'opencode.cmd'),
        headless: ['run', '--auto'],
        sessionFlag: '-s',                  // opencode run -s <id> (+ --fork pour brancher)
        continueFlag: '-c',
        forkFlag: '--fork',
        sessionStore: '~/.local/share/opencode/project/<slug>/storage/session',
        exportCmd: 'opencode export <sessionID>',
        replyVia: 'opencode export <id>'
    },
    gemini: {
        bin: bin('GEMINI_BIN', APPDATA, 'npm', 'gemini.cmd'),
        headless: ['-p'],
        sessionFlag: '--resume',            // gemini --resume <id|latest|index>
        newSessionFlag: '--session-id',     // impose un UUID neuf
        sessionStore: '~/.gemini/tmp/<projet>/chats/session-*.json',
        listCmd: 'gemini --list-sessions',
        replyVia: 'fichier session-*.json (chronologique)'
    },
    /* mistral-vibe : RETIRÉ de l'architecture (2026-10-07) — plus de tier
       gratuit Mistral ; agent hors pipeline. */
    hermes: {
        bin: bin('HERMES_BIN', HOME, '.local', 'bin', 'hermes.exe'),
        headless: ['-z'],
        sessionFlag: '--resume',            // hermes --resume <SESSION>
        continueFlag: '--continue',         // [--continue SESSION_NAME]
        listCmd: 'hermes sessions list',
        exportCmd: 'hermes sessions export <name>',
        sessionStore: '~/.hermes/sessions',
        acp: 'hermes acp  (serveur ACP natif)'
    },
    cline: {
        bin: bin('CLINE_BIN', APPDATA, 'npm', 'cline.cmd'),
        headless: [],
        sessionFlag: '--id',                // cline --id <session-id>
        listCmd: 'cline history',
        sessionStore: '~/.cline (à confirmer)',
        replyVia: 'cline history / --id'
    },
    codex: {
        bin: bin('CODEX_BIN', APPDATA, 'npm', 'codex.cmd'),
        headless: ['exec'],
        sessionFlag: 'resume',              // codex resume <id> (sous-commande)
        subcommand: true,
        sessionStore: '~/.codex/sessions'
    },
    /* Providers purs — pas de conversation : le front-end CLI porte la session */
    ollama: {
        provider: true,
        api: 'http://127.0.0.1:11434/api/generate',
        body: { model: 'SparkLLM/Spark-X2.5-1.7B:latest', stream: false, think: false },
        preferredModel: 'SparkLLM/Spark-X2.5-1.7B:latest',
        note: 'API HTTP — JAMAIS le CLI (ANSI brut). think:false obligatoire sur modèles thinking (sinon réponse = raisonnement brut). Modèles :cloud suspendus (quota).'
    },
    nim: { provider: true, note: 'NVIDIA NIM API 1 — provider, dispatch via kilo/hermes' },
    nim2: { provider: true, note: 'NVIDIA NIM API 2 — provider, dispatch via kilo' },
    openrouter: { provider: true, note: 'provider via opencode (OPENCODE_CONFIG opencode-openrouter.json)' },
    'devin-cloud': { provider: true, note: 'Devin cloud — sessions API Devin' }
};

/** Args de reprise pour un agent + session_id connu (ou dernier si null). */
function resumeArgs(agent, sessionId) {
    const a = ADAPTERS[agent];
    if (!a || a.provider) return [];
    if (sessionId && a.sessionFlag) {
        if (a.subcommand) return [a.sessionFlag, sessionId];
        return [a.sessionFlag, sessionId];
    }
    if (!sessionId && a.continueFlag) return [a.continueFlag];
    return [];
}

/** Tag de routage à embedder dans le titre de tâche : [sess:kilo=abc123]. */
const SESSION_TAG = /(?:sess|session)[:=]\s*([a-z0-9_-]+)\s*[:=]\s*([A-Za-z0-9_-]+)/i;

if (require.main === module) {
    const [cmd, agent, id] = process.argv.slice(2);
    if (cmd === 'resume') console.log(resumeArgs(agent, id || null).join(' '));
    else if (cmd === 'list') console.log(Object.keys(ADAPTERS).join('\n'));
    else if (cmd === 'show') console.log(JSON.stringify(ADAPTERS[agent], null, 1));
    else console.error('cmds: list | show <agent> | resume <agent> [sessionId]');
}

module.exports = { ADAPTERS, resumeArgs, SESSION_TAG };
