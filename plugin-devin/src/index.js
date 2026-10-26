// Squelette du plugin Hephaistos pour Devin
// Enregistre les commandes execute_skill_* et proxy MCP via mcp-proxy.js

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Chargement du mapping skill -> commande
const skillsMapper = require('./skills');

// Initialisation du proxy MCP (singleton)
const { initialize: mcpInit, callTool, stopMcp } = require('./mcp-proxy');

// Enregistre toutes les commandes execute_skill_* dans la contexte Devin/CLI
function registerCommands() {
  const commands = {};
  for (const [skillName, cmdDef] of Object.entries(skillsMapper)) {
    const cmdKey = 'execute_skill_' + skillName;
    commands[cmdKey] = async (...args) => {
      try {
        // Dispatch vers la fonction de skill correspondante
        const result = await skillsMapper[skillName](...args);
        return result;
      } catch (err) {
        throw new Error('Skill ' + skillName + ' failed: ' + err.message);
      }
    };
  }
  return commands;
}

// Point d'entree: initialisation une fois au chargement
async function startPlugin() {
  await mcpInit(); // initialise le processus hphe-mcp unique
  const commands = registerCommands();
  // Exposer les commandes au contexte global (ex: globalThis, ou via API Devin)
  // Ici on les attache global pour le demo; adapter selon l'environnement d'execution
  globalThis.hephaistosCommands = commands;
  console.log('[hephaistos-devin] plugin started, commands:', Object.keys(commands));
}

// Au besoin, fournir une fonction d'arret propre
function stopPlugin() {
  stopMcp();
  console.log('[hephaistos-devin] plugin stopped');
}

module.exports = {
  startPlugin,
  stopPlugin,
  getCommands: registerCommands
};