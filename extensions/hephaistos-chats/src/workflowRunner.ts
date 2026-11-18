import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { ChatSession } from './types';
import { runIdeAgentTurn } from './devinRoute';
import { callHpheTool, completeTurn, logRuntime } from './runtime';
import { buildWorkflowPrompt, WorkflowGraph, WorkflowNode, WorkflowRunStatus, workflowOrder } from './workflow';
import { SessionStore } from './sessionStore';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 6000;

// Préfixe marquant une mission « structurelle » (prompt de rôle polyvalent)
// par opposition à une question injectée dans la mission du chairman.
const COUNCIL_ROLE_PREFIX = 'ROLE:';

/**
 * La question du concile n'est PAS stockée dans la mission du chairman :
 * c'est un paramètre de run fourni par Devin. Ordre de résolution :
 *  1. champ `question` du nœud chairman (roster/schéma actif)
 *  2. champ `question` du graphe
 *  3. dernier message utilisateur de la session chairman (chat-*)
 *  4. mission du chairman si elle n'est pas préfixée ROLE: (compat legacy)
 */
function resolveCouncilQuestion(
    entry: WorkflowNode & { question?: string },
    graph: WorkflowGraph & { question?: string },
    sessions: SessionStore,
): string {
    if (typeof entry.question === 'string' && entry.question.trim()) return entry.question.trim();
    if (typeof graph.question === 'string' && graph.question.trim()) return graph.question.trim();
    const session = sessions.get(entry.sessionId);
    const lastUser = session?.messages
        ? [...session.messages].reverse().find((m) => m.role === 'user' && m.text.trim())
        : undefined;
    if (lastUser) return lastUser.text.trim();
    const task = entry.task.trim();
    if (task && !task.toUpperCase().startsWith(COUNCIL_ROLE_PREFIX)) return task;
    throw new Error(
        'Aucune problématique soumise au concile : injecte-la dans la session chairman '
        + '(dernier message utilisateur), renseigne le champ `question` du nœud ou du '
        + 'graphe, ou écris-la dans la mission du bloc chairman.',
    );
}

interface CouncilTurn {
    role: string;
    sessionId: string;
    round: number;
    text: string;
    label?: string;
}

interface AnonymizedResponse {
    label: string;
    role: string;
    sessionId: string;
    text: string;
}

function councilPhaseLabel(round: number): string {
    if (round === 0) return 'Verdict';
    if (round === 1) return 'Avis';
    if (round === 2) return 'Revue';
    return 'Débat';
}

function formatTranscript(transcript: CouncilTurn[]): string {
    return transcript
        .map((turn) => `[${councilPhaseLabel(turn.round)}] ${turn.role}${turn.label ? ` (réponse ${turn.label})` : ''}:\n${turn.text}`)
        .join('\n\n');
}

function buildCouncilOpinionPrompt(node: WorkflowNode, question: string): string {
    const skills = (node.skills || []).length ? ` Compétences: ${(node.skills || []).join(', ')}.` : '';
    return `[CONCILE — avis indépendant]\nTu es ${node.role}, conseiller siégeant au concile.${skills}\nTon angle de pensée : ${node.task}\n\nQUESTION À TRANCHER:\n${question}\n\nRéponds depuis ton angle uniquement — direct, spécifique, sans complaisance ni fausse balance. Pousse ta perspective à fond : les autres conseillers couvrent les angles que tu ne traites pas. Entre 150 et 300 mots, sans préambule.`;
}

function anonymizeOpinions(opinions: CouncilTurn[]): AnonymizedResponse[] {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const shuffled = [...opinions];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.map((turn, index) => ({
        label: letters[index],
        role: turn.role,
        sessionId: turn.sessionId,
        text: turn.text,
    }));
}

function buildCouncilReviewPrompt(
    node: WorkflowNode,
    question: string,
    anonymized: AnonymizedResponse[],
): string {
    const skills = (node.skills || []).length ? ` Compétences: ${(node.skills || []).join(', ')}.` : '';
    const responses = anonymized.map((anon) => `**Réponse ${anon.label} :**\n${anon.text}`).join('\n\n');
    return `[CONCILE — revue par les pairs]\nTu es ${node.role}, conseiller siégeant au concile.${skills}\n\n${anonymized.length} conseillers ont répondu indépendamment à cette question :\n\n---\n${question}\n---\n\nVoici leurs réponses, anonymisées :\n\n${responses}\n\nRéponds à ces trois questions en citant les lettres :\n1. Quelle réponse est la plus forte, et pourquoi ?\n2. Quelle réponse a le plus gros angle mort, et que manque-t-il ?\n3. Qu'est-ce que TOUTES les réponses ont raté et que le concile doit considérer ?\n\nMoins de 200 mots. Direct.`;
}

