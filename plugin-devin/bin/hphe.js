#!/usr/bin/env node
'use strict';
/* Point d'entrée CLI du plugin hephaistos-devin.
 * Usage:
 *   node bin/hphe.js mcp <tool> [jsonArgs]      -> callTool(tool, args)
 *   node bin/hphe.js activity-feed [n]           -> 20 dernières entrées comms.jsonl
 *   node bin/hphe.js skill <name> [jsonArgs]     -> execute_skill_<name>
 *   node bin/hphe.js commands                    -> liste les commandes du manifeste
 * Sans arguments l'outil résout hphe-mcp.exe via HPHE_MCP_PATH puis
 * <workspace>/hphe/target/release/hphe-mcp.exe.
 */
const path = require('path');
const { initialize, callTool, stopMcp } = require('../src/mcp-proxy');
const { activityFeed } = require('../src/index');
const manifest = require('../manifest.json');
const { callViaDaemon } = require('../src/mcp-client');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'commands') {
      console.log(Object.keys(manifest.commands).join('\n'));
      return;
    }
    if (cmd === 'activity-feed') {
      const n = parseInt(rest[0] || '20', 10);
      const entries = await activityFeed(Number.isFinite(n) ? n : 20, {});
      return entries;
    }
    if (cmd === 'daemon') {
      // Statut du demon persistant (spawn hphe-mcp.exe unique partage)
      try {
        const res = await callViaDaemon({ method: 'daemon/ping' });
        console.log(JSON.stringify({ running: true, ...(res.result || res) }));
      } catch (e) {
        console.log(JSON.stringify({ running: false, reason: e.message }));
      }
      return;
    }
    if (cmd === 'mcp' || cmd === 'skill') {
      const name = rest[0];
      if (!name) throw new Error('nom de tool/skill requis');
      const args = rest[1] ? JSON.parse(rest[1]) : {};
      const toolName = cmd === 'skill' ? `execute_skill_${name}` : name;
      // Chemin 1 : demon persistant (un seul hphe-mcp.exe partage).
      // Chemin 2 (fallback) : spawn-per-call historique. Dans les deux cas
      // la validation TOOL_SCHEMAS + blocage __confirmed passe par mcp-proxy.
      try {
        const res = await callViaDaemon({ method: 'tools/call', params: { name: toolName, arguments: args } });
        if (res && res.error) throw new Error(res.error);
        console.log(JSON.stringify(res.result, null, 2));
        return;
      } catch {
        await initialize();
        const result = await callTool(toolName, args);
        console.log(JSON.stringify(result, null, 2));
        return;
      }
    }
    console.error('usage: hphe mcp|skill <name> [jsonArgs] | activity-feed [n] | commands');
    process.exitCode = 2;
  } finally {
    stopMcp();
  }
}

main().catch((e) => { console.error('hphe:', e.message); stopMcp(); process.exit(1); });
