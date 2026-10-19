/*
 * 包 Z 批次三 · `registerMacroLike` / `unregisterMacroLike`（macro_register，1 键）
 *
 * 契约来源（一手，不是 ST 核心）：`stopGenerationById` / `registerMacroLike` 这些键不在
 * ST 1.18.0 里（`grep -rn "getAliases\|stopGenerationById\|registerMacroLike"
 * _reference/sillytavern-1.18.0/public/` 全无命中），它们是**酒馆助手（JS-Slash-Runner）**的 API，
 * 权威签名在 `st-plugins/third-party/JS-Slash-Runner-main/@types/function/`：
 *   macro_like.d.ts:27-31  registerMacroLike(regex, replace) -> { unregister }
 *   macro_like.d.ts:37     unregisterMacroLike(regex)
 *   macro_like.d.ts:4-7    MacroLikeContext = { message_id?, role? }
 *   generate.d.ts:216      stopGenerationById(generation_id: string): boolean（本包未实现，见报告）
 *
 * 求值对象：`runtime-body/part-03.ts` 里从 macroRegistryCompat 到 parseMaybeJsonObject
 * 的**真源码**（COMPAT_V2_RUNTIME_ARTIFACT 切片），外部依赖（ctx / compatChat /
 * chatVariableStore / globalVariableStore / post / getByPath / window）由测试注入。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/z-package-macro-register.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';

function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `from not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `to not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

type Frame = {
  substituteParams: (content: string, options?: any) => string;
  registerMacroLike: (regex: RegExp, replace: (...a: any[]) => string) => { unregister: () => void };
  unregisterMacroLike: (regex: RegExp) => boolean;
  call: (name: string, ...args: any[]) => any;
};

/** 把 part-03 的宏表 + macro-like 表 + substituteParamsCompat 原样求值出来。 */
function buildFrame() {
  const region = sliceBetween(
    SRC,
    'const macroRegistryCompat = new Map();',
    'const parseMaybeJsonObject = (value, fallback = {}) => {',
  );
  const posted: Array<{ type: string; message: string }> = [];
  const calls: string[] = [];
  const ctx: any = { messageId: 1, userName: 'User', characterName: 'Aster' };
  const compatChat: any[] = [
    { message_id: 0, is_user: true, mes: '早上好' },
    { message_id: 1, name: 'Aster', mes: '晚安 {{user}}', role: 'assistant' },
  ];
  const windowStub: any = { selected_group: '' };
  const getByPath = (source: any, path: string, fallback?: any) => {
    const parts = String(path || '').split('.');
    let cursor: any = source;
    for (const part of parts) {
      if (cursor == null || !Object.prototype.hasOwnProperty.call(cursor, part)) return fallback;
      cursor = cursor[part];
    }
    return cursor;
  };
  const factory = new Function(
    'window', 'ctx', 'compatChat', 'chatVariableStore', 'globalVariableStore', 'post', 'getByPath',
    `${region}
return {
  substituteParams: substituteParamsCompat,
  registerMacroLike: registerMacroLikeCompat,
  unregisterMacroLike: unregisterMacroLikeCompat,
  call: (name) => name,
};`,
  );
  const built = factory(
    windowStub, ctx, compatChat, {}, {}, (entry: any) => posted.push(entry), getByPath,
  ) as Frame & { };
  const wrapped: Frame = {
    ...built,
    call: (name: string, ...args: any[]) => { calls.push(name); return (built as any)[name](...args); },
  };
  return { frame: wrapped, posted, calls, ctx, compatChat };
}

