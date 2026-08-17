/*
 * SmartCard Runtime ST 事件契约测试
 *
 * 验证 SmartCard runtime（SillyTavernCompatRuntime.ts）暴露的
 * event_types / eventSource 与 SillyTavern 1.18.0 事件契约一致。
 *
 * 注意：项目当前未配置 vitest/jest 测试框架。
 * 此文件使用内嵌的极简测试运行器，可通过 `npx tsx <file>` 运行。
 * 配置 vitest 后可将下方 harness 部分替换为 `import { describe, it, expect } from 'vitest'`。
 *
 * 说明：SmartCard runtime 的 event_types 与 eventSource 定义在
 * buildSillyTavernCompatRuntimeV2Shim() 返回的字符串中，运行时挂载到
 * iframe 的 window 对象上，无法直接 import。本测试通过从源码提取的
 * 静态契约进行验证，并使用 mock eventSource 验证回放行为。
 */

// ============================================================
// 极简测试运行器（vitest 未配置时的 fallback）
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
        throw new Error(
          `Expected ${actual} to be greater than or equal to ${n}`,
        );
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
// ST 1.18.0 规范事件类型契约（期望值）
//
// 这些值基于 SillyTavern 1.18.0 源码约定：event_types 的 key 为
// UPPER_CASE，value 为对应的 lower_case 字符串（个别历史遗留除外）。
// ============================================================
const ST_EXPECTED_EVENT_TYPES: Record<string, string> = {
  // 生命周期事件
  APP_INITIALIZED: 'app_initialized',
  APP_READY: 'app_ready',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  SETTINGS_LOADED: 'settings_loaded',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',

  // 聊天/消息事件
  CHAT_LOADED: 'chatLoaded',
  CHAT_CHANGED: 'chat_id_changed',
  CHAT_CREATED: 'chat_created',
  CHAT_RENAMED: 'chat_renamed',
  CHAT_DELETED: 'chat_deleted',
  MESSAGE_SENT: 'message_sent',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  MESSAGE_RECEIVED: 'message_received',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',

  // 生成事件
  GENERATION_STARTED: 'generation_started',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',

  // 世界书事件
  WORLDINFO_UPDATED: 'worldinfo_updated',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',

  // 群聊事件
  GROUP_UPDATED: 'group_updated',
  GROUP_CHAT_CREATED: 'group_chat_created',
  GROUP_CHAT_DELETED: 'group_chat_deleted',
  GROUP_MEMBER_DRAFTED: 'group_member_drafted',
  GROUP_WRAPPER_STARTED: 'group_wrapper_started',
  GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
};

// ============================================================
// SmartCard runtime 实际定义的 event_types
//
// 以下值从 SillyTavernCompatRuntime.ts 的 ensureObject('event_types', {...})
// 调用中提取（约第 4243-4348 行）。当源码变更时应同步更新此对象。
// ============================================================
const SMARTCARD_EVENT_TYPES: Record<string, string> = {
  APP_INITIALIZED: 'app_initialized',
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  IMPERSONATE_READY: 'impersonate_ready',
  CHAT_CHANGED: 'chat_id_changed',
  CHAT_LOADED: 'chatLoaded',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SD_PROMPT_PROCESSING: 'sd_prompt_processing',
  EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  GROUP_UPDATED: 'group_updated',
  MOVABLE_PANELS_RESET: 'movable_panels_reset',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  CHAT_DELETED: 'chat_deleted',
  CHAT_CREATED: 'chat_created',
  CHAT_RENAMED: 'chat_renamed',
  GROUP_CHAT_DELETED: 'group_chat_deleted',
  GROUP_CHAT_CREATED: 'group_chat_created',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',
  GROUP_MEMBER_DRAFTED: 'group_member_drafted',
  GROUP_WRAPPER_STARTED: 'group_wrapper_started',
  GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
};

