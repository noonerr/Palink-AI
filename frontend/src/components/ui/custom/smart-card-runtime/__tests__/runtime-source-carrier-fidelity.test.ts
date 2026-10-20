/*
 * 测试载体保真守卫（包L · 2026-10-18）
 *
 * 要防的事故：**测试载体与生产不同语义 ⇒ 本地永远绿、线上永远坏。**
 *
 * 起因（可复跑的证据）：`compat-v2-runtime-source.ts` 的载体一是 readFileSync 拼出来的
 * **未求值源码文本**，而 11 个测试文件把这份文本的切片喂进 `new Function` 执行并断言行为。
 * 运行时体本身是模板字符串 —— 想让 iframe 看到「反斜杠 + d」，源码里必须写**两个**反斜杠；
 * 只写一个，模板求值会把反斜杠吞掉。于是同一段代码在两个载体里正则语义相反：
 *   载体一 `/^\d+$/` = 一位以上数字（测试跑出来是对的）
 *   载体二 `/^d+$/`   = 只匹配字母 d（线上就是这个，那条分支永不命中）
 * 包H 查到的 part-07 `normalizeCompatEntries` 正是这一类，而改前本地 463 例全绿（实测见报告）。
 *
 * 本文件把「保真」变成机器可查的四组断言：
 *   A 两个载体的身份（谁是生产产物、谁是源码文本）
 *   B 生产产物自身可解析、且没被求值塞进控制字符
 *   C 反斜杠丢失点登记表（新代码写错转义立刻红；已修坐标另有回归钉）
 *   D 载体使用纪律（执行型测试必须用载体二）
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/runtime-source-carrier-fidelity.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSmartCardCompatRuntimeExternalScript } from '../SillyTavernCompatRuntime';
import {
  COMPAT_V2_RUNTIME_SOURCE,
  COMPAT_V2_RUNTIME_ARTIFACT,
} from './compat-v2-runtime-source';

const BS = String.fromCharCode(92);   // 反斜杠：一律用 charCode 取，避免本文件自己踩转义
const BT = String.fromCharCode(96);   // 反引号
const SQ = String.fromCharCode(39);   // 单引号
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const PARTS_RELATIVE_DIR = 'src/components/ui/custom/smart-card-runtime/runtime-body';
const TESTS_RELATIVE_DIR = 'src/components/ui/custom/smart-card-runtime/__tests__';
const PARTS = ['part-01.ts', 'part-02.ts', 'part-03.ts', 'part-04.ts', 'part-05.ts',
  'part-06.ts', 'part-07.ts', 'part-08.ts'];

const readPart = (file: string) => readFileSync(join(process.cwd(), PARTS_RELATIVE_DIR, file), 'utf8');
const testFiles = (): string[] => readdirSync(join(process.cwd(), TESTS_RELATIVE_DIR))
  .filter((name) => name.endsWith('.test.ts'))
  .sort();
const readTestFile = (name: string) => readFileSync(join(process.cwd(), TESTS_RELATIVE_DIR, name), 'utf8');

/**
 * 切出段文件里那**一个**模板字符串的原文（首尾反引号之间）。
 * 结构前提由 C0 逐段钉住：每个段文件恰好一对未转义反引号。
 */
function templateBodyOf(text: string): { body: string; firstBodyLine: number } {
  const open = text.indexOf(BT);
  const close = text.lastIndexOf(BT);
  expect(open, '模板起始反引号未找到').toBeGreaterThan(-1);
  expect(close, '模板收尾反引号未找到').toBeGreaterThan(open);
  return {
    body: text.slice(open + 1, close),
    firstBodyLine: text.slice(0, open).split(LF).length,
  };
}

/**
 * 模板体里「会被求值吞掉/改写」的单反斜杠位点。
 * 合法的只有四种：成对反斜杠（产物里留一个）、反引号转义、美元符转义、`\uXXXX`（分库内
 * 中文提示语就是这么写的）。其余（d s w b n t r f v 0 与标点）在模板里都是**写错**：
 * 求值后要么反斜杠消失，要么塞进一个控制字符。
 */
