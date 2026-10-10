
# CASDOOR 集成实施检查清单

## 前置准备
- [ ] 确认 CASDOOR 服务已部署并正常运行
- [ ] 在 CASDOOR 中创建应用，获取 Client ID 和 Client Secret
- [ ] 配置 CASDOOR 应用的回调地址（指向 Palink-AI 的 `/api/auth/casdoor/callback`）
- [ ] 获取 CASDOOR 证书文件（PEM 格式）

## 后端开发任务

### 数据库变更
- [ ] 在 `User` 模型中添加 `casdoor_id` 字段（`backend/app/models/user.py`）
- [ ] 创建 Alembic 迁移脚本，添加 `casdoor_id` 列和索引

### 认证配置管理
- [ ] 实现 `get_auth_config()` 函数，支持数据库配置优先、环境变量回退
- [ ] 在 `admin.py` 中添加 `GET /api/admin/auth/config` 接口
- [ ] 在 `admin.py` 中添加 `POST /api/admin/auth/config` 接口
- [ ] 在 `admin.py` 中添加 `POST /api/admin/auth/test-casdoor` 接口
- [ ] 在 `auth.py` 中添加 `GET /api/auth/config` 公开接口（不暴露敏感信息）

### CASDOOR 登录流程
- [ ] 创建 `backend/app/services/casdoor_service.py`（CasdoorAuthService）
- [ ] 创建 `backend/app/services/user_sync_service.py`（UserSyncService）
- [ ] 在 `auth.py` 中添加 `GET /api/auth/casdoor/login-url` 接口
- [ ] 在 `auth.py` 中添加 `GET /api/auth/casdoor/callback` 接口
- [ ] 修改 `POST /api/register` 接口，根据 `local_register_enabled` 配置控制注册

### 依赖
- [ ] 确认 `httpx` 已在 requirements.txt 中（用于异步 HTTP 请求）
- [ ] 确认 `PyJWT` 已在 requirements.txt 中（用于 JWT 解码验证）

## 前端开发任务

### 管理员认证设置页
- [ ] 创建 `frontend/src/components/views/settings-tabs/AuthSettingsTab.tsx`
- [ ] 实现 CASDOOR 开关和配置表单 UI
- [ ] 实现本地登录/本地注册开关
- [ ] 实现 CASDOOR 连接测试功能
- [ ] 实现配置保存功能

### 设置面板集成
- [ ] 在 `SettingsView.tsx` 中新增 `admin_auth` tab 类型
- [ ] 在管理员菜单中添加"认证设置"项（Key 图标，位于用户管理和系统默认之间）
- [ ] 渲染 `AuthSettingsTab` 组件

### 登录页改造
- [ ] 修改 `AuthScreen.tsx`，启动时请求 `/api/auth/config`
- [ ] CASDOOR 启用时显示 CASDOOR 登录按钮
- [ ] CASDOOR 启用时显示"或"分隔线和本地登录表单
- [ ] 本地注册关闭时隐藏注册入口
- [ ] 实现 CASDOOR 登录跳转逻辑
- [ ] 实现 CASDOOR 回调页面处理

### 类型定义
- [ ] 在 `frontend/src/types/index.ts` 中添加 AuthConfig、AdminAuthConfig 类型

## 集成测试
- [ ] 管理员认证设置页面 UI 测试
- [ ] CASDOOR 配置保存和读取测试
- [ ] CASDOOR 连接测试功能测试
- [ ] CASDOOR 正常登录流程端到端测试
- [ ] CASDOOR 用户数据同步测试
- [ ] 本地注册关闭后注册接口返回 403 测试
- [ ] CASDOOR 未启用时登录页仅显示本地登录测试
- [ ] CASDOOR 启用但不可用时降级测试
- [ ] 安全性测试（CSRF、Token 验证、敏感信息不泄露）

## 部署与文档
- [ ] 更新 `.env.example` 添加 CASDOOR 相关环境变量
- [ ] 更新部署文档
- [ ] 编写管理员操作手册（如何配置 CASDOOR）
