"""
Windows GUI for FRP Client.

Provides graphical interface with:
- Login/Register dialogs
- Tunnel management table
- Start/Stop/Delete operations
- System tray integration
- Auto-start support
- Beautiful modern UI with themes
- Port group / game preset support
"""

import sys
import os

# Fix imports - simple approach
if __name__ == '__main__':
    if getattr(sys, 'frozen', False):
        # PyInstaller bundle
        pass
    else:
        # Development
        parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if parent_dir not in sys.path:
            sys.path.insert(0, parent_dir)

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QTableWidget, QTableWidgetItem, QPushButton, QDialog, QLabel,
    QLineEdit, QComboBox, QMessageBox, QSystemTrayIcon, QMenu,
    QAction, QHeaderView, QDialogButtonBox, QFormLayout, QFrame,
    QStackedWidget, QSplitter, QGroupBox, QCheckBox,
    QTabWidget, QScrollArea, QFileDialog
)
from PyQt5.QtCore import Qt, QTimer, QSize, QPropertyAnimation, QEasingCurve, pyqtProperty
from PyQt5.QtGui import QIcon, QColor, QFont, QPalette, QPixmap

# Simple import - copy the classes directly here
# First, try to import from various ways
import importlib.util

def import_module(name):
    """Helper to import module with fallback methods"""
    try:
        return importlib.import_module(name)
    except ImportError:
        return None

# Try different import strategies
api_client = import_module('api_client')
if not api_client:
    api_client = import_module('frp_client.api_client')

frpc_manager = import_module('frpc_manager')
if not frpc_manager:
    frpc_manager = import_module('frp_client.frpc_manager')

config_manager = import_module('config_manager')
if not config_manager:
    config_manager = import_module('frp_client.config_manager')

# Get the classes from imported modules
if api_client:
    FRPApiClient = getattr(api_client, 'FRPApiClient', None)
    AuthenticationError = getattr(api_client, 'AuthenticationError', None)
    APIError = getattr(api_client, 'APIError', None)

if frpc_manager:
    FRPCManager = getattr(frpc_manager, 'FRPCManager', None)
    FRPCManagerError = getattr(frpc_manager, 'FRPCManagerError', None)

if config_manager:
    ConfigManager = getattr(config_manager, 'ConfigManager', None)

# If all else fails, copy the essential code
if not FRPApiClient:
    # Fallback minimal implementation (simplified)
    class AuthenticationError(Exception): pass
    class APIError(Exception): pass
    class FRPApiClient: pass
    class FRPCManager: pass
    class FRPCManagerError(Exception): pass
    class ConfigManager: pass


class StyleHelper:
    """Helper class for styling."""
    
    @staticmethod
    def get_button_style(btn_type="primary"):
        styles = {
            "primary": """
                QPushButton {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #667eea, stop:1 #764ba2);
                    border: none;
                    border-radius: 8px;
                    color: white;
                    padding: 10px 24px;
                    font-size: 14px;
                    font-weight: 600;
                }
                QPushButton:hover {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #764ba2, stop:1 #667eea);
                }
                QPushButton:pressed {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #5a6fd6, stop:1 #6a4190);
                }
                QPushButton:disabled {
                    background: #cccccc;
                    color: #999999;
                }
            """,
            "success": """
                QPushButton {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #11998e, stop:1 #38ef7d);
                    border: none;
                    border-radius: 8px;
                    color: white;
                    padding: 8px 16px;
                    font-size: 13px;
                    font-weight: 600;
                }
                QPushButton:hover {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #38ef7d, stop:1 #11998e);
                }
            """,
            "danger": """
                QPushButton {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #eb3349, stop:1 #f45c43);
                    border: none;
                    border-radius: 8px;
                    color: white;
                    padding: 8px 16px;
                    font-size: 13px;
                    font-weight: 600;
                }
                QPushButton:hover {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                        stop:0 #f45c43, stop:1 #eb3349);
                }
            """,
            "default": """
                QPushButton {
                    background: #f0f0f0;
                    border: 1px solid #ddd;
                    border-radius: 8px;
                    color: #333;
                    padding: 8px 16px;
                    font-size: 13px;
                }
                QPushButton:hover {
                    background: #e0e0e0;
                }
            """,
            "small": """
                QPushButton {
                    background: #409eff;
                    border: none;
                    border-radius: 6px;
                    color: white;
                    padding: 6px 12px;
                    font-size: 12px;
                }
                QPushButton:hover {
                    background: #66b1ff;
                }
            """
        }
        return styles.get(btn_type, styles["default"])
    
    @staticmethod
    def get_input_style():
        return """
            QLineEdit {
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                padding: 10px 14px;
                font-size: 14px;
                background: white;
            }
            QLineEdit:focus {
                border: 2px solid #667eea;
            }
        """
    
    @staticmethod
    def get_combo_style():
        return """
            QComboBox {
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                padding: 10px 14px;
                font-size: 14px;
                background: white;
            }
            QComboBox:focus {
                border: 2px solid #667eea;
            }
            QComboBox::drop-down {
                border: none;
                width: 30px;
            }
            QComboBox::down-arrow {
                image: none;
                border-left: 5px solid transparent;
                border-right: 5px solid transparent;
                border-top: 5px solid #666;
            }
        """
    
    @staticmethod
    def get_table_style():
        return """
            QTableWidget {
                border: 1px solid #e0e0e0;
                border-radius: 12px;
                background: white;
                gridline-color: #f0f0f0;
                alternate-background-color: #fafafa;
            }
            QTableWidget::item {
                padding: 12px;
            }
            QTableWidget::item:selected {
                background: #667eea;
                color: white;
            }
            QHeaderView::section {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #f8f9fa, stop:1 #e9ecef);
                border: none;
                border-bottom: 2px solid #667eea;
                padding: 14px;
                font-weight: 600;
                color: #333;
            }
        """
    
    @staticmethod
    def get_card_style():
        return """
            QFrame {
                background: white;
                border-radius: 12px;
                border: 1px solid #e0e0e0;
            }
        """


