// @ts-nocheck
(function () {
    "use strict";

    // Erreurs JS visibles dans la webview (diagnostic)
    function showFatal(msg) {
        try {
            let box = document.getElementById("js-fatal");
            if (!box) {
                box = document.createElement("div");
                box.id = "js-fatal";
                box.style.cssText =
                    "position:fixed;top:0;left:0;right:0;z-index:9999;background:#a1260d;color:#fff;padding:8px 12px;font:12px monospace;white-space:pre-wrap;";
                (document.body || document.documentElement).appendChild(box);
            }
            box.textContent = "panel.js: " + msg;
        } catch (e) {
            /* dernier recours */
        }
    }
    window.onerror = function (m, s, l, c) {
        showFatal(m + " @" + l + ":" + c);
    };

    function tr(key) {
        if (typeof window.t === "function")
            return window.t(key, effectiveLang());
        return key; // i18n.js non chargé : la clé s'affiche (diagnostic visible)
    }

    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // État interne de la vue
    let state = {
        tasks: [],
        agents: [],
        lastUpdate: null,
        wsConnected: false,
        searchQuery: "",
        expandedTaskId: null,
        lang: null, // choix utilisateur (persisté)
        envLang: "en", // langue de l'IDE reçue via config
        collapsed: {}, // groupes repliés {status|'agents': bool}
        groupHeights: {}, // hauteurs persistées {status|'comms': "NNNpx"}
        commsHidden: false, // section comms totalement refermée
        comms: [], // feed inter-agents (.agent/comms.jsonl via bridge)
        providerEnabled: {}, // toggles provider {provider: bool} — DB provider_prefs
        providerOrder: null, // ordre drag&drop de la chaîne — DB provider_prefs.position
        colLayout: {
            // ordre + largeurs des colonnes (toutes les tables)
            order: [
                "statuslight",
                "id",
                "title",
                "priority",
                "type",
                "model",
                "agent",
                "session",
                "created",
                "actions",
            ],
            widths: {},
        },
    };

    const defaultColOrder = [...state.colLayout.order];
    const previousState = vscode.getState();
    if (previousState) {
        state = { ...state, ...previousState };
    }
    // Normalisation : ancien colLayout sauvegardé peut manquer les nouvelles
    // colonnes (statuslight/session) ou l'objet widths — on complète.
    state.colLayout = state.colLayout || {};
    if (!Array.isArray(state.colLayout.order)) state.colLayout.order = [];
    for (const k of defaultColOrder) {
        if (!state.colLayout.order.includes(k)) state.colLayout.order.push(k);
    }
    state.colLayout.widths = state.colLayout.widths || {};

    // Langue effective : choix utilisateur > langue IDE détectée > en
    function effectiveLang() {
        const cand = state.lang || state.envLang || "en";
        return (window.SUPPORTED_LANGS || []).includes(cand) ? cand : "en";
    }

    // Éléments du DOM
    const wsIndicatorDot = document.getElementById("ws-dot");
    const wsStatusText = document.getElementById("ws-status-text");
    const lastUpdateText = document.getElementById("last-update-text");
    const kpiInProgress = document.getElementById("kpi-in-progress");
    const kpiPending = document.getElementById("kpi-pending");
    const kpiCompleted = document.getElementById("kpi-completed");
    const kpiFailed = document.getElementById("kpi-failed");
    const kpiAgents = document.getElementById("kpi-agents");
    const tasksCount = document.getElementById("tasks-count");
    const taskSearchInput = document.getElementById("task-search-input");
    const btnSettings = document.getElementById("btn-settings");
    const settingsMenu = document.getElementById("settings-menu");
    const agentsCount = document.getElementById("agents-count");
    const agentsGridContainer = document.getElementById(
        "agents-grid-container",
    );
    const GROUP_STATUSES = ["in_progress", "pending", "failed", "completed"];

    function saveState() {
        vscode.setState(state);
    }

    // ===== i18n =====
    function applyI18n() {
        const lang = effectiveLang();
        document.documentElement.lang = lang;
        document.querySelectorAll("[data-i18n]").forEach((el) => {
            el.textContent = tr(el.getAttribute("data-i18n"));
        });
        document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
            el.placeholder = tr(el.getAttribute("data-i18n-ph"));
        });
        document.querySelectorAll("[data-i18n-title]").forEach((el) => {
            el.title = tr(el.getAttribute("data-i18n-title"));
        });
        // Marque la langue active dans le menu
        document.querySelectorAll(".settings-lang").forEach((el) => {
            el.classList.toggle(
                "active",
                el.getAttribute("data-lang") === lang,
            );
        });
        // Textes dynamiques hors attributs
        updateHeader();
    }

    // Formatage date locale (langue suivie)
    function formatDate(dateStr) {
        if (!dateStr) return "-";
        try {
            // SQLite CURRENT_TIMESTAMP = UTC sans marqueur ("YYYY-MM-DD HH:MM:SS")
            // → normaliser en ISO-Z sinon JS l'interprète en heure locale (+2h de décalage)
            const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(dateStr)
                ? dateStr.replace(" ", "T") + "Z"
                : dateStr;
            const d = new Date(iso);
            if (isNaN(d.getTime())) return dateStr;
            return d.toLocaleString(
                effectiveLang() === "fr"
                    ? "fr-FR"
                    : effectiveLang() === "de"
                      ? "de-DE"
                      : effectiveLang() === "es"
                        ? "es-ES"
                        : "en-GB",
                {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                },
            );
        } catch {
            return dateStr;
        }
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function updateHeader() {
        if (wsIndicatorDot && wsStatusText) {
            wsIndicatorDot.className =
                "status-dot " +
                (state.wsConnected ? "connected" : "disconnected");
            wsStatusText.textContent = tr(
                state.wsConnected ? "conn.connected" : "conn.disconnected",
            );
        }
        if (lastUpdateText) {
            lastUpdateText.textContent = state.lastUpdate
                ? `${tr("sync.last")} : ${formatDate(state.lastUpdate)}`
                : tr("sync.waiting");
        }
    }

    function updateKPIs() {
        let countInProgress = 0,
            countPending = 0,
            countCompleted = 0,
            countFailed = 0;
        for (const task of state.tasks) {
            const status = (task.status || "").toLowerCase();
            if (status === "in_progress") countInProgress++;
            else if (status === "pending") countPending++;
            else if (status === "completed") countCompleted++;
            else if (status === "failed") countFailed++;
        }
        let countActiveAgents = 0;
        for (const agent of visibleAgents()) {
            if (typeof agent.id !== "number") continue; // cartes virtuelles (providers) hors KPI
            if (agent.active === 1 || agent.active === true)
                countActiveAgents++;
        }
        if (kpiInProgress) kpiInProgress.textContent = String(countInProgress);
        if (kpiPending) kpiPending.textContent = String(countPending);
        if (kpiCompleted) kpiCompleted.textContent = String(countCompleted);
        if (kpiFailed) kpiFailed.textContent = String(countFailed);
        if (kpiAgents) kpiAgents.textContent = String(countActiveAgents);
    }

    function getAgentName(assignedTo) {
        if (assignedTo === null || assignedTo === undefined) return "-";
        const agent = state.agents.find((a) => a.id === assignedTo);
        return agent ? agent.agent_name : `Agent #${assignedTo}`;
    }

    function matchesQuery(task, query) {
        if (!query) return true;
        return (
            (task.title || "").toLowerCase().includes(query) ||
            String(task.id || "").includes(query) ||
            (task.model || "").toLowerCase().includes(query) ||
            (task.provider || "").toLowerCase().includes(query) ||
            (task.task_type || "").toLowerCase().includes(query) ||
            getAgentName(task.assigned_to).toLowerCase().includes(query)
        );
    }

    function priorityBadge(task) {
        const key = (task.priority || "").toLowerCase();
        const known = {
            high: "prio.high",
            medium: "prio.medium",
            low: "prio.low",
        };
        const label = known[key] ? tr(known[key]) : task.priority || "-";
        return `<span class="badge-priority priority-${key}">${label}</span>`;
    }

    // ===== Colonnes : ordre, déplacement (drag) et redimensionnement =====
    function applyColLayout() {
        const order = state.colLayout.order;
        const tables = [...document.querySelectorAll(".tasks-table")];
        tables.forEach((table) => {
            const colgroup = table.querySelector("colgroup");
            const headRow = table.querySelector("thead tr");
            if (!colgroup || !headRow) return;
            for (const key of order) {
                const col = colgroup.querySelector(`col[data-col="${key}"]`);
                if (col) colgroup.appendChild(col);
                const th = headRow.querySelector(`th[data-col="${key}"]`);
                if (th) headRow.appendChild(th);
            }
        });

        // Harmonisation stricte : une data-col = une largeur IDENTIQUE dans
        // toutes les tables. Source = largeur persistée, sinon la plus grande
        // largeur de th mesurée (la table remplie sert de référence).
        const keys = new Set();
        tables.forEach((t) =>
            t.querySelectorAll("col[data-col]").forEach((c) =>
                keys.add(c.getAttribute("data-col")),
            ),
        );
        for (const key of keys) {
            let w = (state.colLayout.widths || {})[key];
            if (!w) {
                let max = 0;
                tables.forEach((t) => {
                    const th = t.querySelector(`th[data-col="${key}"]`);
                    if (th) max = Math.max(max, th.offsetWidth);
                });
                if (!max) continue;
                w = max + "px";
            }
            tables.forEach((t) => {
                const col = t.querySelector(`col[data-col="${key}"]`);
                if (col) col.style.width = w;
                const th = t.querySelector(`th[data-col="${key}"]`);
                if (th) th.style.width = w;
            });
        }
    }

    function initTableInteractions() {
        document.querySelectorAll(".tasks-table thead th").forEach((th) => {
            const key = th.getAttribute("data-col");
            if (!key) return;

            // --- Redimensionnement (poignée droite) ---
            const resizer = th.querySelector(".col-resizer");
            if (resizer) {
                resizer.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const startX = e.clientX;
                    const startW = th.offsetWidth;
                    let finalW = startW;
                    const applyW = (w) => {
                        // Même data-col dans TOUTES les tables .tasks-table :
                        // col + th (certains rendus webview ignorent col seul
                        // sous table-layout:fixed quand le th a du contenu).
                        document
                            .querySelectorAll(
                                `.tasks-table col[data-col="${key}"], ` +
                                `.tasks-table th[data-col="${key}"]`,
                            )
                            .forEach((el) => {
                                el.style.width = w + "px";
                            });
                    };
                    const move = (ev) => {
                        finalW = Math.max(20, startW + ev.clientX - startX);
                        applyW(finalW);
                    };
                    const up = () => {
                        document.removeEventListener("mousemove", move);
                        document.removeEventListener("mouseup", up);
                        state.colLayout.widths[key] = finalW + "px";
                        saveState();
                    };
                    document.addEventListener("mousemove", move);
                    document.addEventListener("mouseup", up);
                });
            }

            // --- Réordonnancement (drag & drop) ---
            th.addEventListener("dragstart", (e) => {
                if (e.target.closest(".col-resizer")) {
                    e.preventDefault();
                    return;
                }
                e.dataTransfer.setData("text/plain", key);
                e.dataTransfer.effectAllowed = "move";
                th.classList.add("dragging");
            });
            th.addEventListener("dragend", () => {
                th.classList.remove("dragging");
                document
                    .querySelectorAll("th.drag-over")
                    .forEach((el) => el.classList.remove("drag-over"));
            });
            th.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                th.classList.add("drag-over");
            });
            th.addEventListener("dragleave", () =>
                th.classList.remove("drag-over"),
            );
            th.addEventListener("drop", (e) => {
                e.preventDefault();
                th.classList.remove("drag-over");
                const src = e.dataTransfer.getData("text/plain");
                const dst = key;
                if (!src || src === dst) return;
                const order = state.colLayout.order.filter((k) => k !== src);
                order.splice(order.indexOf(dst), 0, src);
                state.colLayout.order = order;
                saveState();
                applyColLayout();
                renderTasks();
            });
        });
    }

    // État replié des groupes (persisté, inclut la section agents)
    function applyCollapsed() {
        document.querySelectorAll(".task-group").forEach((g) => {
            const key = g.getAttribute("data-status") || "agents";
            if (key in state.collapsed) {
                g.classList.toggle("collapsed", !!state.collapsed[key]);
            }
        });
    }

    // Cellule d'une tâche par clé de colonne
    function taskCellHtml(task, col) {
        const agentDisplay = getAgentName(task.assigned_to);
        let chipsHtml = "";
        if (task.provider) {
            chipsHtml += `<span class="chip chip-provider">${escapeHtml(task.provider)}</span>`;
        }
        if (task.model) {
            chipsHtml += `<span class="chip chip-model">${escapeHtml(task.model)}</span>`;
        }
        if (!chipsHtml) {
            chipsHtml =
                '<span style="color: var(--vscode-descriptionForeground);">-</span>';
        }
        switch (col) {
            case "statuslight": {
                const _stMap = {
                    pending: "pending",
                    in_progress: "progress",
                    failed: "failed",
                    completed: "done",
                };
                const _st =
                    _stMap[(task.status || "pending").toLowerCase()] ||
                    "pending";
                return `<td class='col-status'><span class='status-light st-${_st}' title='${escapeHtml(tr("light." + _st))}'></span></td>`;
            }
            case "id":
                return `<td class="col-id">#${task.id}</td>`;
            case "title":
                return `<td class="col-title">${escapeHtml(task.title || "(Sans titre)")}</td>`;
            case "priority":
                return `<td class="col-priority">${priorityBadge(task)}</td>`;
            case "type":
                return `<td class="col-type">${escapeHtml(task.task_type || "-")}</td>`;
            case "model":
                return `<td class="col-model"><div class="chip-wrapper">${chipsHtml}</div></td>`;
            case "agent":
                return `<td class="col-agent">${escapeHtml(agentDisplay)}</td>`;
            case "created":
                return `<td class="col-date">${formatDate(task.created_at)}</td>`;
            case "actions":
                return `<td class="col-actions"><button class="row-btn" data-send-task="${task.id}" title="${escapeHtml(tr("tasks.sendTask"))}">&#8679;</button><button class="row-btn row-btn-del" data-del-task="${task.id}" title="${escapeHtml(tr("tasks.deleteTask"))}">&#128465;</button></td>`;
            case "session": {
                // Utiliser la nouvelle colonne dispatcher de la DB si disponible, sinon parser le titre
                const sessionValue =
                    task.dispatcher !== null && task.dispatcher !== undefined
                        ? task.dispatcher
                        : (() => {
                              const match = (task.title || "").match(
                                  /\[session:([^\]]+)\]/,
                              );
                              return match ? match[1] : null;
                          })();
                return `<td class="col-session">${escapeHtml(sessionValue || "-")}</td>`;
            }
            default:
                return "<td></td>";
        }
    }

    // Ligne d'une tâche (sans colonne statut — implicite au groupe)
    function taskRowHtml(task) {
        const isExpanded = state.expandedTaskId === task.id;
        const nCols = state.colLayout.order.length;
        let html =
            `<tr class="task-row" data-task-id="${task.id}">` +
            state.colLayout.order
                .map((col) => taskCellHtml(task, col))
                .join("") +
            "</tr>";

        if (isExpanded) {
            html += `
                <tr class="detail-row">
                    <td colspan="${nCols}">
                        <div class="task-detail-box">
                            ${
                                task.description
                                    ? `
                                <div class="detail-line">
                                    <strong>${tr("detail.desc")}</strong>
                                    <div class="detail-content">${escapeHtml(task.description)}</div>
                                </div>
                            `
                                    : ""
                            }
                            ${
                                task.result
                                    ? `
                                <div class="detail-line">
                                    <strong>${tr("detail.result")}</strong>
                                    <div class="detail-content">${escapeHtml(task.result)}</div>
                                </div>
                            `
                                    : ""
                            }
                        </div>
                    </td>
                </tr>
            `;
        }
        return html;
    }

    // Rendu des 4 groupes de tâches
    function renderTasks() {
        const query = state.searchQuery.toLowerCase().trim();
        let totalShown = 0;

        for (const statusKey of GROUP_STATUSES) {
            const tbody = document.getElementById("tbody-" + statusKey);
            const countEl = document.getElementById("gcount-" + statusKey);
            if (!tbody) continue;

            const groupTasks = state.tasks
                .filter((t) => (t.status || "").toLowerCase() === statusKey)
                .filter((t) => matchesQuery(t, query))
                .sort((a, b) => (b.id || 0) - (a.id || 0));

            if (countEl) countEl.textContent = String(groupTasks.length);
            totalShown += groupTasks.length;

            tbody.innerHTML =
                groupTasks.length === 0
                    ? `<tr><td colspan="${state.colLayout.order.length}" class="table-empty">${tr("tasks.none")}</td></tr>`
                    : groupTasks.map(taskRowHtml).join("");
        }

        if (tasksCount) {
            tasksCount.textContent = `${totalShown} / ${state.tasks.length}`;
        }

        // Ré-harmonise les colonnes après chaque rendu : les tables vides ou
        // nouvellement remplies doivent rester identiques aux autres.
        applyColLayout();

        // Clic ligne → détail
        document
            .querySelectorAll(".task-group-body .task-row")
            .forEach((row) => {
                row.addEventListener("click", () => {
                    const idAttr = row.getAttribute("data-task-id");
                    const id = idAttr ? parseInt(idAttr, 10) : null;
                    state.expandedTaskId =
                        state.expandedTaskId === id ? null : id;
                    saveState();
                    renderTasks();
                });
            });

        // Boutons « envoyer la tâche à Devin »
        document.querySelectorAll(".row-btn[data-send-task]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const id = parseInt(
                    btn.getAttribute("data-send-task") || "",
                    10,
                );
                const task = state.tasks.find((t) => t.id === id);
                if (task) {
                    sendToChat(formatTaskLine(task), "Tâche #" + id);
                }
            });
        });

        // Poubelle par ligne : 1er clic arme (bouton rouge « ? »), 2e clic < 3s
        // confirme la suppression — pas de dialog bloquant en webview.
        document.querySelectorAll(".row-btn-del[data-del-task]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!btn.classList.contains("armed")) {
                    btn.classList.add("armed");
                    btn.textContent = "?";
                    setTimeout(() => {
                        btn.classList.remove("armed");
                        btn.innerHTML = "&#128465;";
                    }, 3000);
                    return;
                }
                const id = parseInt(
                    btn.getAttribute("data-del-task") || "",
                    10,
                );
                if (Number.isFinite(id)) {
                    vscode.postMessage({ command: "delete_task", id });
                }
            });
        });
    }

    // ===== Envoi vers le chat Devin =====
    function sendToChat(text, note) {
        vscode.postMessage({ command: "send_to_chat", text, note });
    }

    function formatTaskLine(task) {
        const meta = [];
        const agentName = getAgentName(task.assigned_to);
        if (agentName && agentName !== "-") meta.push("agent: " + agentName);
        if (task.provider || task.model)
            meta.push(
                "modèle: " +
                    [task.provider, task.model].filter(Boolean).join("/"),
            );
        if (task.priority) meta.push("priorité: " + task.priority);
        if (task.created_at) meta.push("créée: " + formatDate(task.created_at));
        return (
            "- **#" +
            task.id +
            "** " +
            (task.title || "(Sans titre)") +
            " — _" +
            (task.status || "?") +
            "_ (" +
            meta.join(", ") +
            ")"
        );
    }

    function formatTaskTable(title, tasks) {
        const lines = ["## " + title + " (" + tasks.length + ")", ""];
        if (tasks.length === 0) {
            lines.push("_(aucune)_");
        } else {
            tasks.forEach((t) => lines.push(formatTaskLine(t)));
        }
        return lines.join("\n");
    }

    function copyGroupTasks(status) {
        const query = state.searchQuery.toLowerCase().trim();
        const list = state.tasks
            .filter((t) => (t.status || "").toLowerCase() === status)
            .filter((t) => matchesQuery(t, query))
            .sort((a, b) => (b.id || 0) - (a.id || 0));
        const label = tr("group." + status);
        sendToChat(
            formatTaskTable(tr("tasks.title") + " « " + label + " »", list),
            tr("group." + status),
        );
    }

    function copyAllTasks() {
        const query = state.searchQuery.toLowerCase().trim();
        const parts = GROUP_STATUSES.map((status) => {
            const list = state.tasks
                .filter((t) => (t.status || "").toLowerCase() === status)
                .filter((t) => matchesQuery(t, query))
                .sort((a, b) => (b.id || 0) - (a.id || 0));
            return formatTaskTable(
                tr("tasks.title") + " « " + tr("group." + status) + " »",
                list,
            );
        });
        sendToChat(
            "# " + tr("tasks.title") + "\n\n" + parts.join("\n\n"),
            tr("tasks.title"),
        );
    }

    // Agents masqués : __system_init__ (bookkeeping interne) et devin (CLI Devin
    // redondant dans l'IDE Devin — antigravity/kilo/hermes suffisent)
    const HIDDEN_AGENTS = new Set(["__system_init__", "devin"]);
    // Chaîne par priorité (directives) : NIM1 → NIM2 → Ollama local/cloud →
    // Kilo Code → Hermes → AGY (spécialisé graphique) → OpenRouter
    // Ordre modifiable par drag & drop — persisté en DB (provider_prefs.position)
    const PROVIDER_CHAIN = [
        "mistral-vibe",
        "antigravity-subscription",
        "nvidia-nim",
        "nvidia-nim2",
        "kilo-free",
        "hermes-free",
        "openrouter-free",
        "kilocode",
        "hermes",
        "ollama",
        "ollama-cloud",
    ];
    const PROVIDER_LABEL = {
        "mistral-vibe": "Mistral Vibe",
        "nvidia-nim": "NVIDIA NIM · API 1",
        "nvidia-nim2": "NVIDIA NIM · API 2",
        ollama: "Ollama local",
        "ollama-cloud": "Ollama cloud",
        kilocode: "Kilo Code",
        hermes: "Hermes",
        "antigravity-subscription": "Antigravity",
        "kilo-free": "Kilo (free)",
        "hermes-free": "Hermes/Nous (free)",
        "openrouter-free": "OpenRouter (free)",
    };

    // Carte virtuelle : providers cloud représentés dans la grille sans être
    // des agents CLI enregistrés en DB
    const VIRTUAL_AGENTS = [
        {
            id: "ollama",
            agent_name: "Ollama",
            agent_type: "provider",
            active: 1,
            config: JSON.stringify({
                providers: ["ollama-cloud", "ollama"],
                skills: [],
            }),
        },
    ];
    const PROVIDER_RANK = PROVIDER_CHAIN;

    function parseAgentCfg(agent) {
        if (typeof agent.config === "object" && agent.config !== null)
            return agent.config;
        try {
            return JSON.parse(agent.config || "{}");
        } catch {
            return {};
        }
    }

    function agentRank(agent) {
        const provs = parseAgentCfg(agent).providers || [];
        const idx = provs.length ? PROVIDER_RANK.indexOf(provs[0]) : -1;
        return idx >= 0 ? idx : PROVIDER_RANK.length + 1; // providers non listés (abonnements) → fin
    }

    function visibleAgents() {
        return state.agents
            .filter((a) => !HIDDEN_AGENTS.has(a.agent_name || ""))
            .concat(VIRTUAL_AGENTS)
            .sort(
                (a, b) =>
                    agentRank(a) - agentRank(b) ||
                    String(a.agent_name).localeCompare(b.agent_name),
            );
    }

    // Rendu des cartes agents
    function renderAgents() {
        if (!agentsGridContainer) return;
        const agents = visibleAgents();
        if (agentsCount) agentsCount.textContent = String(agents.length);

        // Chaîne de providers par priorité — chaque nœud = toggle on/off draggable
        // (provider_prefs en DB ; ON = l'orchestrateur peut piocher dedans, OFF = sauté)
        const saved = Array.isArray(state.providerOrder)
            ? state.providerOrder
            : [];
        const chain = saved
            .filter((p) => PROVIDER_CHAIN.includes(p))
            .concat(PROVIDER_CHAIN.filter((p) => !saved.includes(p)));
        let chainHtml =
            `<div class="provider-chain"><span class="provider-chain-label">${tr("agents.chain")}</span>` +
            chain
                .map((p) => {
                    const enabled = state.providerEnabled[p] !== false;
                    const tip = `${p} · ${enabled ? tr("provider.on") : tr("provider.off")}`;
                    return `<button type="button" class="provider-node ${enabled ? "on" : "off"}" draggable="true" data-provider="${escapeHtml(p)}" title="${escapeHtml(tip)}">${escapeHtml(PROVIDER_LABEL[p] || p)}</button>`;
                })
                .join('<span class="provider-sep">&#8594;</span>') +
            "</div>";

        // Santé modèles en direct (model_health : pings discovery + sonde bridge)
        const health = Array.isArray(state.modelHealth)
            ? state.modelHealth
            : [];
        if (health.length) {
            const short = (m) =>
                String(m || "").split("/").pop().slice(0, 28);
            chainHtml +=
                `<div class="model-health"><span class="provider-chain-label">${tr("agents.models")}</span>` +
                health
                    .slice(0, 14)
                    .map((h) => {
                        const ok = h.available === 1 || h.available === true;
                        const lat =
                            typeof h.latency_ms === "number"
                                ? `${h.latency_ms}ms`
                                : "-";
                        const tip = `${h.model} · ${h.provider || h.supplier || ""} · ${ok ? tr("model.up") : tr("model.down")} · ${lat} · ${h.checked_at || ""}`;
                        return `<span class="model-pill ${ok ? "up" : "down"}" title="${escapeHtml(tip)}"><i class="model-dot"></i>${escapeHtml(short(h.model))}<em>${lat}</em></span>`;
                    })
                    .join("") +
                "</div>";
        }

        if (agents.length === 0) {
            agentsGridContainer.innerHTML =
                chainHtml +
                `<div class="table-empty">${tr("agents.none")}</div>`;
            return;
        }

        let html = chainHtml;
        for (const agent of agents) {
            const isActive = agent.active === 1 || agent.active === true;
            const configObj = parseAgentCfg(agent);

            const skills = Array.isArray(configObj.skills)
                ? configObj.skills
                : [];
            const providers = Array.isArray(configObj.providers)
                ? configObj.providers
                : [];

            html += `
                <div class="agent-card">
                    <div class="agent-card-header">
                        <span class="agent-name">${escapeHtml(agent.agent_name || "Agent")}</span>
                        <span class="agent-active-badge ${isActive ? "active" : "inactive"}">
                            ${isActive ? tr("agents.active") : tr("agents.inactive")}
                        </span>
                        ${
                            typeof configObj.priority === "number"
                                ? `<span class="agent-active-badge active" title="priorité de routage">P${configObj.priority}</span>`
                                : ""
                        }
                    </div>
                    <div class="agent-type">${tr("agents.type")} ${escapeHtml(agent.agent_type || "standard")}</div>
                    ${
                        skills.length > 0
                            ? `
                        <div class="agent-meta">
                            <span>${tr("agents.skills")}</span>
                            <div class="agent-tags">
                                ${skills.map((s) => `<span class="tag-skill">${escapeHtml(s)}</span>`).join("")}
                            </div>
                        </div>
                    `
                            : ""
                    }
                    ${
                        providers.length > 0
                            ? `
                        <div class="agent-meta">
                            <span>${tr("agents.providers")}</span>
                            <div class="agent-tags">
                                ${providers.map((p) => `<span class="chip chip-provider">${escapeHtml(p)}</span>`).join("")}
                            </div>
                        </div>
                    `
                            : ""
                    }
                </div>
            `;
        }

        agentsGridContainer.innerHTML = html;
    }

    function render() {
        updateHeader();
        updateKPIs();
        renderTasks();
        renderAgents();
        saveState();
    }

    // Toggles provider : clic → on/off ; drag → réordonne la priorité (persisté en DB)
    if (agentsGridContainer) {
        let dragProvider = null;
        agentsGridContainer.addEventListener("click", (e) => {
            const node = e.target.closest(".provider-node");
            if (!node) return;
            const provider = node.getAttribute("data-provider");
            if (!provider) return;
            const enabled = !(state.providerEnabled[provider] !== false);
            state.providerEnabled[provider] = enabled;
            vscode.postMessage({
                command: "provider_toggle",
                provider,
                enabled,
            });
            renderAgents();
        });
        agentsGridContainer.addEventListener("dragstart", (e) => {
            const node = e.target.closest(".provider-node");
            if (!node) return;
            dragProvider = node.getAttribute("data-provider");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", dragProvider || "");
            node.classList.add("dragging");
        });
        agentsGridContainer.addEventListener("dragover", (e) => {
            if (!dragProvider) return;
            const node = e.target.closest(".provider-node");
            if (!node || node.getAttribute("data-provider") === dragProvider)
                return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = node.getBoundingClientRect();
            node.classList.toggle(
                "drop-before",
                e.clientX < rect.left + rect.width / 2,
            );
            node.classList.toggle(
                "drop-after",
                e.clientX >= rect.left + rect.width / 2,
            );
        });
        agentsGridContainer.addEventListener("dragleave", (e) => {
            const node = e.target.closest(".provider-node");
            if (node) node.classList.remove("drop-before", "drop-after");
        });
        agentsGridContainer.addEventListener("drop", (e) => {
            const node = e.target.closest(".provider-node");
            if (!node || !dragProvider) return;
            e.preventDefault();
            const target = node.getAttribute("data-provider");
            const after = node.classList.contains("drop-after");
            // Nouvel ordre = chaîne courante réarrangée
            const saved = Array.isArray(state.providerOrder)
                ? state.providerOrder
                : [];
            const chain = saved
                .filter((p) => PROVIDER_CHAIN.includes(p))
                .concat(PROVIDER_CHAIN.filter((p) => !saved.includes(p)));
            const next = chain.filter((p) => p !== dragProvider);
            let idx = next.indexOf(target);
            if (idx < 0) idx = next.length;
            else if (after) idx += 1;
            next.splice(idx, 0, dragProvider);
            state.providerOrder = next;
            saveState();
            vscode.postMessage({ command: "provider_order", order: next });
            renderAgents();
            dragProvider = null;
        });
        agentsGridContainer.addEventListener("dragend", () => {
            dragProvider = null;
            agentsGridContainer
                .querySelectorAll(".provider-node")
                .forEach((n) =>
                    n.classList.remove("dragging", "drop-before", "drop-after"),
                );
        });
    }

    // ===== Écouteurs =====
    if (taskSearchInput) {
        taskSearchInput.value = state.searchQuery;
        taskSearchInput.addEventListener("input", (e) => {
            // @ts-ignore
            state.searchQuery = e.target.value;
            saveState();
            renderTasks();
        });
    }

    // En-têtes de groupes : plier / déplier (+ persistance, inclut la section agents)
    document.querySelectorAll(".task-group-header").forEach((header) => {
        const toggle = () => {
            const g = header.closest(".task-group");
            if (!g) return;
            g.classList.toggle("collapsed");
            const key = g.getAttribute("data-status") || "agents";
            state.collapsed[key] = g.classList.contains("collapsed");
            saveState();
        };
        header.addEventListener("click", (e) => {
            if (e.target.closest("button")) return; // ne pas replier en cliquant ⇧/🗑
            toggle();
        });
        header.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
            }
        });
    });

    // --- Poignées de redimensionnement vertical (groupes + comms) ---
    function sectionTarget(key) {
        if (key === "comms") {
            return document.getElementById("comms-feed");
        }
        const g = document.querySelector(
            `.task-group[data-status="${key}"]`,
        );
        return g ? g.querySelector(".task-group-body") : null;
    }

    function applySectionSizes() {
        for (const [key, h] of Object.entries(state.groupHeights || {})) {
            const el = sectionTarget(key);
            if (el) {
                el.style.height = h;
                el.style.overflowY = "auto";
            }
        }
    }

    function initSectionResizers() {
        document.querySelectorAll(".group-resizer").forEach((rz) => {
            rz.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const key = rz.getAttribute("data-resize");
                const el = sectionTarget(key);
                if (!el) return;
                const startY = e.clientY;
                const startH = el.offsetHeight;
                let finalH = startH;
                const move = (ev) => {
                    finalH = Math.max(40, startH + ev.clientY - startY);
                    el.style.height = finalH + "px";
                    el.style.overflowY = "auto";
                };
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    state.groupHeights[key] = finalH + "px";
                    saveState();
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
            });
        });
    }

    // --- Section comms : refermable complètement ---
    const commsToggle = document.getElementById("comms-toggle");
    const commsSection = document.getElementById("comms-section");
    function applyCommsHidden() {
        if (commsSection) {
            commsSection.classList.toggle("comms-hidden", !!state.commsHidden);
        }
    }
    if (commsToggle) {
        commsToggle.addEventListener("click", () => {
            state.commsHidden = !state.commsHidden;
            saveState();
            applyCommsHidden();
        });
    }

    // Boutons « envoyer le groupe » dans les en-têtes
    document
        .querySelectorAll(".group-action-btn[data-copy-group]")
        .forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                copyGroupTasks(btn.getAttribute("data-copy-group") || "");
            });
        });

    // Boutons « purger le groupe » dans les en-têtes
    document
        .querySelectorAll(".group-purge-btn[data-purge-group]")
        .forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                vscode.postMessage({
                    command: "clear_tasks",
                    statuses: [btn.getAttribute("data-purge-group")],
                });
            });
        });

    // Bouton « ouvrir en plein écran » (vue sidebar uniquement)
    const btnExpand = document.getElementById("btn-expand");
    if (btnExpand) {
        btnExpand.addEventListener("click", () => {
            vscode.postMessage({ command: "open_full_panel" });
        });
    }

    // Menu paramètres (⚙)
    if (btnSettings && settingsMenu) {
        btnSettings.addEventListener("click", (e) => {
            e.stopPropagation();
            settingsMenu.classList.toggle("hidden");
        });
        document.addEventListener("click", () =>
            settingsMenu.classList.add("hidden"),
        );

        // Sélecteur de langue
        settingsMenu.querySelectorAll(".settings-lang").forEach((item) => {
            item.addEventListener("click", () => {
                state.lang = item.getAttribute("data-lang");
                saveState();
                applyI18n();
                render();
            });
        });

        // Actions diverses
        settingsMenu.addEventListener("click", (e) => {
            const action = e.target.dataset?.action;
            if (!action) return;
            settingsMenu.classList.add("hidden");
            if (action === "refresh") {
                vscode.postMessage({ command: "refresh" });
            } else if (action === "restart-bridge") {
                vscode.postMessage({ command: "restart_bridge" });
            }
        });
    }

    // Messages venant de l'extension
    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;

        switch (message.type) {
            case "snapshot":
                state.tasks = Array.isArray(message.tasks) ? message.tasks : [];
                state.agents = Array.isArray(message.agents)
                    ? message.agents
                    : [];
                if (
                    message.providers &&
                    typeof message.providers === "object"
                ) {
                    state.providerEnabled = message.providers;
                }
                if (Array.isArray(message.provider_order)) {
                    state.providerOrder = message.provider_order;
                }
                if (Array.isArray(message.model_health)) {
                    state.modelHealth = message.model_health;
                }
                if (Array.isArray(message.comms)) {
                    state.comms = message.comms;
                    if (window.CommsFeed) {
                        window.CommsFeed.setEntries(state.comms);
                    }
                }
                if (window.CommsFeed && window.CommsFeed.setAgents) {
                    const known = new Set([
                        "devin",
                        "agy",
                        "orchestrator",
                        "user",
                    ]);
                    state.agents.forEach((a) => {
                        if (a.agent_name) known.add(a.agent_name);
                    });
                    state.comms.forEach((e) => {
                        if (e.src) known.add(e.src);
                        if (e.dst) known.add(e.dst);
                    });
                    window.CommsFeed.setAgents([...known]);
                }
                state.lastUpdate = message.ts || new Date().toISOString();
                state.wsConnected = true;
                render();
                break;

            case "config":
                if (typeof message.lang === "string") {
                    state.envLang = message.lang.split("-")[0].toLowerCase();
                    if (!state.lang) {
                        applyI18n();
                    }
                    saveState();
                }
                break;

            case "task_update":
                if (message.task && typeof message.task === "object") {
                    const updatedTask = message.task;
                    const idx = state.tasks.findIndex(
                        (t) => t.id === updatedTask.id,
                    );
                    if (idx >= 0) {
                        state.tasks[idx] = {
                            ...state.tasks[idx],
                            ...updatedTask,
                        };
                    } else {
                        state.tasks.unshift(updatedTask);
                    }
                    state.lastUpdate = message.ts || new Date().toISOString();
                    render();
                }
                break;

            case "task_delete":
                if (typeof message.id === "number") {
                    state.tasks = state.tasks.filter(
                        (t) => t.id !== message.id,
                    );
                    state.lastUpdate =
                        message.ts || new Date().toISOString();
                    render();
                }
                break;

            case "model_health":
                if (Array.isArray(message.models)) {
                    state.modelHealth = message.models;
                    renderAgents();
                }
                break;

            case "ws_status":
                state.wsConnected = !!message.connected;
                updateHeader();
                saveState();
                break;

            case "comms":
                if (message.reset) {
                    state.comms = [];
                    if (window.CommsFeed) {
                        window.CommsFeed.setEntries([]);
                    }
                    saveState();
                    break;
                }
                if (Array.isArray(message.entries) && window.CommsFeed) {
                    message.entries.forEach((e) => {
                        state.comms.push(e);
                        window.CommsFeed.appendEntry(e);
                    });
                }
                break;

            case "clear_result":
                if (lastUpdateText) {
                    lastUpdateText.textContent = message.error
                        ? `${tr("err.purge")} : ${message.error}`
                        : `${message.deleted} ✓`;
                }
                break;
        }
    });

    // Premier rendu + handshake ready (récupère config/langue + snapshot)
    try {
        if (window.CommsFeed) {
            window.CommsFeed.mount(document.getElementById("comms-feed"));
            if (Array.isArray(state.comms)) {
                window.CommsFeed.setEntries(state.comms);
            }
            if (window.CommsFeed.onClear) {
                window.CommsFeed.onClear(() =>
                    vscode.postMessage({ command: "comms-clear" }),
                );
            }
        }
        applyI18n();
        applyColLayout();
        applyCollapsed();
        initTableInteractions();
        initSectionResizers();
        applySectionSizes();
        applyCommsHidden();
        render();
        vscode.postMessage({ command: "ready" });
    } catch (err) {
        showFatal(
            "init: " + (err && err.message) + "\n" + ((err && err.stack) || ""),
        );
    }
})();
