import sys

filepath = '/home/azureuser/frp-platform/server/frp_manager.py'
with open(filepath, 'r') as f:
    content = f.read()

old = '''        lines.append(
            f'name = "user_{
                tunnel["user_id"]}_tunnel_{
                tunnel["id"]}"')'''

new = '''        name_str = f'user_{tunnel["user_id"]}_tunnel_{tunnel["id"]}'
        lines.append(f'name = "{name_str}"')'''

if old in content:
    content = content.replace(old, new)
    with open(filepath, 'w') as f:
        f.write(content)
    print('Fixed frp_manager.py')
else:
    print('Pattern not found, checking line by line...')
    lines = content.split('\n')
    for i, line in enumerate(lines, 1):
        if 'user_{' in line and 'tunnel_' in line:
            print(f'Line {i}: {repr(line)}')
