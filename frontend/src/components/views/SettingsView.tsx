import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { 
  User, 
  Sparkles, 
  AlertCircle, 
  Users, 
  Shield, 
  HelpCircle,
  Save,
  Plus,
  Edit3,
  Trash2,
  Bot,
  Database,
  UploadCloud,
  LogOut,
  ChevronDown,
  Sun,
  Moon,
  RefreshCw,
  Zap,
  MessageSquareText,
  Eye,
  Image,
  Key,
  Globe,
  Settings2,
  Sliders,
  Download,
  Puzzle,
  MonitorSmartphone
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, invalidateCache } from '@/services/api';
import { getSmartCardAssetMode, setSmartCardAssetMode } from '@/components/ui/custom/smart-card-runtime/asset-mode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { OCSettings } from '@/components/ui/custom/OCSettings';
import { PromptSettings } from './settings-tabs/PromptSettings';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { TokenUsagePanel } from '@/components/ui/custom/TokenUsagePanel';
import { ModelManagementTab } from './settings-tabs/ModelManagementTab';
import { AboutTab } from './settings-tabs/AboutTab';
import { ProfileTab } from './settings-tabs/ProfileTab';
import { AuthSettingsTab } from './settings-tabs/AuthSettingsTab';
import { AdminPluginsTab } from './settings-tabs/AdminPluginsTab';
import { EMOJIS } from './settings-constants';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import { useIsMobile } from '@/hooks/use-mobile';
import { useRoleplayTheme, RoleplayThemeProvider } from '@/contexts/RoleplayThemeContext';
import { PresetManager } from '@/components/ui/custom/PresetManager';
import type { Model, Provider, User as UserType, RoleplayChatStyle, Theme } from '@/types';

interface SettingsViewProps {
  token: string;
  user: UserType;
  models: Model[];
  systemDefaults: any;
  onLogout: () => void;
  onUpdateDefaults: () => void;
  t: Record<string, string>;
  isDark?: boolean;
  onThemeToggle?: () => void;
  themeMode?: Theme;
  onThemeSet?: (mode: Theme) => void;
  lang?: string;
  onLangToggle?: () => void;
}

type SettingsTab = 'profile' | 'roleplay_engine' | 'appearance' | 'models' | 'memory' | 'oc' | 'prompts' | 'admin_users' | 'admin_auth' | 'admin_defaults' | 'admin_starters' | 'admin_plugins' | 'about' | 'usage' | 'user_usage';
type ModelSubTab = 'llm' | 'local' | 'vision';
type RoleplayEngineSubTab = 'theme' | 'regex' | 'preset' | 'sillytavern';

function RoleplayThemeSettingsPanel() {
  const { themes, currentThemeId, setCurrentThemeId, createTheme, deleteTheme, exportTheme, importTheme, updateTheme } = useRoleplayTheme();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <div className="space-y-4">
      <GlassCard className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-lg font-medium">主题预设</h4>
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
        <h4 className="text-lg font-medium mb-4">聊天样式</h4>
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
  const [stMode, setStMode] = useState<string>('palink-native');

  useEffect(() => {
    const loadMode = async () => {
      try {
        const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
        setStMode(settings.silly_tavern_mode || 'palink-native');
      } catch (e) {
        console.error('Failed to load silly tavern mode:', e);
      }
    };
    loadMode();
  }, []);

  const handleModeChange = async (mode: string) => {
    const previous = stMode;
    setStMode(mode);
    try {
      await api.put('/api/users/me/settings', {
        silly_tavern_mode: mode,
      });
      invalidateCache('/api/users/me/settings');
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', {
        detail: { sillyTavernMode: mode },
      }));
      const labels: Record<string, string> = {
        'palink-native': 'Palink 原生',
        'st-compat': 'ST 兼容装配',
        'st-native': 'ST 原生界面',
      };
      toast.success(`已切换为${labels[mode] || mode}`);
    } catch (e) {
      console.error('Failed to save silly tavern mode:', e);
      setStMode(previous);
      toast.error('保存 ST 模式失败，已恢复之前状态');
    }
  };

  // 方向声明: 项目主攻 palink-native；st-compat / st-native 已封存冷处理、待删除，
  // 除非用户明确要求不要优化这两个模式。详见根目录 AGENTS.md。
  const stModes: Array<{ value: string; label: string; desc: string }> = [
    { value: 'palink-native', label: 'Palink 原生', desc: 'Palink 界面 + Palink 原生提示词装配' },
    { value: 'st-compat', label: 'ST 兼容装配', desc: 'Palink 界面 + SillyTavern 1.18 对齐的提示词装配（推荐）' },
    { value: 'st-native', label: 'ST 原生界面', desc: '嵌入完整的 SillyTavern 前端界面，使用酒馆原生渲染、插件和正则引擎' },
  ];

  return (
    <div className="space-y-6">
      <GlassCard className="p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <Sparkles size={20} className="text-muted-foreground shrink-0" />
          <div>
            <p className="font-medium">SillyTavern 模式</p>
            <p className="text-xs text-muted-foreground">选择角色扮演提示词的装配与界面运行时</p>
          </div>
        </div>
        <div className="space-y-2">
          {stModes.map((m) => (
            <button
              key={m.value}
              type="button"
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                stMode === m.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              )}
              onClick={() => handleModeChange(m.value)}
            >
              <span className={cn(
                'mt-1 h-3.5 w-3.5 shrink-0 rounded-full border',
                stMode === m.value ? 'border-primary bg-primary' : 'border-muted-foreground/40'
              )} />
              <span>
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </GlassCard>

      <GlassCard className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Sliders size={20} className="text-muted-foreground shrink-0" />
            <div>
              <p className="font-medium">正则引擎</p>
              <p className="text-xs text-muted-foreground">SillyTavern 兼容正则引擎（LRU 缓存、允许列表、深度过滤）</p>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">已就绪</div>
        </div>
      </GlassCard>

      <GlassCard className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Puzzle size={20} className="text-muted-foreground shrink-0" />
            <div>
              <p className="font-medium">插件系统</p>
              <p className="text-xs text-muted-foreground">SillyTavern 扩展插件管理</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenPlugins}
            className="min-h-[44px]"
          >
            打开插件管理
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}

