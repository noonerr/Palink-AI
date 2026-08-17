import json
with open(r'C:\Users\Pall\chara.txt', encoding='utf-8') as f:
    data = f.read()
th = json.loads(data).get('tavern_helper') if data.startswith('{') else None
if th is None:
    # 可能整个是 extensions 对象
    try:
        ext = json.loads(data)
        th = ext.get('tavern_helper')
    except Exception as e:
        print('parse err', e)
        print(data[:500])
        raise SystemExit
if th is None:
    print('!!! no tavern_helper. keys:', list(json.loads(data).keys())[:20])
    raise SystemExit
print('th keys:', list(th.keys()))
scripts = th.get('scripts', [])
for i, s in enumerate(scripts):
    print(f'--- script[{i}] name={s.get("name")} type={s.get("type")} enabled={s.get("enabled")} len={len(s.get("content",""))}')
    print(s.get('content','')[:600])
print('variables:', json.dumps(th.get('variables', {}), ensure_ascii=False)[:800])