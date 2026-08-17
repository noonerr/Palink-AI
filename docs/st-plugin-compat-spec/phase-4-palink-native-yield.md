# Phase 4: 双轨功能让步

## 目标

让 ST 插件主导，Palink 原生功能降级或共存。解决 memory/vectors/regex/connection-manager/slash-commands 五个双轨冲突。

## Why

Phase 0-3 补齐了 ST 插件所需的基础设施，但 Palink 原生功能仍与 ST 插件并行运行，导致：
- **memory 双轨**：ST `1_memory` 扩展 + Palink `memory_module` 双重摘要、双重 token 消耗
- **vectors 双轨**：Phase 3 已把 `/api/vector/*` 代理到 sidecar，但 Palink `worldbook_vector_service` 仍可能介入
- **regex 双轨**：ST regex 扩展 UI 与 Palink regex-pipeline 脚本源隔离
- **connection-manager 双轨**：Phase 3 已代理 `/api/connection*`，但 Palink 连接管理仍可能冲突
- **斜杠命令双轨**：ST 插件注册命令直接覆盖 Palink 命令，无保护

## What Changes

### 改动点

#### 1. memory_module 降级（让 ST memory 主导）

**文件**：`backend/app/memory_module/config.py`（行 17-21）

**当前**：仅环境变量 `MEMORY_ENABLED` 控制

**改为**：增加 DB 字段 + 用户设置开关，默认禁用（让 ST memory 主导）

```python
class MemoryConfig:
    ENABLED = os.getenv("MEMORY_ENABLED", "false").lower() == "true"  # 默认改为 false

    @classmethod
    def is_enabled(cls):
        return cls.ENABLED

    @classmethod
    def is_user_enabled(cls, user_id: int, db: Session) -> bool:
        """检查用户是否启用 Palink memory_module（默认 false，让 ST memory 主导）"""
        from app.models.user_settings import UserSetting
        setting = db.query(UserSetting).filter(
            UserSetting.user_id == user_id,
            UserSetting.key == "palink_memory_enabled"
        ).first()
        return setting.value.lower() == "true" if setting else False
```

**文件**：`backend/app/services/roleplay_prompt_assembly.py`（行 3072, 4044-4100）

**改为**：`_append_memory_context` 检查 `is_user_enabled`，默认跳过

```python
async def _append_memory_context(req, deps, memory_mode, dynamic_context_parts, report):
    if memory_mode == "disabled" or req.is_init:
        return

    # 新增：检查用户是否启用 Palink memory_module（默认禁用，让 ST memory 主导）
    if not MemoryConfig.is_user_enabled(req.user_id, req.db):
        return  # 跳过 Palink memory_module，让 ST 1_memory 扩展接管

    mem_svc = MemoryService(req.db)
    if mem_svc.is_available():
        ...
```

**用户设置 UI**：在 Palink 设置页新增"记忆系统"开关，默认关闭，提示"已由 ST memory 扩展接管"。

#### 2. vectors 让步（让 ST vectors 主导）

**文件**：`backend/app/services/worldbook_vector_service.py`

**当前**：Palink `worldbook_vector_service` 可能介入向量化

**改为**：当 ST vectors 扩展已加载时，`worldbook_vector_service` 不介入

```python
class WorldbookVectorService:
    def is_st_vectors_active(self) -> bool:
        """检查 ST vectors 扩展是否已加载"""
        # 通过 ST sidecar 检查 vectors 扩展状态
        ...

    def should_palink_vectorize(self) -> bool:
        """是否应由 Palink 进行向量化（ST vectors 未加载时）"""
        return not self.is_st_vectors_active()
```

**注意**：Phase 3 已把 `/api/vector/*` 代理到 sidecar，这里只需确保 Palink 内部的 `worldbook_vector_service` 不与 ST vectors 冲突。

#### 3. regex 双向同步

**文件**：`frontend/src/lib/plugin-system/sandbox.ts`

**当前**：ST regex 扩展 UI 改动存入 `ext_settings_regex`（Phase 1 后存入全局 `extension_settings.regex`），与 Palink 后端 `extensions.regex_scripts` 隔离

**改为**：在 `extension_settings.regex` 的 set 拦截器中同步到 Palink 后端