export function SettingsView({
  token,
  user,
  models,
  systemDefaults,
  onLogout,
  onUpdateDefaults,
  t,
  isDark,
  onThemeToggle,
  themeMode,
  onThemeSet,
  lang,
  onLangToggle
}: SettingsViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const bottomPadding = useMobileBottomPadding();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const state = location.state as { activeTab?: string } | null;
    if (state?.activeTab && ['profile', 'roleplay_engine', 'appearance', 'models', 'memory', 'oc', 'prompts', 'admin_users', 'admin_auth', 'admin_defaults', 'admin_starters', 'admin_plugins', 'about', 'usage', 'user_usage'].includes(state.activeTab)) {
      return state.activeTab as SettingsTab;
    }
    return 'profile';
  });
  const [mobileTabSelected, setMobileTabSelected] = useState(() => {
    const state = location.state as { activeTab?: string } | null;
    return !!state?.activeTab;
  });
  const [modelSubTab, setModelSubTab] = useState<ModelSubTab>('llm');
  const [roleplayEngineSubTab, setRoleplayEngineSubTab] = useState<RoleplayEngineSubTab>('theme');

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
    if (location.state) {
      window.history.replaceState({}, '');
    }
  }, []);

  useEffect(() => {
    const handleIconSync = (e: Event) => {
      const { modelId, icon } = (e as CustomEvent).detail;
      if (!modelId || !icon) return;
      setProviders(prev => {
        let changed = false;
        const updated = prev.map(p => {
          const modelIndex = p.models.findIndex(m => m.id === modelId || m.name === modelId);
          if (modelIndex !== -1 && p.models[modelIndex].icon !== icon) {
            changed = true;
            const newModels = [...p.models];
            newModels[modelIndex] = { ...newModels[modelIndex], icon };
            return { ...p, models: newModels };
          }
          return p;
        });
        return changed ? updated : prev;
      });
    };
    window.addEventListener('modelIconChanged', handleIconSync);
    return () => window.removeEventListener('modelIconChanged', handleIconSync);
  }, []);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usersList, setUsersList] = useState<UserType[]>([]);
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  
  // Provider connection status
  const [providerStatus, setProviderStatus] = useState<Record<string, { 
    success: boolean | null; 
    message: string; 
    testing: boolean 
  }>>({});
  
  // Ollama model running status
  const [ollamaModelStatus, setOllamaModelStatus] = useState<Record<string, boolean>>({});
  
  // Profile state
  const [avatarUrl, setAvatarUrl] = useState(user.avatar || '');
  const [avatarType, setAvatarType] = useState<'emoji' | 'image' | 'url'>('emoji');
  const [newUsername, setNewUsername] = useState(user.username || '');
  const [pwdOld, setPwdOld] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  // Memory mode state
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [showModelReasoning, setShowModelReasoning] = useState<boolean>(true);
  const [promptLanguage, setPromptLanguage] = useState<string>('auto');
  const [characterDisplayMode, setCharacterDisplayMode] = useState<string>('framed');
  // 亮色模式智能卡对比度自动增强开关（localStorage 持久化，增强器实时读取）
  const [autoContrast, setAutoContrast] = useState<boolean>(true);
  // 角色扮演角色卡头像展示开关（localStorage 持久化，Message 实时读取；默认开启）
  const [showCharacterAvatar, setShowCharacterAvatar] = useState<boolean>(true);
  // 智能卡第三方资源加载模式（localStorage 持久化；默认 direct 用户直连，
  // 开启 = proxy 服务器中转；CharacterCardRenderer 监听事件实时重建）
  const [smartCardAssetProxy, setSmartCardAssetProxy] = useState<boolean>(
    () => getSmartCardAssetMode() === 'proxy'
  );

  // Admin defaults state
  const [defChat, setDefChat] = useState(systemDefaults.default_chat_model || '');
  const [defWs, setDefWs] = useState(systemDefaults.default_workspace_model || '');
  const [defOutline, setDefOutline] = useState(systemDefaults.default_outline_model || '');
  const [dailyTopicModel, setDailyTopicModel] = useState(systemDefaults.daily_topic_model || '');
  const [defCharacterParse, setDefCharacterParse] = useState(systemDefaults.default_character_parse_model || '');
  const [defCharacterTranslate, setDefCharacterTranslate] = useState(systemDefaults.default_character_translate_model || '');
  const [defCharacterChat, setDefCharacterChat] = useState(systemDefaults.default_character_chat_model || '');
  const [defSummarization, setDefSummarization] = useState(systemDefaults.default_summarization_model || '');
  const [defOCAnalysis, setDefOCAnalysis] = useState(systemDefaults.default_oc_analysis_model || '');
  const [allowOCAnalysis, setAllowOCAnalysis] = useState(systemDefaults.allow_oc_analysis !== false);
  const [starterQuestions, setStarterQuestions] = useState<string[]>([]);
  const [startersExpanded, setStartersExpanded] = useState(false);
  const [imageCleanupEnabled, setImageCleanupEnabled] = useState(true);
  const [imageCleanupMaxAge, setImageCleanupMaxAge] = useState(30);
  const [imageCleanupExpanded, setImageCleanupExpanded] = useState(false);
  const isMobile = useIsMobile();
  const isDesktop = !isMobile;

  // Confirm dialog state
  const [modelDeleteConfirm, setModelDeleteConfirm] = useState<{ open: boolean; modelId: string }>({ open: false, modelId: '' });
  const [userDeleteConfirm, setUserDeleteConfirm] = useState<{ open: boolean; userId: string | number }>({ open: false, userId: '' });
  const [providerDeleteConfirm, setProviderDeleteConfirm] = useState<{ open: boolean; providerId: string }>({ open: false, providerId: '' });
  const [viewingUser, setViewingUser] = useState<UserType | null>(null);

  const isAdmin = user.role === 'admin';

  useEffect(() => {
    if (isAdmin) {
      fetchProviders();
      fetchUsers();
      fetchStarters();
      fetchLocalModels();
      fetchImageCleanupConfig();
    }
    // Load memory settings
    fetchMemoryMode();
    fetchRegexPluginsAndScripts();
    fetchPresets();
    fetchContextTemplates();
  }, [isAdmin]);

  const isLocalProvider = (provider: any): boolean => {
    const localKeywords = ['ollama', 'localhost', '127.0.0.1'];
    const providerName = (provider.name || '').toLowerCase();
    const baseUrl = (provider.base_url || '').toLowerCase();
    return localKeywords.some(keyword => 
      providerName.includes(keyword) || baseUrl.includes(keyword)
    ) || baseUrl.startsWith('ollama:');
  };

  const fetchMemoryMode = async () => {
    try {
      const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
      setMemoryMode(settings.memory_mode || 'rule');
      setShowModelReasoning(settings.show_model_reasoning !== false);
      setPromptLanguage(settings.prompt_language || 'auto');
      setCharacterDisplayMode(settings.character_display_mode || 'framed');
    } catch (e) {
      console.error('Failed to fetch memory mode:', e);
    }
  };

  useEffect(() => {
    try {
      setAutoContrast(localStorage.getItem('palink-auto-contrast') !== '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      setShowCharacterAvatar(localStorage.getItem('palink-rp-character-avatar') !== '0');
    } catch {
      /* ignore */
    }
  }, []);

  const handleToggleAutoContrast = (checked: boolean) => {
    setAutoContrast(checked);
    try {
      localStorage.setItem('palink-auto-contrast', checked ? '1' : '0');
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent('palink-auto-contrast-changed', { detail: { enabled: checked } }));
  };

  const handleToggleCharacterAvatar = (checked: boolean) => {
    setShowCharacterAvatar(checked);
    try {
      localStorage.setItem('palink-rp-character-avatar', checked ? '1' : '0');
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent('palink-rp-character-avatar-changed', { detail: { enabled: checked } }));
  };

  const handleToggleSmartCardAssetProxy = (checked: boolean) => {
    setSmartCardAssetProxy(checked);
    setSmartCardAssetMode(checked ? 'proxy' : 'direct');
  };

  const handleSaveMemoryMode = async (newMode: string) => {
    try {
      await api.put('/api/users/me/settings', { memory_mode: newMode });
      invalidateCache('/api/users/me/settings');
      setMemoryMode(newMode);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
    } catch (e) {
      console.error('Failed to save memory mode:', e);
      toast.error('保存记忆模式失败');
    }
  };

  const handleSaveModelReasoning = async (enabled: boolean) => {
    try {
      await api.put('/api/users/me/settings', { show_model_reasoning: enabled });
      invalidateCache('/api/users/me/settings');
      setShowModelReasoning(enabled);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { showModelReasoning: enabled } }));
    } catch (e) {
      console.error('Failed to save model reasoning setting:', e);
      toast.error('保存深度思考设置失败');
    }
  };

  const handleSavePromptLanguage = async (newLang: string) => {
    try {
      await api.put('/api/users/me/settings', { prompt_language: newLang });
      invalidateCache('/api/users/me/settings');
      setPromptLanguage(newLang);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { promptLanguage: newLang } }));
    } catch (e) {
      console.error('Failed to save prompt language:', e);
      toast.error('保存提示词语言失败');
    }
  };

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

  const fetchLocalModels = async () => {
    try {
      const data = await api.get('/api/models/local?all=true');
      setLocalModels(data);
    } catch (e) { console.error(e); }
  };
  
  // 启用/禁用模型
  const handleModelEnable = async (modelId: string, enabled: boolean) => {
    try {
      const modelName = modelId.replace('local:', '');
      await api.put(`/api/admin/models/local/${modelName}/enable?enabled=${enabled}`);
      setLocalModels(prev => prev.map(m => 
        m.id === modelId ? { ...m, enabled } : m
      ));
      window.dispatchEvent(new CustomEvent('modelsUpdated'));
      toast.success(enabled ? '模型已启用' : '模型已禁用');
    } catch (e: any) { 
      console.error(e);
      const detail = e?.detail || e?.message || (typeof e === 'string' ? e : '');
      toast.error(detail ? `设置失败: ${detail}` : '设置模型状态失败');
    }
  };

  const [mmprojFiles, setMmprojFiles] = useState<Array<{filename: string; path: string; size_bytes: number}>>([]);
  const [mmprojSelectorFor, setMmprojSelectorFor] = useState<string | null>(null);

  const fetchMmprojFiles = async () => {
    try {
      const files = await api.get('/api/admin/models/local/mmproj-files');
      setMmprojFiles(files);
    } catch (e) {
      console.error('Failed to fetch mmproj files:', e);
    }
  };

  const handleMmprojToggle = async (modelId: string, enabled: boolean) => {
    try {
      const modelName = modelId.replace('local:', '');
      await api.put(`/api/admin/models/local/${modelName}/mmproj?mmproj_enabled=${enabled}`);
      await fetchLocalModels();
      toast.success(enabled ? '视觉编码器已启用' : '视觉编码器已禁用');
    } catch (e: any) {
      console.error('Failed to toggle mmproj:', e);
      const detail = e?.detail || e?.message || (typeof e === 'string' ? e : '');
      toast.error(detail ? `操作失败: ${detail}` : '设置视觉编码器状态失败');
    }
  };

  const handleMaxConcurrentChange = async (modelId: string, maxConcurrent: number) => {
    try {
      const modelName = modelId.replace('local:', '');
      await api.put(`/api/admin/models/local/${modelName}/max-concurrent`, {
        max_concurrent: maxConcurrent,
      });
      setLocalModels(prev => prev.map(m =>
        m.id === modelId ? { ...m, max_concurrent: maxConcurrent } : m
      ));
      toast.success(`并发数已设置为 ${maxConcurrent}`);
    } catch (e) {
      console.error(e);
      toast.error('设置并发数失败');
    }
  };



  const handleModelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 重置进度条
    setUploadProgress(0);

    // 检查文件大小，给出提示
    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB
    if (file.size > maxSize) {
      toast.error('文件大小超过限制（最大10GB）');
      setUploadProgress(null);
      e.target.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();

    // 设置更长的超时时间（1小时）
    xhr.timeout = 3600000;

    // 监听上传进度
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const progress = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(progress);
      }
    });

    // 监听上传完成
    xhr.addEventListener('load', () => {
      setUploadProgress(null);
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          toast.success(data.message);
          fetchLocalModels();
        } catch (e) {
          toast.warning('上传成功，但解析响应失败');
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          toast.error(`上传失败: ${error.detail || '未知错误'}`);
        } catch (e) {
          toast.error(`上传失败: ${xhr.statusText || '未知错误'}`);
        }
      }
    });

    // 监听上传错误
    xhr.addEventListener('error', () => {
      setUploadProgress(null);
      toast.error('上传失败: 网络错误，请检查网络连接并重试');
    });

    // 监听上传超时
    xhr.addEventListener('timeout', () => {
      setUploadProgress(null);
      toast.error('上传超时，请检查网络连接并重试');
    });

    // 发送请求
    xhr.open('POST', '/api/admin/models/local/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);

    // 重置文件输入
    e.target.value = '';
  };

  const handleModelDelete = (modelId: string) => {
    setModelDeleteConfirm({ open: true, modelId });
  };

  const doModelDelete = async (modelId: string) => {
    try {
      const modelName = modelId.replace('local:', '');
      const data = await api.delete(`/api/admin/models/local/${modelName}`);
      toast.success(data.message);
      fetchLocalModels();
    } catch (e: any) {
      toast.error(`删除失败: ${e.message || '网络错误'}`);
    }
  };

  const fetchProviders = async () => {
    try {
      const data = await api.get('/api/admin/providers');
      setProviders(data);
    } catch (e) {
      console.error('Failed to fetch providers:', e);
      toast.error('加载服务商列表失败');
    }
  };

  const fetchUsers = async () => {
    try {
      const data = await api.get('/api/admin/users');
      setUsersList(data);
    } catch (e) {
      console.error('Failed to fetch users:', e);
      toast.error('加载用户列表失败');
    }
  };

  const fetchStarters = async () => {
    try {
      const data = await api.get('/api/recommendations/starters');
      setStarterQuestions(data);
    } catch (e) {
      console.error('Failed to fetch starters:', e);
      toast.error('加载推荐问题失败');
    }
  };

  const handleUpdateProfile = async () => {
    try {
      await api.put('/api/users/me', { avatar: avatarUrl, username: newUsername });
      toast.success('Profile updated');
    } catch (e) {
      console.error('Failed to update profile:', e);
      toast.error('更新个人资料失败');
    }
  };

  const handleChangePassword = async () => {
    // 验证输入
    if (!pwdOld.trim()) {
      toast.error(t.old_pwd_required || '请输入旧密码');
      return;
    }
    if (!pwdNew.trim()) {
      toast.error(t.new_pwd_required || '请输入新密码');
      return;
    }
    if (pwdNew.length < 6) {
      toast.error(t.pwd_min_length || '新密码至少需要6个字符');
      return;
    }
    if (pwdOld === pwdNew) {
      toast.error(t.pwd_same_as_old || '新密码不能与旧密码相同');
      return;
    }
    
    try {
      await api.post('/api/users/me/password', { old_password: pwdOld, new_password: pwdNew });
      toast.success(t.pwd_changed || '密码修改成功');
      setPwdOld('');
      setPwdNew('');
      setShowPasswordForm(false);
    } catch (e: any) {
      toast.error(e.message || t.pwd_change_error || '密码修改出错');
    }
  };

  const handleSaveDefaults = async () => {
    try {
      await api.post('/api/admin/system/defaults', {
        default_chat_model: defChat,
        default_workspace_model: defWs,
        default_outline_model: defOutline,
        daily_topic_model: dailyTopicModel,
        default_character_parse_model: defCharacterParse,
        default_character_translate_model: defCharacterTranslate,
        default_character_chat_model: defCharacterChat,
        default_summarization_model: defSummarization,
        default_oc_analysis_model: defOCAnalysis,
        allow_oc_analysis: allowOCAnalysis
      });
      onUpdateDefaults();
      toast.success(t.defaults_saved || '默认配置已保存');
    } catch (e) {
      console.error('Failed to save defaults:', e);
      toast.error('保存默认配置失败');
    }
  };

  const handleDeleteUser = (userId: string | number) => {
    setUserDeleteConfirm({ open: true, userId });
  };

  const doDeleteUser = async (userId: string | number) => {
    try {
      await api.delete(`/api/admin/users/${userId}`);
      setUsersList(usersList.filter((u: UserType) => u.id !== userId));
      toast.success(t.user_deleted || '用户已删除');
    } catch (e) {
      toast.error(t.delete_user_error || '删除用户出错');
    }
  };

  const handleSaveStarters = async () => {
    try {
      await api.post('/api/admin/recommendations/starters', starterQuestions);
      toast.success('Starters saved');
    } catch (e) {
      console.error('Failed to save starters:', e);
      toast.error('保存推荐问题失败');
    }
  };

  const fetchImageCleanupConfig = async () => {
    try {
      const config = await api.get('/api/admin/image-cleanup');
      setImageCleanupEnabled(config.enabled !== false);
      setImageCleanupMaxAge(config.max_age_days || 30);
    } catch (e) {
      console.error('Failed to fetch image cleanup config:', e);
    }
  };

  const handleSaveImageCleanup = async () => {
    try {
      await api.put('/api/admin/image-cleanup', {
        enabled: imageCleanupEnabled,
        max_age_days: imageCleanupMaxAge,
      });
      toast.success('图片清理配置已保存');
    } catch (e) {
      toast.error('保存图片清理配置失败');
    }
  };

  const handleRunImageCleanup = async () => {
    try {
      const result = await api.post('/api/admin/image-cleanup/run', {});
      toast.success(`清理完成：删除 ${result.deleted_count} 个文件，释放 ${result.freed_mb} MB`);
    } catch (e) {
      toast.error('执行图片清理失败');
    }
  };

  const handleEditProvider = (provider?: Provider) => {
    if (provider) {
      navigate(`/settings/providers/${provider.id}`);
    } else {
      navigate('/settings/providers/new');
    }
  };

  const ensureUrlHasProtocol = (url: string): string => {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return 'https://' + url;
  };

  const handleDeleteProvider = (id: string) => {
    setProviderDeleteConfirm({ open: true, providerId: id });
  };

  const doDeleteProvider = async (id: string) => {
    try {
      await api.delete('/api/admin/providers/' + id);
      fetchProviders();
    } catch (e) {
      console.error('Failed to delete provider:', e);
    }
  };

  // Toggle Ollama model running status
  const toggleOllamaModel = async (provider: Provider, modelId: string, modelName: string, enable: boolean) => {
    const key = `${provider.id}-${modelId}`;
    try {
      if (enable) {
        // Start/pull the model in Ollama
        toast.info(`正在加载 ${modelName}...`);
        // We'll check status after a short delay
        setTimeout(() => {
          setOllamaModelStatus(prev => ({ ...prev, [key]: true }));
          toast.success(`${modelName} 已准备就绪`);
        }, 1000);
      } else {
        // We don't actually stop models in Ollama (it manages memory automatically)
        setOllamaModelStatus(prev => ({ ...prev, [key]: false }));
        toast.info(`${modelName} 已禁用`);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const testProviderConnection = async (provider: Provider) => {
    setProviderStatus(prev => ({
      ...prev,
      [provider.id]: { success: null, message: '测试中...', testing: true }
    }));
    
    try {
      const data = await api.post('/api/admin/test-provider', {
        base_url: ensureUrlHasProtocol(provider.base_url),
        api_key: provider.api_key,
        provider_id: provider.id,
        provider_name: provider.name
      });
      setProviderStatus(prev => ({
        ...prev,
        [provider.id]: { 
          success: data.success, 
          message: data.message, 
          testing: false 
        }
      }));
    } catch (e) {
      setProviderStatus(prev => ({
        ...prev,
        [provider.id]: { 
          success: false, 
          message: '网络错误', 
          testing: false 
        }
      }));
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => setAvatarUrl(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const menuItems = [
    { id: 'profile' as SettingsTab, label: t.settings_profile, icon: User },
    { id: 'oc' as SettingsTab, label: '原创角色(OC)', icon: User },
    { id: 'roleplay_engine' as SettingsTab, label: '角色扮演引擎', icon: Bot },
    { id: 'appearance' as SettingsTab, label: t.appearance || '外观与语言', icon: Sun },
    { id: 'prompts' as SettingsTab, label: '提示词', icon: MessageSquareText },
  ];

  if (isAdmin) {
    menuItems.push(
      { id: 'models' as SettingsTab, label: '模型管理', icon: Bot },
      { id: 'admin_users' as SettingsTab, label: t.admin_users, icon: Users },
      { id: 'admin_auth' as SettingsTab, label: '认证设置', icon: Key },
      { id: 'admin_defaults' as SettingsTab, label: t.admin_defaults, icon: Shield },
      { id: 'admin_plugins' as SettingsTab, label: '插件管理', icon: Puzzle }
    );
  }
  
  menuItems.push(
    { id: 'usage' as SettingsTab, label: '用量统计', icon: Zap },
    { id: 'about' as SettingsTab, label: t.settings_about, icon: AlertCircle }
  );

  return (
    <div className={cn('relative flex h-full overflow-hidden', isMobile ? (isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]') : 'bg-background')}>
      {/* Desktop Sidebar - Vertical Navigation */}
      <div className="hidden md:flex w-64 flex-shrink-0 border-r border-border/50 bg-background flex-col">
        {/* Sidebar Header */}
        <div className="h-14 flex items-center justify-between px-4 sm:px-6 border-b border-border/50 bg-background z-10">
          <span className="text-base sm:text-sm font-semibold text-foreground truncate">{t.nav_config}</span>
        </div>
        
        {/* Sidebar Navigation */}
        <ScrollArea className="flex-1 px-2 py-2">
          <div className="space-y-1">
            {menuItems.map(item => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left",
                  activeTab === item.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <item.icon size={18} className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      
      {/* Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Mobile Header - 悬浮覆盖在滚动内容上方，让毛玻璃可以"接住"下面经过的内容模糊 */}
        <div
          className="md:hidden absolute top-0 left-0 right-0 z-20"
          style={{ height: 'calc(max(env(safe-area-inset-top), 8px) + 48px)' }}
        >
          {/* 从下到上渐变模糊的毛玻璃层：底部完全透明，越向上越不透明+模糊越强 */}
          <div
            className="absolute inset-0 z-0 pointer-events-none"
            style={{
              backdropFilter: 'blur(28px) saturate(200%)',
              WebkitBackdropFilter: 'blur(28px) saturate(200%)',
              // 关键修复：background alpha 控制颜色盖子(0底→0.4中→0.8顶，"20%透明度"=alpha0.8)
              // mask 只控制底部羽化(底部0让blur消失→20%处升到1→顶部保持1不削弱background)
              // 实际可见度 = bg alpha × mask alpha：底0×0=0 / 中0.4×1=0.4 / 顶0.8×1=0.8
              backgroundImage: isDark
                ? 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.10) 15%, rgba(0,0,0,0.22) 30%, rgba(0,0,0,0.32) 45%, rgba(0,0,0,0.40) 55%, rgba(0,0,0,0.52) 70%, rgba(0,0,0,0.64) 82%, rgba(0,0,0,0.74) 92%, rgba(0,0,0,0.80) 100%)'
                : 'linear-gradient(to top, rgba(255,255,255,0) 0%, rgba(255,255,255,0.12) 15%, rgba(255,255,255,0.26) 30%, rgba(255,255,255,0.38) 45%, rgba(255,255,255,0.48) 55%, rgba(255,255,255,0.60) 70%, rgba(255,255,255,0.72) 82%, rgba(255,255,255,0.78) 92%, rgba(255,255,255,0.85) 100%)',
              WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 8%, rgba(0,0,0,0.85) 16%, rgba(0,0,0,1) 22%, rgba(0,0,0,1) 100%)',
              maskImage: 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 8%, rgba(0,0,0,0.85) 16%, rgba(0,0,0,1) 22%, rgba(0,0,0,1) 100%)',
            }}
          />
          {/* 分隔线放在毛玻璃上层，但本身半透明（也会被mask的透明度影响，显得底部淡） */}
          <div
            className="absolute left-0 right-0 bottom-0 z-[5] border-b border-border/50 pointer-events-none"
            style={{
              WebkitMaskImage: 'linear-gradient(to top, black 0%, black 20%, transparent 100%)',
              maskImage: 'linear-gradient(to top, black 0%, black 20%, transparent 100%)',
            }}
          />
          <div
            className="absolute inset-0 z-10 flex items-center px-4 pointer-events-none"
            style={{ paddingTop: 'max(env(safe-area-inset-top), 8px)' }}
          >
            <div className="pointer-events-auto flex items-center h-[48px] w-full">
              {mobileTabSelected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMobileTabSelected(false)}
                  className="flex items-center gap-1"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                  返回
                </Button>
              ) : (
                <h2 className="pointer-events-none text-lg font-semibold">{t.nav_config}</h2>
              )}
            </div>
          </div>
        </div>

        {/* Mobile - Vertical Tabs (scrollable with bottom safe area) */}
        {!mobileTabSelected && isMobile && (
          <div
            className={`flex-1 md:hidden overflow-y-auto overflow-x-hidden px-4 py-3 ${bottomPadding}`}
            // 移除固定的 paddingTop，由下方 spacer 精确提供 = header 完整高度
          >
            {/* 顶部安全空间：高度与 header 完全一致(max(safe-area,8px)+48px)，确保"个人资料"等第一个按钮不被 header 挡住 */}
            <div aria-hidden style={{ height: 'calc(max(env(safe-area-inset-top), 8px) + 48px)', width: '100%' }} />
            <div className="space-y-2">
              {menuItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileTabSelected(true);
                  }}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-2xl transition-all duration-200 bg-gradient-to-r from-secondary/90 to-secondary hover:from-secondary hover:to-secondary/90 hover:shadow-md active:scale-[0.98] min-h-[56px] box-border"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <item.icon size={18} className="text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">{item.label}</span>
                  </div>
                  <ChevronDown size={18} className="text-muted-foreground rotate-90 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
        
        {(mobileTabSelected || isDesktop) && (
          <div
            className="flex-1 min-w-0 w-full p-4 md:p-8 h-full overflow-y-auto overflow-x-hidden"
            // 移动端移除固定 paddingTop，由下方 spacer 精确提供
          >
            {/* 顶部安全空间：高度与 header 完全一致，确保 Tab 内容最顶部不会被 header 挡住 */}
            <div aria-hidden style={{ height: 'calc(max(env(safe-area-inset-top), 8px) + 48px)', width: '100%' }} />
            <div className="max-w-4xl mx-auto h-full overflow-y-auto overflow-x-hidden">
              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <ProfileTab
                  t={t}
                  user={user}
                  avatarUrl={avatarUrl}
                  setAvatarUrl={setAvatarUrl}
                  avatarType={avatarType}
                  setAvatarType={setAvatarType}
                  newUsername={newUsername}
                  setNewUsername={setNewUsername}
                  showPasswordForm={showPasswordForm}
                  setShowPasswordForm={setShowPasswordForm}
                  pwdOld={pwdOld}
                  setPwdOld={setPwdOld}
                  pwdNew={pwdNew}
                  setPwdNew={setPwdNew}
                  handleImageUpload={handleImageUpload}
                  handleUpdateProfile={handleUpdateProfile}
                  handleChangePassword={handleChangePassword}
                  onLogout={onLogout}
                />
              )}

          {/* Models Tab - Unified Model Management */}
          {activeTab === 'models' && (
            <ModelManagementTab
              t={t}
              isAdmin={isAdmin}
              providers={providers}
              providerStatus={providerStatus}
              handleEditProvider={handleEditProvider}
              testProviderConnection={testProviderConnection}
              handleDeleteProvider={handleDeleteProvider}
              localModels={localModels}
              fetchLocalModels={fetchLocalModels}
              uploadProgress={uploadProgress}
              handleModelUpload={handleModelUpload}
              handleModelEnable={handleModelEnable}
              handleModelDelete={handleModelDelete}
              handleMmprojToggle={handleMmprojToggle}
            />
          )}

          {/* Admin Defaults Tab */}
          {activeTab === 'admin_defaults' && isAdmin && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-xl md:text-2xl font-semibold">{t.admin_defaults}</h3>
              
              <GlassCard className="p-4 md:p-6">
                <div className="space-y-4">
                  {[
                    { label: t.def_chat_model, value: defChat, set: setDefChat },
                    { label: t.def_ws_model, value: defWs, set: setDefWs },
                    { label: t.def_outline_model, value: defOutline, set: setDefOutline },
                    { label: '解析/翻译人物卡默认模型', value: defCharacterParse, set: setDefCharacterParse },
                    { label: '人物卡翻译默认模型', value: defCharacterTranslate, set: setDefCharacterTranslate },
                    { label: '角色扮演默认模型', value: defCharacterChat, set: setDefCharacterChat },
                    { label: '摘要生成默认模型', value: defSummarization, set: setDefSummarization }
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3 py-3 border-b border-border/50 last:border-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <Bot size={18} className="text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium truncate">{item.label}</span>
                      </div>
                      <div className="shrink-0 ml-auto">
                      <ModelSelector
                        models={models}
                        currentModel={item.value}
                        onSelect={(modelId: string) => item.set(modelId)}
                        size="sm"
                      />
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-t border-border/50">
                    <div className="flex items-center gap-3">
                      <Sparkles size={18} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-sm font-medium">允许AI分析用户个人OC卡</p>
                        <p className="text-xs text-muted-foreground">启用后AI可以深度分析用户的原创角色设定</p>
                      </div>
                    </div>
                    <Switch
                      checked={allowOCAnalysis}
                      onCheckedChange={setAllowOCAnalysis}
                    />
                  </div>
                  {allowOCAnalysis && (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <Bot size={18} className="text-muted-foreground shrink-0" />
                        <span className="text-sm">OC分析默认模型</span>
                      </div>
                      <ModelSelector
                        models={models}
                        currentModel={defOCAnalysis}
                        onSelect={setDefOCAnalysis}
                        size="sm"
                      />
                    </div>
                  )}
                </div>

                <div className="mt-6 flex justify-end">
                  <Button onClick={handleSaveDefaults} className="min-h-[44px]">
                    <Save size={16} className="mr-2" />
                    {t.save}
                  </Button>
                </div>
              </GlassCard>

              <div className="space-y-4 mt-4">
                <button
                  onClick={() => setImageCleanupExpanded(!imageCleanupExpanded)}
                  className="w-full flex items-center justify-between p-3 rounded-xl transition-all bg-secondary hover:bg-secondary/80 active:bg-secondary/60 min-h-[48px]"
                >
                  <div className="flex items-center gap-3">
                    <Trash2 size={18} className="text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm">图片过期清理</span>
                  </div>
                  <ChevronDown
                    size={18}
                    className={cn(
                      "text-muted-foreground transition-transform duration-300 shrink-0",
                      imageCleanupExpanded && "rotate-180"
                    )}
                  />
                </button>

                {imageCleanupExpanded && (
                  <div className="animate-in slide-in-from-top-2 fade-in duration-300">
                    <GlassCard className="p-4 md:p-6">
                      <p className="text-sm text-muted-foreground mb-4">
                        配置上传图片的自动清理策略，超过指定天数的图片将被自动删除。
                      </p>
                      <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2">
                          <div>
                            <p className="font-medium text-sm">启用自动清理</p>
                            <p className="text-xs text-muted-foreground">开启后系统将按设定时间自动清理过期图片</p>
                          </div>
                          <Switch
                            checked={imageCleanupEnabled}
                            onCheckedChange={setImageCleanupEnabled}
                          />
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2 border-t border-border/50">
                          <div>
                            <p className="font-medium text-sm">过期天数</p>
                            <p className="text-xs text-muted-foreground">超过此天数的图片将被自动清理</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={1}
                              max={365}
                              value={imageCleanupMaxAge}
                              onChange={e => setImageCleanupMaxAge(Math.max(1, Math.min(365, parseInt(e.target.value) || 30)))}
                              className="w-20 px-3 py-1.5 rounded-lg bg-secondary border-none outline-none text-center text-sm touch-input"
                            />
                            <span className="text-sm text-muted-foreground">天</span>
                          </div>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2 border-t border-border/50">
                          <div>
                            <p className="font-medium text-sm">立即执行清理</p>
                            <p className="text-xs text-muted-foreground">手动触发一次过期图片清理</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRunImageCleanup}
                            className="min-h-[44px] w-full sm:w-auto"
                          >
                            <Trash2 size={14} className="mr-1.5" />
                            执行清理
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 flex justify-end">
                        <Button onClick={handleSaveImageCleanup} className="min-h-[44px]">
                          <Save size={16} className="mr-2" />
                          {t.save}
                        </Button>
                      </div>
                    </GlassCard>
                  </div>
                )}
              </div>
              </div>
            </ScrollArea>
          )}

          {/* Admin Plugins Tab */}
          {activeTab === 'admin_plugins' && isAdmin && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
                <AdminPluginsTab />
              </div>
            </ScrollArea>
          )}

          {/* Admin Auth Tab */}
          {activeTab === 'admin_auth' && isAdmin && (
            <AuthSettingsTab t={t} token={token} />
          )}

          {/* Admin Users Tab */}
          {activeTab === 'admin_users' && isAdmin && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-xl md:text-2xl font-semibold">{t.admin_users}</h3>
              
              <div className="space-y-2">
                {usersList.map(u => (
                  <GlassCard key={u.id} className="p-3 md:p-4">
                    <div className="flex items-center justify-between">
                      <button 
                        onClick={() => { setViewingUser(u); setActiveTab('user_usage'); }}
                        className="flex items-center gap-3 md:gap-4 text-left flex-1 min-w-0"
                      >
                        <Avatar className="shrink-0">
                          <AvatarImage src={u.avatar} />
                          <AvatarFallback>{u.username?.[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm truncate">{u.username}</p>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {t.role}: {u.role}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2 mt-2">
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-blue-500 font-medium">输入</p>
                              <p className="text-xs md:text-sm font-bold">{(u.tokens_chat || 0) + (u.tokens_workspace || 0) + (u.tokens_character || 0)}</p>
                            </div>
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-green-500 font-medium">输出</p>
                              <p className="text-xs md:text-sm font-bold">0</p>
                            </div>
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-muted-foreground font-medium">请求</p>
                              <p className="text-xs md:text-sm font-bold">{u.chat_count}次</p>
                            </div>
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-muted-foreground font-medium">存储</p>
                              <p className="text-xs md:text-sm font-bold">{((u.storage_used ?? 0) / 1024 / 1024).toFixed(1)}MB</p>
                            </div>
                          </div>
                        </div>
                      </button>
                      <div className="flex gap-2 ml-2 shrink-0">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="text-destructive hover:bg-destructive/10 min-h-[44px] min-w-[44px]"
                          onClick={(e) => { e.stopPropagation(); handleDeleteUser(u.id); }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
              </div>
            </ScrollArea>
          )}

          {/* Roleplay Engine Tab */}
          {activeTab === 'roleplay_engine' && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
                <h3 className="text-xl md:text-2xl font-semibold">角色扮演引擎</h3>

                <div className="flex gap-2 border-b border-border/50">
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
                        'px-4 py-2 text-sm font-medium transition-colors',
                        roleplayEngineSubTab === sub.id
                          ? 'text-primary border-b-2 border-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>

                {roleplayEngineSubTab === 'theme' && (
                  <div className="space-y-6">
                    <GlassCard className="p-4 md:p-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <Bot size={20} className="text-muted-foreground shrink-0" />
                          <div>
                            <p className="font-medium">角色扮演显示模式</p>
                            <p className="text-xs text-muted-foreground">选择角色扮演对话的显示方式</p>
                          </div>
                        </div>
                        <div className="flex gap-2 w-full sm:w-auto">
                          <Button
                            variant={characterDisplayMode === 'framed' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => handleSaveCharacterDisplayMode('framed')}
                            className="flex-1 sm:flex-none min-h-[44px]"
                          >
                            分框模式
                          </Button>
                          <Button
                            variant={characterDisplayMode === 'frameless' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => handleSaveCharacterDisplayMode('frameless')}
                            className="flex-1 sm:flex-none min-h-[44px]"
                          >
                            无分框模式
                          </Button>
                        </div>
                      </div>
                    </GlassCard>

                    <RoleplayThemeProvider>
                      <RoleplayThemeSettingsPanel />
                    </RoleplayThemeProvider>

                    <GlassCard className="p-4 md:p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Puzzle size={20} className="text-muted-foreground shrink-0" />
                          <div>
                            <p className="font-medium">插件管理</p>
                            <p className="text-xs text-muted-foreground">管理角色扮演引擎插件</p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setActiveTab('admin_plugins')}
                          className="min-h-[44px]"
                        >
                          打开插件管理
                        </Button>
                      </div>
                    </GlassCard>
                  </div>
                )}

                {roleplayEngineSubTab === 'regex' && (
                  <div className="space-y-6">
                    <GlassCard className="p-4 md:p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-lg font-medium">正则脚本</h4>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={handleImportRegex}>
                            <UploadCloud size={16} className="mr-2" />
                            导入
                          </Button>
                          <Button variant="outline" size="sm" onClick={handleExportRegex}>
                            <Download size={16} className="mr-2" />
                            导出
                          </Button>
                        </div>
                      </div>
                      {regexScriptsLoading ? (
                        <div className="text-muted-foreground text-sm">加载中...</div>
                      ) : regexScripts.length === 0 ? (
                        <div className="text-muted-foreground text-sm">暂无正则脚本</div>
                      ) : (
                        <div className="space-y-2">
                          {regexScripts.map((script) => (
                            <div key={`${script.plugin_id}-${script.id}`} className="flex items-center justify-between p-3 rounded-lg border border-border/50">
                              <div className="min-w-0">
                                <p className="font-medium text-sm">{script.name}</p>
                                <p className="text-xs text-muted-foreground truncate">{script.description || script.source || '无描述'}</p>
                              </div>
                              <Switch
                                checked={script.enabled !== false}
                                onCheckedChange={() => handleToggleRegexScript(script.plugin_id, script.id)}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </GlassCard>
                  </div>
                )}

                {roleplayEngineSubTab === 'preset' && (
                  <div className="space-y-6">
                    <GlassCard className="p-4 md:p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-lg font-medium">生成参数预设</h4>
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
                    <SillyTavernSettingsPanel onOpenPlugins={() => setActiveTab('admin_plugins')} />
                  </RoleplayThemeProvider>
                )}
              </div>
            </ScrollArea>
          )}

          {/* Appearance Tab */}
          {activeTab === 'appearance' && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-xl md:text-2xl font-semibold">{t.appearance || '外观与语言'}</h3>
              
              <GlassCard className="p-4 md:p-6">
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      {isDark ? <Moon size={20} className="text-muted-foreground shrink-0" /> : <Sun size={20} className="text-muted-foreground shrink-0" />}
                      <div>
                        <p className="font-medium">{t.theme || '主题'}</p>
                        <p className="text-xs text-muted-foreground">
                          {themeMode === 'auto' ? (t.theme_auto || '跟随系统') : isDark ? (t.dark_mode || '深色模式') : (t.light_mode || '浅色模式')}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {(['auto', 'light', 'dark'] as const).map((mode) => {
                        const Icon = mode === 'auto' ? MonitorSmartphone : mode === 'light' ? Sun : Moon;
                        const label = mode === 'auto' ? (t.theme_auto || '跟随系统') : mode === 'light' ? (t.theme_light || '亮色') : (t.theme_dark || '暗色');
                        const active = themeMode === mode;
                        return (
                          <Button
                            key={mode}
                            variant={active ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => onThemeSet?.(mode)}
                            disabled={!onThemeSet}
                            className="min-h-[44px] flex-1 sm:flex-none"
                          >
                            <Icon size={16} className="mr-1.5" />
                            {label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Sparkles size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">亮色模式自动增强卡片对比度</p>
                        <p className="text-xs text-muted-foreground">自动提升角色卡中难以阅读的文字对比度；暗色模式仍按卡片原始样式显示</p>
                      </div>
                    </div>
                    <Switch
                      checked={autoContrast}
                      onCheckedChange={handleToggleAutoContrast}
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Image size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">角色扮演角色卡头像</p>
                        <p className="text-xs text-muted-foreground">角色扮演对话中显示角色卡头像；关闭后仅显示角色名</p>
                      </div>
                    </div>
                    <Switch
                      checked={showCharacterAvatar}
                      onCheckedChange={handleToggleCharacterAvatar}
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Image size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">智能卡图片走服务器代理</p>
                        <p className="text-xs text-muted-foreground">
                          默认关闭：图片/样式/字体由浏览器直连第三方加载（与 SillyTavern 一致，服务器零媒体
                          流量；第三方可见你的 IP，少数仅 http 或不发 CORS 头的字体源可能失效）。开启：经
                          服务器中转（不暴露 IP、转压 webp、统一缓存）
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={smartCardAssetProxy}
                      onCheckedChange={handleToggleSmartCardAssetProxy}
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Zap size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">模型深度思考</p>
                        <p className="text-xs text-muted-foreground">显示模型的思考过程</p>
                      </div>
                    </div>
                    <Button
                      variant={showModelReasoning ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => handleSaveModelReasoning(!showModelReasoning)}
                      className="min-h-[44px] w-full sm:w-auto"
                    >
                      {showModelReasoning ? '已开启' : '已关闭'}
                    </Button>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Database size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">{t.memory_mode || '记忆模式'}</p>
                        <p className="text-xs text-muted-foreground">{t.memory_mode_desc || '向量记忆提供更好的语义理解和更大的记忆容量'}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button
                        variant={memoryMode === 'rule' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveMemoryMode('rule')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.memory_mode_rule || '规则记忆'}
                      </Button>
                      <Button
                        variant={memoryMode === 'vector' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveMemoryMode('vector')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.memory_mode_vector || '向量记忆'}
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-semibold w-8 text-center shrink-0">{lang?.toUpperCase()}</span>
                      <div>
                        <p className="font-medium">{t.language_setting || '语言设置'}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.language_setting_desc || '同时设置界面语言和AI提示词语言'}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button
                        variant={lang === 'zh' && promptLanguage === 'zh' ? 'default' : 'outline'}
                        size="sm"
                        onClick={async () => {
                          onLangToggle?.();
                          await handleSavePromptLanguage('zh');
                        }}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.lang_zh || '中文'}
                      </Button>
                      <Button
                        variant={lang === 'en' && promptLanguage === 'en' ? 'default' : 'outline'}
                        size="sm"
                        onClick={async () => {
                          if (lang !== 'en') onLangToggle?.();
                          await handleSavePromptLanguage('en');
                        }}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.lang_en || 'English'}
                      </Button>
                    </div>
                  </div>
                </div>
              </GlassCard>
              </div>
            </ScrollArea>
          )}

          {/* Prompts Tab */}
          {activeTab === 'prompts' && (
            <ScrollArea className="h-full">
            <div className={`animate-fade-in pr-2 ${bottomPadding}`}>
             <PromptSettings token={token} />
         </div>
            </ScrollArea>
          )}

          {/* OC Settings Tab */}
          {activeTab === 'oc' && (
            <div className="h-full">
              <OCSettings token={token} models={models} />
            </div>
          )}

          {/* Usage Tab */}
          {activeTab === 'usage' && (
            <ScrollArea className="h-full">
              <div className={`p-4 sm:p-6 ${bottomPadding}`}>
                <TokenUsagePanel token={token} />
              </div>
            </ScrollArea>
          )}

          {/* User Usage Tab */}
          {activeTab === 'user_usage' && viewingUser && (
            <ScrollArea className="h-full">
              <div className={`p-4 sm:p-6 ${bottomPadding}`}>
                <div className="mb-4">
                  <Button
                    variant="ghost"
                    onClick={() => { setActiveTab('admin_users'); setViewingUser(null); }}
                    className="mb-4"
                  >
                    <ChevronDown size={18} className="mr-2 -rotate-90" />
                    返回用户管理
                  </Button>
                </div>
                <TokenUsagePanel 
                  token={token} 
                  userId={viewingUser.id}
                  userName={viewingUser.username}
                  hideCharacterUsage={true}
                />
              </div>
            </ScrollArea>
          )}

          {/* About Tab */}
          {activeTab === 'about' && (
          <AboutTab t={t} />
          )}
            </div>
          </div>
        )}
      </div>


      <ConfirmDialog
        open={modelDeleteConfirm.open}
        onOpenChange={(open) => setModelDeleteConfirm(prev => ({ ...prev, open }))}
        title="删除本地模型"
        description="确定要删除这个模型吗？此操作不可恢复。"
        confirmText="删除"
        onConfirm={() => doModelDelete(modelDeleteConfirm.modelId)}
      />
      <ConfirmDialog
        open={userDeleteConfirm.open}
        onOpenChange={(open) => setUserDeleteConfirm(prev => ({ ...prev, open }))}
        title={t.confirm_delete_user?.split('？')[0] || '删除用户'}
        description={t.confirm_delete_user || '确定要删除该用户吗？此操作不可恢复。'}
        confirmText="删除"
        onConfirm={() => doDeleteUser(userDeleteConfirm.userId)}
      />
      <ConfirmDialog
        open={providerDeleteConfirm.open}
        onOpenChange={(open) => setProviderDeleteConfirm(prev => ({ ...prev, open }))}
        title="删除服务商"
        description="确定要删除此服务商并清除其模型配置吗？此操作不可恢复。"
        confirmText="删除"
        onConfirm={() => doDeleteProvider(providerDeleteConfirm.providerId)}
      />
      <PresetManager
        currentPreset={currentPreset}
        onPresetChange={handlePresetChange}
        open={presetManagerOpen}
        onClose={() => setPresetManagerOpen(false)}
      />
    </div>
  );
};
