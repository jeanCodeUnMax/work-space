'use strict';
const fs = require('fs');
const readline = require('readline');
const path = require('path');

/**
 * Lit les n dernières lignes d'un fichier sans charger tout en mémoire.
 * Utilise un readline stream avec un buffer circulaire (ring buffer).
 * @param {string} filePath - Chemin absolu du fichier .jsonl
 * @param {number} n - Nombre de lignes à retourner
 * @returns {Promise<string[]>} Tableau des n dernières lignes (brutes)
 */
async function getLastLines(filePath, n) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return resolve([]);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const ring = [];
    rl.on('line', (line) => {
      if (line.trim()) {
        if (ring.length >= n) ring.shift();
        ring.push(line);
      }
    });
    rl.on('close', () => resolve(ring));
    rl.on('error', reject);
  });
}

/**
 * Parse un tableau de lignes en objets JSON, ignore les lignes corrompues.
 * @param {string[]} lines
 * @returns {any[]} Tableau d'objets JSON valides
 */
function parseJSONLLines(lines) {
  return lines.filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((b) => b !== null);
}

/**
 * Masque les informations sensibles dans un texte.
 * - Remplace les tokens par [REDACTED]
 * - Remplace les longues séquences hexadécimales par [HEX]
 * - Remplace les chemins Windows par [PATH]
 * @param {string} text
 * @returns {string}
 */
function filterSensitive(text) {
  if (typeof text !== 'string') return text;
  return text
    // "key":"..." / 'key': '...' / key=... pour clefs sensibles
    .replace(/(token|api[_-]?key|secret|password|passwd|bearer|credential)(["'\s:=]{1,4})[^\s"',\]]+/gi, '$1$2[REDACTED]')
    // Longues sequences hex/base64 probables (cles, hashes, payloads)
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[REDACTED]')
    // Chemins absolus Windows et UNC
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[PATH]')
    .replace(/\\\\[^\s"']+/g, '[PATH]');
}

/**
 * Récupère les N entrées récentes depuis le fichier comms.jsonl,
 * applique les filtres facultatifs.
 * @param {number} [n=20] - Nombre d'entrées à retourner
 * @param {object} [filters] - Filtres { kinds, sources, hideSensitive }
 * @returns {Promise<object[]>} Entrées formatées { ts, src, dst, kind, text }
 */
async function getLastEntries(n = 20, filters = {}) {
  const filePath = path.resolve(__dirname, '../../.agent/comms.jsonl');
  const lines = await getLastLines(filePath, Math.max(n, 500));
  const entries = await parseJSONLLines(lines);
  // Masquage actif par défaut — le journal peut contenir des payloads
  // wake-acp ; seul un appelant qui passe hideSensitive:false les voit.
  const mask = filters.hideSensitive !== false;
  let filtered = entries.filter((e) => {
    if (filters.kinds && !filters.kinds.includes(e.kind)) return false;
    if (filters.sources && !filters.sources.includes(e.src)) return false;
    if (mask) e.text = filterSensitive(e.text);
    return true;
  });
  // Ne garder que les n plus récentes après filtrage
  return filtered.slice(-n).map((e) => ({
    ts: e.ts,
    src: e.src,
    dst: e.dst,
    kind: e.kind,
    text: typeof e.text === 'string' ? e.text.slice(0, 120) : e.text,
  }));
}

module.exports = { getLastEntries, parseJSONLLines, filterSensitive };