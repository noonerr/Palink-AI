import subprocess, json, sys

def psql(query):
    r = subprocess.run(
        ['docker', 'exec', 'palink-ai-db-1', 'psql', '-U', 'ai_user', '-d', 'ai_hub', '-t', '-A', '-c', query],
        capture_output=True, text=True, encoding='utf-8', errors='replace'
    )
    if r.returncode != 0:
        print('PSQL ERR:', r.stderr[:800], file=sys.stderr)
    return r.stdout

for cid in ['0297f83b-1f08-414f-ba90-59484bdff71e', 'e59751ed-772f-488e-be50-aeec2c9d7645']:
    print('='*80)
    print('CHAR:', cid)
    row = psql(f"SELECT name, first_mes, extensions FROM characters WHERE id='{cid}';")
    parts = row.split('|', 2)
    if len(parts) < 3:
        print('ROW:', row[:500])
        continue
    name, first_mes, ext = parts
    print('NAME:', name)
    print()
    print('--- FIRST_MES ---')
    print(first_mes[:3000])
    print()
    print('--- EXTENSIONS ---')
    try:
        ext_json = json.loads(ext)
        print(json.dumps(ext_json, ensure_ascii=False, indent=2)[:6000])
    except Exception as e:
        print('ext parse err', e)
        print(ext[:3000])
