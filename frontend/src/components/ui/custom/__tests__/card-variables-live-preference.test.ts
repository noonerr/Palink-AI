/*
 * [MVU-STATUSBAR-LIVE] 卡片上下文变量取值优先级契约
 *
 * 钉住的是「卡片自带状态栏不跟随变量更新」的修复。
 *
 * 背景：状态栏 HTML 里的脚本是「首帧画一次 + 变量更新事件后重画」。
 * 事件能不能来，取决于父窗口有没有把新变量推进 iframe ——
 * 而父窗口只在 context **签名变化**时才推（postContextToFrame 按签名去重）。
 *
 * 此前 context 取的是该楼**冻结快照**（message.extra.variables 优先），
 * 变量更新后它不变 → 签名不变 → 判定「没变化」不推 → 事件不 emit → 面板停住。
 *
 * 因此「会话级实时值优先」不只是取值问题，**它是事件能触发的前提**。
 * 本文件把这条优先级钉死，避免被后人"顺手改回快照优先"。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { resolveCardVariables } from '../cardVariables';

const SESSION_V1 = { stat_data: { 环境: { 时间: { 小时: 7 } } } };
const SESSION_V2 = { stat_data: { 环境: { 时间: { 小时: 9 } } } };
const FLOOR_SNAPSHOT = { stat_data: { 环境: { 时间: { 小时: 7 } } } };

describe('resolveCardVariables', () => {
  it('★ 会话级实时值优先 —— 即使该楼快照也在', () => {
    const got = resolveCardVariables(SESSION_V2, FLOOR_SNAPSHOT);
    expect(got).toBe(SESSION_V2);
    expect(got.stat_data).toEqual(SESSION_V2.stat_data);
  });

  it('★ 变量更新后必须返回新值（这是 context 签名变化、进而推送事件的前提）', () => {
    const before = resolveCardVariables(SESSION_V1, FLOOR_SNAPSHOT);
    const after = resolveCardVariables(SESSION_V2, FLOOR_SNAPSHOT);
    // 该楼快照没变，但会话级变了 → 取值必须跟着变，否则去重逻辑不发 context-update
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  it('会话级缺失时回落该楼快照', () => {
    expect(resolveCardVariables(undefined, FLOOR_SNAPSHOT)).toBe(FLOOR_SNAPSHOT);
    expect(resolveCardVariables(null, FLOOR_SNAPSHOT)).toBe(FLOOR_SNAPSHOT);
  });

  it('两者都缺 → 返回空 stat_data（不返回 null，卡片脚本读得到空对象）', () => {
    expect(resolveCardVariables(undefined, undefined)).toEqual({ stat_data: {} });
  });

  it('脏形状（数组 / 字符串 / 数字）一律忽略', () => {
    expect(resolveCardVariables([1, 2], FLOOR_SNAPSHOT)).toBe(FLOOR_SNAPSHOT);
    expect(resolveCardVariables('nope', FLOOR_SNAPSHOT)).toBe(FLOOR_SNAPSHOT);
    expect(resolveCardVariables(42, FLOOR_SNAPSHOT)).toBe(FLOOR_SNAPSHOT);
    expect(resolveCardVariables([], undefined)).toEqual({ stat_data: {} });
  });

  it('空对象也算有效值（会话级被清空时不该回落旧快照）', () => {
    const empty = {};
    expect(resolveCardVariables(empty, FLOOR_SNAPSHOT)).toBe(empty);
  });
});