```typescript
// 在 extension_settings 的 set 拦截器中
set(target, prop, value) {
  if (typeof prop === 'string') {
    target[prop] = value;
    // 同步到全局 + 持久化
    syncToGlobalExtensionSettings(prop, value);
    saveExtensionSettingsDebounced();

    // 特殊处理：regex 字段同步到 Palink 后端
    if (prop === 'regex' || prop === 'character_allowed_regex' || prop === 'preset_allowed_regex') {
      syncRegexToPalinkBackend(value);
    }
  }
  return true;
}

async function syncRegexToPalinkBackend(regexSettings: any): Promise<void> {
  try {
    // 把 ST 格式的 regex 脚本转换为 Palink 格式
    const palinkScripts = convertStRegexToPalink(regexSettings);
    await fetch(`/api/characters/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensions: { regex_scripts: palinkScripts }
      }),
    });
  } catch (err) {
    console.error('[regex-sync] sync to Palink backend failed:', err);
  }
}
```

**反向同步**：Palink 后端的 regex 改动也需同步到 `extension_settings.regex`

```typescript
// 在 Palink 角色卡加载时
function syncPalinkRegexToExtensionSettings(character: any): void {
  const palinkScripts = character?.extensions?.regex_scripts ?? [];
  const stScripts = convertPalinkRegexToSt(palinkScripts);
  globalExtensionSettings.regex = stScripts;
  saveExtensionSettingsDebounced();
}
```

#### 4. connection-manager 共存

**文件**：`backend/app/api/connection_profiles.py`

**当前**：Palink 连接管理是独立功能

**改为**：保持独立，但与 ST connection-manager 共存：
- Palink 连接管理：加密存储、REST API、Palink 原生 UI
- ST connection-manager：明文 localStorage、`/api/connection*` 代理到 sidecar、ST 扩展 UI

**冲突处理**：
- Palink 生成流程优先使用 Palink 连接管理（加密 profile）
- ST 扩展的生成流程使用 ST connection-manager（明文 profile）
- 两套 profile 独立，不互相同步

**用户提示**：在 Palink 连接管理 UI 提示"ST 扩展使用独立的 connection-manager 配置"。

#### 5. 斜杠命令保护

**文件**：`frontend/src/lib/slash-engine/index.ts`（行 81-91）

**当前**：`register()` 直接覆盖同名命令，无冲突检测

**改为**：对极少数核心命令保护，其余允许 ST 覆盖

```typescript
// 必须保护的 Palink 核心命令（避免破坏基础功能）
const PROTECTED_COMMANDS = new Set([
  'clear',  // 清空聊天
]);

class SlashCommandEngine {
  register(command: CommandDefinition): void {
    const name = command.name.toLowerCase();
    const existing = this.commands.get(name);

    if (existing && PROTECTED_COMMANDS.has(name)) {
      // 受保护命令：拒绝覆盖，记录 warning
      console.warn(`[slash-engine] command "/${name}" is protected, cannot be overridden by ST plugin`);
      return;
    }

    if (existing) {
      // 非保护命令：允许覆盖，记录 info
      console.info(`[slash-engine] command "/${name}" overridden by ST plugin (was: ${existing.description || 'unknown'})`);
    }

    this.commands.set(name, command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.set(alias.toLowerCase(), name);
      }
    }
  }
}
```

**后端斜杠命令**（`backend/app/services/slash_command_service.py`）同样加保护：

```python
PROTECTED_COMMANDS = {
    "clear",
}

class SlashCommandRegistry:
    @classmethod
    def register(cls, name, handler, aliases=None, help_text=""):
        name = name.lower()
        if name in cls._commands and name in PROTECTED_COMMANDS:
            import logging
            logging.warning(f"[slash] command /{name} is protected, cannot be overridden")
            return
        cls._commands[name] = handler
        ...
