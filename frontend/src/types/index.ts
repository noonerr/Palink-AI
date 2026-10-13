// ========================================
// Type Definitions
// ========================================

export type * from './tts';
export type * from './imageGeneration';

export interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
  thumbnail?: string;
  size?: number;
}

export interface User {
  id: string | number;
  username: string;
  avatar?: string;
  role: 'user' | 'admin';
  storage_used?: number;
  chat_count?: number;
  tokens_chat?: number;
  tokens_workspace?: number;
  tokens_character?: number;
  tokens_total?: number;
  /** LLM token 额度：null/undefined = 不限（管理员未设置） */
  quota_tokens?: number | null;
  quota_used_tokens?: number;
  /** 按自然月自动清零已用量 */
  quota_monthly_reset?: boolean;
}

export interface Model {
  id: string;
  name: string;
  alias?: string;
  provider: string;
  /** undefined = 未设置（后端按 model_specs 清单/4096 兜底） */
  context_length?: number;
  max_output_tokens?: number;
  icon?: string;
  avatar?: string;
  description?: string;
  supports_vision?: boolean;
  unified_id?: string;
  provider_count?: number;
  provider_id?: string;
  providers?: { provider_id: string; provider_name: string }[];
  is_test_model?: boolean;
  // 新增字段：思考模式和输出 token 控制
  enable_thinking?: boolean;
  /** 思考强度（off/auto/min/low/medium/high/max），模型级全局默认；后端 provider_registry 会自动补 auto */
  reasoning_effort?: string;
}

export interface UnifiedModelProvider {
  provider_id: string;
  provider_name: string;
  provider_type: 'api' | 'local';
  model_id: string;
  base_url?: string;
  api_key_resolved?: boolean;
  supports_vision: boolean;
  context_length: number;
  enabled: boolean;
}

export interface UnifiedModel {
  unified_id: string;
  display_name: string;
  icon: string;
  description: string;
  model_type: string;
  providers: UnifiedModelProvider[];
  context_length?: number;
  max_output_tokens?: number;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: Model[];
  is_active?: boolean;
  /** 网关管理（可选，P2-3）：base_url 指向 new-api/one-api 系网关时的后台地址与凭据 */
  admin_url?: string;
  admin_username?: string;
  /** 明文密码不会从后端回显（返回空串），保存时留空则保留原值 */
  admin_password?: string;
}

export interface Session {
  id: string;
  title: string;
  type: 'chat' | 'workspace' | 'character';
  character_id?: string;
  character?: Character;
  updated_at: string;
}

export interface Message {
  id?: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  created_at?: string;
  tokens?: number;
  summary?: string;
  webSearchResults?: { query: string; results: { title: string; snippet: string; url: string }[] };
  extra?: Record<string, unknown>;
}

export interface FileItem {
  id: string;
  filename: string;
  type: string;
  size: number;
  url?: string;
  created_at: string;
  summary?: string;
}

export interface Folder {
  id: string;
  name: string;
  created_at: string;
}

export interface WorkspaceItems {
  folders: Folder[];
  files: FileItem[];
  usage: number;
  limit: number;
}

export interface SystemDefaults {
  default_chat_model?: string;
  default_workspace_model?: string;
  default_outline_model?: string;
  daily_topic_model?: string;
}

export interface Translations {
  [key: string]: string;
}

export type Theme = 'light' | 'dark' | 'auto';
export type Language = 'zh' | 'en';

export type RoleplayChatStyle = 'flat' | 'bubbles' | 'document';

export interface RoleplayThemeColors {
  '--rp-color-main-text'?: string;
  '--rp-color-italics-text'?: string;
  '--rp-color-chat-bg'?: string;
  '--rp-color-ui-bg'?: string;
  '--rp-color-ui-border'?: string;
  '--rp-color-bot-msg'?: string;
  '--rp-color-user-msg'?: string;
  '--rp-color-timestamps'?: string;
  [key: string]: string | undefined;
}

export interface RoleplayThemeLayout {
  chatWidth: number;
  fontScale: number;
  blurStrength: number;
  shadowWidth: number;
}

export interface RoleplayThemeToggles {
  reducedMotion: boolean;
  noBlur: boolean;
  noTextShadow: boolean;
  chatTimestamps: boolean;
  messageTokenCount: boolean;
  useNativeStRendering: boolean;
}

export interface RoleplayThemeBackground {
  url?: string;
  overlay?: string;
}

