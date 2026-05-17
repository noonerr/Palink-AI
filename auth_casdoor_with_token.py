import secrets
from datetime import datetime
from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity, get_jwt
from werkzeug.security import generate_password_hash
from models import get_db, log_audit
from session_manager import get_session_manager
from casdoor_client import (
    get_signin_url,
    exchange_code_for_token,
    get_user_info,
    get_logout_url,
)

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@auth_bp.route("/signin-url", methods=["GET"])
def get_signin():
    return jsonify({"signin_url": get_signin_url()}), 200

@auth_bp.route("/token-login", methods=["POST"])
def token_login():
    session_mgr = get_session_manager()
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")
    data = request.get_json()
    token = data.get("token") if data else None
    if not token:
        return jsonify({"error": "缺少 Token"}), 400
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE token = ?", (token,))
    user = cursor.fetchone()
    if not user:
        conn.close()
        return jsonify({"error": "无效的 Token"}), 401
    cursor.execute(
        "UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), client_ip, user["id"])
    )
    conn.commit()
    conn.close()
    jti = secrets.token_hex(16)
    jwt_token = create_access_token(
        identity=str(user["id"]),
        additional_claims={"jti": jti}
    )
    session_mgr.create_session(user["id"], jti, client_ip, user_agent)
    log_audit(user["id"], user["username"], "token_login_success", client_ip, user_agent, True)
    return jsonify({
        "message": "登录成功",
        "access_token": jwt_token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "token": user["token"]
        },
    }), 200

@auth_bp.route("/callback", methods=["POST"])
def callback():
    session_mgr = get_session_manager()
    client_ip = request.remote_addr
    user_agent = request.headers.get("User-Agent", "")
    data = request.get_json()
    code = data.get("code")
    if not code:
        return jsonify({"error": "缺少授权码"}), 400
    try:
        token_response = exchange_code_for_token(code)
        access_token = token_response.get("access_token")
        if not access_token:
            raise ValueError("No access token")
        user_info = get_user_info(access_token)
        casdoor_username = user_info.get("preferred_username") or user_info.get("name")
        casdoor_email = user_info.get("email", "")
        casdoor_sub = user_info.get("sub")
        if not casdoor_username or not casdoor_sub:
            raise ValueError("Missing user info")
    except Exception as e:
        log_audit(None, None, "casdoor_auth_failed", client_ip, user_agent, False, str(e))
        return jsonify({"error": "Casdoor 认证失败"}), 500
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE casdoor_sub = ?", (casdoor_sub,))
    user = cursor.fetchone()
    if not user:
        password_hash = generate_password_hash(secrets.token_hex(32))
        token = secrets.token_hex(16)
        attempt_username = casdoor_username
        for _ in range(10):
            cursor.execute("SELECT id FROM users WHERE username = ?", (attempt_username,))
            if cursor.fetchone() is None:
                break
            attempt_username = f"{casdoor_username}_{secrets.token_hex(3)}"
        try:
            cursor.execute(
                """INSERT INTO users
                (username, password_hash, token, casdoor_sub, email)
                VALUES (?, ?, ?, ?, ?)""",
                (attempt_username, password_hash, token, casdoor_sub, casdoor_email),
            )
            conn.commit()
            user_id = cursor.lastrowid
            log_audit(user_id, attempt_username, "casdoor_register", client_ip, user_agent, True)
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            user = cursor.fetchone()
        except Exception as e:
            conn.close()
            log_audit(None, casdoor_username, "casdoor_register_failed", client_ip, user_agent, False, str(e))
            return jsonify({"error": "创建用户失败"}), 500
    cursor.execute(
        "UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), client_ip, user["id"])
    )
    conn.commit()
    conn.close()
    jti = secrets.token_hex(16)
    jwt_token = create_access_token(
        identity=str(user["id"]),
        additional_claims={"jti": jti}
    )
    session_mgr.create_session(user["id"], jti, client_ip, user_agent)
    log_audit(user["id"], user["username"], "casdoor_login_success", client_ip, user_agent, True)
    return jsonify({
        "message": "登录成功",
        "access_token": jwt_token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "token": user["token"]
        },
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
    if jti:
        session_mgr.revoke_session(user_id, jti)
    log_audit(user_id, None, "logout", client_ip, user_agent, True)
    return jsonify({
        "message": "登出成功",
        "casdoor_logout_url": get_logout_url()
    }), 200


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
    session = session_mgr.get_session(user_id, jti)
    if not session:
        return jsonify({"error": "会话不存在"}), 404
    session_mgr.revoke_session(user_id, jti)
    log_audit(user_id, None, "session_revoked", client_ip, user_agent, True, f"Revoked {jti}")
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
    session_mgr = get_session_manager()
    redis_ok = session_mgr.health_check()
    return jsonify({
        "status": "healthy" if redis_ok else "degraded",
        "redis": "connected" if redis_ok else "disconnected"
    }), 200 if redis_ok else 503
