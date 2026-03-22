import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
p = ROOT / 'crawler' / 'downloads_json' / 'Lomo marinado en salsa de chalota.json'
if not p.exists():
    print('missing file')
    raise SystemExit
r = json.loads(p.read_text(encoding='utf-8'))
print('recipeStatus', r.get('recipeStatus'))
print('localImage', r.get('localImage'))
for i, ing in enumerate(r.get('ingredients', []), 1):
    if not ing.get('localImage'):
        print('missing ingredient', i, ing.get('id'), ing.get('name'), 'link', ing.get('imageLink'), 'path', ing.get('imagePath'))
print('steps', len(r.get('steps', [])))
for i, s in enumerate(r.get('steps', []), 1):
    if s.get('images'):
        for j, img in enumerate(s.get('images', []), 1):
            if not img.get('localImage'):
                print('step', i, j, 'missing', 'link', img.get('link'), 'path', img.get('path'))
