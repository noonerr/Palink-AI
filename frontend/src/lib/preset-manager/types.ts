/**
 * Preset Manager 类型定义
 * 基于 SillyTavern preset-manager.js
 */

// ============================================================
// 预设基础类型
// ============================================================

export interface Preset<T = Record<string, any>> {
  name: string;
  data: T;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// 预设后端接口
// ============================================================

export interface PresetBackend<T> {
  loadAll(): Promise<Preset<T>[]>;
  save(preset: Preset<T>): Promise<void>;
  delete(name: string): Promise<void>;
}

// ============================================================
// 预设管理器配置
// ============================================================

export interface PresetManagerConfig {
  storageKey: string;
  autoSave: boolean;
  maxPresets: number;
}

// ============================================================
// 预设变更事件
// ============================================================

export type PresetChangeEvent<T> = {
  type: 'add' | 'update' | 'delete' | 'select' | 'rename';
  preset?: Preset<T>;
  oldName?: string;
  newName?: string;
};
