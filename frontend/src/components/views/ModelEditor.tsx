import React, { useState, useEffect } from 'react';
import {
  Plus,
  Trash2,
  Bot,
  Database,
  Save,
  ChevronDown,
  Sparkles,
  Eye,
  Search,
  Image,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { autoMatchIcon, AVAILABLE_ICONS } from './settings-constants';
import type { Model } from '@/types';

interface ModelEditorProps {
  models: Model[];
  onChange: (models: Model[]) => void;
  providerName: string;
}

export const ModelEditor: React.FC<ModelEditorProps> = ({ models, onChange, providerName }) => {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [iconSearch, setIconSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [ctxUnit, setCtxUnit] = useState<{ [key: number]: 'k' | 'm' | undefined }>({});
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

  useEffect(() => {
    const handleIconSync = (e: Event) => {
      const { modelId, icon } = (e as CustomEvent).detail;
      if (!modelId || !icon) return;
      let changed = false;
      const newModels = models.map(m => {
        if (m.id === modelId && m.icon !== icon) {
          changed = true;
          return { ...m, icon };
        }
        return m;
      });
      if (changed) {
        onChange(newModels);
      }
    };
    window.addEventListener('modelIconChanged', handleIconSync);
    return () => window.removeEventListener('modelIconChanged', handleIconSync);
  }, [models, onChange]);

  const handleAddModel = () => {
    const newModel: Model = {
      id: '',
      name: '',
      provider: providerName,
      context_length: 4096,
      icon: '🤖',
      description: '',
    };
    onChange([...models, newModel]);
    setExpandedIndex(models.length);
  };

  const handleUpdateModel = (index: number, updates: Partial<Model>) => {
    const newModels = [...models];
    const oldIcon = newModels[index].icon;
    newModels[index] = { ...newModels[index], ...updates };
    onChange(newModels);

    if (updates.icon !== undefined && updates.icon !== oldIcon && newModels[index].id) {
      window.dispatchEvent(new CustomEvent('modelIconChanged', {
        detail: { modelId: newModels[index].id, icon: updates.icon }
      }));
    }
  };

  const handleDeleteModel = (index: number) => {
    onChange(models.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
  };

  const handleAutoMatchIcon = (index: number, modelId: string, modelName?: string) => {
    if (modelId) {
      const matchedIcon = autoMatchIcon(modelId, modelName);
      handleUpdateModel(index, { icon: matchedIcon });
    }
  };

  return (
    <div className="space-y-5 min-w-0 overflow-x-hidden">
      <div className="flex items-center justify-between min-w-0">
        <div className="space-y-1 min-w-0">
          <h4 className="text-lg font-semibold text-foreground">模型配置</h4>
          <p className="text-xs text-muted-foreground">管理此提供商下的 AI 模型，最多支持 50 个模型</p>
        </div>
        <Button size="sm" onClick={handleAddModel}>
          <Plus size={16} />
          添加模型
        </Button>
      </div>

      <div className="space-y-3 min-w-0">
        {models.map((model, index) => (
          <div
            key={index}
            className={cn(
              "group relative rounded-2xl border bg-card transition-all duration-300 min-w-0 overflow-hidden",
              expandedIndex === index
                ? "border-primary/50 shadow-lg shadow-primary/5"
                : "border-border hover:border-border/80 hover:shadow-md"
            )}
          >
            <div
              className="flex items-center gap-4 p-4 cursor-pointer transition-colors min-w-0"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('button')) {
                  setExpandedIndex(expandedIndex === index ? null : index);
                }
              }}
            >
              <div className="relative shrink-0">
                <div className={cn(
                  "w-12 h-12 rounded-xl flex items-center justify-center overflow-hidden shrink-0 transition-all duration-300",
                  expandedIndex === index ? "ring-2 ring-primary/30" : ""
                )}>
                  {model.icon?.startsWith('/') || model.icon?.startsWith('http') || model.icon?.startsWith('data:') ? (
                    <img src={model.icon} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-2xl">{model.icon || '🤖'}</span>
                  )}
                </div>
                {expandedIndex === index && (
                  <div className="absolute -inset-1 bg-primary/10 rounded-2xl -z-10 animate-pulse" />
                )}
              </div>

              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  <h5 className="font-semibold text-foreground text-sm break-all line-clamp-2 min-w-0">
                    {model.name || '未命名模型'}
                  </h5>
                  {model.id && (
                    <span className="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-md font-mono shrink-0">
                      {(() => {
                        const unit = ctxUnit[index] || (model.context_length >= 1048576 ? 'M' : 'k');
                        const val = unit === 'M'
                          ? Math.round(model.context_length / 1048576)
                          : Math.round(model.context_length / 1024);
                        return `${val}${unit}`;
                      })()}
                    </span>
                  )}
                  {model.supports_vision && (
                    <span className="text-[10px] bg-blue-500/15 text-blue-500 dark:text-blue-400 px-1.5 py-0.5 rounded-md flex items-center gap-0.5 shrink-0">
                      <Eye size={9} />
                      视觉
                    </span>
                  )}
                </div>
                {model.id && (
                  <p className="text-xs text-muted-foreground truncate font-mono min-w-0">
                    {model.id}
                  </p>
                )}
                {model.description && (
                  <p className="text-xs text-muted-foreground line-clamp-1">
                    {model.description}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <ChevronDown
                  size={18}
                  className={cn(
                    "text-muted-foreground transition-all duration-300",
                    expandedIndex === index && "rotate-180 text-primary"
                  )}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteModel(index);
                  }}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                  title="删除模型"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            {expandedIndex === index && (
              <div
                className="px-4 pb-4 border-t border-border pt-4 space-y-5 animate-in slide-in-from-top-2 fade-in duration-300 overflow-x-hidden min-w-0"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0 overflow-x-hidden">
                  <div className="space-y-2 min-w-0">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      模型 ID
                    </label>
                    <Input
                      placeholder="如: gpt-4o"
                      value={model.id}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const newId = e.target.value;
                        const updates: Partial<Model> = { id: newId };
                        if (newId && !model.name) {
                          updates.name = newId;
                        }
                        handleUpdateModel(index, updates);
                      }}
                      className="h-10 font-mono text-sm bg-background/50 min-w-0"
                    />
                  </div>
                  <div className="space-y-2 min-w-0">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      显示名称
                    </label>
                    <Input
                      placeholder="如: GPT-4o"
                      value={model.name}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateModel(index, { name: e.target.value })}
                      className="h-10 bg-background/50 min-w-0"
                    />
                  </div>
                </div>

                <div className="space-y-2 min-w-0">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    模型图标
                  </label>
                  <div className="flex items-start gap-4 min-w-0">
                    <div className="relative shrink-0">
                      <div className="w-16 h-16 rounded-2xl flex items-center justify-center overflow-hidden border-2 border-border/50 bg-gradient-to-br from-background to-background/50 shrink-0">
                        {model.icon?.startsWith('/') || model.icon?.startsWith('http') || model.icon?.startsWith('data:') ? (
                          <img src={model.icon} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-3xl">{model.icon || '🤖'}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 space-y-3 min-w-0">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleAutoMatchIcon(index, model.id || '', model.name)}
                          className="h-9 shrink-0"
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
                                handleUpdateModel(index, { icon: dataUrl });
                              };
                              reader.readAsDataURL(file);
                            }}
                          />
                          <Button size="sm" variant="secondary" asChild className="h-9 shrink-0">
                            <span><Image size={14} className="mr-1.5" /> 上传</span>
                          </Button>
                        </label>
                      </div>
                      <div className="bg-muted/30 rounded-xl p-3 space-y-3 min-w-0 overflow-hidden">
                        <div className="flex gap-2 min-w-0">
                          <div className="relative flex-1 min-w-0">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                            <Input
                              placeholder="搜索图标..."
                              value={iconSearch}
                              onChange={(e) => setIconSearch(e.target.value)}
                              className="pl-9 h-8 text-sm bg-background min-w-0"
                            />
                          </div>
                          <select
                            value={selectedCategory}
                            onChange={(e) => setSelectedCategory(e.target.value)}
                            className="h-8 px-3 rounded-lg bg-background border border-input text-sm shrink-0"
                          >
                            {iconCategories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div
                          className="grid gap-2 overflow-y-auto p-1 max-h-48 min-w-0"
                          style={{
                            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                          }}
                        >
                          {filteredIcons.map((icon) => (
                            <button
                              key={icon.name}
                              onClick={() => handleUpdateModel(index, { icon: icon.path })}
                              className={cn(
                                "aspect-square rounded-xl bg-background border-2 flex items-center justify-center transition-all duration-200 hover:scale-105 hover:shadow-md min-w-0",
                                model.icon === icon.path
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0 overflow-x-hidden">
                  <div className="space-y-2 min-w-0">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      上下文长度
                    </label>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="relative flex-1 min-w-0">
                        <Database size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={(() => {
                            const unit = ctxUnit[index] || (model.context_length >= 1048576 ? 'm' : 'k');
                            if (unit === 'm') return Math.round(model.context_length / 1048576);
                            return Math.round(model.context_length / 1024);
                          })()}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const num = raw === '' ? 0 : parseInt(raw, 10) || 0;
                            const unit = ctxUnit[index] || (model.context_length >= 1048576 ? 'm' : 'k');
                            const value = unit === 'm' ? num * 1048576 : num * 1024;
                            handleUpdateModel(index, { context_length: value || 4096 });
                          }}
                          className="h-10 pl-10 pr-16 bg-background/50 font-mono overflow-hidden tabular-nums min-w-0"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-semibold pointer-events-none">
                          {ctxUnit[index] || (model.context_length >= 1048576 ? 'M' : 'k')}
                        </span>
                      </div>
                      <div className="flex h-10 rounded-md overflow-hidden border shrink-0">
                        <button
                          onClick={() => {
                            const newUnit = 'k';
                            setCtxUnit({ ...ctxUnit, [index]: newUnit });
                            const currentValue = model.context_length;
                            if (currentValue >= 1048576) {
                              handleUpdateModel(index, { context_length: Math.round(currentValue / 1024) });
                            }
                          }}
                          className={cn(
                            "px-3 text-sm font-medium transition-all",
                            (ctxUnit[index] || (model.context_length < 1048576)) === 'k'
                              ? "bg-primary text-primary-foreground"
                              : "bg-background text-muted-foreground hover:bg-accent"
                          )}
                        >
                          k
                        </button>
                        <button
                          onClick={() => {
                            const newUnit = 'm';
                            setCtxUnit({ ...ctxUnit, [index]: newUnit });
                            const currentValue = model.context_length;
                            if (currentValue < 1048576) {
                              handleUpdateModel(index, { context_length: currentValue * 1024 });
                            }
                          }}
                          className={cn(
                            "px-3 text-sm font-medium transition-all",
                            (ctxUnit[index] || (model.context_length >= 1048576)) === 'm'
                              ? "bg-primary text-primary-foreground"
                              : "bg-background text-muted-foreground hover:bg-accent"
                          )}
                        >
                          M
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2 min-w-0">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      原生视觉输入
                    </label>
                    <div className="flex items-center h-10">
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={!!model.supports_vision}
                          onCheckedChange={(checked) => handleUpdateModel(index, { supports_vision: checked })}
                        />
                        <span className="text-sm text-muted-foreground truncate">
                          {model.supports_vision ? '支持图片输入' : '不支持图片输入'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 min-w-0">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    模型描述
                  </label>
                  <textarea
                    placeholder="输入模型简介，支持换行..."
                    value={model.description || ''}
                    onChange={(e) => handleUpdateModel(index, { description: e.target.value })}
                    className="w-full h-24 p-3.5 rounded-xl bg-background/50 border border-input text-sm resize-none focus:ring-2 focus:ring-ring/50 focus:border-ring outline-none transition-all min-w-0"
                  />
                </div>

                <div className="flex justify-end pt-2 border-t border-border/50">
                  <Button
                    onClick={() => setExpandedIndex(null)}
                    className="h-9"
                  >
                    <Save size={16} className="mr-2" />
                    保存
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {models.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center min-w-0">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-background flex items-center justify-center">
              <Bot size={32} className="text-muted-foreground" />
            </div>
            <h5 className="text-base font-semibold text-foreground mb-2">暂无模型</h5>
            <p className="text-sm text-muted-foreground mb-6">
              添加您的第一个 AI 模型开始使用
            </p>
            <Button onClick={handleAddModel}>
              <Plus size={16} className="mr-2" />
              添加第一个模型
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