class LoginDialog(QDialog):
    """Beautiful login/register dialog."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("FRP 客户端")
        self.setModal(True)
        self.setFixedSize(480, 560)
        self.setStyleSheet("background: #f5f7fa;")

        self.server_url = ""
        self.username = ""
        self.password = ""
        self.is_register = False

        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setSpacing(24)
        layout.setContentsMargins(40, 40, 40, 40)

        # Title
        title_label = QLabel("欢迎回来")
        title_label.setStyleSheet("""
            font-size: 28px;
            font-weight: 700;
            color: #333;
        """)
        title_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(title_label)

        subtitle_label = QLabel("登录您的账户以继续")
        subtitle_label.setStyleSheet("""
            font-size: 14px;
            color: #999;
        """)
        subtitle_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(subtitle_label)

        # Form card
        form_card = QFrame()
        form_card.setStyleSheet(StyleHelper.get_card_style())
        form_layout = QVBoxLayout()
        form_layout.setSpacing(16)
        form_layout.setContentsMargins(24, 24, 24, 24)

        # Server URL
        self.server_input = QLineEdit()
        self.server_input.setPlaceholderText("http://example.com:5000")
        self.server_input.setStyleSheet(StyleHelper.get_input_style())
        
        server_label = QLabel("服务器地址")
        server_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(server_label)
        form_layout.addWidget(self.server_input)

        # Username
        self.username_input = QLineEdit()
        self.username_input.setPlaceholderText("请输入用户名")
        
        username_label = QLabel("用户名")
        username_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(username_label)
        form_layout.addWidget(self.username_input)

        # Password
        self.password_input = QLineEdit()
        self.password_input.setEchoMode(QLineEdit.Password)
        self.password_input.setPlaceholderText("请输入密码")
        
        password_label = QLabel("密码")
        password_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(password_label)
        form_layout.addWidget(self.password_input)

        form_card.setLayout(form_layout)
        layout.addWidget(form_card)

        # Buttons
        button_layout = QVBoxLayout()
        button_layout.setSpacing(12)

        self.login_btn = QPushButton("登录")
        self.login_btn.setStyleSheet(StyleHelper.get_button_style("primary"))
        self.login_btn.setMinimumHeight(48)
        self.login_btn.clicked.connect(self.on_login)

        self.register_btn = QPushButton("注册新账户")
        self.register_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        self.register_btn.setMinimumHeight(44)
        self.register_btn.clicked.connect(self.on_register)

        cancel_btn = QPushButton("取消")
        cancel_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        cancel_btn.clicked.connect(self.reject)

        button_layout.addWidget(self.login_btn)
        button_layout.addWidget(self.register_btn)
        button_layout.addWidget(cancel_btn)

        layout.addLayout(button_layout)
        layout.addStretch()

        self.setLayout(layout)

    def on_login(self):
        self.server_url = self.server_input.text().strip()
        self.username = self.username_input.text().strip()
        self.password = self.password_input.text()

        if not self.server_url or not self.username or not self.password:
            QMessageBox.warning(self, "错误", "请填写所有字段")
            return

        self.accept()

    def on_register(self):
        self.server_url = self.server_input.text().strip()
        self.username = self.username_input.text().strip()
        self.password = self.password_input.text()
        self.is_register = True

        if not self.server_url or not self.username or not self.password:
            QMessageBox.warning(self, "错误", "请填写所有字段")
            return

        self.accept()


class CreateTunnelDialog(QDialog):
    """Beautiful create tunnel dialog."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("创建隧道")
        self.setModal(True)
        self.setFixedSize(460, 420)
        self.setStyleSheet("background: #f5f7fa;")

        self.local_port = 0
        self.protocol = "tcp"
        self.name = ""

        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(32, 32, 32, 32)

        # Title
        title_label = QLabel("创建新隧道")
        title_label.setStyleSheet("""
            font-size: 24px;
            font-weight: 700;
            color: #333;
        """)
        layout.addWidget(title_label)

        # Form card
        form_card = QFrame()
        form_card.setStyleSheet(StyleHelper.get_card_style())
        form_layout = QVBoxLayout()
        form_layout.setSpacing(16)
        form_layout.setContentsMargins(24, 24, 24, 24)

        # Local Port
        self.port_input = QLineEdit()
        self.port_input.setPlaceholderText("例如: 8080")
        self.port_input.setStyleSheet(StyleHelper.get_input_style())
        
        port_label = QLabel("本地端口")
        port_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(port_label)
        form_layout.addWidget(self.port_input)

        # Protocol
        self.protocol_combo = QComboBox()
        self.protocol_combo.addItems(["TCP", "UDP"])
        self.protocol_combo.setStyleSheet(StyleHelper.get_combo_style())
        
        protocol_label = QLabel("协议")
        protocol_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(protocol_label)
        form_layout.addWidget(self.protocol_combo)

        # Name
        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText("可选，便于识别")
        self.name_input.setStyleSheet(StyleHelper.get_input_style())
        
        name_label = QLabel("隧道名称")
        name_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(name_label)
        form_layout.addWidget(self.name_input)

        form_card.setLayout(form_layout)
        layout.addWidget(form_card)

        # Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(12)

        cancel_btn = QPushButton("取消")
        cancel_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        cancel_btn.setMinimumHeight(44)
        cancel_btn.clicked.connect(self.reject)

        ok_btn = QPushButton("创建")
        ok_btn.setStyleSheet(StyleHelper.get_button_style("primary"))
        ok_btn.setMinimumHeight(44)
        ok_btn.clicked.connect(self.on_accept)

        button_layout.addWidget(cancel_btn)
        button_layout.addWidget(ok_btn)

        layout.addLayout(button_layout)
        layout.addStretch()

        self.setLayout(layout)

    def on_accept(self):
        try:
            self.local_port = int(self.port_input.text().strip())
            if self.local_port < 1 or self.local_port > 65535:
                raise ValueError()
        except ValueError:
            QMessageBox.warning(self, "错误", "请输入有效的端口号 (1-65535)")
            return

        self.protocol = self.protocol_combo.currentText().lower()
        self.name = self.name_input.text().strip() or None

        self.accept()


