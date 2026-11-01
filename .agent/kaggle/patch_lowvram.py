import json

nb = json.load(open('push-tmp.ipynb', encoding='utf-8'))
n = 0
for c in nb['cells']:
    s = c.get('source', [])
    for i, l in enumerate(s):
        if '--disable-cuda-malloc' in l and '--lowvram' not in l:
            s[i] = l.replace("'--disable-cuda-malloc'", "'--disable-cuda-malloc','--lowvram'")
            n += 1
json.dump(nb, open('push-tmp.ipynb', 'w', encoding='utf-8'), indent=1)
print('patched lines:', n)
