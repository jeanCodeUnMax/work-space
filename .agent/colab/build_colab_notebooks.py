import json, os, sys

OUT = os.path.dirname(os.path.abspath(__file__))

# Secrets lus depuis les artefacts kaggle (memes identifiants)
TOKEN = os.environ.get('COMFY_AUTH_TOKEN', 'CHANGEME_TOKEN')
try:
    import re
    src = open(r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\push-tmp.ipynb', encoding='utf-8').read()
    m = re.search(r"COMFY_AUTH_TOKEN['\"]?\s*[=:]\s*['\"]([^'\"]{8,})['\"]", src)
    if m:
        TOKEN = m.group(1)
        print('token recupere de push-tmp.ipynb')
except Exception as e:
    print('token fallback:', e)

BOOT = r'''
import os, subprocess, sys, time, json, signal, threading

DRIVE = '/content/drive/MyDrive/ComfyUI-Models'
os.makedirs(DRIVE + '/checkpoints', exist_ok=True)
os.makedirs(DRIVE + '/text_encoders', exist_ok=True)

from google.colab import drive
drive.mount('/content/drive')

def _get(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 1_000_000:
        print('present:', os.path.basename(dst), os.path.getsize(dst))
        return
    tmp = dst + '.part'
    for i in range(4):
        r = subprocess.run(['curl','-L','--retry','3','-C','-','-o',tmp,url])
        if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 1_000_000:
            os.replace(tmp, dst)
            print('dl ok:', os.path.basename(dst))
            return
        time.sleep(5)
    raise RuntimeError('download KO: ' + url)

print('=== MODELES (persistants sur Drive) ===')
MODELS

print('=== COMFYUI ===')
if not os.path.exists('/content/ComfyUI'):
    subprocess.run(['git','clone','--depth','1','https://github.com/comfyanonymous/ComfyUI','/content/ComfyUI'], check=True)
subprocess.run([sys.executable,'-m','pip','install','-q','-r','/content/ComfyUI/requirements.txt','aiohttp','av'], check=True)

# Lien modeles Drive -> ComfyUI (pas de recopie disque)
os.makedirs('/content/ComfyUI/models/checkpoints', exist_ok=True)
os.makedirs('/content/ComfyUI/models/text_encoders', exist_ok=True)
for d in os.listdir(DRIVE + '/checkpoints'):
    s = DRIVE + '/checkpoints/' + d; t = '/content/ComfyUI/models/checkpoints/' + d
    if not os.path.exists(t): os.symlink(s, t)
for d in os.listdir(DRIVE + '/text_encoders'):
    s = DRIVE + '/text_encoders/' + d; t = '/content/ComfyUI/models/text_encoders/' + d
    if not os.path.exists(t): os.symlink(s, t)

# cloudflared
if not os.path.exists('/content/cloudflared'):
    _get('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', '/content/cloudflared.dl')
    os.rename('/content/cloudflared.dl', '/content/cloudflared')
    os.chmod('/content/cloudflared', 0o755)

# ComfyUI sur 8188
env = dict(os.environ)
p_comfy = subprocess.Popen([sys.executable,'/content/ComfyUI/main.py','--port','8188'], env=env,
                           stdout=open('/content/comfy.log','a'), stderr=subprocess.STDOUT)

# Tunnel Cloudflare NOMME (comfi.art-qalam.fr) si token dispo, sinon quick tunnel
TUNNEL_TOKEN = os.environ.get('CF_TUNNEL_TOKEN','')
if TUNNEL_TOKEN:
    p_tun = subprocess.Popen(['/content/cloudflared','tunnel','--no-autoupdate','run','--token',TUNNEL_TOKEN],
                             stdout=open('/content/tunnel.log','a'), stderr=subprocess.STDOUT)
else:
    p_tun = subprocess.Popen(['/content/cloudflared','tunnel','--url','http://127.0.0.1:8080','--no-autoupdate'],
                             stdout=open('/content/tunnel.log','a'), stderr=subprocess.STDOUT)

# Proxy :8080 -> :8188 avec token
AUTH = 'TOKEN_PLACEHOLDER'
from aiohttp import web, ClientSession
import asyncio
_last = [time.time()]
MAX_IDLE_S = float(os.environ.get('KERNEL_MAX_IDLE_SECONDS','7200'))

async def proxy(request):
    _last[0] = time.time()
    if request.path != '/' and request.headers.get('X-Hephaistos-Token') != AUTH:
        return web.Response(status=401, text='auth')
    async with ClientSession() as s:
        h = {k:v for k,v in request.headers.items() if k.lower() not in ('host','content-length','x-hephaistos-token')}
        body = await request.read()
        url = 'http://127.0.0.1:8188' + request.rel_url.path_qs
        async with s.request(request.method, url, headers=h, data=body) as up:
            return web.Response(status=up.status, body=await up.read(),
                                headers={k:v for k,v in up.headers.items() if k.lower() in ('content-type','content-encoding')})

async def watchdog():
    while True:
        await asyncio.sleep(30)
        if time.time() - _last[0] > MAX_IDLE_S:
            print('idle timeout, arret'); os.kill(os.getpid(), signal.SIGTERM)

async def amain():
    app = web.Application(); app.router.add_route('*','/{p:.*}',proxy)
    runner = web.AppRunner(app); await runner.setup()
    await web.TCPSite(runner,'0.0.0.0',8080).start()
    print('proxy pret'); await watchdog()

def _run():
    asyncio.run(amain())
threading.Thread(target=_run, daemon=True).start()
time.sleep(20)
print('=== BOOT OK ===')
'''

LTXV_MODELS = r'''
for rel,url in {
  'checkpoints/ltx-video-2b-v0.9.5.safetensors': 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors',
  'text_encoders/t5xxl_fp8_e4m3fn.safetensors': 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
}.items():
    _get(url, DRIVE + '/' + rel)
'''

# Wan2.2 TI2V 5B fp8 (Comfy-Org repack) + encodeur + VAE
WAN_MODELS = r'''
for rel,url in {
  'checkpoints/wan2.2_ti2v_5B_fp16.safetensors': 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
  'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  'checkpoints/Wan2_2_VAE_bf16.safetensors': 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
}.items():
    _get(url, DRIVE + '/' + rel)
'''

KEEPALIVE = '''
import time
print('Runtime actif. Les rendus se pilotent depuis le poste local via le tunnel.')
print('Tunnel log:'); print(open('/content/tunnel.log').read()[-2000:])
while True:
    time.sleep(300)
    print('alive', time.strftime('%H:%M:%S'), flush=True)
'''

def nb(boot_models, name):
    boot = BOOT.replace('MODELS', boot_models).replace('TOKEN_PLACEHOLDER', TOKEN)
    n = {
        'nbformat': 4, 'nbformat_minor': 5,
        'metadata': {'colab': {'name': name, 'provenance': []},
                     'kernelspec': {'name': 'python3'}, 'accelerator': 'GPU'},
        'cells': [
            {'cell_type': 'markdown', 'metadata': {}, 'source': [
                f'# {name}\n',
                'ComfyUI distant — modeles persistants sur Google Drive (`ComfyUI-Models/`).\n',
                'Executer: Runtime > Run all. Le tunnel sort dans `tunnel.log`.']},
            {'cell_type': 'code', 'metadata': {}, 'source': [boot], 'execution_count': None, 'outputs': []},
            {'cell_type': 'code', 'metadata': {}, 'source': [KEEPALIVE], 'execution_count': None, 'outputs': []},
        ]}
    p = os.path.join(OUT, name + '.ipynb')
    json.dump(n, open(p, 'w', encoding='utf-8'), indent=1)
    for c in n['cells']:
        if c['cell_type'] == 'code':
            compile(''.join(c['source']), name, 'exec')
    print('OK', p)
    return p

nb(LTXV_MODELS, 'comfyui-colab-ltxv')
nb(WAN_MODELS, 'comfyui-colab-wan22')
