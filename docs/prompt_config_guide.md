# 提示词配置使用指南

## 📁 配置文件位置

```
backend/prompts.yaml
```

## 🎯 功能特性

### 1. **热加载**
- 修改配置文件后自动生效，无需重启服务
- 默认缓存60秒，可在配置中调整

### 2. **多语言支持**
- 支持中文（zh）和英文（en）
- 支持自动检测（auto）

### 3. **灵活配置**
- 普通对话提示词
- 角色扮演提示词
- 可选的增强提示（注释掉的部分）

## 📝 配置文件结构

### 普通对话提示词（chat）

```yaml
chat:
  zh:  # 中文版本
    system_role: "你是一个有帮助的AI助手。"
    response_rules: |
      只返回最终答案给用户。不要透露思维链或内部分析过程。
    language_instruction: "除非用户明确要求，否则使用与用户相同的语言回复。"
  
  en:  # 英文版本
    system_role: "You are a helpful assistant."
    response_rules: |
      Return only the final answer for the user.
    language_instruction: "Reply in the same language as the user."
```

### 角色扮演提示词（character）

```yaml
character:
  zh:
    identity: "你是{name}。始终保持角色扮演。"
    
    dialogue_mode:
      first_person: "以第一人称回应..."
      third_person: "以第三人称叙述..."
    
    attributes:
      personality: "性格："
      background: "背景："
      scenario: "场景："
   description: "描述："
    
    user_info: "用户的名字是"{user}"。"
    
    format_rules: |
      回复格式规则：
      - 用双引号包裹口语对话："你好！"
      - 用括号包裹内心想法：（我该怎么办...）
      ...
```

## 🔧 如何修改提示词

### 1. 修改现有提示词

直接编辑 `backend/prompts.yaml` 文件：

```yaml
chat:
  zh:
    system_role: "你是一个专业的AI助手。"  # 修改这里
```

保存后等待60秒（或配置的缓存时间），新提示词自动生效。

### 2. 启用可选提示

配置文件中有一些注释掉的可选提示，取消注释即可启用：

```yaml
character:
  zh:
    # 取消下面的注释来启用角色一致性提示
    consistency_hint: |
      保持角色一致性：
      - 记住之前对话中的细节和承诺
      - 保持角色的价值观和行为模式
```

### 3. 添加新的提示部分

你可以在配置中添加新的字段，然后修改代码来使用它们：

```yaml
character:
  zh:
    # 新增自定义字段
    my_custom_hint: |
      这是我的自定义提示...
```

然后在 `prompt_config.py` 的 `build_character_system_prompt` 方法中添加：

```python
if 'my_custom_hint' in config:
    parts.append(config['my_custom_hint'])
```

## 🎨 常见修改示例

### 示例1：让AI更有个性

```yaml
chat:
  zh:
    system_role: "你是一个幽默风趣、充满活力的AI助手。"
    response_rules: |
      用轻松愉快的语气回复用户。
      适当使用表情符号和俏皮话。
      保持专业但不失亲和力。
```

### 示例2：增强角色情感表达

```yaml
character:
  zh:
    # 取消注释并修改
    emotion_guide: |
      情感表达指南：
      - 展现丰富的情感层次
      - 通过细微的表情和动作传达情绪
      - 在对话中自然流露真实感受
      - 根据情境调整情感强度
```

### 示例3：添加场景描写提示

```yaml
character:
  zh:
    scene_guide: |
    场景描写：
      - 描述环境的视觉、听觉、嗅觉细节
      - 利用天气和光线营造氛围
      - 通过环境变化推动情节
      - 让场景成为角色情感的延伸
```

### 示例4：调整对话风格

```yaml
character:
  zh:
    format_rules: |
      回复格式规则：
      - 对话用双引号："..."
      - 内心想法用括号：（...）
      - 动作描写用【】：【微笑着点头】
      - 环境描写用〔〕：〔微风拂过〕
      - 保持自然流畅，不要过度使用标记
```

## ⚙️ 高级配置
### 调整缓存时间

