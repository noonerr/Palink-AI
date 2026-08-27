/*
 * [A-6] 经典轨 window.setExtensionPrompt 全局真实现契约测试
 *
 * 验证:
 *   1. sillyTavernPluginRuntime.ts 的注入脚本（setupScript）提供全局
 *      window.setExtensionPrompt（入参校验 + 转发到 __palinkSetExtensionPrompt 桥）。
 *   2. 桥接在 TS 侧注册到 prompt-injection 服务（与沙箱轨同源），注册项经
 *      getPromptsForGeneration() 供 chat 装配消费（useCharacterChat:1161）。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/utils/__tests__/plugin-runtime-extprompt-contract.test.ts
 */

// ============================================================
// 极简测试运行器（与既有契约测试一致）
// ============================================================
type TestFn = () => void | Promise<void>;
interface TestCase {
  name: string;
  fn: TestFn;
  skip: boolean;
}
const _testCases: TestCase[] = [];
let _currentSuite = '';

function describe(name: string, fn: () => void): void {
  const prev = _currentSuite;
  _currentSuite = name;
  try {
    fn();
  } finally {
    _currentSuite = prev;
  }
}

function it(name: string, fn: TestFn): void {
  _testCases.push({ name: `${_currentSuite} — ${name}`, fn, skip: false });
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
    },
    toBeTruthy(): void {
      if (!actual) throw new Error(`Expected ${JSON.stringify(actual)} to be truthy`);
    },
    toContain(needle: string): void {
      if (typeof actual !== 'string' || !actual.includes(needle)) {
        throw new Error(`Expected string to contain ${JSON.stringify(needle)}`);
      }
    },
    toBeDefined(): void {
      if (actual === undefined) throw new Error('Expected value to be defined');
    },
  };
}

async function _runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const tc of _testCases) {
    if (tc.skip) {
      console.log(`  ⊘ SKIP  ${tc.name}`);
      continue;
    }
    try {
      await tc.fn();
      passed++;
      console.log(`  ✓ PASS  ${tc.name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ FAIL  ${tc.name}\n         ${(e as Error).message}`);
    }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0 && typeof process !== 'undefined') process.exit(1);
}

// ============================================================
// 导入待测模块
// ============================================================
import './../../lib/sillytavern/__tests__/_tsx-loader.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promptInjection } from '@/services/prompt-injection';

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

  it('registered prompt surfaces through getContext().extensionPrompts (value alias included)', async () => {
    const { getContext } = await import('@/lib/sillytavern/getContext');
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

void _runTests();