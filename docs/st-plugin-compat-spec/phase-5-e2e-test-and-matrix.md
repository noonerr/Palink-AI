# Phase 5: 端到端测试与兼容性矩阵回填

## 目标

用真实 ST 插件验证 Phase 0-4 的修复效果，回填 `PALINK_ST_PLUGIN_COMPAT_MATRIX.md`，建立 CI 回归测试。

## Why

Phase 0-4 是基于代码分析的修复，需用真实插件端到端验证：
- 矩阵文档明确标注"待浏览器运行时验证"
- 契约测试只验字段存在性，不验行为
- 实际插件可能有未预见的依赖组合

## What Changes

### 改动点

#### 1. ST 内置扩展端到端测试

**测试范围**：12 个 ST 内置扩展

| 扩展 | 类别 | 测试场景 | 期望结果 |
|---|---|---|---|
| token-counter | Class A | 加载后显示 token 计数 | 完全可用 |
| regex | Class B | 创建/编辑/应用正则脚本 | UI 可见 + 后台生效 |
| quick-reply | Class B | 按钮栏挂载 + 点击插入文本 | UI 可见 + 双向同步 |
| caption | Class B | 上传图片生成描述 | 后台生效（vision 接入） |
| tts | Class B | 文本转语音播放 | 后台生效（provider 接入） |
| memory | Class B | 摘要生成 + 注入 | 后台生效 + setExtensionPrompt 注入 |
| attachments | Class B | 上传/列出/删除附件 | UI 可见 + 后端端点可用 |
| expressions | Class C | sprite 加载 + 表情切换 | 后端端点可用 |
| vectors | Class C | 索引/查询/重排消息 | 后端端点可用 + interceptor 执行 |
| gallery | Class C | 图片列表/查看 | 后端端点可用 |
| assets | Class C | 安装/删除扩展 | 后端端点可用 |
| connection-manager | Class C | profile CRUD | 后端端点可用 |

**测试方法**：
- 每个扩展编写自动化测试（Playwright + 真实 ST 扩展加载）
- 手动验证关键场景（浏览器操作 + 截图）

**文件**：`frontend/tests/st-plugin-e2e/`（新建）

```
frontend/tests/st-plugin-e2e/
├── token-counter.spec.ts
├── regex.spec.ts
├── quick-reply.spec.ts
├── caption.spec.ts
├── tts.spec.ts
├── memory.spec.ts
├── attachments.spec.ts
├── expressions.spec.ts
├── vectors.spec.ts
├── gallery.spec.ts
├── assets.spec.ts
└── connection-manager.spec.ts
```

**测试模板**（以 vectors 为例）：

```typescript
import { test, expect } from '@playwright/test';

test.describe('ST vectors extension', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/roleplay/1');
    // 等待 ST vectors 扩展加载
    await page.waitForFunction(() => !!(window as any).vectors_rearrangeChat);
  });

  test('vectors_rearrangeChat is registered', async ({ page }) => {
    const registered = await page.evaluate(() => {
      return typeof (window as any).vectors_rearrangeChat === 'function';
    });
    expect(registered).toBeTruthy();
  });

  test('interceptor runs on generation', async ({ page }) => {
    // 监听 console
    const logs: string[] = [];
    page.on('console', msg => logs.push(msg.text()));

    // 触发生成
    await page.fill('#send_textarea', 'test message');
    await page.click('#send_button');

    // 等待生成完成
    await page.waitForTimeout(5000);

    // 验证 interceptor 被调用（通过日志或网络请求）
    expect(logs.some(l => l.includes('vectors'))).toBeTruthy();
  });

  test('/api/vector/list endpoint works', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/vector/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty('hashes');
  });
});
```

#### 2. 第三方插件兼容性测试

**测试范围**：20+ 主流第三方 ST 插件

| 插件 | 类别 | 来源 |
|---|---|---|
| quick-reply 扩展包 | Class B | GitHub |
| variable-engine | Class A | GitHub |
| dn-floorp | Class A | GitHub |
| js-slash-runner | Class A | GitHub |
| quick-reply-api | Class B | GitHub |
| author's-note | Class B | GitHub（ST 内置） |
| world-info-lister | Class A | GitHub |
| lumao-character-card-fix | Class A | GitHub |
| chat-message-tooltips | Class B | GitHub |
| st-extension-disabled | Class A | GitHub |
| group-chat-enhancer | Class B | GitHub |
| reply-with-quote | Class B | GitHub |
| ... | ... | ... |

**测试方法**：
- 从 GitHub 安装插件（通过 `/api/extensions/install`）
- 加载后验证核心功能
- 记录不兼容问题

#### 3. 兼容性矩阵回填

