#!/usr/bin/env node
/**
 * comms.js — bus d'échanges inter-agents (Devin ⇄ AGY ⇄ CLIs).
 *
 * Format : append-only JSONL dans <workspace>/.agent/comms.jsonl.
 * N'importe quel process (extension, CLI, bridge, script) peut append —
 * le ws-bridge tail le fichier et broadcast aux webviews du monitor.
 *
 * Entrée : {ts, src, dst, kind, text, convId?, taskId?}
 *   src/dst : 'devin' | 'agy' | 'kilo' | 'hermes' | ... | 'user'
 *   kind    : 'prompt' | 'reply' | 'wake' | 'result' | 'event' | 'error'
 *
 * Env : COMMS_LOG (chemin complet) ou HEPHAISTOS_WORKSPACE (racine workspace).
 *
 * CLI :
 *   node comms.js log <src> <dst> <kind> <texte> [convId] [taskId]
 *   node comms.js tail [n]      → dernières entrées
 *   node comms.js path          → chemin du fichier
 */
'use strict';

const fs = require('fs');
const path = require('path');

function workspaceRoot() {
    if (process.env.HEPHAISTOS_WORKSPACE) return process.env.HEPHAISTOS_WORKSPACE;
    // cwd si on est lancé depuis la racine du workspace (cas courant en CLI)
    try {
        const cwd = process.cwd();
        if (fs.existsSync(path.join(cwd, '.agent')) || fs.existsSync(path.join(cwd, '.git'))) return cwd;
    } catch { /* ignore */ }
    // Remonter depuis __dirname jusqu'au premier ancêtre qui contient
    // .agent/ — couvre agent-bridge/ sous .agent/ (copie portable) et
    // sous extensions/orchestrator-monitor/ (repo/extension installée).
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        if (fs.existsSync(path.join(dir, '.agent', 'rules')) || fs.existsSync(path.join(dir, 'orchestrator.db'))) return dir;
    }
    return path.join(__dirname, '..', '..', '..');
}

function commsPath() {
    return process.env.COMMS_LOG || path.join(workspaceRoot(), '.agent', 'comms.jsonl');
}

/** Nettoie la sortie CLI : ANSI + caractères de contrôle (ollama & co crachent de l'ANSI brut). */
function sanitize(text) {
    return String(text ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // séquences CSI
        .replace(/\x1b[()][0-9A-B]/g, '')          // jeux de caractères
        .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Append une entrée. Tolérant aux pannes — ne throw jamais. */
function log(entry) {
    try {
        const p = commsPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const line = JSON.stringify({
            ts: entry.ts || new Date().toISOString(),
            src: entry.src || '?',
            dst: entry.dst || '?',
            kind: entry.kind || 'event',
            text: sanitize(entry.text).slice(0, 4000),
            ...(entry.convId ? { convId: entry.convId } : {}),
            ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {})
        });
        fs.appendFileSync(p, line + '\n');
        return true;
    } catch { return false; }
}

/** Lit les n dernières entrées (défaut 100). */
function tail(n = 100, file = commsPath()) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

/**
 * Lit les octets ajoutés depuis `offset`. → {entries, offset}
 * offset négatif/géré par l'appelant (bridge : offset = taille lue précédente).
 */
function readFrom(offset, file = commsPath()) {
    try {
        const st = fs.statSync(file);
        if (offset > st.size) offset = 0; // fichier tronqué → repartir du début
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        const entries = buf.toString('utf8').split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return { entries, offset: st.size };
    } catch { return { entries: [], offset: 0 }; }
}

if (require.main === module) {
    const [cmd, ...a] = process.argv.slice(2);
    if (cmd === 'log') {
        const [src, dst, kind, ...rest] = a;
        const taskId = /^\d+$/.test(a[a.length - 1] || '') ? Number(a.pop()) : undefined;
        const convId = /^[0-9a-f-]{36}$/i.test(a[a.length - 1] || '') ? a.pop() : undefined;
        log({ src, dst, kind, text: rest.join(' '), convId, taskId });
    } else if (cmd === 'tail') {
        tail(a[0] ? Number(a[0]) : 20).forEach((e) => console.log(`[${e.ts}] ${e.src}→${e.dst} ${e.kind}: ${e.text.slice(0, 200)}`));
    } else if (cmd === 'path') {
        console.log(commsPath());
    } else {
        console.error('cmds: log <src> <dst> <kind> <texte> [convId] [taskId] | tail [n] | path');
        process.exit(2);
    }
}

module.exports = { log, tail, readFrom, commsPath, workspaceRoot };
