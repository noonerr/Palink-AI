/**
 * Prompt Manager 管理器
 * 管理提示词条目的CRUD和预设
 */

import type {
  PromptEntry,
  PromptPreset,
  PromptManagerConfig,
  InjectionPosition,
  PromptRole,
} from './types';
import { emitEvent } from '../event-bus';
import { api } from '@/services/api';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: PromptManagerConfig = {
  maxEntries: 100,
  defaultPosition: 1, // AFTER
  defaultRole: 'system',
  autoSave: true,
};

/**
 * Prompt Manager
 */
export class PromptManagerClass {
  private entries: Map<string, PromptEntry> = new Map();
  private presets: Map<string, PromptPreset> = new Map();
  private config: PromptManagerConfig;
  private backendInitialized = false;

  constructor(config?: Partial<PromptManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从后端加载预设
   */
  async init(): Promise<void> {
    if (this.backendInitialized) return;
    this.backendInitialized = true;
    try {
      const remote = await api.get<Array<{
        id: string;
        name: string;
        entries: PromptEntry[];
        config?: any;
        created_at?: string;
        updated_at?: string;
      }>>('/api/prompt-manager/presets');
      if (Array.isArray(remote)) {
        for (const p of remote) {
          const preset: PromptPreset = {
            id: p.id,
            name: p.name,
            entries: Array.isArray(p.entries) ? p.entries : [],
            createdAt: p.created_at ?? new Date().toISOString(),
            updatedAt: p.updated_at ?? new Date().toISOString(),
          };
          this.presets.set(p.name, preset);
        }
      }
    } catch (error) {
      console.error('[PromptManager] Failed to load presets from backend:', error);
    }
  }

  /**
   * 同步预设到后端（fire-and-forget）
   */
  private _syncPresetToBackend(preset: PromptPreset): void {
    const payload = {
      name: preset.name,
      entries: preset.entries,
    };
    if (preset.id) {
      api.put(`/api/prompt-manager/presets/${preset.id}`, payload).catch((e) => {
        console.error('[PromptManager] Failed to sync preset to backend:', e);
      });
    } else {
      api.post<{ id: string }>('/api/prompt-manager/presets', payload).then((res) => {
        if (res && res.id) {
          const existing = this.presets.get(preset.name);
          if (existing) {
            existing.id = res.id;
          }
        }
      }).catch((e) => {
        console.error('[PromptManager] Failed to create preset on backend:', e);
      });
    }
  }

  /**
   * 从后端删除预设（fire-and-forget）
   */
  private _deletePresetFromBackend(preset: PromptPreset): void {
    if (!preset.id) return;
    api.delete(`/api/prompt-manager/presets/${preset.id}`).catch((e) => {
      console.error('[PromptManager] Failed to delete preset from backend:', e);
    });
  }

  /**
   * 添加提示词条目
   */
  addEntry(entry: Partial<PromptEntry> & { identifier: string; content: string }): PromptEntry {
    const fullEntry: PromptEntry = {
      name: entry.identifier,
      enabled: true,
      position: this.config.defaultPosition,
      depth: 0,
      role: this.config.defaultRole,
      order: this.entries.size,
      ...entry,
    };

    this.entries.set(fullEntry.identifier, fullEntry);
    emitEvent('prompt:added', { identifier: fullEntry.identifier });
    return fullEntry;
  }

  /**
   * 更新提示词条目
   */
  updateEntry(identifier: string, updates: Partial<PromptEntry>): boolean {
    const entry = this.entries.get(identifier);
    if (!entry) return false;

    Object.assign(entry, updates);
    emitEvent('prompt:updated', { identifier });
    return true;
  }

  /**
   * 删除提示词条目
   */
  removeEntry(identifier: string): boolean {
    const deleted = this.entries.delete(identifier);
    if (deleted) {
      emitEvent('prompt:removed', { identifier });
    }
    return deleted;
  }

  /**
   * 获取提示词条目
   */
  getEntry(identifier: string): PromptEntry | undefined {
    return this.entries.get(identifier);
  }

  /**
   * 获取所有条目
   */
  getAllEntries(): PromptEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * 获取启用的条目
   */
  getEnabledEntries(): PromptEntry[] {
    return Array.from(this.entries.values()).filter(e => e.enabled);
  }

  /**
   * 按位置获取条目
   */
  getEntriesByPosition(position: InjectionPosition): PromptEntry[] {
    return this.getEnabledEntries()
      .filter(e => e.position === position)
      .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  }

  /**
   * 保存预设
   */
  savePreset(name: string): void {
    const existing = this.presets.get(name);
    const now = new Date().toISOString();
    const preset: PromptPreset = {
      id: existing?.id,
      name,
      entries: Array.from(this.entries.values()),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.presets.set(name, preset);
    this._syncPresetToBackend(preset);
    emitEvent('preset:saved', { name });
  }

  /**
   * 加载预设
   */
  loadPreset(name: string): boolean {
    const preset = this.presets.get(name);
    if (!preset) return false;

    this.entries.clear();
    for (const entry of preset.entries) {
      this.entries.set(entry.identifier, entry);
    }

    emitEvent('preset:loaded', { name });
    return true;
  }

  /**
   * 删除预设
   */
  deletePreset(name: string): boolean {
    const preset = this.presets.get(name);
    const deleted = this.presets.delete(name);
    if (deleted && preset) {
      this._deletePresetFromBackend(preset);
    }
    return deleted;
  }

  /**
   * 获取预设列表
   */
  getPresetNames(): string[] {
    return Array.from(this.presets.keys());
  }

  /**
   * 导出预设
   */
  exportPreset(name: string): string | null {
    const preset = this.presets.get(name);
    if (!preset) return null;
    return JSON.stringify(preset, null, 2);
  }

  /**
   * 导入预设
   */
  importPreset(json: string): boolean {
    try {
      const preset = JSON.parse(json) as PromptPreset;
      if (preset.name && Array.isArray(preset.entries)) {
        const now = new Date().toISOString();
        const imported: PromptPreset = {
          ...preset,
          id: undefined,
          createdAt: preset.createdAt ?? now,
          updatedAt: now,
        };
        this.presets.set(preset.name, imported);
        this._syncPresetToBackend(imported);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 清空所有条目
   */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * 创建Prompt Manager实例
 */
export function createPromptManager(config?: Partial<PromptManagerConfig>): PromptManagerClass {
  return new PromptManagerClass(config);
}

// 导出单例
export const promptManager = new PromptManagerClass();
