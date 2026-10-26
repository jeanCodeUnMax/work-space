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
    SelectionMode,
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
    skills?: string[];
    external?: boolean;
    onSkillDrop?: (skill: string) => void;
    isEntry: boolean;
    tone: 'amber' | 'blue' | 'green';
}

type AgentNode = Node<AgentData, 'agent'>;

interface StoredNode {
    title?: string;
    sessionId: string;
    role: string;
    task: string;
    skills?: string[];
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

interface WorkflowCatalog {
    roles: string[];
    skills: string[];
    providers: { id: string; label: string }[];
}

interface WorkflowView {
    graph: WorkflowGraph;
    nodes: AgentNode[];
    edges: Edge[];
    entrySessionId: string | null;
    catalog?: WorkflowCatalog;
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
        <div
            className={'flow-node ' + data.tone + (selected ? ' selected' : '')}
            onDragOver={(event) => {
                if (event.dataTransfer.types.includes('application/x-hph-skill')) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                }
            }}
            onDrop={(event) => {
                const skill = event.dataTransfer.getData('application/x-hph-skill');
                if (!skill) return;
                event.preventDefault();
                event.stopPropagation();
                data.onSkillDrop?.(skill);
            }}
        >
            <Handle type="target" position={Position.Left} />
            <div className="flow-node-heading">
                <span className="flow-node-kicker">{data.isEntry ? 'ENTRÉE' : (data.external ? 'SESSION ACP' : 'AGENT')}</span>
                <span className="flow-node-provider">{data.provider}</span>
            </div>
            {(()=>{let h=0;for(const c of (data.sessionId||""))h=(h*31+c.charCodeAt(0))>>>0;const base=(window as any).__agentsUri;const src=base?base+"/p"+(1+h%6)+"-c"+String(h%16).padStart(2,"0")+".png":"";return src?<img src={src} style={{width:22,height:22,borderRadius:5,objectFit:"cover",marginRight:6,verticalAlign:"middle"}}/>:null;})()}<strong className="flow-node-title">{data.title}</strong>
            <span className="flow-node-model">{data.model}</span>
            {(!data.external || (data.role !== 'Devin' && data.role !== 'Antigravity')) && <span className="flow-node-role">{data.role}</span>}
            {(data.skills || []).length > 0 && (
                <div className="flow-node-skills">
                    {(data.skills || []).map((skill) => <span className="flow-node-skill" key={skill}>{skill}</span>)}
                </div>
            )}
            <Handle type="source" position={Position.Right} />
        </div>
    );
}

const nodeTypes = { agent: AgentNodeCard };

interface WorkspaceErrorState {
    error?: string;
}

class WorkspaceErrorBoundary extends React.Component<{ children: React.ReactNode }, WorkspaceErrorState> {
    state: WorkspaceErrorState = {};

