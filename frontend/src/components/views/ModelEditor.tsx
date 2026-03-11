import React, { useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Bot,
  Database,
  Save,
  Search,
  Image,
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AVAILABLE_ICONS, autoMatchIcon } from './settings-constants';
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
  const [_customIconUrl, _setCustomIconUrl] = useState('');
  const [_showCustomIconInput, _setShowCustomIconInput] = useState(false);

  const categories = ['全部', ...Array.from(new Set(AVAILABLE_ICONS.map(i => i.category)))];

  const filteredIcons = AVAILABLE_ICONS.filter(icon => {
    const matchesSearch = icon.name.toLowerCase().includes(iconSearch.toLowerCase());
    const matchesCategory = selectedCategory === '全部' || icon.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

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
    newModels[index] = { ...newModels[index], ...updates };
    onChange(newModels);
  };

  const handleDeleteModel = (index: number) => {
    onChange(models.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
  };

  const handleAutoMatchIcon = (index: number, modelName: string) => {
    if (modelName) {
      const matchedIcon = autoMatchIcon(modelName);
      handleUpdateModel(index, { icon: matchedIcon });
    }
  };

  const handleCustomIconUpload = (e: React.ChangeEvent<HTMLInputElement>, index: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请上传图片文件');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('图片大小不能超过 2MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      handleUpdateModel(index, { icon: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h4 className="text-lg font-semibold text-foreground">模型配置</h4>
          <p className="text-xs text-muted-foreground">管理此提供商下的 AI 模型，最多支持 50 个模型</p>
        </div>
        <Button size="sm" onClick={handleAddModel}>
          <Plus size={16} />
          添加模型
        </Button>
      </div>

      <div className="space-y-3">
        {models.map((model, index) => (
          <div
            key={index}
            className={cn(
              "group relative rounded-2xl border bg-card transition-all duration-300",
              expandedIndex === index
                ? "border-primary/50 shadow-lg shadow-primary/5"
                : "border-border hover:border-border/80 hover:shadow-md"
            )}
          >
            <div
              className="flex items-center gap-4 p-4 cursor-pointer transition-colors"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('button')) {
                  setExpandedIndex(expandedIndex === index ? null : index);
                }
              }}
            >
              <div className="relative">
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
                <div className="flex items-center gap-2">
                  <h5 className="font-semibold text-foreground truncate">
                    {model.name || '未命名模型'}
                  </h5>
                  {model.id && (
                    <span className="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-md font-mono">
                      {model.context_length}K
                    </span>
                  )}
                </div>
                {model.id && (
                  <p className="text-xs text-muted-foreground truncate font-mono">
                    {model.id}
                  </p>
                )}
                {model.description && (
                  <p className="text-xs text-muted-foreground line-clamp-1">
                    {model.description}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1">
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
                className="px-4 pb-4 border-t border-border pt-4 space-y-5 animate-in slide-in-from-top-2 fade-in duration-300"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
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
                      className="h-10 font-mono text-sm bg-background/50"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      显示名称
                    </label>
                    <Input
                      placeholder="如: GPT-4o"
                      value={model.name}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateModel(index, { name: e.target.value })}
                      className="h-10 bg-background/50"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    模型图标
                  </label>

                  <div className="flex items-start gap-4">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-2xl flex items-center justify-center overflow-hidden border-2 border-border/50 bg-gradient-to-br from-background to-background/50">
                        {model.icon?.startsWith('/') || model.icon?.startsWith('http') || model.icon?.startsWith('data:') ? (
                          <img src={model.icon} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-3xl">{model.icon || '🤖'}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleAutoMatchIcon(index, model.id || model.name || '')}
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
                            onChange={(e) => handleCustomIconUpload(e, index)}
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
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="grid grid-cols-8 gap-2 max-h-28 overflow-y-auto p-1">
                          {filteredIcons.map((icon) => (
                            <button
                              key={icon.name}
                              onClick={() => handleUpdateModel(index, { icon: icon.path })}
                              className={cn(
                                "aspect-square rounded-xl bg-background border-2 flex items-center justify-center transition-all duration-200 hover:scale-105 hover:shadow-md",
                                model.icon === icon.path
                                  ? "border-primary ring-2 ring-primary/20 scale-105"
                                  : "border-transparent hover:border-border"
                              )}
                              title={icon.name}
                            >
                              <img src={icon.path} alt={icon.name} className="w-7 h-7 object-contain" />
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      上下文长度
                    </label>
                    <div className="relative">
                      <Database size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="number"
                        value={model.context_length}
                        onChange={(e) => handleUpdateModel(index, { context_length: parseInt(e.target.value) || 4096 })}
                        className="h-10 pl-10 bg-background/50 font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    模型描述
                  </label>
                  <textarea
                    placeholder="输入模型简介，支持换行..."
                    value={model.description || ''}
                    onChange={(e) => handleUpdateModel(index, { description: e.target.value })}
                    className="w-full h-24 p-3.5 rounded-xl bg-background/50 border border-input text-sm resize-none focus:ring-2 focus:ring-ring/50 focus:border-ring outline-none transition-all"
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
          <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center">
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
