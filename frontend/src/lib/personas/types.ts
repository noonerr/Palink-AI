/**
 * Personas 类型定义
 * 基于 SillyTavern 1.18.0 personas.js
 */

// ============================================================
// Persona
// ============================================================

/**
 * 用户角色（Persona）
 */
export interface Persona {
  id: string;
  name: string;
  description: string;
  avatar?: string;
  isDefault: boolean;

  // 角色绑定
  characterBindings: Record<string, string>; // characterId → personaId

  // ST 1.18.0 persona description injection controls
  personaShow?: boolean;              // 是否将 description 注入提示词
  personaDescriptionPosition?: number; // 0=in story, 1=after post-history, 2=last in chat, 3=inactive

  // 元数据
  createdAt: string;
  updatedAt: string;
}

/**
 * Persona设置
 */
export interface PersonaSettings {
  activePersonaId: string | null;
  defaultPersonaId: string | null;
  lockPersona: boolean;           // 是否锁定当前Persona
  lockToCharacter: boolean;       // 是否锁定到角色
}

// ============================================================
// Persona管理器配置
// ============================================================

export interface PersonaManagerConfig {
  maxPersonas: number;
  autoSelect: boolean;
}

// ============================================================
// Persona事件
// ============================================================

export interface PersonaEvents {
  'persona:created': { personaId: string };
  'persona:updated': { personaId: string };
  'persona:deleted': { personaId: string };
  'persona:selected': { personaId: string | null };
  'persona:bound': { personaId: string; characterId: string };
  'persona:unbound': { personaId: string; characterId: string };
}
