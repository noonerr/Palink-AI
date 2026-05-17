#!/usr/bin/env python3
"""
FRP Client - Modern UI
"""

import sys
import os
import json
import subprocess
import platform
import time
from pathlib import Path
from typing import Optional, Dict, List, Tuple

import requests
import psutil
from cryptography.fernet import Fernet
import base64

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QTableWidget, QTableWidgetItem, QPushButton, QDialog, QLabel,
    QLineEdit, QComboBox, QMessageBox, QSystemTrayIcon, QMenu,
    QAction, QHeaderView, QFrame, QSpacerItem, QSizePolicy,
    QGraphicsDropShadowEffect, QScrollArea, QStackedWidget,
    QToolButton, QTabWidget, QFileDialog
)
from PyQt5.QtCore import Qt, QTimer, QPropertyAnimation, QEasingCurve, QSize, pyqtProperty, QRectF
from PyQt5.QtGui import QIcon, QColor, QFont, QPalette, QPixmap, QPainter, QBrush, QLinearGradient, QPen, QPaintEvent


# ============== API Client ==============
class FRPApiClientError(Exception):
    pass

class AuthenticationError(FRPApiClientError):
    pass

class APIError(FRPApiClientError):
    pass

class FRPApiClient:
    def __init__(self, server_url: str, timeout: int = 30):
        self.server_url = server_url.rstrip("/")
        self.timeout = timeout
        self.access_token: Optional[str] = None
        self.user_info: Optional[Dict] = None
        self.session = requests.Session()

    def _make_request(self, method: str, endpoint: str, data: Optional[Dict] = None, require_auth: bool = False) -> Dict:
        from urllib.parse import urljoin
        url = urljoin(self.server_url, endpoint)
        headers = {}
        if require_auth:
            if not self.access_token:
                raise AuthenticationError("未登录，请先登录")
            headers["Authorization"] = f"Bearer {self.access_token}"
        try:
            if method == "GET":
                response = self.session.get(url, headers=headers, timeout=self.timeout)
            elif method == "POST":
                response = self.session.post(url, json=data, headers=headers, timeout=self.timeout)
            elif method == "DELETE":
                response = self.session.delete(url, headers=headers, timeout=self.timeout)
            else:
                raise ValueError(f"不支持的HTTP方法: {method}")
            if response.status_code == 401:
                raise AuthenticationError("认证失败，请重新登录")
            if response.status_code >= 400:
                error_msg = response.json().get("error", "请求失败")
                raise APIError(f"API错误 ({response.status_code}): {error_msg}")
            return response.json()
        except requests.exceptions.Timeout:
            raise APIError("请求超时，请检查网络连接")
        except requests.exceptions.ConnectionError:
            raise APIError("无法连接到服务器，请检查服务器地址")
        except requests.exceptions.RequestException as e:
            raise APIError(f"请求失败: {str(e)}")

    def token_login(self, api_token: str) -> Dict:
        data = {"token": api_token}
        response = self._make_request("POST", "/api/auth/token-login", data=data)
        self.access_token = response["access_token"]
        self.user_info = response["user"]
        return {"id": self.user_info["id"], "username": self.user_info["username"],
                "token": self.user_info["token"], "access_token": self.access_token}

    def list_tunnels(self) -> List[Dict]:
        response = self._make_request("GET", "/api/tunnels", require_auth=True)
        return response["tunnels"]

    def create_tunnel(self, local_port: int, protocol: str = "tcp", name: Optional[str] = None) -> Dict:
        data = {"local_port": local_port, "protocol": protocol}
        if name:
            data["name"] = name
        response = self._make_request("POST", "/api/tunnels", data=data, require_auth=True)
        return response["tunnel"]

    def delete_tunnel(self, tunnel_id: int) -> bool:
        self._make_request("DELETE", f"/api/tunnels/{tunnel_id}", require_auth=True)
        return True

    def get_tunnel_config(self, tunnel_id: int) -> str:
        from urllib.parse import urljoin
        url = urljoin(self.server_url, f"/api/tunnels/{tunnel_id}/config")
        headers = {"Authorization": f"Bearer {self.access_token}"}
        try:
            response = self.session.get(url, headers=headers, timeout=self.timeout)
            if response.status_code == 401:
                raise AuthenticationError("认证失败，请重新登录")
            if response.status_code >= 400:
                raise APIError(f"下载配置失败 ({response.status_code})")
            return response.text
        except requests.exceptions.RequestException as e:
            raise APIError(f"下载配置失败: {str(e)}")

    def list_tunnel_groups(self) -> List[Dict]:
        response = self._make_request("GET", "/api/tunnel-groups", require_auth=True)
        return response["groups"]

    def get_game_templates(self) -> List[Dict]:
        response = self._make_request("GET", "/api/tunnel-groups/templates", require_auth=True)
        return response["templates"]

    def create_tunnel_group(self, name: str, template_id: Optional[str] = None, ports: Optional[List[Dict]] = None) -> Dict:
        data = {"name": name}
        if template_id:
            data["template_id"] = template_id
        if ports:
            data["ports"] = ports
        response = self._make_request("POST", "/api/tunnel-groups", data=data, require_auth=True)
        return response["group"]

    def delete_tunnel_group(self, group_id: int) -> bool:
        self._make_request("DELETE", f"/api/tunnel-groups/{group_id}", require_auth=True)
        return True

    def get_tunnel_group_config(self, group_id: int) -> str:
        from urllib.parse import urljoin
        url = urljoin(self.server_url, f"/api/tunnel-groups/{group_id}/config")
        headers = {"Authorization": f"Bearer {self.access_token}"}
        try:
            response = self.session.get(url, headers=headers, timeout=self.timeout)
            if response.status_code == 401:
                raise AuthenticationError("认证失败，请重新登录")
            if response.status_code >= 400:
                raise APIError(f"下载配置失败 ({response.status_code})")
            return response.text
        except requests.exceptions.RequestException as e:
            raise APIError(f"下载配置失败: {str(e)}")

    def logout(self):
        self.access_token = None
        self.user_info = None

    def is_authenticated(self) -> bool:
        return self.access_token is not None


# ============== FRPC Manager ==============
class FRPCManagerError(Exception):
    pass

