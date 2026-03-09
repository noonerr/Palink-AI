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
}

export interface Model {
  id: string;
  name: string;
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
  parent_message_id?: number;
  branch_name: string;
  is_active: boolean;
  created_at: string;
}

export interface CharacterChatMessage {
  id?: number;
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
