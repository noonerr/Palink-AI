import React, { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, ChevronDown, Check, Settings2, Save, Globe } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup } from './settings-ui';
import { api, invalidateCache, isAbortError } from '@/services/api';
import { CompatStubStatsCard } from './CompatStubStatsCard';
import {
  DEFAULT_PLUGIN_FETCH_WHITELIST,
  normalizeWhitelistHostInput,
  readUserWhitelist,
  writeUserWhitelist,
} from '@/lib/plugin-system/plugin-fetch-whitelist';

interface Plugin {
  id: string;
  name: string;
  plugin_type: string;
  description: string | null;
  version: string | null;
  author: string | null;
  enabled: boolean;
  source_type: string | null;
  config?: Record<string, unknown> | null;
  scripts_count: number;
  enabled_scripts: number;
  created_at: string | null;
}

interface PluginScript {
  id: string;
  script_name: string;
  script_type: string;
  enabled: boolean;
  content_length: number;
  find_regex: string | null;
  replace_string_length: number;
  placement: string | null;
  markdown_only: boolean;
  prompt_only: boolean;
  min_depth: number | null;
  max_depth: number | null;
  order_no: number;
}

const TYPE_LABELS: Record<string, string> = {
  regex_scripts: '正则脚本',
  tavern_helper: '酒馆助手',
  preset: '推进预设',
  chatsheets: '表格模板',
  character_card: '角色卡',
  regex_script_single: '正则脚本',
  sillytavern_extension: '第三方扩展',
};

const TYPE_COLORS: Record<string, string> = {
  regex_scripts: 'bg-blue-500/15 text-blue-500',
  tavern_helper: 'bg-purple-500/15 text-purple-500',
  preset: 'bg-amber-500/15 text-amber-500',
  chatsheets: 'bg-green-500/15 text-green-500',
  character_card: 'bg-pink-500/15 text-pink-500',
  regex_script_single: 'bg-blue-500/15 text-blue-500',
  sillytavern_extension: 'bg-cyan-500/15 text-cyan-500',
};

