import json

nb = json.load(open('push-tmp.ipynb', encoding='utf-8'))
n = 0
for c in nb['cells']:
    s = c.get('source', [])
    for i, l in enumerate(s):
        if "'--lowvram'," in l:
            s[i] = l.replace("'--lowvram',", "")
            n += 1

# add swapfile creation at top of cell 0 (inside try, after _mark START)
c0 = nb['cells'][0]
src = c0['source']
for i, l in enumerate(src):
    if "_mark('START" in l:
        src.insert(i + 1, "    import subprocess as _sp\n")
        src.insert(i + 2, "    _sp.run('fallocate -l 16G /kaggle/working/swapfile 2>/dev/null || dd if=/dev/zero of=/kaggle/working/swapfile bs=1M count=16384', shell=True)\n")
        src.insert(i + 3, "    _sp.run('chmod 600 /kaggle/working/swapfile; mkswap /kaggle/working/swapfile; swapon /kaggle/working/swapfile || true', shell=True)\n")
        src.insert(i + 4, "    _mark('SWAP ' + _sp.run(['bash','-c','free -h | grep Swap'],capture_output=True,text=True).stdout.strip())\n")
        break

json.dump(nb, open('push-tmp.ipynb', 'w', encoding='utf-8'), indent=1)
print('lowvram removed:', n)
