import os

BASE = r"C:\Users\Pall\OneDrive\桌面\frp\server\routes"

admin_py = r'''"""
管理员 API 路由

提供用户管理、系统配置、审计日志查询等管理功能
"""
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from models import get_db, log_audit
from rbac import require_role, require_permission, Role, Permission, get_user_role
from config import MAX_TUNNELS_PER_USER

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


@admin_bp.route("/users", methods=["GET"])
@jwt_required()
@require_permission(Permission.VIEW_ALL_USERS)
def get_all_users():
    """获取所有用户列表（管理员）"""
    conn = get_db()
    cursor = conn.cursor()

    # 分页参数
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 20, type=int)
    per_page = min(per_page, 100)  # 最多 100 条

    offset = (page - 1) * per_page

    # 查询用户
    cursor.execute(
        """SELECT id, username, email, role, tunnel_quota, created_at,
           last_login_at, last_login_ip, failed_login_attempts
           FROM users
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?""",
        (per_page, offset)
    )
    users = cursor.fetchall()

    # 查询总数
    cursor.execute("SELECT COUNT(*) as total FROM users")
    total = cursor.fetchone()["total"]

    # 查询每个用户的隧道数量
    result = []
    for user in users:
        cursor.execute(
            "SELECT COUNT(*) as cnt FROM tunnels WHERE user_id = ? AND status = 'active'",
            (user["id"],)
        )
        tunnel_count = cursor.fetchone()["cnt"]

        result.append({
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": user["role"],
            "tunnel_quota": user["tunnel_quota"] or MAX_TUNNELS_PER_USER,
            "tunnel_count": tunnel_count,
            "created_at": user["created_at"],
            "last_login_at": user["last_login_at"],
            "last_login_ip": user["last_login_ip"],
            "failed_login_attempts": user["failed_login_attempts"],
        })

    conn.close()

    return jsonify({
        "users": result,
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": total,
            "pages": (total + per_page - 1) // per_page
        }
    }), 200


@admin_bp.route("/users/<int:user_id>", methods=["GET"])
@jwt_required()
@require_permission(Permission.VIEW_ALL_USERS)
def get_user_detail(user_id):
    """获取用户详细信息（管理员）"""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """SELECT id, username, email, role, tunnel_quota, token, created_at,
           last_login_at, last_login_ip, failed_login_attempts, locked_until
           FROM users WHERE id = ?""",
        (user_id,)
    )
    user = cursor.fetchone()

    if not user:
        conn.close()
        return jsonify({"error": "用户不存在"}), 404

    # 查询隧道
    cursor.execute(
        "SELECT * FROM tunnels WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,)
    )
    tunnels = cursor.fetchall()

    conn.close()

    return jsonify({
        "user": {
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": user["role"],
            "tunnel_quota": user["tunnel_quota"] or MAX_TUNNELS_PER_USER,
            "token": user["token"],
            "created_at": user["created_at"],
            "last_login_at": user["last_login_at"],
            "last_login_ip": user["last_login_ip"],
            "failed_login_attempts": user["failed_login_attempts"],
            "locked_until": user["locked_until"],
        },
        "tunnels": [
            {
                "id": t["id"],
                "local_port": t["local_port"],
                "server_port": t["server_port"],
                "protocol": t["protocol"],
                "status": t["status"],
                "name": t["name"],
                "created_at": t["created_at"],
            }
            for t in tunnels
        ]
    }), 200


@admin_bp.route("/users/<int:user_id>/role", methods=["PUT"])
@jwt_required()
@require_permission(Permission.CHANGE_USER_ROLE)
def change_user_role(user_id):
    """修改用户角色（管理员）"""
    admin_id = int(get_jwt_identity())
    data = request.get_json()

    if not data or "role" not in data:
        return jsonify({"error": "缺少角色参数"}), 400

    new_role = data["role"]

    # 验证角色
    if new_role not in [Role.ADMIN, Role.USER, Role.GUEST]:
        return jsonify({"error": "无效的角色"}), 400

    # 不能修改自己的角色
    if user_id == admin_id:
        return jsonify({"error": "不能修改自己的角色"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT username, role FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()

    if not user:
        conn.close()
        return jsonify({"error": "用户不存在"}), 404

    old_role = user["role"]

    cursor.execute("UPDATE users SET role = ? WHERE id = ?", (new_role, user_id))
    conn.commit()
    conn.close()

    log_audit(
        admin_id,
        None,
        "user_role_changed",
        request.remote_addr,
        request.headers.get("User-Agent", ""),
        True,
        f"User {user_id} ({user['username']}): {old_role} -> {new_role}"
    )

    return jsonify({
        "message": "角色修改成功",
        "user_id": user_id,
        "old_role": old_role,
        "new_role": new_role
    }), 200


@admin_bp.route("/users/<int:user_id>/quota", methods=["PUT"])
@jwt_required()
@require_permission(Permission.CHANGE_USER_QUOTA)
def change_user_quota(user_id):
    """修改用户隧道配额（管理员）"""
    admin_id = int(get_jwt_identity())
    data = request.get_json()

    if not data or "quota" not in data:
        return jsonify({"error": "缺少配额参数"}), 400

    try:
        new_quota = int(data["quota"])
    except (ValueError, TypeError):
        return jsonify({"error": "配额必须是整数"}), 400

    if new_quota < 0 or new_quota > 1000:
        return jsonify({"error": "配额范围无效（0-1000）"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT username, tunnel_quota FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()

    if not user:
        conn.close()
        return jsonify({"error": "用户不存在"}), 404

    old_quota = user["tunnel_quota"] or MAX_TUNNELS_PER_USER

    cursor.execute("UPDATE users SET tunnel_quota = ? WHERE id = ?", (new_quota, user_id))
    conn.commit()
    conn.close()

    log_audit(
        admin_id,
        None,
        "user_quota_changed",
        request.remote_addr,
        request.headers.get("User-Agent", ""),
        True,
        f"User {user_id} ({user['username']}): {old_quota} -> {new_quota}"
    )

    return jsonify({
        "message": "配额修改成功",
        "user_id": user_id,
        "old_quota": old_quota,
        "new_quota": new_quota
    }), 200


@admin_bp.route("/audit-logs", methods=["GET"])
@jwt_required()
@require_permission(Permission.VIEW_ALL_AUDIT_LOGS)
def get_audit_logs():
    """获取审计日志（管理员）"""
    conn = get_db()
    cursor = conn.cursor()

    # 分页参数
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 50, type=int)
    per_page = min(per_page, 200)

    # 过滤参数
    user_id = request.args.get("user_id", type=int)
    action = request.args.get("action")
    success = request.args.get("success", type=int)

    offset = (page - 1) * per_page

    # 构建查询
    where_clauses = []
    params = []

    if user_id:
        where_clauses.append("user_id = ?")
        params.append(user_id)

    if action:
        where_clauses.append("action = ?")
        params.append(action)

    if success is not None:
        where_clauses.append("success = ?")
        params.append(success)

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

    # 查询日志
    cursor.execute(
        f"""SELECT * FROM audit_logs
            WHERE {where_sql}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?""",
        params + [per_page, offset]
    )
    logs = cursor.fetchall()

    # 查询总数
    cursor.execute(
        f"SELECT COUNT(*) as total FROM audit_logs WHERE {where_sql}",
        params
    )
    total = cursor.fetchone()["total"]

    conn.close()

    return jsonify({
        "logs": [
            {
                "id": log["id"],
                "user_id": log["user_id"],
                "username": log["username"],
                "action": log["action"],
                "ip_address": log["ip_address"],
                "user_agent": log["user_agent"],
                "success": bool(log["success"]),
                "details": log["details"],
                "created_at": log["created_at"],
            }
            for log in logs
        ],
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": total,
            "pages": (total + per_page - 1) // per_page
        }
    }), 200


@admin_bp.route("/stats", methods=["GET"])
@jwt_required()
@require_role(Role.ADMIN)
def get_system_stats():
    """获取系统统计信息（管理员）"""
    conn = get_db()
    cursor = conn.cursor()

    # 用户统计
    cursor.execute("SELECT COUNT(*) as total FROM users")
    total_users = cursor.fetchone()["total"]

    cursor.execute("SELECT COUNT(*) as total FROM users WHERE role = 'admin'")
    admin_users = cursor.fetchone()["total"]

    # 隧道统计
    cursor.execute("SELECT COUNT(*) as total FROM tunnels")
    total_tunnels = cursor.fetchone()["total"]

    cursor.execute("SELECT COUNT(*) as total FROM tunnels WHERE status = 'active'")
    active_tunnels = cursor.fetchone()["total"]

    # 端口池统计
    cursor.execute("SELECT COUNT(*) as total FROM port_pool WHERE status = 'available'")
    available_ports = cursor.fetchone()["total"]

    cursor.execute("SELECT COUNT(*) as total FROM port_pool WHERE status = 'used'")
    used_ports = cursor.fetchone()["total"]

    # 最近登录
    cursor.execute(
        """SELECT username, last_login_at, last_login_ip
           FROM users
           WHERE last_login_at IS NOT NULL
           ORDER BY last_login_at DESC
           LIMIT 10"""
    )
    recent_logins = cursor.fetchall()

    conn.close()

    return jsonify({
        "users": {
            "total": total_users,
            "admins": admin_users,
            "regular": total_users - admin_users
        },
        "tunnels": {
            "total": total_tunnels,
            "active": active_tunnels,
            "inactive": total_tunnels - active_tunnels
        },
        "ports": {
            "available": available_ports,
            "used": used_ports,
            "total": available_ports + used_ports
        },
        "recent_logins": [
            {
                "username": login["username"],
                "login_at": login["last_login_at"],
                "ip": login["last_login_ip"]
            }
            for login in recent_logins
        ]
    }), 200


@admin_bp.route("/tunnels", methods=["GET"])
@jwt_required()
@require_permission(Permission.VIEW_ALL_TUNNELS)
def get_all_tunnels():
    """获取所有隧道（管理员）"""
    conn = get_db()
    cursor = conn.cursor()

    # 分页参数
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 50, type=int)
    per_page = min(per_page, 200)

    offset = (page - 1) * per_page

    # 查询隧道（包含用户信息）
    cursor.execute(
        """SELECT t.*, u.username
           FROM tunnels t
           LEFT JOIN users u ON t.user_id = u.id
           ORDER BY t.created_at DESC
           LIMIT ? OFFSET ?""",
        (per_page, offset)
    )
    tunnels = cursor.fetchall()

    # 查询总数
    cursor.execute("SELECT COUNT(*) as total FROM tunnels")
    total = cursor.fetchone()["total"]

    conn.close()

    return jsonify({
        "tunnels": [
            {
                "id": t["id"],
                "user_id": t["user_id"],
                "username": t["username"],
                "local_port": t["local_port"],
                "server_port": t["server_port"],
                "protocol": t["protocol"],
                "status": t["status"],
                "name": t["name"],
                "traffic_bytes": t["traffic_bytes"],
                "created_at": t["created_at"],
            }
            for t in tunnels
        ],
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": total,
            "pages": (total + per_page - 1) // per_page
        }
    }), 200
'''

