import re

filepath = '/home/azureuser/frp-platform/server/app.py'
with open(filepath, 'r') as f:
    content = f.read()

bp_name_map = {
    'auth_bp': 'auth',
    'tunnels_bp': 'tunnels',
    'tunnel_groups_bp': 'tunnel_groups',
    'admin_bp': 'admin',
    'devices_bp': 'devices',
}

def replace_view_functions(match):
    bp_var = match.group(1)
    func_name = match.group(2)
    bp_name = bp_name_map.get(bp_var)
    if bp_name:
        return f'app.view_functions.get("{bp_name}.{func_name}")'
    return match.group(0)

pattern = r'(\w+_bp)\.view_functions\.get\("(\w+)"\)'
content = re.sub(pattern, replace_view_functions, content)

with open(filepath, 'w') as f:
    f.write(content)

remaining = re.findall(r'\w+_bp\.view_functions\.get', content)
if remaining:
    print(f'Warning: {len(remaining)} unresolved bp.view_functions references remain')
else:
    print('All view_functions references fixed')
