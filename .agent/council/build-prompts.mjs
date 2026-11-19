#!/usr/bin/env node
// Compose les prompts council par agent : role + skills + protocole.
// Usage: node build-prompts.mjs <question> [sessionId]
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('./advisors.json', import.meta.url), 'utf8'));
const question = process.argv[2] || '{QUESTION}';
export function advisorPrompt(a, q) {
  const skills = a.skills?.length ? ` Tes competences (${a.skills.join(', ')}) sont tes angles d'attaque : applique-les a l'analyse.` : '';
  return `Tu es l'advisor ${a.role.toUpperCase()} du LLM-Council. ${a.lens}${skills}
Question du chairman : "${q}"
Consigne : analyse uniquement sous ton angle, 8-15 lignes, concret, zero hedging.
Livrable : ecris .agent/council/sessions/${'${Q}'}/advisor-${a.role}.md puis poste une ligne {from:"${a.agent}",to:"chairman",type:"advisor-done",path} sur ${cfg.bus}.`;
}
export function reviewPrompt(a, q, n) {
  return `Peer-review LLM-Council (${a.role}). Voici ${n} analyses ANONYMISEES A1..A${n} de la question "${q}". Note chacune 1-10 + 1 ligne de justification (merite, pas le style). Ecris .agent/council/sessions/${'${Q}'}/review-${a.role}.md puis poste sur ${cfg.bus}.`;
}
if (process.argv[1].endsWith('build-prompts.mjs')) {
  for (const a of cfg.advisors) console.log(`--- ${a.agent} (${a.role})\n${advisorPrompt(a, question)}\n`);
}
