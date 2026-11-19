#!/usr/bin/env node
// Genere les prompts de role modulaires depuis advisors.json -> roles/<role>.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('.agent/council/advisors.json', 'utf8'));
mkdirSync('.agent/council/roles', { recursive: true });

const MOD = {
  ident: (r, a) => `[IDENT] Tu es ${r} (${a}) dans le LLM-Council — maillage 7 noeuds, full-duplex via .agent/comms.jsonl.`,
  lens: (a) => `[LENS] ${a.lens}`,
  skill: (a) => `[SKILL] Lis .agent/skills/llm-council/SKILL.md (methodologie Karpathy). Instruments: ${a.skills?.length ? a.skills.join(', ') : 'regard neuf — ton zero-contexte EST l\'outil'}. Applique-les concretement, cite-les.`,
  proto: (r) => `[PROTO-T1] Question -> council/<YYYY-MM-DD>/<Q>/advisor-${r}.md (8-15 lignes : stance + 3 arguments + 1 assertion falsifiable) -> bus {from,to:"chairman",type:"advisor-done",path}. [PROTO-T2] Chairman renvoie A1..A6 anonymises -> score 1-10 + justification -> review-${r}.md -> bus.`,
  mesh: `[MESH] Tu peux lire les fichiers des autres advisors dans council/<YYYY-MM-DD>/<Q>/ pour contre-argumenter — jamais copier leur stance.`,
  fmt: `[FORMAT] Verdict d'abord, bullets, zero hedging, type de preuve explicite (donnee|precedent|hypothese).`
};

const chairman = `Tu es le CHAIRMAN du LLM-Council.

${MOD.ident('Chairman-Concil', cfg.chairman.agent)}

[FLOW] 1) recois la question -> node .agent/council/dispatch-question.mjs "<Q>" -> attend les 6 advisor-*.md annonces sur le bus
2) anonymise en A1..A6 -> re-injecte le reviewPrompt a chacun
3) lis les 6 review-*.md -> synthetise : accords / clashs / blind-spots / recommandation / premier pas
4) ecris council-report-<ts>.html + council-transcript-<ts>.md

[MESH] Orchestre le duplex : relaie les positions divergentes aux advisors concernes pour confrontation directe.

[FORMAT] Verdict en tete, matrice accord/desaccord, blind-spots, action lundi matin.`;
writeFileSync('.agent/council/roles/chairman.md', chairman);

for (const a of cfg.advisors) {
  const p = `Tu es ${a.role.toUpperCase()} du LLM-Council.\n\n${[MOD.ident(a.role, a.agent), MOD.lens(a), MOD.skill(a), MOD.proto(a.role), MOD.mesh, MOD.fmt].join('\n\n')}`;
  writeFileSync(`.agent/council/roles/${a.role}.md`, p);
  console.log(`role file: ${a.role} ${p.length} chars`);
}
console.log('OK roles/ generes depuis advisors.json');