function buildCouncilDebatePrompt(
    node: WorkflowNode,
    question: string,
    transcript: CouncilTurn[],
): string {
    const skills = (node.skills || []).length ? ` Compétences: ${(node.skills || []).join(', ')}.` : '';
    return `[CONCILE — débat ouvert]\nTu es ${node.role}, conseiller siégeant au concile.${skills}\nTon angle de pensée : ${node.task}\n\nQUESTION À TRANCHER:\n${question}\n\nDÉLIBÉRATION COMPLÈTE JUSQU'ICI (avis dé-anonymisés, revues par les pairs, répliques déjà données):\n${formatTranscript(transcript)}\n\nL'anonymat est levé et le débat est ouvert : réplique aux désaccords en citant les conseillers par leur rôle, renforce ou nuance ta position, et indique si tu converges vers un consensus — lequel. Concis et tranché, 150-250 mots.`;
}

function buildCouncilVerdictPrompt(
    entry: WorkflowNode,
    question: string,
    transcript: CouncilTurn[],
    mapping: string,
): string {
    const opinions = transcript.filter((turn) => turn.round === 1)
        .map((turn) => `**${turn.role}${turn.label ? ` — réponse ${turn.label}` : ''} :**\n${turn.text}`)
        .join('\n\n');
    const reviews = transcript.filter((turn) => turn.round === 2)
        .map((turn) => `**Revue de ${turn.role} :**\n${turn.text}`)
        .join('\n\n');
    const debate = transcript.filter((turn) => turn.round === 3)
        .map((turn) => `**Réplique de ${turn.role} :**\n${turn.text}`)
        .join('\n\n');
    return `[CONCILE — VERDICT]\nTu es ${entry.role}, chairman du concile : tu synthétises les avis des conseillers, leurs revues croisées et le débat en un verdict final.\n\nQUESTION SOUMISE AU CONCILE:\n${question}\n\nAVIS DES CONSEILLERS (correspondance de l'anonymat : ${mapping}):\n${opinions}\n\nREVUES PAR LES PAIRS:\n${reviews}\n\nDÉBAT OUVERT:\n${debate}\n\nRends le verdict avec exactement cette structure :\n\n## Consensus du concile\n[Points sur lesquels plusieurs conseillers ont convergé indépendamment — signaux à haute confiance.]\n\n## Désaccords du concile\n[Désaccords réels : présente les deux côtés et explique pourquoi des conseillers raisonnables divergent.]\n\n## Angles morts détectés\n[Ce qui n'a émergé que grâce à la revue par les pairs — manques signalés par d'autres conseillers.]\n\n## Recommandation\n[Réponse claire et directe — pas de « ça dépend ». Tu peux suivre la minorité si son raisonnement est le plus solide, en expliquant pourquoi.]\n\n## Premier pas concret\n[UNE seule action immédiate — pas une liste.]\n\nDirect, sans langue de bois : le concile existe pour trancher.`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCouncilHtmlReport(
    graphName: string,
    runId: string,
    question: string,
    transcript: CouncilTurn[],
): string {
    const verdict = transcript.find((turn) => turn.round === 0);
    const sections = transcript.filter((turn) => turn.round !== 0)
        .map((turn) => `<details><summary>${escapeHtml(councilPhaseLabel(turn.round))} · ${escapeHtml(turn.role)}${turn.label ? ` — réponse ${escapeHtml(turn.label)}` : ''}</summary><div class="turn">${escapeHtml(turn.text)}</div></details>`)
        .join('\n');
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Concile — ${escapeHtml(graphName)}</title><style>body{font-family:system-ui,'Segoe UI',Arial,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1f2933;background:#fff}h1{font-size:20px}.meta{color:#6b7280;font-size:13px}.verdict{border:1px solid #d1d5db;border-left:4px solid #4f46e5;border-radius:8px;padding:16px 20px;background:#f8f7ff;white-space:pre-wrap}details{border:1px solid #e5e7eb;border-radius:8px;margin:10px 0;padding:8px 14px}summary{cursor:pointer;font-weight:600}.turn{white-space:pre-wrap;margin:10px 0;color:#374151}footer{margin-top:24px;font-size:12px;color:#9ca3af}</style></head><body><h1>Concile — ${escapeHtml(graphName)}</h1><p class="meta">Run ${runId}</p><h2>Question</h2><div class="turn">${escapeHtml(question)}</div><h2>Verdict du chairman</h2><div class="verdict">${escapeHtml(verdict ? verdict.text : 'Verdict non rendu (concile interrompu).')}</div><h2>Délibération</h2>${sections}<footer>Généré par hephaistos-chats workflowRunner — ${new Date().toISOString()}</footer></body></html>`;
}

interface RosterStatus {
    entries?: { sessionId: string; providerId: string; group: string; status: string }[];
}

interface WorkflowTask {
    session?: ChatSession;
    node: WorkflowNode;
    taskId: string;
    dependencies: string[];
}

export class WorkflowRunner {
    private readonly rosterScript: string;
    private activeRun = false;
    private cachedBridgeToken?: string;

    constructor(
        private readonly workspaceRoot: string,
        private readonly sessions: SessionStore,
        private readonly onProgress: (status: WorkflowRunStatus) => void,
        private readonly onFinished: (runId: string, success: boolean, message: string) => void,
    ) {
        this.rosterScript = path.join(workspaceRoot, '.agent', 'agent-bridge', 'workspace-roster.js');
    }

    async run(
        graph: WorkflowGraph,
        entrySessionId: string,
        enabledProviders: Set<string>,
        question?: string,
    ): Promise<void> {
        if (this.activeRun) throw new Error('Un flux est déjà en cours.');
        this.activeRun = true;
        const runId = randomUUID();
        try {
            if (graph.mode === 'council') {
                await this.executeCouncil(graph, entrySessionId, runId, enabledProviders, question);
                this.onFinished(runId, true, 'Concile terminé — verdict rendu.');
            } else {
                await this.execute(graph, entrySessionId, runId, enabledProviders);
                this.onFinished(runId, true, 'Flux terminé.');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.onFinished(runId, false, message);
            throw error;
        } finally {
            this.activeRun = false;
        }
    }

    private async execute(
        graph: WorkflowGraph,
        entrySessionId: string,
        runId: string,
        enabledProviders: Set<string>,
    ): Promise<void> {
        const orderedNodes = workflowOrder(graph, entrySessionId);
        this.validateTasks(orderedNodes, enabledProviders);
        const liveRoster = await this.getLiveRoster();
        const rosterIds = new Set(
            (liveRoster.entries || [])
                .filter((entry) => entry.group === 'bleubites'
                    && entry.providerId === 'hephaistos'
                    && entry.status === 'session-present')
                .map((entry) => entry.sessionId),
        );
        const tasks = await this.createTasks(graph, orderedNodes, rosterIds, runId);

        const outputs = new Map<string, string>();
        // Résultats des outils n8n pré-fetchés — un appel par carte svc et par run.
        const toolResults = new Map<string, string>();
        let failedSession: string | undefined;
        let failureError: unknown;
        const pending = new Set(tasks);

        while (pending.size > 0 && !failedSession) {
            // Un nœud est prêt si TOUTES ses dépendances amont ont produit leur
            // sortie. Les edges 'tool' sont des grants de contexte, jamais des deps.
            const readyTasks = [...pending].filter((task) => {
                const parentEdges = graph.edges.filter((e) => e.target === task.node.sessionId && e.type !== 'tool');
                return parentEdges.every((e) => outputs.has(e.source));
            });

            if (!readyTasks.length) {
                const stuck = [...pending][0];
                failedSession = stuck.node.sessionId;
                failureError = new Error(`Dépendances amont non résolues pour ${failedSession}.`);
                break;
            }

            // Exécution concurrente de tous les nœuds prêts du niveau topologique courant
            await Promise.all(readyTasks.map(async (task) => {
                pending.delete(task);
                const { node, session, taskId } = task;
                const sid = node.sessionId;
                if (failedSession) return;
                try {
                    this.onProgress({ runId, sessionId: sid, taskId, state: 'running' });
                    await callHpheTool('update_task', { task_id: taskId, status: 'in_progress' });
                    const upstream = graph.edges
                        .filter((edge) => edge.target === sid && edge.type !== 'tool' && outputs.has(edge.source))
                        .map((edge) => ({
                            role: this.nodeFor(graph, edge.source).role,
                            output: outputs.get(edge.source)!,
                        }));
                    /* Edges 'tool' : svc/* -> ce noeud, ou svc/* -> entry (= tout
                       le SWAT). Le workflow est invoqué via la bridge (allowlist
                       + secret côté serveur) et son résultat injecté en contexte. */
                    const toolCtx: string[] = [];
                    for (const te of graph.edges.filter((e) => e.type === 'tool'
                        && (e.target === sid || e.target === entrySessionId))) {
                        if (!toolResults.has(te.source)) {
                            toolResults.set(te.source, await this.callN8nSvc(te.source, {
                                missionId: runId,
                                objective: this.nodeFor(graph, entrySessionId).task || graph.name,
                                prompt: `Contexte demandé par l'étape ${node.role} (${sid})`,
                                texte: `Contexte demandé par l'étape ${node.role} (${sid})`,
                            }));
                        }
                        toolCtx.push(`[outil n8n ${te.source}]\n${toolResults.get(te.source)!.slice(0, 4000)}`);
                    }
                    const prompt = buildWorkflowPrompt(node, upstream, graph)
                        + (toolCtx.length ? `\n\nContexte outils n8n (pre-fetch du runner) :\n${toolCtx.join('\n\n')}` : '');
                    const result = session
                        ? await this.runSessionTurn(session, prompt)
                        : sid.startsWith('svc/')
                            ? { reply: await this.callN8nSvc(sid, { prompt, missionId: runId }), stopReason: 'end_turn' as const }
                            : { reply: await runIdeAgentTurn(node.sessionId.split('/')[1], node.sessionId, 'agent', prompt, (m) => logRuntime(m)), stopReason: 'end_turn' as const };
                    const output = result.reply.trim().slice(0, MAX_OUTPUT_CHARS);
                    if (!output) throw new Error('L’agent a terminé sans réponse textuelle.');

                    outputs.set(sid, output);
                    await callHpheTool('update_task', {
                        task_id: taskId,
                        status: 'completed',
                        result: output.slice(0, 4000),
                    });
                    this.onProgress({
                        runId,
                        sessionId: sid,
                        taskId,
                        state: 'completed',
                        message: output.slice(0, 180),
                    });
                } catch (error) {
                    if (!failedSession) {
                        failedSession = sid;
                        failureError = error;
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    await this.updateTaskFailure(taskId, message);
                    this.onProgress({ runId, sessionId: sid, taskId, state: 'failed', message });
                }
            }));
        }

        if (failedSession) {
            for (const task of tasks) {
                if (outputs.has(task.node.sessionId) || task.node.sessionId === failedSession) continue;
                await this.updateTaskFailure(task.taskId, `Bloqué par l’échec de ${failedSession}.`);
                this.onProgress({
                    runId,
                    sessionId: task.node.sessionId,
                    taskId: task.taskId,
                    state: 'blocked',
                    message: `Bloqué par l’échec de ${failedSession}.`,
                });
            }
            throw (failureError instanceof Error ? failureError : new Error(`Le flux s’est arrêté sur ${failedSession}.`));
        }
    }

    /**
     * Mode concile (méthodologie LLM Council, skill `llm-council`) :
     * le nœud d'entrée est le chairman (sa mission = la question).
     *  1. Avis indépendants en parallèle — aucun conseiller ne voit les autres.
     *  2. Revue par les pairs en parallèle — avis mélangés et anonymisés A, B, C…
     *  3. Débat ouvert en 2 tours séquentiels — anonymat levé, chacun
     *     réplique à tous les autres via le transcript partagé (full duplex
     *     broadcast ; le graphe affiche le maillage complet entre pairs).
     *  4. Verdict du chairman : consensus, désaccords, angles morts,
     *     recommandation et premier pas concret.
     * Artefacts : concil-live.md (suivi temps réel), archive .md et rapport
     * visuel concil-<runId>.html dans .agent/reports.
     */
    private async executeCouncil(
        graph: WorkflowGraph,
        entrySessionId: string,
        runId: string,
        enabledProviders: Set<string>,
        providedQuestion?: string,
    ): Promise<void> {
        // En mode concile, toutes les cartes siégent — les arêtes ne portent
        // pas de sémantique d'exécution (ordre de parole = ordre du graphe).
        const orderedNodes = graph.nodes;
        this.validateTasks(orderedNodes, enabledProviders);
        const entry = this.nodeFor(graph, entrySessionId);
        const experts = orderedNodes.filter((node) => node.sessionId !== entrySessionId);
        if (!experts.length) {
            throw new Error('Un concile exige au moins un expert en plus du président (nœud d’entrée).');
        }
        const question = providedQuestion?.trim() || resolveCouncilQuestion(entry, graph, this.sessions);
        const liveRoster = await this.getLiveRoster();
        const rosterIds = new Set(
            (liveRoster.entries || [])
                .filter((item) => item.group === 'bleubites'
                    && item.providerId === 'hephaistos'
                    && item.status === 'session-present')
                .map((item) => item.sessionId),
        );
        const tasks = await this.createTasks(graph, orderedNodes, rosterIds, runId);
        const taskBySession = new Map(tasks.map((task) => [task.node.sessionId, task]));
        const transcript: CouncilTurn[] = [];
        let failedSession: string | undefined;
        let failureError: unknown;

        // Transcript live : réécrit après chaque prise de parole — le rapport
        // concil-live.md permet de suivre le débat en temps réel (preview MD).
        const reportDir = path.join(this.workspaceRoot, '.agent', 'reports');
        const liveReport = path.join(reportDir, 'concil-live.md');
        const writeReport = (): void => {
            try {
                fs.mkdirSync(reportDir, { recursive: true });
                fs.writeFileSync(liveReport, [
                    `# Concil — ${graph.name}`,
                    '',
                    `**Question** : ${question}`,
                    `**Run** : ${runId}`,
                    '',
                    ...transcript.map((turn) => `## ${turn.role} (${turn.round === 0 ? 'verdict' : `tour ${turn.round}`})\n\n${turn.text}\n`),
                ].join('\n'), 'utf8');
            } catch (error) {
                logRuntime(`concil live report write failed: ${String(error)}`);
            }
        };
        writeReport();

        const takeTurn = async (node: WorkflowNode, prompt: string): Promise<string> => {
            const task = taskBySession.get(node.sessionId)!;
            this.onProgress({ runId, sessionId: node.sessionId, taskId: task.taskId, state: 'running' });
            await callHpheTool('update_task', { task_id: task.taskId, status: 'in_progress' });
            const result = task.session
                ? await this.runSessionTurn(task.session, prompt)
                : { reply: await runIdeAgentTurn(node.sessionId.split('/')[1], node.sessionId, 'agent', prompt, (m) => logRuntime(m)), stopReason: 'end_turn' };
            const output = result.reply.trim().slice(0, MAX_OUTPUT_CHARS);
            if (!output) throw new Error('L’agent a terminé sans réponse textuelle.');
            return output;
        };
        const failTurn = async (sessionId: string, error: unknown): Promise<void> => {
            const task = taskBySession.get(sessionId)!;
            const message = error instanceof Error ? error.message : String(error);
            await this.updateTaskFailure(task.taskId, message);
            this.onProgress({ runId, sessionId, taskId: task.taskId, state: 'failed', message });
        };

        // Phase 1 — avis indépendants en parallèle : aucun conseiller ne voit
        // les réponses des autres. L'indépendance est ce qui produit la tension
        // entre perspectives (méthodo LLM Council).
        const opinionResults = await Promise.all(experts.map(async (node) => {
            try {
                const output = await takeTurn(node, buildCouncilOpinionPrompt(node, question));
                transcript.push({ role: node.role, sessionId: node.sessionId, round: 1, text: output });
                writeReport();
                this.onProgress({
                    runId,
                    sessionId: node.sessionId,
                    taskId: taskBySession.get(node.sessionId)!.taskId,
                    state: 'running',
                    message: `Avis rendu — ${output.slice(0, 150)}`,
                });
                return { node, error: undefined as unknown };
            } catch (error) {
                return { node, error };
            }
        }));
        const opinionFailure = opinionResults.find((result) => result.error);
        if (opinionFailure) {
            failedSession = opinionFailure.node.sessionId;
            failureError = opinionFailure.error;
            await failTurn(opinionFailure.node.sessionId, opinionFailure.error);
        }

        // Phase 2 — revue par les pairs en parallèle : les avis sont mélangés et
        // anonymisés (Réponse A, B, C…) pour que chaque conseiller évalue le
        // fond, pas l'auteur.
        let anonymized: AnonymizedResponse[] = [];
        if (!failedSession) {
            anonymized = anonymizeOpinions(transcript.filter((turn) => turn.round === 1));
            for (const anon of anonymized) {
                const turn = transcript.find((item) => item.sessionId === anon.sessionId && item.round === 1);
                if (turn) turn.label = anon.label;
            }
            writeReport();
            const reviewResults = await Promise.all(experts.map(async (node) => {
                try {
                    const output = await takeTurn(node, buildCouncilReviewPrompt(node, question, anonymized));
                    transcript.push({ role: node.role, sessionId: node.sessionId, round: 2, text: output });
                    writeReport();
                    const task = taskBySession.get(node.sessionId)!;
                    await callHpheTool('update_task', {
                        task_id: task.taskId,
                        status: 'in_progress',
                        result: `[Revue] ${output.slice(0, 3900)}`,
                    });
                    this.onProgress({
                        runId,
                        sessionId: node.sessionId,
                        taskId: task.taskId,
                        state: 'running',
                        message: `Revue rendue — ${output.slice(0, 150)}`,
                    });
                    return { node, error: undefined as unknown };
                } catch (error) {
                    return { node, error };
                }
            }));
            const reviewFailure = reviewResults.find((result) => result.error);
            if (reviewFailure) {
                failedSession = reviewFailure.node.sessionId;
                failureError = reviewFailure.error;
                await failTurn(reviewFailure.node.sessionId, reviewFailure.error);
            }
        }

        // Phase 3 — débat ouvert : l'anonymat tombe et les conseillers
        // discutent entre eux. Deux tours de parole chaînés (séquentiel) :
        // chaque réplique est visible par tous les suivants — full duplex
        // via le transcript partagé, vrai va-et-vient multi-tour.
        const DEBATE_ROUNDS = 2;
        if (!failedSession) {
            for (let debateRound = 1; debateRound <= DEBATE_ROUNDS && !failedSession; debateRound++) {
                for (const node of experts) {
                    try {
                        const output = await takeTurn(node, buildCouncilDebatePrompt(node, question, transcript));
                        transcript.push({ role: node.role, sessionId: node.sessionId, round: 3, text: output });
                        writeReport();
                        const task = taskBySession.get(node.sessionId)!;
                        const lastTurn = debateRound === DEBATE_ROUNDS;
                        await callHpheTool('update_task', {
                            task_id: task.taskId,
                            status: lastTurn ? 'completed' : 'in_progress',
                            result: `[Débat ${debateRound}/${DEBATE_ROUNDS}] ${output.slice(0, 3900)}`,
                        });
                        this.onProgress({
                            runId,
                            sessionId: node.sessionId,
                            taskId: task.taskId,
                            state: lastTurn ? 'completed' : 'running',
                            message: `Réplique ${debateRound}/${DEBATE_ROUNDS} — ${output.slice(0, 150)}`,
                        });
                    } catch (error) {
                        failedSession = node.sessionId;
                        failureError = error;
                        await failTurn(node.sessionId, error);
                        break;
                    }
                }
            }
        }

        // Phase 4 — verdict du chairman : avis dé-anonymisés + revues + débat.
        if (!failedSession) {
            try {
                const mapping = anonymized.map((anon) => `${anon.label}=${anon.role}`).join(', ');
                const verdict = await takeTurn(entry, buildCouncilVerdictPrompt(entry, question, transcript, mapping));
                transcript.push({ role: `Verdict — ${entry.role}`, sessionId: entry.sessionId, round: 0, text: verdict });
                writeReport();
                const task = taskBySession.get(entry.sessionId)!;
                await callHpheTool('update_task', { task_id: task.taskId, status: 'completed', result: verdict.slice(0, 4000) });
                this.onProgress({ runId, sessionId: entry.sessionId, taskId: task.taskId, state: 'completed', message: verdict.slice(0, 180) });
            } catch (error) {
                failedSession = entry.sessionId;
                failureError = error;
                await failTurn(entry.sessionId, error);
            }
        }

        // Archive horodatée en plus du transcript live concil-live.md.
        try {
            fs.copyFileSync(liveReport, path.join(reportDir, `concil-${runId.slice(0, 8)}.md`));
        } catch (error) {
            logRuntime(`concil report archive failed: ${String(error)}`);
        }
        // Rapport visuel HTML auto-contenu (méthodo LLM Council) : verdict en
        // évidence, interventions des conseillers en sections repliées.
        try {
            fs.writeFileSync(
                path.join(reportDir, `concil-${runId.slice(0, 8)}.html`),
                buildCouncilHtmlReport(graph.name, runId, question, transcript),
                'utf8',
            );
        } catch (error) {
            logRuntime(`concil html report write failed: ${String(error)}`);
        }

        if (failedSession) {
            for (const task of tasks) {
                if (task.node.sessionId === failedSession) continue;
                const spoke = transcript.some((turn) => turn.sessionId === task.node.sessionId);
                if (spoke) continue;
                await this.updateTaskFailure(task.taskId, `Concile interrompu par l’échec de ${failedSession}.`);
                this.onProgress({
                    runId,
                    sessionId: task.node.sessionId,
                    taskId: task.taskId,
                    state: 'blocked',
                    message: `Concile interrompu par l’échec de ${failedSession}.`,
                });
            }
            throw (failureError instanceof Error ? failureError : new Error(`Le concile s’est arrêté sur ${failedSession}.`));
        }
    }

    private validateTasks(nodes: WorkflowNode[], enabledProviders: Set<string>): void {
        if (!nodes.length) throw new Error('Le point d’entrée ne mène à aucun agent.');
        for (const node of nodes) {
            if (!node.role.trim()) throw new Error(`Le rôle de ${node.sessionId} est vide.`);
            if (!node.task.trim()) throw new Error(`Ajoute une mission au bloc « ${node.role} » avant de lancer le flux.`);
            // Nœud service n8n (svc/n8n/<workflowId>) : exécuté via la bridge
            // HTTP, jamais une session chat — pas de contrôle roster/provider.
            if (node.sessionId.startsWith('svc/')) continue;
            const session = this.sessions.get(node.sessionId);
            if (!session) {
                if (!node.sessionId.startsWith('acp/')) {
                    throw new Error(`La session ${node.sessionId} n'existe plus dans ce workspace.`);
                }
                continue; // Agent IDE externe : exécuté via le hub (wake_acp_agent).
            }
            if (session.workspace && path.resolve(session.workspace) !== path.resolve(this.workspaceRoot)) {
                throw new Error(`La session ${node.sessionId} appartient à un autre workspace.`);
            }
            if (!enabledProviders.has(session.provider)) {
                throw new Error(`Le fournisseur ${session.provider} de ${node.sessionId} est désactivé dans le monitor.`);
            }
        }
    }

    private async getLiveRoster(): Promise<RosterStatus> {
        const { stdout } = await execFileAsync(process.execPath, [this.rosterScript, 'status'], {
            cwd: this.workspaceRoot,
            encoding: 'utf8',
            timeout: 20000,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
        });
        return JSON.parse(stdout) as RosterStatus;
    }

    private async createTasks(
        graph: WorkflowGraph,
        nodes: WorkflowNode[],
        rosterIds: Set<string>,
        runId: string,
    ): Promise<WorkflowTask[]> {
        // These tasks target exact existing chat sessions; dispatch_task would spawn a different CLI agent.
        const created: WorkflowTask[] = [];
        const idBySession = new Map<string, string>();
        try {
            for (const node of nodes) {
                const session = this.sessions.get(node.sessionId);
                const isSvc = node.sessionId.startsWith('svc/');
                const external = !session && node.sessionId.startsWith('acp/');
                if (!isSvc && !external && !rosterIds.has(node.sessionId)) {
                    throw new Error(`L'agent ${node.sessionId} n'est pas présent dans le roster live.`);
                }
                if (!isSvc && !session && !external) throw new Error(`Session absente: ${node.sessionId}`);

                await this.registerAgent(node, session);
                const dependencies = graph.edges
                    .filter((edge) => edge.target === node.sessionId && edge.type !== 'tool')
                    .map((edge) => idBySession.get(edge.source))
                    .filter((id): id is string => !!id);
                const prompt = buildWorkflowPrompt(node, [], graph);
                const response = await callHpheTool('create_task', {
                    title: `[Flux] ${node.role} - ${node.sessionId}`.slice(0, 180),
                    description: prompt.slice(0, 6000),
                    assigned_to: node.sessionId,
                    dependencies,
                    priority: 'medium',
                    session: `workflow:${runId}`,
                    workspace: this.workspaceRoot,
                });
                const taskId = this.extractTaskId(response);
                idBySession.set(node.sessionId, taskId);
                created.push({ session, node, taskId, dependencies });
            }
            return created;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await Promise.all(created.map((task) => this.updateTaskFailure(task.taskId, `Flux non lancé: ${message}`)));
            throw error;
        }
    }

    private async registerAgent(node: WorkflowNode, session?: ChatSession): Promise<void> {
        await callHpheTool('register_agent', {
            agent_name: node.sessionId,
            agent_type: 'acp',
            capabilities: JSON.stringify(['fs_read', 'fs_write', 'cmd']),
            config: JSON.stringify({
                transport: session ? 'hephaistos-chat' : 'ide-agent',
                provider: session?.provider || node.sessionId.split('/')[1] || 'unknown',
                model: session?.model || 'agent IDE',
                session: node.sessionId,
                workspace: this.workspaceRoot,
                role: node.role,
            }),
        });
    }

    private extractTaskId(response: any): string {
        const id = response?.id ?? response?.task_id ?? response?.task?.id ?? response?.data?.id;
        if (id == null || String(id).trim() === '') {
            throw new Error('hphe-mcp a créé une tâche sans renvoyer son identifiant.');
        }
        return String(id);
    }

    private nodeFor(graph: WorkflowGraph, sessionId: string): WorkflowNode {
        const node = graph.nodes.find((item) => item.sessionId === sessionId);
        if (!node) throw new Error(`Nœud de workflow inconnu: ${sessionId}`);
        return node;
    }

    /* Nœud service n8n : le suffixe svc/n8n/<workflowId> est résolu par la
       bridge (allowlist → webhookPath, secret injecté côté serveur). Un seul
       point de résolution : pas de secret n8n dans l'extension. */
    private async callN8nSvc(sessionId: string, payload: Record<string, unknown>): Promise<string> {
        const suffix = sessionId.split('/')[2] || '';
        if (!suffix || !/^[a-zA-Z0-9_-]{1,100}$/.test(suffix)) {
            throw new Error(`svc/n8n invalide : ${sessionId} — choisis un workflow dans le panneau de la carte.`);
        }
        const token = this.bridgeToken();
        const r = await fetch(`http://127.0.0.1:7478/n8n/workflows/${encodeURIComponent(suffix)}/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(300_000),
        });
        const data = await r.json().catch(() => ({})) as { ok?: boolean; result?: unknown; error?: string; httpStatus?: number };
        if (!r.ok || data.ok === false) {
            throw new Error(`svc n8n ${suffix} HTTP ${data.httpStatus || r.status} : ${String(data.error || JSON.stringify(data.result ?? data)).slice(0, 300)}`);
        }
        const res = data.result;
        const reply = typeof res === 'string' ? res
            : (res && typeof res === 'object'
                ? String((res as Record<string, unknown>).output || (res as Record<string, unknown>).response || JSON.stringify(res))
                : '');
        if (!reply.trim()) throw new Error(`Reponse n8n vide (${suffix}).`);
        return reply.trim();
    }

    private bridgeToken(): string {
        if (this.cachedBridgeToken === undefined) {
            try {
                this.cachedBridgeToken = fs.readFileSync(path.join(this.workspaceRoot, '.agent', 'ws-bridge.token'), 'utf8').trim();
            } catch { this.cachedBridgeToken = ''; }
        }
        return this.cachedBridgeToken;
    }

    private async updateTaskFailure(taskId: string, message: string): Promise<void> {
        try {
            await callHpheTool('update_task', {
                task_id: taskId,
                status: 'failed',
                result: message.slice(0, 2000),
            });
        } catch (error) {
            logRuntime(`workflow task update failed task=${taskId}: ${String(error)}`);
        }
    }

    /**
     * Exécute l'étape dans la session de chat elle-même — même chemin que la
     * webview (completeTurn) : devin-cli passe par le hub ws-bridge :7477, les
     * providers API par leur backend HTTP, les agents ACP par runAcpTurn.
     * Le message et la réponse sont persistés dans sessions.json : la fenêtre
     * de chat affiche le tour comme si l'utilisateur l'avait tapé.
     */
    private async runSessionTurn(session: ChatSession, prompt: string): Promise<{ reply: string; stopReason: string }> {
        const now = new Date().toISOString();
        const working: ChatSession = {
            ...session,
            messages: [
                ...session.messages,
                { role: 'user', text: prompt, at: now },
                { role: 'assistant', text: '', at: new Date().toISOString() },
            ],
        };
        this.sessions.save(working);
        const last = working.messages.length - 1;
        try {
            const reply = await completeTurn(
                working.provider,
                working.model,
                working.mode,
                working.messages.slice(0, last),
                (accumulated) => { working.messages[last].text = accumulated; },
                undefined,
                undefined,
                {
                    chatSessionId: working.id,
                    acpSessionId: working.acpSessionId,
                    onAcpSessionId: (id) => { working.acpSessionId = id; },
                },
            );
            working.messages[last].isError = false;
            this.sessions.save(working);
            return { reply, stopReason: 'end_turn' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            working.messages[last].text = `⚠️ **Erreur :** ${message}`;
            working.messages[last].isError = true;
            this.sessions.save(working);
            throw error;
        }
    }
}
