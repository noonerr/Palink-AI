/*
 * 批次P3（2026-10-21）—— 帧内预设快照的**宿主侧**契约。
 *
 * 本文件钉两件事（与 p2-preset-read-keys-frame.test.ts 的"帧内同步"配套）：
 *   ① 数据源改指（P3-B）：宿主拉的是 `/api/prompt-manager/presets/snapshot`
 *      （服务端按 `generation_presets` 算好、**只含本人那份**），
 *      ⛔ 不再是 `/api/prompt-manager/presets`（背后是 `prompt_presets`，全库 0 行）。
 *   ② 快照→ctx 的形状搬运（P3-A）：`toSmartCardPresetSnapshot` 把服务端蛇形
 *      （`loaded_name` / `in_use`）转成帧内驼峰，且**缺数据时保留空容器与 null**
 *      —— 不把"没快照"伪装成"没有预设"（那正是本次要修的 P1 的反面）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/p3-preset-snapshot-source.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();

vi.mock('@/services/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  invalidateCache: vi.fn(),
}));

import {
  fetchSmartCardPresetSnapshot,
  toSmartCardPresetSnapshot,
} from '../SmartCardCompatController';

const SERVER_SNAPSHOT = {
  store: 'generation_presets',
  names: ['平衡', '自由', '严谨'],
  loaded_name: '平衡',
  in_use: {
    settings: { temperature: 0.7, top_p: 0.95 },
    prompts: [{ name: 'main', content: 'x' }],
    prompts_unused: [],
    extensions: {},
  },
  presets: {
    平衡: { settings: { temperature: 0.7 }, prompts: [{ name: 'main' }], prompts_unused: [], extensions: {} },
    自由: { settings: { temperature: 1.0 }, prompts: [], prompts_unused: [], extensions: {} },
    严谨: { settings: { temperature: 0.3 }, prompts: [], prompts_unused: [], extensions: {} },
  },
  source: 'global',
};

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation(async () => SERVER_SNAPSHOT);
});

describe('P3-B 数据源改指 generation_presets', () => {
  it('不带会话 ⇒ 打 `/api/prompt-manager/presets/snapshot`（不带 session_id）', async () => {
    const snap = await fetchSmartCardPresetSnapshot(null);
    expect(getMock).toHaveBeenCalledWith('/api/prompt-manager/presets/snapshot');
    expect(snap.names).toEqual(['平衡', '自由', '严谨']);
  });

  it('带会话 ⇒ session_id 走 query 且被编码（不拼出额外路径段）', async () => {
    await fetchSmartCardPresetSnapshot('a/b c');
    expect(getMock).toHaveBeenCalledWith(
      '/api/prompt-manager/presets/snapshot?session_id=a%2Fb%20c',
    );
  });

  it('`__pending__` 视为"还没有会话"，不带 session_id', async () => {
    await fetchSmartCardPresetSnapshot('__pending__');
    expect(getMock).toHaveBeenCalledWith('/api/prompt-manager/presets/snapshot');
  });

  it('⛔ 不再消费 `/api/prompt-manager/presets`（那张表全库 0 行）', async () => {
    await fetchSmartCardPresetSnapshot('sess-1');
    getMock.mock.calls.forEach((call) => {
      expect(String(call[0])).not.toBe('/api/prompt-manager/presets');
    });
  });

  it('共享行不进名单：服务端给什么就用什么（过滤在服务端，父侧不自行补行）', async () => {
    // 服务端已按 `user_id == :id` 挡掉 `user_id IS NULL` 的共享行；
    // 父侧的责任是**照单全收、不自己造行**（造行等于把过滤逻辑复制成第二份真相）。
    const snap = await fetchSmartCardPresetSnapshot('sess-1');
    expect(Object.keys(snap.presets || {})).toEqual(['平衡', '自由', '严谨']);
    expect(snap.store).toBe('generation_presets');
  });
});

describe('P3-A 快照 → 帧内 ctx 形状', () => {
  it('蛇形转驼峰，四键形状不变（settings/prompts/prompts_unused/extensions）', () => {
    const snap = toSmartCardPresetSnapshot(SERVER_SNAPSHOT);
    expect(snap).not.toBeNull();
    expect(snap?.names).toEqual(['平衡', '自由', '严谨']);
    expect(snap?.loadedName).toBe('平衡');
    expect(Object.keys(snap?.inUse || {}).sort()).toEqual([
      'extensions', 'prompts', 'prompts_unused', 'settings',
    ]);
    expect(Object.keys(snap?.presets || {})).toEqual(['平衡', '自由', '严谨']);
    expect(snap?.presets?.['平衡']?.settings).toEqual({ temperature: 0.7 });
    expect(snap?.store).toBe('generation_presets');
  });

  it('一份预设都没有 ⇒ names 是 []、loadedName 是 null、inUse 是 null（⛔ 不是 undefined）', () => {
    const snap = toSmartCardPresetSnapshot({
      store: 'generation_presets',
      names: [],
      loaded_name: null,
      in_use: null,
      presets: {},
      source: 'none',
    });
    expect(snap?.names).toEqual([]);
    expect(snap?.loadedName).toBeNull();
    expect(snap?.inUse).toBeNull();
    expect(snap?.inUse).not.toBeUndefined();
  });

  it('payload 为空 ⇒ null（宿主据此不发快照，帧内走"未就绪"留痕分支）', () => {
    expect(toSmartCardPresetSnapshot(null)).toBeNull();
    expect(toSmartCardPresetSnapshot(undefined)).toBeNull();
  });

  it('每份预设缺字段时补成空容器（卡拿到的永远是四键齐全的对象）', () => {
    const snap = toSmartCardPresetSnapshot({
      store: 'generation_presets',
      names: ['残缺'],
      loaded_name: '残缺',
      in_use: null,
      presets: { 残缺: {} },
    });
    const preset = snap?.presets?.['残缺'];
    expect(preset?.settings).toEqual({});
    expect(preset?.prompts).toEqual([]);
    expect(preset?.prompts_unused).toEqual([]);
    expect(preset?.extensions).toEqual({});
  });
});
