import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { ChatSession } from './types';
import { runIdeAgentTurn } from './devinRoute';
import { callHpheTool, completeTurn, logRuntime } from './runtime';
import { buildWorkflowPrompt, WorkflowGraph, WorkflowNode, WorkflowRunStatus, workflowOrder } from './workflow';
import { SessionStore } from './sessionStore';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 6000;

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
            await this.execute(graph, entrySessionId, runId, enabledProviders);
            this.onFinished(runId, true, 'Flux terminé.');
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
