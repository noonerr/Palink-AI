# 一劳永逸的数据库迁移解决方案

## ✅ 已完成的配置

### 1. 启用自动迁移

已将 `backend/app/core/config.py` 中的配置修改为：

```python
RUN_MIGRATIONS_ON_STARTUP: bool = True  # 启用自动迁移
```

**这意味着：**
- ✅ 每次启动后端服务时，会自动检查并应用所有待执行的数据库迁移
- ✅ 不需要手动运行 `alembic upgrade head`
- ✅ 新添加的字段会自动创建
- ✅ 多个 worker 同时启动时，只有一个会执行迁移（通过文件锁保护）

### 2. 迁移文件已创建

已创建迁移文件：`backend/alembic/versions/0008_add_branch_frozen_favorite.py`

包含以下字段：
- `is_frozen` - 分支是否冻结
- `is_favorited` - 分支是否收藏
- `last_message_at` - 最后消息时间

## 🚀 现在只需要做一件事

**重启后端服务**

```bash
# 停止当前运行的后端
# 然后重新启动

cd backend
python -m uvicorn app.main:app --reload
```

启动时你会看到日志：
```
INFO: RUN_MIGRATIONS_ON_STARTUP=true，开始执行数据库迁移
INFO: 数据库迁移完成
```

## 📋 验证迁移成功

启动后，检查日志中是否有：
- ✅ "数据库迁移完成"
- ✅ 没有报错信息

然后测试角色扮演功能：
1. 进入角色扮演页面
2. 选择任意角色
3. 点击"开始对话"
4. 应该可以正常使用，不再报错

## 🔧 如果还有问题

### 问题1：迁移失败

查看后端日志，找到具体错误信息。可能的原因：
- 数据库文件被锁定（关闭所有数据库连接）
- 权限问题（检查 `backend/data/` 目录权限）

### 问题2：迁移没有执行

检查：
1. 确认 `RUN_MIGRATIONS_ON_STARTUP` 确实是 `True`
2. 查看启动日志是否有 "开始执行数据库迁移"
3. 检查是否有多个后端进程在运行

### 问题3：字段还是不存在

手动运行迁移：
```bash
cd backend
alembic upgrade head
```

## 🎯 未来添加新字段的流程

1. **修改模型** - 在 `backend/app/models/*.py` 中添加新字段
2. **创建迁移** - 运行 `alembic revision -m "描述"`
3. **编写迁移脚本** - 在生成的文件中添加 `ALTER TABLE` 语句
4. **重启服务** - 自动应用迁移 ✅

**不需要手动操作数据库！**

## 📝 环境变量覆盖（可选）

如果你想在特定环境中禁用自动迁移，可以设置环境变量：

```bash
# .env 文件或环境变量
RUN_MIGRATIONS_ON_STARTUP=false
```

但通常情况下，保持 `true` 是最方便的。

## ⚠️ 生产环境建议

在生产环境中，建议：
1. 在部署前先在测试环境验证迁移
2. 备份数据库
3. 使用 `MIGRATIONS_FAIL_FAST=true`（已默认启用）
4. 监控迁移日志

---

**现在重启后端服务，一切就绪！** 🎉
