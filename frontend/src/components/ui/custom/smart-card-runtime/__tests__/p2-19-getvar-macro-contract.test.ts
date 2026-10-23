/*
 * P2-19 · `{{getvar::name}}` / `{{getglobalvar::name}}` 宏契约
 *
 * 上游口径（ST 1.18，d:\SillyTavern-release）：
 *   · `{{getvar::x}}` 取**当前聊天**变量，取不到再落到**全局**变量；都没有 → 空串
 *   · `{{getglobalvar::x}}` 只认全局变量；没有 → 空串
 *   · 分隔符 `::` 与空格两种写法都认
 *   · **没有** `getlocalvar` 宏（上游只有 `/getlocalvar` 斜杠命令），本运行时也不提供
 * 改动前：`{{getvar::hp}}` 原样返回（既不是值也不是空串）。
 *
 * 载体：COMPAT_V2_RUNTIME_ARTIFACT（**求值后**、与生产 iframe 逐字节一致的脚本），
 * 只切 part-03 的宏表 → substituteParamsCompat 区段，外部依赖（ctx / compatChat /
 * chatVariableStore / globalVariableStore / post / getByPath / window）由测试注入。
 * getByPath 桩照抄 variables-compat.ts 的真实实现（含「空 path 回退成整个 store」这条，
 * 用来盯住空变量名不许把 [object Object] 漏出来）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/p2-19-getvar-macro-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
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
};

function buildFrame(
  chatStore: Record<string, any> = {},
  globalStore: Record<string, any> = {},
) {
  const region = sliceBetween(
    SRC,
    'const macroRegistryCompat = new Map();',
    'const parseMaybeJsonObject = (value, fallback = {}) => {',
  );
  const posted: Array<{ type: string; message: string }> = [];
  const ctx: any = { messageId: 1, userName: 'User', characterName: 'Aster' };
  const compatChat: any[] = [
    { message_id: 0, is_user: true, mes: '早上好' },
    { message_id: 1, name: 'Aster', mes: '晚安 {{user}}', role: 'assistant' },
  ];
  const windowStub: any = { selected_group: '' };
  // 与 variables-compat.ts 的 VARIABLES_COMPAT_SOURCE / getByPathCompat 同义
  const getByPath = (source: any, path: string, fallback?: any) => {
    if (!path) return source ?? fallback;
    const parts = String(path).split('.').filter(Boolean);
    let value = source;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return fallback;
      value = value[part];
    }
    return value === undefined ? fallback : value;
  };
  // part-05 的 resolveMessageIndex（getMessageMacroValueCompat 依赖它，不在切片范围内）
  const resolveMessageIndex = (messageId: any = ctx.messageId) => {
    const byId = compatChat.findIndex(
      (m) => String(m.id) === String(messageId) || String(m.message_id) === String(messageId),
    );
    if (byId >= 0) return byId;
    const asIndex = Number(messageId);
    if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < compatChat.length) return asIndex;
    return compatChat.length > 0 ? compatChat.length - 1 : 0;
  };
  const factory = new Function(
    'window', 'ctx', 'compatChat', 'chatVariableStore', 'globalVariableStore', 'post', 'getByPath',
    'resolveMessageIndex',
    `${region}
return { substituteParams: substituteParamsCompat };`,
  );
  const built = factory(
    windowStub, ctx, compatChat, chatStore, globalStore,
    (entry: any) => posted.push(entry), getByPath, resolveMessageIndex,
  ) as Frame;
  return { frame: built, posted, ctx, compatChat, chatStore, globalStore };
}

describe('P2-19 · getvar / getglobalvar 作用域取变量', () => {
  it('{{getvar::hp}} 取到 chat 变量（:: 分隔）', () => {
    const { frame } = buildFrame({ hp: 42 }, { hp: 'global-hp', g: '全局值' });
    expect(frame.substituteParams('血量 {{getvar::hp}}')).toBe('血量 42');
  });

  it('{{getvar hp}} 空格分隔同样生效（上游两种都认）', () => {
    const { frame } = buildFrame({ hp: 42 }, {});
    expect(frame.substituteParams('血量 {{getvar hp}}')).toBe('血量 42');
  });

  it('{{getvar::hp}} chat 优先于 global', () => {
    const { frame } = buildFrame({ hp: 42 }, { hp: 'global-hp' });
    expect(frame.substituteParams('{{getvar::hp}}')).toBe('42');
  });

  it('{{getvar::missing}} → 空串（不是原样返回，也不是 undefined）', () => {
    const { frame, posted } = buildFrame({ hp: 42 }, { g: '全局值' });
    expect(frame.substituteParams('前{{getvar::missing}}后')).toBe('前后');
    expect(posted.filter((p) => p.type === 'error')).toHaveLength(0);
  });

  it('{{getglobalvar::g}} 取到全局变量（chat 有同名也不串）', () => {
    const { frame } = buildFrame({ g: 'chat-g' }, { g: '全局值' });
    expect(frame.substituteParams('{{getglobalvar::g}}')).toBe('全局值');
  });

  it('{{getglobalvar::missing}} → 空串', () => {
    const { frame } = buildFrame({ g: 'chat-g' }, { g: '全局值' });
    expect(frame.substituteParams('[{{getglobalvar::missing}}]')).toBe('[]');
  });

  it('变量名走 getByPath：点号路径可读嵌套值', () => {
    const { frame } = buildFrame({ stats: { hp: 7 } }, { world: { name: 'Palink' } });
    expect(frame.substituteParams('{{getvar::stats.hp}}/{{getglobalvar::world.name}}')).toBe('7/Palink');
  });

  it('空变量名不得漏出整个 store（getByPath 空 path 会回退成 store 对象）', () => {
    const { frame } = buildFrame({ hp: 42 }, { g: '全局值' });
    const out = frame.substituteParams('[{{getvar::}}][{{getglobalvar::}}]');
    expect(out).toBe('[][]');
    expect(out).not.toContain('[object Object]');
  });

  it('上游没有 getlocalvar 宏：不得被本实现接管', () => {
    const { frame } = buildFrame({ hp: 42 }, { g: '全局值' });
    // 未实现 → 走兜底 return rawMatch（保留原文）
    expect(frame.substituteParams('{{getlocalvar::hp}}')).toBe('{{getlocalvar::hp}}');
  });
});

describe('P2-19 · 既有行为不受影响', () => {
  it('{{x}} 直读 chat / global 变量仍工作', () => {
    const { frame } = buildFrame({ x: '直读chat' }, { y: '直读global' });
    expect(frame.substituteParams('{{x}}-{{y}}')).toBe('直读chat-直读global');
  });

  it('内置宏（{{user}} / {{char}}）仍优先于变量', () => {
    const { frame } = buildFrame({ user: '变量里的user' }, {});
    expect(frame.substituteParams('{{user}}/{{char}}')).toBe('User/Aster');
  });

  it('未闭合的花括号不当作宏，原样保留', () => {
    const { frame } = buildFrame({ hp: 42 }, {});
    expect(frame.substituteParams('{{getvar::hp')).toBe('{{getvar::hp');
    expect(frame.substituteParams('getvar::hp}}')).toBe('getvar::hp}}');
  });

  it('未知宏仍原样保留（不被空串吃掉）', () => {
    const { frame } = buildFrame({ hp: 42 }, {});
    expect(frame.substituteParams('{{nope}}/{{getvarx::hp}}')).toBe('{{nope}}/{{getvarx::hp}}');
  });

  it('message 宏与 getvar 共存', () => {
    const { frame } = buildFrame({ hp: 3 }, {});
    expect(frame.substituteParams('{{mes}}|{{getvar::hp}}')).toBe('晚安 {{user}}|3');
  });
});
