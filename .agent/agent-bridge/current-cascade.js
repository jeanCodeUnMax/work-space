#!/usr/bin/env node
// current-cascade.js — imprime le cascadeId de la conversation Devin ACTIVE.
//
// Source PRIMAIRE (fiable) : le globalStorage Devin persiste chaque session
// chat sous la clé `windsurf.acp.sessioninfo.session.<id>` avec info.updatedAt
// — l'horodatage reflète l'activité utilisateur réelle (champ "updatedAt" mis
// à jour quand l'utilisateur parle dans cette conversation).
//   → %APPDATA%/Devin/User/globalStorage/state.vscdb (SQLite)
//
// Fallback : heuristique .pb (~/.codeium/windsurf/cascade/*.pb le plus récent)
// — moins fiable : des writes de fond polluent les mtimes (chats vierges
// créés au reload, wakes injectés, etc.).
//
// Usage : node current-cascade.js   →  "72f64bf0-e339-..."

const fs = require('fs');
const path = require('path');
const os = require('os');

// 1) Source fiable : sessioninfo.updatedAt dans le globalStorage Devin
function fromSessionInfo() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const dbPath = path.join(appdata, 'Devin', 'User', 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(dbPath)) return '';
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(
        "SELECT value FROM ItemTable WHERE key LIKE 'windsurf.acp.sessioninfo.session.%'"
      ).all();
      let best = '', bestTs = '';
      for (const r of rows) {
        try {
          const p = JSON.parse(r.value);
          // providerId 'cascade' = vraie conversation Devin (ignore les
          // sessions ACP d'autres agents : kilo, hermes, devin-cli...)
          if (p.providerId !== 'cascade') continue;
          // Les drafts vides ("Awaiting User's Request") ont un cascadeId
          // ÉPHÉMÈRE : le premier sendCascadeInput les matérialise sous un
          // id différent -> le message part dans une fenêtre neuve. On les
          // exclut : une cible de handshake doit être une conv persistée.
          if ((p.info?.title || '') === 'Awaiting User\'s Request') continue;
          const id = p.info?.sessionId || '';
          const ts = p.info?.updatedAt || '';
          if (id && ts > bestTs) { bestTs = ts; best = id; }
        } catch { /* entrée non-JSON */ }
      }
      return best;
    } finally { db.close(); }
  } catch { return ''; }
}

// 2) Fallback : .pb le plus récemment écrit
function fromPbMtime() {
  const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.pb') && !f.endsWith('.archived'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? files[0].f.replace(/\.pb$/, '') : '';
  } catch { return ''; }
}

const id = fromSessionInfo() || fromPbMtime();
if (!id) { console.error('current-cascade: aucune cascade trouvée'); process.exit(1); }
console.log(id);
