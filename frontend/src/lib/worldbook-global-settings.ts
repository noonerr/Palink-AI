/**
 * 世界书全局设置（批次 C 前端半）——纯函数契约层。
 *
 * 后端契约：世界书全局设置存于 UserSetting.silly_tavern_settings JSON 顶层的
 * ``world_info_settings`` 字典，装配层消费点
 * backend/app/services/roleplay_prompt_assembly.py:4530-4549 一带
 * （depth / recursive / character_strategy 已消费；budget / budget_cap /
 * include_names 属批次 C1/C3 后端半，落地后自动生效）。
 *
 * 默认值对齐 ST 1.18.0：
 *   - world_info_depth = 2（ST Scan Depth 默认 2）
 *   - world_info_recursive = false（world-info.js:74 真值，批次 C2 对齐）
 *   - world_info_budget = 25（% 语义，ST Context % Budget）
 *   - world_info_budget_cap = 0（0 = 不启用）
 *   - world_info_include_names = true（script.js:4565 真值）
 *   - world_info_case_sensitive = false
 *   - world_info_match_whole_words = false
 *   - world_info_character_strategy = 1（world-info.js:4496，1=character_first）
 *
 * Palink 自研的语义召回三键（**无 world_info_ 前缀**，ST 同名语义不同，勿合并）：
 *   - vectorized_enabled = false（总开关，默认关 = 存量零突变）
 *   - vector_threshold = 0.55（0~1 浮点，越大越严；P1 由 0.25 收紧）
 *   - vector_top_k = 3（1~10 整数）
 * 后端消费：roleplay_prompt_assembly.py:4156/4196（开关）、
 * worldbook_service._read_vector_params_from_settings（后两键，settings 层优先于 env）。
 *
 * 本文件保持零依赖（不 import services/api），便于契约测试直接单测。
 */

export interface WorldInfoGlobalSettings {
  world_info_depth: number;
  world_info_recursive: boolean;
  world_info_budget: number;
  world_info_budget_cap: number;
  world_info_include_names: boolean;
  world_info_case_sensitive: boolean;
  world_info_match_whole_words: boolean;
  world_info_character_strategy: number;
  /**
   * 语义召回总开关（后端键名 `vectorized_enabled`，无 world_info_ 前缀）。
   * 默认关 = 与 ST 1.18 一致、存量零突变；只有显式打开才走语义检索。
   * 消费点：backend/app/services/roleplay_prompt_assembly.py:4156/4196。
   */
  vectorized_enabled: boolean;
  /** 语义匹配置信门槛 0~1，越大越严。默认 0.55（P1 收紧，旧默认 0.25 会误召）。 */
  vector_threshold: number;
  /** 每本书每轮最多注入的语义命中条数，1~10。默认 3。 */
  vector_top_k: number;
}

export const WORLD_INFO_GLOBAL_KEYS = [
  'world_info_depth',
  'world_info_recursive',
  'world_info_budget',
  'world_info_budget_cap',
  'world_info_include_names',
  'world_info_case_sensitive',
  'world_info_match_whole_words',
  'world_info_character_strategy',
  'vectorized_enabled',
  'vector_threshold',
  'vector_top_k',
] as const;

export type WorldInfoGlobalKey = (typeof WORLD_INFO_GLOBAL_KEYS)[number];

// ST 1.18.0 默认值（与上方注释中的后端消费点默认保持一致）
export const WORLD_INFO_GLOBAL_DEFAULTS: WorldInfoGlobalSettings = {
  world_info_depth: 2,
  world_info_recursive: false,
  world_info_budget: 25,
  world_info_budget_cap: 0,
  world_info_include_names: true,
  world_info_case_sensitive: false,
  world_info_match_whole_words: false,
  world_info_character_strategy: 1,
  // 语义召回三键（非 ST 键，Palink 自研，故无 world_info_ 前缀）：
  // 开关默认关；门槛 0.55 / 条数 3 与 worldbook_service._resolve_vector_* 默认一致
  vectorized_enabled: false,
  vector_threshold: 0.55,
  vector_top_k: 3,
};

// UI 输入合法范围（任务契约：depth 0-1000、budget 0-100、cap>=0、strategy 0-2、
// threshold 0-1 浮点、top_k 1-10）
const DEPTH_RANGE = { min: 0, max: 1000 } as const;
const BUDGET_RANGE = { min: 0, max: 100 } as const;
const STRATEGY_RANGE = { min: 0, max: 2 } as const;
const VECTOR_THRESHOLD_RANGE = { min: 0, max: 1 } as const;
const VECTOR_TOP_K_RANGE = { min: 1, max: 10 } as const;

function isPlainDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 数字解析对齐后端 int() 语义：空串/非法/NaN 回退默认，小数向零截断
function toIntOrDefault(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.trunc(num);
}

