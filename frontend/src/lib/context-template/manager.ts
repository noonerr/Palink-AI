/**
 * Context Template 管理器
 *
 * 提供获取/选择/编辑 context template 的 API 封装。
 * 基于 SillyTavern 1.18.0 context template 配置，对应后端
 * /api/roleplay/context-templates 端点。
 *
 * 内置模板（is_builtin=true）不可删除，但可编辑 story_string 等字段。
 */

import { api } from '@/services/api';
import type { ContextTemplate, ContextTemplatePayload } from './types';

const DEFAULT_TEMPLATE_NAME = 'Default';
const STORAGE_KEY = 'palink_context_template_selected';

/**
 * ContextTemplateManager 类
 *
 * 单例式管理器：缓存模板列表 + 当前选中模板名。
 * 调用 init() 从后端拉取模板列表并恢复 localStorage 中的选中状态。
 */
export class ContextTemplateManager {
  private templates: Map<string, ContextTemplate> = new Map();
  private selectedName: string | null = null;
  private initialized = false;

  /**
   * 从后端加载所有 context template，并恢复选中状态。
   * 多次调用是幂等的，会刷新缓存。
   */
  async init(): Promise<void> {
    try {
      // 触发内置模板的种子写入（idempotent），确保 Default 等模板存在
      await api.post('/api/roleplay/context-templates/ensure-builtin');
      const list: ContextTemplate[] = await api.get('/api/roleplay/context-templates');
      this.templates.clear();
      for (const t of list) {
        this.templates.set(t.name, t);
      }
      this.initialized = true;
    } catch (err) {
      console.error('[ContextTemplateManager] Failed to load templates:', err);
      this.initialized = true;
      return;
    }

    // 恢复选中状态：localStorage 优先，否则取 Default
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && this.templates.has(saved)) {
      this.selectedName = saved;
    } else if (this.templates.has(DEFAULT_TEMPLATE_NAME)) {
      this.selectedName = DEFAULT_TEMPLATE_NAME;
    } else if (this.templates.size > 0) {
      this.selectedName = this.templates.keys().next().value ?? null;
    }
  }

  /**
   * 获取所有模板（按 is_builtin 优先、name 字母序）
   */
  getAll(): ContextTemplate[] {
    const all = Array.from(this.templates.values());
    return all.sort((a, b) => {
      if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * 按名称获取模板
   */
  get(name: string): ContextTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * 获取当前选中的模板
   */
  getSelected(): ContextTemplate | null {
    if (!this.selectedName) return null;
    return this.templates.get(this.selectedName) ?? null;
  }

  /**
   * 获取当前选中的模板名
   */
  getSelectedName(): string | null {
    return this.selectedName;
  }

  /**
   * 选择模板（仅本地选中状态，不写后端）
   * 后端绑定通过 preset.context_template_name 字段完成。
   */
  select(name: string): boolean {
    if (!this.templates.has(name)) return false;
    this.selectedName = name;
    localStorage.setItem(STORAGE_KEY, name);
    return true;
  }

  /**
   * 创建新模板
   */
  async create(payload: ContextTemplatePayload): Promise<ContextTemplate | null> {
    try {
      const created: ContextTemplate = await api.post('/api/roleplay/context-templates', payload);
      this.templates.set(created.name, created);
      return created;
    } catch (err) {
      console.error('[ContextTemplateManager] Failed to create template:', err);
      return null;
    }
  }

  /**
   * 更新模板（内置模板的 name 字段不可更改）
   */
  async update(id: number, payload: Partial<ContextTemplatePayload>): Promise<ContextTemplate | null> {
    try {
      const updated: ContextTemplate = await api.put(`/api/roleplay/context-templates/${id}`, payload);
      // 处理 name 改变（仅非内置模板）
      const oldEntry = Array.from(this.templates.entries()).find(([, t]) => t.id === id);
      if (oldEntry && oldEntry[0] !== updated.name) {
        this.templates.delete(oldEntry[0]);
      }
      this.templates.set(updated.name, updated);
      if (this.selectedName === oldEntry?.[0]) {
        this.selectedName = updated.name;
        localStorage.setItem(STORAGE_KEY, updated.name);
      }
      return updated;
    } catch (err) {
      console.error('[ContextTemplateManager] Failed to update template:', err);
      return null;
    }
  }

  /**
   * 删除模板（内置模板不可删除，后端会返回 400）
   */
  async delete(id: number): Promise<boolean> {
    const entry = Array.from(this.templates.entries()).find(([, t]) => t.id === id);
    if (!entry) return false;
    const [name, template] = entry;
    if (template.is_builtin) {
      console.warn('[ContextTemplateManager] Built-in templates cannot be deleted');
      return false;
    }
    try {
      await api.delete(`/api/roleplay/context-templates/${id}`);
      this.templates.delete(name);
      if (this.selectedName === name) {
        this.selectedName = DEFAULT_TEMPLATE_NAME;
        if (this.templates.has(DEFAULT_TEMPLATE_NAME)) {
          localStorage.setItem(STORAGE_KEY, DEFAULT_TEMPLATE_NAME);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      return true;
    } catch (err) {
      console.error('[ContextTemplateManager] Failed to delete template:', err);
      return false;
    }
  }

  /**
   * 重置为 Default 模板
   */
  resetToDefault(): boolean {
    return this.select(DEFAULT_TEMPLATE_NAME);
  }

  /**
   * 强制重新从后端加载
   */
  async refresh(): Promise<void> {
    await this.init();
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  getCount(): number {
    return this.templates.size;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * 单例实例
 */
export const contextTemplateManager = new ContextTemplateManager();

/**
 * 创建独立的管理器实例（用于测试或多实例场景）
 */
export function createContextTemplateManager(): ContextTemplateManager {
  return new ContextTemplateManager();
}