function findEatenBackslashes(body: string, firstBodyLine: number) {
  const legitNext = new Set([BS, BT, '$', 'u']);
  const hits: Array<{ line: number; seq: string; text: string }> = [];
  body.split(LF).forEach((rawLine, idx) => {
    const line = rawLine.endsWith(CR) ? rawLine.slice(0, -1) : rawLine;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== BS) continue;
      const next = line[i + 1];
      if (next === BS) { i += 1; continue; }
      if (next !== undefined && legitNext.has(next)) continue;
      hits.push({
        line: firstBodyLine + idx,
        seq: BS + (next === undefined ? 'EOL' : next),
        text: line.trim().slice(0, 120),
      });
    }
  });
  return hits;
}

/**
 * 已知反斜杠丢失登记（**登记表外的新命中一律红**；修完请把登记项删掉）。
 * 定位用代码片段而不是行号 —— part-08 正被并行包改动，行号会漂。
 */
/**
 * 已知反斜杠丢失登记（**登记表外的新命中一律红**；修完请把登记项删掉）。
 * 定位用代码片段而不是行号 —— part-08 正被并行包改动，行号会漂。
 *
 * 包L 登记的两处 part-08 缺陷已由包J 于 2026-10-18 改成成对反斜杠，登记表**清空**。
 * 表本身留着：C1 的口径是「表外一个都不许多」，将来谁再写单反斜杠就在这里挂号。
 * 修完的两处语义由 C3（文本钉）+ C4/C5（求值后载体的行为断言）守住。
 */
const KNOWN_ESCAPE_LOSS: Array<{ part: string; seq: string; fragment: string; owner: string }> = [];
const knownKey = (part: string, seq: string, fragment: string) => `${part} | ${seq} | ${fragment}`;

// ============================================================
// A 两个载体各自是谁
// ============================================================
describe('A 载体身份 —— 谁是生产产物、谁是源码文本', () => {
  it('A1 载体二逐字节等于生产入口 buildSmartCardCompatRuntimeExternalScript() 的返回值', () => {
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toBe(buildSmartCardCompatRuntimeExternalScript());
  });

  it('A2 载体二里没有未求值的 bootHeader 占位与 TS 壳，且两处插值都已落成真源码', () => {
    // 注意：part-03 的注释里**故意**写了转义过的占位名（`\${VARIABLES_COMPAT_SOURCE}`），
    // 求值后产物里仍能看到该字样 —— 所以这里判的是「插值的真内容进来了」，不是字样消失。
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain('$' + '{bootHeader}');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain('export const RUNTIME_BODY_PART');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain('runtimeBodyPart01(bootHeader)');
    // IDB 分库垫片（${IDB_NS_RUNTIME_SOURCE}）与变量兼容层（${VARIABLES_COMPAT_SOURCE}）
    // 的函数体确实在产物里
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain('var sanitizeIdbSuffix = function (raw) {');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain('const getVariableWithPriorityCompat = (');
  });

  it('A3 载体一保留占位与宿主 TS 头（这是它存在的理由，不许改成求值后文本）', () => {
    expect(COMPAT_V2_RUNTIME_SOURCE).toContain('$' + '{bootHeader}');
    expect(COMPAT_V2_RUNTIME_SOURCE).toContain('export function buildSillyTavernCompatRuntimeV2Shim');
    // boot payload 白名单这类断言只能靠载体一：宿主 TS 侧代码不在注入产物里
    expect(COMPAT_V2_RUNTIME_SOURCE).toContain("worldbookName: context.worldbookName || ''");
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain("worldbookName: context.worldbookName || ''");
  });

  it('A4 三口径之「行尾」：源文件是 CRLF，模板求值按规范归一成 LF ⇒ 跨载体逐字节比对必须先归一', () => {
    expect(COMPAT_V2_RUNTIME_SOURCE).toContain(CR + LF);
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain(CR);
  });
});

