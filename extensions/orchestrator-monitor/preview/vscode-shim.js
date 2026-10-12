/* Shim navigateur : remplace l'API VS Code webview et connecte panel.js
   directement au bridge WS ws://127.0.0.1:7477 (poll orchestrator.db).
   Usage : preview standalone du dashboard (dev/inspection d'éléments). */
(function () {
    'use strict';
    const WS_URL = 'ws://127.0.0.1:7477';
    let ws = null;
    let queue = [];

    function pushToPanel(data) {
        window.dispatchEvent(new MessageEvent('message', { data }));
    }

    function connect() {
        try {
            ws = new WebSocket(WS_URL);
            ws.onopen = () => {
                console.log('[shim] WS connected');
                pushToPanel({ type: 'ws_status', connected: true });
                queue.forEach(m => { try { ws.send(m); } catch (e) { } });
                queue = [];
            };
            ws.onmessage = (ev) => {
                try { pushToPanel(JSON.parse(ev.data)); }
                catch (e) { console.error('[shim] bad ws msg', e); }
            };
            ws.onclose = () => {
                pushToPanel({ type: 'ws_status', connected: false });
                setTimeout(connect, 5000);
            };
            ws.onerror = () => { ws.close(); };
        } catch (e) {
            pushToPanel({ type: 'ws_status', connected: false });
            setTimeout(connect, 5000);
        }
    }

    const state = JSON.parse(localStorage.getItem('orchmon-state') || 'null');

    window.acquireVsCodeApi = function () {
        return {
            getState: () => state,
            setState: (s) => { try { localStorage.setItem('orchmon-state', JSON.stringify(s)); } catch (e) { } },
            postMessage: (msg) => {
                if (!msg || typeof msg !== 'object') return;
                switch (msg.command) {
                    case 'ready':
                    case 'refresh':
                        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ command: 'refresh' }));
                        else queue.push(JSON.stringify({ command: 'refresh' }));
                        pushToPanel({ type: 'config', lang: navigator.language || 'en' });
                        break;
                    case 'clear_tasks': {
                        const payload = JSON.stringify({ command: 'clear_tasks', statuses: msg.statuses || [] });
                        if (ws && ws.readyState === 1) ws.send(payload); else queue.push(payload);
                        break;
                    }
                    case 'provider_toggle': {
                        const payload = JSON.stringify({ command: 'provider_toggle', provider: msg.provider, enabled: !!msg.enabled });
                        if (ws && ws.readyState === 1) ws.send(payload); else queue.push(payload);
                        break;
                    }
                    case 'provider_order': {
                        const payload = JSON.stringify({ command: 'provider_order', order: msg.order || [] });
                        if (ws && ws.readyState === 1) ws.send(payload); else queue.push(payload);
                        break;
                    }
                    case 'send_to_chat':
                        // Pas de chat Devin dans le navigateur : copie presse-papier
                        navigator.clipboard?.writeText(msg.text || '').catch(() => { });
                        console.log('[shim] send_to_chat → clipboard:', (msg.text || '').slice(0, 80));
                        break;
                    case 'open_full_panel':
                    case 'restart_bridge':
                    case 'openFile':
                        console.log('[shim] commande IDE non dispo dans le navigateur:', msg.command);
                        break;
                }
            }
        };
    };

    connect();
})();
