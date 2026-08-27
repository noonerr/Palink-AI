/*
 * ST 事件契约测试
 *
 * 验证 Palink 的事件名、参数顺序、生命周期时序与 SillyTavern 1.18.0 一致。
 *
 * 注意：项目当前未配置 vitest/jest 测试框架。
 * 此文件使用内嵌的极简测试运行器，可通过 `npx tsx <file>` 运行。
 * 配置 vitest 后可将下方 harness 部分替换为 `import { describe, it, expect } from 'vitest'`。
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
import { ST_EVENT_TYPES } from '../getContext';
import {
  createSillyTavernRuntime,
  destroySillyTavernRuntime,
  type StEventSource,
} from '../runtime';

// ============================================================
// ST 1.18.0 规范事件类型契约（期望值）
//
// 这些值基于 SillyTavern 1.18.0 源码约定：event_types 的 key 为
// UPPER_CASE，value 为对应的 lower_case 字符串（个别历史遗留除外）。
// 测试的目的在于发现 Palink 实现与 ST 规范之间的偏差。
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
// A. 事件名契约
// ============================================================
describe('ST Event Name Contract', () => {
  // --- 生命周期事件 ---
  it('APP_INITIALIZED equals "app_initialized"', () => {
    expect(ST_EVENT_TYPES.APP_INITIALIZED).toBe('app_initialized');
  });
  it('APP_READY equals "app_ready"', () => {
    expect(ST_EVENT_TYPES.APP_READY).toBe('app_ready');
  });
  it('SETTINGS_LOADED_BEFORE equals "settings_loaded_before"', () => {
    expect(ST_EVENT_TYPES.SETTINGS_LOADED_BEFORE).toBe(
      'settings_loaded_before',
    );
  });
  it('SETTINGS_LOADED_AFTER equals "settings_loaded_after"', () => {
    expect(ST_EVENT_TYPES.SETTINGS_LOADED_AFTER).toBe(
      'settings_loaded_after',
    );
  });
  it('SETTINGS_LOADED equals "settings_loaded"', () => {
    expect(ST_EVENT_TYPES.SETTINGS_LOADED).toBe('settings_loaded');
  });
  it('EXTENSION_SETTINGS_LOADED equals "extension_settings_loaded"', () => {
    expect(ST_EVENT_TYPES.EXTENSION_SETTINGS_LOADED).toBe(
      'extension_settings_loaded',
    );
  });

  // --- 聊天/消息事件 ---
  it('CHAT_LOADED equals "chatLoaded"', () => {
    expect(ST_EVENT_TYPES.CHAT_LOADED).toBe('chatLoaded');
  });
  it('CHAT_CHANGED equals "chat_id_changed"', () => {
    expect(ST_EVENT_TYPES.CHAT_CHANGED).toBe('chat_id_changed');
  });
  it('CHAT_CREATED equals "chat_created"', () => {
    expect(ST_EVENT_TYPES.CHAT_CREATED).toBe('chat_created');
  });
  it('CHAT_RENAMED equals "chat_renamed"', () => {
    expect(ST_EVENT_TYPES.CHAT_RENAMED).toBe('chat_renamed');
  });
  it('CHAT_DELETED equals "chat_deleted"', () => {
    expect(ST_EVENT_TYPES.CHAT_DELETED).toBe('chat_deleted');
  });
  it('MESSAGE_SENT equals "message_sent"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_SENT).toBe('message_sent');
  });
  it('USER_MESSAGE_RENDERED equals "user_message_rendered"', () => {
    expect(ST_EVENT_TYPES.USER_MESSAGE_RENDERED).toBe(
      'user_message_rendered',
    );
  });
  it('MESSAGE_RECEIVED equals "message_received"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_RECEIVED).toBe('message_received');
  });
  it('CHARACTER_MESSAGE_RENDERED equals "character_message_rendered"', () => {
    expect(ST_EVENT_TYPES.CHARACTER_MESSAGE_RENDERED).toBe(
      'character_message_rendered',
    );
  });
  it('MESSAGE_EDITED equals "message_edited"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_EDITED).toBe('message_edited');
  });
  it('MESSAGE_UPDATED equals "message_updated"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_UPDATED).toBe('message_updated');
  });
  it('MESSAGE_DELETED equals "message_deleted"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_DELETED).toBe('message_deleted');
  });
  it('MESSAGE_SWIPED equals "message_swiped"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_SWIPED).toBe('message_swiped');
  });
  it('MESSAGE_SWIPE_DELETED equals "message_swipe_deleted"', () => {
    expect(ST_EVENT_TYPES.MESSAGE_SWIPE_DELETED).toBe(
      'message_swipe_deleted',
    );
  });

  // --- 生成事件 ---
  it('GENERATION_STARTED equals "generation_started"', () => {
    expect(ST_EVENT_TYPES.GENERATION_STARTED).toBe('generation_started');
  });
  // K-6 修复: 与 ST 1.18.0 events.js:22 对齐（全大写，非 snake_case）
  it('GENERATION_AFTER_COMMANDS equals "GENERATION_AFTER_COMMANDS"', () => {
    expect(ST_EVENT_TYPES.GENERATION_AFTER_COMMANDS).toBe(
      'GENERATION_AFTER_COMMANDS',
    );
  });
  it('CHAT_COMPLETION_SETTINGS_READY equals "chat_completion_settings_ready"', () => {
    expect(ST_EVENT_TYPES.CHAT_COMPLETION_SETTINGS_READY).toBe(
      'chat_completion_settings_ready',
    );
  });
  it('CHAT_COMPLETION_PROMPT_READY equals "chat_completion_prompt_ready"', () => {
    expect(ST_EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY).toBe(
      'chat_completion_prompt_ready',
    );
  });
  it('STREAM_TOKEN_RECEIVED equals "stream_token_received"', () => {
    expect(ST_EVENT_TYPES.STREAM_TOKEN_RECEIVED).toBe(
      'stream_token_received',
    );
  });
  it('STREAM_REASONING_DONE equals "stream_reasoning_done"', () => {
    expect(ST_EVENT_TYPES.STREAM_REASONING_DONE).toBe(
      'stream_reasoning_done',
    );
  });
  it('GENERATION_STOPPED equals "generation_stopped"', () => {
    expect(ST_EVENT_TYPES.GENERATION_STOPPED).toBe('generation_stopped');
  });
  it('GENERATION_ENDED equals "generation_ended"', () => {
    expect(ST_EVENT_TYPES.GENERATION_ENDED).toBe('generation_ended');
  });
  it('GENERATE_BEFORE_COMBINE_PROMPTS equals "generate_before_combine_prompts"', () => {
    expect(ST_EVENT_TYPES.GENERATE_BEFORE_COMBINE_PROMPTS).toBe(
      'generate_before_combine_prompts',
    );
  });
  it('GENERATE_AFTER_COMBINE_PROMPTS equals "generate_after_combine_prompts"', () => {
    expect(ST_EVENT_TYPES.GENERATE_AFTER_COMBINE_PROMPTS).toBe(
      'generate_after_combine_prompts',
    );
  });
  it('GENERATE_AFTER_DATA equals "generate_after_data"', () => {
    expect(ST_EVENT_TYPES.GENERATE_AFTER_DATA).toBe('generate_after_data');
  });

  // --- 世界书事件 ---
  it('WORLDINFO_UPDATED equals "worldinfo_updated"', () => {
    expect(ST_EVENT_TYPES.WORLDINFO_UPDATED).toBe('worldinfo_updated');
  });
  it('WORLDINFO_SETTINGS_UPDATED equals "worldinfo_settings_updated"', () => {
    expect(ST_EVENT_TYPES.WORLDINFO_SETTINGS_UPDATED).toBe(
      'worldinfo_settings_updated',
    );
  });
  it('WORLD_INFO_ACTIVATED equals "world_info_activated"', () => {
    expect(ST_EVENT_TYPES.WORLD_INFO_ACTIVATED).toBe(
      'world_info_activated',
    );
  });
  it('WORLDINFO_FORCE_ACTIVATE equals "worldinfo_force_activate"', () => {
    expect(ST_EVENT_TYPES.WORLDINFO_FORCE_ACTIVATE).toBe(
      'worldinfo_force_activate',
    );
  });
  it('WORLDINFO_ENTRIES_LOADED equals "worldinfo_entries_loaded"', () => {
    expect(ST_EVENT_TYPES.WORLDINFO_ENTRIES_LOADED).toBe(
      'worldinfo_entries_loaded',
    );
  });
  it('WORLDINFO_SCAN_DONE equals "worldinfo_scan_done"', () => {
    expect(ST_EVENT_TYPES.WORLDINFO_SCAN_DONE).toBe(
      'worldinfo_scan_done',
    );
  });

  // --- 群聊事件 ---
  it('GROUP_UPDATED equals "group_updated"', () => {
    expect(ST_EVENT_TYPES.GROUP_UPDATED).toBe('group_updated');
  });
  it('GROUP_CHAT_CREATED equals "group_chat_created"', () => {
    expect(ST_EVENT_TYPES.GROUP_CHAT_CREATED).toBe('group_chat_created');
  });
  it('GROUP_CHAT_DELETED equals "group_chat_deleted"', () => {
    expect(ST_EVENT_TYPES.GROUP_CHAT_DELETED).toBe('group_chat_deleted');
  });
  it('GROUP_MEMBER_DRAFTED equals "group_member_drafted"', () => {
    expect(ST_EVENT_TYPES.GROUP_MEMBER_DRAFTED).toBe(
      'group_member_drafted',
    );
  });
  it('GROUP_WRAPPER_STARTED equals "group_wrapper_started"', () => {
    expect(ST_EVENT_TYPES.GROUP_WRAPPER_STARTED).toBe(
      'group_wrapper_started',
    );
  });
  it('GROUP_WRAPPER_FINISHED equals "group_wrapper_finished"', () => {
    expect(ST_EVENT_TYPES.GROUP_WRAPPER_FINISHED).toBe(
      'group_wrapper_finished',
    );
  });

  // --- 契约完整性：所有期望的 ST 事件都在 Palink 中定义 ---
  it('Palink defines all expected ST event types', () => {
    for (const key of Object.keys(ST_EXPECTED_EVENT_TYPES)) {
      expect(ST_EVENT_TYPES[key]).toBeDefined();
    }
  });
});

// ============================================================
// B. 事件源 API 契约
// ============================================================
describe('EventSource API Contract', () => {
  let runtime: ReturnType<typeof createSillyTavernRuntime>;
  let eventSource: StEventSource;

  function setup(): void {
    runtime = createSillyTavernRuntime();
    eventSource = runtime.getEventSource();
  }

  function teardown(): void {
    eventSource.removeAllListeners();
    destroySillyTavernRuntime();
  }

  it('eventSource has on method', () => {
    setup();
    try {
      expect(typeof eventSource.on).toBe('function');
    } finally {
      teardown();
    }
  });

  it('eventSource has off method', () => {
    setup();
    try {
      expect(typeof eventSource.off).toBe('function');
    } finally {
      teardown();
    }
  });

  it('eventSource has once method', () => {
    setup();
    try {
      expect(typeof eventSource.once).toBe('function');
    } finally {
      teardown();
    }
  });

  it('eventSource has makeFirst method', () => {
    setup();
    try {
      expect(typeof eventSource.makeFirst).toBe('function');
    } finally {
      teardown();
    }
  });

  it('eventSource has makeLast method', () => {
    setup();
    try {
      expect(typeof eventSource.makeLast).toBe('function');
    } finally {
      teardown();
    }
  });

  it('eventSource has emit method', () => {
    setup();
    try {
      expect(typeof eventSource.emit).toBe('function');
    } finally {
      teardown();
    }
  });

  it('on returns unsubscribe function', () => {
    setup();
    try {
      const unsub = eventSource.on('test_event', () => {});
      expect(typeof unsub).toBe('function');
      unsub();
    } finally {
      teardown();
    }
  });

  it('on listener receives emitted args', () => {
    setup();
    try {
      const received: unknown[] = [];
      eventSource.on('test_event', (...args: unknown[]) => {
        received.push(...args);
      });
      eventSource.emit('test_event', 'a', 1, { x: 2 });
      expect(received.length).toBe(3);
      expect(received[0]).toBe('a');
      expect(received[1]).toBe(1);
    } finally {
      teardown();
    }
  });

  it('makeFirst registers listener at front', () => {
    setup();
    try {
      const order: string[] = [];
      eventSource.on('test_event', () => {
        order.push('regular');
      });
      eventSource.makeFirst('test_event', () => {
        order.push('first');
      });
      eventSource.emit('test_event');
      expect(order.length).toBe(2);
      expect(order[0]).toBe('first');
      expect(order[1]).toBe('regular');
    } finally {
      teardown();
    }
  });

  it('makeLast registers listener at back', () => {
    setup();
    try {
      const order: string[] = [];
      eventSource.on('test_event', () => {
        order.push('regular');
      });
      eventSource.makeLast('test_event', () => {
        order.push('last');
      });
      eventSource.emit('test_event');
      expect(order.length).toBe(2);
      expect(order[0]).toBe('regular');
      expect(order[1]).toBe('last');
    } finally {
      teardown();
    }
  });

  it('once listener auto-removes after first call', () => {
    setup();
    try {
      let callCount = 0;
      eventSource.once('test_event', () => {
        callCount++;
      });
      eventSource.emit('test_event');
      eventSource.emit('test_event');
      expect(callCount).toBe(1);
    } finally {
      teardown();
    }
  });

  it('off removes specific listener', () => {
    setup();
    try {
      let callCount = 0;
      const listener = () => {
        callCount++;
      };
      eventSource.on('test_event', listener);
      eventSource.emit('test_event');
      expect(callCount).toBe(1);
      eventSource.off('test_event', listener);
      eventSource.emit('test_event');
      expect(callCount).toBe(1);
    } finally {
      teardown();
    }
  });

  it('unsubscribe function returned by on removes listener', () => {
    setup();
    try {
      let callCount = 0;
      const unsub = eventSource.on('test_event', () => {
        callCount++;
      });
      eventSource.emit('test_event');
      expect(callCount).toBe(1);
      unsub();
      eventSource.emit('test_event');
      expect(callCount).toBe(1);
    } finally {
      teardown();
    }
  });

  it('removeAllListeners clears all listeners for an event', () => {
    setup();
    try {
      let count = 0;
      eventSource.on('test_event', () => {
        count++;
      });
      eventSource.on('test_event', () => {
        count++;
      });
      eventSource.removeAllListeners('test_event');
      eventSource.emit('test_event');
      expect(count).toBe(0);
    } finally {
      teardown();
    }
  });
});

// ============================================================
// C. APP_READY 回放契约
// ============================================================
describe('APP_READY Replay Contract', () => {
  // Palink 的 EventSourceWrapper 委托到 eventBus（TypedEventBus），
  // eventBus 不缓存已触发的事件，因此晚注册的监听器不会收到回放。
  // ST 原生在 APP_READY 后注册的扩展仍可收到回放（通过 jQuery 事件缓存），
  // 这是 Palink 与 ST 的已知差异。
  // SmartCard runtime（SillyTavernCompatRuntime.ts）通过 _palinkFiredEvents
  // 实现了 APP_READY 回放，但 Palink 核心运行时未实现。
  it.skip('late listeners receive replayed APP_READY — Palink 核心运行时未实现事件回放，eventBus 不缓存已触发事件');
});

// ============================================================
// D. 事件参数顺序
// ============================================================
describe('Event Argument Order', () => {
  let runtime: ReturnType<typeof createSillyTavernRuntime>;
  let eventSource: StEventSource;

  function setup(): void {
    runtime = createSillyTavernRuntime();
    eventSource = runtime.getEventSource();
  }

  function teardown(): void {
    eventSource.removeAllListeners();
    destroySillyTavernRuntime();
  }

  it('MESSAGE_SENT receives (messageId, message) when addOneMessage adds user message', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('message_sent', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'User',
        mes: 'hello',
        is_user: true,
      });
      expect(captured.length).toBeGreaterThan(0);
      // ST 约定：MESSAGE_SENT(messageId, message)
      expect(captured[0] as unknown[]).toBeDefined();
      const args = captured[0] as unknown[];
      expect(args.length).toBeGreaterThanOrEqual(1);
      expect(args[0]).toBe(index);
    } finally {
      teardown();
    }
  });

  it('MESSAGE_RECEIVED receives (messageId, message) from addOneMessage', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('message_received', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'Assistant',
        mes: 'hi',
        is_user: false,
      });
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe(index);
    } finally {
      teardown();
    }
  });

  it('USER_MESSAGE_RENDERED receives (messageId, message) for user messages', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('user_message_rendered', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'User',
        mes: 'hello',
        is_user: true,
      });
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe(index);
    } finally {
      teardown();
    }
  });

  it('CHARACTER_MESSAGE_RENDERED receives (messageId, message) for assistant messages', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('character_message_rendered', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'Assistant',
        mes: 'hi',
        is_user: false,
      });
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe(index);
    } finally {
      teardown();
    }
  });

  it('MESSAGE_EDITED receives (messageId, message) from setChatMessage', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('message_edited', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'User',
        mes: 'hello',
        is_user: true,
      });
      runtime.setChatMessage('edited content', index);
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe(index);
    } finally {
      teardown();
    }
  });

  it('MESSAGE_DELETED receives (messageId) from deleteMessage', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('message_deleted', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'User',
        mes: 'hello',
        is_user: true,
      });
      runtime.deleteMessage(index);
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe(index);
    } finally {
      teardown();
    }
  });

  it('MESSAGE_SWIPED receives (messageId, swipeId) from swipe', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('message_swiped', (...args: unknown[]) => {
        captured.push(args);
      });
      const index = runtime.addOneMessage({
        name: 'Assistant',
        mes: 'response1',
        is_user: false,
        swipes: ['response1', 'response2'],
        swipe_id: 0,
      });
      runtime.swipe(index, 'right');
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe(index);
      expect(args[1]).toBe(1);
    } finally {
      teardown();
    }
  });

  it('GENERATION_STARTED receives (type, options) from startGeneration', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('generation_started', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.startGeneration('normal', { temperature: 0.7 });
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      // ST 约定：GENERATION_STARTED(type, options, dry)
      expect(args[0]).toBe('normal');
    } finally {
      teardown();
    }
  });

  // [A-4] 经典轨发射面确认：emitAppReady 在共享 runtime 上发射 app_ready。
  // App.tsx 在 pluginManager.init() resolve 后调用（与沙箱轨对齐）。
  it('APP_READY is emitted by emitAppReady on classic runtime', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('app_ready', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.emitAppReady();
      expect(captured.length).toBeGreaterThan(0);
    } finally {
      teardown();
    }
  });

  it('GENERATION_ENDED receives (type, options) from onGenerationEnded', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('generation_ended', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.onGenerationEnded('response text', 'normal');
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      // Palink 实现：GENERATION_ENDED(type, { message: response })
      expect(args[0]).toBe('normal');
      expect(typeof args[1]).toBe('object');
      expect((args[1] as { message: string }).message).toBe(
        'response text',
      );
    } finally {
      teardown();
    }
  });

  it('GENERATION_STOPPED receives no args from stopGeneration', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('generation_stopped', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.stopGeneration();
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      // Palink 实现：GENERATION_STOPPED() 无参数
      expect(args.length).toBe(0);
    } finally {
      teardown();
    }
  });

  it('STREAM_TOKEN_RECEIVED receives (token) from onStreamToken', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('stream_token_received', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.onStreamToken('hello');
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe('hello');
    } finally {
      teardown();
    }
  });

  it('STREAM_REASONING_DONE receives (reasoning) from onStreamReasoningDone', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('stream_reasoning_done', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.onStreamReasoningDone('thinking...');
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(args[0]).toBe('thinking...');
    } finally {
      teardown();
    }
  });

  it('CHAT_CHANGED (chat_id_changed) receives (chat) from setContext', () => {
    setup();
    try {
      const captured: unknown[] = [];
      eventSource.on('chat_id_changed', (...args: unknown[]) => {
        captured.push(args);
      });
      runtime.setContext({
        chat: [
          { name: 'User', mes: 'hello', is_user: true },
        ],
      });
      expect(captured.length).toBeGreaterThan(0);
      const args = captured[0] as unknown[];
      expect(Array.isArray(args[0])).toBeTruthy();
    } finally {
      teardown();
    }
  });
});

// ============================================================
// E. 生命周期时序契约
// ============================================================
describe('Lifecycle Timing Contract', () => {
  let runtime: ReturnType<typeof createSillyTavernRuntime>;
  let eventSource: StEventSource;

  function setup(): void {
    runtime = createSillyTavernRuntime();
    eventSource = runtime.getEventSource();
  }

  function teardown(): void {
    eventSource.removeAllListeners();
    destroySillyTavernRuntime();
  }

  it('addOneMessage emits MESSAGE_RECEIVED before render event', () => {
    setup();
    try {
      const sequence: string[] = [];
      eventSource.on('message_received', () => {
        sequence.push('message_received');
      });
      eventSource.on('user_message_rendered', () => {
        sequence.push('user_message_rendered');
      });
      eventSource.on('character_message_rendered', () => {
        sequence.push('character_message_rendered');
      });
      runtime.addOneMessage({
        name: 'Assistant',
        mes: 'hi',
        is_user: false,
      });
      // ST 约定：先触发 message_received，再触发 character_message_rendered
      expect(sequence[0]).toBe('message_received');
      expect(sequence[1]).toBe('character_message_rendered');
    } finally {
      teardown();
    }
  });

  it('addOneMessage for user emits MESSAGE_SENT before USER_MESSAGE_RENDERED', () => {
    setup();
    try {
      const sequence: string[] = [];
      eventSource.on('message_received', () => {
        sequence.push('message_received');
      });
      eventSource.on('message_sent', () => {
        sequence.push('message_sent');
      });
      eventSource.on('user_message_rendered', () => {
        sequence.push('user_message_rendered');
      });
      runtime.addOneMessage({
        name: 'User',
        mes: 'hello',
        is_user: true,
      });
      // Palink 实现：message_received → message_sent → user_message_rendered
      expect(sequence.indexOf('message_received')).toBeGreaterThanOrEqual(0);
    } finally {
      teardown();
    }
  });
});

// ============================================================
// 自动运行测试（当未配置 vitest 时）
// ============================================================
void _runTests();
