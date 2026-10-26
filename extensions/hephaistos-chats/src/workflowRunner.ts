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

interface CouncilTurn {
    role: string;
    sessionId: string;
    round: number;
    text: string;
}

function formatTranscript(transcript: CouncilTurn[]): string {
    return transcript
        .map((turn) => `[${turn.round === 0 ? 'Verdict' : `Tour ${turn.round}`}] ${turn.role}:\n${turn.text}`)
        .join('\n\n');
}

function buildCouncilTurnPrompt(
    node: WorkflowNode,
    question: string,
    transcript: CouncilTurn[],
    round: number,
    totalRounds: number,
): string {
    const skills = (node.skills || []).length ? ` Compétences: ${(node.skills || []).join(', ')}.` : '';
    const history = transcript.length ? `\n\nTRANSCRIPT DU CONCILE JUSQU'ICI:\n${formatTranscript(transcript)}` : '';
    const instruction = round === 1
        ? "Donne ta position argumentée sur la question, en t'appuyant sur ton expertise. Sois concis, tranché et honnête — signale les incertitudes."
        : "Après lecture des positions de tes pairs : réplique aux désaccords, renforce ou nuance ta position, puis indique si tu converges vers un consensus et lequel.";
    return `[CONCILE — tour ${round}/${totalRounds}]\nTu es ${node.role}, expert siégeant au concile.${skills}\nTon expertise : ${node.task}\n\nQUESTION À TRANCHER:\n${question}\n${history}\n\n${instruction}`;
}

function buildCouncilVerdictPrompt(
    entry: WorkflowNode,
    question: string,
    transcript: CouncilTurn[],
): string {
    return `[CONCILE — SYNTHÈSE FINALE]\nTu es ${entry.role}, président du concile.\n\nQUESTION SOUMISE AU CONCILE:\n${question}\n\nTRANSCRIPT COMPLET DE LA DÉLIBÉRATION:\n${formatTranscript(transcript)}\n\nRédige le VERDICT du concile : position retenue, arguments déterminants, points de dissensus restants et recommandation d'action. Conclusion claire, motivée et actionnable.`;
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
    ): Promise<void> {
        if (this.activeRun) throw new Error('Un flux est déjà en cours.');
        this.activeRun = true;
        const runId = randomUUID();
        try {
            if (graph.mode === 'council') {
                await this.executeCouncil(graph, entrySessionId, runId, enabledProviders);
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
        let failedSession: string | undefined;
        let failureError: unknown;
        const pending = new Set(tasks);

        while (pending.size > 0 && !failedSession) {
            // Un nœud est prêt si TOUTES ses dépendances amont (parents dans graph.edges) ont produit leur sortie
            const readyTasks = [...pending].filter((task) => {
                const parentEdges = graph.edges.filter((e) => e.target === task.node.sessionId);
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
                        .filter((edge) => edge.target === sid && outputs.has(edge.source))
                        .map((edge) => ({
                            role: this.nodeFor(graph, edge.source).role,
                            output: outputs.get(edge.source)!,
                        }));
                    const prompt = buildWorkflowPrompt(node, upstream, graph);
                    const result = session
                        ? await this.runSessionTurn(session, prompt)
                        : { reply: await runIdeAgentTurn(node.sessionId.split('/')[1], node.sessionId, 'agent', prompt, (m) => logRuntime(m)), stopReason: 'end_turn' };
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
     * Mode concile : délibération séquentielle à transcript partagé.
     * Le nœud d'entrée est le président (sa mission = la question) ; chaque
     * expert parle à tour de rôle en lisant tout ce qui a été dit, puis le
     * président rend le verdict. Pas de parallélisme : c'est une discussion.
     */
    private async executeCouncil(
        graph: WorkflowGraph,
        entrySessionId: string,
        runId: string,
        enabledProviders: Set<string>,
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
        const question = entry.task.trim() || 'Question non précisée par le président du concile.';
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

        const ROUNDS = 2;
        for (let round = 1; round <= ROUNDS && !failedSession; round++) {
            for (const node of experts) {
                try {
                    const output = await takeTurn(node, buildCouncilTurnPrompt(node, question, transcript, round, ROUNDS));
                    transcript.push({ role: node.role, sessionId: node.sessionId, round, text: output });
                    writeReport();
                    const task = taskBySession.get(node.sessionId)!;
                    const lastRound = round === ROUNDS;
                    await callHpheTool('update_task', {
                        task_id: task.taskId,
                        status: lastRound ? 'completed' : 'in_progress',
                        result: `[Tour ${round}] ${output.slice(0, 3900)}`,
                    });
                    this.onProgress({
                        runId,
                        sessionId: node.sessionId,
                        taskId: task.taskId,
                        state: lastRound ? 'completed' : 'running',
                        message: `Tour ${round}/${ROUNDS} — ${output.slice(0, 150)}`,
                    });
                } catch (error) {
                    failedSession = node.sessionId;
                    failureError = error;
                    await failTurn(node.sessionId, error);
                    break;
                }
            }
        }

        if (!failedSession) {
            try {
                const verdict = await takeTurn(entry, buildCouncilVerdictPrompt(entry, question, transcript));
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
                const external = !session && node.sessionId.startsWith('acp/');
                if (!external && !rosterIds.has(node.sessionId)) {
                    throw new Error(`L'agent ${node.sessionId} n'est pas présent dans le roster live.`);
                }
                if (!session && !external) throw new Error(`Session absente: ${node.sessionId}`);

                await this.registerAgent(node, session);
                const dependencies = graph.edges
                    .filter((edge) => edge.target === node.sessionId)
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
