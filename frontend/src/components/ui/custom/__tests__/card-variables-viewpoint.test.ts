/**
 * [MVU-AS-OF 2026-10-22 批次MS-2] 「历史楼层」的取值契约。
 *
 * 老板验收线：**切换故事线、或看不同楼层时，显示必须是那条故事线、那一楼层的状态。**
 * 反例原话：「回跳到第二条，结果显示的却是 100 条的变量数据」。
 *
 * 与 `card-variables-live-preference.test.ts` 的分工（两份都要活着，语义不冲突）：
 *   - 那份钉的是**当前视点那楼**必须取会话级实时值（否则 context 签名不变、
 *     `VARIABLE_UPDATE_ENDED` 不触发、卡片状态栏停在首帧）。本批**没有改判它**。
 *   - 本份钉的是**非视点楼层**必须取该楼自己的值，取不到就空，**绝不退回会话级**。
 *
 * ⚠️ 本文件即旧 bug 的反证守卫：把 `isViewpoint=false` 分支改回"会话级优先"，
 *   `test_历史楼层取该楼的值` 与 `test_明细缺失时不得拿会话级顶` 会立刻变红。
 */
import { describe, expect, it } from 'vitest';

import { resolveCardVariables } from '../cardVariables';

const SESSION_LIVE = { stat_data: { 好感度: 100 } };
const FLOOR_SNAPSHOT = { stat_data: { 好感度: 2 } };
// 自动清理摘掉明细后的形态：只剩 pruned 痕迹，没有 stat_data
const FLOOR_PRUNED = { pruned: true };

describe('非视点楼层（历史楼层）取值', () => {
  it('★ 历史楼层取该楼的值，不是会话最新值', () => {
    const got = resolveCardVariables(SESSION_LIVE, FLOOR_SNAPSHOT, false);
    expect(got.stat_data).toEqual({ 好感度: 2 });
    expect(got.stat_data).not.toEqual(SESSION_LIVE.stat_data);
  });

  it('★ 该楼明细缺失时给空 + 显式标记，绝不拿会话级顶', () => {
    const got = resolveCardVariables(SESSION_LIVE, FLOOR_PRUNED, false);
    expect(got.stat_data).toEqual({});
    expect(got.mvu_state_unavailable).toBe(true);
    expect(got.stat_data).not.toEqual(SESSION_LIVE.stat_data);
  });

  it('该楼完全没有变量对象 ⇒ 同样是空 + 标记（不返回 null 让卡片脚本读崩）', () => {
    const got = resolveCardVariables(SESSION_LIVE, undefined, false);
    expect(got.stat_data).toEqual({});
    expect(got.mvu_state_unavailable).toBe(true);
  });
});

describe('视点楼层与默认参数（保住那份防回退守卫的语义）', () => {
  it('视点楼：会话级实时值优先（显式传 true）', () => {
    const got = resolveCardVariables(SESSION_LIVE, FLOOR_SNAPSHOT, true);
    expect(got.stat_data).toEqual({ 好感度: 100 });
  });

  it('不传第三参 ⇒ 行为与本批改动前逐字一致（旧调用点不受影响）', () => {
    expect(resolveCardVariables(SESSION_LIVE, FLOOR_SNAPSHOT)).toEqual(SESSION_LIVE);
    expect(resolveCardVariables(undefined, FLOOR_SNAPSHOT)).toEqual(FLOOR_SNAPSHOT);
    expect(resolveCardVariables(undefined, undefined)).toEqual({ stat_data: {} });
  });
});
