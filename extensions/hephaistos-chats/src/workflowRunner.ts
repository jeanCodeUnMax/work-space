import { randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { ChatSession } from './types';
import { callHpheTool, logRuntime } from './runtime';
import { buildWorkflowPrompt, WorkflowGraph, WorkflowNode, WorkflowRunStatus, workflowOrder } from './workflow';
import { SessionStore } from './sessionStore';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 6000;

interface RosterStatus {
    entries?: { sessionId: string; providerId: string; group: string; status: string }[];
}

interface WorkflowTask {
    session: ChatSession;
    node: WorkflowNode;
    taskId: string;
    dependencies: string[];
}

export class WorkflowRunner {
    private readonly rosterScript: string;
    private readonly injectScript: string;
    private activeRun = false;

    constructor(
        private readonly workspaceRoot: string,
        private readonly sessions: SessionStore,
        private readonly onProgress: (status: WorkflowRunStatus) => void,
        private readonly onFinished: (runId: string, success: boolean, message: string) => void,
    ) {
        this.rosterScript = path.join(workspaceRoot, '.agent', 'agent-bridge', 'workspace-roster.js');
        this.injectScript = path.join(workspaceRoot, '.agent', 'agent-bridge', 'acp-inject.js');
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
        for (const task of tasks) {
            const { node, session, taskId } = task;
            try {
                this.onProgress({ runId, sessionId: session.id, taskId, state: 'running' });
                await callHpheTool('update_task', { task_id: taskId, status: 'in_progress' });
                const upstream = graph.edges
                    .filter((edge) => edge.target === session.id && outputs.has(edge.source))
                    .map((edge) => ({
                        role: this.nodeFor(graph, edge.source).role,
                        output: outputs.get(edge.source)!,
                    }));
                const prompt = buildWorkflowPrompt(node, upstream);
                const result = await this.inject(session.id, prompt);
                const output = result.reply.trim().slice(0, MAX_OUTPUT_CHARS);
                if (!output) throw new Error('L’agent a terminé sans réponse textuelle.');

                outputs.set(session.id, output);
                await callHpheTool('update_task', {
                    task_id: taskId,
                    status: 'completed',
                    result: output.slice(0, 4000),
                });
                this.onProgress({
                    runId,
                    sessionId: session.id,
                    taskId,
                    state: 'completed',
                    message: output.slice(0, 180),
                });
            } catch (error) {
                failedSession = session.id;
                const message = error instanceof Error ? error.message : String(error);
                await this.updateTaskFailure(taskId, message);
                this.onProgress({ runId, sessionId: session.id, taskId, state: 'failed', message });
                break;
            }
        }

        if (failedSession) {
            for (const task of tasks) {
                if (outputs.has(task.session.id) || task.session.id === failedSession) continue;
                await this.updateTaskFailure(task.taskId, `Bloqué par l’échec de ${failedSession}.`);
                this.onProgress({
                    runId,
                    sessionId: task.session.id,
                    taskId: task.taskId,
                    state: 'blocked',
                    message: `Bloqué par l’échec de ${failedSession}.`,
                });
            }
            throw new Error(`Le flux s’est arrêté sur ${failedSession}.`);
        }
    }

    private validateTasks(nodes: WorkflowNode[], enabledProviders: Set<string>): void {
        if (!nodes.length) throw new Error('Le point d’entrée ne mène à aucun agent.');
        for (const node of nodes) {
            if (!node.role.trim()) throw new Error(`Le rôle de ${node.sessionId} est vide.`);
            if (!node.task.trim()) throw new Error(`Ajoute une mission au bloc « ${node.role} » avant de lancer le flux.`);
            if (!this.sessions.get(node.sessionId)) {
                throw new Error(`La session ${node.sessionId} n’existe plus dans ce workspace.`);
            }
            const session = this.sessions.get(node.sessionId)!;
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
                if (!rosterIds.has(node.sessionId)) {
                    throw new Error(`L’agent ${node.sessionId} n’est pas présent dans le roster live.`);
                }
                const session = this.sessions.get(node.sessionId);
                if (!session) throw new Error(`Session absente: ${node.sessionId}`);

                await this.registerAgent(session, node);
                const dependencies = graph.edges
                    .filter((edge) => edge.target === session.id)
                    .map((edge) => idBySession.get(edge.source))
                    .filter((id): id is string => !!id);
                const prompt = buildWorkflowPrompt(node, []);
                const response = await callHpheTool('create_task', {
                    title: `[Flux] ${node.role} — ${session.id}`.slice(0, 180),
                    description: prompt.slice(0, 6000),
                    assigned_to: session.id,
                    dependencies,
                    priority: 'medium',
                    session: `workflow:${runId}`,
                    workspace: this.workspaceRoot,
                });
                const taskId = this.extractTaskId(response);
                idBySession.set(session.id, taskId);
                created.push({ session, node, taskId, dependencies });
            }
            return created;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await Promise.all(created.map((task) => this.updateTaskFailure(task.taskId, `Flux non lancé: ${message}`)));
            throw error;
        }
    }

    private async registerAgent(session: ChatSession, node: WorkflowNode): Promise<void> {
        await callHpheTool('register_agent', {
            agent_name: session.id,
            agent_type: 'acp',
            capabilities: JSON.stringify(['fs_read', 'fs_write', 'cmd']),
            config: JSON.stringify({
                transport: 'hephaistos-chat',
                provider: session.provider,
                model: session.model,
                session: session.id,
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

    private inject(sessionId: string, prompt: string): Promise<{ reply: string; stopReason: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [
                this.injectScript,
                '--provider', 'hephaistos',
                '--session', sessionId,
                '--cwd', this.workspaceRoot,
                '--wait', 'turn',
                '--timeout', '240',
                '--stdin',
            ], {
                cwd: this.workspaceRoot,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`Timeout ACP sur ${sessionId}.`));
            }, 250_000);

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-128_000); });
            child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4000); });
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                let result: any;
                try {
                    result = JSON.parse(stdout.trim());
                } catch {
                    reject(new Error(stderr || 'Réponse ACP illisible.'));
                    return;
                }
                if (code !== 0 || !result.delivered || result.stopReason !== 'end_turn') {
                    reject(new Error(result.error || `Tour ACP incomplet (${result.stopReason || code}).`));
                    return;
                }
                resolve({ reply: String(result.reply || ''), stopReason: result.stopReason });
            });
            child.stdin.end(prompt);
        });
    }
}
