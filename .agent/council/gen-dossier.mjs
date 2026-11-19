#!/usr/bin/env node
// gen-dossier.mjs v2 — DOSSIER.md : intention -> supervision (corrections visibles) ->
// analyses agent-a-agent -> scores -> sante du run -> verdict -> historiques complets
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = 'C:/data-sys/hephaistos2-kit';
const cfg = JSON.parse(readFileSync(join(ROOT, '.agent/council/advisors.json'), 'utf8'));
let dir = process.argv[2];
if (!dir) dir = join('council', readFileSync(join(ROOT, '.agent/council/current-Q.txt'), 'utf8').trim());
const slug = dir.split(/[\/]/).pop();
const rd = (f) => existsSync(join(ROOT, dir, f)) ? readFileSync(join(ROOT, dir, f), 'utf8').trim() : null;
const files = readdirSync(join(ROOT, dir));
const verdict = files.find(f => f.startsWith('council-verdict'));
const sessions = JSON.parse(readFileSync(join(ROOT, '.agent/chats/sessions.json'), 'utf8'));
const arr = Array.isArray(sessions) ? sessions : (sessions.sessions || []);
const find = (id) => arr.find(x => x.id === id);

// --- metriques : livrables, reviews, incidents detectes dans les historiques ---
const rows = [];
let incidents = [];
for (const a of cfg.advisors) {
  const c = find(a.session);
  const advisor = rd(`advisor-${a.role}.md`);
  const review = rd(`review-${a.role}.md`);
  const msgs = (c?.messages || []);
  const errs = [];
  for (const m of msgs) {
    const t = m.text || '';
    for (const g of t.matchAll(/erreur outil[^|\n]*/g)) errs.push(g[0].slice(0, 60));
  }
  // detection hors-sujet : mentionne biere/farine hors session cup-biere
  const offTopic = advisor && !slug.includes('biere') && /bi[eè]re|farine|flour/i.test(advisor);
  if (offTopic) incidents.push(`${a.role}: reponse hors-sujet (contexte precedent)`);
  if (!c) incidents.push(`${a.role} (${a.agent}): session absente du store`);
  if (advisor && !review) incidents.push(`${a.role}: peer-review non livree`);
  if (errs.length) incidents.push(`${a.role}: ${errs.length} erreur(s) outil (${errs[0]}...)`);
  rows.push(`| ${a.role} | ${a.agent} | ${c ? '✅' : '❌ absent'} | ${advisor ? '✅' : '❌'} | ${review ? '✅' : '❌'} | ${errs.length} | ${offTopic ? '⚠️ hors-sujet' : ''} |`);
}
const delivered = rows.filter(r => r.includes('| ✅ | ✅ |')).length;
const reviews = rows.filter(r => /\| ✅ \| ✅ \| ✅ \|/.test(r)).length;

// --- historiques filtres sur la session ---
const hist = (id) => {
  const c = find(id); if (!c) return '*session absente du store — jamais attachée*';
  const rel = (c.messages || []).filter(m => /COUNCIL|PEER-REVIEW|DEBAT|CORRECTION|TEST-VISIBLE/.test(m.text || ''));
  return rel.map(m => `**[${m.role}]**\n${(m.text || '').slice(0, 2500)}`).join('\n\n') || '*aucun message lie*';
};

const parts = [
`# 📁 DOSSIER DE SESSION — ${slug}

> Généré le ${new Date().toISOString()} · Chairman : ${cfg.chairman.agent} · Advisors : ${cfg.advisors.length}`,

`## 🎯 Intention & question

${rd('question.md') || 'Voir les prompts injectés en annexe (section historiques).'}`,

`## 🩺 Santé du run (processus)

| Rôle | Agent | Session | Analyse | Review | Err. outil | Notes |
|------|-------|---------|---------|--------|-----------|-------|
${rows.join('\n')}

| KPI | Valeur |
|-----|--------|
| Analyses livrées | ${delivered}/${cfg.advisors.length} |
| Peer-reviews livrées | ${reviews}/${cfg.advisors.length} |
| Incidents détectés | ${incidents.length} |
| Rotations/failover | ${rd('supervision.log') ? 'voir log' : 'dispatch manuel (pas de superviseur)'} |

### 🚨 Incidents & corrections appliquées
${incidents.length ? incidents.map(i => '- ' + i).join('\n') : '- aucun'}`,

`## 🏛️ Verdict

${verdict ? rd(verdict) : '*verdict non produit*'}`,

`## 🗂️ Livrables
${files.map(f => '- ' + f).join('\n')}`,

`---
# 📜 ANNEXE — historiques agents (exhaustif, messages liés)`
];
for (const a of cfg.advisors) parts.push(`\n## ${a.role} — ${a.agent}`, hist(a.session));
writeFileSync(join(ROOT, dir, 'DOSSIER.md'), parts.join('\n'));
console.log('DOSSIER v2:', join(dir, 'DOSSIER.md'), '| incidents:', incidents.length);
