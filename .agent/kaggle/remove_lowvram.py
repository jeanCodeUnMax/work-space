import json

nb = json.load(open('push-tmp.ipynb', encoding='utf-8'))
n = 0
for c in nb['cells']:
    for i, l in enumerate(c.get('source', [])):
        if "'--lowvram'" in l:
            c['source'][i] = l.replace(",'--lowvram'", '')
            n += 1
json.dump(nb, open('push-tmp.ipynb', 'w', encoding='utf-8'), indent=1)
print('removed', n)
