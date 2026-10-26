(function () {
    const vscode = acquireVsCodeApi();

    const transcript = document.getElementById('transcript');
    const providerBtn = document.getElementById('providerBtn');
    const providerName = document.getElementById('providerName');
    const historyBtn = document.getElementById('historyBtn');
    const pointBtn = document.getElementById('pointBtn');
    if (pointBtn) {
        pointBtn.onclick = () => vscode.postMessage({ type: 'point_agent' });
    }
    const historyMenu = document.getElementById('historyMenu');
    const historyList = document.getElementById('historyList');

    const draft = document.getElementById('draft');
    const sendBtn = document.getElementById('send');
    const modeBtn = document.getElementById('modeBtn');
    const modeLabel = document.getElementById('modeLabel');
    const modelBtn = document.getElementById('modelBtn');
    const modelLabel = document.getElementById('modelLabel');

    const modeMenu = document.getElementById('modeMenu');
    const modelMenu = document.getElementById('modelMenu');
    const modelSearch = document.getElementById('modelSearch');
    const modelList = document.getElementById('modelList');
    const slashMenu = document.getElementById('slashMenu');

    let state = {
        session: null,
        providers: [],
        models: [],
        status: '',
        isGenerating: false,
        allSessions: [],
    };

    const MODES_DATA = {
        agent: { label: 'Agent', color: '#0e639c' },
        plan: { label: 'Plan', color: '#8957e5' },
        ask: { label: 'Ask', color: '#2ea043' },
        debug: { label: 'Debug', color: '#d29922' },
    };

    const SLASH_COMMANDS = [
        { cmd: '/help', desc: 'Aide et liste des commandes disponibles' },
        { cmd: '/chat-id', desc: 'Afficher et copier l\'ID de session (Protocole Binôme)' },
        { cmd: '/chat-id-project', desc: 'Résoudre l\'ID de session canonique via chat-id.js' },
        { cmd: '/jointes', desc: 'Protocole binôme (ex: /jointes AGY ou KiloCode)' },
        { cmd: '/plan', desc: 'Basculer en mode Plan (architecture)' },
        { cmd: '/ask', desc: 'Basculer en mode Ask (question/réponse)' },
        { cmd: '/agent', desc: 'Basculer en mode Agent (code direct)' },
        { cmd: '/debug', desc: 'Basculer en mode Debug (diagnostic)' },
        { cmd: '/skills', desc: 'Lister les compétences Hephaistos' },
        { cmd: '/clear', desc: 'Vider l\'historique de la discussion' },
        { cmd: '/status', desc: 'Afficher l\'état de santé et modèles' },
    ];

    function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function shortModel(id) {
        if (!id) return 'Modèle';
        const slash = id.lastIndexOf('/');
        return slash >= 0 ? id.slice(slash + 1) : id;
    }

    // Mini Markdown Parser
    function renderMarkdown(raw) {
        if (!raw) return '';

        const codeBlocks = [];
        let text = raw.replace(/```([a-zA-Z0-9_\-#+]*)\n([\s\S]*?)```/g, (match, lang, code) => {
            const index = codeBlocks.length;
            codeBlocks.push({ lang: lang || 'code', code: code });
            return `__CODE_BLOCK_${index}__`;
        });

        const lines = text.split('\n');
        const out = [];
        let inList = false;
        let listType = 'ul';

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            if (/^\s*[-*+]\s+(.*)/.test(line)) {
                const content = line.replace(/^\s*[-*+]\s+/, '');
                if (!inList || listType !== 'ul') {
                    if (inList) out.push(`</${listType}>`);
                    out.push('<ul>');
                    inList = true;
                    listType = 'ul';
                }
                out.push(`<li>${inlineMarkdown(content)}</li>`);
                continue;
            }

            if (/^\s*\d+\.\s+(.*)/.test(line)) {
                const content = line.replace(/^\s*\d+\.\s+/, '');
                if (!inList || listType !== 'ol') {
                    if (inList) out.push(`</${listType}>`);
                    out.push('<ol>');
                    inList = true;
                    listType = 'ol';
                }
                out.push(`<li>${inlineMarkdown(content)}</li>`);
                continue;
            }

            if (inList) {
                out.push(`</${listType}>`);
                inList = false;
            }

            if (/^### (.*)/.test(line)) {
                out.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
                continue;
            }
            if (/^## (.*)/.test(line)) {
                out.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
                continue;
            }
            if (/^# (.*)/.test(line)) {
                out.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
                continue;
            }

            if (/^>\s?(.*)/.test(line)) {
                out.push(`<blockquote>${inlineMarkdown(line.slice(1).trim())}</blockquote>`);
                continue;
            }

            if (line.trim().length > 0) {
                out.push(`<p>${inlineMarkdown(line)}</p>`);
            }
        }

        if (inList) {
            out.push(`</${listType}>`);
        }

        let html = out.join('');

        html = html.replace(/__CODE_BLOCK_(\d+)__/g, (match, idx) => {
            const b = codeBlocks[parseInt(idx, 10)];
            if (!b) return '';
            const escCode = escapeHtml(b.code);
            return `
                <div class="code-block">
                    <div class="code-header">
                        <span>${escapeHtml(b.lang)}</span>
                        <button type="button" class="copy-btn" onclick="copySnippet(this)">Copier</button>
                    </div>
                    <pre><code>${escCode}</code></pre>
                </div>
            `;
        });

        return html;
    }

    function inlineMarkdown(text) {
        let esc = escapeHtml(text);
        esc = esc.replace(/`([^`]+)`/g, '<code>$1</code>');
        esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        esc = esc.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        return esc;
    }

    window.copySnippet = function (btn) {
        const pre = btn.closest('.code-block').querySelector('pre');
        if (pre) {
            navigator.clipboard.writeText(pre.innerText).then(() => {
                const old = btn.textContent;
                btn.textContent = '✓ Copié !';
                setTimeout(() => { btn.textContent = old; }, 1800);
            });
        }
    };

    // Les thèmes nomment leurs PNG différemment (commando = pX-cYY, dwarves =
    // icon-NN) : l'host injecte __agentIcons / __agentsFallbackIcons et le webview
    // pioche par hash % count. Sans liste -> convention historique pX-cYY.
    function iconUrl(base, files, h) {
        if (!base) return '';
        const name = files && files.length
            ? files[h % files.length]
            : 'p' + (1 + h % 6) + '-c' + String(h % 16).padStart(2, '0') + '.png';
        return base + '/' + name;
    }

    function agentIconUrls(id) {
        let h = 0;
        for (const ch of (id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return {
            src: iconUrl(window.__agentsUri, window.__agentIcons, h),
            fbk: iconUrl(window.__agentsFallbackUri, window.__agentsFallbackIcons, h),
        };
    }

    // Fallback icône : fichier absent du thème -> équivalent commando (data-fbk), sinon masqué.
    function agentIconFallback() {
        const img = this;
        const fbk = img.dataset.fbk;
        if (fbk && img.src !== fbk) {
            img.src = fbk;
            return;
        }
        img.style.display = 'none';
    }

    function closeMenus() {
        modeMenu.hidden = true;
        modelMenu.hidden = true;
        historyMenu.hidden = true;
        slashMenu.hidden = true;
    }

    function renderTranscript() {
        const session = state.session;
        if (!session) return;

        transcript.replaceChildren();

        if (!session.messages.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.innerHTML = `
                <div class="icon">⚡</div>
                <h2>Hephaistos Chats</h2>
                <p>Pose une question, demande un plan d'architecture ou tape <code>/</code> pour voir les commandes disponibles.</p>
            `;
            transcript.appendChild(empty);
            return;
        }

        session.messages.forEach((msg, idx) => {
            const row = document.createElement('div');
            row.className = `message-row ${msg.role} ${msg.isError ? 'error' : ''}`;

            const isAssistant = msg.role === 'assistant';
            const avatar = document.createElement('div');
            avatar.className = `avatar ${isAssistant ? 'assistant-avatar' : 'user-avatar'}`;
            if (isAssistant && window.__agentsUri && session && session.id) { const iu=agentIconUrls(session.id); const ai=document.createElement('img'); ai.src=iu.src; ai.dataset.fbk=iu.fbk; ai.alt=''; ai.onerror=agentIconFallback; ai.style.cssText='width:100%;height:100%;object-fit:cover;border-radius:inherit;'; avatar.textContent=''; avatar.appendChild(ai); } else { avatar.textContent = isAssistant ? '⚡' : 'U'; }

            const wrap = document.createElement('div');
            wrap.className = 'message-content-wrap';

            const meta = document.createElement('div');
            meta.className = 'message-meta';
            const timeStr = msg.at ? new Date(msg.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            meta.innerHTML = `<span>${isAssistant ? escapeHtml(shortModel(session.model)) : 'Vous'}</span> · <span>${timeStr}</span>`;

            const body = document.createElement('div');
            body.className = `message-body ${isAssistant ? 'markdown' : ''}`;

            if (isAssistant) {
                const streamingLast = state.isGenerating && idx === session.messages.length - 1;
                let html = '';
                if (msg.thinking) {
                    // Raisonnement : déplié tant qu'il est seul (stream en cours), replié ensuite
                    const open = streamingLast && !msg.text ? ' open' : '';
                    html += `<details class="thinking-block"${open}>
                        <summary>💭 Raisonnement</summary>
                        <div class="thinking-content">${escapeHtml(msg.thinking)}</div>
                    </details>`;
                }
                if (msg.tools && msg.tools.length) {
                    html += '<div class="tools-block">' + msg.tools.map((t) => {
                        const icon = t.kind === 'plan' ? '📋' : '🔧';
                        const st = t.status || 'pending';
                        return `<div class="tool-line status-${escapeHtml(st)}"><span>${icon}</span> ${escapeHtml(t.title)} <span class="tool-status">${escapeHtml(st)}</span></div>`;
                    }).join('') + '</div>';
                }
                if (!msg.text && streamingLast) {
                    html += `<div class="typing-dots"><span></span><span></span><span></span></div>`;
                } else {
                    html += renderMarkdown(msg.text);
                }
                body.innerHTML = html;
            } else {
                body.textContent = msg.text;
            }

            wrap.appendChild(meta);
            wrap.appendChild(body);

            if (isAssistant) {
                row.appendChild(avatar);
                row.appendChild(wrap);
            } else {
                row.appendChild(wrap);
                row.appendChild(avatar);
            }

            transcript.appendChild(row);
        });

        transcript.scrollTop = transcript.scrollHeight;
    }

    function renderMenus() {
        const session = state.session;
        if (!session) return;

        // Menu Modes
        modeMenu.replaceChildren();
        Object.entries(MODES_DATA).forEach(([modeKey, info]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = (modeKey === session.mode) ? 'selected' : '';
            btn.innerHTML = `<span class="mode-dot" style="background:${info.color}"></span> ${info.label}`;
            btn.onclick = () => {
                closeMenus();
                vscode.postMessage({ type: 'meta', mode: modeKey, provider: session.provider, model: session.model });
            };
            modeMenu.appendChild(btn);
        });

        // Menu Modèles
        renderFilteredModels('');

        // Menu Historique
        renderHistoryList();
    }

    function renderHistoryList() {
        historyList.replaceChildren();
        const sessions = state.allSessions || [];
        if (!sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'history-item-meta';
            empty.style.padding = '8px';
            empty.textContent = 'Aucune autre conversation.';
            historyList.appendChild(empty);
            return;
        }

        sessions.forEach((s) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `history-item ${s.id === state.session?.id ? 'active' : ''}`;
            const timeStr = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            btn.innerHTML = `
                <span class="history-item-title">${escapeHtml(s.title || s.model)}</span>
                <span class="history-item-meta">${escapeHtml(s.provider)} · ${timeStr}</span>
            `;
            btn.onclick = () => {
                closeMenus();
                if (s.id !== state.session?.id) {
                    vscode.postMessage({ type: 'switch_session', id: s.id });
                }
            };
            historyList.appendChild(btn);
        });
    }

    function renderFilteredModels(filter) {
        modelList.replaceChildren();
        const search = (filter || '').toLowerCase().trim();
        const currentProvider = state.session ? state.session.provider : '';

        // Restreindre strictement aux modèles du fournisseur de cette session
        const providerModels = state.models.filter((m) => m.provider === currentProvider);

        const filtered = providerModels.filter((m) => {
            if (!search) return true;
            return m.id.toLowerCase().includes(search);
        });

        const provObj = state.providers.find((p) => p.id === currentProvider);
        const provLabel = provObj ? provObj.label : currentProvider;

        const groupTitle = document.createElement('div');
        groupTitle.className = 'model-group-title';
        groupTitle.textContent = `${provLabel} (${filtered.length} modèle${filtered.length > 1 ? 's' : ''})`;
        modelList.appendChild(groupTitle);

        if (!filtered.length) {
            const none = document.createElement('div');
            none.className = 'model-group-title';
            none.style.padding = '8px 10px';
            none.textContent = search ? 'Aucun modèle correspondant.' : `Aucun modèle détecté pour ${provLabel}.`;
            modelList.appendChild(none);
            return;
        }

        filtered.forEach((m) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `model-item ${m.id === state.session.model ? 'selected' : ''}`;
            btn.title = m.id;
            btn.innerHTML = `<span>${escapeHtml(shortModel(m.id))}</span>`;
            btn.onclick = () => {
                closeMenus();
                vscode.postMessage({ type: 'meta', mode: state.session.mode, provider: currentProvider, model: m.id });
            };
            modelList.appendChild(btn);
        });
    }

    function updateComposerState() {
        const hasText = draft.value.trim().length > 0;
        if (state.isGenerating) {
            sendBtn.disabled = false;
            sendBtn.classList.add('stop');
            sendBtn.title = 'Arrêter la génération';
            sendBtn.innerHTML = '■';
        } else {
            sendBtn.classList.remove('stop');
            sendBtn.title = 'Envoyer (Entrée)';
            sendBtn.innerHTML = '<span class="send-icon">↑</span>';
            sendBtn.disabled = !hasText;
        }
    }

    function autoResizeTextarea() {
        draft.style.height = 'auto';
        const newHeight = Math.min(Math.max(draft.scrollHeight, 48), 180);
        draft.style.height = newHeight + 'px';
    }

    function renderSlashSuggestions() {
        const val = draft.value;
        if (!val.startsWith('/')) {
            slashMenu.hidden = true;
            return;
        }

        const query = val.toLowerCase().trim();
        const matches = SLASH_COMMANDS.filter((sc) => sc.cmd.startsWith(query) || sc.cmd.includes(query.slice(1)));
        if (!matches.length) {
            slashMenu.hidden = true;
            return;
        }

        slashMenu.innerHTML = matches.map((m) => `
            <div class="slash-item" data-cmd="${m.cmd}">
                <strong>${escapeHtml(m.cmd)}</strong>
                <span>${escapeHtml(m.desc)}</span>
            </div>
        `).join('');

        slashMenu.hidden = false;
    }

    function executeSlashCommand(cmd) {
        slashMenu.hidden = true;
        const session = state.session;
        if (!session) return;

        if (cmd === '/clear') {
            vscode.postMessage({ type: 'clear' });
            draft.value = '';
            autoResizeTextarea();
            updateComposerState();
            return;
        }

        if (cmd === '/chat-id' || cmd === '/chat-id-project') {
            copyChatIdBinome();
            vscode.postMessage({ type: 'get_chat_id' });
            draft.value = '';
            autoResizeTextarea();
            updateComposerState();
            return;
        }

        if (cmd === '/plan' || cmd === '/ask' || cmd === '/agent' || cmd === '/debug') {
            const newMode = cmd.slice(1);
            vscode.postMessage({ type: 'meta', mode: newMode, provider: session.provider, model: session.model });
            draft.value = '';
            autoResizeTextarea();
            updateComposerState();
            return;
        }

        if (cmd === '/help') {
            const helpText = `**Commandes disponibles :**\n- \`/chat-id\` : Copier l'ID et les métadonnées binôme\n- \`/jointes <agent>\` : Protocole binôme\n- \`/plan\`, \`/ask\`, \`/agent\`, \`/debug\` : Changer de mode\n- \`/clear\` : Vider l'historique de ce fil\n- \`/status\` : État du bridge et des modèles`;
            session.messages.push({ role: 'assistant', text: helpText, at: new Date().toISOString() });
            renderTranscript();
            draft.value = '';
            autoResizeTextarea();
            updateComposerState();
            return;
        }

        if (cmd === '/status') {
            const statusText = `**Statut Hephaistos :**\n- Fournisseur actif : \`${session.provider}\`\n- Modèle : \`${session.model}\`\n- Mode : \`${session.mode}\`\n- Sessions enregistrées : ${state.allSessions?.length || 0}\n- État : ${state.status || 'OK'}`;
            session.messages.push({ role: 'assistant', text: statusText, at: new Date().toISOString() });
            renderTranscript();
            draft.value = '';
            autoResizeTextarea();
            updateComposerState();
            return;
        }

        // Pour /jointes ou autres, insérer dans le prompt et préparer l'envoi
        draft.value = cmd + ' ';
        draft.focus();
        autoResizeTextarea();
        updateComposerState();
    }

    function copyChatIdBinome() {
        const session = state.session;
        if (!session) return;

        const userMsgCount = (session.messages || []).filter((m) => m.role === 'user').length;
        const identity = {
            sessionId: session.id,
            providerId: session.provider,
            transport: 'hephaistos-chat',
            model: session.model,
            mode: session.mode,
            title: session.title || shortModel(session.model),
            userMessageCount: userMsgCount,
            createdAt: session.updatedAt || new Date().toISOString(),
        };

        const binomeMeta = JSON.stringify(identity, null, 2);
        navigator.clipboard.writeText(binomeMeta).then(() => {
            const provObj = state.providers.find((p) => p.id === session.provider);
            const normalText = provObj ? provObj.label : session.provider;
            providerBtn.classList.add('copied');
            providerName.textContent = `✓ ID #${session.id.slice(-6)} copié !`;
            setTimeout(() => {
                providerBtn.classList.remove('copied');
                providerName.textContent = normalText;
            }, 1800);
        });
    }

    function render() {
        const session = state.session;
        if (!session) return;

        // Mise à jour du Fournisseur en haut à gauche
        const provObj = state.providers.find((p) => p.id === session.provider);
        const provLabel = provObj ? provObj.label : session.provider;
        providerName.textContent = session.codename || provLabel;
        const iu=agentIconUrls(session.id);
        let img=document.getElementById("agentIcon"); if(!img){img=document.createElement("img");img.id="agentIcon";img.onerror=agentIconFallback;img.style.cssText="width:28px;height:28px;border-radius:6px;object-fit:cover;margin-right:6px;";providerBtn.insertBefore(img,providerName);} img.dataset.fbk=iu.fbk;img.style.display='';img.src=iu.src;
        providerBtn.title = `Fournisseur : ${provLabel}\nModèle : ${session.model}\nChat ID : ${session.id}\n(Cliquer pour copier l'identifiant pour le protocole Binôme)`;

        // Composer labels
        const modeInfo = MODES_DATA[session.mode] || MODES_DATA.agent;
        modeLabel.textContent = modeInfo.label;
        document.querySelector('.mode-dot').style.background = modeInfo.color;
        modelLabel.textContent = shortModel(session.model) + " · " + provLabel;
        modelBtn.title = `${session.model} (${session.provider})`;

        renderTranscript();
        renderMenus();
        updateComposerState();

        vscode.setState({ sessionId: session.id });
    }

    // Event Listeners
    providerBtn.onclick = () => {
        copyChatIdBinome();
    };

    historyBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = !historyMenu.hidden;
        closeMenus();
        if (!isOpen) {
            historyMenu.hidden = false;
            renderHistoryList();
        }
    };

    modeBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = !modeMenu.hidden;
        closeMenus();
        if (!isOpen) modeMenu.hidden = false;
    };

    modelBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = !modelMenu.hidden;
        closeMenus();
        if (!isOpen) {
            modelMenu.hidden = false;
            modelSearch.value = '';
            renderFilteredModels('');
            setTimeout(() => modelSearch.focus(), 50);
        }
    };

    modelSearch.oninput = () => {
        renderFilteredModels(modelSearch.value);
    };

    slashMenu.onclick = (e) => {
        const item = e.target.closest('.slash-item');
        if (item && item.dataset.cmd) {
            executeSlashCommand(item.dataset.cmd);
        }
    };

    sendBtn.onclick = () => {
        if (state.isGenerating) {
            vscode.postMessage({ type: 'abort' });
            return;
        }
        const text = draft.value.trim();
        if (!text) return;

        if (text.startsWith('/')) {
            const parts = text.split(' ');
            const cmd = parts[0];
            if (SLASH_COMMANDS.some((sc) => sc.cmd === cmd)) {
                executeSlashCommand(text);
                return;
            }
        }

        draft.value = '';
        autoResizeTextarea();
        updateComposerState();
        closeMenus();
        vscode.postMessage({ type: 'send', text });
    };

    draft.addEventListener('input', () => {
        autoResizeTextarea();
        updateComposerState();
        renderSlashSuggestions();
    });

    draft.addEventListener('keydown', (e) => {
        if (!slashMenu.hidden) {
            if (e.key === 'Escape') {
                slashMenu.hidden = true;
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                const first = slashMenu.querySelector('.slash-item');
                if (first && first.dataset.cmd) {
                    e.preventDefault();
                    executeSlashCommand(first.dataset.cmd);
                    return;
                }
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled) {
                sendBtn.click();
            }
        }
    });

    document.addEventListener('mousedown', (e) => {
        if (modeMenu.contains(e.target) || modelMenu.contains(e.target) || historyMenu.contains(e.target) || slashMenu.contains(e.target)) return;
        if (e.target === modeBtn || modeBtn.contains(e.target)) return;
        if (e.target === modelBtn || modelBtn.contains(e.target)) return;
        if (e.target === historyBtn || historyBtn.contains(e.target)) return;
        closeMenus();
    });

    window.addEventListener('message', (event) => {
        // Rebascule des URI media/agents/<theme>/ poussée par l'host après set_icon_theme.
        if (event.data && event.data.type === 'icon_theme') {
            if (event.data.agentsUri) window.__agentsUri = event.data.agentsUri;
            if (event.data.fallbackUri) window.__agentsFallbackUri = event.data.fallbackUri;
            if (Array.isArray(event.data.iconFiles)) window.__agentIcons = event.data.iconFiles;
            if (Array.isArray(event.data.fallbackFiles)) window.__agentsFallbackIcons = event.data.fallbackFiles;
            if (state.session) render();
            return;
        }

        if (event.data && event.data.type === 'prefill') {
            draft.value = event.data.text || '';
            autoResizeTextarea();
            updateComposerState();
            draft.focus();
            return;
        }

        if (event.data && event.data.type === 'state') {
            state = event.data;
            render();
            return;
        }

        if (event.data && event.data.type === 'chat_id_response') {
            const sid = event.data.sessionIdentity;
            const wss = event.data.workspaceSession;
            let md = `### Identité de session canonique (\`/chat-id\`)\n\`\`\`json\n${JSON.stringify(sid, null, 2)}\n\`\`\`\n*(Copiée dans le presse-papier — exploitable pour le protocole binôme \`/jointes\`)*`;
            if (wss) {
                md += `\n\n**Session focalisée dans le workspace (via \`chat-id.js\`) :**\n\`\`\`json\n${JSON.stringify(wss, null, 2)}\n\`\`\``;
            }
            if (state.session) {
                state.session.messages.push({ role: 'assistant', text: md, at: new Date().toISOString() });
                renderTranscript();
            }
        }
    });

    vscode.postMessage({ type: 'ready' });
}());