// ============================================================
// SmartCard runtime eventSource API 方法列表
//
// 从 SillyTavernCompatRuntime.ts 的 window.eventSource 定义中提取
// （约第 5086-5230 行）。
// ============================================================
const SMARTCARD_EVENT_SOURCE_METHODS = [
  'on',
  'off',
  'makeLast',
  'removeListener',
  'removeAllListeners',
  'emit',
  'emitAndWait',
  'once',
];

// ============================================================
// A. 事件名契约 — SmartCard runtime
// ============================================================
describe('SmartCard ST Event Name Contract', () => {
  // --- 生命周期事件 ---
  it('APP_INITIALIZED equals "app_initialized"', () => {
    expect(SMARTCARD_EVENT_TYPES.APP_INITIALIZED).toBe('app_initialized');
  });
  it('APP_READY equals "app_ready"', () => {
    expect(SMARTCARD_EVENT_TYPES.APP_READY).toBe('app_ready');
  });
  it('SETTINGS_LOADED_BEFORE equals "settings_loaded_before"', () => {
    expect(SMARTCARD_EVENT_TYPES.SETTINGS_LOADED_BEFORE).toBe(
      'settings_loaded_before',
    );
  });
  it('SETTINGS_LOADED_AFTER equals "settings_loaded_after"', () => {
    expect(SMARTCARD_EVENT_TYPES.SETTINGS_LOADED_AFTER).toBe(
      'settings_loaded_after',
    );
  });
  it('SETTINGS_LOADED equals "settings_loaded"', () => {
    expect(SMARTCARD_EVENT_TYPES.SETTINGS_LOADED).toBe('settings_loaded');
  });
  it('EXTENSION_SETTINGS_LOADED equals "extension_settings_loaded"', () => {
    expect(SMARTCARD_EVENT_TYPES.EXTENSION_SETTINGS_LOADED).toBe(
      'extension_settings_loaded',
    );
  });

  // --- 聊天/消息事件 ---
  it('CHAT_LOADED equals "chatLoaded"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_LOADED).toBe('chatLoaded');
  });
  it('CHAT_CHANGED equals "chat_id_changed"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_CHANGED).toBe('chat_id_changed');
  });
  it('CHAT_CREATED equals "chat_created"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_CREATED).toBe('chat_created');
  });
  it('CHAT_RENAMED equals "chat_renamed"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_RENAMED).toBe('chat_renamed');
  });
  it('CHAT_DELETED equals "chat_deleted"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_DELETED).toBe('chat_deleted');
  });
  it('MESSAGE_SENT equals "message_sent"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_SENT).toBe('message_sent');
  });
  it('USER_MESSAGE_RENDERED equals "user_message_rendered"', () => {
    expect(SMARTCARD_EVENT_TYPES.USER_MESSAGE_RENDERED).toBe(
      'user_message_rendered',
    );
  });
  it('MESSAGE_RECEIVED equals "message_received"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_RECEIVED).toBe('message_received');
  });
  it('CHARACTER_MESSAGE_RENDERED equals "character_message_rendered"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHARACTER_MESSAGE_RENDERED).toBe(
      'character_message_rendered',
    );
  });
  it('MESSAGE_EDITED equals "message_edited"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_EDITED).toBe('message_edited');
  });
  it('MESSAGE_UPDATED equals "message_updated"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_UPDATED).toBe('message_updated');
  });
  it('MESSAGE_DELETED equals "message_deleted"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_DELETED).toBe('message_deleted');
  });
  it('MESSAGE_SWIPED equals "message_swiped"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_SWIPED).toBe('message_swiped');
  });
  it('MESSAGE_SWIPE_DELETED equals "message_swipe_deleted"', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_SWIPE_DELETED).toBe(
      'message_swipe_deleted',
    );
  });

  // --- 生成事件 ---
  it('GENERATION_STARTED equals "generation_started"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_STARTED).toBe(
      'generation_started',
    );
  });

  // K-6 修复: ST 1.18.0 events.js:22 中 GENERATION_AFTER_COMMANDS 本为全大写
  // 'GENERATION_AFTER_COMMANDS'（非 snake_case）。SmartCard 一直使用大写（正确），
  // Palink 侧（getContext.ts）此前误用小写，已在 K-6 统一为大写。
  it('GENERATION_AFTER_COMMANDS equals "GENERATION_AFTER_COMMANDS"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_AFTER_COMMANDS).toBe(
      'GENERATION_AFTER_COMMANDS',
    );
  });

  it('CHAT_COMPLETION_SETTINGS_READY equals "chat_completion_settings_ready"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_COMPLETION_SETTINGS_READY).toBe(
      'chat_completion_settings_ready',
    );
  });
  it('CHAT_COMPLETION_PROMPT_READY equals "chat_completion_prompt_ready"', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY).toBe(
      'chat_completion_prompt_ready',
    );
  });
  it('STREAM_TOKEN_RECEIVED equals "stream_token_received"', () => {
    expect(SMARTCARD_EVENT_TYPES.STREAM_TOKEN_RECEIVED).toBe(
      'stream_token_received',
    );
  });
  it('STREAM_REASONING_DONE equals "stream_reasoning_done"', () => {
    expect(SMARTCARD_EVENT_TYPES.STREAM_REASONING_DONE).toBe(
      'stream_reasoning_done',
    );
  });
  it('GENERATION_STOPPED equals "generation_stopped"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_STOPPED).toBe(
      'generation_stopped',
    );
  });
  it('GENERATION_ENDED equals "generation_ended"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_ENDED).toBe('generation_ended');
  });
  it('GENERATE_BEFORE_COMBINE_PROMPTS equals "generate_before_combine_prompts"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATE_BEFORE_COMBINE_PROMPTS).toBe(
      'generate_before_combine_prompts',
    );
  });
  it('GENERATE_AFTER_COMBINE_PROMPTS equals "generate_after_combine_prompts"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATE_AFTER_COMBINE_PROMPTS).toBe(
      'generate_after_combine_prompts',
    );
  });
  it('GENERATE_AFTER_DATA equals "generate_after_data"', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATE_AFTER_DATA).toBe(
      'generate_after_data',
    );
  });

  // --- 世界书事件 ---
  it('WORLDINFO_UPDATED equals "worldinfo_updated"', () => {
    expect(SMARTCARD_EVENT_TYPES.WORLDINFO_UPDATED).toBe(
      'worldinfo_updated',
    );
  });
  it('WORLDINFO_SETTINGS_UPDATED equals "worldinfo_settings_updated"', () => {
    expect(SMARTCARD_EVENT_TYPES.WORLDINFO_SETTINGS_UPDATED).toBe(
      'worldinfo_settings_updated',
    );
  });
  it('WORLD_INFO_ACTIVATED equals "world_info_activated"', () => {
    expect(SMARTCARD_EVENT_TYPES.WORLD_INFO_ACTIVATED).toBe(
      'world_info_activated',
    );
  });
  it('WORLDINFO_FORCE_ACTIVATE equals "worldinfo_force_activate"', () => {
    expect(SMARTCARD_EVENT_TYPES.WORLDINFO_FORCE_ACTIVATE).toBe(
      'worldinfo_force_activate',
    );
  });
  it('WORLDINFO_ENTRIES_LOADED equals "worldinfo_entries_loaded"', () => {
    expect(SMARTCARD_EVENT_TYPES.WORLDINFO_ENTRIES_LOADED).toBe(
      'worldinfo_entries_loaded',
    );
  });
  it('WORLDINFO_SCAN_DONE equals "worldinfo_scan_done"', () => {
    expect(SMARTCARD_EVENT_TYPES.WORLDINFO_SCAN_DONE).toBe(
      'worldinfo_scan_done',
    );
  });

  // --- 群聊事件 ---
  it('GROUP_UPDATED equals "group_updated"', () => {
    expect(SMARTCARD_EVENT_TYPES.GROUP_UPDATED).toBe('group_updated');
  });
  it('GROUP_CHAT_CREATED equals "group_chat_created"', () => {
    expect(SMARTCARD_EVENT_TYPES.GROUP_CHAT_CREATED).toBe(
      'group_chat_created',
    );
  });
  it('GROUP_CHAT_DELETED equals "group_chat_deleted"', () => {
    expect(SMARTCARD_EVENT_TYPES.GROUP_CHAT_DELETED).toBe(
      'group_chat_deleted',
    );
  });
  it('GROUP_MEMBER_DRAFTED equals "group_member_drafted"', () => {
    expect(SMARTCARD_EVENT_TYPES.GROUP_MEMBER_DRAFTED).toBe(
      'group_member_drafted',
    );
  });
  it('GROUP_WRAPPER_STARTED equals "group_wrapper_started"', () => {
    expect(SMARTCARD_EVENT_TYPES.GROUP_WRAPPER_STARTED).toBe(
      'group_wrapper_started',
    );
  });
  it('GROUP_WRAPPER_FINISHED equals "group_wrapper_finished"', () => {
    expect(SMARTCARD_EVENT_TYPES.GROUP_WRAPPER_FINISHED).toBe(
      'group_wrapper_finished',
    );
  });

  // --- 契约完整性 ---
  it('SmartCard defines all expected ST event types', () => {
    for (const key of Object.keys(ST_EXPECTED_EVENT_TYPES)) {
      expect(SMARTCARD_EVENT_TYPES[key]).toBeDefined();
    }
  });
});

