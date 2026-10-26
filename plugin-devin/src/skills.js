const fs = require('fs');
const path = require('path');

// Chargement dynamique du mapping skill -> commande à partir de skills-to-plugin-commands.json
// Ce fichier doit contenir { <nom_skill>: { input: ..., output: ... } }
const commandsPath = path.resolve(__dirname, '../skills-to-plugin-commands.json');
let skillCommands = {};
try {
  skillCommands = JSON.parse(fs.readFileSync(commandsPath, 'utf8'));
} catch (e) {
  console.warn('[skills.js] Impossible de charger skills-to-plugin-commands.json', e);
}

// Mapping inversé : commande -> nom_skill (pour les erreurs)
const commandToSkill = {};
Object.entries(skillCommands).forEach(([skillName, info]) => {
  commandToSkill[`execute_skill_${skillName}`] = skillName;
});

function executeSkill(skillName, ...args) {
  const info = skillCommands[skillName];
  if (!info) {
    const available = Object.keys(skillCommands).join(', ');
    throw new Error('Skill inconnu : ' + skillName + '. Compétences disponibles : ' + available);
  }
  // Dispatch : on suppose que le handler correspondant existe dans index.js
  // Pour l'instant, on lève un indice vers l'implémentation manquante
  throw new Error('Dispatcher execute_skill_' + skillName + ' non implémenté dans src/index.js (à raccorder via mcp-proxy)');
}

// Lister les skills disponibles (issues des clés de skills-to-plugin-commands.json)
function listSkills() {
  return Object.keys(skillCommands);
}

module.exports = {
  executeSkill,
  listSkills,
  skillCommands,
};