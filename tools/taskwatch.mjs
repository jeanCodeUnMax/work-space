// taskwatch.mjs — KICKER du watchdog Hephaistos (tache planifiee hphe-taskwatch, 5 min).
// Unifie : le poll pending/notify vit desormais dans watchdog.ps1.
// Ce script ne fait qu'une chose : si le watchdog ne tourne pas, il le relance.
// Workspace via HPHE_WORKSPACE, sinon le projet canonique.
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WS = process.env.HPHE_WORKSPACE || 'C:/Program Files/Projet-complet/hephaistos2-kit';
const SCRIPT = join(WS, '.agent', 'skills', 'reactive-orchestrator', 'watchdog.ps1');
const log = (m) => console.log(`[kicker ${new Date().toISOString()}] ${m}`);

if (!existsSync(SCRIPT)) { log(`watchdog.ps1 introuvable: ${SCRIPT}`); process.exit(0); }

let alive = false;
try {
  const out = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'pwsh.exe\' or Name=\'powershell.exe\'\\" | Where-Object { $_.CommandLine -match \'reactive-orchestrator\' } | Select-Object -First 1 -ExpandProperty ProcessId"',
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }
  );
  alive = /^\s*\d+/m.test(out || '');
} catch { alive = false; }

if (alive) { log('watchdog vivant — rien a faire'); process.exit(0); }

log('watchdog absent — relance');
const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
  '-WorkspaceRoot', WS, '-IntervalSeconds', '60'],
  { cwd: WS, windowsHide: true, detached: true, stdio: 'ignore' });
child.unref();
log(`watchdog relance pid=${child.pid}`);
