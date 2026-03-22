import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
v = json.loads((ROOT / 'crawler' / 'validated_recipes.json').read_text(encoding='utf-8'))
print('regular_count', v.get('regular_count'))
miss_list = []
for x in v.get('validated', []):
    fpath = ROOT / 'crawler' / 'downloads_json' / x['file']
    if not fpath.exists():
        miss_list.append((x['file'], 'missing file'))
        continue
    r = json.loads(fpath.read_text(encoding='utf-8'))
    if not r.get('localImage'):
        miss_list.append((x['file'], 'recipe image missing'))
        continue
    ing_miss = [ing for ing in r.get('ingredients', []) if not ing.get('localImage')]
    if ing_miss:
        miss_list.append((x['file'], 'ingredient images missing', [ing.get('id') or ing.get('name') for ing in ing_miss]))
        continue
    step_miss = []
    for i, step in enumerate(r.get('steps', []), start=1):
        if step.get('localImage'):
            continue
        images = step.get('images') or []
        if images and any(not img.get('localImage') for img in images):
            step_miss.append(i)
    if step_miss:
        miss_list.append((x['file'], 'step images missing', step_miss))

print('missing_count', len(miss_list))
for item in miss_list[:20]:
    print(item)
