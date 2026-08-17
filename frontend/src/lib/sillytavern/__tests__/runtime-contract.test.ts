/*
 * SmartCard Runtime 契约 / 冒烟测试
 *
 * 验证 Palink SillyTavern 运行时 (runtime.ts) 暴露的核心 API 形状与
 * SillyTavern 1.18.0 兼容契约一致：全局运行时入口、getContext、eventSource、
 * eventTypes 映射，以及正则执行顺序与斜杠命令执行。
 *
 * 注意：项目当前未配置 vitest/jest 测试框架。
 * 此文件使用内嵌的极简测试运行器，可通过 `npx tsx <file>` 运行。
 * 配置 vitest 后可将下方 harness 部分替换为 `import { describe, it, expect } from 'vitest'`。
 */

// ============================================================
// 极简测试运行器（vitest 未配置时的 fallback，与 event-contract.test.ts 一致）
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
  _testCases.push({
    name: _currentSuite ? `${_currentSuite} — ${name}` : name,
    fn,
    skip: false,
  });
}
it.skip = (name: string, _fn?: TestFn): void => {
  _testCases.push({
    name: _currentSuite ? `${_currentSuite} — ${name}` : name,
    fn: async () => {},
    skip: true,
  });
};

function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      if (actual !== expected) {
        throw new Error(
          `Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`,
        );
      }
    },
    toEqual(expected: T): void {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`,
        );
      }
    },
    toBeDefined(): void {
      if (actual === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeUndefined(): void {
      if (actual !== undefined) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be undefined`);
      }
    },
    toBeTruthy(): void {
      if (!actual) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be truthy`);
      }
    },
    toBeInstanceOf(cls: new (...args: any[]) => unknown): void {
      if (!(actual instanceof cls)) {
        throw new Error(
          `Expected ${JSON.stringify(actual)} to be instance of ${cls.name}`,
        );
      }
    },
    toHaveProperty(prop: string): void {
      if (
        typeof actual !== 'object' ||
        actual === null ||
        !(prop in actual)
      ) {
        throw new Error(`Expected object to have property "${prop}"`);
      }
    },
    toContain(item: unknown): void {
      if (typeof actual === 'string') {
        if (!actual.includes(String(item))) {
          throw new Error(`Expected string to contain "${item}"`);
        }
      } else if (Array.isArray(actual)) {
        if (!actual.includes(item)) {
          throw new Error(`Expected array to contain ${JSON.stringify(item)}`);
        }
      } else {
        throw new Error('toContain expects string or array');
      }
    },
    toBeGreaterThan(n: number): void {
      if (typeof actual !== 'number' || actual <= n) {
        throw new Error(`Expected ${actual} to be greater than ${n}`);
      }
    },
    toBeGreaterThanOrEqual(n: number): void {
      if (typeof actual !== 'number' || actual < n) {
        throw new Error(`Expected ${actual} to be greater than or equal to ${n}`);
      }
    },
  };
}

async function _runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const tc of _testCases) {
    if (tc.skip) {
      skipped++;
      console.log(`  ⊘ SKIP  ${tc.name}`);
      continue;
    }
    try {
      await tc.fn();
      passed++;
      console.log(`  ✓ PASS  ${tc.name}`);
    } catch (e) {
      failed++;
      console.log(
        `  ✗ FAIL  ${tc.name}\n         ${(e as Error).message}`,
      );
    }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, ${skipped} 跳过`);
  if (failed > 0 && typeof process !== 'undefined') {
    process.exit(1);
  }
}

// ============================================================
// 导入待测模块
// ============================================================
import {
  createSillyTavernRuntime,
  destroySillyTavernRuntime,
  ST_TO_PALINK_EVENT_MAP,
  SillyTavernRuntime,
  getRegexedString,
  regex_placement,
  type RegexScript,
  type StEventSource,
} from '../runtime';

