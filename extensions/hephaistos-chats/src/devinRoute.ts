import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { OrchWsClient } from './orchWs';
import { ChatMode, TurnCtx } from './types';

/* Route « devin-cli » — Devin n'est pas un agent ACP spawnable en stdio : le
 * panneau relaie le message via le ws-bridge :7477 (commande wake_acp_agent →
 * orchestrator-monitor focalise la fenêtre Devin cible et y injecte le texte
 * via devin.sendChatActionMessage), puis attend la réponse sur le bus comms :
 * le bridge tail .agent/comms.jsonl et broadcast {type:'comms'} à tous les
 * clients. Corrélation : convId = requestId du tour (UUID).
 *
 * La réponse est donc ASYNCHRONE : elle suppose que la session Devin cible
 * exécute l'instruction comms de l'enveloppe (même contrat que le bus binôme).
 */

export interface DevinSession {
    sessionId: string;
    providerId: string;
    focused?: boolean;
    title?: string;
}

let bridge: OrchWsClient | null = null;

/** Injecté par extension.ts au démarrage (même client que le suivi orchestrateur). */
export function setDevinBridge(client: OrchWsClient | null): void {
    bridge = client;
}

type LogFn = (msg: string) => void;
const noopLog: LogFn = () => {};

const WAKE_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 5_000;
const REPLY_TIMEOUT_MS = 10 * 60_000;
// Le bridge tronque le texte injecté à 4000 — l'enveloppe doit rester dedans.
const MAX_ENVELOPE = 3_900;

/** Requête/réponse générique sur le client WS partagé (acp_wake_result, acp_sessions_result…). */
function bridgeRequest(
    client: OrchWsClient,
    command: string,
    payload: Record<string, unknown>,
    resultType: string,
    timeoutMs: number,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
            client.off('message', onMessage);
            reject(new Error(`timeout ${command} via ws-bridge :7477`));
        }, timeoutMs);
        const onMessage = (frame: any) => {
            if (frame?.requestId !== requestId || frame?.type !== resultType) return;
            clearTimeout(timer);
            client.off('message', onMessage);
            if (frame?.error) reject(new Error(String(frame.error)));
            else resolve(frame);
        };
        client.on('message', onMessage);
        client.send({ command, requestId, ...payload });
    });
}

/** Sessions Devin ouvertes dans l'IDE (providerId devin-cli), dédoublonnées par le bridge. */
async function listDevinSessions(workspaceRoot: string): Promise<DevinSession[]> {
    if (!bridge?.isConnected) return [];
    const res = await bridgeRequest(
        bridge, 'list_acp_sessions',
        { providerId: 'devin-cli', workspaceRoot },
        'acp_sessions_result', LIST_TIMEOUT_MS,
    );
    const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
    return sessions.filter((s: DevinSession) => s?.sessionId && s.providerId === 'devin-cli');
}

/**
 * Enveloppe injectée dans la fenêtre Devin cible — même convention que le bus
 * binôme : l'agent traite la demande puis publie sa réponse finale dans
 * .agent/comms.jsonl (CLI canonique comms.js, ou ligne JSON équivalente).
 */
function buildEnvelope(reqId: string, mode: ChatMode, text: string): string {
    const head = [
        `[hephaistos-chats] Message utilisateur relayé depuis le panneau « Hephaistos Chats » (req ${reqId}, mode ${mode}).`,
        'Traite cette demande normalement, puis renvoie ta réponse FINALE en une ligne au bus comms :',
        `  node .agent/agent-bridge/comms.js log devin chats reply "<ta réponse complète>" ${reqId}`,
        `(équivalent : append dans .agent/comms.jsonl — {"src":"devin","dst":"chats","kind":"reply","convId":"${reqId}","text":"…"})`,
        '',
        '— Demande —',
    ].join('\n');
    const budget = MAX_ENVELOPE - head.length - 1;
    const body = text.length > budget ? `${text.slice(0, budget)}\n[… tronqué]` : text;
    return `${head}\n${body}`;
}

/** Slug lisible de la session cible pour l'UI (acp/devin-cli/lake-phrase → lake-phrase). */
function shortSlug(sessionId: string): string {
    const parts = String(sessionId).split('/');
    return parts[parts.length - 1] || sessionId;
}

