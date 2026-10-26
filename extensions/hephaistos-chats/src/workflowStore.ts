import * as fs from 'fs';
import * as path from 'path';
import { ChatSession } from './types';
import { defaultRoleForProvider, WorkflowGraph, WorkflowNode } from './workflow';

interface RosterWorkflowApi {
    readWorkflow(root: string): WorkflowGraph;
    saveWorkflow(root: string, graph: WorkflowGraph): WorkflowGraph;
    syncRosterWorkflow(root: string, sessions: Pick<ChatSession, 'id' | 'model'>[]): WorkflowGraph;
    upsertChatAgent(root: string, agent: { sessionId: string; model: string; role: string; providerId?: string }): WorkflowGraph;
    upsertCoreAgent(root: string, group: string, agent: { providerId: string; sessionId: string; role?: string; title?: string; restore?: string }): WorkflowGraph;
    removeChatAgent(root: string, sessionId: string): WorkflowGraph;
    setMemberHidden(root: string, sessionId: string, hidden: boolean): void;
    saveSchema(root: string, name: string, graph: WorkflowGraph): unknown;
    listSchemas(root: string, all: boolean): Array<{ id: string; name: string; workspace: string; savedAt: string; nodes: number; desc?: string; builtin?: boolean; mode?: 'council' }>;
    loadSchema(root: string, id: string): WorkflowGraph;
    deleteSchema(root: string, id: string): unknown;
    renameSchema(root: string, id: string, name: string): { renamed?: boolean; protected?: boolean; name?: string; error?: string };
    updateStandardSchema(root: string, id: string, graph: WorkflowGraph): { updated?: boolean; name?: string; error?: string };
    createEmptySchema(root: string, name: string): WorkflowGraph;
    restoreStandardSchemas(root: string): { restored: string[] };
    getWorkflowAgentProfile(root: string, sessionId: string): {
        providerId: string;
        model: string;
        role: string;
        title: string;
    } | undefined;
}

export class WorkflowStore {
    private readonly api: RosterWorkflowApi;

    constructor(private readonly workspaceRoot: string) {
        const script = path.join(workspaceRoot, '.agent', 'agent-bridge', 'workspace-roster.js');
        if (!fs.existsSync(script)) {
            throw new Error('Le roster Hephaistos est absent de ce workspace.');
        }
        const resolved = require.resolve(script);
        delete require.cache[resolved];
        this.api = require(resolved) as RosterWorkflowApi;
    }

    load(sessions: ChatSession[]): WorkflowGraph {
        return this.api.syncRosterWorkflow(this.workspaceRoot, sessions);
    }

    upsertSession(session: ChatSession): WorkflowGraph {
        return this.api.upsertChatAgent(this.workspaceRoot, {
            sessionId: session.id,
            model: session.model,
            role: defaultRoleForProvider(session.provider),
            providerId: session.provider,
        });
    }

    upsertCoreAgent(group: string, agent: { providerId: string; sessionId: string; role?: string; title?: string }): WorkflowGraph {
        return this.api.upsertCoreAgent(this.workspaceRoot, group, agent);
    }

    save(graph: WorkflowGraph): WorkflowGraph {
        return this.api.saveWorkflow(this.workspaceRoot, graph);
    }

    removeSession(sessionId: string): WorkflowGraph {
        return this.api.removeChatAgent(this.workspaceRoot, sessionId);
    }

    setHidden(sessionId: string, hidden: boolean, sessions: ChatSession[]): WorkflowGraph {
        this.api.setMemberHidden(this.workspaceRoot, sessionId, hidden);
        return this.api.syncRosterWorkflow(this.workspaceRoot, sessions);
    }

    saveSchema(name: string, graph: WorkflowGraph): void {
        this.api.saveSchema(this.workspaceRoot, name, graph);
    }

    listSchemas(all: boolean): Array<{ id: string; name: string; workspace: string; savedAt: string; nodes: number; desc?: string; builtin?: boolean; mode?: 'council' }> {
        return this.api.listSchemas(this.workspaceRoot, all);
    }

    createSchema(name: string): WorkflowGraph {
        return this.api.createEmptySchema(this.workspaceRoot, name);
    }

    restoreStandards(): string[] {
        return this.api.restoreStandardSchemas(this.workspaceRoot).restored;
    }

    loadSchema(id: string): WorkflowGraph {
        return this.api.loadSchema(this.workspaceRoot, id);
    }

    deleteSchema(id: string): void {
        this.api.deleteSchema(this.workspaceRoot, id);
    }

    renameSchema(id: string, name: string): { renamed?: boolean; protected?: boolean; name?: string; error?: string } {
        return this.api.renameSchema(this.workspaceRoot, id, name);
    }

    updateStandardSchema(id: string, graph: WorkflowGraph): { updated?: boolean; name?: string; error?: string } {
        return this.api.updateStandardSchema(this.workspaceRoot, id, graph);
    }

    getAgentProfile(sessionId: string): {
        providerId: string;
        model: string;
        role: string;
        title: string;
    } | undefined {
        return this.api.getWorkflowAgentProfile(this.workspaceRoot, sessionId);
    }

    sessionNode(graph: WorkflowGraph, sessionId: string): WorkflowNode | undefined {
        return graph.nodes.find((node) => node.sessionId === sessionId);
    }
}
