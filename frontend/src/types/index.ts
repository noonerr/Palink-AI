// ========================================
// Type Definitions
// ========================================

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
}

export interface Model {
  id: string;
  name: string;
  alias?: string;
  provider: string;
  context_length: number;
  icon?: string;
  avatar?: string;
  description?: string;
  supports_vision?: boolean;
  unified_id?: string;
  provider_count?: number;
  provider_id?: string;
  is_test_model?: boolean;
}

export interface UnifiedModelProvider {
  provider_id: string;
  provider_name: string;
  provider_type: 'api' | 'local';
  model_id: string;
  base_url: string;
  api_key_resolved: boolean;
  supports_vision: boolean;
  context_length: number;
  priority: number;
  weight: number;
  enabled: boolean;
  max_rpm: number;
  max_concurrent: number;
  max_tokens_per_min: number;
}

export interface UnifiedModel {
  unified_id: string;
  display_name: string;
  icon: string;
  description: string;
  model_type: string;
  providers: UnifiedModelProvider[];
  routing_strategy: 'priority' | 'round_robin' | 'weighted';
  failover_enabled: boolean;
}

export interface RoutingStrategy {
  id: string;
  name: string;
  description: string;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: Model[];
  is_active?: boolean;
}

export interface Session {
  id: string;
  title: string;
  type: 'chat' | 'workspace' | 'character';
  character_id?: string;
  character?: Character;
  dialogue_mode?: 'first_person' | 'third_person';
  updated_at: string;
}

export interface Message {
  id?: string | number;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  created_at?: string;
  tokens?: number;
  summary?: string;
  webSearchResults?: { query: string; results: { title: string; snippet: string; url: string }[] };
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

export type Theme = 'light' | 'dark';
export type Language = 'zh' | 'en';
export type ViewTab = 'chat' | 'workspace' | 'settings' | 'characters';

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
  avatar_url?: string;
  greeting?: string;
}

// Silly Tavern 角色卡格式
export interface SillyTavernCharacterCard {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: {
    name: string;
    description: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt: string;
    tags: string[];
    creator: string;
    character_version: string;
    extensions: Record<string, any>;
  };
}

export interface CharacterChatSession {
  id: string;
  title?: string;
  character_id?: string;
  user_id?: number;
  dialogue_mode: string;
  created_at: string;
  updated_at: string;
}

export interface CharacterChatSessionBranch {
  id: string;
  session_id: string;
  parent_branch_id?: string;
  parent_message_id?: number | null;
  branch_name: string;
  is_active: boolean;
  created_at: string;
}

export interface CharacterChatMessage {
  id?: string | number;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  created_at?: string;
  tokens?: number;
  branch_id?: string;
}

// OC (Original Character) 相关类型
export interface OCCustomField {
  id: string;
  label: string;
  value: string;
}

export interface OCData {
  id: string;
  name: string;
  traits: string;
  personality: string;
  hobbies: string;
  background: string;
  avatar?: string;
  customFields: OCCustomField[];
  createdAt: string;
  updatedAt: string;
}

export interface OCConfig {
  allowAIAnalysis: boolean;
  defaultAnalysisModel: string;
}

// ── World Book (世界书) ──

export interface WorldBook {
  id: string;
  name: string;
  description?: string;
  source_type: 'upload' | 'online_edit';
  raw_content?: string;
  format: 'silly_tavern_v2' | 'custom';
  tags?: string[];
  is_parsed: boolean;
  stage_count: number;
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

