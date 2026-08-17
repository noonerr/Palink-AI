/**
 * 插件管理器
 * 管理插件的发现、加载、启用/禁用
 */

import type {
  PluginManifest,
  PluginInstance,
  PluginContext,
  PluginManagerConfig,
  PluginStorage,
  PluginRuntimePayload,
  PluginRuntimeResources,
} from './types';
import { PluginStatus } from './types';
import { storageManager } from './storage';
import { createPluginContext } from './context';
import { pluginSandbox } from './sandbox';
import { api } from '@/services/api';
import { emitEvent } from '../event-bus';

/**
 * Task 8: 外部资源 URL 加载域名白名单
 * 仅允许 HTTPS 协议且域名在白名单内的外部资源加载，
 * 防止插件从不可信来源加载恶意代码。
 */
const EXTERNAL_RESOURCE_DOMAIN_WHITELIST = new Set<string>([
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'raw.githubusercontent.com',
  'github.com',
]);

/**
 * Task 8: 验证外部资源 URL 是否安全（HTTPS + 白名单域名）
 */
function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return EXTERNAL_RESOURCE_DOMAIN_WHITELIST.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Task 8: 从外部 URL 加载资源内容（带白名单验证）
 * @returns 加载的文本内容，加载失败返回 null
 */
async function fetchExternalResource(url: string): Promise<string | null> {
  if (!isAllowedExternalUrl(url)) {
    console.warn(`[PluginManager] 外部资源 URL 被白名单拒绝: ${url}`);
    return null;
  }
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) {
      console.warn(`[PluginManager] 外部资源加载失败 (${response.status}): ${url}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.warn(`[PluginManager] 外部资源 fetch 异常: ${url}`, e);
    return null;
  }
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: PluginManagerConfig = {
  autoLoad: true,
  maxPlugins: 50,
  sandboxMode: false,
};

/**
 * 将后端 runtime payload 转换为前端 PluginManifest
 * 后端 manifest 是原始 ST 清单（含 js/css 路径），需要映射到 entry/styles/hooks
 */
function payloadToManifest(payload: PluginRuntimePayload): PluginManifest {
  const rawManifest = payload.manifest || {};
  // ST manifest 中的 js 字段是入口文件路径（如 "index.js"）
  const entry = rawManifest.js || rawManifest.entry || '';
  // ST manifest 中的 css 字段是 CSS 文件路径数组
  const styles = Array.isArray(rawManifest.css) ? rawManifest.css : (rawManifest.styles || []);
  return {
    id: payload.id,
    name: payload.name,
    displayName: rawManifest.display_name || rawManifest.displayName || payload.name,
    version: payload.version || rawManifest.version || '',
    description: rawManifest.description,
    author: payload.author || rawManifest.author,
    loadingOrder: rawManifest.loading_order ?? rawManifest.loadingOrder ?? 0,
    entry,
    styles,
    requires: rawManifest.requires,
    optional: rawManifest.optional,
    hooks: rawManifest.hooks,
    type: rawManifest.type,
    enabled: true,
  };
}

/**
 * 插件管理器
 */
export class PluginManager {
  private plugins: Map<string, PluginInstance> = new Map();
  private config: PluginManagerConfig;
  private loaded = false;

  constructor(config?: Partial<PluginManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 发现插件
   */
  async discover(): Promise<PluginManifest[]> {
    try {
      const result = await api.get<{ plugins: PluginRuntimePayload[] }>('/api/plugins/runtime/config');
      if (result?.plugins) {
        const manifests: PluginManifest[] = [];
        for (const payload of result.plugins) {
          if (!this.plugins.has(payload.name)) {
            const manifest = payloadToManifest(payload);
            this.plugins.set(payload.name, {
              manifest,
              status: PluginStatus.DISCOVERED,
              resources: payload.resources,
              extensionSettings: payload.extension_settings,
              settings: payload.settings,
              pluginType: payload.plugin_type,
            });
            manifests.push(manifest);
          }
        }
        return manifests;
      }
      return [];
    } catch (error) {
      console.error('Failed to discover plugins:', error);
      return [];
    }
  }

  /**
   * 加载插件
   */
  async load(name: string): Promise<boolean> {
    const instance = this.plugins.get(name);
    if (!instance) {
      console.error(`Plugin not found: ${name}`);
      return false;
    }

    if (instance.status === PluginStatus.LOADED || instance.status === PluginStatus.ACTIVE) {
      return true;
    }

    try {
      instance.status = PluginStatus.LOADING;

      // tavern_helper 类型插件（如酒馆助手）是大型 IIFE 经典脚本，
      // 需要真实 DOM 环境和全局变量（$、document、window 等），
      // 由 SillyTavernPluginRuntime 通过 <script> 标签直接注入执行，
      // 不在沙箱中运行（沙箱缺少完整全局环境，4MB+ 脚本易出错）。
      if (instance.pluginType === 'tavern_helper') {
        instance.status = PluginStatus.LOADED;
        instance.loadedAt = new Date().toISOString();
        emitEvent('plugin:loaded', { name });
        return true;
      }

      // 创建插件上下文
      const storage = storageManager.getStore(name);
      const context = createPluginContext(name, storage);

      instance.context = context;

      // 通过沙箱执行插件 JS 入口
      // Task 8: 支持内联 content 和外部 URL 两种加载方式
      const resources = instance.resources;
      // 暴露本插件的 HTML 模板给沙箱，供 renderExtensionTemplateAsync 渲染设置面板（修复 P0 桩）
      (context as unknown as Record<string, unknown>).pluginTemplates = resources?.templates || [];
      if (resources?.js && instance.manifest.entry) {
        // 找到与 entry 路径匹配的 JS 资源
        const jsResource = resources.js.find(
          j => j.path === instance.manifest.entry || j.execute
        );
        // Task 8: 优先使用内联 content，无 content 时尝试从 url 加载
        let jsContent = jsResource?.content;
        if (!jsContent && jsResource?.url) {
          jsContent = await fetchExternalResource(jsResource.url);
        }
        if (jsContent) {
          try {
            // 组装插件本地多文件模块表：入口(js) + 其余模块(modules)，
            // 统一剥掉 zip 顶层目录前缀，使 ./core/xxx.js 等相对 import 能被解析。
            //
            // 关键修正：前缀必须从 **zip_path**（恒含 zip 顶层目录，如
            // 'palink-sample-extension/core/constants.js'）推断，而非 `path`。
            // 后端 _import_sillytavern_extension_zip 存库时已将 `path` 剥掉顶层目录
            // （js='index.js'、module='core/constants.js'），顶层目录只留在 zip_path。
            // 若从 `path` 推断，会把 'core/constants.js' 的首段 'core' 误判为顶层目录并剥掉，
            // 得到 'constants.js'，与插件 require('./core/constants.js') 解析出的
            // 'core/constants.js' 不匹配 → 模块返回空对象 → EXT_ID 变 undefined → 注入失败。
            // zip_path 的公共顶层段才是真正的 zip 根目录，剥离它对已去前缀的 path 为 no-op、
            // 对仍带前缀的 path 则正确剥离，二者皆安全。
            const allZipPaths = [...(resources?.js || []), ...(resources?.modules || [])]
              .map((f: any) => String(f.zip_path || f.path || ''));
            const prefix = (() => {
              const segs = allZipPaths
                .filter((p: string) => p.includes('/'))
                .map((p: string) => p.slice(0, p.indexOf('/')));
              const uniq = Array.from(new Set(segs));
              return uniq.length === 1 ? uniq[0] : '';
            })();
            const stripPrefix = (p: string) =>
              prefix && p.startsWith(prefix + '/') ? p.slice(prefix.length + 1) : p;
            const localFiles = [...(resources?.js || []), ...(resources?.modules || [])]
              .filter((f: any) => f && typeof f.content === 'string')
              .map((f: any) => ({
                path: stripPrefix(String(f.path || '').replace(/^\.\//, '').replace(/^\//, '')),
                content: f.content as string,
              }));
            const entryPath = stripPrefix(
              String(jsResource?.path || instance.manifest.entry || 'index.js')
                .replace(/^\.\//, '')
                .replace(/^\//, ''),
            );
            await pluginSandbox.executePluginCode(jsContent, context, name, entryPath, localFiles);

            // 调用 hooks.activate 初始化函数
            const activateHook = instance.manifest.hooks?.activate;
            if (activateHook) {
              await pluginSandbox.callActivateHook(name, activateHook);
            }
          } catch (jsError) {
            console.warn(`Plugin ${name} JS execution failed (non-fatal):`, jsError);
            instance.error = String(jsError);
          }
        }
      }

      // 注入插件 CSS（内联 content 或外部 URL）
      if (resources?.css && resources.css.length > 0) {
        for (const cssResource of resources.css) {
          // Task 8: 优先使用内联 content，无 content 时尝试从 url 加载
          let cssContent = cssResource.content;
          if (!cssContent && cssResource.url) {
            cssContent = await fetchExternalResource(cssResource.url);
          }
          if (cssContent) {
            try {
              pluginSandbox.injectPluginCSS(name, cssContent);
            } catch (cssError) {
              console.warn(`Plugin ${name} CSS injection failed:`, cssError);
            }
          }
        }
      }

      // 判断是否首次加载（无 loadedAt 表示首次）
      const wasFirstLoad = !instance.loadedAt;
      instance.status = PluginStatus.LOADED;
      instance.loadedAt = new Date().toISOString();

      // 调用生命周期钩子：首次加载调用 install，否则调用 update
      if (wasFirstLoad) {
        await this.callHook(name, 'install').catch(e => {
          console.warn(`Plugin ${name} install hook failed:`, e);
        });
      } else {
        await this.callHook(name, 'update').catch(e => {
          console.warn(`Plugin ${name} update hook failed:`, e);
        });
      }

      emitEvent('plugin:loaded', { name });
      return true;
    } catch (error) {
      instance.status = PluginStatus.ERROR;
      instance.error = String(error);
      emitEvent('plugin:error', { name, error: String(error) });
      return false;
    }
  }

  /**
   * 卸载插件
   */
  async unload(name: string): Promise<boolean> {
    const instance = this.plugins.get(name);
    if (!instance) return false;

    // 调用 hooks.delete 生命周期钩子（卸载前清理，等待完成后再清理资源）
    try {
      await this.callHook(name, 'delete');
    } catch (e) {
      console.warn(`Plugin ${name} delete hook failed:`, e);
    }

    // 清理沙箱资源（命令/宏/事件监听器/CSS/定时器）
    pluginSandbox.cleanupPlugin(name);

    instance.status = PluginStatus.DISCOVERED;
    instance.context = undefined;
    instance.loadedAt = undefined;

    emitEvent('plugin:unloaded', { name });
    return true;
  }

  /**
   * 启用插件
   */
  async enable(name: string): Promise<boolean> {
    const instance = this.plugins.get(name);
    if (!instance) return false;

    // 依赖检查
    const depCheck = this.checkDependencies(name);
    if (!depCheck.ok) {
      instance.error = `Missing dependencies: ${depCheck.missing.join(', ')}`;
      emitEvent('plugin:error', { name, error: instance.error });
      return false;
    }

    if (instance.status !== PluginStatus.LOADED && instance.status !== PluginStatus.DISABLED) {
      // 先加载
      const loaded = await this.load(name);
      if (!loaded) return false;
    }

    instance.manifest.enabled = true;
    instance.status = PluginStatus.ACTIVE;

    // 调用 hooks.enable 生命周期钩子
    await this.callHook(name, 'enable');

    emitEvent('plugin:enabled', { name });
    return true;
  }

  /**
   * 禁用插件
   */
  async disable(name: string): Promise<boolean> {
    const instance = this.plugins.get(name);
    if (!instance) return false;

    // 调用 hooks.disable 生命周期钩子（禁用前清理）
    await this.callHook(name, 'disable');

    instance.manifest.enabled = false;
    instance.status = PluginStatus.DISABLED;

    emitEvent('plugin:disabled', { name });
    return true;
  }

  /**
   * 调用插件生命周期钩子
   * 钩子函数名由 manifest.hooks 指定，通过沙箱执行
   */
  private async callHook(name: string, hookType: 'install' | 'update' | 'delete' | 'enable' | 'disable' | 'activate'): Promise<void> {
    const instance = this.plugins.get(name);
    if (!instance) return;

    const hookFnName = instance.manifest.hooks?.[hookType];
    if (!hookFnName) return;

    const moduleExports = pluginSandbox.getModuleExports(name);
    if (!moduleExports) {
      console.warn(`Plugin ${name} not loaded, cannot call hook ${hookType}`);
      return;
    }

    const hookFn = moduleExports[hookFnName] as ((...args: any[]) => any) | undefined;
    if (typeof hookFn !== 'function') {
      console.warn(`Plugin ${name} hook ${hookType} (${hookFnName}) is not a function`);
      return;
    }

    try {
      await hookFn();
    } catch (error) {
      console.error(`Plugin ${name} hook ${hookType} execution failed:`, error);
      throw error;
    }
  }

  /**
   * 检查插件依赖
   * @returns { ok: 是否满足, missing: 缺失的依赖列表 }
   */
  checkDependencies(name: string): { ok: boolean; missing: string[] } {
    const instance = this.plugins.get(name);
    if (!instance) return { ok: false, missing: ['plugin not found'] };

    const required = instance.manifest.requires || [];
    const missing: string[] = [];

    for (const req of required) {
      // 检查是否已安装且启用
      const depInstance = this.plugins.get(req);
      if (!depInstance) {
        missing.push(req);
      } else if (depInstance.status !== PluginStatus.ACTIVE && depInstance.status !== PluginStatus.LOADED) {
        missing.push(`${req} (not active)`);
      }
    }

    return { ok: missing.length === 0, missing };
  }

  /**
   * 检查可选依赖
   */
  checkOptionalDependencies(name: string): { available: string[]; missing: string[] } {
    const instance = this.plugins.get(name);
    if (!instance) return { available: [], missing: [] };

    const optional = instance.manifest.optional || [];
    const available: string[] = [];
    const missing: string[] = [];

    for (const opt of optional) {
      const depInstance = this.plugins.get(opt);
      if (depInstance && (depInstance.status === PluginStatus.ACTIVE || depInstance.status === PluginStatus.LOADED)) {
        available.push(opt);
      } else {
        missing.push(opt);
      }
    }

    return { available, missing };
  }

  /**
   * 获取插件
   */
  getPlugin(name: string): PluginInstance | undefined {
    return this.plugins.get(name);
  }

  /**
   * 获取所有插件
   */
  getAllPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 获取活跃插件
   */
  getActivePlugins(): PluginInstance[] {
    return Array.from(this.plugins.values()).filter(
      p => p.status === PluginStatus.ACTIVE
    );
  }

  /**
   * 获取插件上下文
   */
  getContext(name: string): PluginContext | undefined {
    return this.plugins.get(name)?.context;
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    if (this.loaded) return;

    // 发现插件
    await this.discover();

    // 自动加载
    if (this.config.autoLoad) {
      for (const [name, instance] of this.plugins.entries()) {
        if (instance.manifest.enabled !== false) {
          await this.enable(name);
        }
      }
    }

    this.loaded = true;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PluginManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): PluginManagerConfig {
    return { ...this.config };
  }
}

/**
 * 创建插件管理器实例
 */
export function createPluginManager(config?: Partial<PluginManagerConfig>): PluginManager {
  return new PluginManager(config);
}

// 导出单例
export const pluginManager = new PluginManager();