    static getDerivedStateFromError(error: unknown): WorkspaceErrorState {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    componentDidCatch(error: Error): void {
        console.error('[Hephaistos Flow] render failed', error);
    }

    render(): React.ReactNode {
        if (this.state.error) {
            return (
                <div className="workspace-fatal" role="alert">
                    <strong>Le canvas React Flow n’a pas pu démarrer.</strong>
                    <pre>{this.state.error}</pre>
                </div>
            );
        }
        return this.props.children;
    }
}

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
            title: node.data.title,
            role: node.data.role,
            task: node.data.task,
            skills: node.data.skills || [],
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
    const [skillQuery, setSkillQuery] = useState('');
    const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
    const [schemasCollapsed, setSchemasCollapsed] = useState(true);
    const [schemas, setSchemas] = useState<Array<{ id: string; name: string; workspace: string; savedAt: string; nodes: number }>>([]);
    const [showAllSchemas, setShowAllSchemas] = useState(false);
    const [schemaName, setSchemaName] = useState('');
    const [progress, setProgress] = useState<Record<string, Progress>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [runSummary, setRunSummary] = useState('');
    const [catalog, setCatalog] = useState<WorkflowCatalog>({ roles: [], skills: [], providers: [] });
    const [newProvider, setNewProvider] = useState('openrouter');
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
            if (message?.type === 'schemas_state') {
                setSchemas(message.schemas || []);
                return;
            }
            if (message?.type === 'workflow_state') {
                vscode.postMessage({ type: 'schemas_list', all: showAllSchemas });
                const view = message.workflow as WorkflowView;
                setNodes((current) => {
                    const byId = new Map(current.map((n) => [n.id, n]));
                    return view.nodes.map((node) => {
                        const prev = byId.get(node.id);
                        return {
                            ...node,
                            selected: prev?.selected ?? node.selected,
                            dragging: prev?.dragging ?? node.dragging,
                            position: prev?.position || node.position,
                            data: { ...node.data, onSkillDrop: (skill: string) => assignSkill(node.id, skill) },
                        };
                    });
                });
                setEdges(view.edges.map(e=>({ ...e, interactionWidth: 1, selectable: false })));
                setWorkflowName(view.graph.name);
                setEntrySessionId(view.entrySessionId);
                setEntryIsExplicit(!!view.graph.entrySessionId);
                setCatalog(view.catalog || { roles: [], skills: [], providers: [] });
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

    const stateRef = useRef({ nodes, edges, entrySessionId, workflowName, entryIsExplicit });
    stateRef.current = { nodes, edges, entrySessionId, workflowName, entryIsExplicit };

    const assignSkill = useCallback((id: string, skill: string) => {
        setNodes((current) => {
            const next = current.map((n) => n.id === id
                ? { ...n, data: { ...n.data, skills: [...new Set([...(n.data.skills || []), skill])] } }
                : n);
            const s = stateRef.current;
            vscode.postMessage({
                type: 'workflow_change',
                graph: toStoredGraph(next, s.edges, s.workflowName, s.entrySessionId, s.entryIsExplicit),
            });
            return next;
        });
    }, [setNodes]);

    const onConnect = useCallback((connection: Connection) => {
        const nextEdges = addEdge({ ...connection, type: 'smoothstep', interactionWidth: 1, selectable: false }, edges);
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

    const hideFromWorkflow = (): void => {
        if (!selectedId) return;
        vscode.postMessage({ type: 'hide_agent', sessionId: selectedId });
        setSelectedId(null);
    };

    const refreshSchemas = (all: boolean): void => {
        vscode.postMessage({ type: 'schemas_list', all });
    };
    const saveSchema = (): void => {
        vscode.postMessage({ type: 'schema_save', name: schemaName.trim() || 'Schema', all: showAllSchemas });
        setSchemaName('');
    };
    const loadSchema = (id: string): void => {
        vscode.postMessage({ type: 'schema_load', id });
    };
    const openSchemas = (): void => {
        setSchemasCollapsed(false);
        refreshSchemas(showAllSchemas);
    };
    const toggleAllSchemas = (checked: boolean): void => {
        setShowAllSchemas(checked);
        refreshSchemas(checked);
    };

    const addAgent = (): void => {
        vscode.postMessage({ type: 'add_agent', provider: newProvider });
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
                    {selectedEdgeId && <button type="button" className="remove-edge" onClick={removeSelectedEdge}>Retirer le lien</button>}
                    <select
                        className="add-agent-provider"
                        title="Provider du nouvel agent"
                        value={newProvider}
                        onChange={(event) => setNewProvider(event.target.value)}
                    >
                        {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                    </select>
                    <button type="button" className="add-agent" onClick={addAgent}>+ Agent</button>
                    
                </div>
            </header>
            <div className="workspace-content">
                {schemasCollapsed ? (
                    <button
                        type="button"
                        className="panel-tab panel-tab-left"
                        title="Schémas"
                        onClick={openSchemas}
                    >◈</button>
                ) : (
                    <aside className="schemas-panel">
                        <div className="schemas-head">
                            <span className="inspector-kicker">SCHÉMAS</span>
                            <button
                                type="button"
                                className="panel-collapse"
                                title="Replier"
                                onClick={() => setSchemasCollapsed(true)}
                            >◂</button>
                        </div>
                        <input
                            className="skill-filter"
                            type="text"
                            placeholder="Nom du schéma"
                            value={schemaName}
                            onChange={(event) => setSchemaName(event.target.value)}
                        />
                        <button type="button" className="schema-save" onClick={saveSchema}>
                            Sauvegarder le schéma
                        </button>
                        <label className="schema-all">
                            <input
                                type="checkbox"
                                checked={showAllSchemas}
                                onChange={(event) => toggleAllSchemas(event.target.checked)}
                            />
                            {' '}Tous les workspaces
                        </label>
                        <div className="schema-list">
                            {schemas.length === 0 && <span className="skill-empty">Aucun schéma enregistré.</span>}
                            {schemas.map((schema) => (
                                <div className="schema-item" key={schema.id}>
                                    <button
                                        type="button"
                                        className="schema-load"
                                        title={schema.workspace}
                                        onClick={() => loadSchema(schema.id)}
                                    >{schema.name}</button>
                                    <span className="schema-meta">
                                        {schema.nodes} nœuds{showAllSchemas ? ' · ' + schema.workspace.split(/[\\/]/).pop() : ''}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </aside>
                )}
                <section className="flow-canvas" aria-label="Éditeur visuel React Flow">
                    {nodes.length === 0 ? (
                        <div className="canvas-empty">
                            <span className="empty-kicker">ROSTER DU WORKSPACE</span>
                            <h2>Aucun agent actif à afficher</h2>
                            <p>Les Bleubites du roster Hephaistos apparaîtront ici. Crée un chat depuis la fenêtre Chats ou ajoute une session au roster : son bloc sera synchronisé automatiquement.</p>
                        </div>
                    ) : (
                        <>
                            <ReactFlow
                                selectionOnDrag
                                panOnDrag={[2]}
                                selectionMode={SelectionMode.Partial}
                                selectNodesOnDrag
                                elementsSelectable
                                edgesFocusable={false}
                                nodes={nodes}
                                edges={edges}
                                nodeTypes={nodeTypes}
                                onNodesChange={onNodesChange}
                                onEdgesChange={onEdgeChanges}
                                onConnect={onConnect}
                                onNodeClick={(_event, node) => setSelectedId(node.id)}
                                onNodeDoubleClick={(_event, node) => vscode.postMessage({ type: 'open_agent', sessionId: node.id })}
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
                <aside className={inspectorCollapsed ? 'node-inspector collapsed' : 'node-inspector'}>
                    {!inspectorCollapsed && (
                    <button
                        type="button"
                        className="panel-collapse inspector-collapse"
                        title="Replier le panneau"
                        onClick={() => setInspectorCollapsed(true)}
                    >▸</button>
                    )}
                    {selectedNode ? (
                        <>
                            <div className="inspector-header">
                                <span className="inspector-kicker">CONFIGURATION AGENT</span>
                                <button
                                    type="button"
                                    className="schema-hide-btn"
                                    title="Retire le bloc du schéma — l'agent reste dans l'équipe"
                                    onClick={hideFromWorkflow}
                                >
                                    Retirer du schéma
                                </button>
                            </div>
                            <h2 style={{display:"flex",alignItems:"center",gap:8}}>{(()=>{let h=0;for(const c of (selectedNode.data.sessionId||""))h=(h*31+c.charCodeAt(0))>>>0;const base=(window as any).__agentsUri;const src=base?base+"/p"+(1+h%6)+"-c"+String(h%16).padStart(2,"0")+".png":"";return src?<img src={src} style={{width:32,height:32,borderRadius:7,objectFit:"cover",flexShrink:0}}/>:null;})()}<span>{selectedNode.data.title}</span></h2>
                            <p className="inspector-provider">{selectedNode.data.provider} · {selectedNode.data.model}</p>
                            <label className="field-label" htmlFor="agent-role">Rôle</label>
                            <select
                                className="inspector-input"
                                title="Rôle prédéfini"
                                value={catalog.roles.includes(selectedNode.data.role) ? selectedNode.data.role : ''}
                                onChange={(event) => { if (event.target.value) updateNode(selectedNode.id, { role: event.target.value }); }}
                            >
                                <option value="">— preset —</option>
                                {catalog.roles.map((role) => <option key={role} value={role}>{role}</option>)}
                            </select>
                            <input
                                id="agent-role"
                                className="inspector-input"
                                value={selectedNode.data.role}
                                onChange={(event) => updateNode(selectedNode.id, { role: event.target.value })}
                                maxLength={120}
                            />
                            <label className="field-label">Compétences assignées</label>
                            <div className="skill-list">
                                {(selectedNode.data.skills || []).length === 0 && <span className="skill-empty">Glisse des puces depuis la palette.</span>}
                                {(selectedNode.data.skills || []).map((skill) => (
                                    <button
                                        type="button"
                                        key={skill}
                                        className="skill-chip active"
                                        title="Retirer cette compétence"
                                        onClick={() => updateNode(selectedNode.id, {
                                            skills: (selectedNode.data.skills || []).filter((item) => item !== skill),
                                        })}
                                    >{skill} ×</button>
                                ))}
                            </div>
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
                    <div className="skill-palette">
                        <input
                            className="skill-filter"
                            type="text"
                            placeholder="Filtrer les competences..."
                            value={skillQuery}
                            onChange={(event) => setSkillQuery(event.target.value)}
                        />
                        <span className="inspector-kicker">COMPETENCES — glisser sur un agent</span>
                        <div className="skill-palette-list">
                            {catalog.skills.length === 0 && <span className="skill-empty">Aucun skill dans .agent/skills</span>}
                            {catalog.skills.filter((skill) => !skillQuery || skill.toLowerCase().includes(skillQuery.toLowerCase())).map((skill) => (
                                <span
                                    key={skill}
                                    className="skill-chip draggable"
                                    draggable
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData('application/x-hph-skill', skill);
                                        event.dataTransfer.effectAllowed = 'copy';
                                    }}
                                >{skill}</span>
                            ))}
                        </div>
                    </div>
                </aside>
                {inspectorCollapsed && (
                    <button
                        type="button"
                        className="panel-tab panel-tab-right"
                        title="Configuration"
                        onClick={() => setInspectorCollapsed(false)}
                    >⚙</button>
                )}
            </div>
        </main>
    );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<WorkspaceErrorBoundary><Workspace /></WorkspaceErrorBoundary>);
