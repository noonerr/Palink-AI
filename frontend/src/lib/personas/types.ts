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
  // ST 1.18 枚举（personas.js:88-97）：0 IN_PROMPT / 2 TOP_AN / 3 BOTTOM_AN / 4 AT_DEPTH / 9 NONE
  personaDescriptionPosition?: number;
  personaDescriptionDepth?: number;   // AT_DEPTH(4) 时的注入深度，默认 4

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