export interface RoleplayThemeConfig {
  id: string;
  name: string;
  colors: RoleplayThemeColors;
  layout: RoleplayThemeLayout;
  toggles: RoleplayThemeToggles;
  customCSS: string;
  background: RoleplayThemeBackground;
  chatStyle: RoleplayChatStyle;
}

// 角色特定 UI 自定义配置
export interface CharacterThemeConfig {
  primary_color?: string;
  secondary_color?: string;
  accent_color?: string;
  text_color?: string;
  bg_color?: string;
  border_color?: string;
}

export interface CharacterBackgroundConfig {
  type?: 'image' | 'color' | 'aurora' | 'none';
  image_url?: string;
  image_blur?: number;
  image_opacity?: number;
  color?: string;
}

export interface CharacterMessageBubbleConfig {
  user_bg_color?: string;
  assistant_bg_color?: string;
  user_text_color?: string;
  assistant_text_color?: string;
  border_radius?: string;
}

export interface CharacterEffectsConfig {
  aurora_enabled?: boolean;
  aurora_color1?: string;
  aurora_color2?: string;
  aurora_color3?: string;
  animation_speed?: number;
}

export interface CharacterUIConfig {
  theme?: CharacterThemeConfig;
  background?: CharacterBackgroundConfig;
  message_bubbles?: CharacterMessageBubbleConfig;
  effects?: CharacterEffectsConfig;
  custom_css?: string;
}

export type SmartCardRenderMode =
  | 'auto'
  | 'iframe-js'
  | 'static-html'
  | 'inline-html'
  | 'immersive-sandbox'
  | 'immersive-trusted-native';

export type SmartCardRuntimeMode = 'sandbox' | 'native-trusted' | 'static-html';

export interface SillyTavernPluginRuntimeItem {
  id: string;
  name: string;
  plugin_type: string;
  version?: string | null;
  author?: string | null;
  source_type?: string | null;
  settings?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  capabilities?: Record<string, unknown> | string[];
  extension_settings?: Record<string, unknown>;
  resources?: {
    css?: Array<{
      path?: string;
      content?: string | null;
      missing?: boolean;
    }>;
    js?: Array<{
      path?: string;
      zip_path?: string | null;
      content?: string | null;
      missing?: boolean;
      execute?: boolean;
    }>;
    templates?: Array<{
      path?: string;
      zip_path?: string | null;
      content?: string | null;
      missing?: boolean;
    }>;
    modules?: Array<{
      path?: string;
      zip_path?: string | null;
      content?: string | null;
      missing?: boolean;
    }>;
    assets?: Array<{
      path?: string;
      mime?: string | null;
    }>;
  };
}

export interface SillyTavernPluginRuntimeConfig {
  plugins: SillyTavernPluginRuntimeItem[];
  extension_settings: Record<string, unknown>;
  generated_at?: string;
}

export interface SmartCardCompatDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  apiName?: string;
  message: string;
  detail?: string;
  args?: unknown[];
  stack?: string;
  runtimeVersion?: string;
  runtimeMode?: SmartCardRuntimeMode;
  timestamp?: number;
}

export interface SillyTavernCompatContext extends CharacterSmartCardContext {
  runtimeMode?: SmartCardRuntimeMode;
}

export interface SillyTavernCompatRequest {
  requestId: string;
  action: string;
  payload?: Record<string, unknown>;
}