// ============================================================
// B 生产产物自身的可执行性（整帧白屏级守卫）
// ============================================================
describe('B 生产产物可解析、没被求值塞进控制字符', () => {
  it('B1 求值后运行时体能被 JS 解析（单反斜杠 n 会把换行塞进字符串字面量 → SyntaxError → 整帧白屏）', () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(COMPAT_V2_RUNTIME_ARTIFACT)).not.toThrow();
  });

  it('B2 产物里除 LF 之外没有控制字符（被求值塞进来的反斜杠 b f v t r 0 x 都会在这里现形）', () => {
    const found: string[] = [];
    for (let i = 0; i < COMPAT_V2_RUNTIME_ARTIFACT.length; i += 1) {
      const code = COMPAT_V2_RUNTIME_ARTIFACT.charCodeAt(i);
      if (code === 10) continue;
      if (code < 32) found.push(`${code}@${i}`);
    }
    expect(found.slice(0, 5)).toEqual([]);
  });

  it('B3 反证锚点：登记口径确实抓得住「少写一个反斜杠」', () => {
    const correct = `  const re = /^${BS}${BS}d+$/;` + LF;   // 模板里成对写 → 产物里是「反斜杠 d」
    const broken = `  const re = /^${BS}d+$/;` + LF;         // 少写一个 → 产物里只剩字母 d
    expect(findEatenBackslashes(correct, 1)).toEqual([]);
    const hits = findEatenBackslashes(broken, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].seq).toBe(BS + 'd');
  });
});

