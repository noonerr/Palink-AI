/**
 * 插件管理器组件
 *
 * 提供 ST 插件的完整管理界面：
 * - 插件列表（名称、版本、作者、状态徽章、描述）
 * - 状态过滤标签页（all/enabled/disabled/error）
 * - 启用/禁用切换开关
 * - 卸载功能（确认对话框）
 * - 安装功能（URL 安装，调用后端 /api/extensions/install）
 * - 设置按钮（打开 PluginSettingsPanel）
 * - 错误状态显示和重新加载
 *
 * 后端 API：
 * - GET /api/plugins/runtime/config — 获取所有插件运行时配置
 * - POST /api/extensions/install — 安装 ST 扩展（代理到 ST sidecar）
 * - POST /api/extensions/delete — 卸载 ST 扩展
 * - GET /api/extensions/discover — 发现可安装扩展
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { pluginManager } from '@/lib/plugin-system/manager';
import { PluginStatus, type PluginInstance } from '@/lib/plugin-system/types';
import { PluginSettingsPanel } from '../st-plugin-ui-host/PluginSettingsPanel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface PluginManagerProps {
  open: boolean;
  onClose: () => void;
}

type FilterTab = 'all' | 'enabled' | 'disabled' | 'error';

export const PluginManager: React.FC<PluginManagerProps> = ({ open, onClose }) => {
  const [plugins, setPlugins] = useState<PluginInstance[]>([]);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [loading, setLoading] = useState(false);
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [importingLocal, setImportingLocal] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [settingsPlugin, setSettingsPlugin] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const localFileInputRef = useRef<HTMLInputElement>(null);

  // 加载插件列表
  const refreshPlugins = useCallback(async () => {
    setLoading(true);
    try {
      await pluginManager.discover();
      setPlugins([...pluginManager.getAllPlugins()]);
    } catch (e) {
      console.warn('[PluginManager] 加载插件列表失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次打开时加载
  useEffect(() => {
    if (open && !initializedRef.current) {
      initializedRef.current = true;
      refreshPlugins();
    }
  }, [open, refreshPlugins]);

  // 过滤后的插件列表
  const filteredPlugins = useMemo(() => {
    return plugins.filter(p => {
      switch (filter) {
        case 'enabled':
          return p.status === PluginStatus.ACTIVE || p.status === PluginStatus.LOADED;
        case 'disabled':
          return p.status === PluginStatus.DISABLED;
        case 'error':
          return p.status === PluginStatus.ERROR;
        default:
          return true;
      }
    });
  }, [plugins, filter]);

  // 统计信息
  const stats = useMemo(() => ({
    total: plugins.length,
    enabled: plugins.filter(p => p.status === PluginStatus.ACTIVE || p.status === PluginStatus.LOADED).length,
    disabled: plugins.filter(p => p.status === PluginStatus.DISABLED).length,
    error: plugins.filter(p => p.status === PluginStatus.ERROR).length,
  }), [plugins]);

  // 切换启用/禁用
  const handleToggle = useCallback(async (plugin: PluginInstance) => {
    const name = plugin.manifest.name;
    const isEnabled = plugin.status === PluginStatus.ACTIVE || plugin.status === PluginStatus.LOADED;
    try {
      if (isEnabled) {
        await pluginManager.disable(name);
        toast.success(`已禁用 ${plugin.manifest.displayName || name}`);
      } else {
        await pluginManager.enable(name);
        toast.success(`已启用 ${plugin.manifest.displayName || name}`);
      }
      setPlugins([...pluginManager.getAllPlugins()]);
    } catch (e) {
      console.error('[PluginManager] 切换插件状态失败:', e);
      toast.error(`操作失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // 重新加载（先卸载再启用）
  const handleReload = useCallback(async (plugin: PluginInstance) => {
    const name = plugin.manifest.name;
    try {
      await pluginManager.unload(name);
      await pluginManager.enable(name);
      toast.success(`已重新加载 ${plugin.manifest.displayName || name}`);
      setPlugins([...pluginManager.getAllPlugins()]);
    } catch (e) {
      console.error('[PluginManager] 重新加载失败:', e);
      toast.error(`重新加载失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // 卸载插件
  const handleUninstall = useCallback(async (name: string) => {
    setConfirmUninstall(null);
    try {
      // 先在前端卸载
      await pluginManager.unload(name);
      // 调用后端删除（/api/extensions/delete）
      try {
        await api.post('/api/extensions/delete', { name });
      } catch (e) {
        console.warn('[PluginManager] 后端卸载请求失败（可能后端不支持）:', e);
      }
      toast.success(`已卸载 ${name}`);
      setPlugins([...pluginManager.getAllPlugins()]);
    } catch (e) {
      console.error('[PluginManager] 卸载失败:', e);
      toast.error(`卸载失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // 安装插件
  const handleInstall = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) {
      toast.warning('请输入扩展 URL');
      return;
    }
    setInstalling(true);
    try {
      await api.post('/api/extensions/install', { url });
      toast.success(`扩展安装请求已提交: ${url}`);
      setInstallUrl('');
      // 重新加载插件列表
      await refreshPlugins();
    } catch (e) {
      console.error('[PluginManager] 安装失败:', e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`安装失败: ${msg}`);
    } finally {
      setInstalling(false);
    }
  }, [installUrl, refreshPlugins]);

  // 导入本地文件（支持 ST预设/正则/酒馆助手/角色卡/ZIP 扩展包）
  const handleImportLocalFile = useCallback(async (file: File) => {
    setImportingLocal(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.raw('/api/plugins/import', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message || '导入成功');
      } else {
        toast.error(data.detail || '导入失败');
      }
      // 重新加载插件列表
      await refreshPlugins();
    } catch (e) {
      console.error('[PluginManager] 本地文件导入失败:', e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`导入失败: ${msg}`);
    } finally {
      setImportingLocal(false);
      if (localFileInputRef.current) localFileInputRef.current.value = '';
    }
  }, [refreshPlugins]);

  // 打开设置面板
  const handleOpenSettings = useCallback((name: string) => {
    setSettingsPlugin(name);
  }, []);

  // 扫描 ST 挂载点，收集插件运行时注入的设置入口按钮（如酒馆助手注入的
  // #galgame-ui-plugin-btn / #bubble-avatar-wand-btn），供「插件内设置」二级菜单使用。
  // 对话框打开时实时扫描（插件按钮在进入聊天页后才由运行时注入）。
  const [injectedSettings, setInjectedSettings] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    const mountPointIds = [
      'extensionsMenu',
      'extensions_menu',
      'extensions_settings',
      'extensions_settings2',
      'movingDivs',
      'top-settings-holder',
    ];
    const entries: { id: string; label: string }[] = [];
    for (const mid of mountPointIds) {
      const root = document.getElementById(mid);
      if (!root) continue;
      for (const child of Array.from(root.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const isEmptyContainer =
          child.classList.contains('extension_container') &&
          child.children.length === 0 &&
          !(child.textContent || '').trim();
        if (isEmptyContainer) continue;
        const label = (child.textContent || '').trim() || child.id;
        if (label) {
          entries.push({ id: child.id || `${mid}-${entries.length}`, label });
        }
      }
    }
    setInjectedSettings(entries);
  }, [open]);

  // 点击插件内设置入口，转发到原 DOM 元素（clone 不保留插件绑定事件）
  const handleOpenInjectedSetting = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) el.click();
  }, []);

  if (!open) return null;

  return (
    <>
      {/* 全屏页面：覆盖整个视口，无弹窗遮罩/卡片 */}
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-accent transition-colors"
              title="返回聊天"
            >
              ← 返回
            </button>
            <div className="h-5 w-px bg-border" />
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">插件管理</h2>
              <span className="text-xs text-muted-foreground">
                共 {stats.total} · 启用 {stats.enabled} · 禁用 {stats.disabled} · 错误 {stats.error}
              </span>
            </div>
          </div>
          <button
            onClick={refreshPlugins}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground hover:bg-accent disabled:opacity-50"
            title="刷新插件列表"
          >
            {loading ? '加载中...' : '↻ 刷新'}
          </button>
        </div>

        {/* 安装区域 */}
        <div className="px-6 py-4 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={installUrl}
              onChange={e => setInstallUrl(e.target.value)}
              placeholder="输入 ST 扩展 URL（如 https://github.com/...）"
              disabled={installing}
              className="flex-1 text-sm px-3 py-2 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary"
              onKeyDown={e => {
                if (e.key === 'Enter' && !installing) {
                  e.preventDefault();
                  handleInstall();
                }
              }}
            />
            <button
              onClick={handleInstall}
              disabled={installing || !installUrl.trim()}
              className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex-shrink-0"
            >
              {installing ? '安装中...' : '安装'}
            </button>
            <button
              onClick={() => localFileInputRef.current?.click()}
              disabled={importingLocal}
              className="text-sm px-4 py-2 rounded-md bg-secondary text-secondary-foreground hover:bg-accent disabled:opacity-50 flex-shrink-0"
              title="导入本地文件（ST预设/正则/酒馆助手/角色卡/ZIP扩展包）"
            >
              {importingLocal ? '导入中...' : '导入本地文件'}
            </button>
            <input
              ref={localFileInputRef}
              type="file"
              accept=".json,.zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImportLocalFile(file);
              }}
            />
          </div>
          <div className="text-xs text-muted-foreground mt-1.5">
            安装来源：SillyTavern Extension 仓库 URL，或直接导入本地文件（JSON/ZIP）。安装后默认禁用，需手动启用。
          </div>
        </div>

        {/* 过滤标签 */}
        <div className="px-6 py-2.5 border-b border-border flex items-center gap-1.5">
          {([
            { key: 'all', label: '全部', count: stats.total },
            { key: 'enabled', label: '已启用', count: stats.enabled },
            { key: 'disabled', label: '已禁用', count: stats.disabled },
            { key: 'error', label: '错误', count: stats.error },
          ] as Array<{ key: FilterTab; label: string; count: number }>).map(tab => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`text-xs px-3.5 py-1.5 rounded-md ${
                filter === tab.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        {/* 插件列表 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {filteredPlugins.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-8">
              {loading ? '加载中...' : '暂无插件。可通过上方 URL 安装 ST 扩展，或导入本地文件。'}
            </div>
          )}
        {filteredPlugins.map(plugin => {
          const isEnabled = plugin.status === PluginStatus.ACTIVE || plugin.status === PluginStatus.LOADED;
          const isError = plugin.status === PluginStatus.ERROR;
          const name = plugin.manifest.name;
          return (
            <div
              key={name}
              className={`border rounded-lg p-4 transition-colors ${
                isError ? 'border-destructive/50 bg-destructive/5' :
                isEnabled ? 'border-primary/30 bg-primary/5' :
                'border-border bg-background'
              }`}
            >
              <div className="flex items-start gap-3">
                {/* 图标 */}
                <div className={`flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-lg ${
                  isEnabled ? 'bg-primary/15' : 'bg-muted'
                }`}>
                  🧩
                </div>

                {/* 信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {plugin.manifest.displayName || name}
                    </span>
                    {plugin.manifest.version && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        v{plugin.manifest.version}
                      </span>
                    )}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      isEnabled ? 'bg-primary/15 text-primary' :
                      isError ? 'bg-destructive/15 text-destructive' :
                      plugin.status === PluginStatus.DISABLED ? 'bg-muted text-muted-foreground' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {plugin.status}
                    </span>
                    {plugin.manifest.author && (
                      <span className="text-[10px] text-muted-foreground">
                        by {plugin.manifest.author}
                      </span>
                    )}
                  </div>
                  {plugin.manifest.description && (
                    <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {plugin.manifest.description}
                    </div>
                  )}
                  {isError && plugin.error && (
                    <div className="text-xs text-destructive mt-1 font-mono">
                      {plugin.error}
                    </div>
                  )}
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* 插件内设置（二级菜单） */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="text-xs px-2 py-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                        title="插件内设置"
                      >
                        ⚙
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuLabel className="text-xs text-muted-foreground">
                        插件内设置
                      </DropdownMenuLabel>
                      {injectedSettings.length > 0 ? (
                        injectedSettings.map((entry) => (
                          <DropdownMenuItem
                            key={entry.id}
                            onClick={() => handleOpenInjectedSetting(entry.id)}
                          >
                            {entry.label}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem
                          onClick={() => handleOpenSettings(name)}
                          className="text-xs text-muted-foreground"
                        >
                          未检测到插件内设置入口
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => handleOpenSettings(name)}>
                        打开设置面板
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* 重新加载（仅错误状态显示） */}
                  {isError && (
                    <button
                      onClick={() => handleReload(plugin)}
                      className="text-xs px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:bg-accent"
                      title="重新加载"
                    >
                      ↻
                    </button>
                  )}

                  {/* 启用/禁用开关 */}
                  <button
                    onClick={() => handleToggle(plugin)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      isEnabled ? 'bg-primary' : 'bg-muted'
                    }`}
                    title={isEnabled ? '点击禁用' : '点击启用'}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${
                        isEnabled ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  {/* 卸载按钮 */}
                  <button
                    onClick={() => setConfirmUninstall(name)}
                    className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                    title="卸载"
                  >
                    🗑
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>

      {confirmUninstall && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50"
          onClick={() => setConfirmUninstall(null)}
        >
          <div
            className="bg-background border border-border rounded-lg shadow-lg p-5 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold mb-2">确认卸载</h3>
            <p className="text-sm text-muted-foreground mb-4">
              确定要卸载插件 <span className="font-medium text-foreground">{confirmUninstall}</span> 吗？
              此操作将删除插件文件，不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmUninstall(null)}
                className="text-sm px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                onClick={() => handleUninstall(confirmUninstall)}
                className="text-sm px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                卸载
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 插件设置面板 */}
      {settingsPlugin && (
        <PluginSettingsPanel
          pluginName={settingsPlugin}
          onClose={() => setSettingsPlugin(null)}
        />
      )}
    </>
  );
};

export default PluginManager;
