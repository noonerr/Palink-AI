import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, Check, Sliders } from 'lucide-react';
import { api } from '@/services/api';
import type { GenerationPreset } from '@/types';
import { cn } from '@/lib/utils';

interface PresetSelectorProps {
  currentPreset: GenerationPreset | null;
  onPresetChange: (preset: GenerationPreset) => void;
  className?: string;
  theme?: 'dark' | 'light';
  compact?: boolean;
  hideTrigger?: boolean;
  open?: boolean;
  onClose?: () => void;
  mobileButtonClassName?: string;
}

export function PresetSelector({
  currentPreset,
  onPresetChange,
  className,
  theme = 'dark',
  compact = false,
  hideTrigger = false,
  open: openProp = false,
  onClose,
  mobileButtonClassName,
}: PresetSelectorProps) {
  const [presets, setPresets] = useState<GenerationPreset[]>([]);
  const [showList, setShowList] = useState(false);
  const initialized = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDarkTheme = theme === 'dark';

  const loadPresets = useCallback(async () => {
    try {
      await api.post('/api/roleplay/presets/ensure-defaults');
      const data = await api.get('/api/roleplay/presets');
      setPresets(data);
      if (!currentPreset && data.length > 0) {
        const def = data.find((p: GenerationPreset) => p.is_default) || data[0];
        onPresetChange(def);
      }
    } catch (e) {
      console.error('Failed to load presets:', e);
    }
  }, [currentPreset, onPresetChange]);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      loadPresets();
    }
  }, [loadPresets]);

  useEffect(() => {
    if (openProp) {
      setShowList(true);
    }
  }, [openProp]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowList(false);
        onClose?.();
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [onClose]);

  const handleSelect = (preset: GenerationPreset) => {
    onPresetChange(preset);
    setShowList(false);
    onClose?.();
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {!hideTrigger && (
        <button
          onClick={() => setShowList(!showList)}
          className={cn(
            'rounded-2xl backdrop-blur-[20px] bg-transparent hover:bg-[#FFFAFA]/30 dark:hover:bg-white/[0.05] transition-all inline-flex items-center justify-center gap-1.5',
            compact ? 'h-9 px-3 text-xs' : 'h-12 w-12',
            mobileButtonClassName,
            showList && (isDarkTheme ? 'bg-white/[0.05]' : 'bg-[#FFFAFA]/30')
          )}
          aria-label="参数预设"
          title={currentPreset?.name ?? '参数预设'}
        >
          <Sliders size={compact ? 14 : 18} />
          {compact && currentPreset && (
            <span className={cn('max-w-[80px] truncate', isDarkTheme ? 'text-slate-200' : 'text-slate-700')}>
              {currentPreset.name}
            </span>
          )}
          {compact && <ChevronDown size={12} />}
        </button>
      )}

      {showList && (
        <div className={cn(
          'absolute right-0 top-full mt-2 z-50 min-w-[220px] rounded-xl shadow-lg border backdrop-blur-[20px] overflow-hidden',
          isDarkTheme
            ? 'bg-[rgba(15,23,42,0.95)] border-[rgba(255,255,255,0.18)]'
            : 'bg-[rgba(255,250,250,0.95)] border-[#ddd4c5]'
        )}>
          <div className="max-h-56 overflow-y-auto py-1">
            {presets.length === 0 && (
              <div className={cn('px-3 py-2 text-xs', isDarkTheme ? 'text-slate-400' : 'text-slate-500')}>
                暂无预设
              </div>
            )}
            {presets.map((p: GenerationPreset) => (
              <button
                key={p.id}
                onClick={() => handleSelect(p)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                  currentPreset?.id === p.id
                    ? (isDarkTheme ? 'bg-white/10 text-white font-medium' : 'bg-[#d7cab2]/20 text-slate-900 font-medium')
                    : (isDarkTheme ? 'text-slate-200 hover:bg-white/5' : 'text-slate-700 hover:bg-[#FFFAFA]/50')
                )}
              >
                <Sliders size={14} className="shrink-0" />
                <span className="flex-1 text-left truncate">{p.name}</span>
                {p.is_default && (
                  <span className={cn(
                    'text-[10px] px-1 py-0.5 rounded',
                    isDarkTheme ? 'bg-white/10 text-slate-300' : 'bg-[#d7cab2]/20 text-slate-600'
                  )}>默认</span>
                )}
                {currentPreset?.id === p.id && <Check size={14} className="shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
