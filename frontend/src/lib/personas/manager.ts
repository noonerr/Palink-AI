/**
 * Personas 管理器
 * 管理用户角色的CRUD和绑定
 */

import type { Persona, PersonaSettings, PersonaManagerConfig } from './types';
import { emitEvent } from '../event-bus';
import { api } from '@/services/api';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: PersonaManagerConfig = {
  maxPersonas: 50,
  autoSelect: true,
};

/**
 * Personas 管理器
 */
export class PersonaManager {
  private personas: Map<string, Persona> = new Map();
  private settings: PersonaSettings = {
    activePersonaId: null,
    defaultPersonaId: null,
    lockPersona: false,
    lockToCharacter: false,
  };
  private config: PersonaManagerConfig;
  private backendInitialized = false;

  constructor(config?: Partial<PersonaManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从后端加载Personas
   */
  async init(): Promise<void> {
    if (this.backendInitialized) return;
    this.backendInitialized = true;
    try {
      const remote = await api.get<Array<{
        id: string;
        name: string;
        description: string;
        avatar?: string;
        characterBindings: Record<string, string>;
        isDefault: boolean;
        personaShow?: boolean;
        personaDescriptionPosition?: number;
        createdAt: string;
        updatedAt: string;
      }>>('/api/personas');
      if (Array.isArray(remote)) {
        for (const p of remote) {
          const persona: Persona = {
            id: p.id,
            name: p.name,
            description: p.description ?? '',
            avatar: p.avatar,
            isDefault: !!p.isDefault,
            characterBindings: p.characterBindings ?? {},
            personaShow: p.personaShow ?? false,
            personaDescriptionPosition: p.personaDescriptionPosition ?? 0,
            createdAt: p.createdAt ?? new Date().toISOString(),
            updatedAt: p.updatedAt ?? new Date().toISOString(),
          };
          this.personas.set(persona.id, persona);
          if (persona.isDefault) {
            this.settings.defaultPersonaId = persona.id;
          }
        }
        if (!this.settings.activePersonaId && this.personas.size > 0) {
          this.settings.activePersonaId = this.settings.defaultPersonaId
            ?? this.personas.values().next().value?.id
            ?? null;
        }
      }
    } catch (error) {
      console.error('[PersonaManager] Failed to load personas from backend:', error);
    }
  }

  /**
   * 同步Persona到后端（fire-and-forget）
   */
  private _syncPersonaToBackend(persona: Persona, isNew: boolean): void {
    const payload = {
      id: persona.id,
      name: persona.name,
      description: persona.description,
      avatar: persona.avatar,
      character_bindings: persona.characterBindings,
      is_default: persona.isDefault,
    };
    if (isNew) {
      api.post('/api/personas', payload).catch((e) => {
        console.error('[PersonaManager] Failed to create persona on backend:', e);
      });
    } else {
      api.put(`/api/personas/${persona.id}`, {
        name: persona.name,
        description: persona.description,
        avatar: persona.avatar,
        character_bindings: persona.characterBindings,
        is_default: persona.isDefault,
      }).catch((e) => {
        console.error('[PersonaManager] Failed to update persona on backend:', e);
      });
    }
  }

  /**
   * 从后端删除Persona（fire-and-forget）
   */
  private _deletePersonaFromBackend(personaId: string): void {
    api.delete(`/api/personas/${personaId}`).catch((e) => {
      console.error('[PersonaManager] Failed to delete persona from backend:', e);
    });
  }

  /**
   * 创建Persona
   */
  createPersona(name: string, description: string, options?: Partial<Persona>): Persona {
    const id = `persona-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const persona: Persona = {
      id,
      name,
      description,
      isDefault: false,
      characterBindings: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...options,
    };

    this.personas.set(id, persona);

    // 如果是第一个，设为默认
    if (this.personas.size === 1) {
      this.settings.defaultPersonaId = id;
      this.settings.activePersonaId = id;
      persona.isDefault = true;
    }

    this._syncPersonaToBackend(persona, true);
    emitEvent('persona:created', { personaId: id });
    return persona;
  }

  /**
   * 获取Persona
   */
  getPersona(id: string): Persona | undefined {
    return this.personas.get(id);
  }

  /**
   * 获取所有Persona
   */
  getAllPersonas(): Persona[] {
    return Array.from(this.personas.values());
  }

  /**
   * 获取活跃Persona
   */
  getActivePersona(): Persona | null {
    if (!this.settings.activePersonaId) return null;
    return this.personas.get(this.settings.activePersonaId) ?? null;
  }

  /**
   * 更新Persona
   */
  updatePersona(id: string, updates: Partial<Persona>): Persona | undefined {
    const persona = this.personas.get(id);
    if (!persona) return undefined;

    const updated = { ...persona, ...updates, updatedAt: new Date().toISOString() };
    this.personas.set(id, updated);

    this._syncPersonaToBackend(updated, false);
    emitEvent('persona:updated', { personaId: id });
    return updated;
  }

  /**
   * 删除Persona
   */
  deletePersona(id: string): boolean {
    const deleted = this.personas.delete(id);
    if (deleted) {
      this._deletePersonaFromBackend(id);
      if (this.settings.activePersonaId === id) {
        this.settings.activePersonaId = this.settings.defaultPersonaId;
      }
      if (this.settings.defaultPersonaId === id) {
        const first = this.personas.values().next().value;
        this.settings.defaultPersonaId = first?.id ?? null;
      }
      emitEvent('persona:deleted', { personaId: id });
    }
    return deleted;
  }

  /**
   * 选择Persona
   */
  selectPersona(id: string | null): void {
    this.settings.activePersonaId = id;
    emitEvent('persona:selected', { personaId: id });
  }

  /**
   * 设置默认Persona
   */
  setDefaultPersona(id: string): void {
    this.settings.defaultPersonaId = id;
  }

  /**
   * 绑定Persona到角色
   */
  bindToCharacter(personaId: string, characterId: string): boolean {
    const persona = this.personas.get(personaId);
    if (!persona) return false;

    persona.characterBindings[characterId] = personaId;
    persona.updatedAt = new Date().toISOString();

    this._syncPersonaToBackend(persona, false);
    emitEvent('persona:bound', { personaId, characterId });
    return true;
  }

  /**
   * 解绑Persona和角色
   */
  unbindFromCharacter(personaId: string, characterId: string): boolean {
    const persona = this.personas.get(personaId);
    if (!persona) return false;

    delete persona.characterBindings[characterId];
    persona.updatedAt = new Date().toISOString();

    this._syncPersonaToBackend(persona, false);
    emitEvent('persona:unbound', { personaId, characterId });
    return true;
  }

  /**
   * 获取角色绑定的Persona
   */
  getPersonaForCharacter(characterId: string): Persona | null {
    for (const persona of this.personas.values()) {
      if (persona.characterBindings[characterId]) {
        return persona;
      }
    }
    return null;
  }

  /**
   * 获取设置
   */
  getSettings(): PersonaSettings {
    return { ...this.settings };
  }

  /**
   * 更新设置
   */
  updateSettings(updates: Partial<PersonaSettings>): void {
    this.settings = { ...this.settings, ...updates };
  }

  /**
   * 锁定/解锁Persona
   */
  toggleLock(): void {
    this.settings.lockPersona = !this.settings.lockPersona;
  }
}

/**
 * 创建Personas管理器实例
 */
export function createPersonaManager(config?: Partial<PersonaManagerConfig>): PersonaManager {
  return new PersonaManager(config);
}

// 导出单例
export const personaManager = new PersonaManager();
