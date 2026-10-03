/*
 * [A-6] 经典轨 window.setExtensionPrompt 全局真实现契约测试
 *
 * 验证:
 *   1. sillyTavernPluginRuntime.ts 的注入脚本（setupScript）提供全局
 *      window.setExtensionPrompt（入参校验 + 转发到 __palinkSetExtensionPrompt 桥）。
 *   2. 桥接在 TS 侧注册到 prompt-injection 服务（与沙箱轨同源），注册项经
 *      getPromptsForGeneration() 供 chat 装配消费（useCharacterChat:1161）。
 *
 * 运行: npx vitest run
 */

// ============================================================
// 导入待测模块
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  promptInjection,
  setActivePromptCharacter,
  getActivePromptCharacter,
} from '@/services/prompt-injection';

// getContext 的依赖图很大（.css 副作用导入 + showdown/dompurify/jquery/select2/toastr），
// 冷启动转译在全量并行时能超过 vitest 默认的 5s 用例超时（实测该用例在满载下 flake）。
// 把动态导入提到模块顶层（与 getcontext-parity.test.ts 同款写法），让这份成本落在收集阶段，
// 而不是落在被计时的用例体内 —— 该用例断言的是 extensionPrompts 别名，不是导入耗时。
const { getContext } = await import('@/lib/sillytavern/getContext');

const _here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SOURCE = readFileSync(path.resolve(_here, '../sillyTavernPluginRuntime.ts'), 'utf-8');

// ============================================================
// A. 源码级静态断言（防结构性回退）
// ============================================================
describe('A-6 Static Wiring', () => {
  it('runtime imports promptInjection service', () => {
    // [B4-SHARED-PARTITION] 导入列表从单符号变多符号（B4 引入
    // activeSandboxPartitionKey 用于分区键归属），故改为匹配 import 语句前缀，
    // 避免以后再加符号时又假红。守卫的是「runtime 确实引入了这个服务」。
    expect(RUNTIME_SOURCE).toMatch(/import \{[^}]*promptInjection[^}]*\} from '@\/services\/prompt-injection'/);
  });

  it('setupScript defines global window.setExtensionPrompt with input validation', () => {
    expect(RUNTIME_SOURCE).toContain('if (typeof window.setExtensionPrompt !== \'function\')');
    expect(RUNTIME_SOURCE).toContain('window.setExtensionPrompt = function(identifier, content, position, depth, scan, role, filter)');
    // 七参签名与 ST script.js 一致（identifier/content/position/depth/scan/role/filter）
    expect(RUNTIME_SOURCE).toContain('无效 identifier');
    expect(RUNTIME_SOURCE).toContain('content 必须是字符串');
  });

  it('window.setExtensionPrompt bridges to __palinkSetExtensionPrompt which registers into promptInjection', () => {
    expect(RUNTIME_SOURCE).toContain('window.__palinkSetExtensionPrompt');
    expect(RUNTIME_SOURCE).toContain('promptInjection.setExtensionPrompt(identifier, content, position as any, depth, scan, role, filter)');
  });
});

