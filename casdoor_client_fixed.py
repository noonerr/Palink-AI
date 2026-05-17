import os
import requests

CASDOOR_ENDPOINT = os.environ.get("CASDOOR_ENDPOINT", "http://127.0.0.1:8444")
CASDOOR_PUBLIC_URL = os.environ.get("CASDOOR_PUBLIC_URL", "https://104.208.99.17:9443")
CLIENT_ID = os.environ.get("CASDOOR_CLIENT_ID", "frp-platform")
CLIENT_SECRET = os.environ.get("CASDOOR_CLIENT_SECRET", "")
ORGANIZATION = os.environ.get("CASDOOR_ORGANIZATION", "built-in")
APPLICATION = os.environ.get("CASDOOR_APPLICATION", "frp-platform")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "https://104.208.99.17:8081")

REDIRECT_URI = f"{FRONTEND_URL}/auth/callback"


def get_signin_url():
    return (
        f"{CASDOOR_PUBLIC_URL}/login/oauth/authorize"
        f"?client_id={CLIENT_ID}"
        f"&response_type=code"
        f"&redirect_uri={REDIRECT_URI}"
        f"&scope=openid%20profile%20email"
    )


def exchange_code_for_token(code):
    token_url = f"{CASDOOR_ENDPOINT}/api/login/oauth/access_token"
    data = {
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }
    response = requests.post(token_url, data=data, timeout=10)
    response.raise_for_status()
    return response.json()


def get_user_info(access_token):
    userinfo_url = f"{CASDOOR_ENDPOINT}/api/userinfo"
    headers = {"Authorization": f"Bearer {access_token}"}
    response = requests.get(userinfo_url, headers=headers, timeout=10)
    response.raise_for_status()
    return response.json()


def verify_token(access_token):
    try:
        user_info = get_user_info(access_token)
        return user_info if user_info.get("sub") else None
    except Exception:
        return None


def get_logout_url():
    return f"{CASDOOR_PUBLIC_URL}/logout?redirect_uri={FRONTEND_URL}"