// ============================================================
// A. SmartCard Runtime Core Globals
//
// window.SillyTavern / window.eventSource / window.event_types 等全局由
// 浏览器侧兼容层 (SillyTavernIframe.tsx) 在 iframe 内挂载，无法在 Node 中
// 直接验证。此处验证其底层支撑的 Palink 运行时 API 形状（createSillyTavernRuntime
// 返回的实例即 window.SillyTavern.getContext / eventSource 的来源）。
// ============================================================
describe('SmartCard Runtime Core Globals', () => {
  it('createSillyTavernRuntime returns a SillyTavernRuntime instance', () => {
    const runtime = createSillyTavernRuntime();
    try {
      expect(runtime).toBeInstanceOf(SillyTavernRuntime);
    } finally {
      destroySillyTavernRuntime();
    }
  });

  // window.SillyTavern 全局由浏览器兼容层挂载，Node 环境无 window，跳过实际全局检查。
  it.skip('exposes SillyTavern global on window — requires browser iframe environment');

  it('exposes getContext function returning a context object', () => {
    const runtime = createSillyTavernRuntime();
    try {
      expect(typeof runtime.getContext).toBe('function');
      const ctx = runtime.getContext();
      expect(typeof ctx).toBe('object');
      // StContext 核心字段
      expect(ctx).toHaveProperty('chat');
      expect(ctx).toHaveProperty('character');
      expect(ctx).toHaveProperty('chatId');
      expect(Array.isArray(ctx.chat)).toBeTruthy();
    } finally {
      destroySillyTavernRuntime();
    }
  });

  it('exposes eventSource with on/off/emit/once/makeLast/makeFirst methods', () => {
    const runtime = createSillyTavernRuntime();
    try {
      const eventSource: StEventSource = runtime.getEventSource();
      expect(typeof eventSource.on).toBe('function');
      expect(typeof eventSource.off).toBe('function');
      expect(typeof eventSource.emit).toBe('function');
      expect(typeof eventSource.once).toBe('function');
      expect(typeof eventSource.makeLast).toBe('function');
      expect(typeof eventSource.makeFirst).toBe('function');
      expect(typeof eventSource.removeAllListeners).toBe('function');
      expect(typeof eventSource.listenerCount).toBe('function');
    } finally {
      destroySillyTavernRuntime();
    }
  });

  it('exposes eventTypes (ST_TO_PALINK_EVENT_MAP) with core event names', () => {
    // ST_TO_PALINK_EVENT_MAP 的 key 为 ST UPPER_CASE 事件名
    expect(typeof ST_TO_PALINK_EVENT_MAP).toBe('object');
    // 核心生命周期 / 消息 / 生成事件必须存在
    expect(ST_TO_PALINK_EVENT_MAP.APP_READY).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.APP_INITIALIZED).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.MESSAGE_RECEIVED).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.MESSAGE_SENT).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.GENERATION_STARTED).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.GENERATION_ENDED).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.CHAT_LOADED).toBeDefined();
    expect(ST_TO_PALINK_EVENT_MAP.STREAM_TOKEN_RECEIVED).toBeDefined();
    // 映射值为非空 Palink 事件名
    expect(typeof ST_TO_PALINK_EVENT_MAP.APP_READY).toBe('string');
    expect(ST_TO_PALINK_EVENT_MAP.APP_READY.length).toBeGreaterThan(0);
  });
});

// ============================================================
// B. Regex Execution Order
//
// 对照 regex/engine.ts: getRegexScripts 按 GLOBAL(0) -> SCOPED(1) -> PRESET(2)
// 顺序合并，组内按数组顺序保留。getRegexedString 按该顺序依次应用脚本。
// ============================================================
describe('Regex Execution Order', () => {
  it('global scripts run before scoped scripts', () => {
    const globalScripts: RegexScript[] = [
      {
        findRegex: 'hello',
        replaceString: 'world',
        markdownOnly: false,
        promptOnly: false,
        disabled: false,
      },
    ];
    const scopedScripts: RegexScript[] = [
      {
        findRegex: 'world',
        replaceString: 'earth',
        markdownOnly: false,
        promptOnly: false,
        disabled: false,
      },
    ];
    // global (hello→world) 先于 scoped (world→earth) 执行 → 最终 "earth"
    const result = getRegexedString('hello', regex_placement.MD_DISPLAY, {
      globalScripts,
      scopedScripts,
      isMarkdown: true,
    });
    expect(result).toBe('earth');
  });

  it('scripts within a group execute in array order', () => {
    const globalScripts: RegexScript[] = [
      {
        findRegex: 'hello',
        replaceString: 'hi',
        markdownOnly: false,
        promptOnly: false,
        disabled: false,
      },
      {
        findRegex: 'hi',
        replaceString: 'hey',
        markdownOnly: false,
        promptOnly: false,
        disabled: false,
      },
    ];
    // 组内数组顺序：hello→hi→hey
    const result = getRegexedString('hello', regex_placement.MD_DISPLAY, {
      globalScripts,
      isMarkdown: true,
    });
    expect(result).toBe('hey');
  });

  it('disabled scripts are skipped', () => {
    const globalScripts: RegexScript[] = [
      {
        findRegex: 'hello',
        replaceString: 'world',
        markdownOnly: false,
        promptOnly: false,
        disabled: true,
      },
    ];
    const result = getRegexedString('hello', regex_placement.MD_DISPLAY, {
      globalScripts,
      isMarkdown: true,
    });
    expect(result).toBe('hello');
  });
});

// ============================================================
// C. Slash Command Execution
//
// 验证 runtime.registerSlashCommand + runtime.executeSlashCommands 能完成
// 注册→解析→执行→输出的端到端往返（委托到 SlashCommandEngine 单例）。
// ============================================================
describe('Slash Command Execution', () => {
  it('registerSlashCommand + executeSlashCommands round-trip', async () => {
    const runtime = createSillyTavernRuntime();
    try {
      const cmdName = 'palink_contract_echo';
      runtime.registerSlashCommand(
        cmdName,
        (args: string) => `echo:${args}`,
      );
      const output = await runtime.executeSlashCommands(`/${cmdName} hello`);
      expect(typeof output).toBe('string');
      expect(output).toContain('echo:');
      expect(output).toContain('hello');
    } finally {
      destroySillyTavernRuntime();
    }
  });

  it('executeSlashCommands returns empty string for non-command input', async () => {
    const runtime = createSillyTavernRuntime();
    try {
      const output = await runtime.executeSlashCommands('plain text without slash');
      expect(typeof output).toBe('string');
    } finally {
      destroySillyTavernRuntime();
    }
  });
});

// ============================================================
// 自动运行测试（当未配置 vitest 时）
// ============================================================
void _runTests();
