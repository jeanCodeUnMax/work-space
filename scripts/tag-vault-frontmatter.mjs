#!/usr/bin/env node
// tag-vault-frontmatter.mjs — applique le schéma 00_Meta (tags + champs génériques)
// sur toutes les notes .md du vault Obsidian. Idempotent.
// Usage : node tag-vault-frontmatter.mjs [--dry] [--vault <path>]

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const vaultIdx = args.indexOf('--vault');
const VAULT = vaultIdx >= 0 ? args[vaultIdx + 1]
  : (process.env.OBSIDIAN_VAULT_PATH || (() => { throw new Error('OBSIDIAN_VAULT_PATH requis ou --vault <path>'); })());
const TODAY = '2026-10-19';
const AUTHOR = 'Cash (Devin)';

// Dossiers exclus (squelettes, caches, données techniques)
const SKIP_DIRS = new Set([
  '00_Meta', '90_Templates', 'semantic-cache-data', 'memory-database',
  '.obsidian', '.trash', '.git', 'node_modules',
]);

// top-folder -> tags à garantir
const FOLDER_TAGS = {
  '01_Skills': ['dev', 'skills'],
  '02_Projets': ['dev', 'projet'],
  '02_Proyectos': ['dev', 'projet'],
  '10_Projets_Docs': ['dev', 'projet', 'docs'],
  '40_Automatisation_et_Dev': ['dev', 'automatisation'],
  'Notes-C++': ['dev', 'cpp'],
  'documentation Devin': ['dev', 'docs', 'devin'],
  '70_Ecosysteme_Agents': ['dev', 'agents'],
  '00_Agent': ['dev', 'agents'],
  '00_Agente': ['dev', 'agents'],
  '03_Sessions': ['dev', 'agents', 'session'],
  '03_Sesiones': ['dev', 'agents', 'session'],
  'Chats': ['dev', 'agents', 'chat'],
  '20_Intelligence_Artificielle': ['research', 'ia'],
  '30_Prompt_Engineering': ['research', 'prompt-engineering'],
  '50_Veille_et_Recherche': ['research', 'veille'],
  '60_Connaissances_et_Visuels': ['research', 'knowledge'],
  'Documentation': ['docs', 'reference'],
  'Excalidraw': ['visuel'],
  '04_Outils': ['outils'],
  '04_Herramientas': ['outils'],
  '05_Contacts': ['contacts'],
  '90_Archive': ['archive'],
  '99_Archive': ['archive'],
  '_root': ['docs'],
};
const DOMAIN_VOCAB = new Set(['dev', 'marketing', 'research', 'finance']);

// Champs génériques 00_Meta (template_general.md) — ajoutés si absents
const GENERIC = [
  ['kanban_board', '""'],
  ['calendar_event', '""'],
  ['automation', 'false'],
  ['ci_status', '""'],
  ['repo', '""'],
  ['depends_on', '[]'],
  ['revision', '1'],
  ['change_log', '[]'],
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      yield* walk(p);
    } else if (e.name.toLowerCase().endsWith('.md')) {
      yield p;
    }
  }
}

