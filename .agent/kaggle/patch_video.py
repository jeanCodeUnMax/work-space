import os, subprocess as sp
F = r'F:/ComfyUI_windows_portable/ComfyUI/custom_nodes/comfyui-agy-providers/agy_provider_node.py'
src = open(F, encoding='utf-8').read()

old = '''    "kaggle": ["RealVisXL_V5.0_fp16.safetensors", "DreamShaperXL_Turbo_v2.safetensors"],'''
new = '''    "kaggle": ["RealVisXL_V5.0_fp16.safetensors", "DreamShaperXL_Turbo_v2.safetensors", "ltx-video-2b-v0.9.5.safetensors"],'''
assert old in src; src = src.replace(old, new)

old = "def _kaggle_comfy(ckpt, prompt, negative, mode, width=1024, height=1024, steps=25, cfg=7.0, seed=-1, image_path=None, denoise=1.0, lora_name='', lora_strength=1.0):"
new = "def _kaggle_comfy(ckpt, prompt, negative, mode, width=1024, height=1024, steps=25, cfg=7.0, seed=-1, image_path=None, denoise=1.0, lora_name='', lora_strength=1.0, frames=97, fps=25):"
assert old in src; src = src.replace(old, new)

old = '''    if mode != "image":
        return ("ERROR[kaggle]: le serveur Kaggle ne fait que des images", "", None)'''
new = '''    if mode not in ("image", "video"):
        return ("ERROR[kaggle]: mode non supporte (image|video)", "", None)
    if mode == "video":
        return _kaggle_video(ckpt, prompt, negative, base, token, width, height, frames, fps, seed, image_path, steps)'''
assert old in src; src = src.replace(old, new)

video_fn = '''
def _kaggle_video(ckpt, prompt, negative, base, token, width, height, frames, fps, seed, image_path, steps):
    import time, uuid, urllib.parse, io
    import torch
    from PIL import Image
    import numpy as np
    h = {"X-Hephaistos-Token": token, "User-Agent": "ComfyUI/0.7 (Hephaistos2-kit)"}
    core = {
        "44": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "38": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5xxl_fp16.safetensors", "type": "ltxv", "device": "default"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["38", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["38", 0]}},
        "73": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    }
    noise = {"add_noise": True, "noise_seed": seed if seed >= 0 else __import__("random").randint(0, 2**32 - 1),
             "control_after_generate": "randomize", "cfg": 3, "model": ["44", 0], "sampler": ["73", 0], "sigmas": ["71", 0]}
    if image_path:
        up = subprocess.run(["curl.exe", "-sS", "-X", "POST", base + "/upload/image",
            "-H", f"X-Hephaistos-Token: {token}", "-A", "ComfyUI/0.7 (Hephaistos2-kit)",
            "-F", f"image=@{image_path}", "-F", "overwrite=true"], capture_output=True, timeout=120)
        if up.returncode != 0:
            return (f"ERROR[kaggle]: upload image KO : {up.stderr.decode()[:200]}", "", None)
        try:
            remote_name = json.loads(up.stdout.decode()).get("name") or os.path.basename(image_path)
        except Exception:
            remote_name = os.path.basename(image_path)
        core["78"] = {"class_type": "LoadImage", "inputs": {"image": remote_name}}
        core["77"] = {"class_type": "LTXVImgToVideo", "inputs": {"positive": ["6", 0], "negative": ["7", 0],
            "vae": ["44", 2], "image": ["78", 0], "width": width, "height": height, "length": frames,
            "batch_size": 1, "strength": 0.15}}
        latent, pos, neg = ["77", 0], ["77", 1], ["77", 2]
    else:
        core["70"] = {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": width, "height": height,
            "length": frames, "batch_size": 1}}
        core["69"] = {"class_type": "LTXVConditioning", "inputs": {"frame_rate": fps,
            "positive": ["6", 0], "negative": ["7", 0]}}
        latent, pos, neg = ["70", 0], ["69", 0], ["69", 1]
    core["71"] = {"class_type": "LTXVScheduler", "inputs": {"steps": steps, "max_shift": 2.05,
        "base_shift": 0.95, "stretch": True, "terminal": 0.1, "latent": latent}}
    core["72"] = {"class_type": "SamplerCustom", "inputs": {**noise,
        "positive": pos, "negative": neg, "latent_image": latent}}
    core["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["72", 0], "vae": ["44", 2]}}
    core["99"] = {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "ltxv"}}
    r = json.loads(_curl(base + "/prompt", h, {"prompt": core, "client_id": str(uuid.uuid4())}, timeout=60).decode())
    pid = r["prompt_id"]
    deadline = time.time() + 3600
    while time.time() < deadline:
        hist = json.loads(_curl(f"{base}/history/{pid}", h, timeout=60).decode()).get(pid)
        if hist:
            st = hist.get("status", {})
            if st.get("status_str") == "error":
                return (f"ERROR[kaggle]: {str(st.get('messages'))[:300]}", "", None)
            outs = hist.get("outputs", {}).get("99", {}).get("images", [])
            if outs:
                frames_t = []
                for im in outs:
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    raw = _curl(f"{base}/view?{q}", h, timeout=180)
                    arr = np.asarray(Image.open(io.BytesIO(raw))).astype(np.float32) / 255.0
                    frames_t.append(torch.from_numpy(arr[..., :3]))
                return (f"OK kaggle video {len(outs)} frames", "", torch.stack(frames_t))
        time.sleep(5)
    return ("ERROR[kaggle]: timeout video (3600s)", "", None)

'''
anchor = "class AgyProviderRouter:"
assert anchor in src
src = src.replace(anchor, video_fn + anchor, 1)

old_w = '''            "lora_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),'''
new_w = '''            "lora_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
            "frames": ("INT", {"default": 97, "min": 9, "max": 257, "step": 8}),
            "fps": ("INT", {"default": 25, "min": 8, "max": 60}),'''
assert old_w in src; src = src.replace(old_w, new_w)

src = src.replace(
    "denoise=1.0, lora_name='', lora_strength=1.0):\n        text, url, img = self._run(prompt, provider, model, mode, images, negative_prompt, external_api_key, width, height, steps, cfg, seed, denoise, lora_name, lora_strength)",
    "denoise=1.0, lora_name='', lora_strength=1.0, frames=97, fps=25):\n        text, url, img = self._run(prompt, provider, model, mode, images, negative_prompt, external_api_key, width, height, steps, cfg, seed, denoise, lora_name, lora_strength, frames, fps)")
src = src.replace(
    "def _run(self, prompt, provider, model, mode, images=None, negative_prompt=\"\", external_api_key=\"\", width=1024, height=1024, steps=25, cfg=7.0, seed=-1, denoise=1.0, lora_name='', lora_strength=1.0):",
    "def _run(self, prompt, provider, model, mode, images=None, negative_prompt=\"\", external_api_key=\"\", width=1024, height=1024, steps=25, cfg=7.0, seed=-1, denoise=1.0, lora_name='', lora_strength=1.0, frames=97, fps=25):")
src = src.replace(
    "return _kaggle_comfy(model, prompt, negative_prompt, mode, width, height, steps, cfg, seed, image_path, denoise, lora_name, lora_strength)",
    "return _kaggle_comfy(model, prompt, negative_prompt, mode, width, height, steps, cfg, seed, image_path, denoise, lora_name, lora_strength, frames, fps)")
src = src.replace(
    'if img is None and mode == "image":',
    'if img is None and mode in ("image", "video"):')

open(F, 'w', encoding='utf-8').write(src)
sp.run(['python', '-m', 'py_compile', F], check=True)
print('video OK')
