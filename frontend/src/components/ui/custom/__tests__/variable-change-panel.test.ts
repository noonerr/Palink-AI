/**
 * 「变量变化」面板的单测。
 *
 * 覆盖 `diffStatData` 的判定口径（新增 / 变化 / 移除 / 不变 / 只读字段 / 空对象 / 数组 / 深层嵌套），
 * 以及 `formatChangeValue` 的展示口径。组件渲染本身由 jsdom 下的 vitest 环境承载，
 * 但这里只测纯函数 —— 判定的正确性是这一块的核心风险，渲染是次要的。
 */
import { describe, expect, it } from 'vitest';

import {
  diffStatData,
  flattenStatData,
  formatChangeValue,
  type VariableChange,
} from '../VariableChangePanel';

/** 把结果压成便于断言的紧凑形状。 */
function shape(changes: VariableChange[]) {
  return changes.map((c) => ({
    path: c.path,
    kind: c.kind,
    from: c.from,
    to: c.to,
  }));
}

describe('flattenStatData', () => {
  it('把嵌套树压成点号路径', () => {
    expect(flattenStatData({ 桃汐: { 好感度: 37, 服饰: '校服' } })).toEqual({
      '桃汐.好感度': 37,
      '桃汐.服饰': '校服',
    });
  });

  it('数组按整体叶子处理，不逐元素展开', () => {
    // MVU 的 JSON Patch 对数组是整体 replace，语义上就该整体比较
    expect(flattenStatData({ 背包: ['剑', '盾'] })).toEqual({ 背包: ['剑', '盾'] });
  });

  it('跳过 `_` 开头的只读字段（与后端 mvu_engine._is_readonly 同约定）', () => {
    expect(flattenStatData({ _meta: { x: 1 }, 桃汐: { 好感度: 1 } })).toEqual({
      '桃汐.好感度': 1,
    });
  });

  it('空对象不产出叶子（避免"桃汐: {} 新增"这种纯噪声）', () => {
    expect(flattenStatData({ 桃汐: {} })).toEqual({});
  });

  it('null / undefined 返回空表，不抛', () => {
    expect(flattenStatData(null)).toEqual({});
    expect(flattenStatData(undefined)).toEqual({});
  });
});

describe('diffStatData', () => {
  it('只报变化项，未变的字段不出现在结果里', () => {
    const prev = { 桃汐: { 好感度: 37, 服饰: '校服' } };
    const curr = { 桃汐: { 好感度: 42, 服饰: '校服' } };
    expect(shape(diffStatData(prev, curr))).toEqual([
      { path: '桃汐.好感度', kind: 'change', from: 37, to: 42 },
    ]);
  });

  it('区分 新增 / 变化 / 移除 三种类型', () => {
    const prev = { 世界信息: { 地点: '教室' }, 桃汐: { 好感度: 37 } };
    const curr = { 世界信息: { 地点: '天台' }, 桃汐: { 好感度: 37, 心情: '开心' } };
    const result = shape(diffStatData(prev, curr));
    // 结果按路径码点序排列，故断言按同一顺序写（不依赖中文排序直觉）
    expect(result).toEqual([
      { path: '世界信息.地点', kind: 'change', from: '教室', to: '天台' },
      { path: '桃汐.心情', kind: 'add', from: undefined, to: '开心' },
    ]);
  });

  it('移除字段报 remove，且 to 为 undefined', () => {
    const result = shape(diffStatData({ 桃汐: { 临时状态: 'x' } }, { 桃汐: {} }));
    expect(result).toEqual([
      { path: '桃汐.临时状态', kind: 'remove', from: 'x', to: undefined },
    ]);
  });

  it('完全一致时返回空数组（面板据此不渲染）', () => {
    const data = { 桃汐: { 好感度: 37 } };
    expect(diffStatData(data, { 桃汐: { 好感度: 37 } })).toEqual([]);
  });

  it('对象值按内容比较，键顺序不同不算变化', () => {
    expect(diffStatData({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
  });

  it('数组内容变化算变化', () => {
    const result = shape(diffStatData({ 背包: ['剑'] }, { 背包: ['剑', '盾'] }));
    expect(result).toEqual([
      { path: '背包', kind: 'change', from: ['剑'], to: ['剑', '盾'] },
    ]);
  });

  it('0 / false / 空字符串 参与比较，不会被当成"无值"漏掉', () => {
    const result = shape(
      diffStatData({ a: { 数: 1, 开关: true, 名: 'x' } }, { a: { 数: 0, 开关: false, 名: '' } }),
    );
    // 两侧都排序再比，避免依赖中文码点序的直觉
    expect(result.map((r) => r.path).sort()).toEqual(['a.开关', 'a.数', 'a.名'].sort());
    expect(result.every((r) => r.kind === 'change')).toBe(true);
  });

  it('分组被整体清空时报 remove（空对象占位生效）', () => {
    const result = shape(diffStatData({ 桃汐: { 好感度: 1 } }, { 桃汐: {} }));
    expect(result).toEqual([
      { path: '桃汐.好感度', kind: 'remove', from: 1, to: undefined },
    ]);
  });

  it('两侧都为空/非法时不抛，返回空数组', () => {
    expect(diffStatData(null, undefined)).toEqual([]);
    expect(diffStatData({}, {})).toEqual([]);
  });

  it('解析出的 group / field 正确切分（无分组时 group 为 _）', () => {
    const [change] = diffStatData({ 好感度: 1 }, { 好感度: 2 });
    expect(change.group).toBe('_');
    expect(change.field).toBe('好感度');
    const [nested] = diffStatData({ 桃汐: { 好感度: 1 } }, { 桃汐: { 好感度: 2 } });
    expect(nested.group).toBe('桃汐');
    expect(nested.field).toBe('好感度');
  });
});

describe('formatChangeValue', () => {
  it('布尔转中文、空值转破折号、undefined 转（无）', () => {
    expect(formatChangeValue(true)).toBe('是');
    expect(formatChangeValue(false)).toBe('否');
    expect(formatChangeValue(null)).toBe('—');
    expect(formatChangeValue('')).toBe('—');
    expect(formatChangeValue(undefined)).toBe('（无）');
  });

  it('长字符串按上限截断并加省略号', () => {
    const long = 'x'.repeat(80);
    const out = formatChangeValue(long, 10);
    expect(out).toBe(`${'x'.repeat(10)}…`);
  });

  it('对象序列化展示', () => {
    expect(formatChangeValue({ a: 1 })).toBe('{"a":1}');
  });
});
