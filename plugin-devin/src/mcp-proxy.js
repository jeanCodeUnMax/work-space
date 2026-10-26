const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// MCP proxy singleton: one stdio process, reuse for all JSON-RPC calls
let mcpProc = null;
let pendingCalls = new Map(); // id -> { resolve, reject, timeout }
let rpcIdCounter = 0;

// Compteur atomique pour IDs JSON-RPC (incrémente, pas Date.now() pour éviter les collisions horodatage)
function nextRpcId() {
  return ++rpcIdCounter;
}

// Chemin résolu pour hphe-mcp.exe : env HPHE_MCP_PATH, sinon fallback relatif workspace, sinon nom nu
function resolveMcpPath() {
  const envPath = process.env.HPHE_MCP_PATH;
  if (envPath) return envPath;

  // fallback relatif à la racine du workspace Hephaistos2-Kit
  const fallback = 'C:\\Program Files\\Projet-complet\\hephaistos2-kit\\hphe\\target\\release\\hphe-mcp.exe';
  // On vérifie si le fichier existe ; si non, on garde le nom nu
  try { require('fs').accessSync(fallback); } catch (_) { return 'hphe-mcp.exe'; }
  return fallback;
}

// Buffer stdio robuste : accumulateur + split lignes
let stdioBuffer = '';

// Outils connus (schemas minimaux) chargés au initialize
// Schémas minimaux par défaut — types attendus par outil. Peuplé aussi via setToolSchemas.
let TOOL_SCHEMAS = {
  everything_search: { query: 'string', max_results: 'number', offset: 'number', sort: 'string', descending: 'boolean', stat: 'boolean', refresh: 'boolean' },
  search_files: { query: 'string', max_results: 'number', offset: 'number' },
  everything_count: { query: 'string' },
  fs_read_file: { path: 'string', max_bytes: 'number', encoding: 'string' },
  fs_list_directory: { path: 'string', max_entries: 'number' },
  fs_get_info: { path: 'string' },
  fs_write_file: { path: 'string', content: 'string', append: 'boolean', encoding: 'string' },
  fs_create_directory: { path: 'string' },
  fs_read_multiple_files: { paths: 'object', max_bytes: 'number', encoding: 'string' },
  nim_chat: { domain: 'string', prompt: 'string', system: 'string', max_tokens: 'number', temperature: 'number' },
  nim_models: {},
  available_models: { refresh: 'boolean' }
};

// Fonction pour arrêter proprement le processus MCP
function stopMcp() {
  if (mcpProc) {
    mcpProc.kill();
    mcpProc = null;
  }
  pendingCalls.clear();
}

// Démarrage (ou réutilisation) du processus MCP
function startMcp() {
  if (mcpProc) return mcpProc;

  const mcpPath = resolveMcpPath();
  mcpProc = spawn(mcpPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });

  mcpProc.stdout.on('data', chunk => {
    stdioBuffer += chunk.toString();
    // Traiter toutes les lignes complètes terminées par \n
    while (stdioBuffer.includes('\n')) {
      const idx = stdioBuffer.indexOf('\n');
      const line = stdioBuffer.substring(0, idx).trim();
      stdioBuffer = stdioBuffer.substring(idx + 1).trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        handleJsonRpcMessage(parsed);
      } catch (e) {
        // ignore malformed JSON
      }
    }
  });

  mcpProc.stderr.on('data', chunk => console.error('[mcp-proxy] stderr:', chunk.toString()));
  mcpProc.on('error', err => console.error('[mcp-proxy] process error:', err));
  mcpProc.on('close', () => {
    mcpProc = null;
    // Rejeter toutes les promesses en attente
    pendingCalls.forEach(({ reject }) => reject(new Error('mcp closed')));
    pendingCalls.clear();
  });
  return mcpProc;
}

// Nettoyage unifié : clearTimeout + delete de la Map
function cleanupPending(id) {
  const entry = pendingCalls.get(id);
  if (entry && entry.timeoutId !== undefined) {
    clearTimeout(entry.timeoutId);
  }
  pendingCalls.delete(id);
}