/** Attend l'entrée comms corrélée (broadcast {type:'comms', entries} du bridge). */
function waitCommsReply(client: OrchWsClient, reqId: string, abortSignal: AbortSignal | undefined, log: LogFn): Promise<string> {
    return new Promise((resolve, reject) => {
        const finish = (err: Error | null, text?: string) => {
            clearTimeout(timer);
            client.off('message', onMessage);
            abortSignal?.removeEventListener('abort', onAbort);
            if (err) reject(err); else resolve(text || '');
        };
        const timer = setTimeout(
            () => finish(new Error(
                `Pas de réponse via comms.jsonl en ${Math.round(REPLY_TIMEOUT_MS / 60000)} min — ` +
                'la session Devin n\'a pas publié l\'entrée reply attendue (instruction comms non exécutée ?).',
            )),
            REPLY_TIMEOUT_MS,
        );
        const onMessage = (frame: any) => {
            if (frame?.type !== 'comms' || !Array.isArray(frame.entries)) return;
            const hit = frame.entries.find(
                (e: any) => e?.convId === reqId && (e?.kind === 'reply' || e?.kind === 'chat-reply'),
            );
            if (hit) {
                log(`devin-turn reply req=${reqId} ${String(hit.text || '').length} car.`);
                finish(null, String(hit.text || ''));
            }
        };
        const onAbort = () => finish(new Error('annulé'));
        if (abortSignal?.aborted) { finish(new Error('annulé')); return; }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        client.on('message', onMessage);
    });
}

/**
 * Tour complet via la session Devin cible :
 *   1. résoudre la session (mémorisée dans ctx, sinon focalisée) ;
 *   2. injecter l'enveloppe via wake_acp_agent (ws-bridge → orchestrator-monitor) ;
 *   3. attendre l'entrée comms {kind:'reply', convId:reqId}.
 */
export async function runDevinTurn(
    model: string,
    mode: ChatMode,
    messages: { role: 'user' | 'assistant'; text: string }[],
    onChunk?: (accumulated: string) => void,
    abortSignal?: AbortSignal,
    ctx?: TurnCtx,
    log: LogFn = noopLog,
): Promise<string> {
    if (!bridge || !bridge.isConnected) {
        throw new Error('Bridge ws://127.0.0.1:7477 injoignable — démarre l\'extension orchestrator-monitor.');
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const userText = messages.filter((m) => m.role === 'user').pop()?.text || '';
    if (!userText.trim()) throw new Error('message vide');

    const pickTarget = async (): Promise<string> => {
        const sessions = await listDevinSessions(wsRoot);
        return sessions.find((s) => s.focused)?.sessionId || sessions[0]?.sessionId || '';
    };

    // Cible : la session mémorisée par ce chat, sinon la session Devin focalisée.
    let target = ctx?.acpSessionId || '';
    if (!target) {
        target = await pickTarget();
        if (!target) {
            throw new Error('Aucune session Devin ouverte — ouvre un chat Devin dans l\'IDE puis réessaie.');
        }
        ctx?.onAcpSessionId?.(target);
    }

    const reqId = randomUUID();
    const envelope = buildEnvelope(reqId, mode, userText);
    const wake = (sessionId: string) =>
        bridgeRequest(bridge!, 'wake_acp_agent', {
            text: envelope, sessionId, providerId: 'devin-cli', workspaceRoot: wsRoot,
        }, 'acp_wake_result', WAKE_TIMEOUT_MS)
            .then((res) => String(res?.status || 'failed'));

    let status = await wake(target);
    if (status !== 'sent') {
        // Cible périmètre (fenêtre fermée entre-temps) : re-résoudre une fois.
        const retry = await pickTarget();
        if (retry && retry !== target) {
            log(`devin-turn reciblage ${target} → ${retry} (wake ${status})`);
            target = retry;
            ctx?.onAcpSessionId?.(target);
            status = await wake(target);
        }
    }
    if (status !== 'sent') {
        throw new Error(`Injection refusée (${status}) dans la session ${target} — fenêtre fermée ou provider devin-cli désactivé.`);
    }

    log(`devin-turn injecté req=${reqId} session=${target} model=${model} mode=${mode}`);
    onChunk?.(`⏳ Injecté dans la session Devin « ${shortSlug(target)} » — en attente de la réponse via comms.jsonl…`);

    const reply = await waitCommsReply(bridge, reqId, abortSignal, log);
    return reply || '*(Réponse vide — voir la fenêtre Devin cible)*';
}