// ============================================================
// B. 功能断言：注册到扩展 prompt 存储（装配期消费可见）
//
// [XCHAR-PROMPT-BLEED 2026-10-03] 沙箱分区带角色维度（sandbox:<characterId>）。
// 取用改为按角色取，故本组用例必须先设活动角色，否则注册会落进「无角色分区」
// 而该分区刻意不参与按角色聚合（拿不到角色宁可空，也不要全量聚合 → 串味）。
// ============================================================
describe('A-6 Registration & Chat-Assembly Visibility', () => {
  const ID = '__palink_a6_contract_test__';
  const CHAR_ID = 'char-a6-contract';

  beforeEach(() => {
    promptInjection.clear();
    setActivePromptCharacter(CHAR_ID);
  });

  afterEach(() => {
    promptInjection.clear();
    setActivePromptCharacter(null);
  });

  it('setExtensionPrompt-style registration is visible in getPromptsForGeneration (useCharacterChat consumption)', () => {
    promptInjection.setExtensionPrompt(ID, 'visible-content', 1, 2, true, 0, null);
    try {
      const merged = promptInjection.getPromptsForGeneration(CHAR_ID);
      const entry = merged[ID] as any;
      expect(entry).toBeDefined();
      expect(entry.content).toBe('visible-content');
      expect(entry.position).toBe(1);
      expect(entry.depth).toBe(2);
      expect(entry.scan).toBe(true);
      expect(entry.role).toBe(0);
    } finally {
      promptInjection.removeExtensionPrompt(ID);
    }
  });

  it('registered prompt surfaces through getContext().extensionPrompts (value alias included)', () => {
    promptInjection.setExtensionPrompt(ID, 'ctx-visible', 0, 0, false, 0, null);
    try {
      const ctx = getContext();
      const entry = (ctx as any).extensionPrompts[ID];
      expect(entry).toBeDefined();
      expect(entry.value).toBe('ctx-visible');
      expect(entry.content).toBe('ctx-visible');
    } finally {
      promptInjection.removeExtensionPrompt(ID);
    }
  });

  // ── [XCHAR-PROMPT-BLEED] 跨角色隔离语义（串味修复的前端一半）──
  it('registration is partitioned per character: other card sees nothing', () => {
    // 活动角色已是 CHAR_ID（beforeEach），故注册落进 sandbox:char-a6-contract
    promptInjection.setExtensionPrompt(ID, 'card-A-only', 1, 2, false, 0, null);
    try {
      // 本卡可见
      expect(promptInjection.getPromptsForGeneration(CHAR_ID)?.[ID]).toBeDefined();
      // 别的卡不可见（修复前：全局单池 → 这里能读到 A 的内容）
      expect(promptInjection.getPromptsForGeneration('char-B')?.[ID]).toBeUndefined();
    } finally {
      promptInjection.removeExtensionPrompt(ID);
    }
  });

  it('without a character id, nothing is aggregated (no silent full-bleed)', () => {
    promptInjection.setExtensionPrompt(ID, 'no-char', 1, 2, false, 0, null);
    try {
      expect(promptInjection.getPromptsForGeneration('')?.[ID]).toBeUndefined();
      expect(promptInjection.getPromptsForGeneration(null)?.[ID]).toBeUndefined();
    } finally {
      promptInjection.removeExtensionPrompt(ID);
    }
  });

  it('clearCharacterSandbox drops exactly that card partition (switch cleanup)', () => {
    // 活动角色 = CHAR_ID，先写 A
    promptInjection.setExtensionPrompt(ID, 'A-payload', 1, 2, false, 0, null);
    // 切到 B，写 B
    setActivePromptCharacter('char-B');
    promptInjection.setExtensionPrompt(ID, 'B-payload', 1, 2, false, 0, null);
    try {
      expect(promptInjection.getPromptsForGeneration(CHAR_ID)?.[ID]?.content).toBe('A-payload');
      expect(promptInjection.getPromptsForGeneration('char-B')?.[ID]?.content).toBe('B-payload');

      // 切卡清理：只清旧角色，B 不受影响
      promptInjection.clearCharacterSandbox(CHAR_ID);
      expect(promptInjection.getPromptsForGeneration(CHAR_ID)?.[ID]).toBeUndefined();
      expect(promptInjection.getPromptsForGeneration('char-B')?.[ID]?.content).toBe('B-payload');
    } finally {
      promptInjection.removeExtensionPrompt(ID);
    }
  });

  it('frame partitions stay visible across characters (iframe track unchanged)', () => {
    promptInjection.setSourcePrompts('frame:f1', {
      'frame-entry': { value: 'from-iframe', position: 1, depth: 4 },
    });
    try {
      expect(promptInjection.getPromptsForGeneration('char-A')?.['frame-entry']?.content).toBe('from-iframe');
      expect(promptInjection.getPromptsForGeneration('char-B')?.['frame-entry']?.content).toBe('from-iframe');
    } finally {
      promptInjection.removeSource('frame:f1');
    }
  });

  it('getActivePromptCharacter reflects the set character (setExtensionPrompt target)', () => {
    setActivePromptCharacter('char-42');
    expect(getActivePromptCharacter()).toBe('char-42');
  });
});
