/*
 * inline 渲染 flag 已废 —— 契约守卫（三轨并一轨 · S1 · T3 / G3）
 *
 * 背景：智能卡曾有**三套执行面**——大堂轨（主页面直注）、单间轨（iframe）、
 * 以及 inline 轨（InlineCardRenderer 把卡片脚本直接跑在主页面全局，无 iframe 隔离）。
 * 并轨的目标是不可信代码一律进 iframe + 统一 postMessage 桥，inline 是绕过这条路的一个口子。
 *
 * B3 拍板（① 强制关闭 inline flag）：不是"把开关调到 off"，而是**把开关废掉**——
 * 留着 localStorage 项就留着"有人翻开就出现第三个执行面"的可能。
 *
 * 实测前提（推翻"inline 是活的生产路径"的说法，见 REPORT_S0完工自检_B1-B9 的 B3 节）：
 *   Message.tsx 走 inline 需 shouldUseInlineCardRendering() 为真，而它 =
 *   isInlineCardRenderingEnabled() && isInlineCardSafeEnv()，前者默认恒 false
 *   （需显式 localStorage 置 '1'）⇒ 线上本就统一走 iframe，废掉的代价 ≈ 0。
 *
 * 本文件钉住：
 *   ① inline-flags.ts 已删除，且 src 下无任何模块 import 它（防复活）；
 *   ② Message.tsx 不再按 flag 分流，智能卡渲染组件恒为 CharacterCardRenderer(iframe)；
 *   ③ flag 的 localStorage 键字面量已从源码消失（设了也不起作用）；
 *   ④ InlineCardRenderer.tsx **仍在**（S5 才删）——提前删会让 Message.tsx 的
 *      类型 import 悬空；它删的时候必须连带处理 inline-script-replay.ts。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/inline-flag-retired-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// vitest 固定以 frontend/ 为 cwd 运行
const SRC_ROOT = join(process.cwd(), 'src');
const MESSAGE_SOURCE = readFileSync(
  join(SRC_ROOT, 'components/ui/custom/Message.tsx'),
  'utf8',
);
const RETIRED_FLAG_FILE = join(
  SRC_ROOT,
  'components/ui/custom/smart-card-runtime/inline/inline-flags.ts',
);
const INLINE_RENDERER_FILE = join(SRC_ROOT, 'components/ui/custom/InlineCardRenderer.tsx');

/** 收集 src 下所有 .ts/.tsx（排除 __tests__，测试自身不算生产引用）。 */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...collectSources(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ALL_SOURCES = collectSources(SRC_ROOT);

// ============================================================
// A1 flag 本体已废
// ============================================================
describe('A1 inline flag 本体已废（B3 拍板 ①）', () => {
  it('[红→S1 转绿] inline-flags.ts 已不存在', () => {
    expect(existsSync(RETIRED_FLAG_FILE)).toBe(false);
  });

  it('[红→S1 转绿] src 下没有任何模块 import inline-flags（防复活）', () => {
    const offenders = ALL_SOURCES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /from\s+['"][^'"]*inline-flags['"]/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('[红→S1 转绿] flag 的 localStorage 键字面量已不可读（设了也不起作用）', () => {
    // 只认**引号内**的字面量：注释里提到这个键名是合法且必要的（说明它为何被废），
    // 但一旦有代码真的拿它去 getItem/setItem，就会被这里抓住。
    const offenders = ALL_SOURCES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /['"]palink_inline_card_(rendering|force)['"]/.test(text)
        || /localStorage\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*['"]palink_inline_card_/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('[红→S1 转绿] INLINE_CARD_FLAG_KEY / INLINE_CARD_FORCE_KEY 标识符已消失', () => {
    const offenders = ALL_SOURCES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /\bINLINE_CARD_(FLAG|FORCE)_KEY\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

// ============================================================
// A2 渲染路径收口：恒走 CharacterCardRenderer(iframe)
// ============================================================
describe('A2 智能卡渲染路径收口到 iframe', () => {
  it('[红→S1 转绿] Message.tsx 不再按 shouldUseInlineCardRendering 分流', () => {
    expect(MESSAGE_SOURCE).not.toContain('shouldUseInlineCardRendering');
  });

  it('[红→S1 转绿] SmartCardComponent 恒为 CharacterCardRenderer', () => {
    expect(MESSAGE_SOURCE).toMatch(/const SmartCardComponent = CharacterCardRenderer\b/);
  });

  it('[红→S1 转绿] Message.tsx 不再把 InlineCardRenderer 当值导入（只留 props 类型）', () => {
    // 值导入形如 `import { InlineCardRenderer, type ... }`；类型导入 `InlineCardRendererProps`
    // 不会被本正则命中（其后紧跟字母，\b 不成立）。
    expect(MESSAGE_SOURCE).not.toMatch(/import\s*\{[^}]*\bInlineCardRenderer\s*[,}]/);
    expect(MESSAGE_SOURCE).toMatch(/import\s+type\s*\{[^}]*InlineCardRendererProps/);
  });
});

// ============================================================
// A3 S5 的连带项：InlineCardRenderer 现在还不能删
// ============================================================
describe('A3 InlineCardRenderer 保留到 S5（提前删会悬空）', () => {
  it('[绿] InlineCardRenderer.tsx 仍在（Message.tsx 的 props 类型来自它）', () => {
    expect(existsSync(INLINE_RENDERER_FILE)).toBe(true);
  });

  it('[绿] inline-script-replay.ts 仍在 —— S5 删它必须连带处理 InlineCardRenderer.tsx 的 import', () => {
    const replayFile = join(
      SRC_ROOT,
      'components/ui/custom/smart-card-runtime/inline/inline-script-replay.ts',
    );
    expect(existsSync(replayFile)).toBe(true);
    const rendererSource = readFileSync(INLINE_RENDERER_FILE, 'utf8');
    expect(rendererSource).toMatch(/from\s+['"][^'"]*inline-script-replay['"]/);
  });
});