```

#### 6. Palink memory_module 用户开关 UI

**文件**：`frontend/src/pages/settings/memory.tsx`（新建或修改）

```tsx
export function MemorySettings() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // 从后端读取用户设置
    fetch('/api/user-settings/palink_memory_enabled')
      .then(res => res.json())
      .then(data => setEnabled(data.value === 'true'));
  }, []);

  const handleToggle = (value: boolean) => {
    setEnabled(value);
    fetch('/api/user-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'palink_memory_enabled', value: String(value) }),
    });
  };

  return (
    <div className="palink-memory-settings">
      <h2>记忆系统</h2>
      <p className="hint">
        默认已由 ST memory 扩展接管。如需启用 Palink 原生记忆系统，请打开此开关（可能与 ST memory 冲突）。
      </p>
      <Toggle checked={enabled} onChange={handleToggle} label="启用 Palink 原生记忆系统" />
    </div>
  );
}
```

## 验收标准

### 单元测试
- [ ] `backend/tests/test_memory_module_yield.py`
  - test 默认禁用 Palink memory_module
  - test 用户开关启用后 Palink memory_module 生效
  - test ST memory 扩展与 Palink memory_module 不冲突
- [ ] `frontend/src/lib/slash-engine/__tests__/register-protection.test.ts`
  - test `/clear` 受保护，ST 插件无法覆盖
  - test 其他命令允许 ST 插件覆盖
  - test 覆盖时记录 warning/info
- [ ] `frontend/src/lib/sillytavern/__tests__/regex-sync.test.ts`
  - test ST regex UI 改动同步到 Palink 后端
  - test Palink 后端 regex 改动同步到 extension_settings.regex

### 集成测试
- [ ] ST memory 扩展运行时，Palink memory_module 不介入（无双重摘要）
- [ ] ST regex 扩展 UI 创建的脚本出现在 Palink 角色卡配置
- [ ] ST 插件注册 `/sys` 命令成功覆盖 Palink 的 `/sys`
- [ ] ST 插件注册 `/clear` 命令失败（受保护）

### 回归测试
- [ ] 后端全量回归：512 passed, 45 skipped, 0 failed
- [ ] ST 验收脚本：220/220 passed
- [ ] 前端 TypeScript：修改的文件 0 错误

## 风险与注意事项

1. **memory_module 降级影响**：默认禁用 Palink memory_module 后，依赖它的 Palink 原生功能（如向量检索）可能失效。需确认无关键功能依赖。
2. **regex 双向同步死循环**：A 改 B 同步、B 改 A 同步。用标志位或时间戳去重。
3. **斜杠命令覆盖**：允许 ST 覆盖 `/sys`/`/note`/`/model` 等命令会改变 Palink 行为。用户需明确知道哪些命令被覆盖。
4. **connection-manager 共存**：两套 profile 独立，用户可能困惑。需在 UI 明确区分。
5. **向后兼容**：已启用 Palink memory_module 的用户需迁移（默认禁用后他们需手动开启）。

## 完成判定

- Palink memory_module 默认禁用，用户可手动启用
- ST vectors 扩展加载时，Palink worldbook_vector_service 不介入
- ST regex UI 改动双向同步到 Palink 后端
- 斜杠命令仅 `/clear` 受保护，其余允许 ST 覆盖
- 全量回归 0 failure

---

## 实施结果（As-Built，2026-07-28，分支 st-plugin-compat-20260727）

> 以下为实际落地方案，若与上文预案冲突，以本节为准。

### 关键决策修正

1. **memory 让步：未采用"默认禁用"预案，改为自动让步（auto-yield）**：
   - `MEMORY_ENABLED` 保持默认 `true`（不破坏存量用户）。
   - 新增 `_st_vector_data_active(db, user_id)`（roleplay_prompt_assembly.py）：检测该用户存在 `st-vec::` 前缀数据（即 ST vectors 扩展在用）时，`_append_memory_context` 自动跳过 Palink 记忆注入，report 记 `yielded to ST vector storage`。60s TTL 缓存。
   - 可用环境变量 `MEMORY_ST_YIELD=false` 关闭让步。commit `b183734`。
2. **settings/save extension_settings 命名空间级合并**（Phase 1 补强）：载荷含 `extension_settings` 时与旧值按 namespace 浅合并；载荷缺省时保留旧值。防止插件局部保存覆盖全局。commit `877bc94`。
3. **斜杠命令 `/clear` 保护**：前端 `commands.ts` 加 `window.confirm` 确认（`force=true` 跳过）；后端 slash_command_service 本就不注册 `/clear`，无需后端改动。commit `230e446`。
4. **regex 双向同步转换器：本轮跳过**（用户已确认接受的已知限制）；ST→Palink 单向导入已有（`_append_unique_regex_scripts`）。
5. **worldbook_vector_service / connection-manager 让步未实施**（未发现实际冲突路径，后续按需）。

### 验证结果

- memory 让步逻辑随 `test_st_contract.py` 回归通过（39 passed / 3 skipped）。
- `tsc --noEmit`：仅 `NativeRoleplayChat.tsx` 6 个既有基线错误，无新增。
