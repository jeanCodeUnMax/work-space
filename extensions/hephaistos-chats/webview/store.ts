import { create } from 'zustand';
import type { Edge } from '@xyflow/react';
import type { AgentNode } from './workspace';

/**
 * Source unique d'état du workspace (remplace le duo useState+stateRef).
 * Lecture dans les callbacks : useWfStore.getState().
 * Écriture : les actions ci-dessous ou useWfStore.setState(partial).
 */
export interface WfState {
    nodes: AgentNode[];
    edges: Edge[];
    workflowName: string;
    entrySessionId: string | null;
    entryIsExplicit: boolean;
    activeSchema?: string;
    activeSchemaId?: string;
    locked: boolean;
    setNodes: (updater: AgentNode[] | ((cur: AgentNode[]) => AgentNode[])) => void;
    setEdges: (updater: Edge[] | ((cur: Edge[]) => Edge[])) => void;
}

export const useWfStore = create<WfState>((set) => ({
    nodes: [],
    edges: [],
    workflowName: 'Flux agents',
    entrySessionId: null,
    entryIsExplicit: false,
    activeSchema: undefined,
    activeSchemaId: undefined,
    locked: false,
    setNodes: (updater) => set((s) => ({ nodes: typeof updater === 'function' ? updater(s.nodes) : updater })),
    setEdges: (updater) => set((s) => ({ edges: typeof updater === 'function' ? updater(s.edges) : updater })),
}));

/** Compat : l'ancien stateRef.current lit/écrit le store zustand. */
export const wfRef = {
    get current(): WfState {
        return useWfStore.getState();
    },
    set current(v: Partial<WfState>) {
        useWfStore.setState(v);
    },
};
