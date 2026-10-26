import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    addEdge,
    applyNodeChanges,
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
    type OnNodesChange,
    type OnEdgesChange,
    type ReactFlowInstance,
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
    /** Re-rendu des blocs quand le thème d'icônes change (window.__agentsUri rebasé). */
    iconTheme?: string;
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
    sourceHandle?: string | null;
    targetHandle?: string | null;
}

interface WorkflowGraph {
    version: 1;
    name: string;
    activeSchema?: string;
    activeSchemaId?: string;
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

// Miroir de ICON_THEMES (src/types.ts) — sous-dossiers de media/agents/.
const ICON_THEMES = ['commando', 'dwarves', 'starwars', 'scifi-horror', 'hightech'];

/** Hash stable du sessionId → index dans la liste d'icônes du thème. */
function agentIconHash(sessionId: string): number {
    let h = 0;
    for (const c of (sessionId || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
}

/**
 * Les thèmes nomment leurs PNG différemment (commando = pX-cYY, dwarves =
 * icon-NN) : l'host injecte la liste des fichiers (__agentIcons) et le webview
 * pioche par hash % count. Sans liste → convention historique pX-cYY.
 */
function iconUrl(base: string | undefined, files: string[] | undefined, h: number): string {
    if (!base) return '';
    const name = files && files.length
        ? files[h % files.length]
        : 'p' + (1 + h % 6) + '-c' + String(h % 16).padStart(2, '0') + '.png';
    return base + '/' + name;
}

/** URI de l'icône du sessionId dans le thème courant + équivalent commando en secours. */
function agentIcon(sessionId: string): { src: string; fbk: string } {
    const h = agentIconHash(sessionId);
    const w = window as any;
    return {
        src: iconUrl(w.__agentsUri, w.__agentIcons, h),
        fbk: iconUrl(w.__agentsFallbackUri, w.__agentsFallbackIcons, h),
    };
}

/** Fallback : icône absente du thème → équivalent commando (data-fbk), sinon masquée. */
function onAgentIconError(event: React.SyntheticEvent<HTMLImageElement>): void {
    const img = event.currentTarget;
    const fbk = img.dataset.fbk;
    if (fbk && img.src !== fbk) {
        img.src = fbk;
        return;
    }
    img.style.display = 'none';
}

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
            <Handle type="target" position={Position.Left} id="target-left" title="Entrée latérale" />
            <Handle type="target" position={Position.Top} id="target-top" title="Entrée haute" />
            <div className="flow-node-heading">
                <span className="flow-node-kicker">{data.isEntry ? 'ENTRÉE' : (data.external ? 'SESSION ACP' : 'AGENT')}</span>
                <span className="flow-node-provider">{data.provider}</span>
            </div>
            {(()=>{const icon=agentIcon(data.sessionId);return icon.src?<img src={icon.src} data-fbk={icon.fbk} onError={onAgentIconError} style={{width:22,height:22,borderRadius:5,objectFit:"cover",marginRight:6,verticalAlign:"middle"}}/>:null;})()}<strong className="flow-node-title">{data.title}</strong>
            <span className="flow-node-model">{data.model}</span>
            {(!data.external || (data.role !== 'Devin' && data.role !== 'Antigravity')) && <span className="flow-node-role">{data.role}</span>}
            {(data.skills || []).length > 0 && (
                <div className="flow-node-skills">
                    {(data.skills || []).map((skill) => <span className="flow-node-skill" key={skill}>{skill}</span>)}
                </div>
            )}
            <Handle type="source" position={Position.Right} id="source-right" title="Sortie latérale" />
            <Handle type="source" position={Position.Bottom} id="source-bottom" title="Sortie basse" />
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
    activeSchema?: string,
    activeSchemaId?: string,
): WorkflowGraph {
    const graph: WorkflowGraph = {
        version: 1,
        name,
        entrySessionId: entryIsExplicit ? entrySessionId : null,
        nodes: nodes.map((node) => ({
            sessionId: node.id,
            title: node.data.title,
            role: node.data.role,
            task: node.data.task,
            skills: node.data.skills || [],
            position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        })),
        edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({
            id,
            source,
            target,
            ...(sourceHandle ? { sourceHandle } : {}),
            ...(targetHandle ? { targetHandle } : {}),
        })),
    };
    if (activeSchema) graph.activeSchema = activeSchema;
    if (activeSchemaId) graph.activeSchemaId = activeSchemaId;
    return graph;
}

function Workspace(): React.JSX.Element {
    const [nodes, setNodes] = useNodesState<AgentNode>([]);
    const schemaLoadPending = useRef(true);
    const reactFlowRef = useRef<ReactFlowInstance<AgentNode, Edge> | null>(null);
    const [edges, setEdges] = useEdgesState<Edge>([]);
    const [workflowName, setWorkflowName] = useState('Flux agents');
    const [activeSchema, setActiveSchema] = useState<string | undefined>(undefined);
    const [activeSchemaId, setActiveSchemaId] = useState<string | undefined>(undefined);
    const [entrySessionId, setEntrySessionId] = useState<string | null>(null);
    const [entryIsExplicit, setEntryIsExplicit] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [skillQuery, setSkillQuery] = useState('');
    const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
    const [schemasCollapsed, setSchemasCollapsed] = useState(true);
    const [schemas, setSchemas] = useState<Array<{ id: string; name: string; workspace: string; savedAt: string; nodes: number; desc?: string; builtin?: boolean }>>([]);
    const [showAllSchemas, setShowAllSchemas] = useState(false);
    const [schemaName, setSchemaName] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [progress, setProgress] = useState<Record<string, Progress>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [runSummary, setRunSummary] = useState('');
    const [catalog, setCatalog] = useState<WorkflowCatalog>({ roles: [], skills: [], providers: [] });
    const [newProvider, setNewProvider] = useState('openrouter');
    const [iconTheme, setIconTheme] = useState('commando');
    const saveTimer = useRef<number | undefined>(undefined);
    const deleteTimer = useRef<number | undefined>(undefined);

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
            if (message?.type === 'icon_theme') {
                // Rebascule des URI media/agents/<theme>/ poussée par l'host —
                // le theme est propagé dans data pour forcer le re-rendu des blocs.
                const theme = String(message.theme || 'commando');
                if (message.agentsUri) (window as any).__agentsUri = message.agentsUri;
                if (message.fallbackUri) (window as any).__agentsFallbackUri = message.fallbackUri;
                if (Array.isArray(message.iconFiles)) (window as any).__agentIcons = message.iconFiles;
                if (Array.isArray(message.fallbackFiles)) (window as any).__agentsFallbackIcons = message.fallbackFiles;
                setIconTheme(theme);
                setNodes((current) => current.map((n) => ({ ...n, data: { ...n.data, iconTheme: theme } })));
                return;
            }
            if (message?.type === 'workflow_state') {
                vscode.postMessage({ type: 'schemas_list', all: showAllSchemas });
                const view = message.workflow as WorkflowView;
                const shouldFitView = schemaLoadPending.current;
                schemaLoadPending.current = false;
                setNodes((current) => {
                    const byId = new Map(current.map((n) => [n.id, n]));
                    return view.nodes.map((node) => {
                        const prev = byId.get(node.id);
                        return {
                            ...node,
                            selected: prev?.selected ?? node.selected,
                            dragging: prev?.dragging ?? node.dragging,
                            position: prev?.dragging ? prev.position : node.position,
                            data: { ...node.data, onSkillDrop: (skill: string) => assignSkill(node.id, skill) },
                        };
                    });
                });
                setEdges(view.edges.map(e=>({ ...e, interactionWidth: 1, selectable: false })));
                setWorkflowName(view.graph.name);
                setActiveSchema(view.graph.activeSchema);
                setActiveSchemaId(view.graph.activeSchemaId);
                setEntrySessionId(view.entrySessionId);
                setEntryIsExplicit(!!view.graph.entrySessionId);
                setCatalog(view.catalog || { roles: [], skills: [], providers: [] });
                setSelectedId((current) => view.nodes.some((node) => node.id === current) ? current : null);
                if (shouldFitView) {
                    window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                            void reactFlowRef.current?.fitView({ padding: 0.24, maxZoom: 0.85 });
                        });
                    });
                }
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

    const stateRef = useRef({ nodes, edges, entrySessionId, workflowName, entryIsExplicit, activeSchema, activeSchemaId });
    stateRef.current = { nodes, edges, entrySessionId, workflowName, entryIsExplicit, activeSchema, activeSchemaId };

    const postWorkflowSave = useCallback((
        nextNodes: AgentNode[],
        nextEdges: Edge[],
        nextEntry: string | null,
        nextName: string,
        nextEntryIsExplicit: boolean,
    ) => {
        const s = stateRef.current;
        vscode.postMessage({
            type: 'workflow_change',
            graph: toStoredGraph(nextNodes, nextEdges, nextName, nextEntry, nextEntryIsExplicit, s.activeSchema, s.activeSchemaId),
        });
    }, []);

    const sendSave = useCallback((
        nextNodes: AgentNode[] = nodes,
        nextEdges: Edge[] = edges,
        nextEntry: string | null = entrySessionId,
        nextName = workflowName,
        nextEntryIsExplicit = entryIsExplicit,
    ) => {
        if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
            saveTimer.current = undefined;
            postWorkflowSave(nextNodes, nextEdges, nextEntry, nextName, nextEntryIsExplicit);
        }, 300);
    }, [edges, entryIsExplicit, entrySessionId, nodes, postWorkflowSave, workflowName]);

    const flushSave = useCallback(() => {
        if (saveTimer.current !== undefined) {
            window.clearTimeout(saveTimer.current);
            saveTimer.current = undefined;
        }
        const current = stateRef.current;
        if (!current.nodes.length) return;
        postWorkflowSave(
            current.nodes,
            current.edges,
            current.entrySessionId,
            current.workflowName,
            current.entryIsExplicit,
        );
    }, [postWorkflowSave]);

    useEffect(() => {
        const persistBeforeExit = (): void => {
            if (saveTimer.current !== undefined) flushSave();
        };
        window.addEventListener('beforeunload', persistBeforeExit);
        window.addEventListener('pagehide', persistBeforeExit);
        return () => {
            window.removeEventListener('beforeunload', persistBeforeExit);
            window.removeEventListener('pagehide', persistBeforeExit);
        };
    }, [flushSave]);

    const onWorkflowNodesChange: OnNodesChange<AgentNode> = useCallback((changes) => {
        setNodes((current) => {
            const nextNodes = applyNodeChanges(changes, current) as AgentNode[];
            const state = stateRef.current;
            stateRef.current = { ...state, nodes: nextNodes };
            const hasPositionEnd = changes.some(
                (change) => change.type === 'position' && change.dragging === false && change.position != null,
            );
            if (hasPositionEnd) {
                if (saveTimer.current !== undefined) {
                    window.clearTimeout(saveTimer.current);
                    saveTimer.current = undefined;
                }
                postWorkflowSave(nextNodes, state.edges, state.entrySessionId, state.workflowName, state.entryIsExplicit);
            }
            return nextNodes;
        });
    }, [postWorkflowSave, setNodes]);

    const assignSkill = useCallback((id: string, skill: string) => {
        setNodes((current) => {
            const next = current.map((n) => n.id === id
                ? { ...n, data: { ...n.data, skills: [...new Set([...(n.data.skills || []), skill])] } }
                : n);
            const s = stateRef.current;
            stateRef.current = { ...s, nodes: next };
            postWorkflowSave(next, s.edges, s.entrySessionId, s.workflowName, s.entryIsExplicit);
            return next;
        });
    }, [postWorkflowSave, setNodes]);

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
        setNodes((current) => {
            const nextNodes = current.map((node) => node.id === moved.id ? moved : node);
            const state = stateRef.current;
            stateRef.current = { ...state, nodes: nextNodes };
            // Une sortie de workspace peut arriver avant le debounce de 300 ms.
            // Le dernier déplacement est donc écrit immédiatement.
            if (saveTimer.current !== undefined) {
                window.clearTimeout(saveTimer.current);
                saveTimer.current = undefined;
            }
            postWorkflowSave(nextNodes, state.edges, state.entrySessionId, state.workflowName, state.entryIsExplicit);
            return nextNodes;
        });
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
        const s = stateRef.current;
        const targetName = schemaName.trim() || s.activeSchema || s.workflowName.trim() || 'Schema';
        if (saveTimer.current !== undefined) {
            window.clearTimeout(saveTimer.current);
            saveTimer.current = undefined;
        }
        vscode.postMessage({
            type: 'schema_save',
            name: targetName,
            all: showAllSchemas,
            graph: toStoredGraph(s.nodes, s.edges, targetName, s.entrySessionId, s.entryIsExplicit, s.activeSchema, s.activeSchemaId),
        });
        setSchemaName('');
    };
    const loadSchema = (id: string): void => {
        if (saveTimer.current !== undefined) {
            flushSave();
        }
        schemaLoadPending.current = true;
        vscode.postMessage({ type: 'schema_load', id });
    };
    const createSchema = (): void => {
        if (saveTimer.current !== undefined) {
            flushSave();
        }
        schemaLoadPending.current = true;
        vscode.postMessage({
            type: 'schema_create',
            name: schemaName.trim() || 'Nouveau schema',
            all: showAllSchemas,
        });
        setSchemaName('');
    };
    const restoreStandards = (): void => {
        vscode.postMessage({ type: 'schemas_restore', all: showAllSchemas });
    };
    const requestDeleteSchema = (id: string): void => {
        if (confirmDeleteId === id) {
            setConfirmDeleteId(null);
            if (deleteTimer.current !== undefined) {
                window.clearTimeout(deleteTimer.current);
                deleteTimer.current = undefined;
            }
            vscode.postMessage({ type: 'schema_delete', id, all: showAllSchemas });
            return;
        }
        setConfirmDeleteId(id);
        if (deleteTimer.current !== undefined) window.clearTimeout(deleteTimer.current);
        deleteTimer.current = window.setTimeout(() => {
            setConfirmDeleteId(null);
            deleteTimer.current = undefined;
        }, 5000);
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
                        <button
                            type="button"
                            className="schema-create"
                            title="Crée un flux de travail vide et l'ouvre pour édition"
                            onClick={createSchema}
                        >
                            + Créer un schéma vide
                        </button>
                        <button type="button" className="schema-save" onClick={saveSchema}>
                            Sauvegarder le schéma
                        </button>
                        <button
                            type="button"
                            className="schema-restore"
                            title="Réinstalle les schémas standards du kit (swat-*) s'ils ont été supprimés"
                            onClick={restoreStandards}
                        >
                            Restaurer les standards
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
                                    <div className="schema-row">
                                        <button
                                            type="button"
                                            className={"schema-load" + (schema.builtin ? " schema-load-builtin" : "")}
                                            title={schema.desc || schema.name}
                                            onClick={() => loadSchema(schema.id)}
                                        >
                                            {schema.builtin && (
                                                <span className="schema-builtin-badge" title="Schéma standard livré avec le kit Hephaistos — restaurable après suppression">★</span>
                                            )}
                                            {schema.name}
                                        </button>
                                        <button
                                            type="button"
                                            className={"schema-delete" + (confirmDeleteId === schema.id ? " schema-delete-confirm" : "")}
                                            title={confirmDeleteId === schema.id ? "Cliquer à nouveau pour confirmer la suppression" : "Supprimer ce schéma"}
                                            aria-label={"Supprimer " + schema.name}
                                            onClick={() => requestDeleteSchema(schema.id)}
                                        >
                                            {confirmDeleteId === schema.id ? "OK ?" : (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                                                    <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M9 2h6a1 1 0 0 1 1 1v1h5v2h-2l-.9 15.1A2 2 0 0 1 16.1 23H7.9a2 2 0 0 1-2-1.9L5 6H3V4h5V3a1 1 0 0 1 1-1Zm1 7.5h1.5v8H10v-8Zm3 0h1.5v8H13v-8Z"/>
                                                </svg>
                                            )}
                                        </button>
                                    </div>
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
                                onInit={(instance) => { reactFlowRef.current = instance; }}
                                selectionOnDrag
                                panOnDrag={[2]}
                                selectionMode={SelectionMode.Partial}
                                selectNodesOnDrag
                                elementsSelectable
                                edgesFocusable={false}
                                nodes={nodes}
                                edges={edges}
                                nodeTypes={nodeTypes}
                                onNodesChange={onWorkflowNodesChange}
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
                                onDragOver={(event) => {
                                    if (event.dataTransfer.types.includes('application/x-hph-role')) {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = 'copy';
                                    }
                                }}
                                onDrop={(event) => {
                                    const role = event.dataTransfer.getData('application/x-hph-role');
                                    if (!role) return;
                                    event.preventDefault();
                                    vscode.postMessage({ type: 'add_agent', provider: newProvider, role });
                                }}
                                fitView
                                fitViewOptions={{ padding: 0.24, maxZoom: 0.85 }}
                                snapToGrid
                                snapGrid={[22, 22]}
                                minZoom={0.2}
                                maxZoom={2}
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
                            <h2 style={{display:"flex",alignItems:"center",gap:8}}>{(()=>{const icon=agentIcon(selectedNode.data.sessionId);return icon.src?<img src={icon.src} data-fbk={icon.fbk} onError={onAgentIconError} style={{width:32,height:32,borderRadius:7,objectFit:"cover",flexShrink:0}}/>:null;})()}<span>{selectedNode.data.title}</span></h2>
                            <p className="inspector-provider">{selectedNode.data.provider} · {selectedNode.data.model}</p>
                            <label className="field-label" htmlFor="icon-theme">Thème d'icônes</label>
                            <select
                                id="icon-theme"
                                className="inspector-input"
                                title="Jeu d'icônes des agents (media/agents/<thème>)"
                                value={iconTheme}
                                onChange={(event) => {
                                    setIconTheme(event.target.value);
                                    vscode.postMessage({ type: 'set_icon_theme', theme: event.target.value });
                                }}
                            >
                                {ICON_THEMES.map((theme) => <option key={theme} value={theme}>{theme}</option>)}
                            </select>
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
                    <div className="skill-palette role-palette">
                        <span className="inspector-kicker">RÔLES — glisser sur le canvas pour créer un agent</span>
                        <div className="skill-palette-list">
                            {catalog.roles.map((role) => (
                                <span
                                    key={role}
                                    className="skill-chip draggable role-chip"
                                    draggable
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData('application/x-hph-role', role);
                                        event.dataTransfer.effectAllowed = 'copy';
                                    }}
                                >{role}</span>
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
