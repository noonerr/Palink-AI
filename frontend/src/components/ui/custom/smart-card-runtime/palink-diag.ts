/**
 * 包W · 静默失败统一记录器（父侧 / 宿主侧）
 *
 * 状态：施工中（包W）。
 *
 * 这一层解决的是「静默失败」——代码走了一条什么都没发生的路径，
 * 用户端零提示、开发者端零痕迹，于是永远定不了责。产品形状（用户已拍板）：
 *   1. 本机站点默认开启，另留手动开关（将来面向外部用户时可默认关）。
 *   2. 对用户仍然安静：本模块**不弹框、不出 toast**，只写缓冲 + 控制台一行汇总。
 *   3. 每条记录必须带「该谁修」标签（owner，取值固定四类），便于直接派单。
 *   4. 去重但不丢弃：同名首次带细节，后续只累加 count 与 lastAt。
 *
 * ⛔ 红线：
 *  - 零网络：本模块不 fetch / 不上传，导出只在浏览器本地下载 JSON。
 *  - 不改用户可见行为：帧内记录经既有 `st:diagnostic` 通道（severity=info，
 *    宿主 toast 闸门对 info 不弹）上送，不新建 postMessage 桥。
 *  - 有界：每类 owner ≤ DIAG_LIMITS.perOwner，总 ≤ DIAG_LIMITS.total。溢出丢最旧并计数。
 */

export const PALINK_DIAG_OWNERS = [
  'frame_compat',
  'host_capability',
  'card_authored',
  'display_pipeline',
] as const;

export type PalinkDiagOwner = (typeof PALINK_DIAG_OWNERS)[number];

/**
 * 记录 kind 的封闭名单（报告里逐条对应用户可见的静默点）。
 * 新增 kind 请同时更新 docs 报告与本名单，测试按本名单校验 owner 归属。
 */
export const PALINK_DIAG_KINDS = [
  'slash_command_unimplemented',
  'compat_catch_swallowed',
  'global_shape_absent',
  'tavernhelper_key_unimplemented',
  'unhandled_rejection',
  'card_script_injection_failed',
  'variable_block_residual',
  'frame_record',
  'context_stub_hit',
  'missing_api',
  'host_script_error',
  'script_error',
] as const;

export type PalinkDiagKind = (typeof PALINK_DIAG_KINDS)[number] | string;

/**
 * 向 ST 学习的缺口 id（台账：docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2）。
 * ⚠️ 本清单与那份台账**必须双向对齐**，由 `__tests__/st-gap-ledger-guard.test.ts` 钉：
 *   台账有 id 而代码没标 ⇒ 红；代码标了 id 而台账没记 ⇒ 也红。
 * 最后三个（script_button_store / model_list / chat_reorder）是包H §7.2 实测到、
 * 但台账初稿没归族的缺口，2026-10-19 由主控补进台账。
 */
export const ST_GAP_IDS = [
  'preset_prompt',
  'jailbreak_slot',
  'persona_crud',
  'charlib_write',
  'audio_player',
  'ext_install',
  'wb_delete',
  'chat_binding',
  'inject_slot',
  'raw_import',
  'regex_object',
  'macro_register',
  'stop_by_id',
  'opaque_dom',
  'script_button_store',
  'model_list',
  'chat_reorder',
] as const;

export type StGapId = (typeof ST_GAP_IDS)[number] | 'unknown';

/**
 * 名字 → 缺口 id。名单**逐条抄自两份已入库报告**，不是按名字猜：
 *   TavernHelper 侧 = REPORT_包H_TavernHelper广度_2026-10-18.md §3 的 D 类行 + §7.2 的 14 个改判键；
 *   slash 侧        = REPORT_包F_ST命令补全_2026-10-18.md §4.2 的逐族命令名。
 * 守门测试拿这两份的权威名单（th134-names.json / st289-names.json）校验每个键名真实存在，
 * 所以这里写错一个字或凭空加一个名字都会红。
 * 名单外的未实现名一律 `unknown` —— 宁可 unknown，也不把没核过的东西塞进排行。
 */
