import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  Puzzle,
  Sliders,
  Save,
  Plus,
  Trash2,
  UploadCloud,
  Download,
  BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, invalidateCache } from '@/services/api';
import {
  WORLD_INFO_GLOBAL_DEFAULTS,
  resolveWorldInfoGlobalSettings,
  sanitizeWorldInfoGlobalSettings,
  buildWorldInfoGlobalSavePayload,
  type WorldInfoGlobalSettings,
} from '@/lib/worldbook-global-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { SettingsGroup, SettingsRow, Segmented } from './settings-ui';
import { Switch } from '@/components/ui/switch';
import { PresetManager } from '@/components/ui/custom/PresetManager';
import { useRoleplayTheme, RoleplayThemeProvider } from '@/contexts/RoleplayThemeContext';

type RoleplayEngineSubTab = 'theme' | 'regex' | 'preset' | 'sillytavern';

function RoleplayThemeSettingsPanel() {
  const { themes, currentThemeId, setCurrentThemeId, createTheme, deleteTheme, exportTheme, importTheme, updateTheme } = useRoleplayTheme();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <div className="space-y-4">
      <GlassCard className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-base md:text-lg">主题预设</h4>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <UploadCloud size={16} className="mr-2" />
              导入
            </Button>
            <Button variant="outline" size="sm" onClick={() => {
              const data = exportTheme(currentThemeId);
              const blob = new Blob([data], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `theme-${currentThemeId}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}>
              <Download size={16} className="mr-2" />
              导出
            </Button>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          {themes.map((theme) => (
            <div
              key={theme.id}
              className={cn(
                'flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors',
                currentThemeId === theme.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border/50 hover:border-border'
              )}
              onClick={() => setCurrentThemeId(theme.id)}
            >
              <span className="text-sm font-medium">{theme.name}</span>
              {themes.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteTheme(theme.id);
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => createTheme({ name: '新主题' })}
          className="w-full"
        >
          <Plus size={16} className="mr-2" />
          新建主题
        </Button>

        {importOpen && (
          <div className="mt-4 space-y-2">
            <textarea
              className="w-full h-24 p-2 text-sm rounded-md border border-border bg-background resize-none"
              placeholder="粘贴主题 JSON..."
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setImportOpen(false); setImportText(''); }}
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const result = importTheme(importText);
                  if (result) {
                    toast.success('主题导入成功');
                    setImportOpen(false);
                    setImportText('');
                  } else {
                    toast.error('主题导入失败');
                  }
                }}
              >
                导入
              </Button>
            </div>
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-4 md:p-6">
        <h4 className="font-semibold text-base md:text-lg mb-4">聊天样式</h4>
        <div className="flex gap-2">
          {(['flat', 'bubbles', 'document'] as const).map((style) => (
            <Button
              key={style}
              variant={themes.find(t => t.id === currentThemeId)?.chatStyle === style ? 'default' : 'outline'}
              size="sm"
              onClick={() => updateTheme(currentThemeId, { chatStyle: style })}
              className="flex-1"
            >
              {style === 'flat' && '扁平'}
              {style === 'bubbles' && '气泡'}
              {style === 'document' && '文档'}
            </Button>
          ))}
        </div>
      </GlassCard>
    </div>
  );
}

function SillyTavernSettingsPanel({ onOpenPlugins }: { onOpenPlugins: () => void }) {
  const { currentTheme, currentThemeId, updateTheme } = useRoleplayTheme();

  // 世界书全局设置（批次 C 前端半）：存于 silly_tavern_settings.world_info_settings
  const [wiSettings, setWiSettings] = useState<WorldInfoGlobalSettings>({ ...WORLD_INFO_GLOBAL_DEFAULTS });
  const [wiLoaded, setWiLoaded] = useState(false);
  const [wiSaving, setWiSaving] = useState(false);

  useEffect(() => {
    const loadWorldInfo = async () => {
      try {
        // 读通道：POST /api/settings/get 返回的 settings 字段是 JSON 字符串
        const res = await api.post<{ settings?: string }>('/api/settings/get', {});
        const parsed = res?.settings ? JSON.parse(res.settings) : {};
        const wis = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed.world_info_settings
          : undefined;
        setWiSettings(resolveWorldInfoGlobalSettings(wis));
      } catch (e) {
        console.error('Failed to load world info settings:', e);
        setWiSettings({ ...WORLD_INFO_GLOBAL_DEFAULTS });
      } finally {
        setWiLoaded(true);
      }
    };
    loadWorldInfo();
  }, []);

  const handleSaveWorldInfo = async () => {
    if (wiSaving) return;
    setWiSaving(true);
    try {
      // 保存前钳制 UI 输入范围，并把钳制结果回写表单
      const next = sanitizeWorldInfoGlobalSettings(wiSettings);
      setWiSettings(next);
      // 写通道：/api/settings/save 对除 extension_settings 外的字段是整 blob 覆盖，
      // 必须先读全量 settings 再仅替换 world_info_settings（不覆盖其他数据）
      const res = await api.post<{ settings?: string }>('/api/settings/get', {});
      const full = res?.settings ? JSON.parse(res.settings) : null;
      const payload = buildWorldInfoGlobalSavePayload(full, next);
      await api.post('/api/settings/save', payload);
      toast.success('世界书全局设置已保存');
    } catch (e) {
      console.error('Failed to save world info settings:', e);
      toast.error('保存世界书全局设置失败');
    } finally {
      setWiSaving(false);
    }
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* 二级菜单：与设置主菜单同款分组列表（图标座 + 标题/说明 + 右侧动作；行内 min-w-0/truncate 防窄屏截断） */}
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/40">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <Sliders size={15} className="text-muted-foreground" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-medium">正则引擎</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">已就绪</span>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <Puzzle size={15} className="text-muted-foreground" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-medium">插件系统</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenPlugins}
            className="shrink-0 h-8 md:h-9 rounded-md px-3"
          >
            管理
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/40">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <BookOpen size={15} className="text-muted-foreground" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-medium">世界书全局设置</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!wiLoaded || wiSaving}
            onClick={() => void handleSaveWorldInfo()}
            className="shrink-0 h-8 md:h-9 rounded-md px-3"
          >
            <Save size={14} className="mr-1.5" />
            {wiSaving ? '保存中…' : '保存'}
          </Button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">扫描深度</p>
              <p className="text-xs text-muted-foreground">关键词扫描的聊天历史范围（ST Scan Depth，条目未自定义深度时生效，0-1000，默认 2）</p>
            </div>
            <Input
              type="number"
              min={0}
              max={1000}
              className="w-24 shrink-0"
              disabled={!wiLoaded}
              value={wiSettings.world_info_depth}
              onChange={(e) => {
                const num = e.target.value === '' ? 0 : Number(e.target.value);
                if (!Number.isNaN(num)) {
                  setWiSettings((s) => ({ ...s, world_info_depth: num }));
                }
              }}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">递归扫描</p>
              <p className="text-xs text-muted-foreground">新激活条目的内容再次参与关键词扫描（ST Recursive Scan，ST 1.18 默认关）</p>
            </div>
            <Switch
              className="shrink-0"
              disabled={!wiLoaded}
              checked={wiSettings.world_info_recursive}
              onCheckedChange={(v) => setWiSettings((s) => ({ ...s, world_info_recursive: v }))}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">预算百分比</p>
              <p className="text-xs text-muted-foreground">世界书注入 token 预算占上下文长度的百分比（ST Context % Budget，0-100，默认 25）</p>
            </div>
            <Input
              type="number"
              min={0}
              max={100}
              className="w-24 shrink-0"
              disabled={!wiLoaded}
              value={wiSettings.world_info_budget}
              onChange={(e) => {
                const num = e.target.value === '' ? 0 : Number(e.target.value);
                if (!Number.isNaN(num)) {
                  setWiSettings((s) => ({ ...s, world_info_budget: num }));
                }
              }}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">预算上限</p>
              <p className="text-xs text-muted-foreground">世界书注入 token 绝对上限（ST Budget Cap，0 = 不启用）</p>
            </div>
            <Input
              type="number"
              min={0}
              className="w-24 shrink-0"
              disabled={!wiLoaded}
              value={wiSettings.world_info_budget_cap}
              onChange={(e) => {
                const num = e.target.value === '' ? 0 : Number(e.target.value);
                if (!Number.isNaN(num)) {
                  setWiSettings((s) => ({ ...s, world_info_budget_cap: num }));
                }
              }}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">扫描含说话人名</p>
              <p className="text-xs text-muted-foreground">关键词扫描范围包含消息的说话人名前缀（ST Include Names，默认开）</p>
            </div>
            <Switch
              className="shrink-0"
              disabled={!wiLoaded}
              checked={wiSettings.world_info_include_names}
              onCheckedChange={(v) => setWiSettings((s) => ({ ...s, world_info_include_names: v }))}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">区分大小写</p>
              <p className="text-xs text-muted-foreground">关键词匹配时区分大小写（ST Case Sensitive，默认关）</p>
            </div>
            <Switch
              className="shrink-0"
              disabled={!wiLoaded}
              checked={wiSettings.world_info_case_sensitive}
              onCheckedChange={(v) => setWiSettings((s) => ({ ...s, world_info_case_sensitive: v }))}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">全词匹配</p>
              <p className="text-xs text-muted-foreground">仅匹配完整单词而非内容片段（ST Match Whole Words，默认关）</p>
            </div>
            <Switch
              className="shrink-0"
              disabled={!wiLoaded}
              checked={wiSettings.world_info_match_whole_words}
              onCheckedChange={(v) => setWiSettings((s) => ({ ...s, world_info_match_whole_words: v }))}
            />
          </div>

          {/* ── 语义召回（Palink 自研，默认关）── */}
          <div className="flex items-start justify-between gap-4 border-t border-border/30 pt-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">世界书语义召回</p>
              <p className="text-xs text-muted-foreground">
                打开后，标了「按意思找」的设定会按语义相似度注入，而不是必须出现关键词。
                第一次打开后的下一条消息开始准备，再下一条才生效。
              </p>
            </div>
            <Switch
              className="shrink-0"
              disabled={!wiLoaded}
              checked={wiSettings.vectorized_enabled}
              onCheckedChange={(v) => setWiSettings((s) => ({ ...s, vectorized_enabled: v }))}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">匹配松紧（0~1，越大越严）</p>
              <p className="text-xs text-muted-foreground">
                语义相似度的及格线，越大越不容易塞进不相干的设定（默认 0.55）。换嵌入模型后需重测。
              </p>
              <button
                type="button"
                disabled={!wiLoaded}
                onClick={() => setWiSettings((s) => ({
                  ...s,
                  vector_threshold: WORLD_INFO_GLOBAL_DEFAULTS.vector_threshold,
                }))}
                className="mt-1 text-xs text-primary hover:underline disabled:opacity-40"
              >
                恢复默认
              </button>
            </div>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="w-24 shrink-0"
              disabled={!wiLoaded || !wiSettings.vectorized_enabled}
              value={wiSettings.vector_threshold}
              onChange={(e) => {
                const num = e.target.value === '' ? 0 : Number(e.target.value);
                if (!Number.isNaN(num)) {
                  setWiSettings((s) => ({ ...s, vector_threshold: num }));
                }
              }}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">每轮最多命中几条</p>
              <p className="text-xs text-muted-foreground">
                每本世界书每轮最多按语义注入的条目数（1-10，默认 3）
              </p>
            </div>
            <Input
              type="number"
              min={1}
              max={10}
              className="w-24 shrink-0"
              disabled={!wiLoaded || !wiSettings.vectorized_enabled}
              value={wiSettings.vector_top_k}
              onChange={(e) => {
                const num = e.target.value === '' ? 1 : Number(e.target.value);
                if (!Number.isNaN(num)) {
                  setWiSettings((s) => ({ ...s, vector_top_k: num }));
                }
              }}
            />
          </div>

          <div>
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">插入策略</p>
              <p className="text-xs text-muted-foreground">角色世界书与全局世界书条目的插入顺序（ST Character Lore Insertion Strategy，默认角色优先）</p>
            </div>
            <div className="mt-2 flex gap-2">
              {([0, 1, 2] as const).map((v) => (
                <Button
                  key={v}
                  variant={wiSettings.world_info_character_strategy === v ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  disabled={!wiLoaded}
                  onClick={() => setWiSettings((s) => ({ ...s, world_info_character_strategy: v }))}
                >
                  {v === 0 ? '均匀' : v === 1 ? '角色优先' : '全局优先'}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RoleplayEngineTabProps {
  bottomPadding: string;
  onOpenAdminPlugins: () => void;
}

export function RoleplayEngineTab({ bottomPadding, onOpenAdminPlugins }: RoleplayEngineTabProps) {
  const [roleplayEngineSubTab, setRoleplayEngineSubTab] = useState<RoleplayEngineSubTab>('theme');
  const [characterDisplayMode, setCharacterDisplayMode] = useState<string>('framed');

  // Roleplay engine regex scripts state
  const [regexScripts, setRegexScripts] = useState<any[]>([]);
  const [regexScriptsLoading, setRegexScriptsLoading] = useState(false);

  // Roleplay engine preset state
  const [presets, setPresets] = useState<any[]>([]);
  const [currentPreset, setCurrentPreset] = useState<any>(null);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [presetsLoading, setPresetsLoading] = useState(false);

  // ST 1.18.0 context template state — loaded alongside presets so the
  // preset editor can show a template selector bound to preset.context_template_name.
  const [contextTemplates, setContextTemplates] = useState<any[]>([]);
  const [contextTemplatesLoading, setContextTemplatesLoading] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
        setCharacterDisplayMode(settings.character_display_mode || 'framed');
      } catch (e) {
        console.error('Failed to fetch character display mode:', e);
      }
    };
    fetchSettings();
    fetchRegexPluginsAndScripts();
    fetchPresets();
    fetchContextTemplates();
  }, []);

  const handleSaveCharacterDisplayMode = async (mode: string) => {
    try {
      await api.put('/api/users/me/settings', { character_display_mode: mode });
      invalidateCache('/api/users/me/settings');
      setCharacterDisplayMode(mode);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { characterDisplayMode: mode } }));
    } catch (e) {
      console.error('Failed to save character display mode:', e);
      toast.error('保存角色扮演显示模式失败');
    }
  };

  const fetchRegexPluginsAndScripts = async () => {
    setRegexScriptsLoading(true);
    try {
      const plugins: any[] = await api.get('/api/plugins');
      const regexTypes = ['regex_scripts', 'regex_script_single'];
      const regexPlugs = plugins.filter((p: any) => regexTypes.includes(p.plugin_type));
      const allScripts: any[] = [];
      await Promise.all(
        regexPlugs.map(async (plugin: any) => {
          try {
            const data = await api.get(`/api/plugins/${plugin.id}`);
            const scripts = (data.scripts || []).filter((s: any) => s.script_type === 'regex');
            scripts.forEach((s: any) => {
              allScripts.push({ ...s, plugin_id: plugin.id });
            });
          } catch (e) {
            console.error('Failed to fetch plugin scripts:', e);
          }
        })
      );
      allScripts.sort((a, b) => (a.order_no ?? 0) - (b.order_no ?? 0));
      setRegexScripts(allScripts);
    } catch (e) {
      console.error('Failed to fetch regex plugins:', e);
    } finally {
      setRegexScriptsLoading(false);
    }
  };

  const handleToggleRegexScript = async (pluginId: string, scriptId: string) => {
    try {
      await api.put(`/api/plugins/${pluginId}/scripts/${scriptId}/toggle`);
      await fetchRegexPluginsAndScripts();
      toast.success('脚本状态已更新');
    } catch (e) {
      toast.error('操作失败');
      console.error('Failed to toggle script:', e);
    }
  };

  const handleImportRegex = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const scripts = JSON.parse(text);
        const result: any = await api.post('/api/plugins/import/regex-target', {
          scripts,
          target: 'global',
        });
        await fetchRegexPluginsAndScripts();
        toast.success(`已导入 ${result.count || scripts.length} 条正则脚本`);
      } catch (err: any) {
        toast.error(err?.message || '正则脚本导入失败');
      }
    };
    input.click();
  };

  const handleExportRegex = () => {
    const blob = new Blob([JSON.stringify(regexScripts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'regex-scripts.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const fetchPresets = async () => {
    setPresetsLoading(true);
    try {
      await api.post('/api/roleplay/presets/ensure-defaults');
      const data = await api.get('/api/roleplay/presets');
      setPresets(data);
      if (!currentPreset && data.length > 0) {
        const def = data.find((p: any) => p.is_default) || data[0];
        setCurrentPreset(def);
      }
    } catch (e) {
      console.error('Failed to load presets:', e);
    } finally {
      setPresetsLoading(false);
    }
  };

  // ST 1.18.0 context templates — fetch the list so the preset editor can
  // show a template selector. Idempotent: ensure-builtin writes seeds if missing.
  const fetchContextTemplates = async () => {
    setContextTemplatesLoading(true);
    try {
      await api.post('/api/roleplay/context-templates/ensure-builtin');
      const data = await api.get('/api/roleplay/context-templates');
      setContextTemplates(data);
    } catch (e) {
      console.error('Failed to load context templates:', e);
    } finally {
      setContextTemplatesLoading(false);
    }
  };

  const handlePresetChange = (preset: any) => {
    setCurrentPreset(preset);
  };

  const handleUpdatePresetParam = async (key: string, value: number) => {
    if (!currentPreset) return;
    const next = { ...currentPreset, [key]: value };
    setCurrentPreset(next);
    try {
      await api.put(`/api/roleplay/presets/${currentPreset.id}`, { [key]: value });
    } catch (e) {
      console.error('Failed to update preset:', e);
    }
  };

  // ST 1.18.0 context template binding — update preset.context_template_name.
  // Empty/null falls back to "Default" on the backend (passthrough behavior).
  const handleUpdatePresetContextTemplate = async (templateName: string) => {
    if (!currentPreset) return;
    const next = { ...currentPreset, context_template_name: templateName || null };
    setCurrentPreset(next);
    try {
      await api.put(`/api/roleplay/presets/${currentPreset.id}`, {
        context_template_name: templateName || null,
      });
    } catch (e) {
      console.error('Failed to update context template binding:', e);
    }
  };

  return (
    <div className={`space-y-4 md:space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>

          {/* 二级页签：统一胶囊底色（grid-cols-4 保证移动端单行不换行） */}
          <div className="grid grid-cols-4 gap-1 p-1 bg-secondary/60 rounded-xl sm:inline-grid sm:grid-cols-4">
            {[
              { id: 'theme' as RoleplayEngineSubTab, label: '主题' },
              { id: 'regex' as RoleplayEngineSubTab, label: '正则脚本' },
              { id: 'preset' as RoleplayEngineSubTab, label: '生成预设' },
              { id: 'sillytavern' as RoleplayEngineSubTab, label: 'SillyTavern' },
            ].map(sub => (
              <button
                key={sub.id}
                onClick={() => setRoleplayEngineSubTab(sub.id)}
                className={cn(
                  'whitespace-nowrap rounded-lg px-1 py-2 text-center text-[13px] font-medium transition-all duration-200 sm:px-4 sm:text-sm',
                  roleplayEngineSubTab === sub.id
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {sub.label}
              </button>
            ))}
          </div>

          {roleplayEngineSubTab === 'theme' && (
            <div className="space-y-4 md:space-y-6">
              <SettingsGroup label="显示">
                <SettingsRow
                  icon={<Bot size={15} />}
                  title="角色扮演显示模式"
                >
                  <Segmented
                    value={characterDisplayMode}
                    onChange={handleSaveCharacterDisplayMode}
                    options={[
                      { value: 'framed', label: '分框模式' },
                      { value: 'frameless', label: '无分框模式' },
                    ]}
                  />
                </SettingsRow>
              </SettingsGroup>

              <RoleplayThemeProvider>
                <RoleplayThemeSettingsPanel />
              </RoleplayThemeProvider>

              <SettingsGroup label="插件">
                <SettingsRow icon={<Puzzle size={15} />} title="插件管理">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onOpenAdminPlugins}
                    className="h-8 md:h-9 rounded-md px-3"
                  >
                    管理
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            </div>
          )}

          {roleplayEngineSubTab === 'regex' && (
            <div className="space-y-4 md:space-y-6">
              <SettingsGroup label="正则脚本">
                <SettingsRow
                  icon={<Sliders size={15} />}
                  title="导入 / 导出"
                >
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleImportRegex} className="h-8 md:h-9 rounded-md px-3">
                      <UploadCloud size={14} className="mr-1.5" />
                      导入
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleExportRegex} className="h-8 md:h-9 rounded-md px-3">
                      <Download size={14} className="mr-1.5" />
                      导出
                    </Button>
                  </div>
                </SettingsRow>
                {regexScriptsLoading ? (
                  <div className="px-4 py-3 text-muted-foreground text-sm">加载中...</div>
                ) : regexScripts.length === 0 ? (
                  <div className="px-4 py-3 text-muted-foreground text-sm">暂无正则脚本</div>
                ) : (
                  regexScripts.map((script) => (
                    <SettingsRow
                      key={`${script.plugin_id}-${script.id}`}
                      title={script.name}
                      desc={script.description || script.source || '无描述'}
                    >
                      <Switch
                        checked={script.enabled !== false}
                        onCheckedChange={() => handleToggleRegexScript(script.plugin_id, script.id)}
                      />
                    </SettingsRow>
                  ))
                )}
              </SettingsGroup>
            </div>
          )}

          {roleplayEngineSubTab === 'preset' && (
            <div className="space-y-4 md:space-y-6">
              <GlassCard className="p-4 md:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-semibold text-base md:text-lg">生成参数预设</h4>
                  <Button variant="outline" size="sm" onClick={() => setPresetManagerOpen(true)}>
                    <Sliders size={16} className="mr-2" />
                    预设管理
                  </Button>
                </div>
                {presetsLoading ? (
                  <div className="text-muted-foreground text-sm">加载中...</div>
                ) : !currentPreset ? (
                  <div className="text-muted-foreground text-sm">暂无预设</div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">当前预设</span>
                      <span className="text-sm">{currentPreset.name}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">上下文模板</span>
                        <span className="text-xs text-muted-foreground">ST 1.18.0 Context Template</span>
                      </div>
                      <select
                        value={currentPreset.context_template_name || 'Default'}
                        onChange={(e) => handleUpdatePresetContextTemplate(e.target.value)}
                        disabled={contextTemplatesLoading}
                        className="text-sm rounded-md border border-border bg-background px-3 py-2 max-w-[60%] focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                      >
                        {contextTemplatesLoading ? (
                          <option value="">加载中...</option>
                        ) : contextTemplates.length === 0 ? (
                          <option value="Default">Default</option>
                        ) : (
                          contextTemplates.map((tpl: any) => (
                            <option key={tpl.id} value={tpl.name}>
                              {tpl.display_name || tpl.name}{tpl.is_builtin ? ' (内置)' : ''}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    {[
                      { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.05 },
                      { key: 'top_p', label: 'Top-P', min: 0, max: 1, step: 0.05 },
                      { key: 'max_tokens', label: '最大令牌数', min: 64, max: 8192, step: 64 },
                      { key: 'frequency_penalty', label: '频率惩罚', min: -2, max: 2, step: 0.1 },
                      { key: 'presence_penalty', label: '存在惩罚', min: -2, max: 2, step: 0.1 },
                    ].map((param) => (
                      <div key={param.key}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm">{param.label}</span>
                          <span className="text-sm text-muted-foreground">{(currentPreset as any)[param.key]}</span>
                        </div>
                        <input
                          type="range"
                          min={param.min}
                          max={param.max}
                          step={param.step}
                          value={(currentPreset as any)[param.key] ?? 0}
                          onChange={(e) => handleUpdatePresetParam(param.key, parseFloat(e.target.value))}
                          className="w-full accent-primary"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>
            </div>
          )}

          {roleplayEngineSubTab === 'sillytavern' && (
            <RoleplayThemeProvider>
              <SillyTavernSettingsPanel onOpenPlugins={onOpenAdminPlugins} />
            </RoleplayThemeProvider>
          )}

          <PresetManager
            currentPreset={currentPreset}
            onPresetChange={handlePresetChange}
            open={presetManagerOpen}
            onClose={() => setPresetManagerOpen(false)}
          />
        </div>
  );
}
