import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
files = list((ROOT / 'crawler' / 'downloads_json').glob('*.json'))
reg_count = 0
for f in files:
    js = json.loads(f.read_text(encoding='utf-8'))
    st = js.get('recipeStatus', {}).get('status')
    if not st:
        st = 'UNKNOWN'
    if st == 'REGULAR':
        reg_count += 1
        print('REGULAR candidate:', f.name)
        print('status object:', js.get('recipeStatus'))
        print('localImage', js.get('localImage'))
        print('ingredients', len(js.get('ingredients', [])))
        print('steps', len(js.get('steps', [])))
        miss = []
        if not js.get('localImage'):
            miss.append('recipe')
        for i, ing in enumerate(js.get('ingredients', []), 1):
            if not ing.get('localImage'):
                miss.append(f'ingredient:{i}:{ing.get("id") or ing.get("name")}')
        for i, step in enumerate(js.get('steps', []), 1):
            if not step.get('images'):
                continue
            for j, img in enumerate(step.get('images', []), 1):
                if not img.get('localImage'):
                    miss.append(f'step:{i}:{j}')
        print('missing positions', miss)
        break

print('REGULAR total', reg_count)
