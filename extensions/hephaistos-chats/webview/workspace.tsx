import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    addEdge,
    applyEdgeChanges,
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MiniMap,
    Position,
    ReactFlow,
    useEdgesState,
    useNodesState,
    type Connection,
    type Edge,
    type Node,
    type NodeProps,
    type OnEdgesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './workspace.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface AgentData extends Record<string, unknown> {
    sessionId: string;
    title: string;
    provider: string;
    model: string;
    role: string;
    task: string;
    isEntry: boolean;
    tone: 'amber' | 'blue' | 'green';
}

type AgentNode = Node<AgentData, 'agent'>;

interface StoredNode {
    sessionId: string;
    role: string;
    task: string;
    position: { x: number; y: number };
}

interface StoredEdge {
    id: string;
    source: string;
    target: string;
}

interface WorkflowGraph {
    version: 1;
    name: string;
    entrySessionId: string | null;
    nodes: StoredNode[];
    edges: StoredEdge[];
}

interface WorkflowView {
    graph: WorkflowGraph;
    nodes: AgentNode[];
    edges: Edge[];
    entrySessionId: string | null;
}

interface Progress {
    runId: string;
    sessionId: string;
    state: 'running' | 'completed' | 'failed' | 'blocked';
    message?: string;
}

const vscode = acquireVsCodeApi();

