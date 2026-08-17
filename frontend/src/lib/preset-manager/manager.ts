/**
 * Preset Manager - 通用预设管理器
 * 基于 SillyTavern preset-manager.js
 */

import type {
  Preset,
  PresetBackend,
  PresetManagerConfig,
  PresetChangeEvent,
} from './types';
import { emitEvent } from '../event-bus';

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: PresetManagerConfig = {
  storageKey: 'palink_presets',
  autoSave: true,
  maxPresets: 100,
};

// ============================================================
// PresetManager 类
// ============================================================

export class PresetManager<T = Record<string, any>> {
  private presets: Map<string, Preset<T>> = new Map();
  private selectedName: string | null = null;
  private config: PresetManagerConfig;
  private backend?: PresetBackend<T>;
  private onChange?: (event: PresetChangeEvent<T>) => void;

  constructor(options: {
    storageKey?: string;
    backend?: PresetBackend<T>;
    onChange?: (event: PresetChangeEvent<T>) => void;
  } = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      storageKey: options.storageKey || DEFAULT_CONFIG.storageKey,
    };
    this.backend = options.backend;
    this.onChange = options.onChange;
  }

  /**
   * 初始化（从后端或本地存储加载）
   */
  async init(): Promise<void> {
    if (this.backend) {
      try {
        const presets = await this.backend.loadAll();
        for (const preset of presets) {
          this.presets.set(preset.name, preset);
        }
      } catch (error) {
        console.error('[PresetManager] Failed to load presets from backend:', error);
      }
    } else {
      this.loadFromStorage();
    }

    // 恢复选中状态
    const savedSelected = localStorage.getItem(`${this.config.storageKey}_selected`);
    if (savedSelected && this.presets.has(savedSelected)) {
      this.selectedName = savedSelected;
    }
  }

  /**
   * 从本地存储加载
   */
  private loadFromStorage(): void {
    try {
      const saved = localStorage.getItem(this.config.storageKey);
      if (saved) {
        const presets = JSON.parse(saved) as Preset<T>[];
        for (const preset of presets) {
          this.presets.set(preset.name, preset);
        }
      }
    } catch (error) {
      console.error('[PresetManager] Failed to load from storage:', error);
    }
  }

  /**
   * 保存到本地存储
   */
  private saveToStorage(): void {
    if (this.config.autoSave && !this.backend) {
      try {
        const presets = Array.from(this.presets.values());
        localStorage.setItem(this.config.storageKey, JSON.stringify(presets));
      } catch (error) {
        console.error('[PresetManager] Failed to save to storage:', error);
      }
    }
  }

  /**
   * 获取所有预设
   */
  getAll(): Preset<T>[] {
    return Array.from(this.presets.values());
  }

  /**
   * 获取预设
   */
  get(name: string): Preset<T> | undefined {
    return this.presets.get(name);
  }

  /**
   * 保存预设
   */
  async save(name: string, data: T): Promise<void> {
    const now = Date.now();
    const existing = this.presets.get(name);

    const preset: Preset<T> = {
      name,
      data,
      isDefault: existing?.isDefault ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.presets.set(name, preset);

    // 保存到后端
    if (this.backend) {
      await this.backend.save(preset);
    }

    this.saveToStorage();
    this.emitChange({ type: existing ? 'update' : 'add', preset });
  }

  /**
   * 删除预设
   */
  async delete(name: string): Promise<void> {
    const preset = this.presets.get(name);
    if (!preset) return;

    this.presets.delete(name);

    // 如果删除的是当前选中的，清除选中状态
    if (this.selectedName === name) {
      this.selectedName = null;
      localStorage.removeItem(`${this.config.storageKey}_selected`);
    }

    // 从后端删除
    if (this.backend) {
      await this.backend.delete(name);
    }

    this.saveToStorage();
    this.emitChange({ type: 'delete', preset });
  }

  /**
   * 重命名预设
   */
  async rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    if (this.presets.has(newName)) {
      throw new Error(`Preset "${newName}" already exists`);
    }

    const preset = this.presets.get(oldName);
    if (!preset) {
      throw new Error(`Preset "${oldName}" not found`);
    }

    // 创建新预设
    const renamed: Preset<T> = {
      ...preset,
      name: newName,
      updatedAt: Date.now(),
    };

    this.presets.delete(oldName);
    this.presets.set(newName, renamed);

    // 更新选中状态
    if (this.selectedName === oldName) {
      this.selectedName = newName;
      localStorage.setItem(`${this.config.storageKey}_selected`, newName);
    }

    // 保存到后端
    if (this.backend) {
      await this.backend.delete(oldName);
      await this.backend.save(renamed);
    }

    this.saveToStorage();
    this.emitChange({ type: 'rename', preset: renamed, oldName, newName });
  }

  /**
   * 获取当前选中的预设
   */
  getSelected(): Preset<T> | null {
    if (!this.selectedName) return null;
    return this.presets.get(this.selectedName) ?? null;
  }

  /**
   * 选择预设
   */
  select(name: string): void {
    if (!this.presets.has(name)) {
      throw new Error(`Preset "${name}" not found`);
    }

    this.selectedName = name;
    localStorage.setItem(`${this.config.storageKey}_selected`, name);

    const preset = this.presets.get(name)!;
    this.emitChange({ type: 'select', preset });
  }

  /**
   * 设置默认预设
   */
  setDefault(name: string): void {
    // 清除所有默认
    for (const preset of this.presets.values()) {
      preset.isDefault = false;
    }

    // 设置新的默认
    const preset = this.presets.get(name);
    if (preset) {
      preset.isDefault = true;
      this.saveToStorage();
    }
  }

  /**
   * 获取默认预设
   */
  getDefault(): Preset<T> | null {
    for (const preset of this.presets.values()) {
      if (preset.isDefault) return preset;
    }
    return null;
  }

  /**
   * 自动匹配预设
   */
  autoSelect(matchName: string): void {
    // 精确匹配
    if (this.presets.has(matchName)) {
      this.select(matchName);
      return;
    }

    // 模糊匹配
    const lowerMatch = matchName.toLowerCase();
    for (const name of this.presets.keys()) {
      if (name.toLowerCase().includes(lowerMatch)) {
        this.select(name);
        return;
      }
    }
  }

  /**
   * 导出预设
   */
  export(names?: string[]): string {
    let presets: Preset<T>[];
    
    if (names) {
      presets = names
        .map(name => this.presets.get(name))
        .filter((p): p is Preset<T> => p !== undefined);
    } else {
      presets = Array.from(this.presets.values());
    }

    return JSON.stringify(presets, null, 2);
  }

  /**
   * 导入预设
   */
  async import(json: string): Promise<number> {
    try {
      const presets = JSON.parse(json) as Preset<T>[];
      if (!Array.isArray(presets)) {
        throw new Error('Invalid format: expected array');
      }

      let imported = 0;
      for (const preset of presets) {
        if (preset.name && preset.data) {
          await this.save(preset.name, preset.data);
          imported++;
        }
      }

      return imported;
    } catch (error) {
      console.error('[PresetManager] Import failed:', error);
      return 0;
    }
  }

  /**
   * 获取预设数量
   */
  getCount(): number {
    return this.presets.size;
  }

  /**
   * 检查预设是否存在
   */
  has(name: string): boolean {
    return this.presets.has(name);
  }

  /**
   * 清空所有预设
   */
  clear(): void {
    this.presets.clear();
    this.selectedName = null;
    localStorage.removeItem(`${this.config.storageKey}_selected`);
    this.saveToStorage();
  }

  /**
   * 触发变更事件
   */
  private emitChange(event: PresetChangeEvent<T>): void {
    this.onChange?.(event);
    emitEvent('preset:changed', {
      type: event.type,
      name: event.preset?.name || event.newName || '',
    });
  }
}

/**
 * 创建预设管理器实例
 */
export function createPresetManager<T>(options?: {
  storageKey?: string;
  backend?: PresetBackend<T>;
  onChange?: (event: PresetChangeEvent<T>) => void;
}): PresetManager<T> {
  return new PresetManager(options);
}
