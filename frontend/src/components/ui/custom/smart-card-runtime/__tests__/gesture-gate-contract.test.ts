/*
 * 智能卡动作「用户手势闸门」契约测试
 *
 * 背景（SEC-2026-09-02 F-1）：智能卡经 postMessage request 通道可请求 35 个动作，
 * 最初仅 8 个受手势闸门保护，且闸门判定是消息体里自声明的 __palinkUserGesture
 * —— 恶意卡片自己填 true 即可绕过。
 *
 * 修复分两部分（本测试锁定行为，防回归）：
 *   ① 父侧（CharacterCardRenderer）把 __palinkUserGesture **改写为帧内密钥验证结果**，
 *      卡片自填不再有效（令牌由 <head> meta 一次性投递给 shim，卡片读不到）。
 *   ② 把 `clearChat` 纳入手势闸门 —— 唯一「不可逆 + 落库 + 无无手势正当用法」的动作。
 *
 * ⚠️ 本文件同时是**兼容性守卫**：明确列出那些「无手势也必须放行」的动作
 * （生成后改写消息 / 追加消息 / 写世界书 / 删单条），防止后续有人扩大闸门集合
 * 而误伤卡片正常流程。删改这些用例前请先读 SmartCardCompatController 里
 * SMART_CARD_MUTATING_ACTIONS_REQUIRING_GESTURE 上方的兼容性论证注释。
 *
 */

import { describe, it, expect } from 'vitest';
import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================
// 测试夹具
// ============================================================

interface RespondCall { ok: boolean; reason?: string; blocked?: boolean }

/** 构造一次 request 调用，返回 respond 收到的内容 + context 上各方法的调用次数。 */
async function runAction(
  actionName: string,
  payload: Record<string, unknown>,
): Promise<{ respond: RespondCall | null; calls: Record<string, number> }> {
  const calls: Record<string, number> = {};
  const bump = (key: string) => { calls[key] = (calls[key] || 0) + 1; };

  const context = {
    selectedCharacterName: 'tester',
    selectedCharacterId: 'c1',
    selectedModel: 'm1',
    selectedSession: null,
    sessionId: null,
    branchId: null,
    wb: {},
    clearChat: async () => { bump('clearChat'); },
    deleteMessage: async () => { bump('deleteMessage'); },
    setChatMessage: async () => { bump('setChatMessage'); },
    appendMessage: async () => ({ success: true, content: 'x' }),
    setInputDraft: () => { bump('setInputDraft'); },
  };

  let respond: RespondCall | null = null;
  await handleSmartCardCompatRequest(
    { worldBook: null } as never,
    context as never,
    {
      type: 'request',
      requestId: 'req-1',
      action: actionName,
      payload,
      respond: (r: { ok: boolean; result?: unknown; error?: string }) => {
        const result = (r.result || {}) as { reason?: string; blocked?: boolean };
        respond = { ok: r.ok, reason: result.reason, blocked: result.blocked };
      },
    } as never,
  );
  return { respond, calls };
}

/** 断言该动作**没有**被手势闸门拦下（兼容性守卫用）。 */
function assertNotGestureBlocked(respond: RespondCall | null, actionName: string): void {
  const blocked = respond?.blocked === true && respond?.reason === 'user_gesture_required';
  assert(!blocked, `${actionName} 不应被手势闸门拦截（会打断卡片正常的无手势流程）`);
}

// ============================================================
// 用例
// ============================================================

describe('F-1 手势闸门 — 收口行为', () => {
  it('clearChat 无手势 → 拦截，且不落库', async () => {
    const { respond, calls } = await runAction('clearChat', {});
    assert(respond !== null, '应有 respond 回调');
    assertEqual(respond!.ok, false, 'clearChat 无手势应失败');
    assertEqual(respond!.reason, 'user_gesture_required', '拒绝原因应为缺少手势');
    assertEqual(calls.clearChat, undefined, '被拦截时 clearChat 不得执行（不得删库）');
  });

  it('clearChat 卡片自填 __palinkUserGesture=true → 仍拦截（父侧会改写，此处模拟未验证）', async () => {
    // 父侧会先把自填值改写为令牌验证结果；本用例模拟「父侧改写为 false」之后的判定，
    // 确保控制器消费的是改写后的值、而非卡片原始声明。
    const { respond, calls } = await runAction('clearChat', { __palinkUserGesture: false });
    assertEqual(respond!.ok, false, '改写为 false 后必须拦截');
    assertEqual(calls.clearChat, undefined, '不得执行');
  });

  it('clearChat 已验证手势 → 放行并执行', async () => {
    const { respond, calls } = await runAction('clearChat', { __palinkUserGesture: true });
    assertEqual(respond!.ok, true, '已验证手势应放行');
    assertEqual(calls.clearChat, 1, 'clearChat 应执行一次');
  });

  it('既有行为守卫：generate 无手势 → 仍拦截（防止改动误放宽）', async () => {
    const { respond } = await runAction('generate', {});
    assertEqual(respond!.ok, false, 'generate 无手势应仍被拦截');
    assertEqual(respond!.reason, 'user_gesture_required', '拒绝原因一致');
  });
});

describe('F-1 兼容性守卫 — 无手势也必须放行的动作', () => {
  // 以下用例是本次收口的**红线**：这些动作常见于「生成结束后」等无手势上下文
  // （MVU 变量更新、状态栏、格式化卡、世界书同步），一旦被闸门拦截即为 ST 兼容回归。
  it('setChatMessage 无手势 → 放行', async () => {
    const { respond } = await runAction('setChatMessage', { message_id: 1, content: 'x' });
    assertNotGestureBlocked(respond, 'setChatMessage');
  });

  it('updateMessageBlock 无手势 → 放行', async () => {
    const { respond } = await runAction('updateMessageBlock', { message_id: 1, content: 'x' });
    assertNotGestureBlocked(respond, 'updateMessageBlock');
  });

  it('addOneMessage 无手势 → 放行', async () => {
    const { respond } = await runAction('addOneMessage', { content: 'x' });
    assertNotGestureBlocked(respond, 'addOneMessage');
  });

  it('deleteLastMessage 无手势 → 放行', async () => {
    const { respond } = await runAction('deleteLastMessage', {});
    assertNotGestureBlocked(respond, 'deleteLastMessage');
  });

  it('deleteMessage 无手势 → 放行', async () => {
    const { respond } = await runAction('deleteMessage', { message_id: 1 });
    assertNotGestureBlocked(respond, 'deleteMessage');
  });

  it('createOrReplaceWorldbook 无手势 → 放行（世界书写路径不得打断）', async () => {
    const { respond } = await runAction('createOrReplaceWorldbook', { name: 'b', entries: [] });
    assertNotGestureBlocked(respond, 'createOrReplaceWorldbook');
  });

  it('setInputDraft 无手势 → 放行', async () => {
    const { respond } = await runAction('setInputDraft', { content: 'x' });
    assertNotGestureBlocked(respond, 'setInputDraft');
  });
});