function AgentNodeCard({ data, selected }: NodeProps<AgentNode>): React.JSX.Element {
    return (
        <div className={`flow-node ${data.tone}${selected ? ' selected' : ''}`}>
            <Handle type="target" position={Position.Left} />
            <div className="flow-node-heading">
                <span className="flow-node-kicker">{data.isEntry ? 'ENTRÉE' : 'AGENT'}</span>
                <span className="flow-node-provider">{data.provider}</span>
            </div>
            <strong className="flow-node-title">{data.title}</strong>
            <span className="flow-node-model">{data.model}</span>
            <span className="flow-node-role">{data.role}</span>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}

const nodeTypes = { agent: AgentNodeCard };

function toStoredGraph(
    nodes: AgentNode[],
    edges: Edge[],
    name: string,
    entrySessionId: string | null,
    entryIsExplicit: boolean,
): WorkflowGraph {
    return {
        version: 1,
        name,
        entrySessionId: entryIsExplicit ? entrySessionId : null,
        nodes: nodes.map((node) => ({
            sessionId: node.id,
            role: node.data.role,
            task: node.data.task,
            position: node.position,
        })),
        edges: edges.map(({ id, source, target }) => ({ id, source, target })),
    };
}

function Workspace(): React.JSX.Element {
    const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>([]);
    const [edges, setEdges] = useEdgesState<Edge>([]);
    const [workflowName, setWorkflowName] = useState('Flux agents');
    const [entrySessionId, setEntrySessionId] = useState<string | null>(null);
    const [entryIsExplicit, setEntryIsExplicit] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [progress, setProgress] = useState<Record<string, Progress>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [runSummary, setRunSummary] = useState('');
    const saveTimer = useRef<number | undefined>(undefined);

    const selectedNode = useMemo(
        () => nodes.find((node) => node.id === selectedId),
        [nodes, selectedId],
    );
    const entryNode = nodes.find((node) => node.id === entrySessionId);
    const completedCount = Object.values(progress).filter((item) => item.state === 'completed').length;

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const message = event.data;
            if (message?.type === 'workflow_state') {
                const view = message.workflow as WorkflowView;
                setNodes(view.nodes);
                setEdges(view.edges);
                setWorkflowName(view.graph.name);
                setEntrySessionId(view.entrySessionId);
                setEntryIsExplicit(!!view.graph.entrySessionId);
                setSelectedId((current) => view.nodes.some((node) => node.id === current) ? current : null);
                return;
            }
            if (message?.type === 'workflow_run_finished') {
                setIsRunning(false);
                setRunSummary(String(message.message || 'Flux terminé.'));
                return;
            }
            if (message?.type === 'workflow_error') {
                setRunSummary(String(message.message || 'Impossible de modifier le flux.'));
                return;
            }
            if (message?.type === 'workflow_progress') {
                const update = message.status as Progress;
                setProgress((current) => ({ ...current, [update.sessionId]: update }));
                if (update.state === 'running') setIsRunning(true);
                if (update.state === 'failed' || update.state === 'blocked') setIsRunning(false);
            }
        };
        window.addEventListener('message', onMessage);
        vscode.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, [setEdges, setNodes]);

    const sendSave = useCallback((
        nextNodes: AgentNode[] = nodes,
        nextEdges: Edge[] = edges,
        nextEntry: string | null = entrySessionId,
        nextName = workflowName,
        nextEntryIsExplicit = entryIsExplicit,
    ) => {
        if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
            vscode.postMessage({
                type: 'workflow_change',
                graph: toStoredGraph(nextNodes, nextEdges, nextName, nextEntry, nextEntryIsExplicit),
            });
        }, 300);
    }, [edges, entryIsExplicit, entrySessionId, nodes, workflowName]);

    const onConnect = useCallback((connection: Connection) => {
        const nextEdges = addEdge({ ...connection, type: 'smoothstep' }, edges);
        setEdges(nextEdges);
        setSelectedEdgeId(null);
        sendSave(nodes, nextEdges);
    }, [edges, nodes, sendSave, setEdges]);

    const onEdgeChanges: OnEdgesChange = useCallback((changes) => {
        const nextEdges = applyEdgeChanges(changes, edges);
        setEdges(nextEdges);
        sendSave(nodes, nextEdges);
    }, [edges, nodes, sendSave, setEdges]);

    const updateNode = (id: string, values: Partial<AgentData>): void => {
        const nextNodes = nodes.map((node) => node.id === id
            ? { ...node, data: { ...node.data, ...values } }
            : node);
        setNodes(nextNodes);
        sendSave(nextNodes);
    };

    const chooseEntry = (id: string): void => {
        const isCurrentExplicitEntry = entryIsExplicit && entrySessionId === id;
        const nextEntryIsExplicit = !isCurrentExplicitEntry;
        const recommendedEntry = nodes.find((node) => node.data.provider === 'devin-cli')
            || nodes.find((node) => node.data.provider === 'antigravity-acp');
        const nextEntry = nextEntryIsExplicit ? id : recommendedEntry?.id || null;
        setEntrySessionId(nextEntry);
        setEntryIsExplicit(nextEntryIsExplicit);
        const nextNodes = nodes.map((node) => ({
            ...node,
            data: { ...node.data, isEntry: node.id === nextEntry },
        }));
        setNodes(nextNodes);
        sendSave(nextNodes, edges, nextEntry, workflowName, nextEntryIsExplicit);
    };

    const onNodeDragStop = (_event: MouseEvent | TouchEvent, moved: AgentNode): void => {
        const nextNodes = nodes.map((node) => node.id === moved.id ? moved : node);
        setNodes(nextNodes);
        sendSave(nextNodes);
    };

    const runWorkflow = (): void => {
        const selectedEntry = entrySessionId || entryNode?.id;
        if (!selectedEntry || isRunning) return;
        setProgress({});
        setRunSummary('');
        setIsRunning(true);
        vscode.postMessage({ type: 'run_workflow', sessionId: selectedEntry });
    };

    const removeSelectedEdge = (): void => {
        if (!selectedEdgeId) return;
        const nextEdges = edges.filter((edge) => edge.id !== selectedEdgeId);
        setEdges(nextEdges);
        setSelectedEdgeId(null);
        sendSave(nodes, nextEdges);
    };

    const removeFromWorkflow = (): void => {
        if (!selectedId) return;
        vscode.postMessage({ type: 'remove_agent', sessionId: selectedId });
        setSelectedId(null);
    };

    return (
        <main className="workspace-shell">
            <header className="workspace-toolbar">
                <div className="workspace-title">
                    <span className="workspace-mark" aria-hidden="true">H</span>
                    <div>
                        <input
                            className="workflow-name"
                            aria-label="Nom du flux"
                            value={workflowName}
                            onChange={(event) => {
                                setWorkflowName(event.target.value);
                                sendSave(nodes, edges, entrySessionId, event.target.value);
                            }}
                        />
                        <p>Les connexions transmettent le résultat d’un agent au suivant.</p>
                    </div>
                </div>
                <div className="workspace-actions">
                    <span className="node-count">{nodes.length} agents</span>
                    <button type="button" className="add-node add-node-secondary" onClick={() => vscode.postMessage({ type: 'create_agent', provider: 'antigravity-acp' })}>
                        + Antigravity
                    </button>
                    {selectedEdgeId && <button type="button" className="remove-edge" onClick={removeSelectedEdge}>Retirer le lien</button>}
                    <button type="button" className="add-node" onClick={() => vscode.postMessage({ type: 'create_agent', provider: 'devin-cli' })}>
                        + Devin
                    </button>
                    <button type="button" className="run-workflow" onClick={runWorkflow} disabled={isRunning || !nodes.length || !entrySessionId}>
                        {isRunning ? 'Chaîne en cours…' : 'Lancer le flux'}
                    </button>
                </div>
            </header>
            <div className="workspace-content">
                <section className="flow-canvas" aria-label="Éditeur visuel React Flow">
                    {nodes.length === 0 ? (
                        <div className="canvas-empty">
                            <span className="empty-kicker">POINT D’ENTRÉE</span>
                            <h2>Commence avec Devin</h2>
                            <p>Chaque chat Hephaistos devient un agent relié à sa vraie session et à son modèle.</p>
                            <div className="empty-actions">
                                <button type="button" className="run-workflow" onClick={() => vscode.postMessage({ type: 'create_agent', provider: 'devin-cli' })}>Créer un chat Devin</button>
                                <button type="button" className="add-node add-node-secondary" onClick={() => vscode.postMessage({ type: 'create_agent', provider: 'antigravity-acp' })}>Choisir Antigravity</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <ReactFlow
                                nodes={nodes}
                                edges={edges}
                                nodeTypes={nodeTypes}
                                onNodesChange={onNodesChange}
                                onEdgesChange={onEdgeChanges}
                                onConnect={onConnect}
                                onNodeClick={(_event, node) => setSelectedId(node.id)}
                                onEdgeClick={(_event, edge) => {
                                    setSelectedId(null);
                                    setSelectedEdgeId(edge.id);
                                }}
                                onPaneClick={() => {
                                    setSelectedId(null);
                                    setSelectedEdgeId(null);
                                }}
                                onNodeDragStop={onNodeDragStop}
                                fitView
                                fitViewOptions={{ padding: 0.24 }}
                                deleteKeyCode={null}
                                selectionOnDrag
                            >
                                <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
                                <Controls />
                                <MiniMap pannable zoomable />
                            </ReactFlow>
                            <div className="canvas-note">
                                Relie les ports pour créer une dépendance. Les missions ne partent qu’au clic sur « Lancer le flux ».
                            </div>
                        </>
                    )}
                    {runSummary && <div className="run-summary-toast">{runSummary}</div>}
                </section>
                <aside className="node-inspector">
                    {selectedNode ? (
                        <>
                            <div className="inspector-header">
                                <span className="inspector-kicker">CONFIGURATION AGENT</span>
                                <button type="button" className="icon-button" title="Retirer du flux" onClick={removeFromWorkflow}>×</button>
                            </div>
                            <h2>{selectedNode.data.title}</h2>
                            <p className="inspector-provider">{selectedNode.data.provider} · {selectedNode.data.model}</p>
                            <label className="field-label" htmlFor="agent-role">Rôle</label>
                            <input
                                id="agent-role"
                                className="inspector-input"
                                value={selectedNode.data.role}
                                onChange={(event) => updateNode(selectedNode.id, { role: event.target.value })}
                                maxLength={120}
                            />
                            <label className="field-label" htmlFor="agent-task">Mission de cet agent</label>
                            <textarea
                                id="agent-task"
                                className="inspector-textarea"
                                value={selectedNode.data.task}
                                onChange={(event) => updateNode(selectedNode.id, { task: event.target.value })}
                                placeholder="Décris la tâche que cet agent doit exécuter dans la chaîne…"
                                maxLength={6000}
                            />
                            <button
                                type="button"
                                className={`entry-toggle${entrySessionId === selectedNode.id ? ' active' : ''}`}
                                onClick={() => chooseEntry(selectedNode.id)}
                            >
                                {entrySessionId === selectedNode.id
                                    ? (entryIsExplicit ? 'Point d’entrée personnalisé' : 'Entrée recommandée · Devin')
                                    : 'Définir comme point d’entrée'}
                            </button>
                            <div className="inspector-session">Session : <code>{selectedNode.data.sessionId}</code></div>
                        </>
                    ) : (
                        <div className="inspector-empty">
                            <span className="inspector-kicker">ÉQUIPE</span>
                            <h2>{entryNode ? 'Chaîne prête à configurer' : 'Choisis un agent d’entrée'}</h2>
                            <p>{entryNode ? `Entrée par défaut : ${entryNode.data.role} (${entryNode.data.provider}).` : 'Crée un chat Devin; Antigravity est proposé si tu préfères.'}</p>
                            <div className="agent-roster-list">
                                {nodes.map((node) => (
                                    <button type="button" className="agent-roster-item" key={node.id} onClick={() => setSelectedId(node.id)}>
                                        <span className={`roster-dot ${node.data.tone}`} />
                                        <span><strong>{node.data.role}</strong><small>{node.data.provider} · {node.data.model}</small></span>
                                        <span className="roster-status">{progress[node.id]?.state || 'prêt'}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {completedCount > 0 && <div className="run-summary">{completedCount} étape{completedCount > 1 ? 's' : ''} terminée{completedCount > 1 ? 's' : ''} dans cette exécution.</div>}
                </aside>
            </div>
        </main>
    );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Workspace />);