export const ST_GAP_BY_NAME: Record<string, string> = {
  // [ST-GAP:preset_prompt] ST 预设体系与"预设里这条提示词是什么类型"的判定；Palink 无预设对象层。
  // ST 侧判定式已核到 PromptManager.js:1723（见台账 §2），本包不搬预设管理器 UI。
  builtin: 'preset_prompt',
  builtin_prompt_default_order: 'preset_prompt',
  createOrReplacePreset: 'preset_prompt',
  createPreset: 'preset_prompt',
  default_preset: 'preset_prompt',
  deletePreset: 'preset_prompt',
  getLoadedPresetName: 'preset_prompt',
  getPreset: 'preset_prompt',
  getPresetNames: 'preset_prompt',
  getProxyPresetNames: 'preset_prompt',
  importRawPreset: 'preset_prompt',
  loadPreset: 'preset_prompt',
  renamePreset: 'preset_prompt',
  replacePreset: 'preset_prompt',
  setPreset: 'preset_prompt',
  updatePresetWith: 'preset_prompt',
  isPresetNormalPrompt: 'preset_prompt',
  isPresetPlaceholderPrompt: 'preset_prompt',
  isPresetSystemPrompt: 'preset_prompt',

  // [ST-GAP:jailbreak_slot] 破甲=一个可被卡覆盖的系统提示词槽位（openai.js:1232 把它归系统提示词家族）。
  // 本名表里没有对应键：这个缺口在**装配链**里，不在帧内 API 面上 ⇒ 排行里永远不会出现它的名字，
  // 由台账 §4-3 单独一包处理（改装配要复跑深度锚点探针）。
  // 保留 token 的唯一理由：让"台账有槽位、代码没标"这种漂移可被 grep 到。

  // [ST-GAP:persona_crud] 人设写通道（宿主 requestParent 无 persona 族动作）。
  createOrReplacePersona: 'persona_crud',
  createPersona: 'persona_crud',
  deletePersona: 'persona_crud',
  getPersona: 'persona_crud',
  getPersonaAvatarPath: 'persona_crud',
  getPersonaIds: 'persona_crud',
  getPersonaNames: 'persona_crud',
  getCurrentPersonaId: 'persona_crud',
  getCurrentPersonaName: 'persona_crud',
  replacePersona: 'persona_crud',
  updatePersonaWith: 'persona_crud',
  'persona-create': 'persona_crud',
  'persona-delete': 'persona_crud',
  'persona-duplicate': 'persona_crud',
  'persona-get': 'persona_crud',
  'persona-lock': 'persona_crud',
  'persona-set': 'persona_crud',
  'persona-sync': 'persona_crud',
  'persona-update': 'persona_crud',

  // [ST-GAP:charlib_write] 角色库写侧；卡能建角色属权限面，动手前要用户拍口径（台账 §5）。
  createCharacter: 'charlib_write',
  createOrReplaceCharacter: 'charlib_write',
  deleteCharacter: 'charlib_write',
  replaceCharacter: 'charlib_write',
  updateCharacterWith: 'charlib_write',
  importRawCharacter: 'charlib_write',
  RawCharacter: 'charlib_write',
  'char-create': 'charlib_write',
  'char-delete': 'charlib_write',
  'char-duplicate': 'charlib_write',
  'char-find': 'charlib_write',
  'char-get': 'charlib_write',
  'char-update': 'charlib_write',
  'rename-char': 'charlib_write',

  // [ST-GAP:audio_player] 要的是"播放队列"这个对象，不是 8 个函数壳（Palink TTS 逐条合成，无队列状态机）。
  playAudio: 'audio_player',
  pauseAudio: 'audio_player',
  getCurrentAudio: 'audio_player',
  getAudioList: 'audio_player',
  replaceAudioList: 'audio_player',
  appendAudioList: 'audio_player',
  getAudioSettings: 'audio_player',
  setAudioSettings: 'audio_player',

  // [ST-GAP:ext_install] 扩展安装/权限模型；口径 c 已拍板**不学**，只保留标记。
  installExtension: 'ext_install',
  uninstallExtension: 'ext_install',
  reinstallExtension: 'ext_install',
  updateExtension: 'ext_install',
  isInstalledExtension: 'ext_install',
  getExtensionType: 'ext_install',
  getExtensionStatus: 'ext_install',
  isAdmin: 'ext_install',
  getTavernHelperExtensionId: 'ext_install',
  'extension-disable': 'ext_install',
  'extension-enable': 'ext_install',
  'extension-exists': 'ext_install',
  'extension-state': 'ext_install',
  'extension-toggle': 'ext_install',

  // [ST-GAP:wb_delete] 删整本世界书：后端删除路由已核实存在，只差父侧动作（甲类·建议第一个做）。
  deleteLorebook: 'wb_delete',
  deleteWorldbook: 'wb_delete',

  // [ST-GAP:chat_binding] 卡↔书绑定写侧；绑定要写角色卡 extensions，父侧无通道。
  setCurrentCharLorebooks: 'chat_binding',
  rebindCharWorldbooks: 'chat_binding',

  // [ST-GAP:inject_slot] 运行时临时注入槽位；Palink 装配在后端，没有"本轮临时提示词"这一层。
  injectPrompts: 'inject_slot',
  uninjectPrompts: 'inject_slot',
  inject: 'inject_slot',
  flushinject: 'inject_slot',
  listinjects: 'inject_slot',

  // [ST-GAP:raw_import] 原始对象导入器；"卡能往库里灌任意对象"是权限口径，先拍口径再谈实现。
  importRawWorldbook: 'raw_import',
  importRawChat: 'raw_import',
  importRawTavernRegex: 'raw_import',

  // [ST-GAP:regex_object] ST 正则对象模型与 Palink regex_scripts 不同名（包H §7.2：半程移植会造出没形状的对象）。
  getTavernRegexes: 'regex_object',
  replaceTavernRegexes: 'regex_object',
  updateTavernRegexesWith: 'regex_object',
  isCharacterTavernRegexesEnabled: 'regex_object',
  formatAsTavernRegexedString: 'regex_object',
  regex: 'regex_object',
  'regex-preset': 'regex_object',
  'regex-state': 'regex_object',
  'regex-toggle': 'regex_object',

  // [ST-GAP:macro_register] 助手宏注册表：Palink 没有酒馆助手那张宏表。
  registerMacroLike: 'macro_register',

  // [ST-GAP:stop_by_id] 按 generation id 中止；Palink 只有全局停止，把"按 id"折成"全停"是语义不符。
  stopGenerationById: 'stop_by_id',

  // [ST-GAP:opaque_dom] ST 私有 DOM 面；未授信帧是 opaque origin ⇒ ⛔ 一行都不许朝"放宽沙箱"修（P1-1）。
  retrieveDisplayedMessage: 'opaque_dom',

  // [ST-GAP:script_button_store] 脚本按钮存储只在主页面 realm（card-script-runner.ts:199），帧内根本没有。
  getAllEnabledScriptButtons: 'script_button_store',

  // [ST-GAP:model_list] ST 打 /api/backends/chat-completions/status 取模型列表；Palink 无此端点且属计费面。
  getModelList: 'model_list',

  // [ST-GAP:chat_reorder] 消息重排：父侧没有重排通道（包H §7.2 实现期由 C 改判 D）。
  rotateChatMessages: 'chat_reorder',
};