// ============================================================
// C 反斜杠三口径登记表
// ============================================================
describe('C 段文件模板体里「会被求值吃掉」的写法必须逐项在登记表中', () => {
  it('C0 结构前提：每个段文件恰好一对未转义反引号（模板体边界可靠）', () => {
    PARTS.forEach((file) => {
      const text = readPart(file);
      let total = 0;
      let unescaped = 0;
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== BT) continue;
        total += 1;
        if (i === 0 || text[i - 1] !== BS) unescaped += 1;
      }
      expect({ file, total, unescaped }, `${file} 必须只有一对模板反引号`).toEqual({
        file, total: 2, unescaped: 2,
      });
    });
  });

  it('C1 登记表外一个都不许多（新写单反斜杠转义 = 生产语义坏 = 立刻红）', () => {
    const unknown: string[] = [];
    const matchedKeys: string[] = [];
    PARTS.forEach((file) => {
      const { body, firstBodyLine } = templateBodyOf(readPart(file));
      findEatenBackslashes(body, firstBodyLine).forEach((hit) => {
        const known = KNOWN_ESCAPE_LOSS.find(
          (k) => k.part === file && k.seq === hit.seq && hit.text.includes(k.fragment),
        );
        if (known) matchedKeys.push(knownKey(known.part, known.seq, known.fragment));
        else unknown.push(`${file}:${hit.line} ${hit.seq} ${hit.text}`);
      });
    });
    expect(unknown, '新增的反斜杠丢失点（写成单反斜杠会被模板求值吞掉）').toEqual([]);
    expect([...new Set(matchedKeys)].sort())
      .toEqual(KNOWN_ESCAPE_LOSS.map((k) => knownKey(k.part, k.seq, k.fragment)).sort());
  });

  it('C2 包L 修复的生产语义回归钉：part-07 下标键还原在产物里必须是「数字」正则', () => {
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain(`/^${BS}d+$/`);
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain('/^d+$/');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain('const normalizeCompatEntries = (result) => {');
  });

  it('C3 包J 修复的文本钉：part-08 两处空白正则在生产产物里必须是「空白字符类」形态', () => {
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain('split(/' + BS + 's+/)');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain('split(/s+/)');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain('replace(/' + BS + 's+/g, ' + SQ + ' ' + SQ + ')');
    expect(COMPAT_V2_RUNTIME_ARTIFACT).not.toContain('replace(/s+/g, ' + SQ + ' ' + SQ + ')');
  });

  /**
   * 从**求值后产物**里把一行表达式的右值抠出来，交给 new Function 真跑。
   * C4/C5 用它做行为断言 —— 包L 的教训是「源码里有某个字面量」不等于生产行为对，
   * 而抠出来的这段文本已经是 iframe 真正拿到的那一份（反斜杠只剩一个）。
   * 入参只允许来自本仓构建产物 COMPAT_V2_RUNTIME_ARTIFACT（自家代码，非任何外部/用户数据）。
   */
  function execExpressionFromArtifact(marker: string, prefix: string, argName: string) {
    const line = COMPAT_V2_RUNTIME_ARTIFACT.split(LF)
      .find((rawLine) => rawLine.includes(marker));
    expect(line, `产物里找不到锚点：${marker}`).toBeTruthy();
    const start = String(line).indexOf(prefix) + prefix.length;
    const expr = String(line).slice(start).trim().replace(/[;,]+$/, '');
    expect(expr.length, `锚点 ${marker} 抠出的表达式为空`).toBeGreaterThan(0);
    // eslint-disable-next-line no-new-func
    if (argName) return new Function(argName, 'return (' + expr + ');');
    // eslint-disable-next-line no-new-func
    return new Function('return (' + expr + ');')();
  }

  it('C4 行为断言（包J J-3）：产物里的 getTextTokens 真的按空白切词，不是按字母 s 切', () => {
    const getTextTokens = execExpressionFromArtifact(
      'getTextTokens: (text) =>', 'getTextTokens: ', '',
    ) as (text: unknown) => string[];
    // 单反斜杠写法（split(/s+/)）在下面这条输入上返回 1 项 —— 改坏必红已实测，见包J 报告
    expect(getTextTokens('alpha   beta\n  gamma\tdelta')).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(getTextTokens('你好 世界')).toEqual(['你好', '世界']);
    expect(getTextTokens('')).toEqual([]);
    expect(getTextTokens(null)).toEqual([]);
  });

  it('C5 行为断言（包J J-3）：产物里的卡内错误摘要真的折叠空白，多行 stack 不挤成一行噪声', () => {
    const fold = execExpressionFromArtifact(
      'String(first.message', 'return ', 'first',
    ) as (first: { message?: string }) => string;
    expect(fold({ message: 'Error  at line1\n  at line2' })).toBe('Error at line1 at line2');
    expect(fold({ message: 'a\n\n\nb' })).toBe('a b');
    expect(fold({})).toBe('');
    expect(fold({ message: 'x '.repeat(200) })).toHaveLength(160);
  });
});

