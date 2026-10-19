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
 * ⚠️ 2026-10-20 包AA-B **改判**（主脑撤销包Z 依据 HANDOFF §1 Z-1 写的两处偏离验收条件）：
 *   兼容目标是 ST 而非"本仓改前行为"，所以下面这一组用例（原"回归面/与改前逐字节一致"）
 *   已按 ST 一手源码重写。逐条依据：
 *     ① 缺省 = all：variables.js:914 `defaultValue: 'all'` + :268 `|| 'all'`
 *        ⇒ 不给 scope 的输出是 :291-294 的两组载荷，**不再**等于改前的局部表 JSON。
 *     ② `chat` 不在 ST 枚举：:918-920 enumList 只有 all|local|global
 *        ⇒ 走 :273-274 双假分支 = 空串（与 scope=bogus 同一口径）。
 *   撤销的偏离原文见同文件 git 历史与
 *   docs/_active/report/REPORT_包Z_紧要批次一小收尾_2026-10-19.md。
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

/** 改前实现的输出（仅作"旧形状已不再出现"的反证基线，2026-10-20 包AA-B 后不再是验收线） */
const legacyOutput = () => JSON.stringify(variableManager.local.list());

describe('Z-1 listvar · 缺省与非法值按 ST 改判（2026-10-20 包AA-B，依据 variables.js:914/:268/:918-920/:273-274）', () => {
  beforeEach(async () => {
    localVariables.load({});
    await run('/flushglobalvar');
  });

  // 原用例「不给 scope 时输出与改前实现逐字节相同」断的是 `{"hp":"10","mp":"5"}`。
  // 改判理由：ST 的缺省值就是 all（:914 defaultValue 'all'，:268 `|| 'all'`），
  // all 分支走 :291-294 的 [{key,value,scope}] 载荷 ⇒ 缺省输出必须是两组形状。
  it('不给 scope 等价于 scope=all（ST :914 defaultValue + :268 的 || "all"）', async () => {
    localVariables.load({ hp: '10', mp: '5' });
    await run('/addglobalvar gold 100');
    expect(await run('/listvar')).toBe(await run('/listvar scope=all'));
    expect(JSON.parse(await run('/listvar'))).toEqual([
      { key: 'hp', value: '10', scope: 'local' },
      { key: 'mp', value: '5', scope: 'local' },
      { key: 'gold', value: '100', scope: 'global' },
    ]);
    // 反证：改前的"只列局部表"形状已不再出现（旧用例断的就是它）。
    expect(await run('/listvar')).not.toBe(legacyOutput());
  });

  // 原用例「scope=chat 与不给 scope 逐字节相同」（任务书要求的同义词）。
  // 改判理由：chat 从来不在 ST 枚举里（:918-920 只有 all|local|global），
  // 未知值使 :273-274 两个 include 恒假 ⇒ 空串；与 scope=bogus 同口径。
  it('scope=chat 按未知枚举处理 = 空串（ST :918-920 无 chat ⇒ :273-274 双假）', async () => {
    localVariables.load({ hp: '10' });
    expect(await run('/listvar scope=chat')).toBe('');
    expect(await run('/listvar scope=chat')).toBe(await run('/listvar scope=bogus'));
  });

  // 原用例「scope=local 与不给 scope 逐字节相同」。
  // 改判理由：不给 scope 现在是 all（:268），local 只出局部表的 JSON 对象，两者形状不同。
  it('scope=local 只出局部表对象，且不等于缺省（缺省已是 all，两组载荷）', async () => {
    localVariables.load({ hp: '10' });
    await run('/addglobalvar gold 100');
    expect(await run('/listvar scope=local')).toBe('{"hp":"10"}');
    expect(await run('/listvar scope=local')).not.toBe(await run('/listvar'));
    expect(await run('/listvar scope=local')).not.toContain('gold');
  });

  // 原用例「空表也保持改前形状（{}，不是 []）」。
  // 改判理由：空表 + 缺省 all ⇒ :291-294 两次展开都是空 ⇒ 载荷是空数组 `[]`。
  it('空表走缺省（all）时形状是 []（ST :291-294 两组都为空）', async () => {
    expect(await run('/listvar')).toBe('[]');
    expect(await run('/listvar scope=chat')).toBe('');
    // local/global 单边分支仍保持各自的对象形状（:301 之外的 return 分支）。
    expect(await run('/listvar scope=local')).toBe('{}');
    expect(await run('/listvar scope=global')).toBe('{}');
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
    // 2026-10-20 包AA-B：枚举闭合到 ST 的三个值（:918-920），包Z 加的 'chat' 已随偏离②撤销。
    expect(scopeArg?.enumList).toEqual(['all', 'local', 'global']);
    expect(scopeArg?.enumList).not.toContain('chat');
  });
});