**文件**：`docs/PALINK_ST_PLUGIN_COMPAT_MATRIX.md`

**当前**：静态分析，标注"待浏览器运行时验证"

**改为**：回填实际测试结果

```markdown
## ST 内置扩展兼容性

| 扩展 | 类别 | 状态 | 测试日期 | 备注 |
|---|---|---|---|---|
| token-counter | Class A | ✅ Supported | 2026-07-27 | 完全可用 |
| regex | Class B | ✅ Supported | 2026-07-27 | UI 可见 + 双向同步 |
| quick-reply | Class B | ✅ Supported | 2026-07-27 | #qr_bar 可见 |
| caption | Class B | ⚠️ Partial | 2026-07-27 | vision 需配置 |
| tts | Class B | ⚠️ Partial | 2026-07-27 | 仅 System/Edge provider |
| memory | Class B | ✅ Supported | 2026-07-27 | Palink memory_module 默认禁用 |
| attachments | Class B | ✅ Supported | 2026-07-27 | 后端端点已实现 |
| expressions | Class C | ✅ Supported | 2026-07-27 | sprite 端点已实现 |
| vectors | Class C | ✅ Supported | 2026-07-27 | interceptor + 端点已实现 |
| gallery | Class C | ✅ Supported | 2026-07-27 | images 端点已实现 |
| assets | Class C | ✅ Supported | 2026-07-27 | extensions install 已实现 |
| connection-manager | Class C | ✅ Supported | 2026-07-27 | connection 端点已实现 |

## 第三方插件兼容性

| 插件 | 类别 | 状态 | 测试日期 | 备注 |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |
```

#### 4. CI 回归测试

**文件**：`.github/workflows/st-plugin-compat.yml`（新建或修改）

```yaml
name: ST Plugin Compatibility

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  st-plugin-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      - name: Install dependencies
        run: |
          cd frontend
          npm ci
          npx playwright install --with-deps
      - name: Start services
        run: |
          docker compose up -d backend
          sleep 30
      - name: Run ST plugin E2E tests
        run: |
          cd frontend
          npx playwright test tests/st-plugin-e2e/
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: st-plugin-test-results
          path: frontend/test-results/
```

#### 5. 已知不兼容问题清单

**文件**：`docs/st-plugin-compat-spec/known-issues.md`（新建）

记录测试中发现的不兼容问题及原因：

```markdown
# 已知不兼容问题

## 完全不兼容

| 插件 | 原因 | 修复方案 |
|---|---|---|
| ... | ... | ... |

## 部分兼容

| 插件 | 问题 | 影响范围 | 临时方案 |
|---|---|---|---|
| ... | ... | ... | ... |

## 已修复

| 插件 | 问题 | 修复 Phase | 修复日期 |
|---|---|---|---|
| ... | ... | ... | ... |
```

## 验收标准

### 测试覆盖
- [ ] 12 个 ST 内置扩展全部有 E2E 测试
- [ ] 20+ 第三方插件有测试记录
- [ ] 每个不兼容问题有详细记录（复现步骤 + 原因 + 修复方案）

### 矩阵回填
- [ ] `PALINK_ST_PLUGIN_COMPAT_MATRIX.md` 所有"待浏览器运行时验证"更新为实际结果
- [ ] 测试日期和测试人填写完整
- [ ] 已知问题清单完整

### CI 集成
- [ ] `.github/workflows/st-plugin-compat.yml` 配置完整
- [ ] CI 在 PR 时自动运行 E2E 测试
- [ ] 测试失败时阻止合并

### 回归测试
- [ ] 后端全量回归：512 passed, 45 skipped, 0 failed
- [ ] ST 验收脚本：220/220 passed
- [ ] 前端 TypeScript：修改的文件 0 错误
- [ ] E2E 测试全部通过

## 风险与注意事项

1. **测试环境**：E2E 测试需要完整环境（backend + frontend + ST sidecar），CI 配置要正确。
2. **真实插件依赖**：第三方插件可能依赖特定 ST 版本或 extras 服务，测试时需模拟。
3. **测试稳定性**：Playwright 测试可能 flaky，需合理设置超时和重试。
4. **测试数据**：部分测试需要预置数据（角色卡、聊天记录、sprite 等），需准备测试 fixture。
5. **手动验证**：自动化测试无法覆盖所有场景，关键功能需手动验证 + 截图。

## 完成判定

- 12 个 ST 内置扩展 E2E 测试全部通过
- 20+ 第三方插件测试完成，结果记录在矩阵
- `PALINK_ST_PLUGIN_COMPAT_MATRIX.md` 回填实际结果
- CI 自动化测试配置完整
- 已知不兼容问题清单完整
- 全量回归 0 failure
