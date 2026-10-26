import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export interface OrchSnapshot {
    type: string;
    tasks?: any[];
    agents?: any[];
    providers?: Record<string, boolean>;
    provider_order?: string[];
    model_health?: Record<string, any>;
    ts?: number;
}

export class OrchWsClient extends EventEmitter {
    private ws: any = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private readonly url: string;
    private readonly port: number;
    private readonly workspaceRoot?: string;
    private shouldReconnect = true;
    private consecutiveFailures = 0;
    private bridgeSpawnCooldown = 0;
    public isConnected = false;
    public lastSnapshot: OrchSnapshot | null = null;

    constructor(url = 'ws://127.0.0.1:7477', workspaceRoot?: string) {
        super();
        this.url = url;
        this.workspaceRoot = workspaceRoot;
        const portMatch = /:(\d+)/.exec(url);
        this.port = portMatch ? Number(portMatch[1]) : 7477;
    }

    private resolveToken(): string {
        if (process.env.ORCH_MONITOR_TOKEN) {
            return process.env.ORCH_MONITOR_TOKEN.trim();
        }
        const candidates = [
            this.workspaceRoot ? path.join(this.workspaceRoot, '.agent', 'ws-bridge.token') : undefined,
            path.join('C:', 'Program Files', 'Projet-complet', 'hephaistos2-kit', '.agent', 'ws-bridge.token'),
            path.join('C:', 'Program Files', 'servers', 'hephaistos2-kit', 'data', 'hphe-rest.token'),
        ].filter((f): f is string => !!f);

        for (const file of candidates) {
            try {
                if (fs.existsSync(file)) {
                    const content = fs.readFileSync(file, 'utf8').trim();
                    if (content) return content;
                }
            } catch {
                /* continuer */
            }
        }
        return '';
    }

    public connect(): void {
        const WS = (globalThis as any).WebSocket;
        if (!WS) {
            console.warn('[OrchWsClient] WebSocket non disponible dans globalThis.');
            return;
        }

        // Si déjà connecté ou en cours de connexion, ne rien faire
        if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
            return;
        }

        if (this.ws) {
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }

        const token = this.resolveToken();
        const connectUrl = token ? `${this.url}?token=${encodeURIComponent(token)}` : this.url;

        try {
            this.ws = new WS(connectUrl);

            this.ws.onopen = () => {
                this.isConnected = true;
                this.consecutiveFailures = 0;
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                this.emit('connected');
                this.send({ command: 'refresh' });
            };

            this.ws.onmessage = (event: { data: string }) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data && data.type === 'snapshot') {
                        this.lastSnapshot = data;
                        this.emit('snapshot', data);
                    } else if (data && data.type === 'task_update') {
                        this.emit('task_update', data.task);
                    }
                    this.emit('message', data);
                } catch {
                    /* ignore frame invalide */
                }
            };

            this.ws.onclose = () => {
                this.isConnected = false;
                this.ws = null;
                this.consecutiveFailures++;
                this.emit('disconnected');
                this.scheduleReconnect();
            };

            this.ws.onerror = () => {
                this.isConnected = false;
                // onclose gère la reconnexion
            };
        } catch {
            this.isConnected = false;
            this.ws = null;
            this.consecutiveFailures++;
            this.scheduleReconnect();
        }
    }

    /**
     * Si le port du bridge ne répond plus (l'IDE propriétaire du process a été
     * fermé, ex. Cursor fermé alors que Devin reste ouvert), on relance
     * bridge.js nous-même en processus DÉTACHÉ — il survit à la fermeture de
     * cet IDE et sert tous les clients (multi-connexions supportées).
     * Jamais plus d'un essai / 30 s.
     */
    private async ensureBridgeAlive(): Promise<void> {
        const free = await new Promise<boolean>((resolve) => {
            const sock = net.connect(this.port, '127.0.0.1');
            const done = (listening: boolean) => { try { sock.destroy(); } catch { /* noop */ } resolve(listening); };
            sock.once('connect', () => done(true));
            sock.once('error', () => done(false));
            sock.setTimeout(1500, () => done(false));
        });
        if (free || Date.now() < this.bridgeSpawnCooldown) {
            return;
        }
        this.bridgeSpawnCooldown = Date.now() + 30_000;

        const candidates = [
            // Extension soeur dans ce repo (layout workspace)
            path.join(__dirname, '..', '..', 'orchestrator-monitor', 'ws-bridge', 'bridge.js'),
        ];
        // Copies installées par IDE (globs élargis à la main)
        for (const base of [
            path.join(process.env.USERPROFILE || '', '.cursor', 'extensions'),
            path.join(process.env.USERPROFILE || '', '.devin', 'extensions'),
            path.join(process.env.USERPROFILE || '', '.vscode', 'extensions'),
        ]) {
            try {
                for (const entry of fs.readdirSync(base)) {
                    if (entry.startsWith('hephaistos.orchestrator-monitor-')) {
                        candidates.push(path.join(base, entry, 'ws-bridge', 'bridge.js'));
                    }
                }
            } catch { /* absent */ }
        }

        const bridgeJs = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
        if (!bridgeJs) {
            return;
        }
        try {
            const child = spawn('node', [bridgeJs], {
                cwd: path.dirname(bridgeJs),
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: { ...process.env, HEPHAISTOS_WORKSPACE: this.workspaceRoot || '' },
            });
            child.unref();
            this.emit('bridge_respawned');
        } catch { /* le watchdog ou un autre IDE s'en chargera */ }
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || this.reconnectTimer) return;
        // Après 3 échecs, vérifier si le bridge est tout simplement mort et le relancer.
        if (this.consecutiveFailures >= 3) {
            void this.ensureBridgeAlive();
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 4000);
    }

    public send(data: unknown): void {
        if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (this.ws as any).OPEN)) {
            try {
                this.ws.send(JSON.stringify(data));
            } catch {
                /* ignore */
            }
        }
    }

    /** Suivi d'une requête de chat auprès de l'orchestrateur (tasks_todo). */
    public trackRequest(payload: Record<string, unknown>): void {
        this.send({ command: 'track_request', ...payload });
    }

    public refresh(): void {
        this.send({ command: 'refresh' });
    }

    public dispose(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }
    }
}
