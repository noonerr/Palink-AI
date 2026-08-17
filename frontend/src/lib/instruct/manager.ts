/**
 * Instruct模式模板管理器
 * 管理Instruct模板的加载、保存、切换
 */

import type { InstructTemplate, InstructSettings } from './types';
import { NamesBehavior } from './types';

/**
 * 创建默认模板
 */
function createDefaultTemplate(name: string, overrides?: Partial<InstructTemplate>): InstructTemplate {
  return {
    name,
    input_sequence: '',
    output_sequence: '',
    system_sequence: '',
    input_suffix: '\n',
    output_suffix: '\n',
    system_suffix: '\n',
    first_output_sequence: '',
    last_output_sequence: '',
    first_input_sequence: '',
    last_input_sequence: '',
    last_system_sequence: '',
    system_instruction_prefix: '',
    stop_sequence: '',
    names_behavior: NamesBehavior.NONE,
    wrap: false,
    macro: true,
    skip_examples: false,
    system_same_as_user: false,
    sequences_as_stop_strings: true,
    bind_to_context: false,
    story_string_prefix: '',
    story_string_suffix: '',
    user_alignment_message: '',
    activation_regex: '',
    enabled: true,
    ...overrides,
  };
}

/**
 * Instruct模板管理器
 */
export class InstructManager {
  private templates: Map<string, InstructTemplate> = new Map();
  private activeTemplateName: string | null = null;

  constructor() {
    this.loadBuiltinTemplates();
  }

  /**
   * 加载内置模板
   */
  private loadBuiltinTemplates(): void {
    // Alpaca模板
    this.templates.set('alpaca', createDefaultTemplate('Alpaca', {
      input_sequence: '### Instruction:\n',
      output_sequence: '### Response:\n',
      system_sequence: '### System:\n',
    }));

    // Vicuna模板
    this.templates.set('vicuna', createDefaultTemplate('Vicuna', {
      input_sequence: 'USER: ',
      output_sequence: 'ASSISTANT: ',
      system_sequence: 'SYSTEM: ',
      stop_sequence: '</s>',
    }));

    // Llama2模板
    this.templates.set('llama2', createDefaultTemplate('Llama2', {
      input_sequence: '[INST] ',
      output_sequence: ' [/INST] ',
      system_sequence: '[INST] <<SYS>>\n',
      system_suffix: '\n<</SYS>>\n\n',
      stop_sequence: '</s>',
    }));
  }

  /**
   * 获取所有模板名称
   */
  getTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * 获取模板
   */
  getTemplate(name: string): InstructTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * 获取活跃模板
   */
  getActiveTemplate(): InstructTemplate | null {
    if (!this.activeTemplateName) return null;
    return this.templates.get(this.activeTemplateName) ?? null;
  }

  /**
   * 选择模板
   */
  selectTemplate(name: string): boolean {
    if (!this.templates.has(name)) return false;
    this.activeTemplateName = name;
    return true;
  }

  /**
   * 保存模板
   */
  saveTemplate(template: InstructTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * 删除模板
   */
  deleteTemplate(name: string): boolean {
    const deleted = this.templates.delete(name);
    if (deleted && this.activeTemplateName === name) {
      this.activeTemplateName = null;
    }
    return deleted;
  }

  /**
   * 导入模板
   */
  importTemplate(data: string): InstructTemplate | null {
    try {
      const parsed = JSON.parse(data);
      if (parsed.name && parsed.input_sequence !== undefined) {
        this.saveTemplate(parsed);
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 导出模板
   */
  exportTemplate(name: string): string | null {
    const template = this.templates.get(name);
    if (!template) return null;
    return JSON.stringify(template, null, 2);
  }

  /**
   * 检查是否有模板
   */
  hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }
}

/**
 * 创建Instruct管理器实例
 */
export function createInstructManager(): InstructManager {
  return new InstructManager();
}

// 导出单例
export const instructManager = new InstructManager();
