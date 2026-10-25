import * as fs from 'fs';
import * as path from 'path';
import { ChatSession } from './types';
import { defaultRoleForProvider, WorkflowGraph, WorkflowNode } from './workflow';

interface RosterWorkflowApi {
    readWorkflow(root: string): WorkflowGraph;
    saveWorkflow(root: string, graph: WorkflowGraph): WorkflowGraph;
    syncRosterWorkflow(root: string, sessions: Pick<ChatSession, 'id' | 'model'>[]): WorkflowGraph;
    upsertChatAgent(root: string, agent: { sessionId: string; model: string; role: string }): WorkflowGraph;
    removeChatAgent(root: string, sessionId: string): WorkflowGraph;
}

export class WorkflowStore {
    private readonly api: RosterWorkflowApi;

    constructor(private readonly workspaceRoot: string) {
        const script = path.join(workspaceRoot, '.agent', 'agent-bridge', 'workspace-roster.js');
        if (!fs.existsSync(script)) {
            throw new Error('Le roster Hephaistos est absent de ce workspace.');
        }
        this.api = require(script) as RosterWorkflowApi;
    }

    load(sessions: ChatSession[]): WorkflowGraph {
        return this.api.syncRosterWorkflow(this.workspaceRoot, sessions);
    }

    upsertSession(session: ChatSession): WorkflowGraph {
        return this.api.upsertChatAgent(this.workspaceRoot, {
            sessionId: session.id,
            model: session.model,
            role: defaultRoleForProvider(session.provider),
        });
    }

    save(graph: WorkflowGraph): WorkflowGraph {
        return this.api.saveWorkflow(this.workspaceRoot, graph);
    }

    removeSession(sessionId: string): WorkflowGraph {
        return this.api.removeChatAgent(this.workspaceRoot, sessionId);
    }

    sessionNode(graph: WorkflowGraph, sessionId: string): WorkflowNode | undefined {
        return graph.nodes.find((node) => node.sessionId === sessionId);
    }
}
