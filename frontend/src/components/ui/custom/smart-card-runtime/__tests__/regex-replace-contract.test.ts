/*
 * SmartCard Runtime $N 捕获组正则契约测试（P1-#3 复核结论）
 *
 * 权威对照 SillyTavern 1.18.0 regex engine：replaceString 的 $1/$<name>
 * 占位符必须由 /\$(\d+)|\$<([^>]+)>/g 替换（同 frontend/src/lib/regex-pipeline/
 * pipeline.ts:300 与 .codex/st-source/regex-engine.js:422）。
 *
 * ⚠️ SPEC 勘误（2026-08-23 实测）：SILLYTAVERN_COMPAT_SPEC_2026-08-23 §4 C-2
 * 称 "SillyTavernCompatRuntime.ts:2296 双反斜杠正则损坏" 系**误报**——该行位于
 * buildSillyTavernCompatRuntimeV2Shim() 的模板字符串内，TS 源码中的 `\\$` 经
 * 模板转义折叠后，生成产物的实际字面量是正确的 /\$(\d+)|\$<([^>]+)>/g。
 * 本测试锁定生成产物契约，防止未来重构（如改用 String.raw 或外移出模板）
 * 时无声破坏该转义。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/components/ui/custom/smart-card-runtime/__tests__/regex-replace-contract.test.ts
 */

// ============================================================
// 极简测试运行器（与 event-contract.test.ts 一致）
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
    toBeTruthy(): void {
      if (!actual) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be truthy`);
      }
    },
    toBeFalsy(): void {
      if (actual) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be falsy`);
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
  if (failed > 0) {
    process.exitCode = 1;
  }
}

// ============================================================
// 导入待测模块并构建 shim 产物
// ============================================================
import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

const shim = buildSillyTavernCompatRuntimeV2Shim({
  context: {} as any,
  frameId: 'contract-test',
  sourceHtml: '<div></div>',
  mode: 'inline',
} as any);

describe('SmartCard Runtime $N Replace Contract', () => {
  it('generated shim contains the correct /\\$(\\d+)|\\$<([^>]+)>/g literal', () => {
    // 模板转义折叠后生成产物应为单反斜杠形态（正确匹配 "$1" / "$<name>"）
    expect(shim.includes('result.replace(/\\$(\\d+)|\\$<([^>]+)>/g')).toBeTruthy();
  });

  it('generated shim does NOT contain a double-backslash (broken) variant', () => {
    // 若未来把该代码移出模板字符串而未同步改字面量，会出现真正的 \\$ 损坏形态
    expect(shim.includes('/\\\\$(\\\\d+)')).toBeFalsy();
  });

  it('extracted literal behaves correctly on $1 placeholders', () => {
    // 定位生成产物中的目标 replace 调用，取出正则字面量本体并实测替换行为
    const marker = 'result.replace(/\\$(\\d+)|\\$<([^>]+)>/g';
    const at = shim.indexOf(marker);
    expect(at >= 0 ? true : false).toBeTruthy();
    const litStart = shim.indexOf('/', at);
    const litEnd = shim.indexOf('/g,', litStart) + 2;
    const lit = shim.slice(litStart, litEnd);
    const parsed = /^\/(.*)\/([gimsuy]*)$/.exec(lit);
    expect(parsed === null ? false : true).toBeTruthy();
    const re = new RegExp((parsed as RegExpExecArray)[1], (parsed as RegExpExecArray)[2]);
    // 行为验证一：能捕获 "$1" 的数字部分（损坏形态 /\\$(\d+)/ 匹配不到任何内容）
    const first = re.exec('value=$1;') as RegExpExecArray;
    expect(first[1]).toBe('1');
    // 行为验证二：命名组分支 "$<name>" 可命中（/g 有 lastIndex 状态，先归零）
    re.lastIndex = 0;
    const second = re.exec('v=$<name>') as RegExpExecArray;
    expect(second[2]).toBe('name');
  });
});

void _runTests();
