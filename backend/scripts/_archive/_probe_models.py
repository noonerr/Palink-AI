# -*- coding: utf-8 -*-
"""查询 opencode.ai 支持的模型列表"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import json
import httpx

prov = json.load(open('/app/data/providers.json', encoding='utf-8'))[0]
r = httpx.get(prov['base_url'].rstrip('/') + '/models', headers={'Authorization': f"Bearer {prov['api_key']}"}, timeout=30)
print('status:', r.status_code)
try:
    data = r.json()
    ids = [m.get('id') for m in data.get('data', [])]
    print('models:', json.dumps(ids, ensure_ascii=False, indent=1))
except Exception as e:
    print('parse error:', e)
    print(r.text[:500])