// 浮点解析：与 toIntOrDefault 的差异是**不取整**——vector_threshold 取值域 0~1，
// 走 toIntOrDefault 会把 0.55 截成 0（等价于门槛失效、什么都召回）。
function toNumberOrDefault(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

// boolean 解析对齐后端 bool() 消费（JSON 值域内 truthy 语义一致）
function toBoolOrDefault(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return Boolean(value);
}

/**
 * 从 world_info_settings 原始 dict 解析全局设置；缺 key / 非法值回退 ST 默认。
 * 忠实回显存量值（不钳制范围），范围钳制由保存前的 sanitize 负责。
 */
export function resolveWorldInfoGlobalSettings(raw: unknown): WorldInfoGlobalSettings {
  if (!isPlainDict(raw)) {
    return { ...WORLD_INFO_GLOBAL_DEFAULTS };
  }
  return {
    world_info_depth: toIntOrDefault(raw.world_info_depth, WORLD_INFO_GLOBAL_DEFAULTS.world_info_depth),
    world_info_recursive: toBoolOrDefault(raw.world_info_recursive, WORLD_INFO_GLOBAL_DEFAULTS.world_info_recursive),
    world_info_budget: toIntOrDefault(raw.world_info_budget, WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget),
    world_info_budget_cap: toIntOrDefault(raw.world_info_budget_cap, WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget_cap),
    world_info_include_names: toBoolOrDefault(raw.world_info_include_names, WORLD_INFO_GLOBAL_DEFAULTS.world_info_include_names),
    world_info_case_sensitive: toBoolOrDefault(raw.world_info_case_sensitive, WORLD_INFO_GLOBAL_DEFAULTS.world_info_case_sensitive),
    world_info_match_whole_words: toBoolOrDefault(raw.world_info_match_whole_words, WORLD_INFO_GLOBAL_DEFAULTS.world_info_match_whole_words),
    world_info_character_strategy: toIntOrDefault(raw.world_info_character_strategy, WORLD_INFO_GLOBAL_DEFAULTS.world_info_character_strategy),
    vectorized_enabled: toBoolOrDefault(raw.vectorized_enabled, WORLD_INFO_GLOBAL_DEFAULTS.vectorized_enabled),
    vector_threshold: toNumberOrDefault(raw.vector_threshold, WORLD_INFO_GLOBAL_DEFAULTS.vector_threshold),
    vector_top_k: toIntOrDefault(raw.vector_top_k, WORLD_INFO_GLOBAL_DEFAULTS.vector_top_k),
  };
}

/**
 * 保存前范围钳制（UI 输入合法域）。
 */
export function sanitizeWorldInfoGlobalSettings(next: WorldInfoGlobalSettings): WorldInfoGlobalSettings {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return {
    ...next,
    world_info_depth: clamp(
      toIntOrDefault(next.world_info_depth, WORLD_INFO_GLOBAL_DEFAULTS.world_info_depth),
      DEPTH_RANGE.min,
      DEPTH_RANGE.max,
    ),
    world_info_budget: clamp(
      toIntOrDefault(next.world_info_budget, WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget),
      BUDGET_RANGE.min,
      BUDGET_RANGE.max,
    ),
    world_info_budget_cap: Math.max(0, toIntOrDefault(next.world_info_budget_cap, WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget_cap)),
    world_info_character_strategy: clamp(
      toIntOrDefault(next.world_info_character_strategy, WORLD_INFO_GLOBAL_DEFAULTS.world_info_character_strategy),
      STRATEGY_RANGE.min,
      STRATEGY_RANGE.max,
    ),
    vectorized_enabled: toBoolOrDefault(
      next.vectorized_enabled,
      WORLD_INFO_GLOBAL_DEFAULTS.vectorized_enabled,
    ),
    vector_threshold: clamp(
      toNumberOrDefault(next.vector_threshold, WORLD_INFO_GLOBAL_DEFAULTS.vector_threshold),
      VECTOR_THRESHOLD_RANGE.min,
      VECTOR_THRESHOLD_RANGE.max,
    ),
    vector_top_k: clamp(
      toIntOrDefault(next.vector_top_k, WORLD_INFO_GLOBAL_DEFAULTS.vector_top_k),
      VECTOR_TOP_K_RANGE.min,
      VECTOR_TOP_K_RANGE.max,
    ),
  };
}

/**
 * 把下一份设置合并进现有 world_info_settings dict（纯函数，不改入参）。
 * 只覆盖 next 中显式提供的 key，existing 内其余 key
 * （world_info_min_activations / world_info_min_activations_depth_max 等）
 * 原样保留。
 *
 * 注：``vectorized_enabled`` 自 2026-09-30 起**已纳入** WORLD_INFO_GLOBAL_KEYS
 * （不再是"只保留、不可设置"的键），设置页开关可写；但 next 未显式提供时
 * 依然不写，存量值不受影响。
 */
export function mergeWorldInfoGlobalSettings(
  existing: unknown,
  next: Partial<WorldInfoGlobalSettings>,
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainDict(existing) ? { ...existing } : {};
  if (isPlainDict(next)) {
    for (const key of WORLD_INFO_GLOBAL_KEYS) {
      if (next[key] !== undefined) {
        base[key] = next[key];
      }
    }
  }
  return base;
}

/**
 * 构造 POST /api/settings/save 的整 blob payload。
 * 该端点对除 extension_settings 外的字段是整体覆盖语义，
 * 因此必须携带读取时的全量 settings（此处浅拷贝保全顶层其他 key），
 * 仅替换其中的 world_info_settings。
 */
export function buildWorldInfoGlobalSavePayload(
  fullSettings: unknown,
  next: Partial<WorldInfoGlobalSettings>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = isPlainDict(fullSettings) ? { ...fullSettings } : {};
  payload.world_info_settings = mergeWorldInfoGlobalSettings(payload.world_info_settings, next);
  return payload;
}