describe('macro_register · 注册即生效（正则式助手宏）', () => {
  it('注册的正则宏对替换后的正文生效，并拿到 (context, substring, ...分组)', () => {
    const { frame } = buildFrame();
    const seen: any[] = [];
    frame.registerMacroLike(/<count>(.*?)<\/count>/gi, (context, substring, inner) => {
      seen.push({ context, substring, inner });
      return `共${String(inner ?? '').length}字`;
    });
    const out = frame.substituteParams('前<count>你好</count>后');
    expect(out).toBe('前共2字后');
    expect(seen).toHaveLength(1);
    expect(seen[0].substring).toBe('<count>你好</count>');
    expect(seen[0].inner).toBe('你好');
    // MacroLikeContext 形状（macro_like.d.ts:4-7）
    expect(seen[0].context.message_id).toBe(1);
    expect(seen[0].context.role).toBe('assistant');
  });

  it('返回 { unregister }，调用后同一正则不再生效', () => {
    const { frame } = buildFrame();
    const handle = frame.registerMacroLike(/abc/g, () => 'X');
    expect(frame.substituteParams('abc')).toBe('X');
    handle.unregister();
    expect(frame.substituteParams('abc')).toBe('abc');
  });

  it('unregisterMacroLike(regex) 同 source+flags 即注销（新构造的同式正则也认）', () => {
    const { frame } = buildFrame();
    frame.registerMacroLike(/xyz/g, () => 'Y');
    expect(frame.substituteParams('axyz')).toBe('aY');
    expect(frame.unregisterMacroLike(new RegExp('xyz', 'g'))).toBe(true);
    expect(frame.substituteParams('axyz')).toBe('axyz');
    // 注销不存在的正返回 false（不假成功）
    expect(frame.unregisterMacroLike(/nope/g)).toBe(false);
  });

  it('与 {{name}} 宏表是两张独立的表：花括号先被消耗，正则宏看到的是替换后的正文', () => {
    const { frame } = buildFrame();
    // {{}} 先生效（内置宏 user=User），正则宏拿到的输入里已经没有花括号
    frame.registerMacroLike(/User/g, () => '(被正则宏接管)');
    expect(frame.substituteParams('你好 {{user}}')).toBe('你好 (被正则宏接管)');
  });

  it('{{}} 替换发生在正则宏之前（顺序可预期）', () => {
    const { frame } = buildFrame();
    frame.registerMacroLike(/Aster/g, (_c, text) => `[${text}]`);
    expect(frame.substituteParams('你好 {{char}}！')).toBe('你好 [Aster]！');
  });

  it('多个正则宏按注册顺序依次应用', () => {
    const { frame } = buildFrame();
    frame.registerMacroLike(/a/g, () => 'b');
    frame.registerMacroLike(/b/g, () => 'c');
    expect(frame.substituteParams('a')).toBe('c');
  });
});

describe('macro_register · 不假成功（红线）', () => {
  it('regex 不是 RegExp 时不注册、抛错留痕、返回空操作手柄', () => {
    const { frame, posted } = buildFrame();
    const handle = frame.registerMacroLike('not-a-regex' as any, () => 'x');
    expect(typeof handle.unregister).toBe('function');
    handle.unregister();
    expect(frame.substituteParams('not-a-regex')).toBe('not-a-regex');
    expect(posted.some((p) => p.type === 'error')).toBe(true);
  });

  it('replace 不是函数时不注册', () => {
    const { frame, posted } = buildFrame();
    const handle = frame.registerMacroLike(/q/g, undefined as any);
    expect(typeof handle.unregister).toBe('function');
    expect(frame.substituteParams('q')).toBe('q');
    expect(posted.some((p) => p.type === 'error')).toBe(true);
  });

  it('替换回调抛错时不把整个正文吞掉，留痕并原样保留匹配文本', () => {
    const { frame, posted } = buildFrame();
    frame.registerMacroLike(/boom/g, () => { throw new Error('callback blew up'); });
    expect(frame.substituteParams('x-boom-y')).toBe('x-boom-y');
    expect(posted.some((p) => p.message.indexOf('boom') >= 0 || p.type === 'error')).toBe(true);
  });

  it('message_id / role 来自当前消息（ctx.messageId 命中不到时退回末条）', () => {
    const { frame, ctx } = buildFrame();
    ctx.messageId = 999;
    let got: any = null;
    frame.registerMacroLike(/hit/g, (context) => { got = context; return 'H'; });
    frame.substituteParams('hit');
    expect(got.message_id).toBe(999);
    expect(got.role).toBe('assistant');
  });
});