class FRPCManager:
    FRP_VERSION = "0.52.0"
    GITHUB_RELEASE_URL = "https://github.com/fatedier/frp/releases/download"

    def __init__(self, data_dir: Optional[str] = None):
        if data_dir:
            self.data_dir = Path(data_dir)
        else:
            if os.name == "nt":
                base = Path(os.environ.get("APPDATA", ""))
                self.data_dir = base / "FRPClient"
            else:
                self.data_dir = Path.home() / ".frp_client"
        self.bin_dir = self.data_dir / "bin"
        self.config_dir = self.data_dir / "configs"
        self.pid_dir = self.data_dir / "pids"
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.pid_dir.mkdir(parents=True, exist_ok=True)
        self.frpc_path = self._get_frpc_path()

    def _get_frpc_path(self) -> Path:
        if os.name == "nt":
            return self.bin_dir / "frpc.exe"
        return self.bin_dir / "frpc"

    def _get_download_url(self) -> str:
        system = platform.system().lower()
        machine = platform.machine().lower()
        if system == "windows":
            arch = "amd64" if ("64" in machine or "amd64" in machine) else "386"
            filename = f"frp_{self.FRP_VERSION}_windows_{arch}.zip"
        elif system == "linux":
            arch = "amd64" if ("64" in machine or "amd64" in machine or "x86_64" in machine) else "386"
            filename = f"frp_{self.FRP_VERSION}_linux_{arch}.tar.gz"
        else:
            arch = "arm64" if "arm" in machine else "amd64"
            filename = f"frp_{self.FRP_VERSION}_darwin_{arch}.tar.gz"
        return f"{self.GITHUB_RELEASE_URL}/v{self.FRP_VERSION}/{filename}"

    def ensure_frpc_binary(self) -> str:
        if self.frpc_path.exists():
            return str(self.frpc_path)
        print(f"正在下载 frpc v{self.FRP_VERSION}...")
        download_url = self._get_download_url()
        try:
            response = requests.get(download_url, stream=True, timeout=300)
            response.raise_for_status()
            archive_path = self.bin_dir / Path(download_url).name
            with open(archive_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            self._extract_frpc(archive_path)
            archive_path.unlink()
            if os.name != "nt":
                os.chmod(self.frpc_path, 0o755)
            return str(self.frpc_path)
        except Exception as e:
            raise FRPCManagerError(f"安装 frpc 失败: {str(e)}")

    def _extract_frpc(self, archive_path: Path):
        import zipfile, tarfile
        if archive_path.suffix == ".zip":
            with zipfile.ZipFile(archive_path, "r") as zip_ref:
                for member in zip_ref.namelist():
                    if "frpc.exe" in member or member.endswith("frpc"):
                        source = zip_ref.open(member)
                        target = open(self.frpc_path, "wb")
                        target.write(source.read())
                        target.close()
                        source.close()
                        break
        else:
            with tarfile.open(archive_path, "r:gz") as tar_ref:
                for member in tar_ref.getmembers():
                    if member.name.endswith("frpc"):
                        source = tar_ref.extractfile(member)
                        if source:
                            target = open(self.frpc_path, "wb")
                            target.write(source.read())
                            target.close()
                            source.close()
                        break

    def write_config(self, tunnel_id: int, config_content: str) -> str:
        config_path = self.config_dir / f"tunnel_{tunnel_id}.toml"
        config_path.write_text(config_content, encoding="utf-8")
        return str(config_path)

    def start_tunnel(self, tunnel_id: int, config_path: str) -> int:
        self.ensure_frpc_binary()
        if self.is_tunnel_running(tunnel_id):
            raise FRPCManagerError(f"隧道 {tunnel_id} 已在运行中")
        
        log_path = self.bin_dir / f"frpc_tunnel_{tunnel_id}.log"
        
        try:
            if os.name == "nt":
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0
                process = subprocess.Popen(
                    [str(self.frpc_path), "-c", config_path],
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
                    startupinfo=si,
                    stdout=open(log_path, "w"),
                    stderr=subprocess.STDOUT,
                )
            else:
                process = subprocess.Popen(
                    [str(self.frpc_path), "-c", config_path],
                    stdout=open(log_path, "w"),
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            pid = process.pid
            pid_file = self.pid_dir / f"tunnel_{tunnel_id}.pid"
            pid_file.write_text(str(pid))
            
            # 等待更长时间并检查日志
            time.sleep(3)
            if not psutil.pid_exists(pid):
                log_content = ""
                if log_path.exists():
                    log_content = log_path.read_text(encoding="utf-8", errors="ignore")
                raise FRPCManagerError(f"进程启动后立即退出，请检查配置\n日志：\n{log_content}")
            
            # 检查是否有启动错误
            if log_path.exists():
                log_content = log_path.read_text(encoding="utf-8", errors="ignore")
                if "error" in log_content.lower() or "fail" in log_content.lower():
                    raise FRPCManagerError(f"frpc 启动失败\n日志：\n{log_content}")
            
            return pid
        except Exception as e:
            if "进程启动后立即退出" not in str(e):
                log_content = ""
                if log_path.exists():
                    log_content = log_path.read_text(encoding="utf-8", errors="ignore")
                raise FRPCManagerError(f"启动隧道失败: {str(e)}\n日志：\n{log_content}")
            raise

    def stop_tunnel(self, tunnel_id: int) -> bool:
        pid_file = self.pid_dir / f"tunnel_{tunnel_id}.pid"
        if not pid_file.exists():
            return False
        try:
            pid = int(pid_file.read_text().strip())
            if psutil.pid_exists(pid):
                process = psutil.Process(pid)
                process.terminate()
                try:
                    process.wait(timeout=5)
                except psutil.TimeoutExpired:
                    process.kill()
            pid_file.unlink()
            return True
        except (ValueError, psutil.NoSuchProcess):
            pid_file.unlink()
            return False
        except Exception as e:
            raise FRPCManagerError(f"停止隧道失败: {str(e)}")

    def is_tunnel_running(self, tunnel_id: int) -> bool:
        pid_file = self.pid_dir / f"tunnel_{tunnel_id}.pid"
        if not pid_file.exists():
            return False
        try:
            pid = int(pid_file.read_text().strip())
            return psutil.pid_exists(pid)
        except (ValueError, IOError):
            return False

    def cleanup(self):
        for pid_file in self.pid_dir.glob("tunnel_*.pid"):
            try:
                tunnel_id = int(pid_file.stem.split("_")[1])
                self.stop_tunnel(tunnel_id)
            except Exception:
                pass


# ============== Config Manager ==============
class ConfigManager:
    def __init__(self, config_dir: Optional[str] = None):
        if config_dir:
            self.config_dir = Path(config_dir)
        else:
            if os.name == "nt":
                base = Path(os.environ.get("APPDATA", ""))
                self.config_dir = base / "FRPClient"
            else:
                self.config_dir = Path.home() / ".frp_client"
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.config_file = self.config_dir / "config.json"
        self.key_file = self.config_dir / ".key"
        self._ensure_encryption_key()
        self.config = self._load_config()

    def _ensure_encryption_key(self):
        if not self.key_file.exists():
            key = Fernet.generate_key()
            self.key_file.write_bytes(key)

    def _get_cipher(self) -> Fernet:
        key = self.key_file.read_bytes()
        return Fernet(key)

    def _load_config(self) -> Dict:
        if not self.config_file.exists():
            return {"server_url": "", "credentials": None, "tunnel_states": {}, "auto_start_tunnels": [], "settings": {}}
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {"server_url": "", "credentials": None, "tunnel_states": {}, "auto_start_tunnels": [], "settings": {}}

    def _save_config(self):
        with open(self.config_file, "w", encoding="utf-8") as f:
            json.dump(self.config, f, indent=2, ensure_ascii=False)

    def save_server_url(self, url: str):
        self.config["server_url"] = url.rstrip("/")
        self._save_config()

    def get_server_url(self) -> str:
        return self.config.get("server_url", "")

    def save_credentials(self, username: str, access_token: str):
        cipher = self._get_cipher()
        credentials_json = json.dumps({"username": username, "access_token": access_token})
        encrypted = cipher.encrypt(credentials_json.encode())
        self.config["credentials"] = base64.b64encode(encrypted).decode()
        self._save_config()

    def get_credentials(self) -> Optional[Tuple[str, str]]:
        encrypted_data = self.config.get("credentials")
        if not encrypted_data:
            return None
        try:
            cipher = self._get_cipher()
            encrypted_bytes = base64.b64decode(encrypted_data)
            decrypted = cipher.decrypt(encrypted_bytes)
            credentials = json.loads(decrypted.decode())
            return credentials["username"], credentials["access_token"]
        except Exception:
            return None

    def clear_credentials(self):
        self.config["credentials"] = None
        self._save_config()

    def save_tunnel_state(self, tunnel_id: int, pid: int, config_path: str):
        self.config["tunnel_states"][str(tunnel_id)] = {"pid": pid, "config_path": config_path}
        self._save_config()

    def remove_tunnel_state(self, tunnel_id: int):
        self.config["tunnel_states"].pop(str(tunnel_id), None)
        self._save_config()


# ============== Modern Theme ==============
class Theme:
    BG_DARK = "#0f0f1a"
    BG_SIDEBAR = "#161625"
    BG_CARD = "#1e1e32"
    BG_CARD_HOVER = "#252540"
    BG_INPUT = "#1a1a2e"
    ACCENT = "#6c5ce7"
    ACCENT_LIGHT = "#a29bfe"
    ACCENT_GRADIENT = "qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #6c5ce7, stop:1 #a29bfe)"
    GREEN = "#00b894"
    GREEN_GRADIENT = "qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #00b894, stop:1 #55efc4)"
    RED = "#e17055"
    RED_GRADIENT = "qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #e17055, stop:1 #fab1a0)"
    TEXT_PRIMARY = "#ffffff"
    TEXT_SECONDARY = "#b2b2d0"
    TEXT_MUTED = "#6c6c8a"
    BORDER = "#2d2d4a"
    SHADOW = "rgba(0,0,0,0.3)"

    @staticmethod
    def app_stylesheet():
        return f"""
            * {{
                font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
            }}
            QMainWindow {{
                background: {Theme.BG_DARK};
            }}
            QWidget {{
                color: {Theme.TEXT_PRIMARY};
            }}
            QMessageBox {{
                background: {Theme.BG_CARD};
            }}
            QMessageBox QLabel {{
                color: {Theme.TEXT_PRIMARY};
                font-size: 13px;
            }}
            QMessageBox QPushButton {{
                background: {Theme.ACCENT_GRADIENT};
                border: none;
                border-radius: 6px;
                color: white;
                padding: 6px 20px;
                font-size: 12px;
                font-weight: 600;
                min-width: 70px;
            }}
            QMessageBox QPushButton:hover {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #7c6cf7, stop:1 #b2abfe);
            }}
            QDialog {{
                background: {Theme.BG_CARD};
            }}
            QDialog QLabel {{
                color: {Theme.TEXT_PRIMARY};
            }}
            QComboBox QAbstractItemView {{
                background: {Theme.BG_CARD};
                color: {Theme.TEXT_PRIMARY};
                selection-background-color: {Theme.ACCENT};
                border: 1px solid {Theme.BORDER};
            }}
        """

    @staticmethod
    def sidebar_style():
        return f"""
            QFrame {{
                background: {Theme.BG_SIDEBAR};
                border-right: 1px solid {Theme.BORDER};
            }}
        """

    @staticmethod
    def nav_button_style(active=False):
        if active:
            return f"""
                QPushButton {{
                    background: {Theme.ACCENT};
                    border: none;
                    border-radius: 6px;
                    color: white;
                    padding: 6px 12px;
                    font-size: 12px;
                    font-weight: 600;
                    text-align: left;
                }}
            """
        return f"""
            QPushButton {{
                background: transparent;
                border: none;
                border-radius: 6px;
                color: {Theme.TEXT_SECONDARY};
                padding: 6px 12px;
                font-size: 12px;
                text-align: left;
            }}
            QPushButton:hover {{
                background: {Theme.BG_CARD};
                color: {Theme.TEXT_PRIMARY};
            }}
        """

    @staticmethod
    def card_style():
        return f"""
            QFrame {{
                background: {Theme.BG_CARD};
                border-radius: 8px;
                border: 1px solid {Theme.BORDER};
            }}
        """

    @staticmethod
    def input_style():
        return f"""
            QLineEdit {{
                background: {Theme.BG_INPUT};
                border: 1px solid {Theme.BORDER};
                border-radius: 5px;
                padding: 5px 10px;
                font-size: 13px;
                color: {Theme.TEXT_PRIMARY};
                selection-background-color: {Theme.ACCENT};
            }}
            QLineEdit:hover {{
                border: 1px solid #4a4a6a;
            }}
            QLineEdit:focus {{
                border: 1px solid {Theme.ACCENT};
                background: #1e1e35;
            }}
            QLineEdit::placeholder {{
                color: {Theme.TEXT_MUTED};
            }}
        """

    @staticmethod
    def combo_style():
        return f"""
            QComboBox {{
                background: {Theme.BG_INPUT};
                border: 1px solid {Theme.BORDER};
                border-radius: 5px;
                padding: 5px 10px;
                font-size: 13px;
                color: {Theme.TEXT_PRIMARY};
            }}
            QComboBox:hover {{
                border: 1px solid #4a4a6a;
            }}
            QComboBox:focus {{
                border: 1px solid {Theme.ACCENT};
            }}
            QComboBox::drop-down {{
                border: none;
                width: 24px;
            }}
            QComboBox::down-arrow {{
                image: none;
                border-left: 4px solid transparent;
                border-right: 4px solid transparent;
                border-top: 5px solid {Theme.TEXT_SECONDARY};
                margin-right: 8px;
            }}
        """

    @staticmethod
    def primary_btn():
        return f"""
            QPushButton {{
                background: {Theme.ACCENT_GRADIENT};
                border: none;
                border-radius: 5px;
                color: white;
                padding: 6px 16px;
                font-size: 13px;
                font-weight: 600;
                min-width: 80px;
                min-height: 28px;
            }}
            QPushButton:hover {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #7c6cf7, stop:1 #b2abfe);
            }}
            QPushButton:pressed {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #5c4cd7, stop:1 #928bee);
            }}
            QPushButton:disabled {{
                background: {Theme.BG_CARD};
                color: {Theme.TEXT_MUTED};
            }}
        """

    @staticmethod
    def success_btn():
        return f"""
            QPushButton {{
                background: {Theme.GREEN_GRADIENT};
                border: none;
                border-radius: 4px;
                color: white;
                padding: 3px 8px;
                font-size: 11px;
                font-weight: 600;
                min-width: 40px;
                min-height: 24px;
            }}
            QPushButton:hover {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #10c9a4, stop:1 #65ffcf);
            }}
        """

    @staticmethod
    def danger_btn():
        return f"""
            QPushButton {{
                background: {Theme.RED_GRADIENT};
                border: none;
                border-radius: 4px;
                color: white;
                padding: 3px 8px;
                font-size: 11px;
                font-weight: 600;
                min-width: 40px;
                min-height: 24px;
            }}
            QPushButton:hover {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #f18065, stop:1 #ffc1b0);
            }}
        """

    @staticmethod
    def ghost_btn():
        return f"""
            QPushButton {{
                background: transparent;
                border: 1px solid {Theme.BORDER};
                border-radius: 4px;
                color: {Theme.TEXT_SECONDARY};
                padding: 3px 8px;
                font-size: 11px;
                min-width: 40px;
                min-height: 24px;
            }}
            QPushButton:hover {{
                background: {Theme.BG_CARD_HOVER};
                color: {Theme.TEXT_PRIMARY};
                border: 1px solid {Theme.ACCENT};
            }}
        """

    @staticmethod
    def table_style():
        return f"""
            QTableWidget {{
                background: {Theme.BG_CARD};
                border: 1px solid {Theme.BORDER};
                border-radius: 8px;
                gridline-color: transparent;
                alternate-background-color: {Theme.BG_CARD_HOVER};
            }}
            QTableWidget::item {{
                padding: 4px 6px;
                border: none;
            }}
            QTableWidget::item:selected {{
                background: {Theme.ACCENT};
                color: white;
            }}
            QHeaderView::section {{
                background: {Theme.BG_SIDEBAR};
                border: none;
                border-bottom: 2px solid {Theme.ACCENT};
                padding: 6px 6px;
                font-weight: 600;
                font-size: 12px;
                color: {Theme.TEXT_SECONDARY};
            }}
        """


# ============== Custom Widgets ==============
class StatusDot(QWidget):
    def __init__(self, active=False, parent=None):
        super().__init__(parent)
        self.active = active
        self.setFixedSize(12, 12)

    def set_active(self, active):
        self.active = active
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        color = QColor(Theme.GREEN) if self.active else QColor(Theme.TEXT_MUTED)
        painter.setBrush(QBrush(color))
        painter.setPen(Qt.NoPen)
        painter.drawEllipse(1, 1, 10, 10)
        if self.active:
            glow = QColor(color)
            glow.setAlpha(60)
            painter.setBrush(QBrush(glow))
            painter.drawEllipse(-2, -2, 16, 16)


class SidebarButton(QPushButton):
    def __init__(self, text, icon_char="", parent=None):
        super().__init__(parent)
        self.icon_char = icon_char
        self.text_content = text
        self.active = False
        self.setText(f"  {icon_char}  {text}" if icon_char else f"  {text}")
        self.setMinimumHeight(32)
        self.setCursor(Qt.PointingHandCursor)

    def set_active(self, active):
        self.active = active
        self.setStyleSheet(Theme.nav_button_style(active))
        self.update()


class GradientCard(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet(Theme.card_style())
        shadow = QGraphicsDropShadowEffect()
        shadow.setBlurRadius(12)
        shadow.setXOffset(0)
        shadow.setYOffset(2)
        shadow.setColor(QColor(0, 0, 0, 30))
        self.setGraphicsEffect(shadow)


# ============== Login Dialog ==============
class LoginDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("FRP 客户端 - 登录")
        self.setModal(True)
        self.setFixedSize(420, 380)
        self.setStyleSheet(f"background: {Theme.BG_DARK};")
        self.server_url = ""
        self.api_token = ""
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setSpacing(14)
        layout.setContentsMargins(36, 28, 36, 28)

        logo_label = QLabel("FRP")
        logo_label.setStyleSheet(f"""
            font-size: 32px;
            font-weight: 800;
            color: transparent;
            background: {Theme.ACCENT_GRADIENT};
            -webkit-background-clip: text;
            background-clip: text;
        """)
        logo_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(logo_label)

        subtitle = QLabel("内网穿透管理平台")
        subtitle.setStyleSheet(f"font-size: 12px; color: {Theme.TEXT_MUTED};")
        subtitle.setAlignment(Qt.AlignCenter)
        layout.addWidget(subtitle)

        layout.addSpacing(4)

        card = GradientCard()
        card_layout = QVBoxLayout()
        card_layout.setSpacing(10)
        card_layout.setContentsMargins(20, 16, 20, 16)

        server_label = QLabel("服务器地址")
        server_label.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500; letter-spacing: 1px;")
        card_layout.addWidget(server_label)
        self.server_input = QLineEdit()
        self.server_input.setPlaceholderText("http://104.208.99.17:5000")
        self.server_input.setStyleSheet(Theme.input_style())
        card_layout.addWidget(self.server_input)

        token_label = QLabel("认证 Token")
        token_label.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500; letter-spacing: 1px;")
        card_layout.addWidget(token_label)

        token_layout = QHBoxLayout()
        token_layout.setSpacing(6)
        self.token_input = QLineEdit()
        self.token_input.setPlaceholderText("请输入您的 API Token")
        self.token_input.setEchoMode(QLineEdit.Password)
        self.token_input.setStyleSheet(Theme.input_style())
        token_layout.addWidget(self.token_input)

        self.toggle_btn = QPushButton("👁")
        self.toggle_btn.setFixedSize(32, 32)
        self.toggle_btn.setStyleSheet(f"""
            QPushButton {{
                background: {Theme.BG_INPUT};
                border: 1px solid {Theme.BORDER};
                border-radius: 5px;
                color: {Theme.TEXT_SECONDARY};
                font-size: 13px;
            }}
            QPushButton:hover {{
                border: 1px solid {Theme.ACCENT};
            }}
        """)
        self.toggle_btn.setCursor(Qt.PointingHandCursor)
        self.toggle_btn.clicked.connect(self.toggle_token_visibility)
        token_layout.addWidget(self.toggle_btn)

        card_layout.addLayout(token_layout)

        hint_label = QLabel("可在网页端 Dashboard 中获取 Token")
        hint_label.setStyleSheet(f"font-size: 10px; color: {Theme.TEXT_MUTED};")
        card_layout.addWidget(hint_label)

        card.setLayout(card_layout)
        layout.addWidget(card)

        self.connect_btn = QPushButton("连 接")
        self.connect_btn.setStyleSheet(Theme.primary_btn())
        self.connect_btn.setMinimumHeight(38)
        self.connect_btn.setCursor(Qt.PointingHandCursor)
        self.connect_btn.clicked.connect(self.on_connect)
        layout.addWidget(self.connect_btn)

        self.setLayout(layout)

    def toggle_token_visibility(self):
        if self.token_input.echoMode() == QLineEdit.Password:
            self.token_input.setEchoMode(QLineEdit.Normal)
            self.toggle_btn.setText("🔒")
        else:
            self.token_input.setEchoMode(QLineEdit.Password)
            self.toggle_btn.setText("👁")

    def on_connect(self):
        server_url = self.server_input.text().strip()
        api_token = self.token_input.text().strip()
        if not server_url:
            QMessageBox.warning(self, "提示", "请输入服务器地址")
            return
        if not api_token:
            QMessageBox.warning(self, "提示", "请输入认证 Token")
            return
        self.server_url = server_url
        self.api_token = api_token
        self.accept()


# ============== Create Tunnel Dialog ==============
GAME_PRESETS = {
    "自定义": None,
    "Minecraft Java": {"port": 25565, "protocol": "TCP"},
    "Minecraft 基岩版": {"port": 19132, "protocol": "UDP"},
    "Terraria": {"port": 7777, "protocol": "TCP"},
    "Palworld 幻兽帕鲁": {"port": 8211, "protocol": "UDP"},
    "Valheim 英灵神殿": {"port": 2456, "protocol": "UDP"},
    "ARK 方舟": {"port": 7777, "protocol": "UDP"},
    "CS2": {"port": 27015, "protocol": "UDP"},
    "Rust": {"port": 28015, "protocol": "TCP"},
    "Don't Starve 饥荒": {"port": 10999, "protocol": "UDP"},
    "Stardew Valley 星露谷": {"port": 24642, "protocol": "UDP"},
    "Factorio 异星工厂": {"port": 34197, "protocol": "UDP"},
    "Garry's Mod": {"port": 27015, "protocol": "TCP"},
    "Left 4 Dead 2": {"port": 27015, "protocol": "TCP"},
    "HTTP/Web": {"port": 80, "protocol": "TCP"},
    "HTTPS": {"port": 443, "protocol": "TCP"},
    "SSH": {"port": 22, "protocol": "TCP"},
    "RDP 远程桌面": {"port": 3389, "protocol": "TCP"},
}

class CreateTunnelDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("创建隧道")
        self.setModal(True)
        self.setFixedSize(400, 440)
        self.setStyleSheet(f"background: {Theme.BG_DARK};")
        self.local_port = 0
        self.protocol = "tcp"
        self.name = ""
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setSpacing(14)
        layout.setContentsMargins(28, 28, 28, 28)

        title = QLabel("创建新隧道")
        title.setStyleSheet(f"font-size: 20px; font-weight: 700; color: {Theme.TEXT_PRIMARY};")
        layout.addWidget(title)

        desc = QLabel("配置您的内网穿透隧道参数")
        desc.setStyleSheet(f"font-size: 12px; color: {Theme.TEXT_MUTED};")
        layout.addWidget(desc)

        card = GradientCard()
        card_layout = QVBoxLayout()
        card_layout.setSpacing(10)
        card_layout.setContentsMargins(18, 16, 18, 16)

        preset_label = QLabel("游戏/应用预设")
        preset_label.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500; letter-spacing: 1px;")
        card_layout.addWidget(preset_label)
        self.preset_combo = QComboBox()
        self.preset_combo.addItems(GAME_PRESETS.keys())
        self.preset_combo.setStyleSheet(Theme.combo_style())
        self.preset_combo.currentTextChanged.connect(self.on_preset_changed)
        card_layout.addWidget(self.preset_combo)

        port_label = QLabel("本地端口")
        port_label.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500; letter-spacing: 1px;")
        card_layout.addWidget(port_label)
        self.port_input = QLineEdit()
        self.port_input.setPlaceholderText("例如: 8080")
        self.port_input.setStyleSheet(Theme.input_style())
        card_layout.addWidget(self.port_input)

        protocol_label = QLabel("协议类型")
        protocol_label.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500; letter-spacing: 1px;")
        card_layout.addWidget(protocol_label)
        self.protocol_combo = QComboBox()
        self.protocol_combo.addItems(["TCP", "UDP"])
        self.protocol_combo.setStyleSheet(Theme.combo_style())
        card_layout.addWidget(self.protocol_combo)

        name_label = QLabel("隧道名称")
        name_label.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500; letter-spacing: 1px;")
        card_layout.addWidget(name_label)
        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText("可选，便于识别")
        self.name_input.setStyleSheet(Theme.input_style())
        card_layout.addWidget(self.name_input)

        card.setLayout(card_layout)
        layout.addWidget(card)

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        cancel_btn = QPushButton("取消")
        cancel_btn.setStyleSheet(Theme.ghost_btn())
        cancel_btn.setMinimumHeight(36)
        cancel_btn.setCursor(Qt.PointingHandCursor)
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        ok_btn = QPushButton("创建隧道")
        ok_btn.setStyleSheet(Theme.primary_btn())
        ok_btn.setMinimumHeight(36)
        ok_btn.setCursor(Qt.PointingHandCursor)
        ok_btn.clicked.connect(self.on_accept)
        btn_layout.addWidget(ok_btn)

        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def on_preset_changed(self, text):
        preset = GAME_PRESETS.get(text)
        if preset:
            self.port_input.setText(str(preset["port"]))
            idx = self.protocol_combo.findText(preset["protocol"])
            if idx >= 0:
                self.protocol_combo.setCurrentIndex(idx)
            if text != "自定义":
                self.name_input.setText(text)

    def on_accept(self):
        try:
            self.local_port = int(self.port_input.text().strip())
            if self.local_port < 1 or self.local_port > 65535:
                raise ValueError()
        except ValueError:
            QMessageBox.warning(self, "提示", "请输入有效的端口号 (1-65535)")
            return
        self.protocol = self.protocol_combo.currentText().lower()
        self.name = self.name_input.text().strip() or None
        self.accept()


# ============== Main Window ==============
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("FRP 内网穿透客户端")
        self.setGeometry(100, 100, 960, 600)
        self.setStyleSheet(Theme.app_stylesheet())

        self.config_manager = ConfigManager()
        self.frpc_manager = FRPCManager()
        self.api_client = None
        self.tunnels = []
        self.current_page = "tunnels"

        self.init_ui()
        self.init_tray()
        self.init_timer()
        self.try_auto_login()

    def init_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout()
        main_layout.setSpacing(0)
        main_layout.setContentsMargins(0, 0, 0, 0)

        # Sidebar
        sidebar = QFrame()
        sidebar.setFixedWidth(180)
        sidebar.setStyleSheet(Theme.sidebar_style())
        sidebar_layout = QVBoxLayout()
        sidebar_layout.setSpacing(6)
        sidebar_layout.setContentsMargins(12, 18, 12, 18)

        logo = QLabel("FRP")
        logo.setStyleSheet(f"""
            font-size: 22px; font-weight: 800; padding: 6px 10px;
            color: {Theme.ACCENT_LIGHT};
        """)
        sidebar_layout.addWidget(logo)

        version = QLabel("v1.0.0")
        version.setStyleSheet(f"font-size: 10px; color: {Theme.TEXT_MUTED}; padding: 0px 10px; margin-bottom: 10px;")
        sidebar_layout.addWidget(version)

        self.nav_tunnels = SidebarButton("隧道管理", "◉")
        self.nav_tunnels.set_active(True)
        self.nav_tunnels.clicked.connect(lambda: self.switch_page("tunnels"))
        self.nav_tunnels.setMinimumHeight(36)
        sidebar_layout.addWidget(self.nav_tunnels)

        sidebar_layout.addStretch()

        self.user_card = QFrame()
        self.user_card.setStyleSheet(f"""
            QFrame {{
                background: {Theme.BG_CARD};
                border-radius: 10px;
                padding: 8px;
            }}
        """)
        user_layout = QHBoxLayout()
        user_layout.setContentsMargins(6, 6, 6, 6)

        self.user_dot = StatusDot(active=False)
        user_layout.addWidget(self.user_dot)

        self.user_label = QLabel("未登录")
        self.user_label.setStyleSheet(f"font-size: 12px; color: {Theme.TEXT_SECONDARY};")
        user_layout.addWidget(self.user_label)
        user_layout.addStretch()

        self.user_card.setLayout(user_layout)
        sidebar_layout.addWidget(self.user_card)

        sidebar.setLayout(sidebar_layout)
        main_layout.addWidget(sidebar)

        # Content area
        content = QWidget()
        content_layout = QVBoxLayout()
        content_layout.setSpacing(14)
        content_layout.setContentsMargins(24, 20, 24, 20)

        top_bar = QHBoxLayout()
        top_bar.setSpacing(10)

        self.page_title = QLabel("隧道管理")
        self.page_title.setStyleSheet(f"font-size: 22px; font-weight: 700; color: {Theme.TEXT_PRIMARY};")
        top_bar.addWidget(self.page_title)

        top_bar.addStretch()

        self.login_btn = QPushButton("登 录")
        self.login_btn.setStyleSheet(Theme.primary_btn())
        self.login_btn.setCursor(Qt.PointingHandCursor)
        self.login_btn.clicked.connect(self.show_login_dialog)
        top_bar.addWidget(self.login_btn)

        self.logout_btn = QPushButton("退出登录")
        self.logout_btn.setStyleSheet(Theme.ghost_btn())
        self.logout_btn.setCursor(Qt.PointingHandCursor)
        self.logout_btn.clicked.connect(self.logout)
        self.logout_btn.setVisible(False)
        top_bar.addWidget(self.logout_btn)

        content_layout.addLayout(top_bar)

        # Stats row
        stats_layout = QHBoxLayout()
        stats_layout.setSpacing(12)

        self.stat_total = self._create_stat_card("隧道总数", "0", Theme.ACCENT)
        self.stat_running = self._create_stat_card("运行中", "0", Theme.GREEN)
        self.stat_stopped = self._create_stat_card("已停止", "0", Theme.RED)

        stats_layout.addWidget(self.stat_total)
        stats_layout.addWidget(self.stat_running)
        stats_layout.addWidget(self.stat_stopped)
        stats_layout.addStretch()

        content_layout.addLayout(stats_layout)

        # Action bar
        action_layout = QHBoxLayout()
        action_layout.setSpacing(10)

        self.create_btn = QPushButton("+ 创建隧道")
        self.create_btn.setStyleSheet(Theme.primary_btn())
        self.create_btn.setCursor(Qt.PointingHandCursor)
        self.create_btn.clicked.connect(self.create_tunnel)
        self.create_btn.setEnabled(False)
        self.create_btn.setFixedHeight(32)
        action_layout.addWidget(self.create_btn)

        self.refresh_btn = QPushButton("刷新列表")
        self.refresh_btn.setStyleSheet(Theme.ghost_btn())
        self.refresh_btn.setCursor(Qt.PointingHandCursor)
        self.refresh_btn.clicked.connect(self.refresh_tunnels)
        self.refresh_btn.setEnabled(False)
        self.refresh_btn.setFixedHeight(32)
        action_layout.addWidget(self.refresh_btn)

        self.ping_btn = QPushButton("延迟测试")
        self.ping_btn.setStyleSheet(Theme.ghost_btn())
        self.ping_btn.setCursor(Qt.PointingHandCursor)
        self.ping_btn.clicked.connect(self.test_latency)
        self.ping_btn.setEnabled(False)
        self.ping_btn.setFixedHeight(32)
        action_layout.addWidget(self.ping_btn)

        action_layout.addStretch()
        content_layout.addLayout(action_layout)

        # Table
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(["ID", "名称", "本地端口", "服务器端口", "协议", "状态", "操作"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(6, QHeaderView.Fixed)
        self.table.setColumnWidth(6, 200)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setStyleSheet(Theme.table_style())
        self.table.verticalHeader().setVisible(False)
        self.table.setShowGrid(False)
        self.table.verticalHeader().setDefaultSectionSize(40)
        content_layout.addWidget(self.table)

        content.setLayout(content_layout)
        main_layout.addWidget(content)

        central.setLayout(main_layout)

    def _create_stat_card(self, title, value, accent_color):
        card = GradientCard()
        card.setFixedHeight(64)
        card.setMinimumWidth(120)
        layout = QVBoxLayout()
        layout.setSpacing(2)
        layout.setContentsMargins(14, 8, 14, 8)

        title_lbl = QLabel(title)
        title_lbl.setStyleSheet(f"font-size: 11px; color: {Theme.TEXT_MUTED}; font-weight: 500;")
        layout.addWidget(title_lbl)

        value_lbl = QLabel(value)
        value_lbl.setStyleSheet(f"font-size: 22px; font-weight: 700; color: {accent_color};")
        value_lbl.setObjectName("value")
        layout.addWidget(value_lbl)

        card.setLayout(layout)
        return card

    def _update_stat_card(self, card, value):
        lbl = card.findChild(QLabel, "value")
        if lbl:
            lbl.setText(str(value))

    def switch_page(self, page):
        self.current_page = page
        self.nav_tunnels.set_active(page == "tunnels")

    def init_tray(self):
        tray_pixmap = QPixmap(32, 32)
        tray_pixmap.fill(QColor(Theme.ACCENT))
        painter = QPainter(tray_pixmap)
        painter.setPen(QPen(QColor("white"), 2))
        font = QFont("Arial", 16, QFont.Bold)
        painter.setFont(font)
        painter.drawText(tray_pixmap.rect(), Qt.AlignCenter, "F")
        painter.end()
        tray_icon = QIcon(tray_pixmap)
        self.tray_icon = QSystemTrayIcon(tray_icon, self)
        self.tray_icon.setToolTip("FRP 客户端")
        tray_menu = QMenu()
        tray_menu.setStyleSheet(f"""
            QMenu {{
                background: {Theme.BG_CARD};
                color: {Theme.TEXT_PRIMARY};
                border: 1px solid {Theme.BORDER};
                padding: 4px;
            }}
            QMenu::item {{
                padding: 6px 24px;
            }}
            QMenu::item:selected {{
                background: {Theme.ACCENT};
            }}
        """)
        show_action = QAction("显示主窗口", self)
        show_action.triggered.connect(self.show)
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self.quit_application)
        tray_menu.addAction(show_action)
        tray_menu.addSeparator()
        tray_menu.addAction(quit_action)
        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.activated.connect(self.on_tray_activated)
        self.tray_icon.show()

    def init_timer(self):
        self.refresh_timer = QTimer()
        self.refresh_timer.timeout.connect(self.update_tunnel_status)
        self.refresh_timer.start(5000)

    def on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.DoubleClick:
            self.show()
            self.activateWindow()

    def closeEvent(self, event):
        event.ignore()
        self.hide()
        self.tray_icon.showMessage("FRP 客户端", "程序已最小化到系统托盘", QSystemTrayIcon.Information, 2000)

    def quit_application(self):
        reply = QMessageBox.question(self, "确认退出", "确定要退出程序吗？\n运行中的隧道将被停止.",
                                     QMessageBox.Yes | QMessageBox.No)
        if reply == QMessageBox.Yes:
            self.frpc_manager.cleanup()
            QApplication.quit()

    def try_auto_login(self):
        server_url = self.config_manager.get_server_url()
        credentials = self.config_manager.get_credentials()
        if server_url and credentials:
            username, access_token = credentials
            self.api_client = FRPApiClient(server_url)
            self.api_client.access_token = access_token
            self.api_client.user_info = {"username": username}
            self.on_login_success(username)
            self.refresh_tunnels()

    def show_login_dialog(self):
        dialog = LoginDialog(self)
        server_url = self.config_manager.get_server_url()
        if server_url:
            dialog.server_input.setText(server_url)
        if dialog.exec_() == QDialog.Accepted:
            self.config_manager.save_server_url(dialog.server_url)
            self.api_client = FRPApiClient(dialog.server_url)
            try:
                user_info = self.api_client.token_login(dialog.api_token)
                username = user_info.get("username", user_info.get("id", ""))
                self.config_manager.save_credentials(username, user_info["access_token"])
                self.on_login_success(username)
                self.refresh_tunnels()
            except Exception as e:
                QMessageBox.critical(self, "连接失败", str(e))

    def on_login_success(self, username):
        self.user_label.setText(username)
        self.user_label.setStyleSheet(f"font-size: 13px; color: {Theme.TEXT_PRIMARY}; font-weight: 500;")
        self.user_dot.set_active(True)
        self.login_btn.setVisible(False)
        self.logout_btn.setVisible(True)
        self.create_btn.setEnabled(True)
        self.refresh_btn.setEnabled(True)
        self.ping_btn.setEnabled(True)

    def logout(self):
        self.api_client = None
        self.config_manager.clear_credentials()
        self.user_label.setText("未登录")
        self.user_label.setStyleSheet(f"font-size: 13px; color: {Theme.TEXT_SECONDARY};")
        self.user_dot.set_active(False)
        self.login_btn.setVisible(True)
        self.logout_btn.setVisible(False)
        self.create_btn.setEnabled(False)
        self.refresh_btn.setEnabled(False)
        self.ping_btn.setEnabled(False)
        self.table.setRowCount(0)
        self.tunnels = []
        self._update_stat_card(self.stat_total, "0")
        self._update_stat_card(self.stat_running, "0")
        self._update_stat_card(self.stat_stopped, "0")

    def create_tunnel(self):
        dialog = CreateTunnelDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            try:
                tunnel = self.api_client.create_tunnel(dialog.local_port, dialog.protocol, dialog.name)
                tunnel_id = tunnel['id']
                try:
                    config_content = self.api_client.get_tunnel_config(tunnel_id)
                    config_path = self.frpc_manager.write_config(tunnel_id, config_content)
                    pid = self.frpc_manager.start_tunnel(tunnel_id, config_path)
                    self.config_manager.save_tunnel_state(tunnel_id, pid, config_path)
                    QMessageBox.information(self, "创建并启动成功",
                        f"隧道创建成功并已启动！\n\n隧道ID: {tunnel_id}\n本地端口: {tunnel['local_port']}\n服务器端口: {tunnel['server_port']}")
                except Exception as start_err:
                    QMessageBox.warning(self, "隧道已创建",
                        f"隧道创建成功，但启动失败：\n{str(start_err)}\n\n隧道ID: {tunnel_id}\n服务器端口: {tunnel['server_port']}\n\n请手动点击启动按钮。")
                self.refresh_tunnels()
            except Exception as e:
                QMessageBox.critical(self, "创建失败", str(e))

    def refresh_tunnels(self):
        if not self.api_client or not self.api_client.is_authenticated():
            return
        try:
            self.tunnels = self.api_client.list_tunnels()
            self.update_table()
        except Exception as e:
            QMessageBox.critical(self, "刷新失败", str(e))

    def update_table(self):
        running_count = 0
        stopped_count = 0
        for t in self.tunnels:
            if self.frpc_manager.is_tunnel_running(t["id"]):
                running_count += 1
            else:
                stopped_count += 1

        self._update_stat_card(self.stat_total, str(len(self.tunnels)))
        self._update_stat_card(self.stat_running, str(running_count))
        self._update_stat_card(self.stat_stopped, str(stopped_count))

        self.table.setRowCount(len(self.tunnels))
        for row, tunnel in enumerate(self.tunnels):
            tunnel_id = tunnel["id"]

            id_item = QTableWidgetItem(str(tunnel_id))
            id_item.setForeground(QColor(Theme.TEXT_MUTED))
            self.table.setItem(row, 0, id_item)

            name_item = QTableWidgetItem(tunnel["name"] or "(无名称)")
            name_item.setForeground(QColor(Theme.TEXT_PRIMARY))
            font = name_item.font()
            font.setWeight(600)
            name_item.setFont(font)
            self.table.setItem(row, 1, name_item)

            self.table.setItem(row, 2, QTableWidgetItem(str(tunnel["local_port"])))
            self.table.setItem(row, 3, QTableWidgetItem(str(tunnel["server_port"])))

            proto_item = QTableWidgetItem(tunnel["protocol"].upper())
            proto_item.setForeground(QColor(Theme.ACCENT_LIGHT))
            self.table.setItem(row, 4, proto_item)

            is_running = self.frpc_manager.is_tunnel_running(tunnel_id)
            status_item = QTableWidgetItem("运行中" if is_running else "已停止")
            status_item.setForeground(QColor(Theme.GREEN) if is_running else QColor(Theme.RED))
            font = status_item.font()
            font.setWeight(600)
            status_item.setFont(font)
            self.table.setItem(row, 5, status_item)

            button_widget = QWidget()
            button_layout = QHBoxLayout()
            button_layout.setContentsMargins(6, 4, 6, 4)
            button_layout.setSpacing(6)

            if is_running:
                stop_btn = QPushButton("停止")
                stop_btn.setStyleSheet(Theme.danger_btn())
                stop_btn.setCursor(Qt.PointingHandCursor)
                stop_btn.clicked.connect(lambda checked, tid=tunnel_id: self.stop_tunnel(tid))
                button_layout.addWidget(stop_btn)
            else:
                start_btn = QPushButton("启动")
                start_btn.setStyleSheet(Theme.success_btn())
                start_btn.setCursor(Qt.PointingHandCursor)
                start_btn.clicked.connect(lambda checked, tid=tunnel_id: self.start_tunnel(tid))
                button_layout.addWidget(start_btn)

            log_btn = QPushButton("日志")
            log_btn.setStyleSheet(Theme.ghost_btn())
            log_btn.setCursor(Qt.PointingHandCursor)
            log_btn.clicked.connect(lambda checked, tid=tunnel_id: self.view_log(tid))
            button_layout.addWidget(log_btn)

            delete_btn = QPushButton("删除")
            delete_btn.setStyleSheet(Theme.ghost_btn())
            delete_btn.setCursor(Qt.PointingHandCursor)
            delete_btn.clicked.connect(lambda checked, tid=tunnel_id: self.delete_tunnel(tid))
            button_layout.addWidget(delete_btn)

            button_widget.setLayout(button_layout)
            self.table.setCellWidget(row, 6, button_widget)

    def view_log(self, tunnel_id):
        log_path = self.frpc_manager.bin_dir / f"frpc_tunnel_{tunnel_id}.log"
        if log_path.exists():
            log_content = log_path.read_text(encoding="utf-8", errors="ignore")
            if not log_content.strip():
                log_content = "(日志文件为空，frpc 可能尚未输出任何信息)"
        else:
            log_content = "(日志文件不存在，隧道可能从未启动过)"
        dialog = QDialog(self)
        dialog.setWindowTitle(f"隧道 {tunnel_id} - frpc 日志")
        dialog.setFixedSize(600, 400)
        dialog.setStyleSheet(f"background: {Theme.BG_DARK};")
        layout = QVBoxLayout()
        layout.setSpacing(10)
        layout.setContentsMargins(16, 16, 16, 16)
        header = QLabel(f"隧道 {tunnel_id} 的 frpc 日志")
        header.setStyleSheet(f"font-size: 14px; font-weight: 600; color: {Theme.TEXT_PRIMARY};")
        layout.addWidget(header)
        from PyQt5.QtWidgets import QTextEdit
        log_text = QTextEdit()
        log_text.setReadOnly(True)
        log_text.setStyleSheet(f"""
            QTextEdit {{
                background: {Theme.BG_INPUT};
                color: {Theme.TEXT_PRIMARY};
                border: 1px solid {Theme.BORDER};
                border-radius: 6px;
                padding: 8px;
                font-family: "Consolas", "Courier New", monospace;
                font-size: 12px;
            }}
        """)
        log_text.setPlainText(log_content)
        layout.addWidget(log_text)
        close_btn = QPushButton("关 闭")
        close_btn.setStyleSheet(Theme.primary_btn())
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.clicked.connect(dialog.accept)
        layout.addWidget(close_btn)
        dialog.setLayout(layout)
        dialog.exec_()

    def start_tunnel(self, tunnel_id):
        try:
            config_content = self.api_client.get_tunnel_config(tunnel_id)
            config_path = self.frpc_manager.write_config(tunnel_id, config_content)
            pid = self.frpc_manager.start_tunnel(tunnel_id, config_path)
            self.config_manager.save_tunnel_state(tunnel_id, pid, config_path)
            QMessageBox.information(self, "启动成功", f"隧道 {tunnel_id} 启动成功")
            self.update_table()
        except Exception as e:
            QMessageBox.critical(self, "启动失败", str(e))

    def stop_tunnel(self, tunnel_id):
        try:
            self.frpc_manager.stop_tunnel(tunnel_id)
            self.config_manager.remove_tunnel_state(tunnel_id)
            QMessageBox.information(self, "停止成功", f"隧道 {tunnel_id} 已停止")
            self.update_table()
        except Exception as e:
            QMessageBox.critical(self, "停止失败", str(e))

    def delete_tunnel(self, tunnel_id):
        reply = QMessageBox.question(self, "确认删除", f"确定要删除隧道 {tunnel_id} 吗？",
                                      QMessageBox.Yes | QMessageBox.No)
        if reply == QMessageBox.Yes:
            try:
                if self.frpc_manager.is_tunnel_running(tunnel_id):
                    self.frpc_manager.stop_tunnel(tunnel_id)
                    self.config_manager.remove_tunnel_state(tunnel_id)
                self.api_client.delete_tunnel(tunnel_id)
                QMessageBox.information(self, "删除成功", f"隧道 {tunnel_id} 已删除")
                self.refresh_tunnels()
            except Exception as e:
                QMessageBox.critical(self, "删除失败", str(e))

    def update_tunnel_status(self):
        if self.tunnels:
            self.update_table()

    def test_latency(self):
        if not self.api_client:
            return
        server_url = self.api_client.server_url
        from urllib.parse import urlparse
        parsed = urlparse(server_url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        self.ping_btn.setEnabled(False)
        self.ping_btn.setText("测试中...")
        QApplication.processEvents()
        try:
            import socket
            results = []
            for i in range(4):
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(5)
                t0 = time.time()
                sock.connect((host, port))
                latency = (time.time() - t0) * 1000
                sock.close()
                results.append(latency)
                time.sleep(0.3)
            avg = sum(results) / len(results)
            mn = min(results)
            mx = max(results)
            self.ping_btn.setText(f"{avg:.0f}ms")
            QMessageBox.information(self, "延迟测试结果",
                f"服务器: {host}:{port}\n\n"
                f"平均延迟: {avg:.1f} ms\n"
                f"最低: {mn:.1f} ms\n"
                f"最高: {mx:.1f} ms\n"
                f"测试次数: {len(results)}")
        except Exception as e:
            self.ping_btn.setText("延迟测试")
            QMessageBox.critical(self, "测试失败", f"无法连接到服务器 {host}:{port}\n{str(e)}")
        finally:
            self.ping_btn.setEnabled(True)


def main():
    try:
        QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
        QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
        app = QApplication(sys.argv)
        app.setApplicationName("FRP客户端")
        app.setQuitOnLastWindowClosed(False)
        font = QFont("Segoe UI", 10)
        app.setFont(font)
        window = MainWindow()
        window.show()
        sys.exit(app.exec_())
    except Exception as e:
        import traceback
        error_msg = f"程序发生错误: {str(e)}\n\n{traceback.format_exc()}"
        try:
            # 尝试显示错误对话框
            error_app = QApplication(sys.argv)
            QMessageBox.critical(None, "程序错误", error_msg)
        except:
            # 如果无法显示对话框，打印到控制台
            print(error_msg)
        sys.exit(1)


if __name__ == '__main__':
    main()