auth_py = r'''import secrets
import re
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity, get_jwt
from models import get_db, log_audit
from session_manager import get_session_manager

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

# Password strength requirements
PASSWORD_MIN_LENGTH = 8
PASSWORD_REQUIRE_UPPERCASE = True
PASSWORD_REQUIRE_LOWERCASE = True
PASSWORD_REQUIRE_DIGIT = True
PASSWORD_REQUIRE_SPECIAL = False

# Account lockout settings
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 30


def validate_password_strength(password):
    """Validate password meets security requirements"""
    if len(password) < PASSWORD_MIN_LENGTH:
        return False, f"密码至少需要{PASSWORD_MIN_LENGTH}个字符"

    if PASSWORD_REQUIRE_UPPERCASE and not re.search(r'[A-Z]', password):
        return False, "密码必须包含至少一个大写字母"

    if PASSWORD_REQUIRE_LOWERCASE and not re.search(r'[a-z]', password):
        return False, "密码必须包含至少一个小写字母"

    if PASSWORD_REQUIRE_DIGIT and not re.search(r'\d', password):
        return False, "密码必须包含至少一个数字"

    if PASSWORD_REQUIRE_SPECIAL and not re.search(
        r'[!@#$%^&*(),.?":{}|<>]', password):
        return False, "密码必须包含至少一个特殊字符"

    return True, None


def is_account_locked(user):
    """Check if account is locked"""
    if user["locked_until"]:
        locked_until = datetime.fromisoformat(user["locked_until"])
        if datetime.utcnow() < locked_until:
            return True, locked_until
    return False, None


def lock_account(conn, user_id, duration_minutes):
    """Lock account for specified duration"""
    locked_until = datetime.utcnow() + timedelta(minutes=duration_minutes)
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET locked_until = ?, failed_login_attempts = 0 WHERE id = ?",
        (locked_until.isoformat(), user_id)
    )
    conn.commit()
    return locked_until


def reset_failed_attempts(conn, user_id):
    """Reset failed login attempts counter"""
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
        (user_id,)
    )
    conn.commit()


def increment_failed_attempts(conn, user_id):
    """Increment failed login attempts and lock if threshold reached"""
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?",
        (user_id,)
    )
    conn.commit()

    cursor.execute(
        "SELECT failed_login_attempts FROM users WHERE id = ?", (user_id,))
    result = cursor.fetchone()
    attempts = result["failed_login_attempts"]

    if attempts >= MAX_FAILED_ATTEMPTS:
        locked_until = lock_account(conn, user_id, LOCKOUT_DURATION_MINUTES)
        return True, locked_until

    return False, None


@auth_bp.route("/register", methods=["POST"])
def register():
    session_mgr = get_session_manager()
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")

    # Rate limiting
    allowed, remaining, reset_at = session_mgr.check_rate_limit(
        "register", client_ip, max_attempts=5, window_seconds=3600
    )
    if not allowed:
        log_audit(None, None, "register_rate_limited", client_ip, user_agent, False,
            f"Rate limit exceeded, resets at {reset_at}")
        return jsonify({"error": "注册请求过于频繁，请稍后再试"}), 429

    data = request.get_json()
    if not data:
        return jsonify({"error": "请求数据不能为空"}), 400

    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400

    if len(username) < 3 or len(username) > 32:
        return jsonify({"error": "用户名长度需在3-32个字符之间"}), 400

    # Validate password strength
    valid, error_msg = validate_password_strength(password)
    if not valid:
        log_audit(
            None,
            username,
            "register_weak_password",
            client_ip,
            user_agent,
            False,
            error_msg)
        return jsonify({"error": error_msg}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
    if cursor.fetchone():
        conn.close()
        log_audit(
            None,
            username,
            "register_duplicate",
            client_ip,
            user_agent,
            False,
            "Username already exists")
        return jsonify({"error": "用户名已存在"}), 409

    password_hash = generate_password_hash(password)
    token = secrets.token_hex(16)

    try:
        cursor.execute(
            "INSERT INTO users (username, password_hash, token) VALUES (?, ?, ?)",
            (username, password_hash, token),
        )
        conn.commit()
        user_id = cursor.lastrowid
    except Exception as e:
        conn.close()
        log_audit(
            None,
            username,
            "register_failed",
            client_ip,
            user_agent,
            False,
            str(e))
        return jsonify({"error": "注册失败，请重试"}), 500

    conn.close()

    log_audit(
        user_id,
        username,
        "register_success",
        client_ip,
        user_agent,
        True)

    return jsonify({
        "message": "注册成功",
        "user": {"id": user_id, "username": username, "token": token},
    }), 201


@auth_bp.route("/login", methods=["POST"])
def login():
    session_mgr = get_session_manager()
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")

    # Rate limiting
    allowed, remaining, reset_at = session_mgr.check_rate_limit(
        "login", client_ip, max_attempts=10, window_seconds=300
    )
    if not allowed:
        log_audit(None, None, "login_rate_limited", client_ip, user_agent, False,
            f"Rate limit exceeded, resets at {reset_at}")
        return jsonify({"error": "登录请求过于频繁，请稍后再试"}), 429

    data = request.get_json()
    if not data:
        return jsonify({"error": "请求数据不能为空"}), 400

    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()

    if not user:
        conn.close()
        log_audit(None, username, "login_failed", client_ip, user_agent, False, "User not found")
        return jsonify({"error": "用户名或密码错误"}), 401

    # Check if account is locked
    locked, locked_until = is_account_locked(user)
    if locked:
        conn.close()
        log_audit(user["id"], username, "login_locked", client_ip, user_agent, False,
            f"Account locked until {locked_until}")
        return jsonify({
            "error": f"账户已被锁定，请在 {locked_until.strftime('%Y-%m-%d %H:%M:%S')} UTC 后重试"
        }), 403

    # Verify password
    if not check_password_hash(user["password_hash"], password):
        is_locked, locked_until = increment_failed_attempts(conn, user["id"])
        conn.close()

        if is_locked:
            log_audit(user["id"], username, "login_failed_locked", client_ip, user_agent, False,
                f"Account locked after {MAX_FAILED_ATTEMPTS} failed attempts")
            return jsonify({
                "error": f"密码错误次数过多，账户已被锁定 {LOCKOUT_DURATION_MINUTES} 分钟"
            }), 403
        else:
            log_audit(user["id"], username, "login_failed", client_ip, user_agent, False,
                f"Invalid password, {user['failed_login_attempts'] + 1} attempts")
            return jsonify({"error": "用户名或密码错误"}), 401

    # Successful login - reset failed attempts
    reset_failed_attempts(conn, user["id"])

    # Update last login info
    cursor.execute(
        "UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), client_ip, user["id"])
    )
    conn.commit()
    conn.close()

    # Create JWT with JTI (JWT ID) for session tracking
    additional_claims = {"jti": secrets.token_hex(16)}
    access_token = create_access_token(identity=str(user["id"]), additional_claims=additional_claims)

    # Create session in Redis
    session_mgr.create_session(user["id"], additional_claims["jti"], client_ip, user_agent)

    log_audit(user["id"], username, "login_success", client_ip, user_agent, True)

    return jsonify({
        "message": "登录成功",
        "access_token": access_token,
        "user": {"id": user["id"], "username": user["username"], "token": user["token"]},
    }), 200


@auth_bp.route("/logout", methods=["POST"])
@jwt_required()
def logout():
    session_mgr = get_session_manager()
    user_id = int(get_jwt_identity())
    jwt_data = get_jwt()
    jti = jwt_data.get("jti")
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")

    # Revoke session
    if jti:
        session_mgr.revoke_session(user_id, jti)

    log_audit(user_id, None, "logout", client_ip, user_agent, True)

    return jsonify({"message": "登出成功"}), 200


@auth_bp.route("/sessions", methods=["GET"])
@jwt_required()
def get_sessions():
    session_mgr = get_session_manager()
    user_id = int(get_jwt_identity())

    sessions = session_mgr.get_user_sessions(user_id)

    return jsonify({"sessions": sessions}), 200


@auth_bp.route("/sessions/<jti>", methods=["DELETE"])
@jwt_required()
def revoke_session(jti):
    session_mgr = get_session_manager()
    user_id = int(get_jwt_identity())
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")

    # Verify session belongs to user
    session = session_mgr.get_session(user_id, jti)
    if not session:
        return jsonify({"error": "会话不存在"}), 404

    session_mgr.revoke_session(user_id, jti)

    log_audit(user_id, None, "session_revoked", client_ip, user_agent, True, f"Revoked session {jti}")

    return jsonify({"message": "会话已撤销"}), 200


@auth_bp.route("/sessions/all", methods=["DELETE"])
@jwt_required()
def revoke_all_sessions():
    session_mgr = get_session_manager()
    user_id = int(get_jwt_identity())
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")

    session_mgr.revoke_all_user_sessions(user_id)

    log_audit(user_id, None, "all_sessions_revoked", client_ip, user_agent, True)

    return jsonify({"message": "所有会话已撤销"}), 200


@auth_bp.route("/health", methods=["GET"])
def health():
    """Health check endpoint"""
    session_mgr = get_session_manager()
    redis_ok = session_mgr.health_check()

    return jsonify({
        "status": "healthy" if redis_ok else "degraded",
        "redis": "connected" if redis_ok else "disconnected"
    }), 200 if redis_ok else 503
'''

