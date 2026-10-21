/**
 * 插件/扩展目录的宿主侧读取与启停（批次R1 2026-10-21）。
 *
 * 这份模块只做三件事，全部复用**已有**后端端点，不新造端点、不建表不加列：
 *   1. `GET /api/plugins/runtime/config`（按登录态 user_id 过滤；管理员
 *      `include_disabled=1` 才拿得到禁用项）→ 帧内扩展读面的快照；
 *   2. `GET /api/users/me` → `isAdmin` 的真值（`role === 'admin'`，与 App.tsx:896 同口径）；
 *   3. `PUT /api/plugins/{id}/toggle` → 启用/停用（后端已按作用域收紧，见
 *      `backend/app/api/plugins.py` 的同名路由）。
 *
 * 为什么需要快照：ST 的 `getExtensionType` / `isInstalledExtension` 是同步契约
 * （`@types/function/extension.d.ts:15/40`），而帧内 requestParent 是异步的
 * ⇒ 同步键只能读宿主带进 ctx 的快照（与批次P3 的 presetSnapshot 同一套投递方式）。
 */
import { api, invalidateCache } from '@/services/api';
import { isCurrentUserAdmin, setCurrentUserRole } from '@/lib/current-user-role';
import type {
  SmartCardExtensionCatalog,
  SmartCardExtensionCatalogEntry,
  SillyTavernPluginRuntimeConfig,
  SillyTavernPluginRuntimeItem,
  User,
} from '@/types';

/** 启停成功后广播：已挂载的卡片帧据此重拉快照（context-update 热更进 ctx）。 */
export const SMART_CARD_EXTENSION_CATALOG_CHANGED_EVENT = 'palink:smart-card-extension-catalog-changed';

const RUNTIME_CONFIG_URL = '/api/plugins/runtime/config';
const RUNTIME_CONFIG_ADMIN_URL = '/api/plugins/runtime/config?include_disabled=1';
const USERS_ME_URL = '/api/users/me';
const RUNTIME_CONFIG_TTL_MS = 10_000;

function normalizeExtensionId(item: SillyTavernPluginRuntimeItem): string {
  const manifest = item && typeof item.manifest === 'object' && item.manifest ? item.manifest : {};
  const manifestName = typeof (manifest as Record<string, unknown>).name === 'string'
    ? String((manifest as Record<string, unknown>).name)
    : '';
  const name = typeof item.name === 'string' ? item.name : '';
  return manifestName || name || String(item.id || '');
}

function toCatalogEntry(item: SillyTavernPluginRuntimeItem): SmartCardExtensionCatalogEntry | null {
  if (!item || typeof item !== 'object' || !item.id) return null;
  const manifest = item && typeof item.manifest === 'object' && item.manifest ? item.manifest : {};
  const manifestName = typeof (manifest as Record<string, unknown>).name === 'string'
    ? String((manifest as Record<string, unknown>).name)
    : '';
  // 后端 _plugin_runtime_payload 的 owner_scope：global = plugins.user_id IS NULL。
  // 旧后端没有这一位时按 local 处理（更保守：不把别人的插件误报成全局）。
  const type: SmartCardExtensionCatalogEntry['type'] = item.owner_scope === 'global' ? 'global' : 'local';
  return {
    id: String(item.id),
    extensionId: normalizeExtensionId(item),
    name: typeof item.name === 'string' ? item.name : '',
    manifestName: manifestName || undefined,
    type,
    enabled: item.enabled !== false,
    version: item.version ?? null,
    sourceUrl: null,
  };
}

/**
 * 拉取当前用户作用域内的插件目录。管理员优先请求 `include_disabled=1`（含禁用项），
 * 被后端拒绝（例如角色判断与后端不一致）时降级为只含启用项，并在 `source` 里如实标注。
 */
