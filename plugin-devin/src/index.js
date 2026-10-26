// Squelette du plugin Hephaistos pour Devin
// Enregistre les commandes execute_skill_* + activity_feed, proxy MCP via mcp-proxy.js

// Chargement du mapping skill -> commande
const skillsMapper = require('./skills');

// Initialisation du proxy MCP (singleton)
const { initialize: mcpInit, callTool, stopMcp } = require('./mcp-proxy');

// J4 — synchro etat : journal partage comms.jsonl
const { getLastEntries } = require('./comms');
const { renderFeed } = require('./activity-panel');

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
  commands.activity_feed = activityFeed;
  return commands;
}

/**
 * Commande activity_feed : recupere les dernieres entrees du journal partage
 * et les affiche dans l'activity panel du plugin Devin.
 */
async function activityFeed(n = 20, filters = {}) {
  try {
    const entries = await getLastEntries(n, filters);
    console.log('=== Activity Feed (last', entries.length, 'entries) ===');
    console.log(renderFeed(entries));
    console.log('========================================');
    return entries;
  } catch (err) {
    console.error('Erreur activity_feed :', err.message);
    return [];
  }
}

// Point d'entree: initialisation une fois au chargement
async function startPlugin() {
  await mcpInit(); // initialise le processus hphe-mcp unique
  const commands = registerCommands();
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
  activityFeed,
  getCommands: registerCommands
};
