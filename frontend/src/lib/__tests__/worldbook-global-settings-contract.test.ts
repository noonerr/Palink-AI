/*
 * 批次 C（前端半）世界书全局设置 UI 契约测试。
 *
 * ST 1.18.0 真值：
 *   - 世界书全局设置存于 settings.json 顶层 world_info_settings 字典；
 *     Palink 对应后端 UserSetting.silly_tavern_settings["world_info_settings"]
 *     （消费点：backend/app/services/roleplay_prompt_assembly.py:4530-4549）。
 *   - world_info_depth 默认 2、world_info_budget 默认 25（%）、
 *     world_info_character_strategy 默认 1=character_first（world-info.js:4496）。
 *   - world_info_recursive：ST 1.18.0 真值默认 false（world-info.js:74，
 *     批次 C2 后端半对齐中）；UI 无值时显示为关。
 *   - world_info_include_names 默认 true（script.js:4565）。
 *   - world_info_budget_cap 默认 0 = 不启用；case_sensitive / match_whole_words 默认 false。
 *
 * 读写通道（既有端点复用，无新增后端）：
 *   - 读：POST /api/settings/get（settings 字段为 JSON 字符串）；
 *   - 写：POST /api/settings/save（整 blob 覆盖，前端必须先 get 再合并再 save，
 *     且 world_info_settings 内无关 key 不得覆盖——如 world_info_min_activations /
 *     world_info_min_activations_depth_max / vectorized_enabled）。
 *
 * 运行: cd frontend && npx vitest run src/lib/__tests__/worldbook-global-settings-contract.test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  WORLD_INFO_GLOBAL_KEYS,
  WORLD_INFO_GLOBAL_DEFAULTS,
  resolveWorldInfoGlobalSettings,
  sanitizeWorldInfoGlobalSettings,
  mergeWorldInfoGlobalSettings,
  buildWorldInfoGlobalSavePayload,
} from '../worldbook-global-settings';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 2026-09-05 设置页拆分：世界书全局设置 UI 从 SettingsView.tsx 内联迁至
// settings-tabs/RoleplayEngineTab.tsx（角色扮演引擎 → SillyTavern 子 tab），锚点随迁。
const SETTINGS_TAB_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'components', 'views', 'settings-tabs', 'RoleplayEngineTab.tsx'),
  'utf-8',
);

// ============================================================
// 源码契约：RoleplayEngineTab.tsx 8 个 key 读写接线 + 通道接线
// ============================================================

describe('世界书全局设置 源码契约：设置页接线', () => {
  it('设置页含全部 world_info_* / vector_* 受管 key', () => {
    for (const key of WORLD_INFO_GLOBAL_KEYS) {
      expect(SETTINGS_TAB_SOURCE.includes(key)).toBe(true);
    }
  });

  it('设置页出现语义召回三键（漏一个即开关无处可写）', () => {
    for (const key of ['vectorized_enabled', 'vector_threshold', 'vector_top_k']) {
      expect(WORLD_INFO_GLOBAL_KEYS).toContain(key);
      expect(SETTINGS_TAB_SOURCE.includes(key)).toBe(true);
    }
  });

  it('语义召回文案是人话，且界面不出现 vectorized 字样', () => {
    // SPEC §11：界面文案不许出现 "vectorized"（只许出现在代码标识符里）。
    // 剔除所有含 vector 的标识符（属性读取 / 对象键）后若仍残留，即为漏进文案
    const stripped = SETTINGS_TAB_SOURCE.replace(/vector\w*/gi, '');
    expect(stripped.toLowerCase().includes('vector')).toBe(false);
    // 开关说明必须写清 P2 的首轮降级，否则用户"看不到效果"
    expect(SETTINGS_TAB_SOURCE).toContain('第一次打开后的下一条消息开始准备，再下一条才生效');
    expect(SETTINGS_TAB_SOURCE).toContain('世界书语义召回');
  });

  it('设置页走 /api/settings/get 读、/api/settings/save 写（既有通道，非新造）', () => {
    expect(SETTINGS_TAB_SOURCE.includes("'/api/settings/get'")).toBe(true);
    expect(SETTINGS_TAB_SOURCE.includes("'/api/settings/save'")).toBe(true);
  });
});

// ============================================================
// 行为契约：缺 key 回退默认值（与后端/ST 对齐）
// ============================================================

