import React from 'react';
import { Database, Edit3, Plus, RefreshCw, Sparkles, Trash2, UploadCloud } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import type { Model, Provider } from '@/types';

interface ModelsTabProps {
  t: Record<string, string>;
  isAdmin: boolean;
  modelSubTab: 'llm' | 'local';
  setModelSubTab: (value: 'llm' | 'local') => void;
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
}

export const ModelsTab: React.FC<ModelsTabProps> = ({
  t,
  isAdmin,
  modelSubTab,
  setModelSubTab,
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
}) => {
  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="flex items-center gap-2 border-b border-border/50 pb-4 shrink-0">
        <button
          onClick={() => setModelSubTab('llm')}
          className={
            modelSubTab === 'llm'
              ? 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all bg-primary text-primary-foreground shadow-lg shadow-primary/20'
              : 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all text-muted-foreground hover:bg-secondary hover:text-foreground'
          }
        >
          <Sparkles size={16} />
          {t.language_models || '语言模型'}
        </button>
        {isAdmin && (
          <button
            onClick={() => setModelSubTab('local')}
            className={
              modelSubTab === 'local'
                ? 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all bg-primary text-primary-foreground shadow-lg shadow-primary/20'
                : 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all text-muted-foreground hover:bg-secondary hover:text-foreground'
            }
          >
            <Database size={16} />
            {t.local_models || '本地模型'}
          </button>
        )}
      </div>

      {modelSubTab === 'llm' && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 animate-fade-in pr-2 pt-4">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-2xl font-semibold">{t.provider_config}</h3>
                <Button onClick={() => handleEditProvider()}>
                  <Plus size={16} className="mr-2" />
                  {t.add_provider}
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
                            {(provider.models || []).length} {t.active_models}
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

      {modelSubTab === 'local' && isAdmin && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 animate-fade-in pr-2 pt-4">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-2xl font-semibold">{t.local_models || '本地模型'}</h3>
                <div className="flex gap-2">
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

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {localModels.length > 0 ? (
                localModels.map((model) => (
                  <GlassCard
                    key={model.id}
                    className={`p-4 sm:p-5 hover:shadow-lg transition-all group ${!model.enabled ? 'opacity-60' : ''}`}
                    hover
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <h4 className="font-semibold truncate text-sm sm:text-base">{model.name}</h4>
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
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200 dark:border-gray-700">
                        <label className="flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={model.enabled !== false}
                            onChange={(e) => handleModelEnable(model.id, e.target.checked)}
                            className="sr-only"
                          />
                          <div
                            className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                              model.enabled !== false ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                            }`}
                          >
                            <div
                              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                                model.enabled !== false ? 'translate-x-5' : ''
                              }`}
                            />
                          </div>
                          <span className="ml-2 text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                            {model.enabled !== false ? '已启用' : '已禁用'}
                          </span>
                        </label>

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
                ))
              ) : (
                <GlassCard className="p-8 text-center">
                  <Database size={48} className="mx-auto text-muted-foreground mb-4" />
                  <h4 className="font-semibold mb-2">{t.no_local_models || '暂无本地模型'}</h4>
                  <p className="text-sm text-muted-foreground">{t.upload_model_hint || '请点击上方的"上传模型"按钮上传本地模型文件'}</p>
                </GlassCard>
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
};
