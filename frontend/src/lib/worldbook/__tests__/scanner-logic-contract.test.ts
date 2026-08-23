/*
 * 前端世界书 Scanner selectiveLogic 语义契约测试（P1-#9 / spec D-8）
 *
 * 权威对照 SillyTavern 1.18.0 world-info.js:4800-4866：
 * - 主关键词 plain 匹配（任一命中即推进，selectiveLogic 不参与）；
 * - 主键命中 + 无有效副键 = 直接激活（:4817-4822）；
 * - selectiveLogic 四态只作用于副键匹配结果：
 *   AND_ANY(0) 任一副键命中 / NOT_ALL(1) 存在未命中副键 /
 *   NOT_ANY(2) 全部副键未命中 / AND_ALL(3) 全部副键命中。
 *
 * 旧实现把 logic 错位作用于主键：NOT_ANY 条目在主键命中时恒被拒绝
 * （"排除型"条目在前端永不激活），AND_ALL 变成"主键须全中"。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/lib/worldbook/__tests__/scanner-logic-contract.test.ts
 */

// ============================================================
// 极简测试运行器
// ============================================================
type TestFn = () => void | Promise<void>;
interface TestCase {
  name: string;
  fn: TestFn;
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
  });
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown): void {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
      }
    },
    toBeTruthy(): void {
      if (!actual) {
        throw new Error(`Expected ${String(actual)} to be truthy`);
      }
    },
  };
}

async function _runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const tc of _testCases) {
    try {
      await tc.fn();
      passed++;
      console.log(`  ✓ PASS  ${tc.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ FAIL  ${tc.name}`);
      console.error(`          ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败 (共 ${_testCases.length})`);
  if (failed > 0) process.exitCode = 1;
}

import { WorldBookScanner } from '../scanner';
import type { WorldBookEntry, ScanContext, WorldInfoLogic } from '../types';

function mkEntry(overrides: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    id: 'e1',
    uid: 1,
    key: ['dragon'],
    keysecondary: [],
    content: 'lore',
    comment: '',
    selectiveLogic: 0 as WorldInfoLogic,
    selective: false,
    constant: false,
    vectorized: false,
    position: 0 as WorldBookEntry['position'],
    depth: 4,
    order: 0,
    scanDepth: null,
    caseSensitive: false,
    matchWholeWords: false,
    useGroupScoring: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    probability: 100,
    group: '',
    groupOverride: false,
    groupWeight: 0,
    decorators: [],
    addMemo: false,
    enabled: true,
    excludeRecursion: false,
    preventRecursion: false,
    ...overrides,
  } as WorldBookEntry;
}

const CONTEXT: ScanContext = {
  messages: ['a dragon appears in the mountains'],
} as ScanContext;

const scanner = new WorldBookScanner();

describe('Scanner Primary/Secondary Logic (ST world-info.js:4800-4866)', () => {
  it('primary hit + no secondary keys → activates regardless of logic', () => {
    // 旧实现：NOT_ANY + 主键命中 → 恒拒绝（永不激活的排除型条目）
    const entry = mkEntry({ selectiveLogic: 2, selective: false, keysecondary: [] });
    const result = scanner.scan([entry], CONTEXT);
    expect(result.entries.length).toBe(1);
  });

  it('NOT_ANY: activates when NO secondary keyword matched', () => {
    const entry = mkEntry({
      selective: true,
      selectiveLogic: 2,
      keysecondary: ['unicorn'],
    });
    expect(scanner.scan([entry], CONTEXT).entries.length).toBe(1);
  });

  it('NOT_ANY: suppressed when a secondary keyword DID match', () => {
    const entry = mkEntry({
      selective: true,
      selectiveLogic: 2,
      keysecondary: ['mountains'],
    });
    expect(scanner.scan([entry], CONTEXT).entries.length).toBe(0);
  });

  it('AND_ANY: activates when any secondary matched', () => {
    const entry = mkEntry({
      selective: true,
      selectiveLogic: 0,
      keysecondary: ['unicorn', 'mountains'],
    });
    expect(scanner.scan([entry], CONTEXT).entries.length).toBe(1);
  });

  it('AND_ALL: requires ALL secondary keywords matched', () => {
    const all = mkEntry({ selective: true, selectiveLogic: 3, keysecondary: ['dragon', 'mountains'] });
    const partial = mkEntry({ id: 'e2', selective: true, selectiveLogic: 3, keysecondary: ['mountains', 'unicorn'] });
    const result = scanner.scan([all, partial], CONTEXT);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].id).toBe('e1');
  });

  it('NOT_ALL: activates when at least one secondary NOT matched', () => {
    const entry = mkEntry({
      selective: true,
      selectiveLogic: 1,
      keysecondary: ['mountains', 'unicorn'],
    });
    expect(scanner.scan([entry], CONTEXT).entries.length).toBe(1);
  });

  it('primary miss → never activated even with permissive logic', () => {
    const entry = mkEntry({ key: ['griffin'], selectiveLogic: 2, selective: false });
    expect(scanner.scan([entry], CONTEXT).entries.length).toBe(0);
  });

  it('matched keywords include primary and matched secondary', () => {
    const entry = mkEntry({
      selective: true,
      selectiveLogic: 0,
      keysecondary: ['mountains'],
    });
    const result = scanner.scan([entry], CONTEXT);
    const kws = result.matchedKeywords.get('e1') || [];
    expect(kws.includes('dragon') && kws.includes('mountains')).toBeTruthy();
  });
});

void _runTests();