/** 台账里"取不到 id"的固定值：排行里它就是"这口井没人认领"，不许拿它当某个族。 */
export const ST_GAP_UNKNOWN = 'unknown';

/**
 * 按 (owner, kind, name) 归到缺口 id。
 * 口径：只有 `host_capability`（缺的是宿主/后端能力）才参与聚合；其它归属返回 ''（不适用），
 * 免得把"兼容层自己的 bug"混进"向 ST 学习"的排行里。
 * 名字侧先剥 `TavernHelper.` 前缀（part-06 记的是全名 `TavernHelper.deleteLorebook`）。
 */
export function classifyStGap(input: { owner?: string; kind?: string; name?: string }): string {
  if (!input || input.owner !== 'host_capability') return '';
  const raw = String(input.name || '');
  const bare = raw.indexOf('TavernHelper.') === 0 ? raw.slice('TavernHelper.'.length) : raw;
  return ST_GAP_BY_NAME[bare] || ST_GAP_UNKNOWN;
}


/**
 * 稳定字段 schema（主控可直接按字段名派单，勿改名）：
 *   key        去重键 `owner|kind|name`，同名记录共用一条
 *   owner      该谁修：frame_compat / host_capability / card_authored / display_pipeline
 *   kind       静默点类型（见 PALINK_DIAG_KINDS）
 *   name       被触碰的东西的名字（命令名 / TavernHelper 键 / 全局名 / 脚本名 / catch 站点）
 *   detail     人类可读细节（首次写入，后续不覆盖）
 *   stack      首次调用栈（可能为空串）
 *   filename / lineno / colno   rejection 与脚本失败定位用，缺省给空串 / -1
 *   frameId    帧号（父侧可知；帧内记录上送时由宿主补齐）
 *   cardId     卡 id（同上）
 *   textLength 相关正文长度（未知给 -1）
 *   origin     'host' = 宿主代码写入；'frame' = 帧内记录器经 st:diagnostic 上送
 *   count      同名累计次数（含首次）
 *   firstAt / lastAt  首次与最后一次的 epoch 毫秒
 *   missingStSubsystem  缺口 id（台账 §2）；host_capability 记录自动归类，取不到=unknown，
 *                       其它归属=''（不适用）。诊断导出按它聚合成"哪口井真被踩到"。
 */
