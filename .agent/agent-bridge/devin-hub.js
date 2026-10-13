#!/usr/bin/env node
/**
 * devin-hub.js — Client de communication directe avec Devin dans l'IDE (sans orchestrateur).
 *
 * Symétrique à agy-hub.js (qui pilote Antigravity en Connect-RPC).
 * devin-hub.js communique via le bridge WebSocket local (ws://127.0.0.1:7477)
 * vers l'extension orchestrator-monitor qui exécute devin.sendChatActionMessage.
 *
 * Usage :
 *   node devin-hub.js current                     → cascadeId active de Devin
 *   node devin-hub.js send <texte> [cascadeId]    → injecte un message direct dans le chat Devin
 *   node devin-hub.js status                      → statut de connexion au bridge
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
let WebSocket;
const wsCandidates = [
    path.join(__dirname, '..', '..', 'extensions', 'orchestrator-monitor', 'ws-bridge', 'node_modules', 'ws'),
    path.join(__dirname, '..', 'ws-bridge', 'node_modules', 'ws'),
    path.join(os.homedir(), '.devin', 'extensions', 'hephaistos.orchestrator-monitor-0.0.34', 'ws-bridge', 'node_modules', 'ws'),
    'C:/Program Files/Projet-complet/hephaistos2-kit/extensions/orchestrator-monitor/ws-bridge/node_modules/ws',
    'ws'
];
for (const cand of wsCandidates) {
    try {
        WebSocket = require(cand);
        if (WebSocket) break;
    } catch { /* try next */ }
}
if (!WebSocket) {
    console.error('[devin-hub] ws module introuvable');
    process.exit(1);
}

let comms;
try { comms = require('./comms'); } catch { comms = null; }

function getActiveCascade() {
    try {
        const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.pb') && !f.endsWith('.archived'))
            .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        if (!files.length) return null;
        return files[0].f.replace(/\.pb$/, '');
    } catch { return null; }
}

function sendToDevin(text, cascadeId, port = 7477) {
    return new Promise((resolve, reject) => {
        const targetId = cascadeId || getActiveCascade();
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`Timeout de connexion au bridge Devin ws://127.0.0.1:${port}`));
        }, 5000);

        ws.on('open', () => {
            const payload = {
                command: 'wake_devin',
                text: text,
                cascadeId: targetId
            };
            ws.send(JSON.stringify(payload));
            if (comms) {
                comms.log({
                    src: 'agy',
                    dst: 'devin',
                    kind: 'prompt',
                    text: text,
                    convId: targetId
                });
            }
            clearTimeout(timeout);
            setTimeout(() => {
                ws.close();
                resolve({ sent: true, cascadeId: targetId });
            }, 300);
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// CLI
if (require.main === module) {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd || cmd === 'help') {
        console.log('Usage:');
        console.log('  node devin-hub.js current');
        console.log('  node devin-hub.js send <texte> [cascadeId]');
        console.log('  node devin-hub.js status');
        process.exit(0);
    }

    if (cmd === 'current') {
        const id = getActiveCascade();
        if (id) {
            console.log(id);
            process.exit(0);
        } else {
            console.error('Aucune session Devin active trouvée');
            process.exit(1);
        }
    }

    if (cmd === 'status') {
        const ws = new WebSocket('ws://127.0.0.1:7477');
        ws.on('open', () => {
            console.log(JSON.stringify({ status: 'connected', port: 7477, activeCascade: getActiveCascade() }, null, 2));
            ws.close();
        });
        ws.on('error', (e) => {
            console.error(JSON.stringify({ status: 'error', error: e.message }, null, 2));
            process.exit(1);
        });
    }

    if (cmd === 'send') {
        const text = args[0];
        if (!text) {
            console.error('Erreur: texte requis. Usage: node devin-hub.js send "<texte>" [cascadeId]');
            process.exit(1);
        }
        const cascadeId = args[1] || null;
        sendToDevin(text, cascadeId)
            .then(res => {
                console.log(JSON.stringify({ status: 'sent', cascadeId: res.cascadeId, text: text }, null, 2));
            })
            .catch(err => {
                console.error(JSON.stringify({ status: 'failed', error: err.message }, null, 2));
                process.exit(1);
            });
    }
}

module.exports = { getActiveCascade, sendToDevin };
