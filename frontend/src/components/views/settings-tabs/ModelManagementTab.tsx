import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import {
  ChevronDown,
  Check,
  Cloud,
  Database,
  Edit3,
  Eye,
  FolderOpen,
  Globe,
  Image,
  Key,
  Layers,
  LayoutGrid,
  Link2,
  Plus,
  Plug,
  RefreshCw,
  Route,
  Save,
  Search,
  Server,
  Settings2,
  Sparkles,
  Trash2,
  Unlink,
  UploadCloud,
  ArrowUpDown,
  ShieldCheck,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { api } from '@/services/api';
import { AVAILABLE_ICONS, MODEL_FAMILIES, autoMatchIcon, detectModelFamily } from '@/components/views/settings-constants';
import { MCPTab } from '@/components/views/settings-tabs/MCPTab';
import type { Model, Provider, UnifiedModel, UnifiedModelProvider, RoutingStrategy } from '@/types';

type SubTab = 'providers' | 'local' | 'routing' | 'web_search' | 'mcp';
type LocalSubView = 'language' | 'vision';

interface ModelManagementTabProps {
  t: Record<string, string>;
  isAdmin: boolean;
  providers: Provider[];
  providerStatus: Record<string, { success: boolean | null; message: string; testing: boolean }>;
  handleEditProvider: (provider?: Provider) => void;
  testProviderConnection: (provider: Provider) => void;
  handleDeleteProvider: (providerId: string) => void;
  localModels: any[];
  fetchLocalModels: () => void;
  uploadProgress: number | null;
  handleModelUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleModelEnable: (modelId: string, enabled: boolean) => void;
  handleModelDelete: (modelId: string) => void;
  handleMmprojToggle?: (modelId: string, enabled: boolean) => void;
}

const API_BASE = '/api/models/unified';

export const ModelManagementTab: React.FC<ModelManagementTabProps> = ({
  t,
  isAdmin,
  providers,
  providerStatus,
  handleEditProvider,
  testProviderConnection,
  handleDeleteProvider,
  localModels,
  fetchLocalModels,
  uploadProgress,
  handleModelUpload,
  handleModelEnable,
  handleModelDelete,
  handleMmprojToggle,
}) => {
  const [subTab, setSubTab] = useState<SubTab>('providers');
  const [unifiedModels, setUnifiedModels] = useState<UnifiedModel[]>([]);
  const [strategies, setStrategies] = useState<RoutingStrategy[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    display_name: string;
    icon: string;
    routing_strategy: string;
    failover_enabled: boolean;
    provider_overrides: Record<string, Partial<UnifiedModelProvider>>;
  }>({
    display_name: '',
    icon: '',
    routing_strategy: 'priority',
    failover_enabled: true,
    provider_overrides: {},
  });
  const [iconSearch, setIconSearch] = useState('');
  const [groupingMode, setGroupingMode] = useState<'family' | 'provider'>('family');
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [wsEnabled, setWsEnabled] = useState(false);
  const [wsEngine, setWsEngine] = useState<'searxng' | 'brave' | 'baidu' | 'custom'>('searxng');
  const [wsSearxngUrl, setWsSearxngUrl] = useState('http://localhost:8080');
  const [wsBraveApiKey, setWsBraveApiKey] = useState('');
  const [wsBaiduCookie, setWsBaiduCookie] = useState('');
  const [wsCustomUrl, setWsCustomUrl] = useState('');
  const [wsCustomEngine, setWsCustomEngine] = useState<'searxng' | 'brave'>('searxng');
  const [wsTesting, setWsTesting] = useState(false);
  const [wsTestResult, setWsTestResult] = useState<{success: boolean; message: string} | null>(null);
  const [mmprojFiles, setMmprojFiles] = useState<{filename: string; path: string; size_bytes: number}[]>([]);
  const [mountingMmproj, setMountingMmproj] = useState<string | null>(null);
  const [mountingVision, setMountingVision] = useState<string | null>(null);
  const [localSubView, setLocalSubView] = useState<LocalSubView>('language');
  const [visionDropdownOpen, setVisionDropdownOpen] = useState<string | null>(null);
  const [visionDropdownPos, setVisionDropdownPos] = useState<{ top: number; left: number; width: number; modelId: string }>({ top: 0, left: 0, width: 0, modelId: '' });
  const iconCategories = ['全部', ...Array.from(new Set(AVAILABLE_ICONS.map(i => i.category)))];
  const filteredIcons = AVAILABLE_ICONS.filter(icon => {
    const matchesSearch = icon.name.toLowerCase().includes(iconSearch.toLowerCase());
    const matchesCategory = selectedCategory === '全部' || icon.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getAdaptiveGridCols = (count: number) => {
    if (count <= 0) return 1;
    if (count <= 4) return count;
    if (count <= 6) return 3;
    if (count <= 9) return 3;
    if (count <= 12) return 4;
    if (count <= 16) return 4;
    if (count <= 20) return 5;
    if (count <= 25) return 5;
    if (count <= 30) return 6;
    if (count <= 36) return 6;
    const sqrt = Math.ceil(Math.sqrt(count));
    return Math.min(sqrt + 1, 8);
  };
  const gridCols = getAdaptiveGridCols(filteredIcons.length);

  const getModelSourceGroups = (models: UnifiedModel[], mode: 'family' | 'provider') => {
    const apiModels = models.filter(m => m.providers.some(p => p.provider_type === 'api'));
    const localModels = models.filter(m => m.providers.every(p => p.provider_type === 'local'));

    if (mode === 'family') {
      const familyGroups: Record<string, { name: string; icon: string; models: UnifiedModel[]; order: number }> = {};
      const familyOrder: Record<string, number> = {};
      MODEL_FAMILIES.forEach((f, i) => { familyOrder[f.id] = i; });

      models.forEach(model => {
        const family = detectModelFamily(model.unified_id, model.display_name);
        if (!familyGroups[family.id]) {
          familyGroups[family.id] = { name: family.name, icon: family.icon, models: [], order: familyOrder[family.id] ?? 999 };
        }
        familyGroups[family.id].models.push(model);
      });

      const sortedGroups: Record<string, { name: string; icon: string; models: UnifiedModel[] }> = {};
      Object.entries(familyGroups)
        .sort(([, a], [, b]) => a.order - b.order)
        .forEach(([key, val]) => {
          sortedGroups[key] = { name: val.name, icon: val.icon, models: val.models };
        });

      return { apiModels, localModels, vendorGroups: sortedGroups, groupMode: 'family' as const };
    } else {
      const providerGroups: Record<string, { name: string; icon: string; models: UnifiedModel[] }> = {};
      apiModels.forEach(model => {
        const vendorNames = [...new Set(model.providers.filter(p => p.provider_type === 'api').map(p => p.provider_name))];
        const primaryVendor = vendorNames[0] || '未知厂商';
        if (!providerGroups[primaryVendor]) {
          providerGroups[primaryVendor] = { name: primaryVendor, icon: '', models: [] };
        }
        providerGroups[primaryVendor].models.push(model);
      });
      return { apiModels, localModels, vendorGroups: providerGroups, groupMode: 'provider' as const };
    }
  };

  const fetchUnifiedModels = useCallback(async () => {
    setLoading(true);
    try {
      const [modelsData, strategiesData] = await Promise.all([
        api.get<UnifiedModel[]>(API_BASE),
        api.get<RoutingStrategy[]>(`${API_BASE}/strategies`),
      ]);
      setUnifiedModels(Array.isArray(modelsData) ? modelsData : []);
      setStrategies(Array.isArray(strategiesData) ? strategiesData : []);
    } catch (e) {
      console.error('Failed to fetch unified models:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (subTab === 'routing') {
      fetchUnifiedModels();
    }
  }, [subTab, fetchUnifiedModels]);

  useEffect(() => {
    if (subTab === 'web_search') {
      api.get('/api/admin/web-search').then((data: any) => {
        setWsEnabled(data.enabled ?? false);
        setWsEngine(data.engine ?? 'searxng');
        setWsSearxngUrl(data.searxng_url ?? 'http://localhost:8080');
        setWsBraveApiKey(data.brave_api_key ?? '');
        setWsBaiduCookie(data.baidu_cookie ?? '');
        setWsCustomUrl(data.custom_url ?? '');
        setWsCustomEngine(data.custom_engine ?? 'searxng');
      }).catch((e) => {
        console.error('Failed to load web search config:', e);
      });
    }
  }, [subTab]);

  useEffect(() => {
    if (subTab === 'local' && isAdmin) {
      api.get('/api/admin/models/local/mmproj-files').then((data: any) => {
        setMmprojFiles(data || []);
      }).catch(() => {
        setMmprojFiles([]);
      });
    }
  }, [subTab, isAdmin, localModels]);

  const handleMountMmproj = async (modelId: string, mmprojPath: string | null) => {
    const modelName = modelId.replace('local:', '');
    setMountingMmproj(modelId);
    try {
      await api.put(`/api/admin/models/local/${modelName}/mmproj-path`, {
        mmproj_path: mmprojPath,
        mmproj_enabled: !!mmprojPath,
      });
      fetchLocalModels();
      toast.success(mmprojPath ? '视觉模型已挂载' : '视觉模型已卸载');
    } catch (e: any) {
      toast.error(e?.detail || e?.message || '操作失败');
    } finally {
      setMountingMmproj(null);
    }
  };

  const handleMountVisionSource = async (modelId: string, visionSource: string | null) => {
    const modelName = modelId.replace('local:', '');
    setMountingVision(modelId);
    try {
      await api.put(`/api/admin/models/local/${modelName}/vision-source`, {
        vision_source: visionSource,
      });
      fetchLocalModels();
      toast.success(visionSource ? '视觉模型已挂载为翻译官' : '视觉翻译官已卸载');
    } catch (e: any) {
      toast.error(e?.detail || e?.message || '操作失败');
    } finally {
      setMountingVision(null);
    }
  };

  useEffect(() => {
    const handleIconSync = (e: Event) => {
      const { modelId, icon } = (e as CustomEvent).detail;
      if (!modelId || !icon) return;
      setUnifiedModels(prev => {
        let changed = false;
        const updated = prev.map(m => {
          if (m.unified_id === modelId && m.icon !== icon) {
            changed = true;
            return { ...m, icon };
          }
          return m;
        });
        return changed ? updated : prev;
      });
    };
    window.addEventListener('modelIconChanged', handleIconSync);
    return () => window.removeEventListener('modelIconChanged', handleIconSync);
  }, []);

  const startEditModel = (model: UnifiedModel) => {
    setEditingModel(model.unified_id);
    const overrides: Record<string, Partial<UnifiedModelProvider>> = {};
    for (const p of model.providers) {
      overrides[p.provider_id] = {
        priority: p.priority,
        weight: p.weight,
        enabled: p.enabled,
        max_rpm: p.max_rpm,
        max_concurrent: p.max_concurrent,
        max_tokens_per_min: p.max_tokens_per_min,
      };
    }
    setEditForm({
      display_name: model.display_name,
      icon: model.icon,
      routing_strategy: model.routing_strategy,
      failover_enabled: model.failover_enabled,
      provider_overrides: overrides,
    });
  };

  const saveModelConfig = async (unifiedId: string) => {
    try {
      await api.put(`${API_BASE}/${encodeURIComponent(unifiedId)}`, editForm);
      if (editForm.icon) {
        window.dispatchEvent(new CustomEvent('modelIconChanged', {
          detail: { modelId: unifiedId, icon: editForm.icon }
        }));
      }
      setEditingModel(null);
      fetchUnifiedModels();
    } catch (e) {
      console.error('Failed to save model config:', e);
    }
  };

  const updateProviderOverride = (providerId: string, field: string, value: any) => {
    setEditForm((prev) => ({
      ...prev,
      provider_overrides: {
        ...prev.provider_overrides,
        [providerId]: {
          ...(prev.provider_overrides[providerId] || {}),
          [field]: value,
        },
      },
    }));
  };

  const subTabs: { key: SubTab; label: string; icon: React.ReactNode }[] = [
    { key: 'providers', label: '提供商', icon: <Sparkles size={16} /> },
    { key: 'local', label: '本地模型', icon: <Database size={16} /> },
    { key: 'routing', label: '路由', icon: <Route size={16} /> },
    { key: 'web_search', label: '搜索', icon: <Globe size={16} /> },
    { key: 'mcp', label: 'MCP', icon: <Plug size={16} /> },
  ];

  return (
    <div className="flex flex-col h-full animate-fade-in overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/50 pb-4 shrink-0 overflow-x-auto">
        {subTabs.map((tab) => {
          if (tab.key === 'local' && !isAdmin) return null;
          if (tab.key === 'routing' && !isAdmin) return null;
          return (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              className={
                subTab === tab.key
                  ? 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-primary text-primary-foreground shadow-lg shadow-primary/20 whitespace-nowrap'
                  : 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all text-muted-foreground hover:bg-secondary hover:text-foreground whitespace-nowrap'
              }
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {subTab === 'providers' && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 animate-fade-in pr-2 pt-4 pb-28 w-full max-w-full">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-2xl font-semibold">{t.provider_config || '服务提供商配置'}</h3>
                <Button onClick={() => handleEditProvider()}>
                  <Plus size={16} className="mr-2" />
                  {t.add_provider || '添加提供商'}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {providers.map((provider) => {
                const status = providerStatus[provider.id];
                return (
                  <GlassCard key={provider.id} className="p-4 sm:p-5 hover:shadow-lg transition-all group" hover>
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <div
                            className={`w-2.5 h-2.5 rounded-full ${
                              status?.success === true ? 'bg-green-500' : status?.success === false ? 'bg-red-500' : 'bg-gray-400'
                            } ${status?.testing ? 'animate-pulse' : ''}`}
                            title={status?.message || '未测试'}
                          />
                          <h4 className="font-semibold truncate text-sm sm:text-base">{provider.name}</h4>
                          <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                            {(provider.models || []).length} {t.active_models || '个模型'}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground font-mono truncate mb-2">
                          {(() => {
                            const url = provider.base_url || '';
                            const withoutProtocol = url.replace(/^https?:\/\//, '');
                            const hostPart = withoutProtocol.split('/')[0];
                            return hostPart || url || '未设置';
                          })()}
                        </p>
                        {status && (
                          <p
                            className={`text-xs mb-2 ${
                              status.success === true
                                ? 'text-green-600'
                                : status.success === false
                                  ? 'text-red-600'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            {status.message}
                          </p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          {(provider.models || []).slice(0, 3).map((model: Model, index: number) => (
                            <span key={index} className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">
                              {model.name?.length > 15 ? `${model.name.substring(0, 15)}...` : model.name || '未命名'}
                            </span>
                          ))}
                          {(provider.models || []).length > 3 && (
                            <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">
                              +{(provider.models || []).length - 3}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200 dark:border-gray-700">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => testProviderConnection(provider)}
                          disabled={status?.testing}
                        >
                          {status?.testing ? (
                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-1" />
                          ) : (
                            <RefreshCw size={14} className="mr-1" />
                          )}
                          测试
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => handleEditProvider(provider)}>
                          <Edit3 size={14} className="mr-1" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeleteProvider(provider.id)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          </div>
        </ScrollArea>
      )}

      {subTab === 'local' && isAdmin && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 animate-fade-in pr-2 pt-4 pb-28 w-full max-w-full">
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-2xl font-semibold">{t.local_models || '本地模型'}</h3>
                  <div className="flex bg-muted/50 rounded-lg p-0.5">
                    {(() => {
                      const isMmprojModel = (m: any) =>
                        (m.key && m.key.toLowerCase().includes('mmproj')) ||
                        (m.filename && m.filename.toLowerCase().includes('mmproj')) ||
                        (m.name && m.name.toLowerCase().includes('mmproj'));
                      const langCount = localModels.filter((m: any) => !isMmprojModel(m)).length;
                      const visCount = localModels.filter((m: any) => isMmprojModel(m)).length;
                      return (
                        <>
                          <button
                            onClick={() => setLocalSubView('language')}
                            className={cn(
                              "flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-all",
                              localSubView === 'language'
                                ? "bg-background text-foreground shadow-sm font-medium"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            <Database size={12} />
                            <span>语言模型</span>
                            <span className="text-[10px] opacity-70">({langCount})</span>
                          </button>
                          <button
                            onClick={() => setLocalSubView('vision')}
                            className={cn(
                              "flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-all",
                              localSubView === 'vision'
                                ? "bg-background text-foreground shadow-sm font-medium"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            <Eye size={12} />
                            <span>视觉模型</span>
                            <span className="text-[10px] opacity-70">({visCount})</span>
                          </button>
                        </>
                      );
                    })()}
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button onClick={fetchLocalModels}>
                    <Database size={16} className="mr-2" />
                    {t.refresh_models || '刷新模型列表'}
                  </Button>
                  <Button onClick={() => document.getElementById('model-upload-input')?.click()} disabled={uploadProgress !== null}>
                    <UploadCloud size={16} className="mr-2" />
                    {t.upload_model || '上传模型'}
                  </Button>
                  <input
                    type="file"
                    id="model-upload-input"
                    className="hidden"
                    onChange={handleModelUpload}
                    accept=".gguf"
                  />
                </div>
              </div>

              {uploadProgress !== null && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>上传进度</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2">
                    <div className="bg-primary h-2 rounded-full transition-all duration-300 ease-in-out" style={{ width: `${uploadProgress}%` }} />
                  </div>
                </div>
              )}
            </div>

            <div>
              {(() => {
                const isMmprojModel = (m: any) =>
                  (m.key && m.key.toLowerCase().includes('mmproj')) ||
                  (m.filename && m.filename.toLowerCase().includes('mmproj')) ||
                  (m.name && m.name.toLowerCase().includes('mmproj'));
                const languageModels = localModels.filter((m: any) => !isMmprojModel(m));
                const visionModels = localModels.filter((m: any) => isMmprojModel(m));

                const getMountedByModels = (visionModelId: string) => {
                  return languageModels.filter((m: any) => m.vision_source === visionModelId);
                };

                if (languageModels.length === 0 && visionModels.length === 0) {
                  return (
                    <GlassCard className="p-8 text-center">
                      <Database size={48} className="mx-auto text-muted-foreground mb-4" />
                      <h4 className="font-semibold mb-2">{t.no_local_models || '暂无本地模型'}</h4>
                      <p className="text-sm text-muted-foreground">{t.upload_model_hint || '请点击上方的"上传模型"按钮上传本地模型文件'}</p>
                    </GlassCard>
                  );
                }

                return (
                  <div className="animate-fade-in">
                    {localSubView === 'language' ? (
                      languageModels.length > 0 ? (
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                          {languageModels.map((model: any) => {
                            const hasMmproj = model.mmproj_path || model.has_mmproj;
                            const currentMmprojName = model.mmproj_name;
                            const currentVisionSource = model.vision_source || '';
                            const currentVisionName = currentVisionSource
                              ? (visionModels.find((v: any) => v.id === currentVisionSource)?.name || currentVisionSource.replace('local:', ''))
                              : '';
                            return (
                            <GlassCard
                              key={model.id}
                              className={`p-4 sm:p-5 hover:shadow-lg transition-all group ${!model.enabled ? 'opacity-60' : ''}`}
                              hover
                            >
                              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-2">
                                    <h4 className="font-semibold truncate text-sm sm:text-base">{model.name}</h4>
                                    {model.supports_vision && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-500 shrink-0">
                                        <Eye size={10} />
                                        <span>视觉</span>
                                      </span>
                                    )}
                                    {!model.enabled && (
                                      <span className="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">
                                        已禁用
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground font-mono truncate mb-2">{model.path}</p>
                                  {model.supports_vision && currentMmprojName && !currentVisionSource && (
                                    <p className="text-[11px] text-blue-500 dark:text-blue-400 mb-1.5 flex items-center gap-1">
                                      <Eye size={11} />
                                      <span>挂载视觉模型: {currentMmprojName}</span>
                                    </p>
                                  )}
                                  {currentVisionSource && currentVisionName && (
                                    <p className="text-[11px] text-purple-500 dark:text-purple-400 mb-1.5 flex items-center gap-1">
                                      <Eye size={11} />
                                      <span>视觉模型: {currentVisionName}</span>
                                    </p>
                                  )}
                                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                                    <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">大小: {model.size}GB</span>
                                    <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">类型: {model.type}</span>
                                    {model.key && (
                                      <span className="text-xs bg-muted text-muted-foreground px-2 py-1 rounded-full font-mono truncate max-w-[120px]">{model.key}</span>
                                    )}
                                  </div>
                                  {visionModels.length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="relative">
                                        <button
                                          type="button"
                                          className={cn(
                                            "w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                                            "border border-border bg-secondary/50 hover:bg-secondary",
                                            mountingVision === model.id && "opacity-50 pointer-events-none"
                                          )}
                                          onClick={(e) => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            setVisionDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width, modelId: model.id });
                                            setVisionDropdownOpen(visionDropdownOpen === model.id ? null : model.id);
                                          }}
                                          disabled={mountingVision === model.id}
                                          aria-label="挂载视觉模型"
                                        >
                                          <Eye size={12} className="text-purple-500 shrink-0" />
                                          <span className="flex-1 text-left truncate">
                                            {currentVisionSource ? currentVisionName : '选择视觉模型'}
                                          </span>
                                          <ChevronDown size={12} className="text-muted-foreground shrink-0" />
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center justify-between sm:justify-end gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200 dark:border-gray-700">
                                  <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      <Switch
                                        checked={model.enabled !== false}
                                        onCheckedChange={(checked) => handleModelEnable(model.id, checked)}
                                      />
                                      <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                                        {model.enabled !== false ? '已启用' : '已禁用'}
                                      </span>
                                    </div>
                                    {model.enabled && hasMmproj && !currentVisionSource && (
                                      <div className="flex items-center gap-2 flex-shrink-0">
                                        <Switch
                                          checked={model.mmproj_enabled === true}
                                          onCheckedChange={(checked) => handleMmprojToggle?.(model.id, checked)}
                                        />
                                        <Eye size={14} className="text-muted-foreground" />
                                        <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                                          {model.mmproj_enabled ? '视觉已启用' : '视觉编码器'}
                                        </span>
                                      </div>
                                    )}
                                  </div>

                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:bg-destructive/10 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0"
                                    onClick={() => handleModelDelete(model.id)}
                                    title="删除模型"
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                </div>
                              </div>
                            </GlassCard>
                          );
                          })}
                        </div>
                      ) : (
                        <GlassCard className="p-6 text-center">
                          <Database size={32} className="mx-auto text-muted-foreground mb-2" />
                          <p className="text-sm text-muted-foreground">暂无语言模型</p>
                        </GlassCard>
                      )
                    ) : (
                      visionModels.length > 0 ? (
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                          {visionModels.map((model: any) => {
                            const mountedByModels = getMountedByModels(model.id);
                            return (
                            <GlassCard
                              key={model.id}
                              className={`p-4 sm:p-5 hover:shadow-lg transition-all group ${!model.enabled ? 'opacity-60' : ''}`}
                              hover
                            >
                              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-2">
                                    <h4 className="font-semibold truncate text-sm sm:text-base">{model.name}</h4>
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/15 text-purple-500 shrink-0">
                                      <Eye size={10} />
                                      <span>mmproj</span>
                                    </span>
                                    {!model.enabled && (
                                      <span className="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">
                                        已禁用
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground font-mono truncate mb-2">{model.path}</p>
                                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                                    <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">大小: {model.size}GB</span>
                                    <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">类型: {model.type}</span>
                                    {model.key && (
                                      <span className="text-xs bg-muted text-muted-foreground px-2 py-1 rounded-full font-mono truncate max-w-[120px]">{model.key}</span>
                                    )}
                                  </div>
                                  {mountedByModels.length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="flex items-center gap-1.5 mb-1">
                                        <Link2 size={11} className="text-purple-500 shrink-0" />
                                        <span className="text-[11px] text-purple-500 dark:text-purple-400 font-medium">
                                          已作为翻译官挂载到 {mountedByModels.length} 个语言模型
                                        </span>
                                      </div>
                                      <div className="flex flex-wrap gap-1">
                                        {mountedByModels.map((m: any) => (
                                          <span key={m.id} className="text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded-full">
                                            {m.name}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {mountedByModels.length === 0 && languageModels.length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <Link2 size={10} />
                                        <span>尚未挂载到任何语言模型</span>
                                      </p>
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200 dark:border-gray-700">
                                  <Switch
                                    checked={model.enabled !== false}
                                    onCheckedChange={(checked) => handleModelEnable(model.id, checked)}
                                  />
                                  <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                                    {model.enabled !== false ? '已启用' : '已禁用'}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:bg-destructive/10 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0"
                                    onClick={() => handleModelDelete(model.id)}
                                    title="删除模型"
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                </div>
                              </div>
                            </GlassCard>
                          );
                          })}
                        </div>
                      ) : (
                        <GlassCard className="p-6 text-center">
                          <Eye size={32} className="mx-auto text-muted-foreground mb-2" />
                          <p className="text-sm text-muted-foreground">暂无视觉模型</p>
                          <p className="text-[10px] text-muted-foreground mt-1">上传含 mmproj 的 .gguf 文件即可</p>
                        </GlassCard>
                      )
                    )}
                  </div>
                );
              })()}
            </div>
            {visionDropdownOpen && visionDropdownPos.modelId && (() => {
              const isMmprojModel = (m: any) =>
                (m.key && m.key.toLowerCase().includes('mmproj')) ||
                (m.filename && m.filename.toLowerCase().includes('mmproj')) ||
                (m.name && m.name.toLowerCase().includes('mmproj'));
              const visionModels = localModels.filter((m: any) => isMmprojModel(m));
              const currentModel = localModels.find((m: any) => m.id === visionDropdownPos.modelId);
              const currentVisionSource = currentModel?.vision_source || '';
              return createPortal(
                <>
                  <div className="fixed inset-0 z-[9998]" onClick={() => setVisionDropdownOpen(null)} />
                  <div
                    className="fixed z-[9999] glass-strong rounded-xl shadow-xl border border-border overflow-hidden animate-fade-in-up"
                    style={{
                      top: visionDropdownPos.top,
                      left: visionDropdownPos.left,
                      width: Math.max(visionDropdownPos.width, 200),
                    }}
                  >
                    <div className="p-1">
                      <button
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all",
                          !currentVisionSource ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-muted"
                        )}
                        onClick={() => {
                          handleMountVisionSource(visionDropdownPos.modelId, null);
                          setVisionDropdownOpen(null);
                        }}
                      >
                        <Eye size={14} className="text-muted-foreground shrink-0" />
                        <span className="flex-1 text-left">不挂载视觉模型</span>
                        {!currentVisionSource && <Check size={12} className="text-primary shrink-0" />}
                      </button>
                      {visionModels.map((v: any) => (
                        <button
                          key={v.id}
                          className={cn(
                            "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all",
                            currentVisionSource === v.id ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-muted"
                          )}
                          onClick={() => {
                            handleMountVisionSource(visionDropdownPos.modelId, v.id);
                            setVisionDropdownOpen(null);
                          }}
                        >
                          <Eye size={14} className="text-purple-500 shrink-0" />
                          <div className="flex-1 text-left min-w-0">
                            <div className="truncate">{v.name}</div>
                            <div className="text-[10px] text-muted-foreground">{v.size}GB</div>
                          </div>
                          {currentVisionSource === v.id && <Check size={12} className="text-primary shrink-0" />}
                        </button>
                      ))}
                    </div>
                  </div>
                </>,
                document.body
              );
            })()}
          </div>
        </ScrollArea>
      )}

      {subTab === 'routing' && isAdmin && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 animate-fade-in pr-2 pt-4 pb-28 w-full max-w-full">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <div className="min-w-0">
                <h3 className="text-2xl font-semibold">路由策略</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  管理同型号模型的多提供商路由策略、优先级和故障转移设置
                </p>
              </div>
              <Button onClick={fetchUnifiedModels} disabled={loading} className="shrink-0">
                <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>

            {loading && unifiedModels.length === 0 ? (
              <GlassCard className="p-8 text-center">
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="text-sm text-muted-foreground">加载模型数据...</p>
              </GlassCard>
            ) : unifiedModels.length === 0 ? (
              <GlassCard className="p-8 text-center">
                <Layers size={48} className="mx-auto text-muted-foreground mb-4" />
                <h4 className="font-semibold mb-2">暂无统一模型数据</h4>
                <p className="text-sm text-muted-foreground">请先在"服务提供商"中配置 API 模型或上传本地模型</p>
              </GlassCard>
            ) : (
              (() => {
                const filteredModels = unifiedModels.filter((m) => m.providers.length > 0);
                const { apiModels, localModels, vendorGroups, groupMode } = getModelSourceGroups(filteredModels, groupingMode);

                const renderModelCard = (model: UnifiedModel) => {
                  const isExpanded = expandedModel === model.unified_id;
                  const isEditing = editingModel === model.unified_id;
                  const multiProvider = model.providers.length > 1;
                  const hasApi = model.providers.some(p => p.provider_type === 'api');
                  const hasLocal = model.providers.some(p => p.provider_type === 'local');

                  return (
                    <GlassCard key={model.unified_id} className="overflow-x-hidden" hover={false}>
                      <div
                        className="p-3 sm:p-4 flex items-center gap-2 sm:gap-3 cursor-pointer hover:bg-muted/30 transition-colors"
                        onClick={() => setExpandedModel(isExpanded ? null : model.unified_id)}
                      >
                        <span className="text-lg sm:text-xl shrink-0">
                          {model.icon?.startsWith('/') || model.icon?.startsWith('http') ? (
                            <img src={model.icon} alt="" className="w-5 h-5 sm:w-6 sm:h-6 object-contain" />
                          ) : (
                            model.icon || '🤖'
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                            <span className="font-semibold text-sm break-words">{model.display_name}</span>
                            {hasApi && hasLocal && (
                              <span className="text-[10px] bg-purple-500/15 text-purple-500 dark:text-purple-400 px-1.5 py-0.5 rounded-full shrink-0">
                                混合
                              </span>
                            )}
                            {hasApi && !hasLocal && (
                              <span className="text-[10px] bg-sky-500/15 text-sky-500 dark:text-sky-400 px-1.5 py-0.5 rounded-full shrink-0">
                                云端
                              </span>
                            )}
                            {hasLocal && !hasApi && (
                              <span className="text-[10px] bg-amber-500/15 text-amber-500 dark:text-amber-400 px-1.5 py-0.5 rounded-full shrink-0">
                                本地
                              </span>
                            )}
                            {multiProvider && (
                              <span className="text-[10px] bg-blue-500/15 text-blue-500 dark:text-blue-400 px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shrink-0">
                                <Layers size={10} />
                                {model.providers.length}个提供商
                              </span>
                            )}
                            {model.failover_enabled && multiProvider && (
                              <span className="text-[10px] bg-green-500/15 text-green-500 dark:text-green-400 px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shrink-0">
                                <ShieldCheck size={10} />
                                故障转移
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 sm:gap-2 flex-wrap">
                            <span className="flex items-center gap-0.5 shrink-0">
                              <Route size={10} />
                              {strategies.find((s) => s.id === model.routing_strategy)?.name || model.routing_strategy}
                            </span>
                            <span className="shrink-0">•</span>
                            <span className="shrink-0">{model.providers.filter((p) => p.enabled).length}/{model.providers.length} 可用</span>
                          </div>
                        </div>
                        <ChevronDown
                          size={16}
                          className={`text-muted-foreground transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                        />
                      </div>

                      {isExpanded && (
                        <div className="border-t border-border/50 p-3 sm:p-4 space-y-4 animate-fade-in overflow-x-hidden">
                          {isEditing ? (
                            <>
                              <div className="space-y-3">
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground mb-1 block">显示名称</label>
                                  <input
                                    type="text"
                                    value={editForm.display_name}
                                    onChange={(e) => setEditForm((prev) => ({ ...prev, display_name: e.target.value }))}
                                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                                  />
                                </div>
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">模型图标</label>
                                <div className="flex items-start gap-4">
                                  <div className="relative">
                                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center overflow-hidden border-2 border-border/50 bg-gradient-to-br from-background to-background/50">
                                      {editForm.icon?.startsWith('/') || editForm.icon?.startsWith('http') || editForm.icon?.startsWith('data:') ? (
                                        <img src={editForm.icon} alt="" className="w-full h-full object-cover" />
                                      ) : (
                                        <span className="text-3xl">{editForm.icon || '🤖'}</span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex-1 space-y-3">
                                    <div className="flex flex-wrap gap-2">
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => {
                                          const matchedIcon = autoMatchIcon(editingModel || '', editForm.display_name);
                                          if (matchedIcon) {
                                            setEditForm((prev) => ({ ...prev, icon: matchedIcon }));
                                          }
                                        }}
                                        className="h-9"
                                      >
                                        <Sparkles size={14} className="mr-1.5" />
                                        自动匹配
                                      </Button>
                                      <label className="cursor-pointer">
                                        <input
                                          type="file"
                                          accept="image/*"
                                          className="hidden"
                                          onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (!file) return;
                                            if (!file.type.startsWith('image/')) return;
                                            if (file.size > 2 * 1024 * 1024) return;
                                            const reader = new FileReader();
                                            reader.onload = (event) => {
                                              const dataUrl = event.target?.result as string;
                                              setEditForm((prev) => ({ ...prev, icon: dataUrl }));
                                            };
                                            reader.readAsDataURL(file);
                                          }}
                                        />
                                        <Button size="sm" variant="secondary" asChild className="h-9">
                                          <span><Image size={14} className="mr-1.5" /> 上传</span>
                                        </Button>
                                      </label>
                                    </div>
                                    <div className="bg-muted/30 rounded-xl p-3 space-y-3">
                                      <div className="flex gap-2">
                                        <div className="relative flex-1">
                                          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                          <Input
                                            placeholder="搜索图标..."
                                            value={iconSearch}
                                            onChange={(e) => setIconSearch(e.target.value)}
                                            className="pl-9 h-8 text-sm bg-background"
                                          />
                                        </div>
                                        <select
                                          value={selectedCategory}
                                          onChange={(e) => setSelectedCategory(e.target.value)}
                                          className="h-8 px-3 rounded-lg bg-background border border-input text-sm"
                                        >
                                          {iconCategories.map(c => <option key={c} value={c}>{c}</option>)}
                                        </select>
                                      </div>
                                      <div
                                        className="grid gap-2 overflow-y-auto p-1"
                                        style={{
                                          gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                                        }}
                                      >
                                        {filteredIcons.map((icon) => (
                                          <button
                                            key={icon.name}
                                            onClick={() => setEditForm((prev) => ({ ...prev, icon: icon.path }))}
                                            className={cn(
                                              "aspect-square rounded-xl bg-background border-2 flex items-center justify-center transition-all duration-200 hover:scale-105 hover:shadow-md",
                                              editForm.icon === icon.path
                                                ? "border-primary ring-2 ring-primary/20 scale-105"
                                                : "border-transparent hover:border-border"
                                            )}
                                            title={icon.name}
                                          >
                                            <img src={icon.path} alt={icon.name} className="w-6 h-6 sm:w-7 sm:h-7 object-contain" />
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">路由策略</label>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                  {strategies.map((s) => (
                                    <button
                                      key={s.id}
                                      onClick={() => setEditForm((prev) => ({ ...prev, routing_strategy: s.id }))}
                                      className={`p-2.5 sm:p-3 rounded-lg border text-left transition-all ${
                                        editForm.routing_strategy === s.id
                                          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                                          : 'border-border hover:border-primary/30'
                                      }`}
                                    >
                                      <div className="font-medium text-sm">{s.name}</div>
                                      <div className="text-[10px] text-muted-foreground mt-0.5">{s.description}</div>
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {multiProvider && (
                                <div>
                                  <div className="flex items-center gap-2">
                                    <Switch
                                      checked={editForm.failover_enabled}
                                      onCheckedChange={(checked) => setEditForm((prev) => ({ ...prev, failover_enabled: checked }))}
                                    />
                                    <span className="text-sm">启用故障转移</span>
                                  </div>
                                </div>
                              )}

                              <div>
                                <div className="flex items-center gap-2 mb-2">
                                  <Settings2 size={14} className="text-muted-foreground" />
                                  <span className="text-xs font-medium text-muted-foreground">提供商配置</span>
                                </div>
                                <div className="space-y-2">
                                  {model.providers.map((provider, idx) => {
                                    const po = editForm.provider_overrides[provider.provider_id] || {};
                                    return (
                                      <div
                                        key={provider.provider_id}
                                        className={`p-2.5 sm:p-3 rounded-lg border border-border/50 overflow-x-hidden ${
                                          !po.enabled && po.enabled !== undefined ? 'opacity-50' : ''
                                        }`}
                                      >
                                        <div className="flex items-center gap-1.5 sm:gap-2 mb-2 flex-wrap">
                                          <ArrowUpDown size={12} className="text-muted-foreground shrink-0" />
                                          <span className="text-sm font-medium break-words">{provider.provider_name}</span>
                                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                                            provider.provider_type === 'local'
                                              ? 'bg-amber-500/15 text-amber-500 dark:text-amber-400'
                                              : 'bg-sky-500/15 text-sky-500 dark:text-sky-400'
                                          }`}>
                                            {provider.provider_type === 'local' ? '本地' : '云端 API'}
                                          </span>
                                          {idx === 0 && po.enabled !== false && (
                                            <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full shrink-0">
                                              首选
                                            </span>
                                          )}
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                          <div>
                                            <label className="text-[10px] text-muted-foreground block">优先级</label>
                                            <input
                                              type="number"
                                              value={po.priority ?? provider.priority ?? 0}
                                              onChange={(e) =>
                                                updateProviderOverride(provider.provider_id, 'priority', parseInt(e.target.value) || 0)
                                              }
                                              className="w-full px-2 py-1 rounded border border-border bg-background text-xs"
                                              min={0}
                                              max={100}
                                            />
                                          </div>
                                          <div>
                                            <label className="text-[10px] text-muted-foreground block">权重</label>
                                            <input
                                              type="number"
                                              value={po.weight ?? provider.weight ?? 1}
                                              onChange={(e) =>
                                                updateProviderOverride(provider.provider_id, 'weight', parseInt(e.target.value) || 1)
                                              }
                                              className="w-full px-2 py-1 rounded border border-border bg-background text-xs"
                                              min={1}
                                              max={100}
                                            />
                                          </div>
                                          <div>
                                            <label className="text-[10px] text-muted-foreground block">RPM限制</label>
                                            <input
                                              type="number"
                                              value={po.max_rpm ?? provider.max_rpm ?? 0}
                                              onChange={(e) =>
                                                updateProviderOverride(provider.provider_id, 'max_rpm', parseInt(e.target.value) || 0)
                                              }
                                              className="w-full px-2 py-1 rounded border border-border bg-background text-xs"
                                              min={0}
                                              placeholder="0=不限"
                                            />
                                          </div>
                                          <div>
                                            <label className="text-[10px] text-muted-foreground block">并发限制</label>
                                            <input
                                              type="number"
                                              value={po.max_concurrent ?? provider.max_concurrent ?? 0}
                                              onChange={(e) =>
                                                updateProviderOverride(provider.provider_id, 'max_concurrent', parseInt(e.target.value) || 0)
                                              }
                                              className="w-full px-2 py-1 rounded border border-border bg-background text-xs"
                                              min={0}
                                              placeholder="0=不限"
                                            />
                                          </div>
                                        </div>
                                        <div className="mt-2">
                                          <div className="flex items-center gap-2">
                                            <Switch
                                              checked={po.enabled ?? provider.enabled ?? true}
                                              onCheckedChange={(checked) =>
                                                updateProviderOverride(provider.provider_id, 'enabled', checked)
                                              }
                                            />
                                            <span className="text-xs text-muted-foreground">
                                              {(po.enabled ?? provider.enabled ?? true) ? '已启用' : '已禁用'}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>

                              <div className="flex justify-end gap-2 pt-2 border-t border-border/50">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditingModel(null)}
                                >
                                  取消
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => saveModelConfig(model.unified_id)}
                                >
                                  保存配置
                                </Button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-xs text-muted-foreground mb-3">
                                {model.description || '无描述'}
                              </div>
                              <div className="space-y-2">
                                {model.providers.map((provider, idx) => (
                                  <div
                                    key={provider.provider_id}
                                    className={`flex items-center gap-2 sm:gap-3 p-2 sm:p-2.5 rounded-lg overflow-x-hidden ${
                                      provider.enabled ? 'bg-muted/30' : 'bg-muted/10 opacity-50'
                                    }`}
                                  >
                                    <div className="flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-primary/10 text-primary text-[10px] sm:text-xs font-bold shrink-0">
                                      {idx + 1}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                                        <span className="text-sm font-medium break-words">{provider.provider_name}</span>
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                                          provider.provider_type === 'local'
                                            ? 'bg-amber-500/15 text-amber-500 dark:text-amber-400'
                                            : 'bg-sky-500/15 text-sky-500 dark:text-sky-400'
                                        }`}>
                                          {provider.provider_type === 'local' ? '本地' : '云端 API'}
                                        </span>
                                        {!provider.enabled && (
                                          <span className="text-[10px] bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded-full shrink-0">
                                            已禁用
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5 sm:gap-2 flex-wrap">
                                        <span className="shrink-0">优先级: {provider.priority}</span>
                                        <span className="shrink-0">•</span>
                                        <span className="shrink-0">权重: {provider.weight}</span>
                                        {provider.provider_type === 'api' && (
                                          <>
                                            <span className="shrink-0">•</span>
                                            <span className="break-all min-w-0">{provider.base_url}</span>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <div className="flex justify-end pt-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startEditModel(model);
                                  }}
                                >
                                  <Settings2 size={14} className="mr-1" />
                                  配置路由
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </GlassCard>
                  );
                };

                return (
                  <div className="space-y-4 max-w-full overflow-x-hidden">
                    <div className="flex items-center gap-2 px-1">
                      <LayoutGrid size={14} className="text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground shrink-0">分组方式</span>
                      <div className="flex bg-muted/50 rounded-lg p-0.5">
                        <button
                          onClick={() => setGroupingMode('family')}
                          className={cn(
                            "px-3 py-1 text-xs rounded-md transition-all",
                            groupingMode === 'family'
                              ? "bg-background text-foreground shadow-sm font-medium"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          按模型派别
                        </button>
                        <button
                          onClick={() => setGroupingMode('provider')}
                          className={cn(
                            "px-3 py-1 text-xs rounded-md transition-all",
                            groupingMode === 'provider'
                              ? "bg-background text-foreground shadow-sm font-medium"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          按提供商
                        </button>
                      </div>
                    </div>

                    {groupMode === 'family' ? (
                      <>
                        {Object.entries(vendorGroups).map(([familyId, group]) => (
                          <div key={familyId} className="space-y-2">
                            <div className="flex items-center gap-2 px-1">
                              {group.icon ? (
                                <img src={group.icon} alt="" className="w-4 h-4 object-contain shrink-0" />
                              ) : (
                                <FolderOpen size={14} className="text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm font-semibold text-foreground">{group.name}</span>
                              <span className="text-xs text-muted-foreground">({group.models.length})</span>
                            </div>
                            <div className="space-y-2 pl-1">
                              {group.models.map(renderModelCard)}
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <>
                        {apiModels.length > 0 && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 px-1">
                              <Cloud size={16} className="text-sky-500 shrink-0" />
                              <span className="text-sm font-semibold text-foreground">云端 API 模型</span>
                              <span className="text-xs text-muted-foreground">({apiModels.length})</span>
                            </div>
                            {Object.entries(vendorGroups).map(([vendorId, group]) => (
                              <div key={vendorId} className="space-y-2">
                                <div className="flex items-center gap-2 px-2">
                                  <FolderOpen size={13} className="text-muted-foreground shrink-0" />
                                  <span className="text-xs font-medium text-muted-foreground">{group.name}</span>
                                  <span className="text-[10px] text-muted-foreground/60">({group.models.length})</span>
                                </div>
                                <div className="space-y-2 pl-1">
                                  {group.models.map(renderModelCard)}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {localModels.length > 0 && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 px-1">
                              <Server size={16} className="text-amber-500 shrink-0" />
                              <span className="text-sm font-semibold text-foreground">本地模型</span>
                              <span className="text-xs text-muted-foreground">({localModels.length})</span>
                            </div>
                            <div className="space-y-2 pl-1">
                              {localModels.map(renderModelCard)}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        </ScrollArea>
      )}
      {subTab === 'web_search' && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 animate-fade-in pr-2 pt-4 pb-28 w-full max-w-full">
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="min-w-0">
                  <h3 className="text-2xl font-semibold">网络搜索</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    配置对话中的网络搜索功能，支持多种搜索引擎
                  </p>
                </div>
              </div>
            </div>

            <GlassCard className="p-5 sm:p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">启用网络搜索</p>
                  <p className="text-xs text-muted-foreground mt-0.5">开启后聊天输入框将显示搜索按钮</p>
                </div>
                <Switch
                  checked={wsEnabled}
                  onCheckedChange={setWsEnabled}
                />
              </div>

              {wsEnabled && (
                <>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 block">搜索引擎</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {([
                        { key: 'searxng' as const, label: 'SearXNG', desc: '自托管' },
                        { key: 'brave' as const, label: 'Brave', desc: 'Search API' },
                        { key: 'baidu' as const, label: '百度', desc: 'AI搜索/网页' },
                        { key: 'custom' as const, label: '自定义', desc: '自定义域名' },
                      ]).map(engine => (
                        <button
                          key={engine.key}
                          onClick={() => setWsEngine(engine.key)}
                          className={cn(
                            "px-4 py-3 rounded-xl text-sm font-medium transition-all border text-left",
                            wsEngine === engine.key
                              ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                              : "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary/80"
                          )}
                        >
                          <div className="font-medium">{engine.label}</div>
                          <div className={cn("text-[10px] mt-0.5", wsEngine === engine.key ? "text-primary-foreground/70" : "text-muted-foreground")}>{engine.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {wsEngine === 'searxng' && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">SearXNG 实例地址</label>
                      <Input placeholder="http://localhost:8080" value={wsSearxngUrl} onChange={e => setWsSearxngUrl(e.target.value)} />
                      <p className="text-[10px] text-muted-foreground">填写自托管的 SearXNG 实例 URL</p>
                    </div>
                  )}

                  {wsEngine === 'brave' && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Brave Search API Key</label>
                      <div className="relative">
                        <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input placeholder="BSA..." value={wsBraveApiKey} onChange={e => setWsBraveApiKey(e.target.value)} className="pl-9" type="password" />
                      </div>
                      <p className="text-[10px] text-muted-foreground">从 <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">brave.com/search/api</a> 获取 API Key</p>
                    </div>
                  )}

                  {wsEngine === 'baidu' && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">百度 API Key / Cookie</label>
                      <div className="relative">
                        <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input placeholder="bce-v3/ALTAK-... 或 BAIDUID=..." value={wsBaiduCookie} onChange={e => setWsBaiduCookie(e.target.value)} className="pl-9" type="password" />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        支持两种方式：① 百度千帆 AI 搜索 API Key（以 bce-v3/ 开头，推荐）② 浏览器 Cookie（BAIDUID=...）
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        千帆 API Key 从 <a href="https://console.bce.baidu.com/qianfan/appbuilder/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">百度千帆 AppBuilder</a> 获取
                      </p>
                    </div>
                  )}

                  {wsEngine === 'custom' && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">自定义搜索服务地址</label>
                        <Input placeholder="https://your-searxng.example.com" value={wsCustomUrl} onChange={e => setWsCustomUrl(e.target.value)} />
                        <p className="text-[10px] text-muted-foreground">填写自定义 SearXNG 或兼容服务的 URL</p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">搜索引擎类型</label>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setWsCustomEngine('searxng')}
                            className={cn(
                              "flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all border",
                              wsCustomEngine === 'searxng'
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary/80"
                            )}
                          >
                            SearXNG 兼容
                          </button>
                          <button
                            onClick={() => setWsCustomEngine('brave')}
                            className={cn(
                              "flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all border",
                              wsCustomEngine === 'brave'
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary/80"
                            )}
                          >
                            Brave API 兼容
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="flex justify-between items-center pt-2 border-t border-border/50">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setWsTesting(true);
                    setWsTestResult(null);
                    try {
                      const result = await api.post('/api/admin/web-search/test');
                      if (result.success) {
                        const msg = result.message || '配置验证通过';
                        const note = result.zero_cost ? ' (零消耗)' : '';
                        setWsTestResult({
                          success: true,
                          message: `${msg}${note}`
                        });
                      } else {
                        setWsTestResult({
                          success: false,
                          message: result.error || result.message || '验证失败'
                        });
                      }
                    } catch (e) {
                      setWsTestResult({
                        success: false,
                        message: e instanceof Error ? e.message : '测试请求失败'
                      });
                    } finally {
                      setWsTesting(false);
                    }
                  }}
                  disabled={wsTesting}
                >
                  <RefreshCw size={14} className={cn("mr-1.5", wsTesting && "animate-spin")} />
                  {wsTesting ? '验证中...' : '验证配置'}
                </Button>

                <div className="flex gap-2">
                  {wsTestResult && (
                    <div className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
                      wsTestResult.success
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800"
                        : "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800"
                    )}>
                      {wsTestResult.success ? (
                        <>
                          <ShieldCheck size={12} />
                          <span>{wsTestResult.message}</span>
                        </>
                      ) : (
                        <>
                          <span>⚠️</span>
                          <span>{wsTestResult.message}</span>
                        </>
                      )}
                    </div>
                  )}

                  <Button onClick={async () => {
                    try {
                      await api.post('/api/admin/web-search', {
                        enabled: wsEnabled,
                        engine: wsEngine,
                        searxng_url: wsSearxngUrl,
                        brave_api_key: wsBraveApiKey,
                        baidu_cookie: wsBaiduCookie,
                        custom_url: wsCustomUrl,
                        custom_engine: wsCustomEngine,
                      });
                      toast.success('网络搜索配置已保存');
                      setWsTestResult(null);
                    } catch (e) {
                      console.error('Failed to save web search config:', e);
                      toast.error('保存失败，请检查配置');
                    }
                  }}>
                    <Save size={16} className="mr-2" />
                    保存配置
                  </Button>
                </div>
              </div>
            </GlassCard>
          </div>
        </ScrollArea>
      )}
      {subTab === 'mcp' && <MCPTab t={t} />}

    </div>
  );
};
