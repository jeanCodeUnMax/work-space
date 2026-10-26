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
    if (cmd === 'mcp' || cmd === 'skill') {
      const name = rest[0];
      if (!name) throw new Error('nom de tool/skill requis');
      const args = rest[1] ? JSON.parse(rest[1]) : {};
      const toolName = cmd === 'skill' ? `execute_skill_${name}` : name;
      await initialize();
      const result = await callTool(toolName, args);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.error('usage: hphe mcp|skill <name> [jsonArgs] | activity-feed [n] | commands');
    process.exitCode = 2;
  } finally {
    stopMcp();
  }
}

main().catch((e) => { console.error('hphe:', e.message); stopMcp(); process.exit(1); });
