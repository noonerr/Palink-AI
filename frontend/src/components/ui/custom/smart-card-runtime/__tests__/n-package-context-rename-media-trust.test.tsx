/*
 * 包N（2026-10-19）契约测试 —— B-2 window.context / B-3 renameChat 桥 /
 * B-1 沙箱 appendMediaToMessage 落库 / C-1 导入时信任提示（TOFU）。
 *
 * 四组都钉"行为 + 接线"两件事，理由：
 *   · 策略代码单测全绿 ≠ 接线生效（本项目已踩过多次）；
 *   · 每个补丁的红线都是"不许假成功"，所以失败路径必须有断言。
 *
 * ⚠️ 批次H（2026-10-20）订正：B-2 的帧内那一半**已撤** —— 包N 依据的「st-context.js 的
 * export const context」经核实不存在（该文件只有 export function getContext + export default），
 * 且用户裁定「冲突以 ST 为准」不摆这个全局。帧内断言随之**改判**为"定义已撤 + 顺序不回退"，
 * 不是删除；沙箱那一半不在批次H 范围，原样保留。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/n-package-context-rename-media-trust.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_BODY_PART_08 } from '../runtime-body/part-08';
import { handleSmartCardCompatRequest, renameSmartCardChatSession } from '../SmartCardCompatController';
import { detectCardScripts, CardScriptTrustPrompt } from '../import-trust-prompt';
import {
  clearSmartCardTrustOptIn,
  readSmartCardTrustOptIn,
  writeSmartCardTrustOptIn,
  getSmartCardTrustOptInKey,
} from '../storage';
import {
  appendStMessageMedia,
  buildStMediaAppendPlan,
  normalizeStMediaEntry,
  resolveStMessageIndex,
} from '@/lib/plugin-system/st-message-media';
import { COMPAT_V2_RUNTIME_ARTIFACT } from './compat-v2-runtime-source';

// ── api mock（控制器 renameChat 用；hoisted 才能被 vi.mock 工厂引用）──────
const apiMocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn() }));
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  const actualApi = (actual.api || {}) as unknown as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...actualApi,
      post: (...args: unknown[]) => apiMocks.post(...args),
      put: (...args: unknown[]) => apiMocks.put(...args),
    },
  };
});

const SANDBOX_SRC = readFileSync(
  join(process.cwd(), 'src/lib/plugin-system/sandbox.ts'),
  'utf8',
);
const CHAT_SRC = readFileSync(
  join(process.cwd(), 'src/components/views/character/CharacterChat.tsx'),
  'utf8',
);
const RENDERER_SRC = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
  'utf8',
);

// ============================================================
// A. B-2 window.context（帧内已撤 / 沙箱保留）
// ============================================================
describe('N-B2 window.context', () => {
  afterEach(() => {
    delete (window as any).context;
  });

  // 批次H 2026-10-20 改判（依据，勿当"为绿删断言"）：
  //   ① 一手核实：两棵 ST 1.18 树 + 酒馆助手插件全仓，window.context / globalThis.context
  //      0 命中；st-context.js 只有 export function getContext() 与 export default，
  //      **没有 export const context** ⇒ 包N B-2 注释里"ST 1.18 的 context 是 st-context.js
  //      里的一次性快照"是误读；ST 真实用法是文件内部 const context = getContext()（两树各 57 处）。
  //   ② 用户裁定（SPEC §2.1 / HANDOFF §0 第 4 条）：「与 ST 冲突以 ST 为准」⇒ 不摆这个全局。
  //   ③ 真机探针（:16000 露缇雅 7/7 帧）：每帧唯一记录 frame_compat:global_shape_absent:
  //      window.context 且 count=1，无任何 name='context' 的 error 轨记录 ⇒ 没有在跑的卡依赖它。
  // ⇒ 断言从"定义在场且是实时 getter"改判为"定义不在场 + 顺序不回退"，执行型证明一并跟上。
  it('帧内：window.context 定义已撤（批次H「冲突以 ST 为准」），原位置只留撤销注记', () => {
    const start = RUNTIME_BODY_PART_08.indexOf('window.getContext = getContextCompat;');
    const end = RUNTIME_BODY_PART_08.indexOf('// [S5-GDEP3 2026-10-16]');
    expect(start, 'window.getContext 赋值点未命中').toBeGreaterThan(-1);
    expect(end, 'B-2 插入点之后的 S5-GDEP3 标记未命中').toBeGreaterThan(start);

    const block = RUNTIME_BODY_PART_08.slice(start, end);
    // 顺序断言一：原位置（getContextCompat 赋值之后、S5-GDEP3 之前）不许再有定义本体。
    // 把 defineProperty 挪回这个区块 ⇒ 本断言红。
    expect(block).not.toContain("Object.defineProperty(window, 'context'");
    // 撤销注记必须在场（依据三件事钉在源码里，防止有人凭印象"补回来"）。
    expect(block).toContain('批次H 2026-10-20 撤销');
    // 顺序断言二：整段求值后载体（= 生产 iframe 逐字节同源）任何位置都不许出现该定义
    // ⇒ 挪到 part-08 别处或其它 part 同样红。
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain("Object.defineProperty(window, 'context'");

    // 执行型证明：用真实源码段求值后，window 上不得落下 context 描述符。
    const fake = { chat: [{ mes: 'hi' }], name1: 'User', characterId: 0 };
    // eslint-disable-next-line no-new-func
    new Function('getContextCompat', block)(() => fake);
    expect(Object.getOwnPropertyDescriptor(window, 'context')).toBeUndefined();
    expect(typeof (window as any).context).toBe('undefined');
  });

  it('沙箱：包装壳注入 var context，且 script.js 模块映射提供 context（否则 import 会覆盖成 undefined）', () => {
    expect(SANDBOX_SRC).toContain('var context = getContext();');
    // script.js 块里必须有 context getter（import { context } from 'script.js' 的落点）
    const scriptJsStart = SANDBOX_SRC.indexOf("'script.js': {");
    expect(scriptJsStart).toBeGreaterThan(-1);
    const block = SANDBOX_SRC.slice(scriptJsStart, scriptJsStart + 2500);
    expect(block).toMatch(/get context\(\)\s*\{/);
  });
});

// ============================================================
// B. B-3 renameChat 桥
// ============================================================
function makeRenameContext(overrides: Record<string, unknown> = {}) {
  return {
    selectedCharacterName: 'tester',
    selectedCharacterId: 'c1',
    selectedModel: 'm1',
    selectedSession: { id: 's1' },
    sessionId: null,
    branchId: null,
    wb: {},
    ...overrides,
  } as any;
}

describe('N-B3 renameChat', () => {
  beforeEach(() => {
    apiMocks.post.mockReset();
    apiMocks.put.mockReset();
  });

  it('请求契约逐字对齐宿主轨：{ file_name: palink-session-<id>, new_name, avatar_url }', async () => {
    apiMocks.post.mockResolvedValue({ result: 'ok' });
    const result = await renameSmartCardChatSession(makeRenameContext(), { title: '新名字' });
    expect(result).toEqual({ success: true, name: '新名字' });
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledWith('/api/chats/rename-session', {
      file_name: 'palink-session-s1',
      new_name: '新名字',
      avatar_url: 'palink-c1.png',
    });
  });

  it('无会话 / 空名 ⇒ success:false 且不发请求（不许假成功）', async () => {
    const noSession = await renameSmartCardChatSession(
      makeRenameContext({ selectedSession: null, sessionId: null }),
      { title: 'x' },
    );
    expect(noSession.success).toBe(false);
    expect(noSession.error).toBe('no_active_session');

    const emptyName = await renameSmartCardChatSession(makeRenameContext(), { title: '   ' });
    expect(emptyName.success).toBe(false);
    expect(emptyName.error).toBe('new_name_required');

    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it('后端失败 ⇒ success:false + 错误码（帧内据此回 false）', async () => {
    apiMocks.post.mockRejectedValue(new Error('Session not found'));
    const result = await renameSmartCardChatSession(makeRenameContext(), { title: '新名字' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });

  it('接线：request 动作 renameChat 落到该实现，respond 带回 success', async () => {
    apiMocks.post.mockResolvedValue({ result: 'ok' });
    const respond = vi.fn();
    await handleSmartCardCompatRequest({ worldBook: null } as any, makeRenameContext(), {
      type: 'request',
      requestId: 'r1',
      action: 'renameChat',
      payload: { title: '改名' },
      respond,
    } as any);
    expect(respond).toHaveBeenCalledTimes(1);
    const response = respond.mock.calls[0][0];
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ success: true, name: '改名' });
  });

  it('接线：失败时 respond.ok 仍为 true（通道成功）但 result.success 为 false', async () => {
    apiMocks.post.mockRejectedValue(new Error('boom'));
    const respond = vi.fn();
    await handleSmartCardCompatRequest({ worldBook: null } as any, makeRenameContext(), {
      type: 'request',
      requestId: 'r2',
      action: 'renameChat',
      payload: { title: '改名' },
      respond,
    } as any);
    const response = respond.mock.calls[0][0];
    expect(response.result.success).toBe(false);
  });

  it('帧内源码：改调 requestParent 且只认 success === true（不再有"未接通道"的 warn）', () => {
    const start = RUNTIME_BODY_PART_08.indexOf('const renameChatCompat = async');
    const end = RUNTIME_BODY_PART_08.indexOf('// #13 createCharacterData');
    const src = RUNTIME_BODY_PART_08.slice(start, end);
    expect(src).toContain("requestParent('renameChat'");
    expect(src).toContain('success === true');
    expect(src).not.toContain('未接会话改名通道');
  });

  it('帧内行为：父侧 success / false / 抛错 三种响应分别回 true / false / false', async () => {
    // 直接求值注入产物里的真实 renameChatCompat（不是重写副本）
    const start = RUNTIME_BODY_PART_08.indexOf('const renameChatCompat = async');
    const end = RUNTIME_BODY_PART_08.indexOf('// #13 createCharacterData');
    const src = RUNTIME_BODY_PART_08.slice(start, end);
    const build = (requestParent: unknown) => {
      // eslint-disable-next-line no-new-func
      const factory = new Function('requestParent', `${src}\nreturn renameChatCompat;`);
      return factory(requestParent) as (title?: unknown) => Promise<boolean>;
    };

    const calls: Array<{ action: string; payload: unknown }> = [];
    const ok = build(async (action: string, payload: unknown) => {
      calls.push({ action, payload });
      return { ok: true, success: true };
    });
    await expect(ok('新名字')).resolves.toBe(true);
    expect(calls).toEqual([{ action: 'renameChat', payload: { title: '新名字' } }]);
    await expect(ok('  ')).resolves.toBe(false);
    expect(calls).toHaveLength(1);

    const failed = build(async () => ({ ok: true, success: false, error: 'no_active_session' }));
    await expect(failed('新名字')).resolves.toBe(false);

    const thrown = build(async () => { throw new Error('rpc exploded'); });
    await expect(thrown('新名字')).resolves.toBe(false);
  });
});

// ============================================================
// C. B-1 appendMediaToMessage（沙箱轨）
// ============================================================
describe('N-B1 appendMediaToMessage', () => {
  const chat = [
    { mesid: 0, mes: 'hi', extra: {} },
    { mesid: 1, mes: 'hello', extra: { media: [] } },
  ];

  it('字符串 URL / {url} 对象 / 完整 MediaItem 都能归一化成 MediaItem 形状', () => {
    const fromUrl = normalizeStMediaEntry('/api/uploads/a.png');
    expect(fromUrl).toMatchObject({ status: 'ready', url: '/api/uploads/a.png' });
    expect(typeof fromUrl?.id).toBe('string');
    expect(fromUrl?.width).toBeGreaterThan(0);

    const fromObject = normalizeStMediaEntry({ url: '/x.png', prompt: 'p', seed: 7 });
    expect(fromObject).toMatchObject({ url: '/x.png', prompt: 'p', seed: 7 });

    const fromItem = normalizeStMediaEntry({ id: 'm_abc', status: 'pending', width: 512, height: 512 });
    expect(fromItem).toMatchObject({ id: 'm_abc', status: 'pending', url: null });
  });

  it('映射不出来一律 null（jQuery 元素 / 消息对象 / 空串 / 只有 id 的对象）', () => {
    expect(normalizeStMediaEntry({ 0: {}, length: 1 })).toBeNull();  // jQuery 形状
    expect(normalizeStMediaEntry({ mes: 'hi' })).toBeNull();          // 消息对象
    expect(normalizeStMediaEntry({ id: 'm_abc' })).toBeNull();        // 缺 status
    expect(normalizeStMediaEntry('   ')).toBeNull();
    expect(normalizeStMediaEntry(undefined)).toBeNull();
  });

  it('下标解析：mesid / 数字 / 对象身份 / 浅拷贝（send_date+mes）', () => {
    expect(resolveStMessageIndex({ mesid: 1 }, chat)).toBe(1);
    expect(resolveStMessageIndex(0, chat)).toBe(0);
    expect(resolveStMessageIndex(chat[1], chat)).toBe(1);
    expect(resolveStMessageIndex({ mes: 'hello', send_date: undefined }, chat)).toBe(1);
    expect(resolveStMessageIndex({ mesid: 99 }, chat)).toBe(-1);
    expect(resolveStMessageIndex({}, [])).toBe(-1);
  });

  it('第二参才是媒体来源；第二参缺省时才回退看第一参', () => {
    const withSecond = buildStMediaAppendPlan({ mesid: 0 }, '/api/uploads/a.png', chat);
    expect(withSecond.ok).toBe(true);
    if (withSecond.ok) {
      expect(withSecond.plan.index).toBe(0);
      expect(withSecond.plan.media.url).toBe('/api/uploads/a.png');
    }

    // 第一参是消息对象、第二参缺省 ⇒ 消息对象不是媒体 ⇒ 诚实失败
    const messageAsMedia = buildStMediaAppendPlan({ mesid: 0, mes: 'hi' }, undefined, chat);
    expect(messageAsMedia.ok).toBe(false);

    // 第一参直接是 URL（插件常见简写）
    const urlOnly = buildStMediaAppendPlan('/api/uploads/b.png', undefined, chat);
    expect(urlOnly.ok).toBe(false); // 找不到消息 ⇒ 失败（不猜最后一条）
  });

  it('落库：只有宿主明确 success === true 才回 true；缺桥/抛错/失败都回 false', async () => {
    const persistOk = vi.fn(async () => ({ success: true, media_index: 0 }));
    await expect(appendStMessageMedia({ mesOrId: { mesid: 0 }, mediaSource: '/a.png', chat, persist: persistOk }))
      .resolves.toBe(true);
    expect(persistOk).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));

    const persistFail = vi.fn(async () => ({ success: false, error: 'persist_failed' }));
    await expect(appendStMessageMedia({ mesOrId: { mesid: 0 }, mediaSource: '/a.png', chat, persist: persistFail }))
      .resolves.toBe(false);

    const persistThrows = vi.fn(async () => { throw new Error('boom'); });
    await expect(appendStMessageMedia({ mesOrId: { mesid: 0 }, mediaSource: '/a.png', chat, persist: persistThrows }))
      .resolves.toBe(false);

    // 宿主桥缺失（未注册）⇒ false，且不会尝试任何"猜测性"写入
    await expect(appendStMessageMedia({ mesOrId: { mesid: 0 }, mediaSource: '/a.png', chat }))
      .resolves.toBe(false);
  });

  it('接线：sandbox 空实现已被替换，且走 __palinkAppendMessageMedia 桥（不是 DOM、不是 applyStChatMessages）', () => {
    expect(SANDBOX_SRC).not.toContain('appendMediaToMessage: () => {}');
    const start = SANDBOX_SRC.indexOf('appendMediaToMessage: async');
    expect(start, 'sandbox 里 appendMediaToMessage 仍是空实现').toBeGreaterThan(-1);
    const block = SANDBOX_SRC.slice(start, start + 1800);
    expect(block).toContain('__palinkAppendMessageMedia');
    expect(block).toContain('appendStMessageMedia');
    expect(block).not.toContain('applyStChatMessages(');
  });

  it('接线：宿主桥存在且走 PUT 落库（内容取权威 content，不取 stripStyleBlocks 后的 mes）', () => {
    expect(CHAT_SRC).toContain('__palinkAppendMessageMedia');
    expect(CHAT_SRC).toContain('/messages/${dbId}');
    expect(CHAT_SRC).toContain('content: String(target.content');
    expect(CHAT_SRC).toContain("success: false, error: 'message_not_persisted'");
  });
});

// ============================================================
// D. C-1 导入时信任提示（TOFU）
// ============================================================
describe('N-C1 导入时信任提示', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('检测：纯文本卡 / 只有 <style> 的静态卡不弹（不打扰）', () => {
    expect(detectCardScripts({ first_mes: '你好呀，今天想聊什么？' }).executes).toBe(false);
    expect(detectCardScripts({ first_mes: '<style>.a{color:red}</style><div class="a">hi</div>' }).executes).toBe(false);
    expect(detectCardScripts(null).executes).toBe(false);
  });

  it('检测：tavern_helper 脚本 / 首条消息里的 <script> / 内联 on* / regex 注入 HTML 都会弹', () => {
    expect(detectCardScripts({
      extensions: { tavern_helper: { scripts: [{ type: 'script', content: 'console.log(1)' }] } },
    })).toMatchObject({ executes: true, reasons: ['tavern_helper_scripts'] });

    expect(detectCardScripts({ first_mes: '<html><body><script>alert(1)</script></body></html>' }).executes).toBe(true);
    expect(detectCardScripts({ first_mes: '<button onclick="doThing()">点我</button>' }).executes).toBe(true);
    expect(detectCardScripts({
      alternate_greetings: ['<script src="https://cdn/x.js"></script>'],
    }).executes).toBe(true);
    expect(detectCardScripts({
      extensions: { regex_scripts: [{ replaceString: '<div id="status"><script>render()</script></div>' }] },
    }).executes).toBe(true);
    // 禁用状态的 regex 不算
    expect(detectCardScripts({
      extensions: { regex_scripts: [{ disabled: true, replaceString: '<script>x()</script>' }] },
    }).executes).toBe(false);
  });

  it('optin 语义：pending 首次采纳当前指纹；指纹变了即失效；clear 后不再授信', () => {
    const key = getSmartCardTrustOptInKey('c1');
    expect(readSmartCardTrustOptIn('c1', 'fp-A')).toBe(false);

    writeSmartCardTrustOptIn('c1');
    expect(JSON.parse(window.localStorage.getItem(key)!).pending).toBe(true);
    expect(readSmartCardTrustOptIn('c1', 'fp-A')).toBe(true);
    // 采纳后绑定到 fp-A
    expect(JSON.parse(window.localStorage.getItem(key)!).fingerprint).toBe('fp-A');
    expect(readSmartCardTrustOptIn('c1', 'fp-A')).toBe(true);
    // 卡内容改了（指纹变）⇒ 信任自动失效
    expect(readSmartCardTrustOptIn('c1', 'fp-B')).toBe(false);

    clearSmartCardTrustOptIn('c1');
    expect(readSmartCardTrustOptIn('c1', 'fp-A')).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('optin 用独立新键，不复用会话级 grant 键（cid:fingerprint + sessionStorage + TTL）', () => {
    expect(getSmartCardTrustOptInKey('c1')).toBe('palink:card-trust-optin:v1:c1');
    writeSmartCardTrustOptIn('c1');
    // 只写 localStorage，不碰 sessionStorage 的 grant 键
    expect(window.sessionStorage.length).toBe(0);
    expect(readSmartCardTrustOptIn('c1', 'fp-A')).toBe(true);
  });

  it('渲染器接线：信任解析是三级（mode / grant / optin），撤销同时清 optin', () => {
    expect(RENDERER_SRC).toContain('readSmartCardTrustOptIn(context.characterId, sourceFingerprint)');
    expect((RENDERER_SRC.match(/readSmartCardTrustOptIn\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(RENDERER_SRC).toContain('if (!nextTrusted) clearSmartCardTrustOptIn(context.characterId);');
  });

  it('P1-1 红线：未授信卡的 sandbox 属性未变（仍只有 allow-scripts + 能力令牌）', () => {
    // 注意：这些是**源码字面量**断言，用单引号包住，避免模板字符串插值。
    expect(RENDERER_SRC).toContain('? `allow-scripts allow-same-origin ${CAPABILITY_TOKENS}`');
    expect(RENDERER_SRC).toContain(': `allow-scripts ${CAPABILITY_TOKENS}`;');
  });

  it('提示组件：点"信任"只回调 onAccept、点"暂不信任"/遮罩只回调 onSkip（组件本身不写存储）', async () => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    const onAccept = vi.fn();
    const onSkip = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(
        <CardScriptTrustPrompt
          text={{ title: 't', body: 'b', accept: 'a', skip: 's' }}
          characterName="露缇雅"
          onAccept={onAccept}
          onSkip={onSkip}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-palink-card-trust-prompt="1"]')).toBeTruthy();
    await act(async () => {
      container.querySelector('[data-palink-card-trust-prompt-choice="accept"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(0);

    await act(async () => {
      container.querySelector('[data-palink-card-trust-prompt-choice="skip"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSkip).toHaveBeenCalledTimes(1);

    // 组件不碰存储
    expect(window.localStorage.length).toBe(0);

    await act(async () => { root?.unmount(); });
    container.remove();
  });
});