describe('世界书全局设置 行为：默认值解析', () => {
  it('world_info_settings 缺失/非 dict → 全部 ST 默认值', () => {
    for (const raw of [undefined, null, 'not-a-dict', 42]) {
      const resolved = resolveWorldInfoGlobalSettings(raw);
      expect(resolved.world_info_depth).toBe(2);
      expect(resolved.world_info_recursive).toBe(false);
      expect(resolved.world_info_budget).toBe(25);
      expect(resolved.world_info_budget_cap).toBe(0);
      expect(resolved.world_info_include_names).toBe(true);
      expect(resolved.world_info_case_sensitive).toBe(false);
      expect(resolved.world_info_match_whole_words).toBe(false);
      expect(resolved.world_info_character_strategy).toBe(1);
    }
  });

  it('空 dict → 全部 ST 默认值', () => {
    const resolved = resolveWorldInfoGlobalSettings({});
    expect(resolved).toEqual(WORLD_INFO_GLOBAL_DEFAULTS);
  });

  it('部分 key 存在 → 已配置值生效，缺省 key 回退默认', () => {
    const resolved = resolveWorldInfoGlobalSettings({
      world_info_depth: 5,
      world_info_include_names: false,
    });
    expect(resolved.world_info_depth).toBe(5);
    expect(resolved.world_info_include_names).toBe(false);
    expect(resolved.world_info_recursive).toBe(false);
    expect(resolved.world_info_budget).toBe(25);
    expect(resolved.world_info_character_strategy).toBe(1);
  });

  it('非法数字值（NaN/非数）→ 回退默认；数字可取整对齐后端 int() 语义', () => {
    const resolved = resolveWorldInfoGlobalSettings({
      world_info_depth: 'abc',
      world_info_budget: Number.NaN,
      world_info_budget_cap: 12.9,
    });
    expect(resolved.world_info_depth).toBe(2);
    expect(resolved.world_info_budget).toBe(25);
    expect(resolved.world_info_budget_cap).toBe(12);
  });

  it('boolean 按 truthy 语义解析，对齐后端 bool() 消费', () => {
    // 后端 wi_recursive = bool(_wis.get(...))：0/"" → false，其余 truthy → true
    expect(resolveWorldInfoGlobalSettings({ world_info_recursive: 1 }).world_info_recursive).toBe(true);
    expect(resolveWorldInfoGlobalSettings({ world_info_recursive: 0 }).world_info_recursive).toBe(false);
    expect(resolveWorldInfoGlobalSettings({ world_info_case_sensitive: 'yes' }).world_info_case_sensitive).toBe(true);
    expect(resolveWorldInfoGlobalSettings({ world_info_case_sensitive: '' }).world_info_case_sensitive).toBe(false);
    expect(resolveWorldInfoGlobalSettings({ world_info_match_whole_words: false }).world_info_match_whole_words).toBe(false);
  });
});

// ============================================================
// 行为契约：保存前范围钳制（depth 0-1000、budget 0-100、cap>=0、strategy 0-2）
// ============================================================

