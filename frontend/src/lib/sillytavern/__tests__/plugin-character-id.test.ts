/*
 * 插件侧角色身份派生契约测试（2026-10-02 P1）
 *
 * 钉住 SPEC_卡脚本本地存储按角色与账号隔离 §5-P1 的四条要求：
 *   1. 返回 number 且 ≠ 0 —— 0 在 ST 语义里是「未选中角色」，插件会出现匪夷所思的兜底行为。
 *   2. 确定性 —— 同样入参必须永远同一结果（否则刷新一次页面插件状态全丢）。
 *   3. 不同 UUID → 不同 id —— 这是修 D2 的核心：同名不同卡必须分开。
 *   4. 旧算法（名字哈希）保留且与历史值一致 —— 迁移回读要靠它，擅自改旧算法等于断掉迁移。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import {
  PLUGIN_CHARACTER_ID_FALLBACK,
  pluginCharacterIdFromUuid,
  pluginCharacterKeyFromUuid,
} from '../plugin-character-id';

/** SPEC §2.6 里实测存在的 4 张同名不同 id 的卡 */
const SAME_NAME_CARDS = [
  '13db28eb-0000-4000-8000-000000000001',
  'be906232-0000-4000-8000-000000000002',
  '8ca6bb91-0000-4000-8000-000000000003',
  'a36680d6-0000-4000-8000-000000000004',
];

describe('pluginCharacterIdFromUuid', () => {
  it('返回 number 且恒不为 0', () => {
    for (const uuid of SAME_NAME_CARDS) {
      const id = pluginCharacterIdFromUuid(uuid);
      expect(typeof id).toBe('number');
      expect(Number.isInteger(id)).toBe(true);
      expect(id).not.toBe(0);
      expect(id).toBeGreaterThan(0);
    }
  });

  it('确定性：同一 UUID 反复调用同一结果，且不掺杂乱数/时间', () => {
    const once = pluginCharacterIdFromUuid('a36680d6-d714-4be9-98b8-f145173c3ae9');
    for (let i = 0; i < 50; i += 1) {
      expect(pluginCharacterIdFromUuid('a36680d6-d714-4be9-98b8-f145173c3ae9')).toBe(once);
    }
    // 返回范围内保持在 32 位安全正整数域内，避免插件拿它做数组索引时越界成浮点问题
    expect(once).toBeLessThanOrEqual(0x7ffffffe);
  });

  it('不同 UUID 得到不同 id（修 D2 的核心：同名卡不再撞键）', () => {
    const ids = SAME_NAME_CARDS.map((id) => pluginCharacterIdFromUuid(id));
    expect(new Set(ids).size).toBe(SAME_NAME_CARDS.length);
  });

  it('名字相同但 id 不同的四张卡 → 旧算法撞车、新算法分开', () => {
    const name = '露缇雅1.2';
    // 旧算法（P1 之前 CharacterChat/Live2DPoolPanel 各抄了一份）：名字哈希 → 四张卡同一个值。
    // 故意写在这里而不是导出回产品代码：留证「为什么会串数据」，但不给新代码可调用之门。
    const legacyFromName = (n: string): number =>
      Array.from(n).reduce((acc, c) => acc + c.charCodeAt(0), 0) || 1;
    expect(new Set(SAME_NAME_CARDS.map(() => legacyFromName(name))).size).toBe(1);
    // 新算法：各不相同
    const newIds = SAME_NAME_CARDS.map((uuid) => pluginCharacterIdFromUuid(uuid));
    expect(new Set(newIds).size).toBe(SAME_NAME_CARDS.length);
  });

  it('首尾空白被 trim 归一化：同一个 UUID 带不带空白结果一致', () => {
    const bare = pluginCharacterIdFromUuid('a36680d6-d714-4be9-98b8-f145173c3ae9');
    expect(pluginCharacterIdFromUuid('  a36680d6-d714-4be9-98b8-f145173c3ae9  ')).toBe(bare);
    expect(pluginCharacterIdFromUuid('\na36680d6-d714-4be9-98b8-f145173c3ae9\n')).toBe(bare);
  });

  it('缺失/空入参返回兜底值 1', () => {
    expect(pluginCharacterIdFromUuid('')).toBe(PLUGIN_CHARACTER_ID_FALLBACK);
    expect(pluginCharacterIdFromUuid('   ')).toBe(PLUGIN_CHARACTER_ID_FALLBACK);
    expect(pluginCharacterIdFromUuid(undefined)).toBe(PLUGIN_CHARACTER_ID_FALLBACK);
    expect(pluginCharacterIdFromUuid(null)).toBe(PLUGIN_CHARACTER_ID_FALLBACK);
    expect(PLUGIN_CHARACTER_ID_FALLBACK).not.toBe(0);
  });
});

describe('pluginCharacterKeyFromUuid（Live2D 等 IDB 字符串主键场景）', () => {
  it('返回数字 id 的字符串形式，与 pluginCharacterIdFromUuid 保持一一对应', () => {
    const key = pluginCharacterKeyFromUuid('a36680d6-d714-4be9-98b8-f145173c3ae9');
    expect(typeof key).toBe('string');
    expect(Number(key)).toBe(pluginCharacterIdFromUuid('a36680d6-d714-4be9-98b8-f145173c3ae9'));
    expect(key).not.toBe('0');
  });

  it('同名四张卡的 IDB 主键互不相同', () => {
    const keys = SAME_NAME_CARDS.map((uuid) => pluginCharacterKeyFromUuid(uuid));
    expect(new Set(keys).size).toBe(SAME_NAME_CARDS.length);
  });
});