export interface PalinkDiagRecord {
  key: string;
  owner: PalinkDiagOwner;
  kind: PalinkDiagKind;
  name: string;
  detail: string;
  stack: string;
  filename: string;
  lineno: number;
  colno: number;
  frameId: string;
  cardId: string;
  textLength: number;
  origin: 'host' | 'frame';
  count: number;
  firstAt: number;
  lastAt: number;
  missingStSubsystem: string;
}

export interface PalinkDiagInput {
  owner: PalinkDiagOwner;
  kind: PalinkDiagKind;
  name: string;
  detail?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  frameId?: string;
  cardId?: string;
  textLength?: number;
  origin?: 'host' | 'frame';
  /** 帧内记录已经累计过的次数（上送时带上，父侧累加而不是只加 1）。 */
  count?: number;
  /** 显式指定缺口 id；不给则按 classifyStGap(owner, kind, name) 自动归。 */
  missingStSubsystem?: string;
}

export const DIAG_LIMITS = { perOwner: 200, total: 2000 } as const;

/** 手动开关落盘用的 localStorage 键（'1' 开 / '0' 关；缺失 = 按站点判定）。 */
export const PALINK_DIAG_STORAGE_KEY = 'palink.diag.enabled';

export type PalinkDiagState = {
  records: PalinkDiagRecord[];
  dropped: number;
  enabledOverride: boolean | null;
};

const state: PalinkDiagState = { records: [], dropped: 0, enabledOverride: null };

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    // 隐私模式 / 禁用存储时 localStorage 直接抛 —— 静默按"未设置"处理。
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* 存不下就算了，内存里的开关仍然生效 */
  }
}

