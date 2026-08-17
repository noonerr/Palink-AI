/**
 * 插件系统类型定义
 * 基于 SillyTavern 1.18.0 extensions.js
 */

// ============================================================
// 插件清单
// ============================================================

/**
 * 插件生命周期钩子
 */
export type PluginHook = 
  | 'install'
  | 'update'
  | 'delete'
  | 'enable'
  | 'disable'
  | 'activate';

/**
 * 插件清单
 */
export interface PluginManifest {
  /** 后端插件ID（UUID），用于资源URL拼接 */
  id?: string;
  name: string;
  displayName: string;
  version: string;
  description?: string;
  author?: string;
  
  // 加载配置
  loadingOrder: number;
  entry: string;           // JS入口文件
  styles?: string[];       // CSS文件列表
  
  // 依赖
  requires?: string[];     // 必需的后端模块
  optional?: string[];     // 可选的后端模块
  
  // 生命周期钩子
  hooks?: {
    install?: string;
    update?: string;
    delete?: string;
    enable?: string;
    disable?: string;
    activate?: string;
  };
  
  // 元数据
  type?: 'system' | 'local' | 'global';
  enabled?: boolean;
}

// ============================================================
// 插件状态
// ============================================================

/**
 * 插件状态
 */
export enum PluginStatus {
  DISCOVERED = 'discovered',
  LOADING = 'loading',
  LOADED = 'loaded',
  ACTIVE = 'active',
  ERROR = 'error',
  DISABLED = 'disabled',
}

/**
 * 插件实例
 */
export interface PluginInstance {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  loadedAt?: string;
  context?: PluginContext;
  /** 后端返回的内联资源（JS/CSS/模板内容），避免额外 fetch */
  resources?: PluginRuntimeResources;
  /** 后端返回的扩展设置 */
  extensionSettings?: Record<string, any>;
  /** 后端返回的插件设置 */
  settings?: Record<string, any>;
  /** 后端返回的插件类型（tavern_helper / sillytavern_extension 等） */
  pluginType?: string;
}

/**
 * 后端运行时资源（内联内容或外部 URL）
 */
export interface PluginRuntimeResources {
  js: Array<{ path: string; content: string | null; execute: boolean; url?: string }>;
  css: Array<{ path: string; content: string | null; url?: string }>;
  templates: Array<{ path: string; content: string | null; url?: string }>;
  modules: Array<{ path: string; content: string | null; url?: string }>;
  assets: Array<{ path: string; mime: string }>;
}

/**
 * 后端 /api/plugins/runtime/config 返回的单个插件 payload
 */
export interface PluginRuntimePayload {
  id: string;
  name: string;
  plugin_type: string;
  version: string;
  author: string;
  source_type: string;
  settings: Record<string, any>;
  manifest: Record<string, any>;
  runtime: Record<string, any>;
  capabilities: Record<string, any>;
  extension_settings: Record<string, any>;
  resources: PluginRuntimeResources;
}

// ============================================================
// 插件上下文
// ============================================================

/**
 * 插件上下文 - 提供给插件的API
 */
export interface PluginContext {
  // 事件系统
  on: (event: string, callback: (...args: any[]) => void) => void;
  off: (event: string, callback: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  once: (event: string, callback: (...args: any[]) => void) => void;
  removeAllListeners: (event?: string) => void;
  
  // 存储
  storage: PluginStorage;
  
  // 注册能力
  registerCommand: (command: any) => void;
  registerMacro: (name: string, options: any) => void;
  
  // 日志
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * 插件存储接口
 */
export interface PluginStorage {
  get<T>(key: string, defaultValue?: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
}

// ============================================================
// 插件管理器配置
// ============================================================

/**
 * 插件管理器配置
 */
export interface PluginManagerConfig {
  autoLoad?: boolean;
  maxPlugins?: number;
  sandboxMode?: boolean;
}

// ============================================================
// 插件事件
// ============================================================

export interface PluginEvents {
  'plugin:loaded': { name: string };
  'plugin:unloaded': { name: string };
  'plugin:enabled': { name: string };
  'plugin:disabled': { name: string };
  'plugin:error': { name: string; error: string };
}
