/*
 * Regex Pipeline 三分支 / placement / 深度豁免 / trimStrings 宏 契约测试
 *
 * 权威对照 SillyTavern 1.18.0 `.codex/st-source/regex-engine.js:334-381`
 * getRegexedString：
 *   运行条件（三分支）:
 *     (markdownOnly && isMarkdown) ||
 *     (promptOnly && isPrompt) ||
 *     (!markdownOnly && !promptOnly && !isMarkdown && !isPrompt)
 *   即：普通脚本只在两个 flag 均为 falsy 的上下文运行（Palink 中该上下文
 *   等价于后端 persist 单点应用）；显示层（isMarkdown）只跑 markdownOnly；
 *   prompt 层只跑 promptOnly。
 *   placement: `script.placement.includes(placement)` —— 空数组不匹配任何位置。
 *   depth: minDepth >= -1 / maxDepth >= 0 边界豁免（regex-engine.js:362-372）。
 *   trimStrings: 先 substituteParams 宏替换再移除（engine.js:460，后端
 *   character_ext.py `_filter_trim_strings` 已对齐）。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/lib/sillytavern/__tests__/regex-pipeline-contract.test.ts
 */

// ============================================================
// 极简测试运行器（与 runtime-contract.test.ts 一致）
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
    } catch (err) {
      failed++;
      console.error(`  ✗ FAIL  ${tc.name}`);
      console.error(`          ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, ${skipped} 跳过 (共 ${_testCases.length})`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

// ============================================================
// 导入待测模块
// ============================================================
import {
  getRegexedString,
  regex_placement,
  type RegexScript,
} from '../runtime';

function mkScript(overrides: Partial<RegexScript>): RegexScript {
  return {
    scriptName: 't',
    findRegex: 'foo',
    replaceString: 'bar',
    placement: [regex_placement.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    ...overrides,
  } as RegexScript;
}

const AI_OUT = regex_placement.AI_OUTPUT;

// ============================================================
// A. 三分支判定（C-1）
// ============================================================
describe('Regex Three-Branch Semantics', () => {
  it('normal script does NOT run at display time (isMarkdown)', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar' })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true });
    expect(result).toBe('foo');
  });

  it('normal script does NOT run at prompt time (isPrompt)', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar' })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true });
    expect(result).toBe('foo');
  });

  it('markdownOnly script runs at display time', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', markdownOnly: true })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true });
    expect(result).toBe('bar');
  });

  it('markdownOnly script does NOT run at prompt time', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', markdownOnly: true })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true });
    expect(result).toBe('foo');
  });

  it('promptOnly script runs at prompt time only', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', promptOnly: true })];
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true })).toBe('bar');
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true })).toBe('foo');
  });

  // 后端 ephemeral 门对齐说明：persist 仅发生在后端（websocket.py:627），
  // 前端不存在 persist 写库场景；前端"两 flag 均 falsy"的调用（如插件事件
  // 载荷）保持 ST 第三分支原义——普通脚本可运行。此处锁定该行为。
  it('normal script runs in neither-flag context (ST third branch)', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar' })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts });
    expect(result).toBe('bar');
  });
});

// ============================================================
// B. placement 空数组语义（C-3）
// ============================================================
describe('Regex Placement Semantics', () => {
  it('empty placement array matches nothing (ST :374 includes)', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', placement: [] })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts });
    expect(result).toBe('foo');
  });

  it('non-matching placement skips script', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', placement: [regex_placement.USER_INPUT] })];
    const result = getRegexedString('foo', AI_OUT, { globalScripts: scripts });
    expect(result).toBe('foo');
  });
});

// ============================================================
// C. 深度边界豁免（C-4a）
//
// ST regex-engine.js:362-372 守卫语义：
//   仅当 minDepth >= -1 / maxDepth >= 0 时才参与深度比较；
//   负得离谱的边界值不参与比较（豁免），depth=-1 哨兵只受 minDepth=0 排除。
// ============================================================
describe('Regex Depth Boundary Exemption', () => {
  it('minDepth=-1 applies to all depths including 0', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', markdownOnly: true, minDepth: -1 })];
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true, depth: 0 })).toBe('bar');
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true, depth: 5 })).toBe('bar');
  });

  it('minDepth=0 excludes depth -1 (prompt tail sentinel)', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', promptOnly: true, minDepth: 0 })];
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true, depth: -1 })).toBe('foo');
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true, depth: 0 })).toBe('bar');
  });

  it('maxDepth=0 keeps depth 0, excludes deeper', () => {
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', promptOnly: true, maxDepth: 0 })];
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true, depth: 0 })).toBe('bar');
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isPrompt: true, depth: 3 })).toBe('foo');
  });

  it('out-of-range boundaries (< minDepth/-1 or < maxDepth/0) are exempt from depth checks', () => {
    // ST :363/:368 守卫：minDepth<-1 / maxDepth<0 不参与比较 → 任意深度都应用
    const scripts = [mkScript({ findRegex: 'foo', replaceString: 'bar', markdownOnly: true, minDepth: -5, maxDepth: -2 })];
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true, depth: 0 })).toBe('bar');
    expect(getRegexedString('foo', AI_OUT, { globalScripts: scripts, isMarkdown: true, depth: 9 })).toBe('bar');
  });
});

// ============================================================
// D. trimStrings 宏替换（C-4b）
//
// ST engine.js:457-465 filterString：trimString 先 substituteParams 再从
// 原始捕获文本中移除（内容宏解析在 trim 之后）。
// ============================================================
describe('Regex trimStrings Macro Substitution', () => {
  it('trim string containing {{user}} macro is substituted before removal', () => {
    const scripts = [
      mkScript({
        findRegex: '^(.*)$',
        replaceString: '$1',
        markdownOnly: true,
        trimStrings: ['{{user}}:'],
      }),
    ];
    // 模型输出里是已解析的名字；trimString 用宏书写以保持可移植性。
    // ST filterString 为纯 replaceAll，不清残留空格 → 权威结果为 ' hello'
    const result = getRegexedString('Alice: hello', AI_OUT, {
      globalScripts: scripts,
      isMarkdown: true,
      userName: 'Alice',
    });
    expect(result).toBe(' hello');
  });
});

_runTests();