/** 本机站点判定：只看 hostname，不发任何请求。 */
export function isLocalPalinkSite(): boolean {
  if (typeof window === 'undefined') return false;
  const host = String(window.location?.hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.1' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^192\.168\./.test(host) || /^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  return false;
}

/**
 * 是否记录中。优先级：
 *   内存覆盖（本会话 __palinkDiagSetEnabled）> localStorage 手动开关 > 本机站点默认开。
 * 外部站点默认关，将来面向用户时可保持这条，也可由开发者模式显式打开。
 */
export function palinkDiagEnabled(): boolean {
  if (state.enabledOverride !== null) return state.enabledOverride;
  const stored = storageGet(PALINK_DIAG_STORAGE_KEY);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return isLocalPalinkSite();
}

export function setPalinkDiagEnabled(value: boolean | null, persist = true): boolean {
  state.enabledOverride = value === null ? null : Boolean(value);
  if (persist) {
    if (value === null) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(PALINK_DIAG_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    } else {
      storageSet(PALINK_DIAG_STORAGE_KEY, value ? '1' : '0');
    }
  }
  return palinkDiagEnabled();
}

export function diagKeyOf(input: { owner: string; kind: string; name: string }): string {
  return `${input.owner}|${input.kind}|${input.name}`;
}

function findRecord(key: string): PalinkDiagRecord | undefined {
  for (let i = state.records.length - 1; i >= 0; i -= 1) {
    if (state.records[i].key === key) return state.records[i];
  }
  return undefined;
}

function countByOwner(owner: PalinkDiagOwner): number {
  let n = 0;
  for (const rec of state.records) if (rec.owner === owner) n += 1;
  return n;
}

/** 溢出时丢该 owner 里最旧的一条（数组头部），并计入 dropped。 */
function evictOldestOfOwner(owner: PalinkDiagOwner): void {
  for (let i = 0; i < state.records.length; i += 1) {
    if (state.records[i].owner === owner) {
      state.records.splice(i, 1);
      state.dropped += 1;
      return;
    }
  }
}

/**
 * 记一条。同名（owner+kind+name）合并：首次带细节，后续只累加 count 与 lastAt。
 * 关闭状态下直接返回 null —— 连去重查询都不做，保证零开销。
 */
export function recordPalinkDiag(input: PalinkDiagInput): PalinkDiagRecord | null {
  if (!palinkDiagEnabled()) return null;
  if (!input || !input.owner || !input.kind) return null;
  const name = String(input.name ?? '');
  const key = diagKeyOf({ owner: input.owner, kind: String(input.kind), name });
  const now = Date.now();
  const step = Number.isFinite(input.count) && Number(input.count) > 1 ? Math.floor(Number(input.count)) : 1;

  const existing = findRecord(key);
  if (existing) {
    existing.count += step;
    existing.lastAt = now;
    if (!existing.stack && typeof input.stack === 'string' && input.stack) existing.stack = input.stack;
    if (existing.filename === '' && typeof input.filename === 'string' && input.filename) existing.filename = input.filename;
    if (existing.lineno < 0 && Number.isFinite(input.lineno)) existing.lineno = Number(input.lineno);
    if (existing.colno < 0 && Number.isFinite(input.colno)) existing.colno = Number(input.colno);
    if (existing.cardId === '' && typeof input.cardId === 'string' && input.cardId) existing.cardId = input.cardId;
    if (existing.frameId === '' && typeof input.frameId === 'string' && input.frameId) existing.frameId = input.frameId;
    if (existing.textLength < 0 && Number.isFinite(input.textLength)) existing.textLength = Number(input.textLength);
    scheduleSummary();
    return existing;
  }

  if (state.records.length >= DIAG_LIMITS.total) {
    // 总数上限：先丢最早到的那一条（无论归属），保证有界。
    state.records.shift();
    state.dropped += 1;
  }
  while (countByOwner(input.owner) >= DIAG_LIMITS.perOwner) {
    evictOldestOfOwner(input.owner);
    if (state.records.length === 0) break;
  }

  const record: PalinkDiagRecord = {
    key,
    owner: input.owner,
    kind: String(input.kind),
    name,
    detail: String(input.detail ?? ''),
    stack: String(input.stack ?? ''),
    filename: String(input.filename ?? ''),
    lineno: Number.isFinite(input.lineno) ? Number(input.lineno) : -1,
    colno: Number.isFinite(input.colno) ? Number(input.colno) : -1,
    frameId: String(input.frameId ?? ''),
    cardId: String(input.cardId ?? ''),
    textLength: Number.isFinite(input.textLength) ? Number(input.textLength) : -1,
    origin: input.origin === 'frame' ? 'frame' : 'host',
    count: step,
    firstAt: now,
    lastAt: now,
    missingStSubsystem: String(input.missingStSubsystem || classifyStGap({ owner: input.owner, kind: String(input.kind), name })),
  };
  state.records.push(record);
  scheduleSummary();
  return record;
}

/**
 * 帧内上送的 st:diagnostic → 转成一条记录（origin=frame）。
 * 帧内记录器把 owner/kind/name 塞在 diagnostic 的 detail JSON 里，
 * 因为 `st:diagnostic` 的形状是既有的、不能改（改了会打中宿主 toast 闸门与包I 分类）。
 */
export function absorbFrameDiagnostic(diagnostic: unknown, meta?: { frameId?: string; cardId?: string }): PalinkDiagRecord | null {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const d = diagnostic as Record<string, unknown>;
  const rawDetail = typeof d.detail === 'string' ? d.detail : '';
  let payload: Record<string, unknown> | null = null;
  if (rawDetail.startsWith('palinkDiag:')) {
    try {
      const parsed = JSON.parse(rawDetail.slice('palinkDiag:'.length));
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (!payload) return null;
  const owner = PALINK_DIAG_OWNERS.includes(payload.owner as PalinkDiagOwner)
    ? (payload.owner as PalinkDiagOwner)
    : 'frame_compat';
  return recordPalinkDiag({
    owner,
    kind: String(payload.kind || 'frame_record'),
    name: String(payload.name ?? ''),
    detail: String(payload.detail ?? ''),
    stack: String(payload.stack ?? String(d.stack ?? '')),
    filename: String(payload.filename ?? ''),
    lineno: Number.isFinite(payload.lineno) ? Number(payload.lineno) : -1,
    colno: Number.isFinite(payload.colno) ? Number(payload.colno) : -1,
    textLength: Number.isFinite(payload.textLength) ? Number(payload.textLength) : -1,
    count: Number.isFinite(payload.count) ? Number(payload.count) : 1,
    frameId: String(meta?.frameId ?? payload.frameId ?? ''),
    cardId: String(meta?.cardId ?? payload.cardId ?? ''),
    origin: 'frame',
  });
}

export function palinkDiagRecords(): PalinkDiagRecord[] {
  return state.records.slice();
}

export function palinkDiagTotals(): Record<string, number> {
  const totals: Record<string, number> = { records: state.records.length, events: 0, dropped: state.dropped };
  for (const rec of state.records) {
    totals.events += rec.count;
    totals[`owner:${rec.owner}`] = (totals[`owner:${rec.owner}`] || 0) + 1;
    totals[`kind:${rec.kind}`] = (totals[`kind:${rec.kind}`] || 0) + 1;
    if (rec.missingStSubsystem) totals[`stGap:${rec.missingStSubsystem}`] = (totals[`stGap:${rec.missingStSubsystem}`] || 0) + 1;
  }
  return totals;
}

/**
 * 缺口排行（台账 §1-2 要的那张表）：按**事件数**（count 累计，不是记录条数）降序，
 * 同数按 id 字典序，保证两次跑出来可比。
 * 空 id（非 host_capability）不进排行；`unknown` 保留在最后，它代表"踩到了但没归族"，
 * 是下一批台账条目的原料，不许当零处理。
 */
export function palinkDiagStGapRanking(): Array<{ id: string; records: number; events: number }> {
  const byId = new Map<string, { records: number; events: number }>();
  for (const rec of state.records) {
    const id = rec.missingStSubsystem;
    if (!id) continue;
    const cur = byId.get(id) || { records: 0, events: 0 };
    cur.records += 1;
    cur.events += rec.count;
    byId.set(id, cur);
  }
  return Array.from(byId.entries())
    .map(([id, v]) => ({ id, records: v.records, events: v.events }))
    .sort((a, b) => (b.events - a.events) || (b.records - a.records) || (a.id < b.id ? -1 : 1));
}

/** 导出用的 JSON 字符串（不含正文，只含长度与身份字段——细节字段本身已由写入方截断）。 */
export function palinkDiagDump(): string {
  return JSON.stringify(
    {
      schema: 'palink-diag/v1',
      enabled: palinkDiagEnabled(),
      generatedAt: new Date().toISOString(),
      limits: DIAG_LIMITS,
      totals: palinkDiagTotals(),
      stGapRanking: palinkDiagStGapRanking(),
      records: state.records,
    },
    null,
    2,
  );
}

/** 一行汇总（各类计数 + 前几名）。禁止逐条刷屏。 */
export function palinkDiagSummaryLine(): string {
  const top = state.records
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((r) => `${r.kind}:${r.name || '-'}×${r.count}`)
    .join(' ');
  const owners = PALINK_DIAG_OWNERS.map((o) => `${o}=${countByOwner(o)}`).join(' ');
  return `[palink-diag] records=${state.records.length} events=${palinkDiagTotals().events} dropped=${state.dropped} ${owners}${top ? ' | top: ' + top : ''}`;
}

let summaryTimer: ReturnType<typeof setTimeout> | null = null;
let summaryPrintedOnce = false;

/**
 * 控制台汇总：**一行**，节流 5s，且只在开发者模式（开关开）时打。
 * 只复用同一个 timer id，不每次新建定时器链。
 */
export function scheduleSummary(delayMs = 5000): void {
  if (typeof console === 'undefined') return;
  if (!palinkDiagEnabled()) return;
  if (!summaryPrintedOnce) {
    summaryPrintedOnce = true;
    try {
      console.info(palinkDiagSummaryLine());
    } catch {
      /* console 被剥掉就算了 */
    }
    return;
  }
  if (summaryTimer !== null) return;
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    try {
      console.info(palinkDiagSummaryLine());
    } catch {
      /* ignore */
    }
  }, delayMs);
}

export function flushPalinkDiagSummary(): void {
  if (summaryTimer !== null) {
    clearTimeout(summaryTimer);
    summaryTimer = null;
  }
  summaryPrintedOnce = false;
}

/** 本地下载 JSON。零上传。 */
export function exportPalinkDiag(filename = 'palink-diag.json'): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const blob = new Blob([palinkDiagDump()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

export function resetPalinkDiagForTest(): void {
  state.records.length = 0;
  state.dropped = 0;
  state.enabledOverride = null;
  flushPalinkDiagSummary();
}

/**
 * 宿主主文档侧的 rejection / script error 取证（包W · K-3 同一条病灶的另一半）。
 *
 * 只装**一对**监听器（不是每卡一个，且幂等），且不拦事件、不 preventDefault、
 * 不调 toast ⇒ 用户可见行为与改前完全一致；只是原来"除了 toast 什么都不留"的
 * 这条轨，现在同时进记录器（带 filename / lineno / colno / stack / reason）。
 *
 * 归属口径：网络型失败（Failed to fetch / NetworkError / Load failed）⇒ host_capability
 * （能不能连通由宿主网络面决定），其余 ⇒ frame_compat（兼容层/主文档自己的问题）。
 * 语法类错误另记 kind=card_script_injection_failed? 不 —— 主文档的脚本错误一律记
 * host_script_error，卡脚本的语法错由 card-script-runner 带身份记录，避免同一失败两条同名。
 */
const PALINK_NETWORK_REJECTION_MARKERS = ['failed to fetch', 'networkerror', 'load failed', 'network request failed', 'network error'];

export function installPalinkDiagHostRejectionTrack(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__palinkDiagHostTrackInstalled === true) return;
  w.__palinkDiagHostTrackInstalled = true;
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = event?.reason as Record<string, unknown> | string | undefined;
      let message = '';
      let stack = '';
      if (reason && typeof reason === 'object') {
        message = typeof reason.message === 'string' ? reason.message : String(reason.name || reason.type || 'rejection');
        stack = typeof reason.stack === 'string' ? reason.stack : '';
      } else if (reason !== undefined) {
        message = String(reason);
      } else {
        message = 'rejection-with-empty-reason';
      }
      const low = message.toLowerCase();
      recordPalinkDiag({
        owner: PALINK_NETWORK_REJECTION_MARKERS.some((needle) => low.includes(needle)) ? 'host_capability' : 'frame_compat',
        kind: 'unhandled_rejection',
        name: message.slice(0, 120),
        detail: `主文档 rejection 轨取证（origin=host；reason 形态 ${reason && typeof reason === 'object' ? 'object' : typeof reason}）`,
        stack,
        origin: 'host',
      });
    } catch {
      /* 取证失败不得影响页面 */
    }
  });
  window.addEventListener('error', (event: ErrorEvent) => {
    try {
      const message = typeof event?.message === 'string' ? event.message : '';
      if (!message) return;
      recordPalinkDiag({
        owner: 'frame_compat',
        kind: 'host_script_error',
        name: message.slice(0, 120),
        detail: '主文档未捕获脚本错误（toast 判定未受影响，本条只进记录器）',
        stack: typeof event.error?.stack === 'string' ? event.error.stack : '',
        filename: typeof event.filename === 'string' ? event.filename : '',
        lineno: typeof event.lineno === 'number' ? event.lineno : -1,
        colno: typeof event.colno === 'number' ? event.colno : -1,
        origin: 'host',
      });
    } catch {
      /* 同上 */
    }
  });
}

