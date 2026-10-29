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
    mcps?: string[];
    external?: boolean;
    onSkillDrop?: (skill: string) => void;
    onMcpDrop?: (mcp: string) => void;
    onAgentDrop?: (agent: PaletteAgent) => void;
    onRoleDrop?: (role: string) => void;
    onPoint?: () => void;
    onBind?: () => void;
    /** Re-rendu des blocs quand le thème d'icônes change (window.__agentsUri rebasé). */
    iconTheme?: string;
    isEntry: boolean;
    bound?: { at: number; kind: string };
    tone: 'amber' | 'blue' | 'green';
}

type AgentNode = Node<AgentData, 'agent'>;

interface StoredNode {
    title?: string;
    sessionId: string;
    role: string;
    task: string;
    skills?: string[];
    mcps?: string[];
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
    mode?: 'council';
}

interface PaletteAgent {
    sessionId: string;
    title: string;
    role: string;
    provider: string;
    model?: string;
    referent?: boolean;
    placed?: boolean;
}

interface WorkflowCatalog {
    roles: string[];
    skills: string[];
    mcps?: string[];
    providers: { id: string; label: string }[];
    agents?: PaletteAgent[];
    cards?: PaletteCard[];
}

interface PaletteCard {
    id: string;
    kind: 'devin' | 'agy' | 'bleubite';
    title: string;
    role: string;
    provider: string;
    sessionId?: string;
    skills?: string[];
    mcps?: string[];
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
                if (event.dataTransfer.types.includes('application/x-hph-skill')
                    || event.dataTransfer.types.includes('application/x-hph-agent')
                    || event.dataTransfer.types.includes('application/x-hph-mcp')
                    || event.dataTransfer.types.includes('application/x-hph-role')) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                }
            }}
            onDrop={(event) => {
                const mcp = event.dataTransfer.getData('application/x-hph-mcp');
                if (mcp) {
                    event.preventDefault();
                    event.stopPropagation();
                    data.onMcpDrop?.(mcp);
                    return;
                }
                const role = event.dataTransfer.getData('application/x-hph-role');
                if (role) {
                    event.preventDefault();
                    event.stopPropagation();
                    data.onRoleDrop?.(role);
                    return;
                }
                const agentRaw = event.dataTransfer.getData('application/x-hph-agent');
                if (agentRaw) {
                    event.preventDefault();
                    event.stopPropagation();
                    try { data.onAgentDrop?.(JSON.parse(agentRaw)); } catch { /* payload invalide */ }
                    return;
                }
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
                <button
                    type="button"
                    className="flow-node-point"
                    title={`Pointer ${data.title} vers l'agent référent`}
                    onClick={(event) => { event.stopPropagation(); data.onPoint?.(); }}
                >⌖</button>
                <button
                    type="button"
                    className="flow-node-point"
                    title="Prendre la fenêtre active et l'attacher à ce bloc"
                    onClick={(event) => { event.stopPropagation(); data.onBind?.(); }}
                >⤓</button>
            </div>
            {(()=>{const icon=agentIcon(data.sessionId);return icon.src?<img src={icon.src} data-fbk={icon.fbk} onError={onAgentIconError} style={{width:22,height:22,borderRadius:5,objectFit:"cover",marginRight:6,verticalAlign:"middle"}}/>:null;})()}<strong className="flow-node-title">{data.title}</strong>
            <span className="flow-node-model">{data.model}</span>
            {data.bound && <span className="flow-node-bound" title={`Carte associée à une fenêtre ${data.bound.kind === 'agy' ? 'Antigravity' : 'Devin'}`}>● associée</span>}
            {(!data.external || (data.role !== 'Devin' && data.role !== 'Antigravity')) && <span className="flow-node-role">{data.role}</span>}
            {((data.skills || []).length + (data.mcps || []).length) > 0 && (
                <div className="flow-node-skills">
                    {(data.skills || []).map((skill) => <span className="flow-node-skill" key={skill}>{skill}</span>)}
                    {(data.mcps || []).map((mcp) => <span className="flow-node-skill flow-node-mcp" key={mcp} title={`MCP: ${mcp}`}>⛁ {mcp}</span>)}
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
            mcps: node.data.mcps || [],
            position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
            bound: node.data.bound,
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
    const [roleQuery, setRoleQuery] = useState('');
    const [mcpQuery, setMcpQuery] = useState('');
    const [agentQuery, setAgentQuery] = useState('');
    const [cardQuery, setCardQuery] = useState('');
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const togglePalette = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
    const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
    const [schemasCollapsed, setSchemasCollapsed] = useState(true);
    const [schemas, setSchemas] = useState<Array<{ id: string; name: string; workspace: string; savedAt: string; nodes: number; desc?: string; builtin?: boolean; mode?: 'council' }>>([]);
    const [showAllSchemas, setShowAllSchemas] = useState(false);
    const [schemaName, setSchemaName] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [progress, setProgress] = useState<Record<string, Progress>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [runSummary, setRunSummary] = useState('');
    const [catalog, setCatalog] = useState<WorkflowCatalog>({ roles: [], skills: [], providers: [] });
    const [pageView, setPageView] = useState<'flow' | 'comfyui' | 'n8n'>('flow');
    // Outils chargés une fois à la 1re ouverture, puis gardés montés (sinon
    // l'iframe est recréée à chaque bascule et la session de l'outil est perdue).
    const [toolLoaded, setToolLoaded] = useState({ comfyui: false, n8n: false });
    const [toolReload, setToolReload] = useState({ comfyui: 0, n8n: 0 });
    const [svcState, setSvcState] = useState<Record<string, 'checking' | 'up' | 'down'>>({});
    const switchPage = (v: 'flow' | 'comfyui' | 'n8n') => {
        setPageView(v);
        if (v !== 'flow' && !toolLoaded[v]) setToolLoaded((s) => ({ ...s, [v]: true }));
        if (v !== 'flow') {
            setSvcState((s) => ({ ...s, [v]: 'checking' }));
            vscode.postMessage({ type: 'ensure_service', service: v });
        }
    };
    const reloadTool = (v: 'flow' | 'comfyui' | 'n8n') => {
        if (v === 'flow') { vscode.postMessage({ type: 'refresh_state' }); return; }
        setSvcState((s) => ({ ...s, [v]: 'checking' }));
        // ⟳ = recharger la VUE : remontage de l'iframe + connexion à
        // l'instance déjà démarrée. Jamais de kill/restart du service.
        setToolReload((s) => ({ ...s, [v]: s[v] + 1 }));
        vscode.postMessage({ type: 'ensure_service', service: v });
    };
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
            if (message?.type === 'service_state') {
                const svc = (message as { service?: string }).service || '';
                const ok = Boolean((message as { ok?: boolean }).ok);
                const checking = Boolean((message as { checking?: boolean }).checking);
                if (checking) { setSvcState((s) => ({ ...s, [svc]: 'checking' })); return; }
                // Remonter l'iframe seulement quand le service revient
                // d'un état non-up : sinon chaque ping détruit la session.
                setSvcState((s) => {
                    const wasUp = s[svc] === 'up';
                    if (ok && !wasUp && (svc === 'comfyui' || svc === 'n8n')) {
                        setToolReload((t) => ({ ...t, [svc]: t[svc] + 1 }));
                    }
                    return { ...s, [svc]: ok ? 'up' : 'down' };
                });
            }
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
                            data: {
                                ...node.data,
                                onSkillDrop: (skill: string) => assignSkill(node.id, skill),
                                onMcpDrop: (mcp: string) => assignMcp(node.id, mcp),
                                onAgentDrop: (agent: PaletteAgent) => {
                                    vscode.postMessage({ type: 'assign_agent', sessionId: node.id, agent });
                                },
                                onRoleDrop: (role: string) => assignRole(node.id, role),
                                onPoint: () => pointAgent(node.id),
                                onBind: () => bindActive(node.id, String(node.data?.provider || '')),
                            },
                        };
                    });
                });
                setEdges(view.edges.map(e=>({ ...e, selectable: true })));
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
                (change) => (change.type === 'position' && change.dragging === false && change.position != null)
                    || change.type === 'remove',
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

    const assignMcp = useCallback((id: string, mcp: string) => {
        setNodes((current) => {
            const next = current.map((n) => n.id === id
                ? { ...n, data: { ...n.data, mcps: [...new Set([...(n.data.mcps || []), mcp])].slice(0, 8) } }
                : n);
            const s = stateRef.current;
            stateRef.current = { ...s, nodes: next };
            postWorkflowSave(next, s.edges, s.entrySessionId, s.workflowName, s.entryIsExplicit);
            return next;
        });
    }, [postWorkflowSave, setNodes]);

    const assignRole = useCallback((id: string, role: string) => {
        setNodes((current) => {
            const next = current.map((n) => n.id === id
                ? { ...n, data: { ...n.data, role } }
                : n);
            const s = stateRef.current;
            stateRef.current = { ...s, nodes: next };
            postWorkflowSave(next, s.edges, s.entrySessionId, s.workflowName, s.entryIsExplicit);
            return next;
        });
    }, [postWorkflowSave, setNodes]);

    const bindActive = useCallback((sessionId: string, provider: string) => {
        const kind = /devin/i.test(provider) ? 'devin' : 'agy';
        vscode.postMessage({ type: 'bind_active', sessionId, kind });
    }, []);
    const pointAgent = useCallback((sessionId: string) => {
        vscode.postMessage({ type: 'point_agent', sessionId });
    }, []);

    const onConnect = useCallback((connection: Connection) => {
        const nextEdges = addEdge({ ...connection, type: 'smoothstep' }, edges);
        setEdges(nextEdges);
        setSelectedEdgeId(null);
        sendSave(nodes, nextEdges);
    }, [edges, nodes, sendSave, setEdges]);

    const onReconnect = useCallback((oldEdge: Edge, connection: Connection) => {
        const nextEdges = addEdge(
            { ...connection, type: 'smoothstep' },
            edges.filter((edge) => edge.id !== oldEdge.id),
        );
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
    const submitRename = (id: string): void => {
        const name = renameValue.trim();
        setRenamingId(null);
        if (name) vscode.postMessage({ type: 'schema_rename', id, name, all: showAllSchemas });
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
                <div className="workspace-tools">
                    <button
                        type="button"
                        className={"tool-page-btn" + (pageView === 'flow' ? " active" : "")}
                        title="Éditeur de flux (React Flow)"
                        onClick={() => switchPage('flow')}
                    >⌘ Flux</button>
                    <button
                        type="button"
                        className={"tool-page-btn" + (pageView === 'comfyui' ? " active" : "")}
                        title={"ComfyUI — génération image/vidéo locale" + (svcState.comfyui === 'checking' ? " (démarrage…)" : svcState.comfyui === 'down' ? " (injoignable)" : "")}
                        onClick={() => switchPage('comfyui')}
                    >◆ ComfyUI{svcState.comfyui === 'checking' ? " ⏳" : svcState.comfyui === 'down' ? " ⛔" : svcState.comfyui === 'up' ? " 🟢" : ""}</button>
                    <button
                        type="button"
                        className={"tool-page-btn" + (pageView === 'n8n' ? " active" : "")}
                        title={"n8n — automatisation de workflows" + (svcState.n8n === 'checking' ? " (démarrage…)" : svcState.n8n === 'down' ? " (injoignable)" : "")}
                        onClick={() => switchPage('n8n')}
                    >⚙ n8n{svcState.n8n === 'checking' ? " ⏳" : svcState.n8n === 'down' ? " ⛔" : svcState.n8n === 'up' ? " 🟢" : ""}</button>
                    <button
                        type="button"
                        className={"tool-page-btn" + (svcState[pageView] === 'checking' ? " tool-loading" : "")}
                        title={"Recharger la page courante" + (svcState[pageView] === 'checking' ? " (démarrage…)" : "")}
                        onClick={() => reloadTool(pageView)}
                    >{svcState[pageView] === 'checking' ? "⏳" : "⟳"}</button>
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
                                        {renamingId === schema.id ? (
                                            <input
                                                className="schema-rename-input"
                                                autoFocus
                                                value={renameValue}
                                                onChange={(event) => setRenameValue(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter') submitRename(schema.id);
                                                    if (event.key === 'Escape') setRenamingId(null);
                                                }}
                                                onBlur={() => submitRename(schema.id)}
                                            />
                                        ) : (
                                        <button
                                            type="button"
                                            className={"schema-load" + (schema.builtin ? " schema-load-builtin" : "")}
                                            title={schema.desc || schema.name}
                                            onClick={() => loadSchema(schema.id)}
                                        >
                                            {schema.builtin && (
                                                <span className="schema-builtin-badge" title="Schéma standard livré avec le kit Hephaistos — restaurable après suppression">★</span>
                                            )}
                                            {schema.mode === 'council' && (
                                                <span className="schema-council-badge" title="Mode concile : les experts délibèrent sur transcript partagé, puis le président rend le verdict">⚖</span>
                                            )}
                                            {schema.name}
                                        </button>
                                        )}
                                        {schema.builtin && renamingId !== schema.id && (
                                        <button
                                            type="button"
                                            className="schema-rename"
                                            title="Promouvoir le canvas actuel comme version officielle de ce standard (gabarit canonique)"
                                            aria-label={"Mettre à jour " + schema.name}
                                            onClick={() => { if (window.confirm(`Écraser le gabarit canonique « ${schema.name} » avec le canvas actuel ? Cette action remplace le schéma standard.`)) vscode.postMessage({ type: 'schema_update_standard', id: schema.id, all: showAllSchemas }); }}
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                                                <path fill="currentColor" d="M12 2.5 15 9l6.7.6-5 4.4 1.5 6.5L12 16.9 5.8 20.5l1.5-6.5-5-4.4L9 9l3-6.5Z"/>
                                            </svg>
                                        </button>
                                        )}
                                        {!schema.builtin && renamingId !== schema.id && (
                                        <button
                                            type="button"
                                            className="schema-rename"
                                            title="Renommer ce schéma"
                                            aria-label={"Renommer " + schema.name}
                                            onClick={() => { setRenamingId(schema.id); setRenameValue(schema.name); }}
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                                                <path fill="currentColor" d="M16.7 3.3a2.6 2.6 0 0 1 3.7 0l.3.3a2.6 2.6 0 0 1 0 3.7l-9.9 9.9-4.6 1 .9-4.7 9.6-9.5Zm2.2 1.5a.9.9 0 0 0-1.3 0l-.7.7 2.2 2.2.7-.7a.9.9 0 0 0 0-1.3l-.9-.9Z"/>
                                            </svg>
                                        </button>
                                        )}
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
                {(pageView === 'comfyui' || toolLoaded.comfyui) && (
                    <iframe
                        key={"comfyui-" + toolReload.comfyui}
                        className={"tool-page" + (pageView !== 'comfyui' ? " tool-page-hidden" : "")}
                        title="ComfyUI"
                        src="http://127.0.0.1:8188"
                    />
                )}
                {(pageView === 'n8n' || toolLoaded.n8n) && (
                    <iframe
                        key={"n8n-" + toolReload.n8n}
                        className={"tool-page" + (pageView !== 'n8n' ? " tool-page-hidden" : "")}
                        title="n8n"
                        src="http://127.0.0.1:5680"
                    />
                )}
                <section className={"flow-canvas" + (pageView !== 'flow' ? " tool-page-hidden" : "")} aria-label="Éditeur visuel React Flow">
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
                                edgesFocusable
                                nodes={nodes}
                                edges={edges}
                                nodeTypes={nodeTypes}
                                onNodesChange={onWorkflowNodesChange}
                                onEdgesChange={onEdgeChanges}
                                onConnect={onConnect}
                                onReconnect={onReconnect}
                                edgesReconnectable
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
                                    if (event.dataTransfer.types.includes('application/x-hph-role')
                                        || event.dataTransfer.types.includes('application/x-hph-agent')
                                        || event.dataTransfer.types.includes('application/x-hph-card')) {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = 'copy';
                                    }
                                }}
                                onDrop={(event) => {
                                    const agentRaw = event.dataTransfer.getData('application/x-hph-agent');
                                    if (agentRaw) {
                                        event.preventDefault();
                                        try {
                                            const agent = JSON.parse(agentRaw) as PaletteAgent;
                                            vscode.postMessage({ type: 'add_agent', provider: agent.provider || newProvider, agent });
                                        } catch { /* payload invalide */ }
                                        return;
                                    }
                                    const cardRaw = event.dataTransfer.getData('application/x-hph-card');
                                    if (cardRaw) {
                                        event.preventDefault();
                                        try { vscode.postMessage({ type: 'add_card', card: JSON.parse(cardRaw) }); } catch { /* carte invalide */ }
                                        return;
                                    }
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
                                deleteKeyCode={['Backspace', 'Delete']}
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
                            <label className="field-label" htmlFor="agent-mcps">Serveurs MCP — noms du broker, séparés par des virgules</label>
                            <input
                                id="agent-mcps"
                                className="inspector-input"
                                value={(selectedNode.data.mcps || []).join(', ')}
                                onChange={(event) => updateNode(selectedNode.id, {
                                    mcps: event.target.value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 8),
                                })}
                                placeholder="vault-pepites, sqlite-node…"
                                maxLength={600}
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
                    {([
                        { key: 'competences', label: 'COMPÉTENCES — glisser sur un agent', query: skillQuery, setQuery: setSkillQuery, placeholder: 'Filtrer les compétences…' },
                        { key: 'roles', label: 'RÔLES — glisser sur un bloc pour l\'éditer, sur le canvas pour créer', query: roleQuery, setQuery: setRoleQuery, placeholder: 'Filtrer les rôles…' },
                        { key: 'agents', label: 'AGENTS — glisser sur un bloc pour l\'éditer, sur le canvas pour l\'ajouter', query: agentQuery, setQuery: setAgentQuery, placeholder: 'Filtrer les agents…' },
                        { key: 'mcps', label: 'MCPS — glisser sur un bloc pour lui donner les outils du serveur', query: mcpQuery, setQuery: setMcpQuery, placeholder: 'Filtrer les serveurs MCP…' },
                        { key: 'cards', label: 'CARTES — glisser sur le canevas pour créer un bloc préconfiguré', query: cardQuery, setQuery: setCardQuery, placeholder: 'Filtrer les cartes…' },
                    ] as const).map((palette) => (
                        <div className={`skill-palette${collapsed[palette.key] ? ' collapsed' : ''}`} key={palette.key}>
                            <button
                                type="button"
                                className="inspector-kicker palette-toggle"
                                onClick={() => togglePalette(palette.key)}
                                title={collapsed[palette.key] ? 'Déployer' : 'Replier'}
                            >{collapsed[palette.key] ? '▸' : '▾'} {palette.label}</button>
                            {!collapsed[palette.key] && (
                                <>
                                    <input
                                        className="skill-filter"
                                        type="text"
                                        placeholder={palette.placeholder}
                                        value={palette.query}
                                        onChange={(event) => palette.setQuery(event.target.value)}
                                    />
                                    <div className="skill-palette-list">
                                        {palette.key === 'competences' && (<>
                                            {catalog.skills.length === 0 && <span className="skill-empty">Aucun skill dans .agent/skills</span>}
                                            {catalog.skills.filter((skill) => !palette.query || skill.toLowerCase().includes(palette.query.toLowerCase())).map((skill) => (
                                                <span key={skill} className="skill-chip draggable" draggable
                                                    onDragStart={(event) => { event.dataTransfer.setData('application/x-hph-skill', skill); event.dataTransfer.effectAllowed = 'copy'; }}
                                                >{skill}</span>
                                            ))}
                                        </>)}
                                        {palette.key === 'roles' && (<>
                                            {catalog.roles.filter((role) => !palette.query || role.toLowerCase().includes(palette.query.toLowerCase())).map((role) => (
                                                <span key={role} className="skill-chip draggable role-chip" draggable
                                                    onDragStart={(event) => { event.dataTransfer.setData('application/x-hph-role', role); event.dataTransfer.effectAllowed = 'copy'; }}
                                                >{role}</span>
                                            ))}
                                        </>)}
                                        {palette.key === 'agents' && (<>
                                            {(catalog.agents || []).filter((agent) => !palette.query || `${agent.role} ${agent.title} ${agent.provider}`.toLowerCase().includes(palette.query.toLowerCase())).map((agent) => (
                                                <span key={agent.sessionId}
                                                    className={`skill-chip draggable role-chip${agent.referent ? ' referent' : ''}${agent.placed ? ' placed' : ''}`}
                                                    title={`${agent.title} · ${agent.provider}${agent.model ? ' · ' + agent.model : ''}`}
                                                    draggable
                                                    onDragStart={(event) => { event.dataTransfer.setData('application/x-hph-agent', JSON.stringify(agent)); event.dataTransfer.effectAllowed = 'copy'; }}
                                                >{agent.role} · {agent.title}</span>
                                            ))}
                                            {(catalog.agents || []).length === 0 && <span className="skill-empty">Aucun agent connu.</span>}
                                        </>)}
                                        {palette.key === 'cards' && (<>
                                            {(catalog.cards || []).length === 0 && <span className="skill-empty">Aucune carte dans .agent/cards</span>}
                                            {(catalog.cards || []).filter((card) => !palette.query || `${card.title} ${card.role} ${card.kind}`.toLowerCase().includes(palette.query.toLowerCase())).map((card) => (
                                                <span key={card.id}
                                                    className={`skill-chip draggable role-chip card-chip card-${card.kind}`}
                                                    title={`${card.title} · ${card.kind} · ${card.provider}${(card.skills || []).length ? ' · ' + (card.skills || []).join(', ') : ''}`}
                                                    draggable
                                                    onDragStart={(event) => { event.dataTransfer.setData('application/x-hph-card', JSON.stringify(card)); event.dataTransfer.effectAllowed = 'copy'; }}
                                                >{card.kind === 'devin' ? '◆' : card.kind === 'agy' ? '◇' : '•'} {card.title}</span>
                                            ))}
                                        </>)}
                                        {palette.key === 'mcps' && (<>
                                            {(catalog.mcps || []).filter((mcp) => !palette.query || mcp.toLowerCase().includes(palette.query.toLowerCase())).map((mcp) => (
                                                <span key={mcp} className="skill-chip draggable mcp-chip" title={`Serveur MCP : ${mcp}`} draggable
                                                    onDragStart={(event) => { event.dataTransfer.setData('application/x-hph-mcp', mcp); event.dataTransfer.effectAllowed = 'copy'; }}
                                                >⛁ {mcp}</span>
                                            ))}
                                            {(catalog.mcps || []).length === 0 && <span className="skill-empty">Aucun serveur dans le broker mcp-mux.</span>}
                                        </>)}
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
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