class CreateGroupDialog(QDialog):
    """Dialog for creating a port group / game preset."""

    def __init__(self, templates=None, parent=None):
        super().__init__(parent)
        self.templates = templates or []
        self.setWindowTitle("添加端口组")
        self.setModal(True)
        self.setFixedSize(560, 640)
        self.setStyleSheet("background: #f5f7fa;")

        self.group_name = ""
        self.template_id = None
        self.custom_ports = []
        self.is_template_mode = True

        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(32, 32, 32, 32)

        title_label = QLabel("添加端口组")
        title_label.setStyleSheet("""
            font-size: 24px;
            font-weight: 700;
            color: #333;
        """)
        layout.addWidget(title_label)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("""
            QScrollArea {
                border: none;
                background: transparent;
            }
        """)

        form_card = QFrame()
        form_card.setStyleSheet(StyleHelper.get_card_style())
        form_layout = QVBoxLayout()
        form_layout.setSpacing(16)
        form_layout.setContentsMargins(24, 24, 24, 24)

        name_label = QLabel("组名")
        name_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(name_label)

        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText("例如: Minecraft服务器")
        self.name_input.setStyleSheet(StyleHelper.get_input_style())
        form_layout.addWidget(self.name_input)

        mode_label = QLabel("配置方式")
        mode_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        form_layout.addWidget(mode_label)

        self.mode_combo = QComboBox()
        self.mode_combo.addItems(["使用游戏模板", "自定义端口"])
        self.mode_combo.setStyleSheet(StyleHelper.get_combo_style())
        self.mode_combo.currentIndexChanged.connect(self._on_mode_changed)
        form_layout.addWidget(self.mode_combo)

        self.template_section = QFrame()
        self.template_section.setStyleSheet("QFrame { border: none; background: transparent; }")
        template_layout = QVBoxLayout()
        template_layout.setContentsMargins(0, 0, 0, 0)
        template_layout.setSpacing(8)

        template_label = QLabel("游戏模板")
        template_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        template_layout.addWidget(template_label)

        self.template_combo = QComboBox()
        self.template_combo.setStyleSheet(StyleHelper.get_combo_style())
        if self.templates:
            for t in self.templates:
                desc = t.get('description', '')
                port_count = t.get('port_count', '?')
                display = f"{t['name']} ({port_count}个端口)"
                if desc:
                    display += f" - {desc}"
                self.template_combo.addItem(display, t['id'])
        else:
            self.template_combo.addItem("暂无可用模板", None)
            self.template_combo.setEnabled(False)
        template_layout.addWidget(self.template_combo)

        self.template_section.setLayout(template_layout)
        form_layout.addWidget(self.template_section)

        self.custom_section = QFrame()
        self.custom_section.setStyleSheet("QFrame { border: none; background: transparent; }")
        custom_layout = QVBoxLayout()
        custom_layout.setContentsMargins(0, 0, 0, 0)
        custom_layout.setSpacing(8)

        custom_label = QLabel("自定义端口")
        custom_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        custom_layout.addWidget(custom_label)

        self.ports_table = QTableWidget()
        self.ports_table.setColumnCount(3)
        self.ports_table.setHorizontalHeaderLabels(["端口名称", "本地端口", "协议"])
        self.ports_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.ports_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.ports_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.ports_table.setStyleSheet(StyleHelper.get_table_style())
        self.ports_table.verticalHeader().setVisible(False)
        self.ports_table.setAlternatingRowColors(True)
        self.ports_table.setMaximumHeight(200)
        custom_layout.addWidget(self.ports_table)

        port_btn_layout = QHBoxLayout()
        port_btn_layout.setSpacing(8)

        add_port_btn = QPushButton("+ 添加端口")
        add_port_btn.setStyleSheet(StyleHelper.get_button_style("small"))
        add_port_btn.clicked.connect(self._add_custom_port)

        remove_port_btn = QPushButton("- 删除选中")
        remove_port_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        remove_port_btn.clicked.connect(self._remove_custom_port)

        port_btn_layout.addWidget(add_port_btn)
        port_btn_layout.addWidget(remove_port_btn)
        port_btn_layout.addStretch()
        custom_layout.addLayout(port_btn_layout)

        self.custom_section.setLayout(custom_layout)
        self.custom_section.setVisible(False)
        form_layout.addWidget(self.custom_section)

        form_card.setLayout(form_layout)
        scroll.setWidget(form_card)
        layout.addWidget(scroll)

        button_layout = QHBoxLayout()
        button_layout.setSpacing(12)

        cancel_btn = QPushButton("取消")
        cancel_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        cancel_btn.setMinimumHeight(44)
        cancel_btn.clicked.connect(self.reject)

        ok_btn = QPushButton("创建")
        ok_btn.setStyleSheet(StyleHelper.get_button_style("primary"))
        ok_btn.setMinimumHeight(44)
        ok_btn.clicked.connect(self._on_accept)

        button_layout.addWidget(cancel_btn)
        button_layout.addWidget(ok_btn)

        layout.addLayout(button_layout)

        self.setLayout(layout)

    def _on_mode_changed(self, index):
        self.is_template_mode = (index == 0)
        self.template_section.setVisible(self.is_template_mode)
        self.custom_section.setVisible(not self.is_template_mode)

    def _add_custom_port(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("添加端口")
        dialog.setFixedSize(360, 300)
        dialog.setStyleSheet("background: #f5f7fa;")

        dlg_layout = QVBoxLayout()
        dlg_layout.setSpacing(12)
        dlg_layout.setContentsMargins(24, 24, 24, 24)

        name_label = QLabel("端口名称")
        name_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        dlg_layout.addWidget(name_label)

        name_input = QLineEdit()
        name_input.setPlaceholderText("例如: 游戏端口")
        name_input.setStyleSheet(StyleHelper.get_input_style())
        dlg_layout.addWidget(name_input)

        port_label = QLabel("本地端口")
        port_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        dlg_layout.addWidget(port_label)

        port_input = QLineEdit()
        port_input.setPlaceholderText("例如: 25565")
        port_input.setStyleSheet(StyleHelper.get_input_style())
        dlg_layout.addWidget(port_input)

        proto_label = QLabel("协议")
        proto_label.setStyleSheet("font-size: 13px; color: #666; font-weight: 500;")
        dlg_layout.addWidget(proto_label)

        protocol_combo = QComboBox()
        protocol_combo.addItems(["TCP", "UDP"])
        protocol_combo.setStyleSheet(StyleHelper.get_combo_style())
        dlg_layout.addWidget(protocol_combo)

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(12)

        cancel = QPushButton("取消")
        cancel.setStyleSheet(StyleHelper.get_button_style("default"))
        cancel.setMinimumHeight(40)
        cancel.clicked.connect(dialog.reject)

        ok = QPushButton("添加")
        ok.setStyleSheet(StyleHelper.get_button_style("primary"))
        ok.setMinimumHeight(40)
        ok.clicked.connect(dialog.accept)

        btn_layout.addWidget(cancel)
        btn_layout.addWidget(ok)
        dlg_layout.addLayout(btn_layout)

        dialog.setLayout(dlg_layout)

        if dialog.exec_() == QDialog.Accepted:
            name = name_input.text().strip() or "未命名"
            try:
                port = int(port_input.text().strip())
                if port < 1 or port > 65535:
                    raise ValueError()
            except ValueError:
                QMessageBox.warning(self, "错误", "请输入有效的端口号 (1-65535)")
                return

            protocol = protocol_combo.currentText().lower()
            row = self.ports_table.rowCount()
            self.ports_table.insertRow(row)
            self.ports_table.setItem(row, 0, QTableWidgetItem(name))
            self.ports_table.setItem(row, 1, QTableWidgetItem(str(port)))
            self.ports_table.setItem(row, 2, QTableWidgetItem(protocol.upper()))

    def _remove_custom_port(self):
        rows = set()
        for item in self.ports_table.selectedItems():
            rows.add(item.row())
        for row in sorted(rows, reverse=True):
            self.ports_table.removeRow(row)

    def _on_accept(self):
        self.group_name = self.name_input.text().strip()
        if not self.group_name:
            QMessageBox.warning(self, "错误", "请输入组名")
            return

        if self.is_template_mode:
            if self.template_combo.count() == 0 or self.template_combo.currentData() is None:
                QMessageBox.warning(self, "错误", "没有可用的游戏模板")
                return
            self.template_id = self.template_combo.currentData()
        else:
            self.template_id = None
            self.custom_ports = []
            for row in range(self.ports_table.rowCount()):
                name_item = self.ports_table.item(row, 0)
                port_item = self.ports_table.item(row, 1)
                proto_item = self.ports_table.item(row, 2)
                if name_item and port_item and proto_item:
                    self.custom_ports.append({
                        "name": name_item.text(),
                        "local_port": int(port_item.text()),
                        "protocol": proto_item.text().lower()
                    })
            if not self.custom_ports:
                QMessageBox.warning(self, "错误", "请至少添加一个端口")
                return

        self.accept()


class MainWindow(QMainWindow):
    """Beautiful main application window."""

    def __init__(self):
        super().__init__()
        self.setWindowTitle("FRP 内网穿透客户端")
        self.setGeometry(100, 100, 1100, 700)
        self.setStyleSheet("background: #f5f7fa;")

        self.config_manager = None
        self.frpc_manager = None
        self.api_client = None
        if ConfigManager:
            self.config_manager = ConfigManager()
        if FRPCManager:
            self.frpc_manager = FRPCManager()

        self.tunnels = []
        self.templates = []
        self.groups = []

        self.init_ui()
        self.init_tray()
        self.init_timer()

        self.try_auto_login()

    def init_ui(self):
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        main_layout = QVBoxLayout()
        main_layout.setSpacing(20)
        main_layout.setContentsMargins(24, 24, 24, 24)

        # Header
        header = QFrame()
        header.setStyleSheet(StyleHelper.get_card_style())
        header_layout = QHBoxLayout()
        header_layout.setContentsMargins(24, 16, 24, 16)

        # Title
        title_layout = QVBoxLayout()
        title_label = QLabel("FRP 内网穿透")
        title_label.setStyleSheet("""
            font-size: 22px;
            font-weight: 700;
            color: #333;
        """)
        self.status_label = QLabel("未登录")
        self.status_label.setStyleSheet("""
            font-size: 13px;
            color: #999;
        """)
        title_layout.addWidget(title_label)
        title_layout.addWidget(self.status_label)

        # Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(12)

        self.login_btn = QPushButton("登录")
        self.login_btn.setStyleSheet(StyleHelper.get_button_style("primary"))
        self.login_btn.clicked.connect(self.show_login_dialog)

        self.logout_btn = QPushButton("退出登录")
        self.logout_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        self.logout_btn.clicked.connect(self.logout)
        self.logout_btn.setEnabled(False)

        button_layout.addWidget(self.login_btn)
        button_layout.addWidget(self.logout_btn)

        header_layout.addLayout(title_layout)
        header_layout.addStretch()
        header_layout.addLayout(button_layout)

        header.setLayout(header_layout)
        main_layout.addWidget(header)

        # Action bar
        action_bar = QFrame()
        action_bar.setStyleSheet(StyleHelper.get_card_style())
        action_layout = QHBoxLayout()
        action_layout.setContentsMargins(20, 16, 20, 16)

        self.create_btn = QPushButton("➕ 创建隧道")
        self.create_btn.setStyleSheet(StyleHelper.get_button_style("primary"))
        self.create_btn.clicked.connect(self.create_tunnel)
        self.create_btn.setEnabled(False)

        self.refresh_btn = QPushButton("🔄 刷新")
        self.refresh_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        self.refresh_btn.clicked.connect(self.refresh_tunnels)
        self.refresh_btn.setEnabled(False)

        action_layout.addWidget(self.create_btn)
        action_layout.addWidget(self.refresh_btn)
        action_layout.addStretch()

        action_bar.setLayout(action_layout)
        main_layout.addWidget(action_bar)

        # Tab widget
        self.tab_widget = QTabWidget()
        self.tab_widget.setStyleSheet("""
            QTabWidget::pane {
                border: 1px solid #e0e0e0;
                border-radius: 12px;
                background: white;
                top: -1px;
            }
            QTabBar::tab {
                background: #f0f0f0;
                border: 1px solid #e0e0e0;
                border-bottom: none;
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
                padding: 10px 24px;
                margin-right: 4px;
                font-size: 14px;
                font-weight: 600;
                color: #666;
            }
            QTabBar::tab:selected {
                background: white;
                color: #667eea;
                border-bottom: 2px solid #667eea;
            }
            QTabBar::tab:hover:!selected {
                background: #e8e8e8;
            }
        """)

        # Tab 1: Single port tunnels
        tab1 = QWidget()
        tab1_layout = QVBoxLayout()
        tab1_layout.setContentsMargins(0, 0, 0, 0)

        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels([
            "ID", "名称", "本地端口", "服务器端口", "协议", "状态", "操作"
        ])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setStyleSheet(StyleHelper.get_table_style())
        self.table.verticalHeader().setVisible(False)

        tab1_layout.addWidget(self.table)
        tab1.setLayout(tab1_layout)
        self.tab_widget.addTab(tab1, "单端口隧道")

        # Tab 2: Port groups
        tab2 = QWidget()
        tab2_layout = QVBoxLayout()
        tab2_layout.setContentsMargins(0, 8, 0, 0)
        tab2_layout.setSpacing(12)

        group_btn_layout = QHBoxLayout()
        self.add_group_btn = QPushButton("➕ 添加端口组")
        self.add_group_btn.setStyleSheet(StyleHelper.get_button_style("primary"))
        self.add_group_btn.clicked.connect(self.show_add_group_dialog)
        self.add_group_btn.setEnabled(False)
        group_btn_layout.addWidget(self.add_group_btn)
        group_btn_layout.addStretch()
        tab2_layout.addLayout(group_btn_layout)

        self.groups_scroll = QScrollArea()
        self.groups_scroll.setWidgetResizable(True)
        self.groups_scroll.setStyleSheet("""
            QScrollArea {
                border: none;
                background: transparent;
            }
            QScrollBar:vertical {
                border: none;
                background: #f0f0f0;
                width: 8px;
                border-radius: 4px;
            }
            QScrollBar::handle:vertical {
                background: #c0c0c0;
                border-radius: 4px;
                min-height: 20px;
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                height: 0px;
            }
        """)

        self.groups_container = QWidget()
        self.groups_container.setStyleSheet("background: transparent;")
        self.groups_container_layout = QVBoxLayout()
        self.groups_container_layout.setSpacing(16)
        self.groups_container_layout.setContentsMargins(0, 0, 8, 0)

        self.groups_empty_label = QLabel("暂无端口组，点击上方按钮添加")
        self.groups_empty_label.setStyleSheet("""
            font-size: 14px;
            color: #999;
            padding: 40px;
        """)
        self.groups_empty_label.setAlignment(Qt.AlignCenter)
        self.groups_container_layout.addWidget(self.groups_empty_label)

        self.groups_container_layout.addStretch()
        self.groups_container.setLayout(self.groups_container_layout)

        self.groups_scroll.setWidget(self.groups_container)
        tab2_layout.addWidget(self.groups_scroll)

        tab2.setLayout(tab2_layout)
        self.tab_widget.addTab(tab2, "端口组（游戏服务器）")

        main_layout.addWidget(self.tab_widget)

        central_widget.setLayout(main_layout)

    def init_tray(self):
        self.tray_icon = QSystemTrayIcon(self)
        self.tray_icon.setToolTip("FRP 客户端")

        tray_menu = QMenu()
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
        self.tray_icon.showMessage(
            "FRP 客户端",
            "程序已最小化到系统托盘",
            QSystemTrayIcon.Information,
            2000
        )

    def quit_application(self):
        reply = QMessageBox.question(
            self, "确认退出",
            "确定要退出程序吗？\n运行中的隧道将被停止。",
            QMessageBox.Yes | QMessageBox.No
        )

        if reply == QMessageBox.Yes:
            if self.frpc_manager:
                self.frpc_manager.cleanup()
            QApplication.quit()

    def try_auto_login(self):
        if not self.config_manager:
            return
            
        server_url = self.config_manager.get_server_url()
        credentials = self.config_manager.get_credentials()

        if server_url and credentials and FRPApiClient:
            username, access_token = credentials
            self.api_client = FRPApiClient(server_url)
            self.api_client.access_token = access_token
            self.api_client.user_info = {"username": username}

            self.on_login_success(username)
            self.refresh_tunnels()

    def show_login_dialog(self):
        dialog = LoginDialog(self)

        if self.config_manager:
            server_url = self.config_manager.get_server_url()
            if server_url:
                dialog.server_input.setText(server_url)

        if dialog.exec_() == QDialog.Accepted and FRPApiClient:
            self.config_manager.save_server_url(dialog.server_url)
            self.api_client = FRPApiClient(dialog.server_url)

            try:
                if dialog.is_register:
                    user_info = self.api_client.register(dialog.username, dialog.password)
                    QMessageBox.information(
                        self, "注册成功",
                        f"注册成功！\n用户ID: {user_info['id']}\n请登录"
                    )
                    self.show_login_dialog()
                else:
                    user_info = self.api_client.login(dialog.username, dialog.password)
                    self.config_manager.save_credentials(
                        dialog.username, user_info["access_token"]
                    )
                    self.on_login_success(dialog.username)
                    self.refresh_tunnels()

            except Exception as e:
                QMessageBox.critical(self, "错误", str(e))

    def on_login_success(self, username: str):
        self.status_label.setText(f"✓ 已登录: {username}")
        self.status_label.setStyleSheet("""
            font-size: 13px;
            color: #11998e;
            font-weight: 500;
        """)
        self.login_btn.setEnabled(False)
        self.logout_btn.setEnabled(True)
        self.create_btn.setEnabled(True)
        self.refresh_btn.setEnabled(True)
        self.add_group_btn.setEnabled(True)

        self.fetch_templates()
        self.fetch_groups()

    def logout(self):
        self.api_client = None
        if self.config_manager:
            self.config_manager.clear_credentials()
        self.status_label.setText("未登录")
        self.status_label.setStyleSheet("""
            font-size: 13px;
            color: #999;
        """)
        self.login_btn.setEnabled(True)
        self.logout_btn.setEnabled(False)
        self.create_btn.setEnabled(False)
        self.refresh_btn.setEnabled(False)
        self.add_group_btn.setEnabled(False)
        self.table.setRowCount(0)
        self.tunnels = []
        self.templates = []
        self.groups = []
        self.update_groups_display()

    def create_tunnel(self):
        if not self.api_client:
            return
            
        dialog = CreateTunnelDialog(self)

        if dialog.exec_() == QDialog.Accepted:
            try:
                tunnel = self.api_client.create_tunnel(
                    dialog.local_port, dialog.protocol, dialog.name
                )
                QMessageBox.information(
                    self, "创建成功",
                    f"隧道创建成功！\n"
                    f"隧道ID: {tunnel['id']}\n"
                    f"本地端口: {tunnel['local_port']}\n"
                    f"服务器端口: {tunnel['server_port']}"
                )
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

        self.fetch_groups()

    def update_table(self):
        self.table.setRowCount(len(self.tunnels))

        for row, tunnel in enumerate(self.tunnels):
            tunnel_id = tunnel["id"]

            self.table.setItem(row, 0, QTableWidgetItem(str(tunnel_id)))
            self.table.setItem(row, 1, QTableWidgetItem(tunnel["name"] or "(无名称)"))
            self.table.setItem(row, 2, QTableWidgetItem(str(tunnel["local_port"])))
            self.table.setItem(row, 3, QTableWidgetItem(str(tunnel["server_port"])))
            self.table.setItem(row, 4, QTableWidgetItem(tunnel["protocol"].upper()))

            is_running = False
            if self.frpc_manager:
                is_running = self.frpc_manager.is_tunnel_running(tunnel_id)
                
            status_item = QTableWidgetItem("✓ 运行中" if is_running else "✗ 已停止")
            status_item.setForeground(QColor("#11998e") if is_running else QColor("#eb3349"))
            font = status_item.font()
            font.setBold(True)
            status_item.setFont(font)
            self.table.setItem(row, 5, status_item)

            button_widget = QWidget()
            button_layout = QHBoxLayout()
            button_layout.setContentsMargins(4, 4, 4, 4)
            button_layout.setSpacing(8)

            if is_running:
                stop_btn = QPushButton("停止")
                stop_btn.setStyleSheet(StyleHelper.get_button_style("danger"))
                stop_btn.clicked.connect(lambda checked, tid=tunnel_id: self.stop_tunnel(tid))
                button_layout.addWidget(stop_btn)
            else:
                start_btn = QPushButton("启动")
                start_btn.setStyleSheet(StyleHelper.get_button_style("success"))
                start_btn.clicked.connect(lambda checked, tid=tunnel_id: self.start_tunnel(tid))
                button_layout.addWidget(start_btn)

            delete_btn = QPushButton("删除")
            delete_btn.setStyleSheet(StyleHelper.get_button_style("default"))
            delete_btn.clicked.connect(lambda checked, tid=tunnel_id: self.delete_tunnel(tid))
            button_layout.addWidget(delete_btn)

            button_widget.setLayout(button_layout)
            self.table.setCellWidget(row, 6, button_widget)

    def start_tunnel(self, tunnel_id: int):
        if not self.api_client or not self.frpc_manager:
            return
            
        try:
            config_content = self.api_client.get_tunnel_config(tunnel_id)
            config_path = self.frpc_manager.write_config(tunnel_id, config_content)
            pid = self.frpc_manager.start_tunnel(tunnel_id, config_path)
            if self.config_manager:
                self.config_manager.save_tunnel_state(tunnel_id, pid, config_path)

            QMessageBox.information(self, "启动成功", f"隧道 {tunnel_id} 启动成功")
            self.update_table()

        except Exception as e:
            QMessageBox.critical(self, "启动失败", str(e))

    def stop_tunnel(self, tunnel_id: int):
        if not self.frpc_manager:
            return
            
        try:
            self.frpc_manager.stop_tunnel(tunnel_id)
            if self.config_manager:
                self.config_manager.remove_tunnel_state(tunnel_id)

            QMessageBox.information(self, "停止成功", f"隧道 {tunnel_id} 已停止")
            self.update_table()

        except Exception as e:
            QMessageBox.critical(self, "停止失败", str(e))

    def delete_tunnel(self, tunnel_id: int):
        if not self.api_client:
            return
            
        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除隧道 {tunnel_id} 吗？",
            QMessageBox.Yes | QMessageBox.No
        )

        if reply == QMessageBox.Yes:
            try:
                if self.frpc_manager and self.frpc_manager.is_tunnel_running(tunnel_id):
                    self.frpc_manager.stop_tunnel(tunnel_id)
                    if self.config_manager:
                        self.config_manager.remove_tunnel_state(tunnel_id)

                self.api_client.delete_tunnel(tunnel_id)
                QMessageBox.information(self, "删除成功", f"隧道 {tunnel_id} 已删除")
                self.refresh_tunnels()

            except Exception as e:
                QMessageBox.critical(self, "删除失败", str(e))

    def update_tunnel_status(self):
        if self.tunnels:
            self.update_table()
        if self.groups:
            self.update_groups_display()

    # ---- Port Group Methods ----

    def fetch_templates(self):
        if not self.api_client or not self.api_client.is_authenticated():
            return
        try:
            self.templates = self.api_client.get_templates()
        except Exception:
            self.templates = []

    def fetch_groups(self):
        if not self.api_client or not self.api_client.is_authenticated():
            return
        try:
            self.groups = self.api_client.get_groups()
            self.update_groups_display()
        except Exception:
            self.groups = []
            self.update_groups_display()

    def show_add_group_dialog(self):
        if not self.api_client:
            return
        dialog = CreateGroupDialog(self.templates, self)
        if dialog.exec_() == QDialog.Accepted:
            self.handle_add_group(dialog)

    def handle_add_group(self, dialog):
        if not self.api_client:
            return
        try:
            if dialog.is_template_mode:
                group = self.api_client.create_group(
                    name=dialog.group_name,
                    template_id=dialog.template_id
                )
            else:
                group = self.api_client.create_group(
                    name=dialog.group_name,
                    ports=dialog.custom_ports
                )
            QMessageBox.information(
                self, "创建成功",
                f"端口组 '{dialog.group_name}' 创建成功！"
            )
            self.fetch_groups()
        except Exception as e:
            QMessageBox.critical(self, "创建失败", str(e))

    def handle_delete_group(self, group_id):
        if not self.api_client:
            return
        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除端口组 {group_id} 吗？\n组内所有隧道将被删除。",
            QMessageBox.Yes | QMessageBox.No
        )
        if reply == QMessageBox.Yes:
            try:
                if self.frpc_manager and self.frpc_manager.is_tunnel_running(group_id):
                    self.frpc_manager.stop_tunnel(group_id)
                    if self.config_manager:
                        self.config_manager.remove_tunnel_state(group_id)
                self.api_client.delete_group(group_id)
                QMessageBox.information(self, "删除成功", f"端口组 {group_id} 已删除")
                self.fetch_groups()
            except Exception as e:
                QMessageBox.critical(self, "删除失败", str(e))

    def download_group_config(self, group_id):
        if not self.api_client:
            return
        try:
            config_content = self.api_client.get_group_config(group_id)
            file_path, _ = QFileDialog.getSaveFileName(
                self, "保存配置文件",
                f"frpc_group_{group_id}.toml",
                "TOML Files (*.toml);;All Files (*)"
            )
            if file_path:
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(config_content)
                QMessageBox.information(self, "保存成功", f"配置已保存到 {file_path}")
        except Exception as e:
            QMessageBox.critical(self, "下载配置失败", str(e))

    def start_group(self, group_id):
        if not self.api_client or not self.frpc_manager:
            return
        try:
            config_content = self.api_client.get_group_config(group_id)
            config_path = self.frpc_manager.write_config(group_id, config_content)
            pid = self.frpc_manager.start_tunnel(group_id, config_path)
            if self.config_manager:
                self.config_manager.save_tunnel_state(group_id, pid, config_path)
            QMessageBox.information(self, "启动成功", f"端口组 {group_id} 启动成功")
            self.update_groups_display()
        except Exception as e:
            QMessageBox.critical(self, "启动失败", str(e))

    def stop_group(self, group_id):
        if not self.frpc_manager:
            return
        try:
            self.frpc_manager.stop_tunnel(group_id)
            if self.config_manager:
                self.config_manager.remove_tunnel_state(group_id)
            QMessageBox.information(self, "停止成功", f"端口组 {group_id} 已停止")
            self.update_groups_display()
        except Exception as e:
            QMessageBox.critical(self, "停止失败", str(e))

    def update_groups_display(self):
        while self.groups_container_layout.count() > 1:
            item = self.groups_container_layout.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

        if not self.groups:
            self.groups_empty_label.setVisible(True)
            return

        self.groups_empty_label.setVisible(False)

        for group in self.groups:
            card = self._create_group_card(group)
            self.groups_container_layout.insertWidget(
                self.groups_container_layout.count() - 1, card
            )

    def _create_group_card(self, group):
        card = QFrame()
        card.setStyleSheet(StyleHelper.get_card_style())
        card_layout = QVBoxLayout()
        card_layout.setSpacing(12)
        card_layout.setContentsMargins(20, 16, 20, 16)

        header_layout = QHBoxLayout()
        header_layout.setSpacing(10)

        name_label = QLabel(group.get("name", ""))
        name_label.setStyleSheet("""
            font-size: 16px;
            font-weight: 700;
            color: #333;
        """)
        header_layout.addWidget(name_label)

        game_template = group.get("game_template")
        if game_template and game_template != "custom":
            template_tag = QLabel(str(game_template))
            template_tag.setStyleSheet("""
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #667eea, stop:1 #764ba2);
                border-radius: 10px;
                color: white;
                padding: 4px 12px;
                font-size: 12px;
                font-weight: 600;
            """)
            header_layout.addWidget(template_tag)

        header_layout.addStretch()
        card_layout.addLayout(header_layout)

        tunnels = group.get("tunnels", [])
        port_table = QTableWidget()
        port_table.setColumnCount(5)
        port_table.setHorizontalHeaderLabels(["端口名称", "协议", "本地端口", "服务器端口", "流量"])
        port_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        port_table.setSelectionBehavior(QTableWidget.SelectRows)
        port_table.setEditTriggers(QTableWidget.NoEditTriggers)
        port_table.setAlternatingRowColors(True)
        port_table.setStyleSheet(StyleHelper.get_table_style())
        port_table.verticalHeader().setVisible(False)
        port_table.setRowCount(len(tunnels))

        for row, tunnel in enumerate(tunnels):
            port_table.setItem(row, 0, QTableWidgetItem(tunnel.get("name", "")))
            port_table.setItem(row, 1, QTableWidgetItem(tunnel.get("protocol", "tcp").upper()))
            port_table.setItem(row, 2, QTableWidgetItem(str(tunnel.get("local_port", ""))))
            port_table.setItem(row, 3, QTableWidgetItem(str(tunnel.get("server_port", ""))))

            traffic = tunnel.get("traffic", tunnel.get("bytes", 0))
            if isinstance(traffic, (int, float)):
                if traffic > 1024 * 1024 * 1024:
                    traffic_str = f"{traffic / (1024*1024*1024):.2f} GB"
                elif traffic > 1024 * 1024:
                    traffic_str = f"{traffic / (1024*1024):.2f} MB"
                elif traffic > 1024:
                    traffic_str = f"{traffic / 1024:.2f} KB"
                else:
                    traffic_str = f"{traffic:.0f} B"
            else:
                traffic_str = str(traffic) if traffic else "0 B"
            port_table.setItem(row, 4, QTableWidgetItem(traffic_str))

        row_height = 36
        header_height = 36
        table_height = header_height + len(tunnels) * row_height + 4
        port_table.setFixedHeight(min(250, max(80, table_height)))
        card_layout.addWidget(port_table)

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(8)

        group_id = group["id"]

        is_running = False
        if self.frpc_manager:
            is_running = self.frpc_manager.is_tunnel_running(group_id)

        if is_running:
            stop_btn = QPushButton("停止")
            stop_btn.setStyleSheet(StyleHelper.get_button_style("danger"))
            stop_btn.clicked.connect(lambda checked, gid=group_id: self.stop_group(gid))
            btn_layout.addWidget(stop_btn)
        else:
            start_btn = QPushButton("启动")
            start_btn.setStyleSheet(StyleHelper.get_button_style("success"))
            start_btn.clicked.connect(lambda checked, gid=group_id: self.start_group(gid))
            btn_layout.addWidget(start_btn)

        download_btn = QPushButton("下载配置")
        download_btn.setStyleSheet(StyleHelper.get_button_style("default"))
        download_btn.clicked.connect(lambda checked, gid=group_id: self.download_group_config(gid))
        btn_layout.addWidget(download_btn)

        delete_btn = QPushButton("删除组")
        delete_btn.setStyleSheet(StyleHelper.get_button_style("danger"))
        delete_btn.clicked.connect(lambda checked, gid=group_id: self.handle_delete_group(gid))
        btn_layout.addWidget(delete_btn)

        btn_layout.addStretch()
        card_layout.addLayout(btn_layout)

        card.setLayout(card_layout)
        return card


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("FRP客户端")
    app.setQuitOnLastWindowClosed(False)

    # Set application font
    font = QFont("Microsoft YaHei UI", 10)
    app.setFont(font)

    window = MainWindow()
    window.show()

    sys.exit(app.exec_())


if __name__ == '__main__':
    main()