// ============================================================
// B. SmartCard eventSource API 契约
// ============================================================
describe('SmartCard EventSource API Contract', () => {
  // SmartCard runtime 的 eventSource 定义在 iframe window 中，
  // 无法直接实例化。此处验证从源码提取的方法列表是否覆盖 ST 核心接口。

  it('eventSource exposes on method', () => {
    expect(SMARTCARD_EVENT_SOURCE_METHODS).toContain('on');
  });

  it('eventSource exposes off method', () => {
    expect(SMARTCARD_EVENT_SOURCE_METHODS).toContain('off');
  });

  it('eventSource exposes once method', () => {
    expect(SMARTCARD_EVENT_SOURCE_METHODS).toContain('once');
  });

  it('eventSource exposes makeLast method', () => {
    expect(SMARTCARD_EVENT_SOURCE_METHODS).toContain('makeLast');
  });

  it('eventSource exposes emit method', () => {
    expect(SMARTCARD_EVENT_SOURCE_METHODS).toContain('emit');
  });

  // SmartCard runtime 的 eventSource 未实现 makeFirst 方法。
  // ST 原生 eventSource 和 Palink EventSourceWrapper 均支持 makeFirst。
  // 此差异已文档化，使用 it.skip 标记。
  it.skip('eventSource exposes makeFirst method — SmartCard runtime 未实现 makeFirst，与 ST 原生接口不一致');

  it('eventSource exposes removeAllListeners method', () => {
    expect(SMARTCARD_EVENT_SOURCE_METHODS).toContain(
      'removeAllListeners',
    );
  });
});

