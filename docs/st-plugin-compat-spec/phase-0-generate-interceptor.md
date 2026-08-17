# Phase 0: generate_interceptor 接入

## 目标

让 ST 的生成拦截器机制（`runGenerationInterceptors`）在 Palink 生成流程中能运行，解锁 vectors（向量化新消息）和 stable-diffusion（触发词检测）等依赖拦截器的扩展。

## Why

ST 1.18.0 的 `extensions.js:2008-2040` 定义 `runGenerationInterceptors(chat, contextSize, type)`，在生成前遍历所有 manifest 中声明 `generate_interceptor` 的扩展，调用 `globalThis[interceptorKey](chat, contextSize, abort, type)`。

当前 Palink 的 `frontend/src/services/generation-engine.ts` 的 `generate()` 方法（行 166-252）**完全缺失 interceptor 钩子**，直接调用后端 API，导致：
- `vectors_rearrangeChat`（vectors/manifest.json:8）永不执行 → 新消息不被向量化 → 向量检索失效
- `SD_ProcessTriggers`（stable-diffusion/manifest.json:8）永不执行 → 自动生图失效
- 拦截器的 `abort(immediately)` 能力丢失 → 插件无法中止生成

## What Changes

### ST runGenerationInterceptors 契约

**签名**（`frontend/public/st/scripts/extensions.js:2015`）：
```js
export async function runGenerationInterceptors(chat, contextSize, type)
```

**参数**：
- `chat`: ChatMessage[] — 聊天消息数组（**注意：interceptor 可直接 mutate 此数组**，如 vectors 会移除并重排消息）
- `contextSize`: number — 上下文大小
- `type`: string — 生成类型（'normal'/'regenerate'/'continue'/'swipe'/'quiet' 等）

**返回值**：`Promise<boolean>` — `true` 表示 generation should be aborted

**abort 回调**（传给 interceptor 的第三个参数）：
```js
const abort = (immediately) => {
  aborted = true;
  exitImmediately = immediately;
};
```

**遍历逻辑**：
- 过滤 `manifest.generate_interceptor` 非空的 manifest
- 按 `loading_order` 排序
- 对每个 manifest：`await globalThis[interceptorKey](chat, contextSize, abort, type)`
- 调用失败仅 `console.error`，不中断后续
- `exitImmediately` 为 true 时立即 break

### 改动点

#### 1. MODIFIED: `frontend/src/services/generation-engine.ts`

**1.1 在 `generate()` 方法（行 166-252）调用后端 API 之前插入 interceptor 调用**

在行 199（`_setGenerating(true)` 之后）和行 201（`api.stream` 调用）之间插入：

```typescript
// ── ST 1.18.0 generate_interceptor 接入 ──
// 在调用后端生成 API 前，运行 ST 扩展的拦截器（如 vectors_rearrangeChat）
// 拦截器可能 mutate chat 数组（vectors 会重排消息）或 abort 生成
try {
  const chat = this._getCurrentChat(); // 需新增辅助方法，从 runtime/session 取当前 chat 数组
  const contextSize = await this._getContextSize(); // 需新增辅助方法
  const type = options?.quietPrompt ? 'quiet' : 'normal';
  const shouldAbort = await runSTGenerationInterceptors(chat, contextSize, type);
  if (shouldAbort) {
    runtime?.emitGenerationEnded('plain', '');
    return;
  }
} catch (err) {
  console.error('[generation-engine] interceptor failed:', err);
  // 不中断生成，继续走原流程
}
```

**1.2 在 `generateQuietPrompt()` 方法（行 265-317）同样插入**

注意：`vectors_rearrangeChat` 在 `type === 'quiet'` 时直接 return（行 778-781），所以 quiet prompt 不会被向量化，但仍需调用 interceptor 让其他扩展有机会介入。

**1.3 在 `generateRaw()` 方法（行 330-395）同样插入**

**1.4 新增辅助方法 `_getCurrentChat()`**

从 runtime 或 session 取当前 chat 消息数组。返回可变数组（interceptor 会 mutate）。

**1.5 新增辅助方法 `_getContextSize()`**

返回当前上下文大小（从 runtime 或后端配置取）。

#### 2. ADDED: `frontend/src/lib/sillytavern/generation-interceptor.ts`

封装对 ST `runGenerationInterceptors` 的调用：

```typescript
import { runGenerationInterceptors } from '../../../public/st/scripts/extensions';

/**
 * 运行 ST 1.18.0 生成拦截器
 * @returns true 表示生成应被中止
 */
export async function runSTGenerationInterceptors(
  chat: any[],
  contextSize: number,
  type: string
): Promise<boolean> {
  try {
    return await runGenerationInterceptors(chat, contextSize, type);
  } catch (err) {
    console.error('[st-interceptor] runGenerationInterceptors failed:', err);
    return false; // 失败不中止生成
  }
}
```

#### 3. MODIFIED: `frontend/src/lib/plugin-system/sandbox.ts`

确保沙箱加载 ST 扩展时：
- 执行 `globalThis[interceptorKey] = ...` 挂载（vectors/index.js:891 已有此行）
- manifest 的 `generate_interceptor` 字段被正确注册到 ST `manifests` 对象

#### 4. MODIFIED: `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`

确保 ST Native 模式（iframe）下：
- `runGenerationInterceptors` 在 iframe 内被调用（ST 原生流程已包含）
- palink-native 模式下，generation-engine 通过 import 调用 ST 的 `runGenerationInterceptors`

## 验收标准

### 单元测试
- [ ] `frontend/src/services/__tests__/generation-engine-interceptor.test.ts`
  - test interceptor 被调用（mock runGenerationInterceptors）
  - test aborted=true 时生成被中止（不调用 api.stream）
  - test interceptor 抛错时生成继续（不中断）
  - test chat 数组被 mutate 后传给后端 API
  - test quiet prompt 也调用 interceptor

### 集成测试
- [ ] vectors 扩展加载后，生成时 `vectors_rearrangeChat` 被调用
- [ ] vectors `setExtensionPrompt(EXTENSION_PROMPT_TAG, ...)` 的内容出现在最终 prompt
- [ ] interceptor abort 后生成不执行

### 回归测试
- [ ] 后端全量回归：512 passed, 45 skipped, 0 failed
- [ ] ST 验收脚本：220/220 passed
- [ ] 前端 TypeScript：修改的文件 0 错误

## 风险与注意事项

1. **chat 数组 mutate**：`vectors_rearrangeChat` 会直接移除并重排 chat 数组中的消息（行 841-845）。generation-engine 传给后端的必须是 mutate 后的数组。
2. **async 顺序**：interceptor 是 async，必须在 `await` 后才调用后端 API。
3. **abort 语义**：`aborted=true` 时应调用 `runtime.emitGenerationEnded` 并 return，不调用后端 API。
4. **type 传递**：不同生成类型（normal/regenerate/continue/swipe/quiet）需正确传递，影响 interceptor 行为。
5. **globalThis 注册时机**：interceptor 函数（如 `vectors_rearrangeChat`）在扩展加载时才挂载到 globalThis，需确保扩展加载在生成之前完成。

## 完成判定

- generation-engine 的 `generate`/`generateQuietPrompt`/`generateRaw` 三处入口都调用 `runSTGenerationInterceptors`
- vectors 扩展的 `vectors_rearrangeChat` 在生成时被实际调用
- 全量回归 0 failure
- 容器重建后服务正常启动