function tagsFor(rel) {
  const segs = rel.split('/');
  const top = segs.length > 1 ? segs[0] : '_root';
  const tags = [...(FOLDER_TAGS[top] || ['docs'])];
  if (top === 'Documentation' && segs.length > 2) {
    tags.push(segs[1].toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  }
  return [...new Set(tags)];
}

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:/;
const ITEM_RE = /^\s*-\s+(.*)$/;
const unquote = s => s.trim().replace(/^['"]|['"]$/g, '');

function processFile(abs) {
  const rel = path.relative(VAULT, abs).replace(/\\/g, '/');
  const want = tagsFor(rel);
  const domain = want.find(t => DOMAIN_VOCAB.has(t));

  let raw = fs.readFileSync(abs, 'utf8');
  let bom = '';
  if (raw.charCodeAt(0) === 0xFEFF) { bom = '\uFEFF'; raw = raw.slice(1); }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const hasFm = lines[0] && lines[0].trim() === '---';
  let fmEnd = -1;
  if (hasFm) {
    for (let i = 1; i < Math.min(lines.length, 400); i++) {
      if (lines[i].trim() === '---') { fmEnd = i; break; }
    }
    if (fmEnd === -1) return { rel, action: 'skipped-malformed-frontmatter' };
  }

  if (!hasFm) {
    const block = [
      '---',
      `created: "${TODAY}"`,
      `updated: "${TODAY}"`,
      'tags:',
      ...want.map(t => `  - ${t}`),
      ...(domain ? [`domain: "${domain}"`] : []),
      ...GENERIC.map(([k, v]) => `${k}: ${v}`),
      '---',
      '',
    ];
    if (!DRY) fs.writeFileSync(abs, bom + block.join(eol) + lines.join(eol), 'utf8');
    return { rel, action: `frontmatter-created;tags=${want.join(',')}` };
  }

  const fm = lines.slice(1, fmEnd);
  const body = lines.slice(fmEnd + 1);

  // clés top-level présentes
  const have = new Set();
  fm.forEach(l => { const m = l.match(KEY_RE); if (m) have.add(m[1]); });

  // collecte des tags existants (inline / bloc / scalaire)
  const existing = new Set();
  let tagsIdx = -1, tagsKind = 'absent';
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(KEY_RE);
    if (!m || m[1] !== 'tags') continue;
    tagsIdx = i;
    const v = fm[i].replace(KEY_RE, '').trim();
    if (v === '') { tagsKind = 'block'; }
    else if (/^\[.*\]$/.test(v)) {
      tagsKind = 'inline';
      v.slice(1, -1).split(',').map(unquote).filter(Boolean).forEach(t => existing.add(t));
    } else { tagsKind = 'scalar'; existing.add(unquote(v)); }
    if (tagsKind === 'block') {
      for (let j = i + 1; j < fm.length; j++) {
        const li = fm[j].match(ITEM_RE);
        if (li) existing.add(unquote(li[1]));
        else if (fm[j].trim() !== '') break;
      }
    }
    break;
  }
  const missing = want.filter(t => !existing.has(t));

  const changes = [];
  const out = [];

  for (let i = 0; i < fm.length; i++) {
    const l = fm[i];
    const m = l.match(KEY_RE);
    const key = m ? m[1] : null;

    if (key === 'tags' && i === tagsIdx) {
      if (tagsKind === 'inline') {
        if (missing.length) {
          out.push(`tags: [${[...existing, ...missing].join(', ')}]`);
          changes.push(`tags+${missing.join(',')}`);
        } else out.push(l);
      } else {
        // block ou scalar : réécriture en liste + complétion
        out.push('tags:');
        if (tagsKind === 'scalar') { out.push(`  - ${unquote(l.replace(KEY_RE, ''))}`); }
        if (tagsKind === 'block') {
          // recopier les items existants
          let j = i + 1;
          for (; j < fm.length; j++) {
            const li = fm[j].match(ITEM_RE);
            if (li) { out.push(fm[j]); }
            else if (fm[j].trim() === '') { out.push(fm[j]); }
            else break;
          }
          i = j - 1; // saut consommé
        }
        if (missing.length) {
          for (const t of missing) out.push(`  - ${t}`);
          changes.push(`tags+${missing.join(',')}`);
        }
      }
      continue;
    }

    if (key === 'updated') {
      const nv = `updated: "${TODAY}"`;
      if (l !== nv) { out.push(nv); changes.push('updated'); } else out.push(l);
      continue;
    }

    out.push(l);
  }

  // clés manquantes -> append en fin de frontmatter
  if (tagsKind === 'absent') {
    out.push('tags:', ...want.map(t => `  - ${t}`));
    changes.push(`tags=${want.join(',')}`);
  }
  if (domain && !have.has('domain')) { out.push(`domain: "${domain}"`); changes.push('domain'); }
  if (!have.has('created')) { out.push(`created: "${TODAY}"`); changes.push('created'); }
  if (!have.has('updated')) { out.push(`updated: "${TODAY}"`); changes.push('updated'); }
  const absentGen = GENERIC.filter(([k]) => !have.has(k));
  if (absentGen.length) {
    for (const [k, v] of absentGen) out.push(`${k}: ${v}`);
    changes.push(`generic+${absentGen.length}`);
  }

  if (!changes.length) return { rel, action: 'ok-already' };
  if (!DRY) fs.writeFileSync(abs, bom + ['---', ...out, '---', ...body].join(eol), 'utf8');
  return { rel, action: changes.join(';') };
}

const results = [];
const counts = { total: 0, modified: 0, ok: 0, skipped: 0, errors: 0 };
for (const f of walk(VAULT)) {
  counts.total++;
  try {
    const r = processFile(f);
    if (r.action === 'ok-already') counts.ok++;
    else if (r.action.startsWith('skipped')) counts.skipped++;
    else counts.modified++;
    results.push(r);
  } catch (e) {
    counts.errors++;
    results.push({ rel: path.relative(VAULT, f), action: `error: ${e.message}` });
  }
}

const manifestDir = path.join(VAULT, '00_Meta', '_migrations');
if (!DRY) {
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, `tag-migration-${TODAY}.json`),
    JSON.stringify({ date: TODAY, by: AUTHOR, vault: VAULT, counts, results }, null, 2),
    'utf8'
  );
}

console.log(JSON.stringify({ dry: DRY, ...counts }, null, 2));
if (DRY) {
  console.log('\n--- samples ---');
  results.filter(r => r.action !== 'ok-already').slice(0, 15)
    .forEach(r => console.log(`${r.action}  <- ${r.rel}`));
}
