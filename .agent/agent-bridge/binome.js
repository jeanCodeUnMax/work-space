#!/usr/bin/env node
/**
 * binome.js — procédure binôme Devin ⇄ AGY (hors orchestrateur).
 *
 * Handshake : chaque agent publie son cascadeId dans comms.jsonl
 *   ({kind:'handshake', convId}), lit celui du pair, puis échange
 *   par IDs explicites — jamais de devinette sur le .pb le plus récent.
 *
 * Usage :
 *   node binome.js --as devin join [session]   → publie mon cascadeId, affiche le pair
 *   node binome.js --as devin send "..."       → agy-hub send <agyCascadeId>
 *   node binome.js --as devin ask "..." [sec]  → agy-hub ask (send+attente+réponse)
 *   node binome.js --as agy   join [session]
 *   node binome.js --as agy   send "..."       → devin-hub send → wake_devin (chat Devin ciblé)
 *   option --to <cascadeId> : force la cible sans handshake préalable
 *   node binome.js --as <ag>  pair             → affiche le couple d'IDs courant
 *   node binome.js --as <ag>  tail [n]         → derniers échanges binôme (comms)
 *
 * --as = qui je suis ('devin' | 'agy'). session défaut = 'binome'.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const comms = require('./comms');
const agyHub = require('./agy-hub');
const devinHub = require('./devin-hub');

const argv = process.argv.slice(2);
function opt(name) {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
}
const me = (opt('--as') || '').toLowerCase();
const peer = me === 'devin' ? 'agy' : 'devin';
// Positionnels = tokens hors paires '--x valeur'.
const OPT_WITH_VAL = new Set(['--as', '--to']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    positional.push(argv[i]);
}
const cmd = positional[0];
const rest = positional.slice(1);
const session = cmd === 'join' ? (rest[0] || 'binome') : 'binome';

if (!['devin', 'agy'].includes(me) || !cmd) {
    console.error('usage: node binome.js --as <devin|agy> <join|send|ask|pair|tail> ...');
    process.exit(64);
}

function myCascade() {
    if (me === 'agy') {
        const hub = agyHub.discoverHub(process.env.AGY_WORKSPACE || process.cwd());
        return agyHub.listConversations(hub).then((l) => {
            l.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));
            return l[0]?.cascadeId || null;
        });
    }
    return Promise.resolve(devinHub.getActiveCascade());
}

function lastHandshake(who) {
    const entries = comms.tail(200).filter((e) => e.kind === 'handshake' && e.src === who);
    return entries.length ? entries[entries.length - 1] : null;
}

async function join() {
    const id = await myCascade();
    if (!id) { console.error(`[binome] ${me}: cascadeId introuvable`); process.exit(1); }
    comms.log({ src: me, dst: peer, kind: 'handshake', text: `session ${session}`, convId: id });
    const p = lastHandshake(peer);
    console.log(JSON.stringify({
        me, myCascade: id,
        peer, peerCascade: p?.convId || null,
        hint: p ? 'pair établi — send/ask direct' : `en attente du handshake ${peer} (faites 'join' de l'autre côté)`
    }, null, 1));
}

async function pair() {
    const [mine, p] = [await myCascade(), lastHandshake(peer)];
    console.log(JSON.stringify({ me, myCascade: mine, peer, peerCascade: p?.convId || null }, null, 1));
}

async function send(text, waitSec) {
    const p = lastHandshake(peer);
    let target = opt('--to') || p?.convId;
    if (!target) {
        if (me === 'agy') target = devinHub.getActiveCascade();
        else if (me === 'devin') target = await agyHub.getActiveCascade(agyHub.discoverHub(process.env.AGY_WORKSPACE || process.cwd()));
    }
    if (!target) { console.error(`[binome] pas de session ${peer} trouvée — lancez 'join' ou spécifiez --to <id>`); process.exit(1); }
    if (me === 'devin') {
        const hub = agyHub.discoverHub(process.env.AGY_WORKSPACE || process.cwd());
        if (waitSec) {
            const r = await agyHub.ask(hub, target, text, waitSec);
            for (const rep of r.replies) console.log(rep.text);
            if (!r.replies.length) console.log('(pas de réponse — timedOut=' + r.timedOut + ')');
        } else {
            await agyHub.sendMessage(hub, target, text);
            console.log(JSON.stringify({ sent: true, to: `${peer}:${target}` }));
        }
    } else {
        await devinHub.sendToDevin(text, target);
        console.log(JSON.stringify({ sent: true, to: `${peer}:${target}` }));
    }
}

function tail(n) {
    comms.tail(n).forEach((e) =>
        console.log(`[${e.ts}] ${e.src}→${e.dst} ${e.kind}: ${(e.text || '').slice(0, 200)}`));
}

(async () => {
    switch (cmd) {
        case 'join': return join();
        case 'pair': return pair();
        case 'tail': return tail(Number(rest[0]) || 30);
        case 'send': return send(rest.join(' '), 0);
        case 'ask': {
            const last = rest[rest.length - 1];
            const sec = /^\d+$/.test(last || '') ? Number(rest.pop()) : 300;
            return send(rest.join(' '), sec);
        }
        default:
            console.error('cmds: join|send|ask|pair|tail');
            process.exit(2);
    }
})().catch((e) => { console.error('[binome]', e.message); process.exit(1); });
