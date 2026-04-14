import React, { useState, useRef } from 'react';
import { Check, ChevronDown, Bot, Cpu, Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { Model } from '@/types';

interface ModelSelectorProps {
  models: Model[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  size?: 'sm' | 'md';
  triggerStyle?: 'default' | 'icon' | 'mobile-bar' | 'mobile-inline';
  theme?: 'dark' | 'light';
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  currentModel,
  onSelect,
  size = 'md',
  triggerStyle = 'default',
  theme = 'dark'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDarkTheme = theme === 'dark';
  
  const currentModelObj = models.find(m => m.id === currentModel) || models[0];
  const displayName = currentModelObj?.alias || currentModelObj?.name || '';

  const getModelDisplayName = (model: Model) => model.alias || model.name;

  useClickOutside(containerRef, () => setIsOpen(false));

  const currentModelIcon =
    currentModelObj?.icon && (currentModelObj.icon.startsWith('/') || currentModelObj.icon.startsWith('http'))
      ? <img src={currentModelObj.icon} alt="" className="h-4 w-4 object-contain" />
      : <Bot size={14} className="sm:w-3 sm:h-3" />;

  if (size === 'sm') {
    if (triggerStyle === 'mobile-bar') {
      return (
        <div ref={containerRef} className="relative">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className={cn(
              'fixed right-5 top-[calc(env(safe-area-inset-top)+24px)] z-[70] flex h-11 items-center gap-2 px-4 rounded-[35px] border backdrop-blur-[30px] transition-all duration-300 ease-in-out',
              isDarkTheme
                ? 'border border-[rgba(255,255,255,0.18)] bg-[rgba(15,23,42,0.5)] text-white'
                : 'border-[#ddd4c5] bg-[rgba(255,250,250,0.7)] text-slate-700',
              isOpen && (isDarkTheme ? 'ring-2 ring-slate-500/70' : 'ring-2 ring-[#d7cab2]')
            )}
            aria-label="select-model"
            data-model-selector="true"
            id="model-selector-button"
          >
            {currentModelIcon}
            <span className="text-sm font-medium max-w-[120px] truncate">{displayName}</span>
            <ChevronDown 
              size={16} 
              className={cn("transition-transform", isOpen && "rotate-180")} 
            />
          </button>

          {isOpen && (
            <div className="absolute top-full right-0 mt-2 w-64 glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up origin-top-right">
              <div className="max-h-64 overflow-y-auto p-1.5">
                {models.map(model => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onSelect(model.id);
                      setIsOpen(false);
                    }}
                    className={cn(
                      'w-full flex items-start gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 rounded-lg text-sm transition-all touch-target',
                      currentModel === model.id
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-foreground hover:bg-muted'
                    )}
                  >
                    <span className="text-lg shrink-0">
                      {model.icon?.startsWith('/') || model.icon?.startsWith('http') ? (
                        <img src={model.icon} alt="" className="w-5 h-5 object-contain" />
                      ) : (
                        model.icon || '🤖'
                      )}
                    </span>
                    <div className="flex-1 text-left min-w-0">
                      <div className="break-words leading-tight text-sm">{getModelDisplayName(model)}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                        <span className="truncate">{model.provider}</span>
                        <span>•</span>
                        <span>{(model.context_length / 1024).toFixed(0)}k</span>
                      </div>
                    </div>
                    {currentModel === model.id && <Check size={14} className="shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (triggerStyle === 'mobile-inline') {
      return (
        <div ref={containerRef} className="relative">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className={cn(
              'flex h-11 items-center gap-2 px-4 rounded-[35px] border backdrop-blur-[30px] transition-all duration-300 ease-in-out',
              isDarkTheme
                ? 'border border-[rgba(255,255,255,0.18)] bg-[rgba(15,23,42,0.5)] text-white'
                : 'border-[#ddd4c5] bg-[rgba(255,250,250,0.7)] text-slate-700',
              isOpen && (isDarkTheme ? 'ring-2 ring-slate-500/70' : 'ring-2 ring-[#d7cab2]')
            )}
            aria-label="select-model"
            data-model-selector="true"
          >
            {currentModelIcon}
            <span className="text-sm font-medium max-w-[120px] truncate">{displayName}</span>
            <ChevronDown
              size={16}
              className={cn('transition-transform', isOpen && 'rotate-180')}
            />
          </button>

          {isOpen && (
            <div className="absolute top-full right-0 mt-2 w-64 glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up origin-top-right">
              <div className="max-h-64 overflow-y-auto p-1.5">
                {models.map(model => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onSelect(model.id);
                      setIsOpen(false);
                    }}
                    className={cn(
                      'w-full flex items-start gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 rounded-lg text-sm transition-all touch-target',
                      currentModel === model.id
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-foreground hover:bg-muted'
                    )}
                  >
                    <span className="text-lg shrink-0">
                      {model.icon?.startsWith('/') || model.icon?.startsWith('http') ? (
                        <img src={model.icon} alt="" className="w-5 h-5 object-contain" />
                      ) : (
                        model.icon || '🤖'
                      )}
                    </span>
                    <div className="flex-1 text-left min-w-0">
                      <div className="break-words leading-tight text-sm">{getModelDisplayName(model)}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                        <span className="truncate">{model.provider}</span>
                        <span>•</span>
                        <span>{(model.context_length / 1024).toFixed(0)}k</span>
                      </div>
                    </div>
                    {currentModel === model.id && <Check size={14} className="shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (triggerStyle === 'icon') {
      return (
        <div ref={containerRef} className="relative">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-xl transition-all',
              isDarkTheme
                ? 'border border-slate-600/80 bg-[#2a3048] text-slate-100'
                : 'border border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 shadow-sm',
              isOpen && (isDarkTheme ? 'ring-2 ring-slate-500/70' : 'ring-2 ring-[#d7cab2]')
            )}
            aria-label="select-model"
          >
            {currentModelIcon}
          </button>

          {isOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-56 sm:w-64 glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up origin-bottom-left">
              <div className="max-h-64 overflow-y-auto p-1.5">
                {models.map(model => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onSelect(model.id);
                      setIsOpen(false);
                    }}
                    className={cn(
                      'w-full flex items-start gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 rounded-lg text-sm transition-all touch-target',
                      currentModel === model.id
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-foreground hover:bg-muted'
                    )}
                  >
                    <span className="text-lg shrink-0">
                      {model.icon?.startsWith('/') || model.icon?.startsWith('http') ? (
                        <img src={model.icon} alt="" className="w-5 h-5 object-contain" />
                      ) : (
                        model.icon || '🤖'
                      )}
                    </span>
                    <div className="flex-1 text-left min-w-0">
                      <div className="break-words leading-tight text-sm">{getModelDisplayName(model)}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                        <span className="truncate">{model.provider}</span>
                        <span>•</span>
                        <span>{(model.context_length / 1024).toFixed(0)}k</span>
                      </div>
                    </div>
                    {currentModel === model.id && <Check size={14} className="shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div ref={containerRef} className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-full text-xs font-medium touch-target",
            "bg-secondary hover:bg-secondary/80 transition-all",
            isOpen && "ring-2 ring-primary/20"
          )}
        >
          {currentModelIcon}
          <span className="max-w-[80px] sm:max-w-[100px] truncate">{displayName}</span>
          <ChevronDown 
            size={14} 
            className={cn("transition-transform sm:w-3 sm:h-3", isOpen && "rotate-180")} 
          />
        </button>

        {isOpen && (
          <div className="absolute bottom-full left-0 mb-2 w-56 sm:w-64 glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up origin-bottom-left">
            <div className="max-h-64 overflow-y-auto p-1.5">
              {models.map(model => (
                <button
                  key={model.id}
                  onClick={() => {
                    onSelect(model.id);
                    setIsOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-start gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 rounded-lg text-sm transition-all touch-target",
                    currentModel === model.id
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-foreground hover:bg-muted"
                  )}
                >
                  <span className="text-lg shrink-0">
                    {model.icon?.startsWith('/') || model.icon?.startsWith('http') ? (
                      <img src={model.icon} alt="" className="w-5 h-5 object-contain" />
                    ) : (
                      model.icon || '🤖'
                    )}
                  </span>
                  <div className="flex-1 text-left min-w-0">
                    <div className="break-words leading-tight text-sm">{getModelDisplayName(model)}</div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <span className="truncate">{model.provider}</span>
                      <span>•</span>
                      <span>{(model.context_length / 1024).toFixed(0)}k</span>
                    </div>
                  </div>
                  {currentModel === model.id && <Check size={14} className="shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium",
          "bg-secondary hover:bg-secondary/80 transition-all",
          isOpen && "ring-2 ring-primary/20"
        )}
      >
        <Bot size={16} />
        <span>{displayName}</span>
        <ChevronDown 
          size={14} 
          className={cn("transition-transform", isOpen && "rotate-180")} 
        />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-72 glass-strong rounded-xl shadow-xl border border-border z-50 overflow-hidden animate-fade-in-up">
          <div className="max-h-80 overflow-y-auto p-1.5">
            {models.map(model => (
              <button
                key={model.id}
                onClick={() => {
                  onSelect(model.id);
                  setIsOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-all",
                  currentModel === model.id
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                )}
              >
                <span className="text-xl">
                  {model.icon?.startsWith('/') || model.icon?.startsWith('http') ? (
                    <img src={model.icon} alt="" className="w-6 h-6 object-contain" />
                  ) : (
                    model.icon || '🤖'
                  )}
                </span>
                <div className="flex-1 text-left">
                  <div className="font-medium">{getModelDisplayName(model)}</div>
                  <div className="text-[10px] opacity-70 flex items-center gap-2 mt-0.5">
                    <span className="flex items-center gap-1">
                      <Cpu size={10} />
                      {model.provider}
                    </span>
                    <span className="flex items-center gap-1">
                      <Database size={10} />
                      {(model.context_length / 1024).toFixed(0)}k
                    </span>
                  </div>
                </div>
                {currentModel === model.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
