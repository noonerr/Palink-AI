import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  User,
  Key,
  ChevronDown,
  ChevronLeft,
  Save,
  Bot,
  Sparkles
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { ModelEditor } from './ModelEditor';
import { PRESETS } from './settings-constants';
import { api } from '@/services/api';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import type { Model, Provider } from '@/types';

interface ProviderEditPageProps {
  token: string;
  providers: Provider[];
  onProvidersUpdate: () => void;
  t: Record<string, string>;
}

export function ProviderEditPage({
  token,
  providers,
  onProvidersUpdate,
  t
}: ProviderEditPageProps) {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const bottomPadding = useMobileBottomPadding();

  const [pName, setPName] = useState('');
  const [pUrl, setPUrl] = useState('');
  const [pKey, setPKey] = useState('');
  const [pModels, setPModels] = useState<Model[]>([]);
  const [configExpanded, setConfigExpanded] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (providerId && providerId !== 'new') {
      const provider = providers.find(p => p.id === providerId);
      if (provider) {
        const normalizedModels = (provider.models || []).map(model => {
          const normalizedModel: any = { ...model };
          if (!normalizedModel.name && normalizedModel.alias) {
            normalizedModel.name = normalizedModel.alias;
          }
          if (!normalizedModel.alias && normalizedModel.name) {
            normalizedModel.alias = normalizedModel.name;
          }
          if (!normalizedModel.name && !normalizedModel.alias) {
            normalizedModel.name = normalizedModel.id || '';
            normalizedModel.alias = normalizedModel.id || '';
          }
          return normalizedModel;
        });

        setPName(provider.name);
        setPUrl(provider.base_url);
        setPKey(provider.api_key);
        setPModels(normalizedModels);
      }
    } else {
      setPName('');
      setPUrl('');
      setPKey('');
      setPModels([]);
    }
    setLoading(false);
  }, [providerId, providers]);

  const applyPreset = (preset: typeof PRESETS[0]) => {
    setPName(preset.name);
    if (preset.url) {
      setPUrl(preset.url);
    }
    setPModels(preset.models.map(m => ({
      id: m,
      name: m,
      provider: preset.name,
      context_length: 4096,
      icon: '🤖'
    })));
  };

  const ensureUrlHasProtocol = (url: string): string => {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return 'https://' + url;
  };

  const handleSaveProvider = async () => {
    if (!pName.trim()) {
      toast.error('请输入服务商名称');
      return;
    }
    if (!pUrl.trim()) {
      toast.error('请输入API地址');
      return;
    }

    const modelsToSave = pModels.map(model => {
      const saveModel: any = {
        ...model,
        id: model.id || '',
        name: model.name || model.alias || model.id || '',
        alias: model.alias || model.name || model.id || ''
      };
      return saveModel;
    });

    const newProvider: Provider = {
      id: providerId && providerId !== 'new' ? providerId : `prov-${Date.now()}`,
      name: pName,
      base_url: ensureUrlHasProtocol(pUrl),
      api_key: pKey,
      models: modelsToSave,
      is_active: true
    };

    const newList = providerId && providerId !== 'new'
      ? providers.map(p => p.id === providerId ? newProvider : p)
      : [...providers, newProvider];

    try {
      toast.loading('保存中...', { id: 'save-provider' });
      await api.post('/api/admin/providers', newList);
      onProvidersUpdate();
      window.dispatchEvent(new CustomEvent('modelsUpdated'));
      modelsToSave.forEach(m => {
        if (m.id && m.icon) {
          window.dispatchEvent(new CustomEvent('modelIconChanged', {
            detail: { modelId: m.id, icon: m.icon }
          }));
        }
      });
      toast.success(providerId && providerId !== 'new' ? '服务商已更新' : '服务商已添加', { id: 'save-provider' });
      navigate('/settings', { state: { activeTab: 'models' }, replace: true });
    } catch (e) {
      console.error('保存出错:', e);
      toast.error(`保存失败: ${e instanceof Error ? e.message : '未知错误'}`, { id: 'save-provider' });
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin text-primary">
          <ChevronDown size={32} className="rotate-45" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 w-full p-4 md:p-8 h-full overflow-hidden overflow-x-hidden">
      <div className="max-w-4xl mx-auto h-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 shrink-0 pb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/settings', { state: { activeTab: 'models' } })}
            className="flex items-center gap-1"
          >
            <ChevronLeft size={16} />
            {t.back || '返回'}
          </Button>
          <div className="h-5 w-px bg-border" />
          <h3 className="text-2xl font-semibold">
            {providerId && providerId !== 'new' ? (t.edit_provider || '编辑服务商') : (t.add_provider_title || '添加服务商')}
          </h3>
        </div>

        {/* Scrollable Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className={`space-y-6 animate-fade-in pr-2 overflow-x-hidden max-w-full ${bottomPadding}`}>

            {/* Presets */}
            {!(providerId && providerId !== 'new') && (
              <GlassCard className="p-5 overflow-hidden">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles size={18} className="text-primary" />
                  <h4 className="font-semibold text-foreground">快速预设</h4>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 w-full">
                  {PRESETS.map(preset => (
                    <button
                      key={preset.name}
                      onClick={() => applyPreset(preset)}
                      className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-br from-secondary/80 to-secondary hover:from-secondary hover:to-secondary/80 text-sm font-medium transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] border border-border/30 overflow-hidden"
                    >
                      <span className="text-lg shrink-0">{preset.icon}</span>
                      <span className="truncate min-w-0">{preset.name}</span>
                    </button>
                  ))}
                </div>
              </GlassCard>
            )}

            {/* Connection Config */}
            <GlassCard className="overflow-hidden">
              <button
                onClick={() => setConfigExpanded(!configExpanded)}
                className="w-full flex items-center justify-between p-5 text-left hover:bg-background/30 transition-all duration-200"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
                    <Key size={18} className="text-primary" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-foreground">连接配置</h4>
                    <p className="text-xs text-muted-foreground">
                      {configExpanded ? '收起配置选项' : '展开配置选项'}
                    </p>
                  </div>
                </div>
                <div className={cn(
                  "w-8 h-8 rounded-lg bg-secondary flex items-center justify-center transition-all duration-300",
                  configExpanded && "bg-primary/10"
                )}>
                  <ChevronDown
                    size={16}
                    className={cn(
                      "text-muted-foreground transition-transform duration-300",
                      configExpanded && "rotate-180 text-primary"
                    )}
                  />
                </div>
              </button>

              <div className={cn(
                "overflow-hidden transition-all duration-500 ease-in-out",
                configExpanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
              )}>
                <div className="px-5 pb-5 pt-2 space-y-5 border-t border-border/50 overflow-x-hidden">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      显示名称
                    </label>
                    <div className="relative min-w-0">
                      <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={pName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPName(e.target.value)}
                        placeholder="Provider Name"
                        className="h-11 pl-10 bg-background/60 min-w-0 overflow-hidden"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      API 代理地址
                    </label>
                    <div className="flex gap-2 min-w-0">
                      <div className="flex rounded-lg overflow-hidden border border-input bg-background/60 shrink-0">
                        <button
                          onClick={() => {
                            const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                            const path = match ? match[2] : pUrl;
                            setPUrl('http://' + path);
                          }}
                          className={cn(
                            "px-3 py-2 text-sm font-medium transition-all",
                            (pUrl.startsWith('http://') || (!pUrl.startsWith('http://') && !pUrl.startsWith('https://')))
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-secondary"
                          )}
                        >
                          http://
                        </button>
                        <button
                          onClick={() => {
                            const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                            const path = match ? match[2] : pUrl;
                            setPUrl('https://' + path);
                          }}
                          className={cn(
                            "px-3 py-2 text-sm font-medium transition-all border-l border-input",
                            pUrl.startsWith('https://')
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-secondary"
                          )}
                        >
                          https://
                        </button>
                      </div>
                      <div className="relative flex-1 min-w-0">
                        <Input
                          value={(() => {
                            const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                            return match ? match[2] : pUrl;
                          })()}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                            const protocol = match ? match[1] : 'http://';
                            setPUrl(protocol + e.target.value);
                          }}
                          placeholder="api.example.com/v1"
                          className="h-11 font-mono text-sm bg-background/60 min-w-0 overflow-hidden"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      API 密钥
                    </label>
                    <div className="relative min-w-0">
                      <Key size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="password"
                        value={pKey}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPKey(e.target.value)}
                        placeholder="sk-..."
                        className="h-11 pl-10 pr-12 font-mono text-sm bg-background/60 min-w-0 overflow-hidden"
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      您的密钥安全存储在本地，不会发送到任何第三方服务器
                    </p>
                  </div>
                </div>
              </div>
            </GlassCard>

            {/* Model Management */}
            <GlassCard className="overflow-hidden">
              <div className="px-5 py-4 border-b border-border/50 bg-gradient-to-r from-background/50 to-background/30">
                <div className="flex items-center gap-2">
                  <Bot size={18} className="text-primary" />
                  <span className="font-semibold text-foreground">模型管理</span>
                  <span className="ml-auto text-xs bg-primary/10 text-primary px-2.5 py-1 rounded-full font-medium">
                    {pModels.length} 个模型
                  </span>
                </div>
              </div>
              <div className="p-5 overflow-x-hidden">
                <ModelEditor
                  models={pModels}
                  onChange={setPModels}
                  providerName={pName}
                />
              </div>
            </GlassCard>

            {/* Save Button */}
            <div className="pt-2">
              <Button
                onClick={handleSaveProvider}
                className="w-full h-11 text-base font-semibold"
              >
                <Save size={18} className="mr-2" />
                {t.save || '保存'}
              </Button>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};