// Gestion des messages JSON-RPC reçus par stdio
function handleJsonRpcMessage(parsed) {
  const id = parsed.id;
  const error = parsed.error;

  // Gestion champ error JSON-RPC
  if (error) {
    if (pendingCalls.has(id)) {
      const { reject } = pendingCalls.get(id);
      pendingCalls.delete(id); // on peut aussi utiliser cleanupPending mais pas de timeout ici
      reject(new Error(error.message || 'JSON-RPC error'));
    }
    return;
  }

  // Réponse successee matchee par id
  if (id !== undefined && pendingCalls.has(id)) {
    const { resolve } = pendingCalls.get(id);
    cleanupPending(id); // clearTimeout + delete
    resolve(parsed);
  }
}

// Outils en ecriture : confirm:true dans manifest.json -> exige args.__confirmed
// Le manifeste nomme les commandes "mcp_<outil>" ; callTool recoit "<outil>".
const CONFIRM_TOOLS = (() => {
  try {
    const manifest = require('../manifest.json');
    return new Set(
      Object.keys(manifest.commands || {})
        .filter((k) => manifest.commands[k].confirm)
        .map((k) => k.replace(/^mcp_/, ''))
    );
  } catch { return new Set(); }
})();

// Validation d'args : whitelist de types par outil (TOOL_SCHEMAS) minimale
function validateArgs(toolName, args) {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    // Si pas de schema connu, on accepte (pour compatibilité future) mais on logue
    console.warn('[mcp-proxy] Aucun schema défini pour l\'outil', toolName);
    return true;
  }
  if (!args || typeof args !== 'object') {
    return false;
  }
  // Vérifier chaque champ du schema minimal
  for (const [key, expectedType] of Object.entries(schema)) {
    if (args[key] !== undefined && typeof args[key] !== expectedType) {
      return false;
    }
  }
  return true;
}

// Envoie un message JSON-RPC et attend la réponse par id
function callTool(toolName, args = {}) {
  // Outil en ecriture sans confirmation explicite -> refus fail-closed
  if (CONFIRM_TOOLS.has(toolName) && args.__confirmed !== true) {
    return Promise.reject(new Error('Tool "' + toolName + '" requires confirmation (pass __confirmed:true after user consent)'));
  }
  if (args.__confirmed !== undefined) {
    args = { ...args };
    delete args.__confirmed;
  }
  // Validation des args avant d'envoyer
  if (!validateArgs(toolName, args)) {
    return Promise.reject(new Error('Invalid arguments for tool "' + toolName + '": ' + JSON.stringify(args)));
  }
  return new Promise((resolve, reject) => {
    const proc = startMcp();
    const id = nextRpcId();
    const msg = { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } };
    proc.stdin.write(JSON.stringify(msg) + '\n');
    pendingCalls.set(id, { resolve, reject });
    // Timeout: un seul endroit de nettoyage via timeoutId stocké
    const timeoutId = setTimeout(() => {
      if (pendingCalls.has(id)) {
        const { reject } = pendingCalls.get(id);
        cleanupPending(id);
        reject(new Error('timeout calling ' + toolName));
      }
    }, 10000);
    pendingCalls.get(id).timeoutId = timeoutId;
  });
}

// Initialize MCP once — retourne une Promise qui attend la réponse JSON-RPC initialize
// params requis : protocolVersion, capabilities, clientInfo
// Enregistre dans pendingCalls ; la réponse initialize sera résolue par handleJsonRpcMessage quand l'id matchera.
function initialize() {
  const proc = startMcp();
  const id = nextRpcId();
  const msg = {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hephaistos-devin', version: '0.1.0' }
    }
  };
  proc.stdin.write(JSON.stringify(msg) + '\n');

  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    // Pas de boucle setTimeout polling : on fait confiance au flux normal de messages.
    // Le timeout est stocké pour safety, mais la résolution normale viendra de handleJsonRpcMessage
    // quand la réponse JSON-RPC initialize arrivera.
    const timeoutId = setTimeout(() => {
      if (pendingCalls.has(id)) {
        const { reject } = pendingCalls.get(id);
        cleanupPending(id);
        reject(new Error('timeout during initialize'));
      }
    }, 10000);
    pendingCalls.get(id).timeoutId = timeoutId;
  });
}

// Export du module
module.exports = {
  callTool,
  initialize,
  stopMcp,
  getMcpProc: () => mcpProc,
  // Pour chargement dynamique des schemas (via tools/list réponse initialize)
  setToolSchemas: (schemas) => { TOOL_SCHEMAS = schemas; }
};