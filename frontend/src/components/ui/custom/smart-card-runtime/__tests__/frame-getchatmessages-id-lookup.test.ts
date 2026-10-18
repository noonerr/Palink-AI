/*
 * 帧内 getChatMessages 的 id/下标双语义守卫（P0 2026-10-06）
 *
 * 背景：卡「家裡的神明大人」状态栏恒显示「无法加载状态数据 (messages empty)」。
 * 卡脚本用的是 ST 惯用写法 getChatMessages(getCurrentMessageId())[0].message，
 * 而 Palink 的 ctx.messageId 是**数据库行 id**（实测 2740），不是 ST 语义的数组下标。
 *
 * 帧内注了两份 getChatMessages：
 *   1. legacy-st-sim.ts（先注入，且把 window.getChatMessages 挂上）—— 只按下标取，
 *      落空直接 return []；
 *   2. SillyTavernCompatRuntime.ts 的 getCompatChatMessages —— 2026-09-30 已加
 *      「下标没命中再按 id/message_id 匹配」的回退。
 * 但 compatV2 的桥接是 typeof window.getChatMessages === 'function' ? 用它 : 自己那份，
 * 于是 compatV2 的修复在帧内永远轮不到 → 09-30 那次修复实际是死代码。
 *
 * 本文件把两份实现**用真实函数体跑同一载荷做对照**，钉住：
 *   1. 行 id 载荷下两份都必须命中同一条消息（谁再只改一份就红）；
 *   2. ST 下标语义、无参语义不回退；
 *   3. 真正不存在的 id 仍返回空数组（不许改成"兜底返回最后一条"）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';
// [S4 2026-10-15] 运行时体已按行拆到 runtime-body/part-01..08.ts，改为读拼接后的源码文本。
// [包L 2026-10-18] 执行型测试 ⇒ 用求值后载体（与生产 iframe 逐字节一致），未求值文本会假绿。
import { COMPAT_V2_RUNTIME_ARTIFACT as COMPAT_V2_SOURCE } from './compat-v2-runtime-source';

/** 从源码/模板字符串里原样切出一个箭头函数体（不重写逻辑，避免测到一份"我以为的实现"）。 */
function sliceArrowFn(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

const LEGACY_BODY = sliceArrowFn(LEGACY_ST_SIM_SEGMENT, 'const getChatMessages = (messageId) =>');
const COMPAT_V2_BODY = sliceArrowFn(COMPAT_V2_SOURCE, 'const getCompatChatMessages = (messageId) =>');

const stripStyleBlocksForPlugin = (message: any) => message;

/** 帧内实际生效的调用序：legacy 占了 window.getChatMessages，compatV2 只会转调它。 */
function buildFrameSurface(chatMessages: any[], currentMessageId: any) {
  const legacyGetChatMessages = new Function(
    'chatMessages', 'ctx',
    `${LEGACY_BODY}; return getChatMessages;`,
  )( () => chatMessages, { messageId: currentMessageId });
  const compatV2GetChatMessages = new Function(
    'compatChat', 'ctx', 'stripStyleBlocksForPlugin',
    `${COMPAT_V2_BODY}; return getCompatChatMessages;`,
  )(chatMessages, { messageId: currentMessageId }, stripStyleBlocksForPlugin);
  const win = { getChatMessages: legacyGetChatMessages };
  const effective = (...args: any[]) => (typeof win.getChatMessages === 'function'
    ? win.getChatMessages(...args)
    : compatV2GetChatMessages(...args));
  return { legacyGetChatMessages, compatV2GetChatMessages, effective };
}

// 本例真实载荷：开场白（未落库，本地临时 id）+ 1 条已落库 assistant（数据库行 id = 2740）
const GREETING = { id: 'greeting-local', message_id: 'greeting-local', role: 'assistant', message: '“哼。”' };
const PERSISTED = { id: 2740, message_id: 2740, role: 'assistant', message: '一个极轻但充满不悦的音节……' };
const CHAT = [GREETING, PERSISTED];

describe('帧内 getChatMessages 的 id/下标双语义（P0 2026-10-06）', () => {
  it('数据库行 id：legacy 必须与 compatV2 命中同一条消息（两份实现不许分叉）', () => {
    const { legacyGetChatMessages, compatV2GetChatMessages, effective } = buildFrameSurface(CHAT, 2740);
    expect(legacyGetChatMessages(2740).map((m: any) => m.id)).toEqual([2740]);
    expect(compatV2GetChatMessages(2740).map((m: any) => m.id)).toEqual([2740]);
    // 卡脚本走的是这条链：getChatMessages(getCurrentMessageId())[0].message 不能为空
    expect(effective(2740)[0].message).toBe('一个极轻但充满不悦的音节……');
  });

  it('ST 下标语义仍按下标优先，行为不变', () => {
    const { legacyGetChatMessages, compatV2GetChatMessages } = buildFrameSurface(CHAT, 1);
    expect(legacyGetChatMessages(1).map((m: any) => m.id)).toEqual([2740]);
    expect(compatV2GetChatMessages(1).map((m: any) => m.id)).toEqual([2740]);
  });

  it('只有开场白（首屏，下标 0）：命中开场白本身', () => {
    const { legacyGetChatMessages } = buildFrameSurface([GREETING], 0);
    expect(legacyGetChatMessages(0).map((m: any) => m.id)).toEqual(['greeting-local']);
  });

  it('无参调用返回全量，两份一致', () => {
    const { legacyGetChatMessages, compatV2GetChatMessages, effective } = buildFrameSurface(CHAT, 2740);
    expect(legacyGetChatMessages()).toHaveLength(2);
    expect(compatV2GetChatMessages()).toHaveLength(2);
    expect(effective()).toHaveLength(2);
  });

  it('字符串 id 按 id 匹配（非数字分支不变）', () => {
    const { legacyGetChatMessages } = buildFrameSurface(CHAT, '2740');
    expect(legacyGetChatMessages('2740').map((m: any) => m.id)).toEqual([2740]);
  });

  it('真正不存在的 id 返回空数组（禁止改成兜底返回最后一条）', () => {
    const { legacyGetChatMessages, compatV2GetChatMessages } = buildFrameSurface(CHAT, 9999);
    expect(legacyGetChatMessages(9999)).toEqual([]);
    expect(compatV2GetChatMessages(9999)).toEqual([]);
  });
});
