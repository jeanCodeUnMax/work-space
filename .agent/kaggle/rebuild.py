import json, os
def code(lines): return {"cell_type":"code","execution_count":None,"metadata":{},"outputs":[],"source":lines}
def md(lines): return {"cell_type":"markdown","metadata":{},"source":lines}
cells = [
 md(["# ComfyUI Kaggle + tunnel securise\n","Secret : `HEPHAISTOS_TOKEN` (injecte ou Kaggle Secret). Fin = URL cloudflared."]),
 code([
  "import os, subprocess, sys\n",
  "os.chdir('/kaggle/working')\n",
  "if not os.path.exists('ComfyUI'):\n",
  "    subprocess.run(['git','clone','--depth','1','https://github.com/comfyanonymous/ComfyUI.git'],check=True)\n",
  "subprocess.run([sys.executable,'-m','pip','install','-q','-r','ComfyUI/requirements.txt'],check=True)\n",
  "subprocess.run([sys.executable,'-m','pip','install','-q','aiohttp','huggingface_hub'],check=True)\n",
  "print('install ok')"]),
 code([
  "from huggingface_hub import hf_hub_download\n",
  "os.makedirs('/kaggle/working/ComfyUI/models/checkpoints', exist_ok=True)\n",
  "p = hf_hub_download('stabilityai/stable-diffusion-xl-base-1.0','sd_xl_base_1.0.safetensors',\n",
  "    local_dir='/kaggle/working/ComfyUI/models/checkpoints')\n",
  "print('ckpt:', p)"]),
 code([
  "import os, threading, subprocess, sys, time, asyncio, signal\n",
  "from aiohttp import web, ClientSession\n",
  "try:\n",
  "    from kaggle_secrets import UserSecretsClient\n",
  "    TOKEN = UserSecretsClient().get_secret('HEPHAISTOS_TOKEN')\n",
  "except Exception:\n",
  "    TOKEN = os.environ.get('HEPHAISTOS_TOKEN') or '__KAGGLE_COMFY_TOKEN__'\n",
  "comfy = subprocess.Popen([sys.executable,'main.py','--listen','127.0.0.1','--port','8188'],\n",
  "    cwd='/kaggle/working/ComfyUI', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n",
  "async def proxy(req):\n",
  "    if req.headers.get('X-Hephaistos-Token') != TOKEN:\n",
  "        return web.Response(status=401, text='bad token')\n",
  "    async with ClientSession() as s:\n",
  "        url = 'http://127.0.0.1:8188' + req.path_qs\n",
  "        body = await req.read() if req.can_read_body else None\n",
  "        async with s.request(req.method, url, data=body,\n",
  "            headers={k:v for k,v in req.headers.items() if k.lower() not in ('host','x-hephaistos-token')}) as up:\n",
  "            return web.Response(status=up.status, body=await up.read(),\n",
  "                headers={k:v for k,v in up.headers.items() if k.lower() not in ('content-encoding','content-length','transfer-encoding')})\n",
  "async def shutdown(req):\n",
  "    if req.headers.get('X-Hephaistos-Token') != TOKEN:\n",
  "        return web.Response(status=401, text='bad token')\n",
  "    threading.Timer(2.0, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()\n",
  "    return web.Response(text='extinction dans 2s')\n",
  "async def main():\n",
  "    app = web.Application()\n",
  "    app.router.add_route('*','/shutdown',shutdown)\n",
  "    app.router.add_route('*','/{path:.*}',proxy)\n",
  "    r = web.AppRunner(app); await r.setup()\n",
  "    await web.TCPSite(r,'0.0.0.0',8080).start()\n",
  "    print('proxy pret :8080')\n",
  "threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()\n",
  "MAX_H = float(os.environ.get('KERNEL_MAX_HOURS','8'))\n",
  "threading.Timer(MAX_H*3600, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()\n",
  "print('auto-extinction dans', MAX_H, 'h')\n",
  "time.sleep(15); print('comfy pid', comfy.pid)"]),
 code([
  "import subprocess, re, time, threading, os\n",
  "if not os.path.exists('/kaggle/working/cloudflared'):\n",
  "    subprocess.run(['wget','-q','https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64','-O','/kaggle/working/cloudflared'],check=True)\n",
  "    subprocess.run(['chmod','+x','/kaggle/working/cloudflared'],check=True)\n",
  "proc = subprocess.Popen(['/kaggle/working/cloudflared','tunnel','--url','http://127.0.0.1:8080'],\n",
  "    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n",
  "url = [None]\n",
  "def pump():\n",
  "    for line in proc.stdout:\n",
  "        m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)\n",
  "        if m and not url[0]:\n",
  "            url[0] = m.group(0)\n",
  "            print('TUNNEL:', url[0])\n",
  "threading.Thread(target=pump, daemon=True).start()\n",
  "for _ in range(30):\n",
  "    if url[0]: break\n",
  "    time.sleep(2)\n",
  "print('>>> KAGGLE_COMFY_URL =', url[0])"]),
 md(["Relance = nouvelle URL a remettre dans KAGGLE_COMFY_URL. `/shutdown` token-gated ou `kaggle kernels stop`."]),
]
nb = {"cells":cells,"metadata":{"kernelspec":{"display_name":"Python 3","language":"python","name":"python3"},"language_info":{"name":"python","version":"3.10"},"kaggle":{"accelerator":"gpu","isInternetEnabled":True}},"nbformat":4,"nbformat_minor":5}
tok = os.environ.get('KAGGLE_COMFY_TOKEN','')
s = json.dumps(nb, indent=1)
open('comfyui-kaggle.ipynb','w',encoding='utf-8').write(s)
open('push-tmp.ipynb','w',encoding='utf-8').write(s.replace('__KAGGLE_COMFY_TOKEN__', tok) if tok else s)
open('kernel-metadata.json','w').write('{"id":"lascardm/comfyui-batch-gpu","title":"ComfyUI batch GPU","code_file":"push-tmp.ipynb","language":"python","kernel_type":"notebook","is_private":true,"enable_gpu":true,"enable_internet":true,"category_ids":[],"dataset_sources":[],"competition_sources":[],"kernel_sources":[]}')
print('rebuilt ok, token injecte:', bool(tok))
