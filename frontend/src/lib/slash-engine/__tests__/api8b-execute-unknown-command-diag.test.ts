/*
 * API-8b · 宿主引擎直执轨未实现命令留痕（2026-10-26）
 *
 * 钉两件事（改动点：lib/slash-engine/index.ts 的 execute catch 分支）：
 *   1. 未知命令的返回值一字不改（success=false / output="Error: Unknown command: /x"）；
 *   2. 同时落一条 recordPalinkDiag（owner=host_capability / kind=slash_command_unimplemented /
 *      name=裸命令名 / origin=host），与帧内桥接轨（part-07 折空串点）同口径；
 *      同名重复触发走记录器既有去重（count 累加），已实现命令不产生记录。
 *
 * 此前这条直执轨（sandbox / getContext / runtime 直接 SlashCommandEngine.execute）零痕迹，
 * 探针只能从返回字符串反推；本文件保证留痕在场且不改变调用方可见行为。
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/api8b-execute-unknown-command-diag.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlashCommandEngine } from '@/lib/slash-engine';
import * as diag from '@/components/ui/custom/smart-card-runtime/palink-diag';

describe('API-8b 直执轨未实现命令留痕', () => {
  beforeEach(() => {
    diag.resetPalinkDiagForTest();
    diag.setPalinkDiagEnabled(true, false);
  });
  afterEach(() => {
    diag.resetPalinkDiagForTest();
  });

  it('未知命令：返回值一字不改，同时落 host_capability / slash_command_unimplemented 一条', async () => {
    const result = await SlashCommandEngine.execute('/definitely-not-a-command-xyz');
    expect(result).toEqual({
      success: false,
      output: 'Error: Unknown command: /definitely-not-a-command-xyz',
      isCommand: true,
    });
    const hits = diag.palinkDiagRecords().filter((r) => r.kind === 'slash_command_unimplemented');
    expect(hits).toHaveLength(1);
    expect(hits[0].owner).toBe('host_capability');
    expect(hits[0].name).toBe('definitely-not-a-command-xyz');
    expect(hits[0].origin).toBe('host');
  });

  it('同名重复触发按既有去重累加 count；已实现命令不产生未实现记录', async () => {
    await SlashCommandEngine.execute('/no-such-cmd-a8b');
    await SlashCommandEngine.execute('/no-such-cmd-a8b');
    const hits = diag.palinkDiagRecords().filter((r) => r.name === 'no-such-cmd-a8b');
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(2);
    // 本文件自注册一条真命令：正常执行路径不得落 slash_command_unimplemented
    SlashCommandEngine.register({ name: 'a8b-ok', description: 'test-only', callback: async () => 'ok' });
    await SlashCommandEngine.execute('/a8b-ok');
    expect(
      diag.palinkDiagRecords().filter((r) => r.kind === 'slash_command_unimplemented' && r.name === 'a8b-ok'),
    ).toHaveLength(0);
  });
});
