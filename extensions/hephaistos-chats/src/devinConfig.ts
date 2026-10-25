import * as fs from 'fs';
import * as path from 'path';

/**
 * Lecture de la configuration ACP de Devin (User/settings.json) :
 * devin.acp.enabledAgents / agentPreferences / agentEnv.
 * L'extension reflète le même registre d'agents que l'IDE.
 */
export interface DevinAcpConfig {
    enabledAgents: Record<string, boolean>;
    agentPreferences: Record<string, { model?: string; mode?: string; provider?: string }>;
    agentEnv: Record<string, Record<string, string>>;
}

let cached: DevinAcpConfig | undefined;

export function devinAcpConfig(): DevinAcpConfig {
    if (cached !== undefined) return cached;
    const candidates = [
        path.join(process.env.APPDATA || '', 'devin', 'User', 'settings.json'),
        path.join(process.env.APPDATA || '', 'Devin', 'User', 'settings.json'),
    ];
    for (const file of candidates) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            cached = {
                enabledAgents: raw['devin.acp.enabledAgents'] || {},
                agentPreferences: raw['devin.acp.agentPreferences'] || {},
                agentEnv: raw['devin.acp.agentEnv'] || {},
            };
            return cached;
        } catch {
            /* fichier absent/invalide */
        }
    }
    cached = { enabledAgents: {}, agentPreferences: {}, agentEnv: {} };
    return cached;
}

/** enabled tel que configuré dans Devin, ou undefined si le provider n'y figure pas. */
export function devinAgentEnabled(providerId: string): boolean | undefined {
    return devinAcpConfig().enabledAgents[providerId];
}

/** Modèle/mode préféré de l'agent tel que configuré dans Devin. */
export function devinAgentPreference(providerId: string): { model?: string; mode?: string; provider?: string } {
    return devinAcpConfig().agentPreferences[providerId] || {};
}

/** Variables d'environnement par agent (PATH, OPENCODE_CONFIG, NIM_ACCOUNT, clés…). */
export function devinAgentEnv(providerId: string): Record<string, string> {
    return devinAcpConfig().agentEnv[providerId] || {};
}

/* ---------- .env du workspace : repli pour les clés absentes de process.env ----------
 * L'extension host hérite l'env du processus IDE ; si celui-ci a été lancé avant
 * l'ajout d'une variable utilisateur, process.env ne la contient pas. Le .env du
 * workspace est la source de vérité du kit. */
let dotenv: Record<string, string> | undefined;

function loadDotenv(): Record<string, string> {
    if (dotenv !== undefined) return dotenv;
    dotenv = {};
    try {
        const ws = require('vscode').workspace.workspaceFolders?.[0]?.uri.fsPath;
        const file = path.join(ws || process.cwd(), '.env');
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
            if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch {
        /* pas de .env */
    }
    return dotenv;
}

/** process.env[name] ou valeur du .env du workspace (non vide). */
export function envVar(name: string): string | undefined {
    const v = process.env[name];
    if (v) return v;
    const d = loadDotenv()[name];
    return d || undefined;
}

/** Clé d'un provider : process.env → devin.acp.agentEnv[providerId] → .env.
 * Ordre voulu pour la portabilité : la config Devin du collègue est la même
 * source que Devin lui-même — pas de second fichier de clés à maintenir. */
export function providerEnv(providerId: string, name: string): string | undefined {
    return envVar(name) || devinAgentEnv(providerId)[name] || undefined;
}
