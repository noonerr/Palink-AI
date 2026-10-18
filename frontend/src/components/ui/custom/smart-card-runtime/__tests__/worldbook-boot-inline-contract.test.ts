/*
 * 世界书名「构建期内联」契约测试（三轨并一轨 · S1 · G7）
 *
 * 问题：帧内世界书 API 是**同步**的（ST 契约），但帧内数据在父侧、桥是**异步**的
 * ⇒ 首次同步调用必然拿不到值。而真机 MVU 只在模块顶层读一次：
 *
 *   const e = getCharWorldbookNames('current').primary ?? 'unknown';   // 一次赋值，等不起
 *   i.initialized_lorebooks[e] = [];                                   // primary 为 null ⇒ 键退化成 'unknown'
 *   try { this.worldbook_name = getCharWorldbookNames('current').primary }  // 站点 2：null ⇒ mirrorState 整段跳过
 *
 * 解法：在 srcdoc **构建期**把会话绑定的世界书名内联进 shim（父侧 wb.sessionStatus.world_book_name
 * 随聊天加载，早于卡片渲染），使同步 API 首帧即有值。
 *
 * ⚠️ 为什么只能靠内联、不能靠 postMessage：`CharacterCardRenderer.tsx:471` 的 srcDoc useMemo
 *    刻意把 context 签名排除在依赖外（晚到 context 不得触发整页重建），所以晚到的世界书名
 *    永远进不了该帧 srcdoc —— 只能"首帧有就内联"。
 *
 * 注意：本文件**不改** getcharworldbooknames-contract.test.ts:171（它钉「空绑定返回
 * { primary: null }」）。本实现保持该行为（内联值为空时仍返回 null），故那条用例无需改动。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/worldbook-boot-inline-contract.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';
import { buildShim } from '../helpers';
// [S4 2026-10-15] 运行时体已按行拆到 runtime-body/part-01..08.ts，改为读拼接后的源码文本。
// [包L 2026-10-18] 两个载体各按语义取用：
//   · COMPAT_V2_ARTIFACT = 求值后产物（生产 iframe 逐字节同源）⇒ 帧内那两行断言用它；
//   · COMPAT_V2_SOURCE   = 未求值源码文本 ⇒ 只用于 TS 侧 boot payload 白名单
//     （`buildSmartCardCompatRuntimeBootPayload` 是宿主 TS 代码，不在注入产物里）。
import {
  COMPAT_V2_RUNTIME_SOURCE as COMPAT_V2_SOURCE,
  COMPAT_V2_RUNTIME_ARTIFACT as COMPAT_V2_ARTIFACT,
} from './compat-v2-runtime-source';

const SEED_PATTERN = /let activeWorldbookName = String\(\(ctx && ctx\.worldbookName\) \|\| ''\);/;

/** 从 marker 起花括号配平，原样切出一段代码。 */
function sliceBraceBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  expect(i, `no '{' after marker: ${marker}`).toBeGreaterThan(-1);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

// ============================================================
// A 两个 shim 构建器都必须把 worldbookName 序列化进 boot context
// ============================================================
describe('A boot context 内联 —— 两个构建器都要带上 worldbookName', () => {
  it('[红→S1 转绿] buildShim（legacy 段）把会话世界书名内联进 ctx', () => {
    const out = buildShim(
      { characterId: 'c1', characterName: '桃汐', userName: '用户', worldbookName: '会话世界书' } as any,
      'frame-1',
    );
    expect(out).toContain('"worldbookName":"会话世界书"');
  });

  it('[红→S1 转绿] buildSillyTavernCompatRuntimeV2Shim（compatV2 段）同样内联', () => {
    // 只断言源码层面的 contextJson 白名单含该字段（构建器依赖 esbuild 打包环境，不便直接跑）
    // [包L] 这一条判的是宿主 TS 侧 `buildSmartCardCompatRuntimeBootPayload` 的字段白名单，
    // 它在**注入产物之外**（产物里只剩序列化结果），所以只能用未求值源码载体。
    expect(COMPAT_V2_SOURCE).toMatch(/worldbookName: context\.worldbookName \|\| ''/);
  });

  it('[红→S1 转绿] worldbookName 缺省时序列化为空串（不是 undefined、不炸）', () => {
    const out = buildShim(
      { characterId: 'c1', characterName: '桃汐', userName: '用户' } as any,
      'frame-1',
    );
    expect(out).toContain('"worldbookName":""');
  });
});

// ============================================================
// B 两处 seed 存在（回归钉：只内联不消费 = 白做）
// ============================================================
describe('B seed 消费 —— 内联值必须真的被帧内缓存采纳', () => {
  it('[红→S1 转绿] legacy-st-sim 的 activeWorldbookName 以 ctx.worldbookName 为初值', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toMatch(SEED_PATTERN);
  });

  it('[红→S1 转绿] SillyTavernCompatRuntime 的 activeWorldbookName 同样以 ctx.worldbookName 为初值', () => {
    // [包L] 断言对象是**注入 iframe 的求值后产物**（宿主真正跑的那份），不是源码文本。
    expect(COMPAT_V2_ARTIFACT).toMatch(SEED_PATTERN);
  });

  it('[回归钉] 内联源必须是角色 character_book，不是 sessionStatus（真机实测后者恒空）', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/views/character/CharacterChat.tsx'),
      'utf8',
    );
    // 真机实证：被测会话 session_world_books 为 0 行 ⇒ world_book_name 恒 undefined，内联白做。
    // 断言精确到**赋值形态**，避免匹配到解释这件事的注释本身。
    expect(src).not.toContain('characterWorldbookName={wb.sessionStatus?.world_book_name}');
    expect(src).toContain("book?.type === 'character_book'");
  });
});

// ============================================================
// C 行为级：seed + 真实 getCharWorldbookNamesCompat 连起来，首次同步调用即返回内联名
// ============================================================
describe('C 行为级 —— 内联后首次同步调用就拿到真名（不再退化成 unknown）', () => {
  function buildWithSeed(segment: string, ctxWorldbookName: string) {
    const seedMatch = segment.match(SEED_PATTERN);
    expect(seedMatch, 'seed not found in segment').not.toBeNull();
    const body = sliceBraceBlock(segment, 'const getCharWorldbookNamesCompat = () => {');
    const requestParent = vi.fn(async () => ({ success: true, name: '' }));   // 冷缓存自热返回空，模拟"父侧还没准备好"
    const post = vi.fn(() => undefined);
    const fn = new Function(
      'ctx', 'worldbookNamesWarmStarted', 'requestParent', 'post',
      `${seedMatch![0]}\n${body}\nreturn getCharWorldbookNamesCompat;`,
    )({ worldbookName: ctxWorldbookName }, false, requestParent, post);
    return fn as () => any;
  }

  it('[红→S1 转绿] 内联名存在 ⇒ 首次调用返回它（真机 MVU 的 .primary ?? unknown 不再是 unknown）', () => {
    const fn = buildWithSeed(LEGACY_ST_SIM_SEGMENT, '会话世界书');
    const out = fn();
    expect(out.primary).toBe('会话世界书');
    expect(out.additional).toEqual(['会话世界书']);
    // 有内联值就不该再发一轮冷缓存 RPC
    expect(typeof out.then).toBe('undefined');
  });

  it('[绿] 内联名为空 ⇒ 仍返回 { primary: null, additional: [] }（保持 T1 契约，:171 无需改）', () => {
    const fn = buildWithSeed(LEGACY_ST_SIM_SEGMENT, '');
    expect(fn()).toEqual({ primary: null, additional: [] });
  });
});
