import json

nb = json.load(open('push-tmp.ipynb', encoding='utf-8'))

BOOT = (
    "import os as _os, traceback as _tb\n"
    "def _mark(m):\n"
    "    _os.makedirs('/kaggle/working', exist_ok=True)\n"
    "    open('/kaggle/working/_bootlog.txt','a').write(m+'\\n')\n"
    "    print(m, flush=True)\n"
    "try:\n"
)
WRAP_END = (
    "except Exception:\n"
    "    open('/kaggle/working/_bootlog.txt','a').write('FATAL:\\n'+_tb.format_exc())\n"
    "    raise\n"
)

marks = {0: 'ETAPE1', 1: 'ETAPE2', 2: 'ETAPE3', 3: 'ETAPE4', 4: 'ETAPE5'}
for i, c in enumerate(nb['cells']):
    if c['cell_type'] != 'code':
        continue
    src = ''.join(c['source'])
    indented = "\n".join("    " + l if l.strip() else l for l in src.splitlines())
    wrapped = BOOT + indented + "\n" + WRAP_END
    lines = [l + '\n' for l in wrapped.splitlines()]
    for j, l in enumerate(lines):
        if l.strip() == 'try:':
            lines.insert(j + 1, "    _mark('START " + marks.get(i, str(i)) + "')\n")
            break
    c['source'] = lines

json.dump(nb, open('push-tmp.ipynb', 'w', encoding='utf-8'), indent=1)
print('instrumentiert, cells:', len(nb['cells']))