describe('世界书全局设置 行为：范围钳制', () => {
  it('sanitizeWorldInfoGlobalSettings：超界值钳到上下界', () => {
    const s = sanitizeWorldInfoGlobalSettings({
      ...WORLD_INFO_GLOBAL_DEFAULTS,
      world_info_depth: 5000,
      world_info_budget: 150,
      world_info_budget_cap: -5,
      world_info_character_strategy: 9,
    });
    expect(s.world_info_depth).toBe(1000);
    expect(s.world_info_budget).toBe(100);
    expect(s.world_info_budget_cap).toBe(0);
    expect(s.world_info_character_strategy).toBe(2);
  });

  it('sanitizeWorldInfoGlobalSettings：范围内值原样保留，不修改入参', () => {
    const input = { ...WORLD_INFO_GLOBAL_DEFAULTS, world_info_depth: 4, world_info_budget: 30 };
    const snapshot = JSON.stringify(input);
    const s = sanitizeWorldInfoGlobalSettings(input);
    expect(s.world_info_depth).toBe(4);
    expect(s.world_info_budget).toBe(30);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ============================================================
// 行为契约：语义召回三键（SPEC §11 C）
// vectorized_enabled=false / vector_threshold=0.55(0~1) / vector_top_k=3(1~10)
// ============================================================

describe('世界书全局设置 行为：语义召回三键默认值', () => {
  it('缺 key / 空 dict → 开关关、门槛 0.55、条数 3（与后端 P1 默认一致）', () => {
    for (const raw of [undefined, null, 'not-a-dict', 42, {}]) {
      const r = resolveWorldInfoGlobalSettings(raw);
      expect(r.vectorized_enabled).toBe(false);
      expect(r.vector_threshold).toBe(0.55);
      expect(r.vector_top_k).toBe(3);
    }
  });

  it('threshold 是浮点：0.55 不得被取整成 0（toIntOrDefault 会把门槛打回 0）', () => {
    expect(resolveWorldInfoGlobalSettings({ vector_threshold: 0.55 }).vector_threshold).toBe(0.55);
    expect(resolveWorldInfoGlobalSettings({ vector_threshold: 0.7 }).vector_threshold).toBe(0.7);
    expect(resolveWorldInfoGlobalSettings({ vector_threshold: '0.35' }).vector_threshold).toBe(0.35);
  });

  it('非法值回退默认；开关按 truthy 语义解析', () => {
    const r = resolveWorldInfoGlobalSettings({
      vectorized_enabled: 1,
      vector_threshold: 'abc',
      vector_top_k: Number.NaN,
    });
    expect(r.vectorized_enabled).toBe(true);
    expect(r.vector_threshold).toBe(0.55);
    expect(r.vector_top_k).toBe(3);
  });
});

describe('世界书全局设置 行为：语义召回三键钳制', () => {
  it('threshold 钳到 0~1、top_k 钳到 1~10（超界与负数）', () => {
    const s = sanitizeWorldInfoGlobalSettings({
      ...WORLD_INFO_GLOBAL_DEFAULTS,
      vector_threshold: 9,
      vector_top_k: 99,
    });
    expect(s.vector_threshold).toBe(1);
    expect(s.vector_top_k).toBe(10);

    const low = sanitizeWorldInfoGlobalSettings({
      ...WORLD_INFO_GLOBAL_DEFAULTS,
      vector_threshold: -3,
      vector_top_k: -1,
    });
    expect(low.vector_threshold).toBe(0);
    expect(low.vector_top_k).toBe(1);
  });

  it('范围内值原样保留（含浮点），且不修改入参', () => {
    const input = {
      ...WORLD_INFO_GLOBAL_DEFAULTS,
      vectorized_enabled: true,
      vector_threshold: 0.62,
      vector_top_k: 5,
    };
    const snapshot = JSON.stringify(input);
    const s = sanitizeWorldInfoGlobalSettings(input);
    expect(s.vectorized_enabled).toBe(true);
    expect(s.vector_threshold).toBe(0.62);
    expect(s.vector_top_k).toBe(5);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('threshold/top_k 非法（NaN/非数）→ 回退默认后再钳制', () => {
    const s = sanitizeWorldInfoGlobalSettings({
      ...WORLD_INFO_GLOBAL_DEFAULTS,
      // 故意喂非法值（UI 输入框可能给出非数字串），断言走默认而非 NaN 落库
      vector_threshold: 'abc' as unknown as number,
      vector_top_k: 'abc' as unknown as number,
    });
    expect(s.vector_threshold).toBe(0.55);
    expect(s.vector_top_k).toBe(3);
  });
});

describe('世界书全局设置 行为：三键参与 merge 且保留无关键', () => {
  it('merge：三键可写，同时 existing 内无关 key 原样保留', () => {
    const existing = {
      world_info_min_activations: 3,
      world_info_depth: 4,
      vectorized_enabled: false,
    };
    const merged = mergeWorldInfoGlobalSettings(existing, {
      vectorized_enabled: true,
      vector_threshold: 0.6,
      vector_top_k: 4,
    });
    expect(merged.vectorized_enabled).toBe(true);
    expect(merged.vector_threshold).toBe(0.6);
    expect(merged.vector_top_k).toBe(4);
    expect(merged.world_info_min_activations).toBe(3);
    expect(merged.world_info_depth).toBe(4);
  });

  it('merge：next 未提供三键时不写（存量值不被覆盖）', () => {
    const existing = { vectorized_enabled: true, vector_threshold: 0.8, vector_top_k: 7 };
    const merged = mergeWorldInfoGlobalSettings(existing, { world_info_depth: 9 });
    expect(merged.vectorized_enabled).toBe(true);
    expect(merged.vector_threshold).toBe(0.8);
    expect(merged.vector_top_k).toBe(7);
    expect(merged.world_info_depth).toBe(9);
  });

  it('buildWorldInfoGlobalSavePayload：整 blob 覆盖语义下顶层其他 key 与无关键都保留', () => {
    const payload = buildWorldInfoGlobalSavePayload(
      {
        oai_settings: { temp_openai: 0.7 },
        world_info_settings: { world_info_min_activations: 2, vector_top_k: 7 },
      },
      { vectorized_enabled: true, vector_threshold: 0.5 },
    );
    const wis = payload.world_info_settings as Record<string, unknown>;
    expect(payload.oai_settings).toEqual({ temp_openai: 0.7 });
    expect(wis.vectorized_enabled).toBe(true);
    expect(wis.vector_threshold).toBe(0.5);
    expect(wis.vector_top_k).toBe(7);
    expect(wis.world_info_min_activations).toBe(2);
  });
});

// ============================================================
// 行为契约：合并不覆盖 world_info_settings 下无关 key
// ============================================================

describe('世界书全局设置 行为：合并逻辑', () => {
  it('mergeWorldInfoGlobalSettings：保留 existing 内无关 key（min_activations / vectorized_enabled 等）', () => {
    const existing = {
      world_info_min_activations: 3,
      world_info_min_activations_depth_max: 7,
      vectorized_enabled: true,
      world_info_depth: 4,
    };
    const merged = mergeWorldInfoGlobalSettings(existing, { world_info_depth: 9 });
    expect(merged.world_info_depth).toBe(9);
    expect(merged.world_info_min_activations).toBe(3);
    expect(merged.world_info_min_activations_depth_max).toBe(7);
    expect(merged.vectorized_enabled).toBe(true);
  });

  it('mergeWorldInfoGlobalSettings：不修改入参（纯函数，返回新对象）', () => {
    const existing = { world_info_depth: 4, vectorized_enabled: true };
    const snapshot = JSON.stringify(existing);
    mergeWorldInfoGlobalSettings(existing, { world_info_depth: 9 });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('mergeWorldInfoGlobalSettings：existing 非法（null/非 dict）→ 只含 patch 的 8 key', () => {
    for (const bad of [null, 'x', 123]) {
      const merged = mergeWorldInfoGlobalSettings(bad, {
        world_info_depth: 3,
        world_info_recursive: true,
        world_info_budget: 30,
        world_info_budget_cap: 1000,
        world_info_include_names: false,
        world_info_case_sensitive: true,
        world_info_match_whole_words: true,
        world_info_character_strategy: 0,
      });
      expect(merged).toEqual({
        world_info_depth: 3,
        world_info_recursive: true,
        world_info_budget: 30,
        world_info_budget_cap: 1000,
        world_info_include_names: false,
        world_info_case_sensitive: true,
        world_info_match_whole_words: true,
        world_info_character_strategy: 0,
      });
    }
  });

  it('buildWorldInfoGlobalSavePayload：全量 settings 顶层其他 key 保留（save 端点是整 blob 覆盖）', () => {
    const fullSettings = {
      oai_settings: { temp_openai: 0.7 },
      power_user: { trim_spaces: true },
      extension_settings: { themes: [] },
      world_info_settings: {
        world_info_min_activations: 2,
        vectorized_enabled: false,
      },
    };
    const payload = buildWorldInfoGlobalSavePayload(fullSettings, {
      world_info_depth: 6,
      world_info_budget: 40,
    });
    const wis = payload.world_info_settings as Record<string, unknown>;
    expect(payload.oai_settings).toEqual({ temp_openai: 0.7 });
    expect(payload.power_user).toEqual({ trim_spaces: true });
    expect(payload.extension_settings).toEqual({ themes: [] });
    expect(wis.world_info_depth).toBe(6);
    expect(wis.world_info_budget).toBe(40);
    expect(wis.world_info_min_activations).toBe(2);
    expect(wis.vectorized_enabled).toBe(false);
  });

  it('buildWorldInfoGlobalSavePayload：全量 settings 缺失 → 兜底 world_info_settings=patch', () => {
    const payload = buildWorldInfoGlobalSavePayload(null, { world_info_depth: 2 });
    expect(payload.world_info_settings).toEqual({ world_info_depth: 2 });
  });
});
