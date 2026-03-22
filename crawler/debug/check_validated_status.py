import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
v = json.loads((ROOT / 'crawler' / 'validated_recipes.json').read_text(encoding='utf-8'))
for item in v['validated']:
    if item['file'] == 'Lomo marinado en salsa de chalota.json':
        print('item', item)
        break
print('counts', v['ok_count'], v['regular_count'], v['fail_count'], v['unknown_count'])
