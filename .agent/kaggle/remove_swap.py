import json

nb = json.load(open('push-tmp.ipynb', encoding='utf-8'))
c0 = nb['cells'][0]
src = [l for l in c0['source'] if 'swapfile' not in l and 'mkswap' not in l
       and 'SWAP ' not in l and 'free -h' not in l]
c0['source'] = src
json.dump(nb, open('push-tmp.ipynb', 'w', encoding='utf-8'), indent=1)
print('swap lines removed:', 'swapfile' not in ''.join(src))
