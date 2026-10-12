#!/usr/bin/env node
// current-cascade.js — imprime le cascadeId de la conversation Devin active.
// Heuristique : le .pb le plus récemment écrit dans ~/.codeium/windsurf/cascade/
// = la conversation en cours (le store est mis à jour à chaque tour).
// Usage : node current-cascade.js   →  "72f64bf0-e339-..."
// À embedder dans le titre d'une tâche dispatchée : [cascade:<id>]
// pour que la réponse revienne dans CETTE conversation.

const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
try {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.pb') && !f.endsWith('.archived'))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) { console.error('aucun .pb dans ' + dir); process.exit(1); }
  console.log(files[0].f.replace(/\.pb$/, ''));
} catch (e) {
  console.error('current-cascade: ' + e.message);
  process.exit(1);
}
