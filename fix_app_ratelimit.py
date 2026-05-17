filepath = '/home/azureuser/frp-platform/server/app.py'
with open(filepath, 'r') as f:
    content = f.read()

content = content.replace(
    'auth_bp.view_functions.get("get_signin")',
    'app.view_functions.get("auth.get_signin")'
)
content = content.replace(
    'auth_bp.view_functions.get("callback")',
    'app.view_functions.get("auth.callback")'
)
content = content.replace(
    'auth_bp.view_functions.get("logout")',
    'app.view_functions.get("auth.logout")'
)
content = content.replace(
    'auth_bp.view_functions.get("get_sessions")',
    'app.view_functions.get("auth.get_sessions")'
)
content = content.replace(
    'auth_bp.view_functions.get("revoke_session")',
    'app.view_functions.get("auth.revoke_session")'
)
content = content.replace(
    'auth_bp.view_functions.get("revoke_all_sessions")',
    'app.view_functions.get("auth.revoke_all_sessions")'
)
content = content.replace(
    'auth_bp.view_functions.get("health")',
    'app.view_functions.get("auth.health")'
)
content = content.replace(
    'auth_bp.view_functions.get("get_current_user")',
    'app.view_functions.get("auth.get_current_user")'
)
content = content.replace(
    'auth_bp.view_functions.get("token_login")',
    'app.view_functions.get("auth.token_login")'
)
content = content.replace(
    'tunnels_bp.view_functions.get("get_tunnels")',
    'app.view_functions.get("tunnels.get_tunnels")'
)
content = content.replace(
    'tunnels_bp.view_functions.get("create_tunnel")',
    'app.view_functions.get("tunnels.create_tunnel")'
)
content = content.replace(
    'tunnels_bp.view_functions.get("delete_tunnel")',
    'app.view_functions.get("tunnels.delete_tunnel")'
)
content = content.replace(
    'tunnels_bp.view_functions.get("get_tunnel_status")',
    'app.view_functions.get("tunnels.get_tunnel_status")'
)
content = content.replace(
    'tunnels_bp.view_functions.get("start_tunnel")',
    'app.view_functions.get("tunnels.start_tunnel")'
)
content = content.replace(
    'tunnels_bp.view_functions.get("stop_tunnel")',
    'app.view_functions.get("tunnels.stop_tunnel")'
)
content = content.replace(
    'tunnel_groups_bp.view_functions.get("get_tunnel_groups")',
    'app.view_functions.get("tunnel_groups.get_tunnel_groups")'
)
content = content.replace(
    'tunnel_groups_bp.view_functions.get("create_tunnel_group")',
    'app.view_functions.get("tunnel_groups.create_tunnel_group")'
)
content = content.replace(
    'tunnel_groups_bp.view_functions.get("delete_tunnel_group")',
    'app.view_functions.get("tunnel_groups.delete_tunnel_group")'
)
content = content.replace(
    'tunnel_groups_bp.view_functions.get("start_tunnel_group")',
    'app.view_functions.get("tunnel_groups.start_tunnel_group")'
)
content = content.replace(
    'tunnel_groups_bp.view_functions.get("stop_tunnel_group")',
    'app.view_functions.get("tunnel_groups.stop_tunnel_group")'
)
content = content.replace(
    'admin_bp.view_functions.get("get_all_users")',
    'app.view_functions.get("admin.get_all_users")'
)
content = content.replace(
    'admin_bp.view_functions.get("update_user_role")',
    'app.view_functions.get("admin.update_user_role")'
)
content = content.replace(
    'admin_bp.view_functions.get("delete_user")',
    'app.view_functions.get("admin.delete_user")'
)
content = content.replace(
    'admin_bp.view_functions.get("get_system_stats")',
    'app.view_functions.get("admin.get_system_stats")'
)
content = content.replace(
    'admin_bp.view_functions.get("get_audit_logs")',
    'app.view_functions.get("admin.get_audit_logs")'
)
content = content.replace(
    'admin_bp.view_functions.get("get_port_pool")',
    'app.view_functions.get("admin.get_port_pool")'
)
content = content.replace(
    'admin_bp.view_functions.get("update_port_status")',
    'app.view_functions.get("admin.update_port_status")'
)
content = content.replace(
    'devices_bp.view_functions.get("get_devices")',
    'app.view_functions.get("devices.get_devices")'
)
content = content.replace(
    'devices_bp.view_functions.get("register_device")',
    'app.view_functions.get("devices.register_device")'
)
content = content.replace(
    'devices_bp.view_functions.get("delete_device")',
    'app.view_functions.get("devices.delete_device")'
)
content = content.replace(
    'devices_bp.view_functions.get("heartbeat")',
    'app.view_functions.get("devices.heartbeat")'
)
content = content.replace(
    'devices_bp.view_functions.get("get_device_tunnels")',
    'app.view_functions.get("devices.get_device_tunnels")'
)

with open(filepath, 'w') as f:
    f.write(content)
print('Fixed app.py rate limiter view_functions references')