export async function fetchSmartCardExtensionCatalog(): Promise<SmartCardExtensionCatalog> {
  let me: User | null = null;
  try {
    me = await api.get<User>(USERS_ME_URL, { cacheTtlMs: 30_000 });
  } catch {
    // 角色端点失败不阻塞目录读取：退回 App 写入的只读快照（可能为 null ⇒ 安全默认 false）。
    me = null;
  }
  if (me && (me.role === 'admin' || me.role === 'user')) {
    setCurrentUserRole(me.role);
  }
  const isAdmin = me ? me.role === 'admin' : isCurrentUserAdmin();

  let payload: SillyTavernPluginRuntimeConfig | null = null;
  let source: SmartCardExtensionCatalog['source'] = 'runtime_config';
  if (isAdmin) {
    try {
      payload = await api.get<SillyTavernPluginRuntimeConfig>(RUNTIME_CONFIG_ADMIN_URL, {
        cacheTtlMs: RUNTIME_CONFIG_TTL_MS,
      });
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    source = 'runtime_config_enabled_only';
    payload = await api.get<SillyTavernPluginRuntimeConfig>(RUNTIME_CONFIG_URL, {
      cacheTtlMs: RUNTIME_CONFIG_TTL_MS,
    });
  }

  const items = payload && Array.isArray(payload.plugins) ? payload.plugins : [];
  const plugins = items
    .map((item) => toCatalogEntry(item))
    .filter((entry): entry is SmartCardExtensionCatalogEntry => entry !== null);
  return {
    plugins,
    isAdmin,
    source,
    generatedAt: payload?.generated_at,
  };
}

/** ST 语义的 id 匹配：扩展内部名以调用方给的 id 结尾即命中（extension.ts:11-14）。 */
export function matchesSmartCardExtensionId(entry: SmartCardExtensionCatalogEntry, extensionId: unknown): boolean {
  const id = String(extensionId === undefined || extensionId === null ? '' : extensionId);
  if (!id) return false;
  const keys = [entry.extensionId, entry.name, entry.manifestName, entry.id];
  for (const key of keys) {
    const value = key ? String(key) : '';
    if (!value) continue;
    if (value === id) return true;
    if (value.length > id.length && value.slice(value.length - id.length) === id) return true;
  }
  return false;
}

export function findSmartCardExtension(
  catalog: SmartCardExtensionCatalog | null | undefined,
  extensionId: unknown,
): SmartCardExtensionCatalogEntry | null {
  const list = catalog && Array.isArray(catalog.plugins) ? catalog.plugins : [];
  for (const entry of list) {
    if (matchesSmartCardExtensionId(entry, extensionId)) return entry;
  }
  return null;
}

export interface SmartCardExtensionToggleResult {
  success: boolean;
  extensionId?: string;
  id?: string;
  enabled?: boolean;
  changed?: boolean;
  error?: string;
  message?: string;
  status?: number;
}

/**
 * 启用/停用当前用户作用域内的扩展。
 *
 * @param extensionId ST 语义的扩展 id（manifest.name / 插件 name / 后端 id 均可）
 * @param desiredEnabled 目标状态；缺省 = 取反当前状态（ST extension-toggle 语义）
 *
 * 越权面：目录本身来自按 user_id 过滤的 runtime/config ⇒ 他人的插件根本不在目录里，
 * 这里直接返回 extension_not_found（不发起 PUT）；全局插件对非管理员返回 admin_required
 * （与 ST `extension.ts:45-47` 的 403 文案同源）。后端还有第二道作用域校验。
 */
export async function toggleSmartCardExtension(
  extensionId: unknown,
  desiredEnabled?: boolean,
): Promise<SmartCardExtensionToggleResult> {
  let catalog: SmartCardExtensionCatalog;
  try {
    catalog = await fetchSmartCardExtensionCatalog();
  } catch (error: any) {
    return {
      success: false,
      error: 'extension_catalog_failed',
      message: String(error?.message || error || 'extension catalog failed'),
    };
  }
  const entry = findSmartCardExtension(catalog, extensionId);
  if (!entry) {
    return { success: false, error: 'extension_not_found', message: '扩展不存在' };
  }
  if (entry.type === 'global' && !catalog.isAdmin) {
    return { success: false, error: 'admin_required', message: '只有管理员才能切换全局扩展' };
  }
  const target = typeof desiredEnabled === 'boolean' ? desiredEnabled : !entry.enabled;
  if (target === entry.enabled) {
    return {
      success: true,
      extensionId: entry.extensionId,
      id: entry.id,
      enabled: entry.enabled,
      changed: false,
    };
  }
  try {
    const response = await api.put<{ enabled?: boolean }>(
      `/api/plugins/${encodeURIComponent(entry.id)}/toggle`,
    );
    const enabled = typeof response?.enabled === 'boolean' ? response.enabled : target;
    invalidateCache(RUNTIME_CONFIG_URL);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new Event(SMART_CARD_EXTENSION_CATALOG_CHANGED_EVENT));
      } catch {
        // 事件只是刷新提示，派发失败不影响已落库的启停结果
      }
    }
    return {
      success: true,
      extensionId: entry.extensionId,
      id: entry.id,
      enabled,
      changed: enabled !== entry.enabled,
    };
  } catch (error: any) {
    return {
      success: false,
      error: 'extension_toggle_failed',
      message: String(error?.message || error || 'toggle failed'),
      status: typeof error?.status === 'number' ? error.status : undefined,
    };
  }
}

/** 供 `getExtensionStatus` 的父侧动作使用：ST 四字段 + 本仓附加的 enabled。 */
export function toSmartCardExtensionInstallationInfo(entry: SmartCardExtensionCatalogEntry): Record<string, unknown> {
  return {
    // ST 的这四项来自 /api/extensions/version 的远端比对；本仓当前没有远端版本通道
    // （update/reinstall 属 R2，本批不实现）⇒ 版本号承载 current_commit_hash（本仓唯一
    // 可用的"已安装修订"标识），branch 与 remote_url 在来源未落库时为空串。
    current_branch_name: '',
    current_commit_hash: entry.version ? String(entry.version) : '',
    // 本平台没有"可更新到的新版本"这个概念：R1 只有安装副本，没有远端比对。
    // R2 一旦引入远端版本，这里必须重算，不能沿用 true。
    is_up_to_date: true,
    remote_url: entry.sourceUrl ? String(entry.sourceUrl) : '',
    // Palink 附加字段（不在 ST d.ts）：扩展当前是否启用。ST 的 installation info 不含
    // 启用状态（启用状态在 extension_settings.disabledExtensions），本仓借这一处一并给出，
    // 好让 "getExtensionStatus 问启用与否" 的调用方有真值可读。
    enabled: entry.enabled === true,
  };
}
