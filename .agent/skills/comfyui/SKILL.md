---
name: comfyui
description: Piloter l'instance ComfyUI locale (workflows, queue, génération, modèles, LoRA, custom nodes) via l'API HTTP/WS sur 8188, le proxy 8189 ou le CLI cli-anything-comfyui. Use when comfyui, génération d'image, workflow comfyui, custom node, LoRA, Stable Diffusion, Flux, ou intégration extension hephaistos-chats.
triggers:
  - comfyui
  - /comfyui
  - comfy
  - workflow comfyui
  - custom node comfyui
  - lora comfyui
---

Piloter ComfyUI local — `C:\data-sys\ComfyUI` (v0.43, RTX 4060 Ti 16Go, PyTorch cu128).

## Chaîne de connexion

- **Backend** : `http://127.0.0.1:8188` — `.venv\Scripts\python main.py` via `run_comfyui.bat` ou `comfyui-watchdog.ps1` (détaché, auto-restart).
- **Proxy iframe** : `http://127.0.0.1:8189` (`comfyui-proxy.mjs`) — strip X-Frame-Options + CORS *, obligatoire pour l'onglet extension (webview bloque http:// direct).
- **Santé** : `GET /system_stats` ; **schéma nodes** : `GET /object_info` ; **WS** : `/ws?clientId=X`.

## CLI-Anything

```bash
cd C:\data-sys\CLI-Anything\comfyui\agent-harness
python cli_anything/comfyui/comfyui_cli.py --url http://127.0.0.1:8188 system info
python cli_anything/comfyui/comfyui_cli.py models list --json
python cli_anything/comfyui/comfyui_cli.py queue list
python cli_anything/comfyui/comfyui_cli.py workflow run <wf.json>
```

Groupes : `system`, `models`, `queue`, `workflow`, `images`, `repl`.

## API directe

```bash
curl http://127.0.0.1:8188/system_stats
curl -X POST http://127.0.0.1:8188/prompt -H "Content-Type: application/json" -d @prompt.json
curl http://127.0.0.1:8188/history/<prompt_id>
curl "http://127.0.0.1:8188/view?filename=X&type=output" -o out.png
```

## Custom nodes & LoRA

- 9 skills dev : `comfyui-node-{basics,inputs,outputs,datatypes,lifecycle,advanced,frontend,packaging,migration}` — API V3 `define_schema`, `io.Schema`, `comfy_entrypoint`.
- LoRA : `models\loras\`, node `Load LoRA` en série entre Checkpoint et KSampler, `strength_model`/`strength_clip` ≈ 0.6-1.0, chaînage multi-LoRA.
- Doc complète : `Documentation/ComfyUI/` du vault cerveau-AI (README, node-dev, lora, local-setup) + `C:\data-sys\ComfyUI\docs\` + https://docs.comfy.org.

## Règles

- Ne jamais réinstaller ComfyUI — utiliser l'existant `C:\data-sys\ComfyUI`.
- Serveur down → relancer via `comfyui-watchdog.ps1` (détaché), jamais un shell temporaire.
- Onglet extension noir → vérifier proxy 8189 UP, pas seulement 8188.
- AGENTS.md du repo : changements minimaux, pas de nouvelles dépendances, style existant.
