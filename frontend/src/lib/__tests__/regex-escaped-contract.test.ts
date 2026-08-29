/*
 * A1【P1-1】正则 ESCAPED 逐值转义契约测试。
 *
 * ST 1.18.0 真值：
 *   - extensions/regex/engine.js:402-403 substitute_find_regex.ESCAPED =
 *     substituteParamsExtended(findRegex, {}, sanitizeRegexMacro)——postProcessFn
 *     只作用于每个宏替换值（script.js:2756-2758），findRegex 模式本体不做整串转义。
 *   - 后端正确实现：backend/app/api/character_ext.py:1157-1163（逐值转义）。
 *   - 历史缺陷：前端 pipeline.ts applyStScript 与 sillytavern/regex/engine.ts
 *     runRegexScript 先整串 substituteParams，再对整个 findRegex 整串
 *     sanitize → 模式本体的 () 分组与 \w 量词被转义，显示层必然失配。
 *
 * 运行: cd frontend && npx vitest run src/lib/__tests__/regex-escaped-contract.test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runRegexScript } from '../sillytavern/regex/engine';
import type { RegexScript } from '../sillytavern/regex/engine';
import { RegexPipeline } from '../regex-pipeline/pipeline';
import { RegexPlacement } from '../regex-pipeline/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_SOURCE = readFileSync(
  join(__dirname, '..', 'regex-pipeline', 'pipeline.ts'),
  'utf-8',
);
const ENGINE_SOURCE = readFileSync(
  join(__dirname, '..', 'sillytavern', 'regex', 'engine.ts'),
  'utf-8',
);

// ============================================================
// 源码契约：ESCAPED 分支存在逐值转义，整串 sanitize 调用点消失
// ============================================================

describe('A1 源码契约：ESCAPED 逐值转义', () => {
  it('pipeline.ts：不再对 findRegex 整串 sanitize，存在逐值转义实现', () => {
    expect(PIPELINE_SOURCE.includes('stSanitizeRegexMacro(findRegexSource)')).toBe(false);
    expect(PIPELINE_SOURCE.includes('stSubstituteParamsEscaped')).toBe(true);
  });

  it('engine.ts：不再对 findRegex 整串 sanitize，存在逐值转义实现', () => {
    expect(ENGINE_SOURCE.includes('sanitizeRegexMacro(findRegexSource)')).toBe(false);
    expect(ENGINE_SOURCE.includes('substituteParamsEscaped')).toBe(true);
  });
});

// ============================================================
// 行为契约：substituteRegex=2 模式本体不被转义、宏替换值被转义
// ============================================================

describe('A1 行为：ESCAPED（substituteRegex=2）', () => {
  it('engine.ts runRegexScript：含分组与量词的模式 + 特殊字符用户名正常匹配', () => {
    const script: RegexScript = {
      scriptName: 'escaped-contract',
      findRegex: '{{user}} says (\\w+)',
      replaceString: '$1',
      substituteRegex: 2,
    };
    // 用户名含正则特殊字符 ( ) 与数字：宏值须转义后才能字面匹配；
    // 模式本体的 (\w+) 分组必须存活，$1 才能取出 hello。
    const out = runRegexScript(script, 'Rex(1) says hello', { userName: 'Rex(1)' });
    expect(out).toBe('hello');
  });

  it('engine.ts runRegexScript：{{match}}→$0 与捕获组既有流程不破坏', () => {
    const script: RegexScript = {
      scriptName: 'escaped-quoted',
      findRegex: '{{char}}\\s*:\\s*"(.+?)"',
      replaceString: '[$1]',
      substituteRegex: 2,
    };
    // char 名含正则特殊字符 . ：须转义后匹配字面 "Miku.v2"；
    // \s 与量词须存活，$1 才能捕获引号内文本。
    const out = runRegexScript(script, 'Miku.v2: "hi"', { characterName: 'Miku.v2' });
    expect(out).toBe('[hi]');
  });

  it('pipeline.ts applyStScript（processFlatScripts）：与 engine.ts 语义一致', () => {
    const pipeline = new RegexPipeline();
    const out = pipeline.processFlatScripts(
      'Rex(1) says hello',
      [{
        scriptName: 'escaped-pipeline',
        findRegex: '{{user}} says (\\w+)',
        replaceString: '$1',
        substituteRegex: 2,
        placement: [RegexPlacement.AI_OUTPUT],
      }],
      { placement: [RegexPlacement.AI_OUTPUT], userName: 'Rex(1)' },
    );
    expect(out).toBe('hello');
  });
});

// ============================================================
// 守卫：RAW / NONE 分支行为不变
// ============================================================

describe('A1 守卫：RAW 与 NONE 分支不受影响', () => {
  it('RAW（substituteRegex=1）宏值原样替换不转义（含 $ 分组语义）', () => {
    const script: RegexScript = {
      scriptName: 'raw-guard',
      findRegex: '{{user}} says (\\w+)',
      replaceString: '$1',
      substituteRegex: 1,
    };
    // RAW 原样：{{user}}→Rex(1) 不转义，其中 (1) 被解释为捕获组（匹配字符
    // "1" 而非字面括号，ST 同款 RAW 语义，锁定防波及），$1 捕获 "1"。
    const out = runRegexScript(script, 'Rex1 says hi', { userName: 'Rex(1)' });
    expect(out).toBe('1');
  });

  it('NONE（substituteRegex=0）宏不替换、模式原样生效', () => {
    const script: RegexScript = {
      scriptName: 'none-guard',
      findRegex: '\\{\\{user\\}\\} says (\\w+)',
      replaceString: '$1',
      substituteRegex: 0,
    };
    const out = runRegexScript(script, '{{user}} says yo', { userName: 'Rex(1)' });
    expect(out).toBe('yo');
  });
});