export interface SillyTavernCompatResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CharacterSmartCardContext {
  characterId?: string;
  characterName?: string;
  userName?: string;
  language?: Language;
  messageId?: string | number;
  messageIndex?: number;
  messageContent?: string;
  chatMessages?: Array<{
    id?: string | number | null;
    role?: string;
    name?: string;
    content?: string;
    mes?: string;
    message?: string;
    text?: string;
    created_at?: string;
    mesid?: number;
    message_id?: string | number | null;
    is_user?: boolean;
    is_system?: boolean;
    is_name?: boolean;
    force_avatar?: string;
    original_avatar?: string;
    avatar?: string;
    gen_id?: string;
    group_id?: string;
    group_name?: string;
    selected_group?: unknown;
    groups?: Array<Record<string, unknown>>;
    swipes?: string[];
    swipe_id?: number;
    swipe_info?: Array<Record<string, unknown>>;
    extra?: Record<string, unknown>;
  }>;
  persistedStorage?: {
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
  };
  firstMes?: string;
  alternateGreetings?: string[];
  // [S1-G7 2026-10-13] 会话绑定的角色世界书名。用于在 srcdoc 构建期把它内联进 shim，
  // 让帧内**同步** API（getCharWorldbookNames / getCharLorebooks / getCurrentCharPrimaryLorebook）
  // 首次调用就有值 —— 帧内桥是异步的，不内联则首次必为空（MVU 只在模块顶层读一次，等不起）。
  worldbookName?: string;
  // [S1-G6 2026-10-13] IDB 分库止血开关（主框架 localStorage `palink_idb_namespace === '0'`）。
  // 必须由父侧读好下发：卡 iframe 里 window.parent 是 legacy 安全代理，
  // 读不到主框架的 localStorage（详见 card-idb-namespace.ts 的 readIdbNamespaceKillSwitch）。
  idbNamespaceDisabled?: boolean;
  characterExtensions?: Record<string, unknown> | string | null;
  presetData?: Record<string, unknown> | null;
  globalRegexScripts?: Array<Record<string, unknown>>;
  stPluginRuntimeConfig?: SillyTavernPluginRuntimeConfig | null;
  sessionId?: string;
  variables?: { stat_data?: Record<string, unknown> } & Record<string, unknown>;
  depth?: number;
  isInit?: boolean;
  presentationMode?: 'inline' | 'immersive-sandbox' | 'immersive-trusted-native';
  trustedNative?: boolean;
  sourceFingerprint?: string;
  viewport?: {
    width?: number;
    height?: number;
    visualWidth?: number;
    visualHeight?: number;
    offsetTop?: number;
    offsetLeft?: number;
    scale?: number;
    safeTop?: number;
    safeBottom?: number;
    composerHeight?: number;
    availableHeight?: number;
    keyboardOpen?: boolean;
    immersive?: boolean;
  };
}

export interface Character {
  id: string;
  name: string;
  description?: string;
  background?: string;
  personality?: string;
  avatar?: string;
  created_at: string;
  updated_at: string;
  user_nickname?: string;
  processing_status?: string;
  is_processing?: boolean;
  // Silly Tavern 兼容字段
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  tags?: string[];
  creator?: string;
  character_version?: string;
  extensions?: Record<string, any>;
  preset_data?: Record<string, any> | null;
  alternate_greetings?: string[];
  has_alternate_greetings?: boolean;
  creator_notes?: string;
  post_history_instructions?: string;
  avatar_url?: string;
  greeting?: string;
  has_character_book?: boolean;
  // 角色特定 UI 配置
  ui_config?: CharacterUIConfig;
  // ST V3 角色卡多模态资源（图片/音频等）
  assets?: CharacterAsset[];
}

/**
 * ST V3 角色卡 asset 项
 */
export interface CharacterAsset {
  type?: string;      // 'icon' | 'cover' | 'background' | 'theme' | ...
  uri?: string;       // data URL 或外部 URL
  name?: string;      // 资源名（如 'default_avatar'）
  ext?: string;       // 扩展字段
}

export interface CharacterChatSession {
  id: string;
  title?: string;
  character_id?: string;
  user_id?: number;
  created_at: string;
  updated_at: string;
}

export interface CharacterChatSessionBranch {
  id: string;
  session_id: string;
  parent_branch_id?: string | null;
  parent_message_id?: number | null;
  branch_name: string;
  is_active: boolean;
  is_frozen?: boolean;
  is_favorited?: boolean;
  last_message_at?: string | null;
  created_at: string;
}

export interface CharacterChatMessage {
  id?: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  created_at?: string;
  tokens?: number;
  branch_id?: string;
  name?: string;
  mesid?: number;
  message_id?: string | number | null;
  is_user?: boolean;
  is_system?: boolean;
  is_name?: boolean;
  force_avatar?: string;
  original_avatar?: string;
  avatar?: string;
  gen_id?: string;
  group_id?: string;
  group_name?: string;
  selected_group?: unknown;
  groups?: Array<Record<string, unknown>>;
  swipes?: string[];
  swipe_id?: number;
  swipe_info?: Array<Record<string, unknown>>;
  // 后端序列化消息时 is_hidden 为顶层字段（character_ext.py _serialize_character_message），
  // 非 extra 内嵌；hidden 消息在装配层已被过滤，仅前端展示用
  is_hidden?: boolean;
  extra?: Record<string, unknown>;
}

