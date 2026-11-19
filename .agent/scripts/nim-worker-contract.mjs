import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function callOrchestrator(name, args, database) {
  const candidates = [process.env.HPHE_MCP_EXE,
    process.env.HPHE_INSTALL && join(process.env.HPHE_INSTALL, 'extension', 'server', 'hphe-mcp.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'servers', 'hephaistos2-kit', 'extension', 'server', 'hphe-mcp.exe')].filter(Boolean);
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('Executable canonique hphe-mcp introuvable');
  return JSON.parse(execFileSync(executable, ['--tool', name, '--args', JSON.stringify(args)], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(database ? { HPHE_ORCH_DB: database } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

export function selectDeliverable(taskId, task, messagePath) {
  if (taskId && !task) throw new Error('Contrat de tache indisponible : aucune ecriture autorisee');
  const expected = String(task?.expected_artifact || '').trim();
  if (taskId) return expected || null;
  return expected || messagePath || null;
}

export function confinedDestination(deliverable, workspace) {
  const root = realpathSync(workspace);
  const target = resolve(root, deliverable);
  const inside = (p) => {
    const rel = relative(root, p);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
  };
  if (!inside(target)) throw new Error('Livrable hors workspace refuse avant ecriture');
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!inside(realpathSync(existing))) throw new Error('Lien hors workspace refuse avant ecriture');
  return target;
}
