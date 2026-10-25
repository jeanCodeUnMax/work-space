"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = require("react");
const client_1 = require("react-dom/client");
const react_2 = require("@xyflow/react");
require("@xyflow/react/dist/style.css");
require("./workspace.css");
const initialNodes = [
    {
        id: 'start',
        type: 'workflow',
        position: { x: 90, y: 170 },
        data: { title: 'Départ', description: 'Point de lancement', tone: 'amber' },
    },
    {
        id: 'agent',
        type: 'workflow',
        position: { x: 390, y: 170 },
        data: { title: 'Agent IA', description: 'Étape de traitement', tone: 'blue' },
    },
    {
        id: 'result',
        type: 'workflow',
        position: { x: 690, y: 170 },
        data: { title: 'Résultat', description: 'Sortie du flux', tone: 'green' },
    },
];
const initialEdges = [
    { id: 'start-agent', source: 'start', target: 'agent', type: 'smoothstep' },
    { id: 'agent-result', source: 'agent', target: 'result', type: 'smoothstep' },
];
function WorkflowNode({ data, selected }) {
    return (<div className={`flow-node ${data.tone}${selected ? ' selected' : ''}`}>
            <react_2.Handle type="target" position={react_2.Position.Left}/>
            <span className="flow-node-kicker">ÉTAPE</span>
            <strong>{data.title}</strong>
            <span className="flow-node-description">{data.description}</span>
            <react_2.Handle type="source" position={react_2.Position.Right}/>
        </div>);
}
const nodeTypes = { workflow: WorkflowNode };
function Workspace() {
    const [nodes, setNodes, onNodesChange] = (0, react_2.useNodesState)(initialNodes);
    const [edges, setEdges, onEdgesChange] = (0, react_2.useEdgesState)(initialEdges);
    const nextNodeId = (0, react_1.useRef)(4);
    const onConnect = (0, react_1.useCallback)((connection) => {
        setEdges((currentEdges) => (0, react_2.addEdge)({ ...connection, type: 'smoothstep' }, currentEdges));
    }, [setEdges]);
    const addNode = () => {
        const id = `step-${nextNodeId.current++}`;
        setNodes((currentNodes) => [
            ...currentNodes,
            {
                id,
                type: 'workflow',
                position: { x: 240 + (currentNodes.length % 3) * 70, y: 330 + Math.floor(currentNodes.length / 3) * 125 },
                data: { title: `Nouvelle étape ${id.slice(5)}`, description: 'Bloc à configurer', tone: 'blue' },
            },
        ]);
    };
    return (<main className="workspace-shell">
            <header className="workspace-toolbar">
                <div className="workspace-title">
                    <span className="workspace-mark" aria-hidden="true">H</span>
                    <div>
                        <h1>Espace de travail</h1>
                        <p>Composez votre flux visuel</p>
                    </div>
                </div>
                <div className="workspace-actions">
                    <span className="node-count">{nodes.length} blocs</span>
                    <button type="button" className="add-node" onClick={addNode}>
                        <span aria-hidden="true">+</span> Ajouter un bloc
                    </button>
                </div>
            </header>
            <section className="flow-canvas" aria-label="Éditeur visuel React Flow">
                <react_2.ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} fitView fitViewOptions={{ padding: 0.22 }} deleteKeyCode={['Backspace', 'Delete']} selectionOnDrag>
                    <react_2.Background variant={react_2.BackgroundVariant.Dots} gap={22} size={1}/>
                    <react_2.Controls />
                    <react_2.MiniMap pannable zoomable/>
                </react_2.ReactFlow>
                <div className="canvas-note">Glissez les blocs et reliez leurs ports pour structurer le flux.</div>
            </section>
        </main>);
}
const root = document.getElementById('root');
if (root) {
    (0, client_1.createRoot)(root).render(<Workspace />);
}
//# sourceMappingURL=workspace.js.map