// ============================================================
// D 载体使用纪律
// ============================================================
describe('D 载体使用纪律 —— 执行型测试不许再吃未求值文本', () => {
  /**
   * 允许「同时 import 载体一、且文件里出现 new Function」的文件：
   * 它们的 new Function 入参全部来自**求值后**来源（载体二 / `RUNTIME_BODY_PART_xx` 常量 /
   * `LEGACY_ST_SIM_SEGMENT` / `buildShim()` 产物），载体一只服务字符串断言。
   * 新增此类文件必须先在这张表里写清「它的 new Function 入参来自哪个求值后来源」，
   * 否则本条红 —— 表本身就是那道人工评审的门。
   */
  const MIXED_CARRIER_FILES: Record<string, string> = {
    'g-getcontext-and-libs-contract.test.ts':
      '执行入参来自求值后的 RUNTIME_BODY_PART_08（文件内 :36-38 已写明两载体分工）；载体一只做文本契约断言。',
    'i-resource-load-failure-contract.test.ts':
      '执行入参来自求值后的 RUNTIME_BODY_PART_08；载体一只做「handler 注册行存在」的字符串断言。',
    'worldbook-boot-inline-contract.test.ts':
      '执行入参来自 buildShim() 产物与载体二；载体一只服务宿主 TS 侧 boot payload 白名单断言。',
    'h-tavernhelper-134-contract.test.ts':
      '执行入参是载体二；载体一只服务「H 段源码里一个裸反斜杠都没有」这条**写法纪律**断言，'
      + '且同一用例已实测两载体在该区域逐字节一致（归一行尾后）。',
    'runtime-source-carrier-fidelity.test.ts':
      '本文件：new Function 只用来解析载体二；载体一是被审计对象本身。',
    // [批次Q1 2026-10-21] 新增的 new Function **不吃运行时载体**：入参是
    // CharacterCardRenderer.tsx 里那段 `sandbox` 表达式（从渲染器 TSX 源码切片）。
    // 那段表达式不在任何外层模板串里，浏览器拿到的就是同一份文本 ⇒ new Function 执行它
    // 与生产求值逐字同义（区域内无裸反斜杠、无二次插值）。载体一只继续服务 B1-B9 的字符串断言。
    'frame-security-and-migration-contract.test.ts':
      '执行入参是渲染器 TSX 源码里的 sandbox 表达式（不是运行时载体，无外层模板串包裹）；载体一只服务字符串契约断言。',
  };

  /** 包L 已迁移的执行型测试（切片来自载体二）。 */
  const MIGRATED_EXECUTION_TESTS = [
    'b-package-slash-and-context-contract.test.ts',
    'f-package-slash-enum-contract.test.ts',
    'frame-getchatmessages-id-lookup.test.ts',
    'getcharworldbooknames-contract.test.ts',
    'h-tavernhelper-134-contract.test.ts',
    'lorebook-family-contract.test.ts',
    'st-compat-fix-batch-contract.test.ts',
    'style-guard-inframe-contract.test.ts',
    'worldbook-boot-inline-contract.test.ts',
  ];

  it('D1 import 载体一且文件里出现 new Function 的测试文件，必须在混合载体白名单里', () => {
    const offenders: string[] = [];
    testFiles().forEach((name) => {
      const text = readTestFile(name);
      if (!text.includes('COMPAT_V2_RUNTIME_SOURCE') || !text.includes('new Function(')) return;
      if (!MIXED_CARRIER_FILES[name]) offenders.push(name);
    });
    expect(offenders, '这些文件把未求值文本喂进了 new Function（执行型测试必须用载体二）').toEqual([]);
  });

  it('D1b 白名单不欠账：每条都写明了理由，且文件仍在用载体一（改干净了就请把条目删掉）', () => {
    Object.entries(MIXED_CARRIER_FILES).forEach(([name, reason]) => {
      expect(reason.length, `${name} 的混用理由为空`).toBeGreaterThan(20);
      expect(readTestFile(name), `${name} 已不再 import 载体一，白名单条目该删`).toContain('COMPAT_V2_RUNTIME_SOURCE');
    });
  });

  it('D2 包L 迁移的 9 份执行型测试都改用求值后载体', () => {
    MIGRATED_EXECUTION_TESTS.forEach((name) => {
      expect(readTestFile(name), `${name} 必须 import 载体二`).toContain('COMPAT_V2_RUNTIME_ARTIFACT');
    });
  });

  it('D3 载体一没有被「顺手删掉」（字符串断言族仍需要它：占位与宿主 TS 头只在它里面）', () => {
    const rawUsers = testFiles().filter((name) => readTestFile(name).includes('COMPAT_V2_RUNTIME_SOURCE'));
    ['frame-security-and-migration-contract.test.ts', 'g-getcontext-and-libs-contract.test.ts',
      'worldbook-boot-inline-contract.test.ts', 'h-tavernhelper-134-contract.test.ts']
      .forEach((name) => expect(rawUsers, `载体一使用者缺了 ${name}`).toContain(name));
  });
});