/**
 * 挂全局可读入口（父侧）。重复调用幂等。
 *   window.__palinkDiagDump()      → JSON 字符串（含各帧已上送的部分）
 *   window.__palinkDiagRecords()   → 数组
 *   window.__palinkDiagSummary()   → 一行汇总字符串
 *   window.__palinkDiagExport()    → 下载 JSON
 *   window.__palinkDiagSetEnabled(bool|null) → 手动开关
 *   window.__palinkDiagRecord(...) → 宿主代码写一条
 *   window.__palinkDiagRanking()   → 缺口排行数组（按事件数降序）
 */
export function installPalinkDiagGlobals(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  w.__palinkDiagDump = palinkDiagDump;
  w.__palinkDiagRecords = palinkDiagRecords;
  w.__palinkDiagSummary = palinkDiagSummaryLine;
  w.__palinkDiagExport = exportPalinkDiag;
  w.__palinkDiagSetEnabled = (value: boolean | null) => setPalinkDiagEnabled(value);
  w.__palinkDiagRecord = recordPalinkDiag;
  w.__palinkDiagEnabled = palinkDiagEnabled;
  // [包Z Z-3] 缺口排行此前只能从 __palinkDiagDump() 的 JSON 里解出来，控制台手查要先 parse。
  w.__palinkDiagRanking = palinkDiagStGapRanking;
  if (palinkDiagEnabled()) scheduleSummary();
}
