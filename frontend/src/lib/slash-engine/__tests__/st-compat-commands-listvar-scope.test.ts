/*
 * 包 Z Z-1 · `/listvar` 的 `scope` 命名参数契约（2026-10-19）
 *
 * 期望值全部抄自 ST 1.18.0 **一手源码**（本机 `/d/SillyTavern-release` 与
 * `_reference/sillytavern-1.18.0` 是同一份），不是"实现完再照着实现编期望"：
 *
 *   注册：public/scripts/variables.js:902-932
 *     :904  name: 'listvar'
 *     :906  aliases: ['listchatvar']
 *     :910-922 namedArgumentList 的 `scope`：
 *            :914 defaultValue 'all'、:916 forceEnum: true、
 *            :918-920 enumList = all | local | global
 *   实现：public/scripts/variables.js:263-302 `listVariablesCallback`
 *     :268  scope = String(args?.scope || '').toLowerCase().trim() || 'all'
 *     :273-274 includeLocal = scope==='all'||scope==='local'
 *              includeGlobal = scope==='all'||scope==='global'
 *     :291-294 jsonVariables = [{key,value,scope:'local'|'global'}]（先 local 后 global）
 *     :301  doReturn(returnType ?? 'popup-html', jsonVariables, {objectToStringFunc: buildTextValue})
 *
 * 本仓按任务书（HANDOFF §1 Z-1）验收标准做的**两处有据可查的偏离**：
 *   ① 不给 scope ⇒ 必须与改前逐字节一致 ⇒ 缺省走 local（ST 缺省是 all）。
 *      改前实现是 `JSON.stringify(variableManager.local.list())`，所以这里断的就是这个字面量。
 *   ② `chat` 不在 ST 枚举里（ST 会把它当非法值出空串），任务书要求 `scope=chat` 与改前一致
 *      ⇒ 当作 local 的同义词。
 *
 * 非法值行为照抄 ST：`forceEnum` 只喂自动补全（SlashCommandArgument.js:55 定义、
 * SlashCommandAutoCompleteNameResult.js:119/188 转 forceMatch），**执行期不抛错**；
 * 未知 scope 使 :273-274 两个 include 恒假 ⇒ 文本分支 `[].join()` = 空串。
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/st-compat-commands-listvar-scope.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/api', () => ({ api: apiMock }));

import { SlashCommandEngine } from '@/lib/slash-engine';
import { ensureSlashCommandsBootstrapped } from '@/lib/slash-engine/bootstrap';
import { variableManager } from '@/lib/variables/manager';
import { localVariables } from '@/lib/variables/local';

ensureSlashCommandsBootstrapped();

const run = async (input: string) => (await SlashCommandEngine.execute(input)).output;

/** 改前实现的输出（回归基线）：`JSON.stringify(variableManager.local.list())` */
const legacyOutput = () => JSON.stringify(variableManager.local.list());

describe('Z-1 listvar · 回归面（与改前逐字节一致）', () => {
  beforeEach(async () => {
    localVariables.load({});
    await run('/flushglobalvar');
  });

  it('不给 scope 时输出与改前实现逐字节相同', async () => {
    localVariables.load({ hp: '10', mp: '5' });
    expect(await run('/listvar')).toBe(legacyOutput());
    expect(await run('/listvar')).toBe('{"hp":"10","mp":"5"}');
  });

  it('scope=chat（任务书要求的同义词）与不给 scope 逐字节相同', async () => {
    localVariables.load({ hp: '10' });
    expect(await run('/listvar scope=chat')).toBe(await run('/listvar'));
  });

  it('scope=local 与不给 scope 逐字节相同（ST :273 includeLocal 含 local）', async () => {
    localVariables.load({ hp: '10' });
    expect(await run('/listvar scope=local')).toBe(await run('/listvar'));
  });

  it('空表也保持改前形状（{}，不是 []）', async () => {
    expect(await run('/listvar')).toBe('{}');
    expect(await run('/listvar scope=chat')).toBe('{}');
  });
});

describe('Z-1 listvar · scope=global 走真通道（variableManager.global）', () => {
  beforeEach(async () => {
    localVariables.load({});
    await run('/flushglobalvar');
  });

  it('只列全局表，不含局部变量', async () => {
    localVariables.load({ hp: '10' });
    await run('/addglobalvar gold 100');
    expect(JSON.parse(await run('/listvar scope=global'))).toEqual({ gold: '100' });
  });

  it('/addglobalvar 写的值必须能被 scope=global 读到（同一张表，不是两套账）', async () => {
    await run('/addglobalvar counter 5');
    expect(JSON.parse(await run('/listvar scope=global')).counter).toBe('5');
    // 同一张表的反向证明：/incglobalvar 之后立刻可见
    await run('/incglobalvar counter');
    expect(JSON.parse(await run('/listvar scope=global')).counter).toBe('6');
  });

  it('大小写与首尾空白按 ST :268 归一（GLOBAL 等价 global）', async () => {
    await run('/addglobalvar gold 1');
    expect(await run('/listvar scope=GLOBAL')).toBe(await run('/listvar scope=global'));
    expect(await run('/listvar scope=Global')).toBe(await run('/listvar scope=global'));
  });
});

describe('Z-1 listvar · scope=all 用 ST :291-294 的载荷形状', () => {
  beforeEach(async () => {
    localVariables.load({});
    await run('/flushglobalvar');
  });

  it('返回 [{key,value,scope}]，先 local 后 global（顺序照 ST 展开式）', async () => {
    localVariables.load({ hp: '10' });
    await run('/addglobalvar gold 100');
    const arr = JSON.parse(await run('/listvar scope=all'));
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toEqual([
      { key: 'hp', value: '10', scope: 'local' },
      { key: 'gold', value: '100', scope: 'global' },
    ]);
  });

  it('只有一边有变量时，另一边不产生占位项', async () => {
    await run('/addglobalvar gold 100');
    const arr = JSON.parse(await run('/listvar scope=all'));
    expect(arr).toEqual([{ key: 'gold', value: '100', scope: 'global' }]);
  });
});

describe('Z-1 listvar · 非法值照抄 ST（不抛错、空串）', () => {
  beforeEach(async () => {
    localVariables.load({ hp: '10' });
    await run('/flushglobalvar');
  });

  it('scope=bogus 返回空串而不是抛错（ST :273-274 双假）', async () => {
    await expect(run('/listvar scope=bogus')).resolves.toBe('');
  });

  it('非法值不会被折成"照样列局部变量"', async () => {
    const out = await run('/listvar scope=bogus');
    expect(out).not.toBe(await run('/listvar'));
    expect(out).not.toContain('hp');
  });
});

describe('Z-1 listvar · 声明面（补全用的枚举）', () => {
  it('namedArgs 里有 scope，且 enumList 含 ST 的三个取值', () => {
    const cmd = SlashCommandEngine.getCommand('listvar');
    expect(cmd).toBeTruthy();
    const scopeArg = cmd?.namedArgs?.find(a => a.name === 'scope');
    expect(scopeArg).toBeTruthy();
    expect(scopeArg?.type).toEqual(['string']);
    expect(scopeArg?.enumList).toEqual(expect.arrayContaining(['all', 'local', 'global']));
  });
});
