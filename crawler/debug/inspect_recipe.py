import json
from pathlib import Path

fn='Lomo marinado en salsa de chalota.json'
ROOT = Path(__file__).resolve().parents[2]
path = ROOT / 'crawler' / 'downloads_json' / fn
r=json.loads(path.read_text(encoding='utf-8'))
print('localImage', r.get('localImage'))
print('ingredient count', len(r.get('ingredients', [])))
for i,ing in enumerate(r.get('ingredients',[]),1):
    if not ing.get('localImage'):
        print('missing ingredient', i, ing.get('id'), ing.get('name'))
        print(ing)
print('step images:')
for i,s in enumerate(r.get('steps',[]),1):
    if s.get('images'):
        for j,img in enumerate(s.get('images',[]),1):
            if not img.get('localImage'):
                print('step', i, 'image', j, 'missing')
