# 开发者模式测试指南

## 如何测试开发者模式

### 1. 打开开发者模式开关

1. 启动前端和后端服务
2. 登录系统
3. 进入 **设置** → **关于** 页面
4. 在页面底部找到 **"开发者模式"** 开关
5. 点击开关启用开发者模式
6. 应该看到 toast 提示："开发者模式已开启"

### 2. 验证测试模型出现

1. 进入 **设置** → **模型管理** → **本地模型** 标签
2. 应该看到一个名为 **"测试模型 (开发者)"** 的模型
3. 该模型显示为已启用状态

### 3. 测试模型推理

#### 方式1：在普通对话中测试
1. 进入对话页面
2. 在模型选择器中选择 **"测试模型 (开发者)"**
3. 发送任意消息
4. 应该收到固定的测试响应："这是测试模型的流式输出。"
5. 页面顶部应该显示提示："开发者模式已开启：发送不会请求真实模型"

#### 方式2：在角色扮演中测试
1. 进入角色扮演页面
2. 选择任意角色
3. 在模型选择器中选择 **"测试模型 (开发者)"**
4. 发送消息
5. 应该收到测试响应

### 4. 关闭开发者模式

1. 返回 **设置** → **关于** 页面
2. 关闭 **"开发者模式"** 开关
3. 应该看到 toast 提示："开发者模式已关闭"
4. 返回模型管理，测试模型应该消失

## 预期行为

### 开启时：
- ✅ 关于页面显示开关为开启状态
- ✅ 本地模型列表中出现"测试模型 (开发者)"
- ✅ 选择测试模型发送消息返回固定测试文本
- ✅ 对话页面显示开发者模式提示
- ✅ 不会真实调用任何AI模型

### 关闭时：
- ✅ 关于页面显示开关为关闭状态
- ✅ 本地模型列表中不显示测试模型
- ✅ 对话页面不显示开发者模式提示
- ✅ 正常调用真实AI模型

## 故障排查

### 问题1：看不到开发者模式开关
- 检查是否在 **设置 → 关于** 页面
- 刷新页面
- 检查浏览器控制台是否有错误

### 问题2：开关无法切换
- 检查浏览器控制台网络请求
- 确认 `/api/users/me/settings` API 是否正常
- 检查后端日志

### 问题3：测试模型不出现
- 确认开发者模式已开启
- 刷新模型列表
- 检查 `/api/models/local` API 返回

### 问题4：测试模型无法推理
- 检查后端 `inference_dispatcher.py` 是否正确处理 `local:test-model`
- 查看后端日志
- 确认前端选择的模型ID是否正确

## API端点

- **获取设置**: `GET /api/users/me/settings`
- **更新设置**: `PUT /api/users/me/settings`
- **获取本地模型**: `GET /api/models/local`
- **发送消息**: `POST /api/chat` 或 `/api/character-chat`

## 相关文件

### 后端
- `backend/app/models/system.py` - UserSetting 模型
- `backend/app/api/models.py` - 本地模型API
- `backend/app/services/inference_dispatcher.py` - 推理调度器

### 前端
- `frontend/src/components/views/settings-tabs/AboutTab.tsx` - 开发者模式开关
- `frontend/src/components/views/SettingsView.tsx` - 设置页面
- `frontend/src/components/views/ChatViewDesktop.tsx` - 桌面端对话页面
- `frontend/src/components/views/ChatViewMobile.tsx` - 移动端对话页面