// OC (Original Character) 旧类型已于 2026-09-07 移除：设置页「用户人设」统一走
// lib/personas（Persona 体系，/api/personas），见 components/ui/custom/OCSettings.tsx

// ── World Book (世界书) ──

export interface WorldBook {
  id: string;
  name: string;
  description?: string;
  source_type: 'upload' | 'online_edit';
  raw_content?: string;
  format: 'silly_tavern_v2' | 'custom';
  type: 'character_book' | 'world_book';
  tags?: string[];
  is_parsed: boolean;
  stage_count: number;
  character_id?: string;
  created_at: string;
  updated_at: string;
}

export interface WorldBookStage {
  id: string;
  world_book_id: string;
  stage_index: number;
  title?: string;
  content: string;
  summary?: string;
  transition_hint?: string;
  priority: number;
  token_count: number;
  image_prompt?: string;
  // Keyword-trigger fields
  keys?: string[];
  secondary_keys?: string[];
  scan_depth: number;
  position: number;
  selective: boolean;
  probability: number;
  constant: boolean;
  /**
   * 是否启用语义召回（后端 WorldBookStage.vectorized）。
   * 勾选后该条目不再走关键词扫描，只认向量命中（worldbook_service 接管分支）。
   * 注意：这是**第一方 UI 面**类型；插件面另有一套
   * `lib/worldbook/types.ts::WorldBookEntry.vectorized`，两者不要混。
   */
  vectorized: boolean;
}

export interface WorldBookDetail extends Omit<WorldBook, 'stage_count'> {
  stages: WorldBookStage[];
}

export interface SessionWorldBook {
  id: string;
  session_id: string;
  world_book_id: string;
  world_book?: WorldBook;
  stages?: WorldBookStage[];
  created_at: string;
  updated_at: string;
}

export interface WorldBookStatus {
  active: boolean;
  world_book_id?: string;
  world_book_name?: string;
  active_entries_count: number;
  entries_overview?: Array<{ id: string; title?: string; keys_preview: string }>;
}

export interface PlotLine {
  id: string;
  name: string;
  description?: string;
  raw_content?: string;
  tags?: string[];
  is_parsed: boolean;
  stage_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlotStage {
  id: string;
  plot_line_id: string;
  stage_index: number;
  title?: string;
  content: string;
  summary?: string;
  transition_hint?: string;
  priority: number;
  token_count: number;
}

export interface PlotLineDetail extends Omit<PlotLine, 'stage_count'> {
  stages: PlotStage[];
}

export interface SessionPlotLine {
  id: string;
  session_id: string;
  plot_line_id: string;
  current_stage_index: number;
  stage_transition_mode: 'auto' | 'manual';
  plot_line?: PlotLine;
  stages?: PlotStage[];
  created_at: string;
  updated_at: string;
}

export interface PlotLineStatus {
  active: boolean;
  plot_line_id?: string;
  plot_line_name?: string;
  current_stage_index?: number;
  total_stages?: number;
  stage_transition_mode?: string;
  current_stage?: PlotStage;
  stages_overview?: Array<{ index: number; title?: string; summary?: string }>;
}

export interface PlotStageTransitionResult {
  previous_stage_index: number;
  current_stage_index: number;
  stage_title?: string;
  total_stages: number;
}

export interface GenerationPreset {
  id: number;
  user_id?: number;
  name: string;
  is_default: boolean;
  activation_regex?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  min_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  system_prompt_override?: string;
  post_history_instructions?: string;
  ban_sequences?: string[];
  logit_bias?: Record<string, number>;
  // ST 1.18.0 context template binding — name of ContextTemplate to apply.
  context_template_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryStats {
  message_count: number;
  token_count: number;
  oldest_message_hours: number;
  compression_needed: boolean;
  compression_reason: string;
}

export interface OAuthProviderInfo {
  name: string;
  display_name: string;
}

export interface AuthConfig {
  local_login_enabled: boolean;
  local_register_enabled: boolean;
  oauth_providers: OAuthProviderInfo[];
}

export interface OAuthProviderConfig {
  name: string;
  display_name: string;
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  userinfo_url: string;
  scopes: string;
  enabled: boolean;
}

export interface AdminAuthConfig {
  local_login_enabled: boolean;
  local_register_enabled: boolean;
  oauth_providers: OAuthProviderConfig[];
}

