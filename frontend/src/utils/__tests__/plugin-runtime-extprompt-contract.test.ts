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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promptInjection } from '@/services/prompt-injection';

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
    expect(RUNTIME_SOURCE).toContain("import { promptInjection } from '@/services/prompt-injection'");
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
// ============================================================
describe('A-6 Registration & Chat-Assembly Visibility', () => {
  const ID = '__palink_a6_contract_test__';

  it('setExtensionPrompt-style registration is visible in getPromptsForGeneration (useCharacterChat consumption)', () => {
    promptInjection.setExtensionPrompt(ID, 'visible-content', 1, 2, true, 0, null);
    try {
      const merged = promptInjection.getPromptsForGeneration();
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
});
