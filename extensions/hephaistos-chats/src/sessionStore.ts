import { ensureCodename } from './types';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatSession } from './types';

const STORAGE_KEY = 'hephaistosChats.sessions';

export class SessionStore {
    private sessions: ChatSession[];
    /** JSON exact de notre dernière écriture disque — pour ignorer nos propres
     *  événements fs.watch (sinon le watcher recharge notre propre écriture
     *  partielle en plein tour de génération et écrase l'objet session). */
    private lastPersistedJson = '';

    constructor(private readonly context: vscode.ExtensionContext) {
        this.sessions = context.workspaceState.get<ChatSession[]>(STORAGE_KEY, []);
        this.sessions.forEach((sess) => ensureCodename(sess));
        this.persistToDisk();
        this.tryRestoreFromDisk();
    }

    private getDiskDir(): string | undefined {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return undefined;
        const dir = path.join(root, '.agent', 'chats');
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            return dir;
        } catch {
            return undefined;
        }
    }

    private tryRestoreFromDisk(): void {
        const dir = this.getDiskDir();
        if (!dir) return;
        try {
            const indexFile = path.join(dir, 'sessions.json');
            if (fs.existsSync(indexFile)) {
                const raw = fs.readFileSync(indexFile, 'utf8');
                const diskSessions = JSON.parse(raw) as ChatSession[];
                if (Array.isArray(diskSessions)) {
                    for (const session of diskSessions) ensureCodename(session);
                    const merged = new Map(diskSessions.map((session) => [session.id, session]));
                    for (const session of this.sessions) {
                        const diskSession = merged.get(session.id);
                        if (!diskSession || session.updatedAt >= diskSession.updatedAt) {
                            merged.set(session.id, session);
                        }
                    }
                    const restored = [...merged.values()];
                    if (JSON.stringify(restored) !== JSON.stringify(this.sessions)) {
                        this.sessions = restored;
                        this.sessions.forEach((x) => ensureCodename(x));
                        void this.context.workspaceState.update(STORAGE_KEY, this.sessions);
                    }
                }
            }
        } catch {
            /* ignore */
        }
    }

    private persistToDisk(): void {
        const dir = this.getDiskDir();
        if (!dir) return;
        try {
            const indexFile = path.join(dir, 'sessions.json');
            this.lastPersistedJson = JSON.stringify(this.sessions, null, 2);
            fs.writeFileSync(indexFile, this.lastPersistedJson, 'utf8');
        } catch {
            /* best-effort */
        }
    }

    /** Recharge depuis le disque (écritures externes, ex. acp-server.mjs). Retourne true si changé. */
    reloadFromDisk(): boolean {
        const dir = this.getDiskDir();
        if (!dir) return false;
        try {
            const indexFile = path.join(dir, 'sessions.json');
            if (!fs.existsSync(indexFile)) return false;
            const raw = fs.readFileSync(indexFile, 'utf8');
            // Écriture provenant de cette instance (fs.watch voit nos propres
            // writeFileSync) : ne jamais recharger notre propre contenu.
            if (raw === this.lastPersistedJson) return false;
            const disk = JSON.parse(raw) as ChatSession[];
            if (!Array.isArray(disk)) return false;
            if (JSON.stringify(disk) === JSON.stringify(this.sessions)) return false;
            this.sessions = disk;
            void this.context.workspaceState.update(STORAGE_KEY, this.sessions);
            return true;
        } catch {
            return false;
        }
    }

    getSessionsFilePath(): string | undefined {
        const dir = this.getDiskDir();
        return dir ? path.join(dir, 'sessions.json') : undefined;
    }

    list(): ChatSession[] {
        return [...this.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id: string): ChatSession | undefined {
        return this.sessions.find((session) => session.id === id);
    }

    create(provider = 'openrouter', model = 'liquid/lfm-2.5-2.6b:free'): ChatSession {
        const session: ChatSession = {
            id: `chat-${randomUUID()}`,
            mode: 'agent',
            provider,
            model,
            messages: [],
            updatedAt: new Date().toISOString(),
            workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        };
        ensureCodename(session);
        this.save(session);
        return session;
    }

    restore(id: string, provider: string, model: string, title?: string): ChatSession {
        const session: ChatSession = {
            id,
            title: title || undefined,
            mode: 'agent',
            provider: provider || 'openrouter',
            model: model || 'liquid/lfm-2.5-2.6b:free',
            messages: [],
            updatedAt: new Date().toISOString(),
            workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        };
        ensureCodename(session);
        this.save(session);
        return session;
    }

    save(session: ChatSession): void {
        const stored = { ...session, updatedAt: new Date().toISOString() };
        this.sessions = this.sessions.filter((item) => item.id !== stored.id);
        this.sessions.push(stored);
        void this.context.workspaceState.update(STORAGE_KEY, this.sessions);
        this.persistToDisk();
    }

    delete(id: string): void {
        this.sessions = this.sessions.filter((s) => s.id !== id);
        void this.context.workspaceState.update(STORAGE_KEY, this.sessions);
        this.persistToDisk();
    }

    rename(id: string, newTitle: string): void {
        const session = this.get(id);
        if (session) {
            session.title = newTitle.trim();
            this.save(session);
        }
    }

    clear(id: string): void {
        const session = this.get(id);
        if (session) {
            session.messages = [];
            this.save(session);
        }
    }
}
