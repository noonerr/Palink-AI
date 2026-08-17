/**
 * Personas 选择器
 * 管理Persona的选择和切换逻辑
 */

import type { Persona, PersonaSettings } from './types';
import { personaManager } from './manager';

/**
 * Persona选择器
 */
export class PersonaSelector {
  /**
   * 获取可选的Persona列表
   */
  getSelectablePersonas(): Persona[] {
    return personaManager.getAllPersonas();
  }

  /**
   * 选择Persona
   */
  select(personaId: string): boolean {
    const persona = personaManager.getPersona(personaId);
    if (!persona) return false;

    personaManager.selectPersona(personaId);
    return true;
  }

  /**
   * 自动选择Persona（基于角色绑定）
   */
  autoSelectForCharacter(characterId: string): Persona | null {
    const settings = personaManager.getSettings();
    
    // 如果锁定，不切换
    if (settings.lockPersona) {
      return personaManager.getActivePersona();
    }

    // 尝试角色绑定
    const bound = personaManager.getPersonaForCharacter(characterId);
    if (bound) {
      personaManager.selectPersona(bound.id);
      return bound;
    }

    // 使用默认
    if (settings.defaultPersonaId) {
      personaManager.selectPersona(settings.defaultPersonaId);
      return personaManager.getPersona(settings.defaultPersonaId) ?? null;
    }

    return null;
  }

  /**
   * 获取当前选择
   */
  getCurrentSelection(): { persona: Persona | null; locked: boolean } {
    const settings = personaManager.getSettings();
    return {
      persona: personaManager.getActivePersona(),
      locked: settings.lockPersona,
    };
  }

  /**
   * 切换锁定状态
   */
  toggleLock(): boolean {
    personaManager.toggleLock();
    return personaManager.getSettings().lockPersona;
  }
}

/**
 * 创建Persona选择器实例
 */
export function createPersonaSelector(): PersonaSelector {
  return new PersonaSelector();
}

// 导出单例
export const personaSelector = new PersonaSelector();
