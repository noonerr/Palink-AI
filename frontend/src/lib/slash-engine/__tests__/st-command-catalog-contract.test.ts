/*
 * 包 F F-1 · ST 命令权威名单的仓库内守卫（2026-10-18）
 *
 * 为什么要有这个文件：交接单口径里的「289 权威名」原本只活在 `.tmp_probe/st289.json`
 * （探针目录、不入库），而上一位 agent 从 ST 1.18 参照源码静态抽出来的真值表是 293 名。
 * 两份东西用途不同，都必须进仓库，否则下一个人只能靠"文件名猜权威"：
 *
 *   - `frontend/src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json`
 *     = **权威来源**（静态抽取，含 core/extension 分桶与 aliases）；
 *   - `frontend/src/lib/slash-engine/__tests__/fixtures/st289-names.json`
 *     = **探针口径**（`.tmp_probe/probe-parity3.js` 用的 289 名，真机 covered_in 的分母）。
 *
 * 本文件守三件事：
 *   1. 宿主注入给帧内的种子（st-command-catalog.ts）与权威 fixture 逐字相等 —— 漂移即红；
 *   2. 探针口径 289 名 ⊆ 权威 293 名（探针分母不会大于真值表）；
 *   3. 红线：C/D 类（ST UI / ST 私有数据模型）**没有**被注册进宿主引擎，
 *      执行时报 "Unknown command"，不是返回空串的假成功。
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/st-command-catalog-contract.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ST_118_COMMAND_NAMES, getStCompatCommandNames } from '@/lib/slash-engine/st-command-catalog';
import { SlashCommandEngine } from '@/lib/slash-engine';
import { ensureSlashCommandsBootstrapped } from '@/lib/slash-engine/bootstrap';

/** vitest 固定以 frontend/ 为 cwd 运行。 */
const readJson = (relativePath: string): any => JSON.parse(
  readFileSync(join(process.cwd(), relativePath), 'utf8'),
);

const AUTHORITY = readJson('src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json');
const PROBE_289 = readJson('src/lib/slash-engine/__tests__/fixtures/st289-names.json');

describe('F-1 权威名单 fixture 自身', () => {
  it('静态真值表：core 220 / extension 73 / 唯一名 293 / aliases 176', () => {
    expect(AUTHORITY.core.length).toBe(220);
    expect(AUTHORITY.extension.length).toBe(73);
    expect(AUTHORITY.commands.length).toBe(293);
    expect(new Set(AUTHORITY.commands).size).toBe(293);
    expect(AUTHORITY.aliases.length).toBe(176);
    // 唯一名 = core ∪ extension（口径写死在 fixtures/README.md，别默默改）
    expect([...AUTHORITY.commands].sort()).toEqual(
      Array.from(new Set<string>([...AUTHORITY.core, ...AUTHORITY.extension])).sort(),
    );
  });

  it('探针口径 289 名 ⊆ 权威 293 名（缺的那 4 个是解析器内部名）', () => {
    expect(PROBE_289.length).toBe(289);
    expect(new Set(PROBE_289).size).toBe(289);
    const authority = new Set<string>(AUTHORITY.commands as string[]);
    const missingFromAuthority = (PROBE_289 as string[]).filter((n) => !authority.has(n));
    expect(missingFromAuthority).toEqual([]);
    const extra = (AUTHORITY.commands as string[]).filter((n) => !new Set<string>(PROBE_289 as string[]).has(n));
    expect(extra.sort()).toEqual(['/', 'break', 'breakpoint', 'parser-flag']);
  });
});

describe('F-1 宿主种子与权威名单逐字相等', () => {
  it('ST_118_COMMAND_NAMES === fixture.commands（改一处必红）', () => {
    expect(ST_118_COMMAND_NAMES.length).toBe(AUTHORITY.commands.length);
    expect([...ST_118_COMMAND_NAMES].sort()).toEqual([...AUTHORITY.commands].sort());
  });

  it('getStCompatCommandNames() 返回副本，改它不影响常量', () => {
    const first = getStCompatCommandNames();
    expect(first).not.toBe(ST_118_COMMAND_NAMES);
    first.push('__mutated__');
    expect(ST_118_COMMAND_NAMES.includes('__mutated__')).toBe(false);
    expect(getStCompatCommandNames().length).toBe(293);
  });
});

describe('F-1 红线：C/D 类不注册、不假成功', () => {
  // 引擎命令表由 bootstrap 注册（幂等）；未 bootstrap 时全仓命令为空，
  // 这组断言依旧成立，但那就测不到"我们没把它们塞进去"，所以先确保注册过。
  ensureSlashCommandsBootstrapped();

  // C 类（ST UI）与 D 类（ST 私有数据模型）各抽 5 条，逐个查宿主引擎。
  const UI_SAMPLES = ['bg', 'bgcol', 'panels', 'theme', 'chat-render'];
  const MODEL_SAMPLES = [
    'checkpoint-create', 'closure-serialize', 'char-create', 'persona-delete', 'db-search',
  ];

  for (const name of [...UI_SAMPLES, ...MODEL_SAMPLES]) {
    it(`${name}：宿主引擎里没有实现，执行报 Unknown command（不是空串假成功）`, async () => {
      expect(SlashCommandEngine.getCommand(name)).toBeFalsy();
      const executed = await SlashCommandEngine.execute(`/${name} x`);
      expect(executed.output).toContain('Unknown command');
    });
  }

  it('种子名单里没有"名字不在 ST 权威表"的项（防有人往里塞私货）', () => {
    const authority = new Set<string>(AUTHORITY.commands as string[]);
    expect(ST_118_COMMAND_NAMES.filter((n) => !authority.has(n))).toEqual([]);
  });
});
