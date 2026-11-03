import os, json, subprocess, sys

DIR = r'F:\kaggle-dataset-comfyui-models'
FILES = {
    'checkpoints/ltx-video-2b-v0.9.5.safetensors':
        'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors',
    'checkpoints/RealVisXL_V5.0_fp16.safetensors':
        'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors',
    'checkpoints/DreamShaperXL_Turbo_v2.safetensors':
        'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo/resolve/main/DreamShaperXL_Turbo_v2.safetensors',
    'text_encoders/t5xxl_fp8_e4m3fn.safetensors':
        'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
}
LOG = os.path.join(DIR, '_download.log')

def log(m):
    print(m, flush=True)
    open(LOG, 'a', encoding='utf-8').write(m + '\n')

os.makedirs(DIR, exist_ok=True)
log('=== dataset build start ===')

for rel, url in FILES.items():
    dst = os.path.join(DIR, rel.replace('/', os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst) and os.path.getsize(dst) > 1_000_000:
        log('present: ' + rel)
        continue
    tmp = dst + '.part'
    log('dl: ' + rel)
    r = subprocess.run(['curl', '-L', '-C', '-', '-o', tmp, url], capture_output=True, text=True)
    sz = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    if r.returncode == 0 and sz > 1_000_000:
        os.replace(tmp, dst)
        log('ok: ' + rel + ' ' + str(sz))
    else:
        log('FAIL: ' + rel + ' rc=' + str(r.returncode) + ' size=' + str(sz) + ' ' + (r.stderr or '')[-150:])
        sys.exit(1)

meta = {
    'title': 'ComfyUI models',
    'id': 'lascardm/comfyui-models',
    'licenses': [{'name': 'other'}]
}
json.dump(meta, open(os.path.join(DIR, 'dataset-metadata.json'), 'w'), indent=1)
log('metadata ecrit, creation dataset...')
r = subprocess.run(['kaggle', 'datasets', 'create', '-p', DIR], capture_output=True, text=True)
log((r.stdout or '') + (r.stderr or ''))
if 'has been created' in (r.stdout or '') or 'already exists' in ((r.stdout or '') + (r.stderr or '')):
    log('=== dataset OK ===')
else:
    log('=== dataset creation incertaine, voir output ===')