```yaml
advanced:
  hot_reload: true
  cache_ttl: 30  # 改为30秒缓存
  log_loading: true
```

### 禁用热加载

```yaml
advanced:
  hot_reload: false  # 禁用热加载，提升性能
```

### 禁用日志

```yaml
advanced:
  log_loading: false  # 不记录提示词加载日志
```

## 🐛 故障排除

### 问题1：修改后没有生效

**原因**：缓存还没过期

**解决**：
1. 等待缓存时间（默认60秒）
2. 或者重启后端服务
3. 或者减小 `cache_ttl` 值

### 问题2：YAML格式错误

**症状**：服务启动失败或使用默认提示词

**解决**：
1. 检查YAML缩进（必须使用空格，不能用Tab）
2. 检查引号是否配对
3. 检查特殊字符是否需要转义
4. 使用在线YAML验证器检查格式

### 问题3：中文显示乱码

**原因**：文件编码问题

**解决**：
1. 确保文件保存为UTF-8编码
2. 不要使用记事本编辑，使用VS Code等编辑器

### 问题4：提示词太长
**症状**：Token超限或响应缓慢

**解决**：
1. 精简提示词内容
2. 移除不必要的说明
3. 使用更简洁的表达

## 📊 提示词变量

配置中可以使用以下变量（会被自动替换）：

### 角色扮演提示词

- `{name}` - 角色名字
- `{user}` - 用户昵称

示例：
```yaml
identity: "你是{name}，一个来自未来的AI。"
user_info: "你正在与{user}对话。"
```

## 🔍 查看当前提示词

如果想查看当前实际使用的提示词，可以：

1. 查看日志（如果启用了 `log_loading`）
2. 在代码中添加调试输出
3. 使用API返回提示词（需要开发者模式）

## 💡 最佳实践

### 1. 提示词设计原则

- **简洁明确**：避免冗长和模糊的描述
- **结构清晰**：使用分点列举，便于AI理解
- **避免矛盾**：确保不同部分的指令不冲突
- **测试验证**：修改后进行充分测试

### 2. 版本管理

建议使用Git管理提示词配置：

```bash
# 提交前备份
cp backend/prompts.yaml backend/prompts.yaml.backup

# 修改后提交
git add backend/prompts.yaml
git commit -m "优化角色扮演提示词"
```

### 3. A/B测试

可以创建多个配置文件进行对比测试：

```
backend/prompts.yaml        # 当前使用
backend/prompts.v1.yaml     # 版本1
backend/prompts.v2.yaml       # 版本2
backend/prompts.experimental.yaml  # 实验版本
```

### 4. 文档化

在配置文件中添加注释说明修改原因：

```yaml
chat:
  zh:
    # 2024-05-12: 增加专业性，减少口语化表达
    system_role: "你是一个专业的AI助手。"
```

## 🚀 进阶用法

### 1. 条件提示词

可以根据不同场景使用不同的提示词配置：

```python
# 在代码中根据条件选择配置
if user.is_premium:
    config_path = "backend/prompts.premium.yaml"
else:
    config_path = "backend/prompts.yaml"
```

### 2. 动态提示词

结合用户设置动态调整提示词：

```python
# 根据用户偏好调整
if user_setting.verbose_mode:
    # 使用详细版提示词
else:
    # 使用简洁版提示词
```

### 3. 提示词模板

创建提示词模板系统，支持更灵活的组合：

```yaml
templates:
  professional: "保持专业和正式的语气"
  casual: "使用轻松随意的语气"
  creative: "发挥创造力，大胆想象"

character:
  zh:
    tone: "{{templates.casual}}"  # 引用模板
```

## 📚 参考资源

- [YAML语法指南](https://yaml.org/)
- [提示工程最佳实践](https://platform.openai.com/docs/guides/prompt-engineering)
- [角色扮演提示词设计](https://docs.anthropic.com/claude/docs/character-design)

## 🆘 获取帮助

如果遇到问题：

1. 查看日志文件：`backend/logs/app.log`
2. 检查配置文件格式
3. 查看示例配置：`backend/prompts.yaml`
4. 提交Issue或联系开发者
