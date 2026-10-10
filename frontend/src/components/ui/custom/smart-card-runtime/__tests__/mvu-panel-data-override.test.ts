/*
 * Mvu 面板数据来源：getMvuData 必须无条件覆盖（2026-10-05 立）
 *
 * 背景：智能卡 iframe 轨此前只对 `Mvu.getAllVariables` 做无条件覆盖，
 * `Mvu.getMvuData` 却带 `if (typeof ... !== 'function')` 守卫 —— 插件自带 MVU 引擎时
 * 它自己的实现胜出，**变量面板读的是插件自己的（通常为空的）变量表**，而不是
 * 后端下发的 stat_data → 面板恒空/恒默认值。
 *
 * 实测依据（卡脚本 backend/data/smart_card_assets/0c646fb31a…js，MVU bundle 原文）：
 *   getMvuData:function(e){return getVariables(e)},
 *   replaceMvuData:function(e,t){return replaceVariables(e,t)}
 * 即 MVU 的 getMvuData 只是「裸全局 getVariables 的薄包装」—— 覆盖它就是让面板读我们的数据。
 *
 * 本文件用**结构断言**（与本目录既有 `card-init-late-registration-guard.test.ts` 同款做法：
 * shim 是一段要注入 iframe 的脚本文本，整体执行需要完整上下文，故断言脚本结构）。
 * 有效性可用反证确认：把 `SillyTavernCompatRuntime.ts` 的赋值翻回条件守卫，本文件第 2 条立即变红。
 *
 * 运行: npx vitest run
 */
import { describe, expect, it } from 'vitest';

import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

function buildShim(): string {
  return buildSillyTavernCompatRuntimeV2Shim({
    context: {} as any,
    frameId: 'mvu-panel-data-frame',
    sourceHtml: '<div></div>',
    mode: 'inline',
  } as any);
}

const ASSIGN_GET_MVU_DATA = 'window.Mvu.getMvuData = mvuGetMvuDataFinal;';
/** 顶层（与 getAllVariables 同缩进）的无条件赋值 —— 旧写法把它包进 if 里，缩进会多 2 格。 */
const ASSIGN_GET_MVU_DATA_TOPLEVEL = `\n    ${ASSIGN_GET_MVU_DATA}`;

describe('Mvu.getMvuData 无条件覆盖（面板读我们的数据）', () => {
  it('赋值语句必须在顶层缩进（不是被包在 if 守卫里）', () => {
    // 这条是回归守卫的主力：旧写法 `if (...) { window.Mvu.getMvuData = ... }` 缩进为 6 格，必然不匹配
    expect(buildShim()).toContain(ASSIGN_GET_MVU_DATA_TOPLEVEL);
  });

  it('不得再出现"插件已提供就不覆盖"的旧守卫（回归守卫）', () => {
    const shim = buildShim();
    expect(shim).not.toMatch(/Mvu\.getMvuData\s*!==\s*'function'/);
    expect(shim).not.toMatch(/typeof\s+window\.Mvu\.getMvuData/);
  });

  it('立即覆盖 + 延时补刀两处都要有（插件异步再覆盖时兜住）', () => {
    const shim = buildShim();
    const hits = shim.split(ASSIGN_GET_MVU_DATA).length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('边界：只覆盖"读"，不碰 replaceMvuData / parseMessage（避免与后端双写）', () => {
    const shim = buildShim();
    expect(shim).not.toContain('Mvu.replaceMvuData');
    expect(shim).not.toContain('Mvu.parseMessage');
  });

  it('getAllVariables 的无条件覆盖口径未被回退（同族一致性）', () => {
    const shim = buildShim();
    expect(shim).toContain('window.Mvu.getAllVariables = mvuGetAllVariablesFinal;');
    expect(shim).not.toMatch(/Mvu\.getAllVariables\s*!==\s*'function'/);
  });
});
