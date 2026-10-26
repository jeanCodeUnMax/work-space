'use strict';

/**
 * Formate une entrée comms en ligne d'affichage.
 * @param {object} e - Entrée {ts, src, dst, kind, text}
 * @returns {string} Ligne formatée "HH:mm:ss src -> dst [kind] texte"
 */
function formatEntry(e) {
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString('fr-FR', { hour12: false }) : '??:??';
  const src = e.src || '-';
  const dst = e.dst || '-';
  const kind = e.kind ? `[${e.kind}]` : '';
  const txt = e.text ? e.text.slice(0, 120) : '';
  return `${ts} ${src} -> ${dst} ${kind} ${txt}`;
}

/**
 * Rend un tableau d'entrées en chaîne multilignes.
 * @param {object[]} entries - Tableau d'entrées formatées
 * @returns {string}
 */
function renderFeed(entries) {
  return entries.map(formatEntry).join('\n');
}

module.exports = { formatEntry, renderFeed };