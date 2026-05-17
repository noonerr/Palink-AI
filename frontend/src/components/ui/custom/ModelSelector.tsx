import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Bot, Brain, Eye, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Model } from '@/types';

interface ModelSelectorProps {
  models: Model[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  size?: 'sm' | 'md';
  triggerStyle?: 'default' | 'icon' | 'mobile-bar' | 'mobile-inline';
  theme?: 'dark' | 'light';
}

export function ModelSelector({
  models,
  currentModel,
  onSelect,
  size = 'md',
  triggerStyle = 'default',
  theme = 'dark'
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDarkTheme = theme === 'dark';
  
  const currentModelObj = models.find(m => m.id === currentModel) || models[0];
  const displayName = currentModelObj?.alias || currentModelObj?.name || '';

  const getModelDisplayName = (model: Model) => model.alias || model.name;

  const VisionBadge = ({ model }: { model: Model }) => {
    if (!model.supports_vision) return null;
    return (
      <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-blue-500/15 text-blue-500 dark:text-blue-400 shrink-0">
        <Eye size={9} />
        <span>视觉</span>
      </span>
    );
  };

  const renderTabBar = () => null;

  const renderModelList = () => {
    const normalModels = models.filter(m => !m.is_test_model);
    const testModels = models.filter(m => m.is_test_model);

    return (
      <div>
        <div className="max-h-52 overflow-y-auto p-1.5">
          {models.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              暂无可用模型
            </div>
          ) : (
            <>
              {normalModels.map(model => (
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
            ) : model.provider === 'local' ? (
              <Brain size={18} className="shrink-0" />
            ) : (
              <Bot size={18} className="shrink-0" />
            )}
          </span>
          <div className="flex-1 text-left min-w-0">
            <div className="break-words leading-tight text-sm flex items-center gap-1">{getModelDisplayName(model)}<VisionBadge model={model} /></div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
              <span className="truncate">{model.provider === 'local' ? '本地' : model.provider}</span>
              <span>•</span>
              <span>{(model.context_length / 1024).toFixed(0)}k</span>
            </div>
          </div>
          {currentModel === model.id && <Check size={14} className="shrink-0" />}
        </button>
              ))}
              {testModels.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-3 py-1.5 mt-1">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <FlaskConical size={10} />
                      开发者
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  {testModels.map(model => (
        <button
          key={model.id}
          onClick={() => {
            onSelect(model.id);
            setIsOpen(false);
          }}
          className={cn(
            'w-full flex items-start gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 rounded-lg text-sm transition-all touch-target',
            currentModel === model.id
              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium'
              : 'text-foreground hover:bg-amber-500/5'
          )}
        >
          <span className="text-lg shrink-0">
            <FlaskConical size={18} className="text-amber-500 shrink-0" />
          </span>
          <div className="flex-1 text-left min-w-0">
            <div className="break-words leading-tight text-sm flex items-center gap-1">{getModelDisplayName(model)}</div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
              <span className="truncate">{model.provider}</span>
              <span>•</span>
              <span>示例回复</span>
            </div>
          </div>
          {currentModel === model.id && <Check size={14} className="shrink-0 text-amber-500" />}
        </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const renderPortalDropdown = (widthClass: string = 'w-64', extraClass: string = '') => {
    if (!isOpen) return null;

    return createPortal(
      <div
        className={`fixed glass-strong rounded-xl shadow-xl border border-border z-[9999] overflow-hidden animate-fade-in-up ${widthClass} ${extraClass}`}
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
        }}
        ref={(el) => {
          if (el) {
            const handleOutsideClick = (e: MouseEvent) => {
              if (containerRef.current && !containerRef.current.contains(e.target as Node) && !el.contains(e.target as Node)) {
                setIsOpen(false);
              }
            };
            document.addEventListener('mousedown', handleOutsideClick);
            return () => document.removeEventListener('mousedown', handleOutsideClick);
          }
        }}
      >
        {renderModelList()}
      </div>,
      document.body
    );
  };

  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const isSmall = size === 'sm';
      const width = isSmall ? 256 : (triggerStyle === 'icon' || size === 'md' ? 256 : 288);

      setDropdownPosition({
        top: rect.bottom + window.scrollY + 8,
        left: Math.min(rect.left + window.scrollX, window.innerWidth - width - 16)
      });
    }
  }, [isOpen, size, triggerStyle]);

  const currentModelIcon =
    currentModelObj?.icon && (currentModelObj.icon.startsWith('/') || currentModelObj.icon.startsWith('http'))
      ? <img src={currentModelObj.icon} alt="" className="h-4 w-4 object-contain" />
      : <Bot size={14} className="sm:w-3 sm:h-3" />;

  if (size === 'sm') {
    if (triggerStyle === 'mobile-bar') {
      return (
        <div ref={containerRef} className="relative">
          <button
            ref={buttonRef}
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

          {renderPortalDropdown('w-64')}
        </div>
      );
    }

    if (triggerStyle === 'mobile-inline') {
      return (
        <div ref={containerRef} className="relative">
          <button
            ref={buttonRef}
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

          {renderPortalDropdown('w-64')}
        </div>
      );
    }

    if (triggerStyle === 'icon') {
      return (
        <div ref={containerRef} className="relative">
          <button
            ref={buttonRef}
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

          {renderPortalDropdown('w-56 sm:w-64')}
        </div>
      );
    }

    return (
      <div ref={containerRef} className="relative">
        <button
          ref={buttonRef}
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

        {renderPortalDropdown('w-56 sm:w-64')}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
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

      {renderPortalDropdown('w-72')}
    </div>
  );
};
