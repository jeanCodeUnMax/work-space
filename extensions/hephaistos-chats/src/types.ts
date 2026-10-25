export type ChatMode = 'agent' | 'plan' | 'ask' | 'debug';

export interface ChatTool {
    id: string;
    title: string;
    kind?: string;
    status?: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
    at: string;
    isError?: boolean;
    /** Chaîne de raisonnement des modèles "thinking" (reasoning_content / thinking) — affichée repliée, jamais mélangée à la réponse. */
    thinking?: string;
    /** Appels d'outils ACP (tool_call / tool_call_update / plan) affichés en lignes compactes. */
    tools?: ChatTool[];
}

export interface ChatSession {
    id: string;
    title?: string;
    /** Blaze agent façon Devin (adjectif-nom) — identite stable de la session. */
    codename?: string;
    mode: ChatMode;
    provider: string;
    model: string;
    messages: ChatMessage[];
    updatedAt: string;
    /** sessionId renvoyé par l'agent ACP (session/new) — permet session/load après respawn. */
    acpSessionId?: string;
    /** Racine du workspace propriétaire — l'historique n'apparaît que dans son projet. */
    workspace?: string;
}

export interface AcpProvider {
    id: string;
    label: string;
    enabled: boolean;
}

/** Contexte d'un tour — session ACP mémorisée ou, pour devin-cli, session Devin cible. */
export interface TurnCtx {
    chatSessionId?: string;
    acpSessionId?: string;
    onAcpSessionId?: (id: string) => void;
    onTools?: (tools: ChatTool[]) => void;
}

export interface ListedModel {
    provider: string;
    id: string;
}

export const MODES: { id: ChatMode; label: string; desc: string; color: string }[] = [
    { id: 'agent', label: 'Agent', desc: 'Exécution et génération de code', color: '#0e639c' },
    { id: 'plan', label: 'Plan', desc: 'Architecture et planification stratégique', color: '#8957e5' },
    { id: 'ask', label: 'Ask', desc: 'Questions et réponses sans modification', color: '#2ea043' },
    { id: 'debug', label: 'Debug', desc: 'Analyse de bugs et diagnostics', color: '#d29922' },
];

export const ACP_PROVIDERS: { id: string; label: string }[] = [
    // Agents ACP — même registre que devin.acp.enabledAgents
    { id: 'devin-cli', label: 'Devin CLI' },
    { id: 'antigravity-acp', label: 'Antigravity' },
    { id: 'kilo', label: 'KiloCode' },
    { id: 'hermes', label: 'Hermes' },
    { id: 'opencode', label: 'OpenCode' },
    { id: 'mistral-vibe', label: 'Mistral Vibe' },
    { id: 'gemini', label: 'Gemini CLI' },
    { id: 'codex-acp', label: 'Codex ACP' },
    { id: 'cline', label: 'Cline' },
    { id: 'vtcode', label: 'VTCode' },
    { id: 'devin-cloud', label: 'Devin Cloud' },
    // Providers modèles routés par OpenCode (profils OPENCODE_CONFIG)
    { id: 'nim', label: 'NVIDIA NIM' },
    { id: 'nim2', label: 'NVIDIA NIM 2' },
    { id: 'ollama', label: 'Ollama (Local)' },
    { id: 'ollama-cloud', label: 'Ollama Cloud' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'huggingface', label: 'Hugging Face' },
    { id: 'omniroute', label: 'OmniRoute' },
];

const CODENAME_ADJ = ['amber','brave','calm','daring','eager','fair','gentle','hardy','ionic','jolly','keen','lunar','mighty','noble','onyx','proud','quiet','rapid','solar','trusted','urban','vivid','warm','xenial','young','zealous'];
const CODENAME_NOUN = ['atlas','badger','comet','drift','ember','falcon','grove','harbor','ibis','juniper','kite','lantern','mesa','nova','orbit','pine','quartz','robin','shoemaker','tide','umbra','vault','willow','xylem','yew','zephyr'];

export function ensureCodename(session: ChatSession): boolean {
    if (session.codename && session.codename.trim() && !session.codename.includes("undefined")) return false;
    let hash = 0;
    for (const ch of session.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    session.codename = CODENAME_ADJ[hash % CODENAME_ADJ.length] + '-' + (CODENAME_NOUN[(hash >> 5) % CODENAME_NOUN.length] || 'agent');
    return true;
}

export function sessionTitle(session: ChatSession): string {
    if (session.codename && session.codename.trim()) {
        return session.codename.trim();
    }
    if (session.title && session.title.trim()) {
        return session.title.trim();
    }
    const firstUserMsg = session.messages.find((m) => m.role === 'user');
    if (firstUserMsg && firstUserMsg.text.trim()) {
        const clean = firstUserMsg.text.trim().replace(/\s+/g, ' ');
        return clean.length > 28 ? clean.slice(0, 25) + '…' : clean;
    }
    const model = session.model || 'Nouveau Chat';
    const slash = model.lastIndexOf('/');
    const short = slash >= 0 ? model.slice(slash + 1) : model;
    return short || 'Nouveau Chat';
}
