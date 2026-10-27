import * as vscode from 'vscode';

/**
 * Panneau ComfyUI — embarque le frontend local du serveur ComfyUI dans une
 * webview iframe (éditeur de nœuds, queue, preview des générations).
 * Le mode est ouvert via la commande hephaistosChats.openComfyUI ou le
 * bouton « ComfyUI » de la vue workspace.
 */
export class ComfyUIPanel {
    private static current: vscode.WebviewPanel | undefined;

    static open(context: vscode.ExtensionContext): void {
        const url = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
        if (ComfyUIPanel.current) {
            ComfyUIPanel.current.reveal(vscode.ViewColumn.Active);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'hephaistosComfyui',
            'ComfyUI — studio local',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        ComfyUIPanel.current = panel;
        panel.onDidDispose(() => { ComfyUIPanel.current = undefined; });
        panel.webview.html = ComfyUIPanel.render(url);
    }

    private static render(url: string): string {
        return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${url} http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline';">
<style>html,body{margin:0;height:100%;background:#1e1e1e}
#bar{display:flex;align-items:center;gap:10px;padding:6px 10px;font:12px system-ui;color:#ccc;background:#252526;border-bottom:1px solid #333}
#bar input{flex:1;background:#1b1b1b;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 8px}
#bar button{background:#3a3d41;color:#ddd;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}
iframe{width:100%;height:calc(100% - 34px);border:0}</style></head>
<body>
<div id="bar">
  <span>ComfyUI</span>
  <input id="u" value="${url}" />
  <button id="go">Connecter</button>
  <button id="rel">Recharger</button>
</div>
<iframe id="f" src="${url}"></iframe>
<script>
const f=document.getElementById('f'),u=document.getElementById('u');
document.getElementById('go').onclick=()=>{f.src=u.value.trim()};
document.getElementById('rel').onclick=()=>{f.src=f.src};
</script>
</body></html>`;
    }
}
