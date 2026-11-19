// signpath-watch.mjs — surveille la boite gmail pour une reponse SignPath
// (relance certificat OSS Cerbere Security Shield, envoyee le 2026-11-16).
// Lance par la tache planifiee hphe-signpath-watch (toutes les heures).
// Premier run = baseline silencieuse (charge les IDs connus sans alerter).
// Alerte : entree 'mail-watch' dans .agent/comms.jsonl + flag state + toast.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WS = path.resolve('C:/Program Files/Projet-complet/hephaistos2-kit');
const STATE_DIR = path.join(WS, '.agent', 'state');
const STATE_FILE = path.join(STATE_DIR, 'signpath-watch.json');
const FLAG_FILE = path.join(STATE_DIR, 'signpath-reply.json');
const LOG_FILE = path.join(WS, '.agent', 'logs', 'signpath-watch.log');
const COMMS = path.join(WS, '.agent', 'comms.jsonl');
const RELANCE_SENT = new Date('2026-11-16T13:50:00Z'); // envoi de la relance

const log = (m) => {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`);
};

function searchMail(account) {
    return new Promise((resolve) => {
        execFile('cli-anything-mail',
            ['--json', 'search', '--account', account, '--query', 'signpath', '--top', '30'],
            { timeout: 90000, windowsHide: true }, (err, stdout) => {
                if (err) return resolve({ account, error: String(err).slice(0, 200), items: [] });
                try {
                    const items = JSON.parse(stdout);
                    resolve({ account, items: Array.isArray(items) ? items : [] });
                } catch { resolve({ account, error: 'parse', items: [] }); }
            });
    });
}

function toast(title, text) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
        `$n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; ` +
        `$n.Visible=$true; $n.ShowBalloonTip(20000,${JSON.stringify(title)},${JSON.stringify(text)},'Info'); ` +
        `Start-Sleep 25; $n.Dispose()`;
    execFile('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
        { timeout: 40000, windowsHide: true }, () => {});
}

const main = async () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const state = fs.existsSync(STATE_FILE)
        ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
        : { seen: [], baselineDone: false };
    const seen = new Set(state.seen);

    const { items, error } = await searchMail('gmail');
    if (error) { log(`erreur cli-anything-mail: ${error}`); return; }

    const fresh = items.filter((m) => !seen.has(m.id) && new Date(m.date) > RELANCE_SENT);
    if (!state.baselineDone) {
        items.forEach((m) => seen.add(m.id));
        state.baselineDone = true;
        log(`baseline : ${items.length} mails signpath ignores`);
    } else {
        for (const m of fresh) {
            seen.add(m.id);
            const isRoutine = /Test signing/i.test(m.subject || '');
            const evt = { ts: new Date().toISOString(), src: 'signpath-watch', dst: 'devin',
                kind: 'mail-watch', convId: 'signpath-cerbere',
                text: JSON.stringify({ type: isRoutine ? 'routine-notification' : 'REPLY',
                    account: 'gmail', from: m.from, subject: m.subject, date: m.date, id: m.id }) };
            fs.appendFileSync(COMMS, JSON.stringify(evt) + '\n');
            fs.writeFileSync(FLAG_FILE, JSON.stringify({ detectedAt: evt.ts, ...JSON.parse(evt.text) }, null, 2));
            log(`${isRoutine ? 'notif routine' : 'REPONSE'} : ${m.from} | ${m.subject}`);
            if (!isRoutine) toast('Reponse SignPath recue', `${m.from}\n${m.subject}`);
        }
        if (!fresh.length) log(`rien de nouveau (${items.length} mails signpath au total)`);
    }
    state.seen = [...seen].slice(-500);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

main().catch((e) => { log(`crash: ${e.message}`); process.exit(1); });