export function AdminPluginsTab() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [scripts, setScripts] = useState<PluginScript[]>([]);
  const [loadingScripts, setLoadingScripts] = useState(false);
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
  const [settingsText, setSettingsText] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  // [批次WU 2026-10-21] 插件网络白名单（localStorage `palink_plugin_fetch_whitelist`）。
  // 用户项默认空；每次变更立即落盘，判定侧每次 fetch 现读 ⇒ 对下一次请求即生效。
  const [userHosts, setUserHosts] = useState<string[]>(() => readUserWhitelist());
  const [hostInput, setHostInput] = useState('');
  const [hostError, setHostError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pluginsAbortRef = useRef<AbortController | null>(null);
  const scriptsAbortRef = useRef<AbortController | null>(null);
  const scriptsRequestIdRef = useRef(0);

  const fetchPlugins = useCallback(async () => {
    pluginsAbortRef.current?.abort();
    const controller = new AbortController();
    pluginsAbortRef.current = controller;
    try {
      const data = await api.get('/api/plugins', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setPlugins(data);
    } catch (e) {
      if (!isAbortError(e)) {
        console.error('Failed to fetch plugins:', e);
      }
    } finally {
      if (pluginsAbortRef.current === controller) {
        pluginsAbortRef.current = null;
      }
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  useEffect(() => {
    return () => {
      pluginsAbortRef.current?.abort();
      scriptsAbortRef.current?.abort();
    };
  }, []);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
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
        invalidateCache('/api/plugins/runtime/config');
        fetchPlugins();
      } else {
        toast.error(data.detail || '导入失败');
      }
    } catch (err: any) {
      toast.error('导入失败: ' + (err.message || '未知错误'));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleToggle = async (pluginId: string) => {
    try {
      await api.put(`/api/plugins/${pluginId}/toggle`);
      invalidateCache('/api/plugins/runtime/config');
      fetchPlugins();
      toast.success('插件状态已更新');
    } catch (e) {
      toast.error('操作失败');
      console.error('Failed to toggle plugin:', e);
    }
  };

  const handleToggleScript = async (pluginId: string, scriptId: string) => {
    try {
      await api.put(`/api/plugins/${pluginId}/scripts/${scriptId}/toggle`);
      invalidateCache('/api/plugins/runtime/config');
      if (expandedPlugin === pluginId) {
        const data = await api.get(`/api/plugins/${pluginId}`);
        setScripts(data.scripts || []);
      }
      fetchPlugins();
      toast.success('脚本状态已更新');
    } catch (e) {
      toast.error('操作失败');
      console.error('Failed to toggle script:', e);
    }
  };

  const handleDelete = async (pluginId: string) => {
    if (!confirm('确定要删除此插件吗？')) return;
    try {
      await api.delete(`/api/plugins/${pluginId}`);
      invalidateCache('/api/plugins/runtime/config');
      if (expandedPlugin === pluginId) setExpandedPlugin(null);
      if (settingsPluginId === pluginId) {
        setSettingsPluginId(null);
        setSettingsText('');
      }
      fetchPlugins();
      toast.success('插件已删除');
    } catch (e) {
      toast.error('删除失败');
      console.error('Failed to delete plugin:', e);
    }
  };

  const handleOpenSettings = (plugin: Plugin) => {
    if (settingsPluginId === plugin.id) {
      setSettingsPluginId(null);
      setSettingsText('');
      return;
    }
    const config = plugin.config && typeof plugin.config === 'object' ? plugin.config : {};
    const defaultConfig = {
      scope: 'global',
      global_runtime: true,
      settings: {},
      extension_settings: {},
      runtime: { enabled: true, execute_scripts: true },
      ...config,
    };
    setSettingsPluginId(plugin.id);
    setSettingsText(JSON.stringify(defaultConfig, null, 2));
  };

  const handleSaveSettings = async (pluginId: string) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(settingsText || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('设置必须是 JSON 对象');
      }
    } catch (error: any) {
      toast.error(error?.message || 'JSON 格式不正确');
      return;
    }

    setSavingSettings(true);
    try {
      await api.patch(`/api/plugins/${pluginId}/config`, { config: parsed });
      invalidateCache('/api/plugins');
      invalidateCache('/api/plugins/runtime/config');
      toast.success('插件运行时设置已保存');
      fetchPlugins();
    } catch (error) {
      toast.error('保存插件设置失败');
      console.error('Failed to save plugin config:', error);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleExpand = async (pluginId: string) => {
    if (expandedPlugin === pluginId) {
      scriptsAbortRef.current?.abort();
      setExpandedPlugin(null);
      setScripts([]);
      return;
    }
    setExpandedPlugin(pluginId);
    setScripts([]);
    const requestId = scriptsRequestIdRef.current + 1;
    scriptsRequestIdRef.current = requestId;
    scriptsAbortRef.current?.abort();
    const controller = new AbortController();
    scriptsAbortRef.current = controller;
    setLoadingScripts(true);
    try {
      const data = await api.get(`/api/plugins/${pluginId}`, { signal: controller.signal });
      if (controller.signal.aborted || scriptsRequestIdRef.current !== requestId) return;
      setScripts(data.scripts || []);
    } catch (e) {
      if (!isAbortError(e)) {
        console.error('Failed to fetch scripts:', e);
      }
    } finally {
      if (scriptsAbortRef.current === controller) {
        scriptsAbortRef.current = null;
      }
      if (scriptsRequestIdRef.current === requestId) {
        setLoadingScripts(false);
      }
    }
  };

  const persistUserHosts = (next: string[], message: string) => {
    const saved = writeUserWhitelist(next);
    setUserHosts(saved);
    setHostError('');
    toast.success(message);
  };

  const handleAddHost = () => {
    const host = normalizeWhitelistHostInput(hostInput);
    if (!host) {
      setHostError('请输入合法主机名，例如 localhost 或 127.0.0.1');
      return;
    }
    setHostInput('');
    // 固定放行项不落成用户项：否则用户会看到一个"删了也照样放行"的假条目
    if (DEFAULT_PLUGIN_FETCH_WHITELIST.includes(host)) {
      toast.success('该主机名本来就在固定放行名单里');
      return;
    }
    if (userHosts.includes(host)) {
      toast.success('该主机名已在白名单中');
      return;
    }
    persistUserHosts([...userHosts, host], '已添加，对下一次插件请求立即生效');
  };

  const handleRemoveHost = (host: string) => {
    persistUserHosts(userHosts.filter((item) => item !== host), '已删除，对下一次插件请求立即生效');
  };

  // 本机 AI 服务（Ollama / SD WebUI / ComfyUI 等）都落在 localhost / 127.0.0.1
  const handlePresetLocalAi = () => {
    // 去重：已加过的不重复出现（两个预置项可能已在表里，点一次就补齐缺的那条）。
    const missing = ['localhost', '127.0.0.1'].filter((host) => !userHosts.includes(host));
    if (!missing.length) {
      toast.success('本机 AI 服务主机已在白名单中');
      return;
    }
    persistUserHosts(
      [...userHosts, ...missing],
      '已添加本机 AI 服务主机，对下一次插件请求立即生效',
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6 animate-fade-in">
      <div className="flex items-center justify-end mb-4">
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.zip"
            onChange={handleImport}
            className="hidden"
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={importing} className="h-8 md:h-9 rounded-md px-3 text-xs">
            <Plus size={14} className="mr-1.5" />
            {importing ? '导入中...' : '导入插件'}
          </Button>
        </div>
      </div>

      <SettingsGroup label="导入说明">
        <div className="px-4 py-3">
          <p className="text-sm font-medium mb-2">支持导入的文件类型</p>
          <ul className="text-sm text-muted-foreground space-y-1 ml-4 list-disc">
            <li>正则脚本 JSON（数组格式或角色卡内嵌）</li>
            <li>酒馆助手脚本（tavern_helper）</li>
            <li>推进预设 JSON（含 prompts/promptGroup）</li>
            <li>chatSheets 表格模板（普通版/SQL版）</li>
            <li>角色卡 JSON（自动提取其中的正则脚本和酒馆助手脚本）</li>
            <li>SillyTavern 第三方扩展 manifest.json 或扩展 zip 包</li>
          </ul>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 leading-relaxed">
            ⚠ 安全提示：酒馆助手 / 第三方扩展等经典脚本插件在主页面以高权限运行
            （等同网页自身代码，可访问登录凭据与全部 DOM；fetch 跨源受域名白名单限制）。
            请仅导入可信来源，详见 docs/PLUGIN_SECURITY_MODEL.md。
          </p>
        </div>
      </SettingsGroup>

      {/*
        [批次WU 2026-10-21] 插件网络白名单。
        判据在 sandbox.ts 的 isUrlAllowedByPluginWhitelist（同源恒放行，跨源只比 hostname；
        [2026-10-24] 起 localhost / 127.0.0.1 / [::1] 默认放行），
        存储契约是 localStorage `palink_plugin_fetch_whitelist` 的**逗号分隔裸主机名**。
        这一栏存在的意义：机制早就通，但只有手工敲 localStorage 才能改 —— 对普通用户等于没有。
      */}
      <SettingsGroup label="插件网络白名单">
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            插件在沙箱里请求**外部地址**时，只有命中下面名单的主机名才会放行（本站同源请求不受影响）。
            只填主机名，不带协议和路径；端口和路径会被忽略，判定只看主机名。
            改动即时生效，无需重启。
          </p>

          <div>
            <p className="text-xs font-medium mb-1.5 text-muted-foreground">固定放行（默认 CDN，不可删除）</p>
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_PLUGIN_FETCH_WHITELIST.map((host) => (
                <span
                  key={host}
                  className="px-2 py-0.5 rounded-full text-[11px] bg-muted text-muted-foreground font-mono"
                >
                  {host}
                </span>
              ))}
            </div>
          </div>

          <p data-testid="plugin-whitelist-loopback-note" className="text-xs text-muted-foreground leading-relaxed">
            本机(localhost)地址默认放行：localhost / 127.0.0.1 / [::1] 的任意端口无需添加即可被插件访问；
            私网（如 192.168.x.x）与公网地址仍需加入下方名单才会放行。
          </p>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              data-testid="plugin-whitelist-input"
              value={hostInput}
              onChange={(e) => {
                setHostInput(e.target.value);
                if (hostError) setHostError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddHost();
                }
              }}
              placeholder="例如 localhost 或 127.0.0.1"
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <Button
              data-testid="plugin-whitelist-add"
              onClick={handleAddHost}
              className="h-8 shrink-0 rounded-md px-3 text-xs gap-1.5"
            >
              <Plus size={14} />
              添加
            </Button>
            <Button
              variant="outline"
              data-testid="plugin-whitelist-preset-local"
              onClick={handlePresetLocalAi}
              className="h-8 shrink-0 rounded-md px-3 text-xs gap-1.5"
              title="一次加上 localhost 与 127.0.0.1（Ollama / SD WebUI / ComfyUI 等本机服务）"
            >
              <Globe size={14} />
              加本机 AI 服务
            </Button>
          </div>

          {hostError && (
            <p data-testid="plugin-whitelist-error" className="text-xs text-red-500">{hostError}</p>
          )}

          {userHosts.length === 0 ? (
            <p data-testid="plugin-whitelist-empty" className="text-xs text-muted-foreground">
              当前没有自定义放行主机 —— 插件只能请求本站、上面那五个 CDN，以及默认放行的本机(localhost)地址。
            </p>
          ) : (
            <div data-testid="plugin-whitelist-user" className="flex flex-wrap gap-1.5">
              {userHosts.map((host) => (
                <span
                  key={host}
                  data-testid={`plugin-whitelist-chip-${host}`}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-mono"
                >
                  {host}
                  <button
                    type="button"
                    data-testid={`plugin-whitelist-remove-${host}`}
                    onClick={() => handleRemoveHost(host)}
                    className="opacity-70 hover:opacity-100"
                    aria-label={`从白名单移除 ${host}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </SettingsGroup>

      <CompatStubStatsCard />

      {plugins.length === 0 ? (
        <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
            <Plus size={32} className="text-muted-foreground" />
          </div>
          <h4 className="font-semibold mb-2">暂无插件</h4>
          <p className="text-sm text-muted-foreground">
            请点击上方的"导入插件"按钮上传插件文件
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {plugins.map((plugin) => {
            const isExpanded = expandedPlugin === plugin.id;
            return (
              <div
                key={plugin.id}
                className={cn(
                  "overflow-hidden rounded-2xl border border-border/50 bg-card",
                  !plugin.enabled && "opacity-60"
                )}
              >
                <div
                  className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4 cursor-pointer hover:bg-muted/20 transition-colors"
                  onClick={() => handleExpand(plugin.id)}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div
                      className="flex flex-col items-center gap-2 pt-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Switch
                        checked={plugin.enabled}
                        onCheckedChange={() => {
                          handleToggle(plugin.id);
                        }}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <h4 className="font-semibold text-[15px] truncate">{plugin.name}</h4>
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0",
                            TYPE_COLORS[plugin.plugin_type] || "bg-muted text-muted-foreground"
                          )}
                        >
                          {TYPE_LABELS[plugin.plugin_type] || plugin.plugin_type}
                        </span>
                        {plugin.version && (
                          <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full shrink-0">
                            v{plugin.version}
                          </span>
                        )}
                      </div>
                      {plugin.description && (
                        <p className="text-xs text-muted-foreground mb-2">
                          {plugin.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                          {plugin.enabled_scripts}/{plugin.scripts_count} 脚本
                        </span>
                        {plugin.source_type && (
                          <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">
                            {plugin.source_type}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-8 w-8 hover:bg-primary/10",
                        settingsPluginId === plugin.id ? "text-primary bg-primary/10" : "text-muted-foreground"
                      )}
                      onClick={(e) => { e.stopPropagation(); handleOpenSettings(plugin); }}
                      title="运行时设置"
                    >
                      <Settings2 size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      onClick={(e) => { e.stopPropagation(); handleDelete(plugin.id); }}
                    >
                      <Trash2 size={14} />
                    </Button>
                    <ChevronDown
                      size={18}
                      className={cn(
                        "text-muted-foreground transition-transform",
                        isExpanded ? "rotate-180" : ""
                      )}
                    />
                  </div>
                </div>

                {settingsPluginId === plugin.id && (
                  <div className="border-t border-border/40 bg-secondary/20 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">SillyTavern 运行时设置</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          这里的 JSON 会注入智能角色卡 iframe 的 extension_settings 和插件运行时上下文。
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleSaveSettings(plugin.id)}
                        disabled={savingSettings}
                      >
                        <Save size={14} className="mr-2" />
                        {savingSettings ? '保存中...' : '保存设置'}
                      </Button>
                    </div>
                    <textarea
                      value={settingsText}
                      onChange={(event) => setSettingsText(event.target.value)}
                      spellCheck={false}
                      className="min-h-[220px] w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder='{"settings":{},"extension_settings":{},"runtime":{"enabled":true,"execute_scripts":true}}'
                    />
                    <p className="text-xs text-muted-foreground">
                      常用字段：namespace、settings、extension_settings、runtime.enabled、runtime.execute_scripts、manifest、capabilities。SillyTavern 扩展会在隔离 iframe 中运行脚本，以优先兼容依赖第三方插件的角色卡。
                    </p>
                  </div>
                )}

                {isExpanded && (
                  <div className="border-t border-border/40 bg-secondary/20 p-4">
                    {loadingScripts ? (
                      <div className="flex items-center justify-center py-4">
                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : scripts.length === 0 ? (
                      <div className="text-center py-4 text-sm text-muted-foreground">
                        无脚本
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground mb-2">脚本列表</p>
                        {scripts.map((script) => (
                          <div
                            key={script.id}
                            className="flex items-center justify-between p-3 rounded-lg bg-background/50"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <Switch
                                checked={script.enabled}
                                onCheckedChange={() => handleToggleScript(plugin.id, script.id)}
                              />
                              <div className="min-w-0">
                                <p className="text-sm truncate">{script.script_name}</p>
                                <div className="flex items-center gap-2 flex-wrap mt-1">
                                  <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                                    {script.script_type}
                                  </span>
                                  {script.find_regex && (
                                    <span className="text-[10px] bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded">
                                      正则
                                    </span>
                                  )}
                                  {script.content_length > 0 && (
                                    <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                                      {(script.content_length / 1024).toFixed(1)}KB
                                    </span>
                                  )}
                                  {script.replace_string_length > 0 && (
                                    <span className="text-[10px] bg-green-500/10 text-green-500 px-1.5 py-0.5 rounded">
                                      替换 {(script.replace_string_length / 1024).toFixed(1)}KB
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            {script.enabled && (
                              <Check size={16} className="text-primary shrink-0" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
