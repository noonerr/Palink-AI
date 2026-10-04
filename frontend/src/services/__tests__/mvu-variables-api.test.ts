/*
 * MVU 变量补丁前端服务（2026-10-05）
 *
 * 这里钉的是一个**踩过坑的口径**：后端 apply_patches 的 path 是
 * **相对 stat_data** 的（内部 target = stat_data.get("stat_data", stat_data)，
 * 末了 result["stat_data"] = target）。写成 /stat_data/角色/好感度 会多套一层
 * stat_data.stat_data.角色 —— 后端不会报错，只是把数据写歪，静默故障。
 *
 * 所以这条断言值得单独存在。
 *
 * 运行: npx vitest run
 */
import { describe, expect, it } from 'vitest';

import {
  buildStatDataPath,
  coerceValueByOriginal,
} from '../mvuVariables';

describe('buildStatDataPath', () => {
  it('path 相对 stat_data，不带 stat_data 前缀', () => {
    expect(buildStatDataPath('角色', '好感度')).toBe('/角色/好感度');
  });

  it('★ 回归守卫：绝不能产出 /stat_data/... 前缀', () => {
    // 后端会把它当成 stat_data 下的一个字面键 "stat_data"，
    // 结果是 stat_data.stat_data.角色 —— 不报错但写歪。
    const p = buildStatDataPath('角色', '好感度');
    expect(p.startsWith('/stat_data/')).toBe(false);
    expect(p).not.toContain('stat_data');
  });

  it('两级键拼成两段 pointer', () => {
    expect(buildStatDataPath('A', 'B').split('/').filter(Boolean)).toEqual(['A', 'B']);
  });
});

describe('coerceValueByOriginal', () => {
  it('原值是数字 → 还原成数字（否则进度条会退化成文本）', () => {
    expect(coerceValueByOriginal('42', 10)).toBe(42);
    expect(coerceValueByOriginal('3.5', 10)).toBe(3.5);
  });

  it('原值是数字但输入不是数 → 原样返回，交给后端判定', () => {
    expect(coerceValueByOriginal('abc', 10)).toBe('abc');
  });

  it('原值是字符串 → 保持字符串', () => {
    expect(coerceValueByOriginal('42', 'x')).toBe('42');
  });

  it('原值是布尔 → 认「是/否」与 true/false', () => {
    expect(coerceValueByOriginal('是', false)).toBe(true);
    expect(coerceValueByOriginal('false', true)).toBe(false);
  });

  it('原值是对象 → 尝试 JSON 解析，失败则原样返回', () => {
    expect(coerceValueByOriginal('{"a":1}', { a: 0 })).toEqual({ a: 1 });
    expect(coerceValueByOriginal('not-json', { a: 0 })).toBe('not-json');
  });
});
