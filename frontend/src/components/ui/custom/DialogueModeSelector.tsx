/**
 * DialogueModeSelector — 对话模式选择器
 * 从 CharacterChat 提取的可复用组件
 */
import React, { useState, useRef, useCallback } from 'react';
import { BookOpen, ChevronDown, Check, User as UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClickOutside } from '@/hooks/useClickOutside';

export type DialogueMode = 'first_person' | 'third_person';

export interface DialogueModeSelectorProps {
  currentMode: DialogueMode;
  onSelect: (mode: DialogueMode) => void;
  lang?: 'zh' | 'en';
  t: Record<string, string>;
  /** 禁用整个选择器 */
  disabled?: boolean;
}

export function DialogueModeSelector({
  currentMode,
  onSelect,
  lang = 'zh',
  t,
  disabled = false,
}: DialogueModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setIsOpen(false));

  const modes: { id: DialogueMode; name: string }[] = [
    { id: 'first_person', name: t.first_person || '第一人称' },
    { id: 'third_person', name: t.story_mode || '故事模式' },
  ];

  const getIcon = useCallback((modeId: string) =>
    modeId === 'first_person' ? <UserIcon size={16} /> : <BookOpen size={16} />,
  []);

  const currentModeObj = modes.find(m => m.id === currentMode) || modes[0];

  const handleSelect = useCallback((mode: DialogueMode) => {
    onSelect(mode);
    setIsOpen(false);
  }, [onSelect]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium",
          "bg-secondary hover:bg-secondary/80 transition-all",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          isOpen && "ring-2 ring-primary/20"
        )}
      >
        {getIcon(currentModeObj.id)}
        <span>{currentModeObj.name}</span>
        <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-44 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-1.5">
            {modes.map(mode => (
              <button
                key={mode.id}
                onClick={() => handleSelect(mode.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all",
                  currentMode === mode.id
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                )}
              >
                <span className="text-xl">{getIcon(mode.id)}</span>
                <div className="flex-1 text-left">
                  <div className="font-medium">{mode.name}</div>
                </div>
                {currentMode === mode.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default DialogueModeSelector;