tunnels_py = r'''from flask import Blueprint, request, jsonify, send_file
from flask_jwt_extended import jwt_required, get_jwt_identity
from models import get_db, log_audit
from frp_manager import generate_frpc_config, restart_frps
from config import MAX_TUNNELS_PER_USER
from security_validators import validate_tunnel_config, sanitize_tunnel_name
import io

tunnels_bp = Blueprint("tunnels", __name__, url_prefix="/api/tunnels")


@tunnels_bp.route("", methods=["GET"])
@jwt_required()
def get_tunnels():
    user_id = int(get_jwt_identity())
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT t.*, d.device_name, d.device_type, d.status as device_status FROM tunnels t LEFT JOIN devices d ON t.device_id = d.id WHERE t.user_id = ?", (user_id,))
    tunnels = cursor.fetchall()
    conn.close()

    result = []
    for t in tunnels:
        result.append({
            "id": t["id"],
            "user_id": t["user_id"],
            "device_id": t["device_id"],
            "device_name": t["device_name"],
            "device_type": t["device_type"],
            "device_status": t["device_status"],
            "local_port": t["local_port"],
            "server_port": t["server_port"],
            "protocol": t["protocol"],
            "status": t["status"],
            "traffic_bytes": t["traffic_bytes"],
            "name": t["name"],
            "created_at": t["created_at"],
        })

    return jsonify({"tunnels": result}), 200


@tunnels_bp.route("", methods=["POST"])
@jwt_required()
def create_tunnel():
    user_id = int(get_jwt_identity())
    data = request.get_json()
    if not data:
        return jsonify({"error": "请求数据不能为空"}), 400

    local_port = data.get("local_port")
    protocol = data.get("protocol", "tcp")
    name = data.get("name")
    device_id = data.get("device_id")

    if local_port is None:
        return jsonify({"error": "本地端口不能为空"}), 400

    try:
        local_port = int(local_port)
    except (ValueError, TypeError):
        return jsonify({"error": "本地端口必须是数字"}), 400

    if local_port < 1 or local_port > 65535:
        return jsonify({"error": "本地端口范围无效"}), 400

    # 使用安全验证器
    is_valid, error_msg = validate_tunnel_config(local_port, protocol, name)
    if not is_valid:
        log_audit(
            user_id,
            None,
            "tunnel_create_failed",
            request.remote_addr,
            request.headers.get("User-Agent", ""),
            False,
            f"Validation failed: {error_msg}"
        )
        return jsonify({"error": error_msg}), 400

    # 清理隧道名称
    if name is not None:
        name = sanitize_tunnel_name(name)
        if not name:
            name = None

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT tunnel_quota FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()
    tunnel_quota = user["tunnel_quota"] if user else MAX_TUNNELS_PER_USER
    cursor.execute(
        "SELECT COUNT(*) as cnt FROM tunnels WHERE user_id = ? AND status = 'active'",
        (user_id,))
    count = cursor.fetchone()["cnt"]
    if count >= tunnel_quota:
        conn.close()
        return jsonify({"error": f"已达到隧道配额限制（{tunnel_quota}个）"}), 400

    cursor.execute(
        "SELECT port FROM port_pool WHERE status = 'available' ORDER BY RANDOM() LIMIT 1")
    port_row = cursor.fetchone()

    if not port_row:
        conn.close()
        return jsonify({"error": "没有可用端口"}), 503

    server_port = port_row["port"]

    try:
        cursor.execute(
            "UPDATE port_pool SET status = 'used' WHERE port = ? AND status = 'available'",
            (server_port,)
        )
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({"error": "端口分配失败，请重试"}), 503

        cursor.execute(
            "INSERT INTO tunnels (user_id, device_id, local_port, server_port, protocol, name) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, device_id, local_port, server_port, protocol, name),
        )
        conn.commit()
        tunnel_id = cursor.lastrowid

        # 记录成功的审计日志
        log_audit(
            user_id,
            None,
            "tunnel_created",
            request.remote_addr,
            request.headers.get("User-Agent", ""),
            True,
            f"Tunnel {tunnel_id}: {protocol}:{local_port}->{server_port}"
        )
    except Exception as e:
        conn.rollback()
        conn.close()
        log_audit(
            user_id,
            None,
            "tunnel_create_failed",
            request.remote_addr,
            request.headers.get("User-Agent", ""),
            False,
            f"Database error: {str(e)}"
        )
        return jsonify({"error": "创建隧道失败"}), 500

    cursor.execute("SELECT * FROM tunnels WHERE id = ?", (tunnel_id,))
    tunnel = cursor.fetchone()
    conn.close()

    restart_frps()

    return jsonify({
        "message": "隧道创建成功",
        "tunnel": {
            "id": tunnel["id"],
            "user_id": tunnel["user_id"],
            "local_port": tunnel["local_port"],
            "server_port": tunnel["server_port"],
            "protocol": tunnel["protocol"],
            "status": tunnel["status"],
            "traffic_bytes": tunnel["traffic_bytes"],
            "name": tunnel["name"],
            "created_at": tunnel["created_at"],
        },
    }), 201


@tunnels_bp.route("/<int:tunnel_id>", methods=["DELETE"])
@jwt_required()
def delete_tunnel(tunnel_id):
    user_id = int(get_jwt_identity())
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM tunnels WHERE id = ?", (tunnel_id,))
    tunnel = cursor.fetchone()

    if not tunnel:
        conn.close()
        return jsonify({"error": "隧道不存在"}), 404

    if tunnel["user_id"] != user_id:
        conn.close()
        log_audit(
            user_id,
            None,
            "tunnel_delete_unauthorized",
            request.remote_addr,
            request.headers.get("User-Agent", ""),
            False,
            f"Attempted to delete tunnel {tunnel_id} owned by user {tunnel['user_id']}"
        )
        return jsonify({"error": "无权操作此隧道"}), 403

    try:
        cursor.execute("DELETE FROM tunnels WHERE id = ?", (tunnel_id,))
        cursor.execute(
            "UPDATE port_pool SET status = 'available' WHERE port = ?",
            (tunnel["server_port"],),
        )
        conn.commit()

        log_audit(
            user_id,
            None,
            "tunnel_deleted",
            request.remote_addr,
            request.headers.get("User-Agent", ""),
            True,
            f"Tunnel {tunnel_id}: {tunnel['protocol']}:{tunnel['local_port']}->{tunnel['server_port']}"
        )
    except Exception as e:
        conn.rollback()
        conn.close()
        log_audit(
            user_id,
            None,
            "tunnel_delete_failed",
            request.remote_addr,
            request.headers.get("User-Agent", ""),
            False,
            f"Database error: {str(e)}"
        )
        return jsonify({"error": "删除隧道失败"}), 500

    conn.close()

    restart_frps()

    return jsonify({"message": "隧道删除成功"}), 200


@tunnels_bp.route("/<int:tunnel_id>/config", methods=["GET"])
@jwt_required()
def get_tunnel_config(tunnel_id):
    user_id = int(get_jwt_identity())
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM tunnels WHERE id = ?", (tunnel_id,))
    tunnel = cursor.fetchone()

    if not tunnel:
        conn.close()
        return jsonify({"error": "隧道不存在"}), 404

    if tunnel["user_id"] != user_id:
        conn.close()
        return jsonify({"error": "无权操作此隧道"}), 403

    cursor.execute("SELECT token FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()
    conn.close()

    tunnel_dict = {
        "id": tunnel["id"],
        "user_id": tunnel["user_id"],
        "local_port": tunnel["local_port"],
        "server_port": tunnel["server_port"],
        "protocol": tunnel["protocol"],
    }

    config_content, config_path = generate_frpc_config(
        user["token"], tunnel_dict)

    return send_file(
        io.BytesIO(config_content.encode("utf-8")),
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=f"frpc_tunnel_{tunnel_id}.toml",
    )


@tunnels_bp.route("/<int:tunnel_id>/stats", methods=["GET"])
@jwt_required()
def get_tunnel_stats(tunnel_id):
    user_id = int(get_jwt_identity())
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM tunnels WHERE id = ?", (tunnel_id,))
    tunnel = cursor.fetchone()
    conn.close()

    if not tunnel:
        return jsonify({"error": "隧道不存在"}), 404

    if tunnel["user_id"] != user_id:
        return jsonify({"error": "无权操作此隧道"}), 403

    return jsonify({
        "tunnel_id": tunnel["id"],
        "traffic_bytes": tunnel["traffic_bytes"],
        "status": tunnel["status"],
    }), 200


@tunnels_bp.route("/quota", methods=["GET"])
@jwt_required()
def get_tunnel_quota():
    """获取用户隧道配额信息"""
    user_id = int(get_jwt_identity())
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT tunnel_quota FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()
    tunnel_quota = user["tunnel_quota"] if user else 10

    cursor.execute(
        "SELECT COUNT(*) as cnt FROM tunnels WHERE user_id = ? AND status = 'active'",
        (user_id,))
    used = cursor.fetchone()["cnt"]

    conn.close()

    return jsonify({
        "quota": tunnel_quota,
        "used": used,
        "remaining": tunnel_quota - used
    }), 200

@tunnels_bp.route("/status", methods=["GET"])
@jwt_required()
def get_tunnels_status():
    from frp_manager import get_frps_proxy_status
    user_id = int(get_jwt_identity())

    proxy_data = get_frps_proxy_status()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, server_port, name FROM tunnels WHERE user_id = ?", (user_id,))
    tunnels = cursor.fetchall()
    conn.close()

    result = []
    for t in tunnels:
        status = "offline"
        if proxy_data and isinstance(proxy_data, list):
            for proxy in proxy_data:
                proxy_name = proxy.get("name", "")
                if f"tunnel_{t['id']}" in proxy_name or f"user_{user_id}_tunnel_{t['id']}" in proxy_name:
                    status = "online" if proxy.get("status") == "online" or proxy.get("running") else "offline"
                    break

        result.append({
            "id": t["id"],
            "server_port": t["server_port"],
            "name": t["name"],
            "real_status": status,
        })

    return jsonify({"tunnels": result}), 200
'''

files = {
    "admin.py": admin_py,
    "auth.py": auth_py,
    "tunnels.py": tunnels_py,
}

for name, content in files.items():
    path = os.path.join(BASE, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Written: {path}")

# Verify compilation
import py_compile
for name in files:
    path = os.path.join(BASE, name)
    try:
        py_compile.compile(path, doraise=True)
        print(f"COMPILE OK: {name}")
    except py_compile.PyCompileError as e:
        print(f"COMPILE ERROR: {name}: {e}")
