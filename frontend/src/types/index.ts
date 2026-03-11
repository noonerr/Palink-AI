// ========================================
// Type Definitions
// ========================================

export interface User {
  id: string;
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
}

export interface WorldBookDetail extends Omit<WorldBook, 'stage_count'> {
  stages: WorldBookStage[];
}

export interface SessionWorldBook {
  id: string;
  session_id: string;
  world_book_id: string;
  current_stage_index: number;
  stage_transition_mode: 'auto' | 'manual';
  world_book?: WorldBook;
  stages?: WorldBookStage[];
  created_at: string;
  updated_at: string;
}

export interface WorldBookStatus {
  active: boolean;
  world_book_id?: string;
  world_book_name?: string;
  current_stage_index?: number;
  total_stages?: number;
  stage_transition_mode?: string;
  current_stage?: WorldBookStage;
  stages_overview?: Array<{ index: number; title?: string; summary?: string }>;
}

export interface StageTransitionResult {
  previous_stage_index: number;
  current_stage_index: number;
  stage_title?: string;
  total_stages: number;
}