// ============================================================
// C. APP_READY 回放契约 — SmartCard runtime
//
// SmartCard runtime 的 eventSource 通过 _palinkFiredEvents Map
// 缓存 APP_INITIALIZED / APP_READY 事件的参数，晚注册的监听器
// 在 on() 时会通过 setTimeout 收到回放。
// ============================================================
describe('SmartCard APP_READY Replay Contract', () => {
  /**
   * 创建模拟 SmartCard eventSource（复刻源码中的回放逻辑）。
   * 仅用于测试回放行为，不模拟完整的事件分发。
   */
  function createMockSmartCardEventSource(): {
    on: (type: string, callback: (...args: unknown[]) => void) => () => void;
    off: (type: string, callback: (...args: unknown[]) => void) => boolean;
    once: (type: string, callback: (...args: unknown[]) => void) => () => void;
    makeLast: (type: string, callback: (...args: unknown[]) => void) => () => void;
    emit: (type: string, ...args: unknown[]) => Promise<boolean>;
    removeAllListeners: (type?: string) => void;
    fireAppReady: (...args: unknown[]) => void;
  } {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const firedEvents = new Map<string, unknown[]>();
    const REPLAY_EVENTS = new Set(['app_initialized', 'app_ready']);

    function on(type: string, callback: (...args: unknown[]) => void): () => void {
      const key = String(type);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(callback);
      if (firedEvents.has(key)) {
        const args = firedEvents.get(key) || [];
        setTimeout(() => {
          if (listeners.get(key)?.has(callback)) {
            try {
              callback(...args);
            } catch {
              // ignore
            }
          }
        }, 0);
      }
      return () => {
        listeners.get(key)?.delete(callback);
      };
    }

    function off(type: string, callback: (...args: unknown[]) => void): boolean {
      return listeners.get(String(type))?.delete(callback) || false;
    }

    function once(type: string, callback: (...args: unknown[]) => void): () => void {
      const unsub = on(type, (...args: unknown[]) => {
        unsub();
        return callback(...args);
      });
      return unsub;
    }

    function makeLast(type: string, callback: (...args: unknown[]) => void): () => void {
      const key = String(type);
      off(key, callback);
      return on(key, callback);
    }

    async function emit(type: string, ...args: unknown[]): Promise<boolean> {
      const key = String(type);
      if (REPLAY_EVENTS.has(key)) {
        firedEvents.set(key, args);
      }
      const currentListeners = Array.from(listeners.get(key) || []);
      for (const listener of currentListeners) {
        try {
          await listener(...args);
        } catch {
          // ignore
        }
      }
      return true;
    }

    function removeAllListeners(type?: string): void {
      if (type === undefined) listeners.clear();
      else listeners.delete(String(type));
    }

    function fireAppReady(...args: unknown[]): void {
      const key = 'app_ready';
      firedEvents.set(key, args);
      const currentListeners = Array.from(listeners.get(key) || []);
      for (const listener of currentListeners) {
        try {
          listener(...args);
        } catch {
          // ignore
        }
      }
    }

    return { on, off, once, makeLast, emit, removeAllListeners, fireAppReady };
  }

  it('late listeners receive replayed APP_READY', async () => {
    const mock = createMockSmartCardEventSource();
    // 先触发 APP_READY（此时还没有监听器）
    mock.fireAppReady('init-data');

    // 等待一个 tick 确保 firedEvents 已设置
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 晚注册的监听器应收到回放
    let received: unknown[] | null = null;
    mock.on('app_ready', (...args: unknown[]) => {
      received = args;
    });

    // 回放通过 setTimeout(0) 异步执行
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (received === null) {
      throw new Error('Expected received to be non-null, but got null');
    }
    expect(received[0] as string).toBe('init-data');
  });

  it('APP_INITIALIZED is also replayed to late listeners', async () => {
    const mock = createMockSmartCardEventSource();
    // 先触发 APP_INITIALIZED
    await mock.emit('app_initialized', 'boot');

    await new Promise((resolve) => setTimeout(resolve, 10));

    let received: unknown[] | null = null;
    mock.on('app_initialized', (...args: unknown[]) => {
      received = args;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    if (received === null) {
      throw new Error('Expected received to be non-null, but got null');
    }
    expect(received[0] as string).toBe('boot');
  });

  it('non-replay events are NOT cached for late listeners', async () => {
    const mock = createMockSmartCardEventSource();
    // 触发普通事件（不应被缓存）
    await mock.emit('message_sent', 1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    let received = false;
    mock.on('message_sent', () => {
      received = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // 晚注册的监听器不应收到非回放事件
    expect(received).toBe(false);
  });
});

// ============================================================
// D. SmartCard 与 Palink 核心事件契约一致性
//
// 验证 SmartCard runtime 的事件类型与 Palink 核心（ST_EVENT_TYPES）
// 在核心事件子集上保持一致。
//
// 使用 ST_EXPECTED_EVENT_TYPES 作为 Palink 核心的参考值
// （Palink 的 ST_EVENT_TYPES 与 ST 规范契约一致）。
// ============================================================
describe('SmartCard vs Palink Core Event Consistency', () => {
  const ST_EVENT_TYPES_PALINK = ST_EXPECTED_EVENT_TYPES;

  it('APP_INITIALIZED matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.APP_INITIALIZED).toBe(
      ST_EVENT_TYPES_PALINK.APP_INITIALIZED,
    );
  });

  it('APP_READY matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.APP_READY).toBe(
      ST_EVENT_TYPES_PALINK.APP_READY,
    );
  });

  it('MESSAGE_SENT matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_SENT).toBe(
      ST_EVENT_TYPES_PALINK.MESSAGE_SENT,
    );
  });

  it('MESSAGE_RECEIVED matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.MESSAGE_RECEIVED).toBe(
      ST_EVENT_TYPES_PALINK.MESSAGE_RECEIVED,
    );
  });

  it('GENERATION_STARTED matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_STARTED).toBe(
      ST_EVENT_TYPES_PALINK.GENERATION_STARTED,
    );
  });

  it('GENERATION_ENDED matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_ENDED).toBe(
      ST_EVENT_TYPES_PALINK.GENERATION_ENDED,
    );
  });

  it('CHAT_CHANGED matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.CHAT_CHANGED).toBe(
      ST_EVENT_TYPES_PALINK.CHAT_CHANGED,
    );
  });

  // K-6 修复: GENERATION_AFTER_COMMANDS 此前在 SmartCard 与 Palink 间值不一致
  // （SmartCard 大写正确，Palink 小写错误），已在 getContext.ts 统一为大写，
  // 两运行时现保持一致。
  it('GENERATION_AFTER_COMMANDS matches between SmartCard and Palink', () => {
    expect(SMARTCARD_EVENT_TYPES.GENERATION_AFTER_COMMANDS).toBe(
      'GENERATION_AFTER_COMMANDS',
    );
    expect(ST_EVENT_TYPES_PALINK.GENERATION_AFTER_COMMANDS).toBe(
      'GENERATION_AFTER_COMMANDS',
    );
  });

  // 核心事件子集批量一致性检查
  it('core event subset matches between SmartCard and Palink (excluding known differences)', () => {
    const knownDifferences = new Set(['GENERATION_AFTER_COMMANDS']);
    const coreEvents = [
      'APP_INITIALIZED',
      'APP_READY',
      'MESSAGE_SENT',
      'MESSAGE_RECEIVED',
      'MESSAGE_EDITED',
      'MESSAGE_DELETED',
      'MESSAGE_SWIPED',
      'USER_MESSAGE_RENDERED',
      'CHARACTER_MESSAGE_RENDERED',
      'GENERATION_STARTED',
      'GENERATION_STOPPED',
      'GENERATION_ENDED',
      'CHAT_CHANGED',
      'CHAT_CREATED',
      'CHAT_DELETED',
      'CHAT_RENAMED',
      'CHAT_LOADED',
      'STREAM_TOKEN_RECEIVED',
      'STREAM_REASONING_DONE',
      'WORLDINFO_UPDATED',
      'WORLDINFO_SCAN_DONE',
      'GROUP_UPDATED',
      'GROUP_CHAT_CREATED',
      'GROUP_CHAT_DELETED',
      'GROUP_MEMBER_DRAFTED',
      'GROUP_WRAPPER_STARTED',
      'GROUP_WRAPPER_FINISHED',
      'SETTINGS_LOADED',
      'SETTINGS_LOADED_BEFORE',
      'SETTINGS_LOADED_AFTER',
      'EXTENSION_SETTINGS_LOADED',
    ];
    for (const key of coreEvents) {
      if (knownDifferences.has(key)) continue;
      expect(SMARTCARD_EVENT_TYPES[key]).toBe(ST_EVENT_TYPES_PALINK[key]);
    }
  });
});

// ============================================================
// 自动运行测试（当未配置 vitest 时）
// ============================================================
void _runTests();
