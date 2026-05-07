import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, Settings, Check, Sliders, Save, Upload, Download, Trash2 } from 'lucide-react';
import { api } from '@/services/api';
import type { GenerationPreset } from '@/types';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
}

export function PresetSelector({
  currentPreset,
  onPresetChange,
  className,
  theme = 'dark',
  compact = false,
  hideTrigger = false,
  open = false,
  onClose,
}: PresetSelectorProps) {
  const [presets, setPresets] = useState<GenerationPreset[]>([]);
  const [showList, setShowList] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
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
    if (open) {
      setShowList(true);
    }
  }, [open]);

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

  const handleSaveNew = async () => {
    if (!newPresetName.trim() || !currentPreset) return;
    try {
      const created = await api.post('/api/roleplay/presets', {
        name: newPresetName.trim(),
        temperature: currentPreset.temperature,
        top_p: currentPreset.top_p,
        max_tokens: currentPreset.max_tokens,
        frequency_penalty: currentPreset.frequency_penalty,
        presence_penalty: currentPreset.presence_penalty,
        min_p: currentPreset.min_p,
        top_k: currentPreset.top_k,
        repetition_penalty: currentPreset.repetition_penalty,
      });
      setNewPresetName('');
      setShowSaveDialog(false);
      await loadPresets();
      onPresetChange(created);
    } catch (e) {
      console.error('Failed to save preset:', e);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/api/roleplay/presets/${id}`);
      await loadPresets();
      if (currentPreset?.id === id) {
        const remaining = presets.filter(p => p.id !== id);
        if (remaining.length > 0) onPresetChange(remaining[0]);
      }
    } catch (e) {
      console.error('Failed to delete preset:', e);
    }
  };

  const handleExport = async (id: number) => {
    try {
      const data = await api.get(`/api/roleplay/presets/${id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.name || 'preset'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export preset:', e);
    }
  };

  const handleImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append('file', file);
        const created = await api.post('/api/roleplay/presets/import', formData);
        await loadPresets();
        onPresetChange(created);
      } catch (err) {
        console.error('Failed to import preset:', err);
      }
    };
    input.click();
  };

  const updateParam = (key: keyof GenerationPreset, value: number) => {
    if (!currentPreset) return;
    onPresetChange({ ...currentPreset, [key]: value });
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {!hideTrigger && (
      <button
        onClick={() => setShowList(!showList)}
        className={cn(
          'h-12 w-12 rounded-2xl backdrop-blur-[20px] bg-transparent hover:bg-[#FFFAFA]/30 dark:hover:bg-white/[0.05] transition-all inline-flex items-center justify-center',
          showList && (isDarkTheme ? 'bg-white/[0.05]' : 'bg-[#FFFAFA]/30')
        )}
        aria-label="参数设置"
        title={currentPreset?.name ?? '参数设置'}
      >
        <Sliders size={20} />
      </button>
      )}

      {showList && (
        <div className={cn(
          'absolute right-0 top-full mt-2 z-50 min-w-[200px] rounded-xl shadow-lg border backdrop-blur-[20px] overflow-hidden',
          isDarkTheme
            ? 'bg-[rgba(15,23,42,0.95)] border-[rgba(255,255,255,0.18)]'
            : 'bg-[rgba(255,250,250,0.95)] border-[#ddd4c5]'
        )}>
          <div className="max-h-56 overflow-y-auto py-1">
            {presets.map(p => (
              <button
                key={p.id}
                onClick={() => {
                  onPresetChange(p);
                  setShowList(false);
                  onClose?.();
                }}
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
          <div className={cn('border-t', isDarkTheme ? 'border-white/10' : 'border-[#ddd4c5]')}>
            <button
              onClick={() => { setShowList(false); setShowPanel(true); }}
              className={cn(
                'flex items-center justify-center gap-1 w-full px-3 py-1.5 text-xs font-medium transition-colors',
                isDarkTheme ? 'text-slate-400 hover:bg-white/5' : 'text-slate-500 hover:bg-[#FFFAFA]/50'
              )}
            >
              <Settings size={13} />
              参数设置
            </button>
          </div>
        </div>
      )}

      {showPanel && currentPreset && (
        <div className={cn(
          'absolute right-0 top-full mt-2 z-50 w-72 rounded-xl shadow-lg border backdrop-blur-[20px] p-3',
          isDarkTheme
            ? 'bg-[rgba(15,23,42,0.95)] border-[rgba(255,255,255,0.18)]'
            : 'bg-[rgba(255,250,250,0.95)] border-[#ddd4c5]'
        )}>
          <div className="flex items-center justify-between mb-3">
            <div className={cn('text-xs font-semibold', isDarkTheme ? 'text-white' : 'text-slate-900')}>生成参数</div>
            <button
              className={cn('h-6 w-6 rounded-md flex items-center justify-center transition-colors', isDarkTheme ? 'text-slate-400 hover:bg-white/10' : 'text-slate-500 hover:bg-[#FFFAFA]/50')}
              onClick={() => setShowPanel(false)}
            >
              ✕
            </button>
          </div>

          <ParamSlider label="温度 (Temperature)" value={currentPreset.temperature ?? 1} min={0} max={2} step={0.05}
            onChange={(v) => updateParam('temperature', v)} isDark={isDarkTheme} />
          <ParamSlider label="Top P" value={currentPreset.top_p ?? 1} min={0} max={1} step={0.05}
            onChange={(v) => updateParam('top_p', v)} isDark={isDarkTheme} />
          <ParamSlider label="最大令牌数" value={currentPreset.max_tokens ?? 4096} min={64} max={8192} step={64}
            onChange={(v) => updateParam('max_tokens', v)} isDark={isDarkTheme} />
          <ParamSlider label="频率惩罚" value={currentPreset.frequency_penalty ?? 0} min={0} max={2} step={0.05}
            onChange={(v) => updateParam('frequency_penalty', v)} isDark={isDarkTheme} />
          <ParamSlider label="存在惩罚" value={currentPreset.presence_penalty ?? 0} min={0} max={2} step={0.05}
            onChange={(v) => updateParam('presence_penalty', v)} isDark={isDarkTheme} />
          <ParamSlider label="Min P" value={currentPreset.min_p ?? 0.2} min={0} max={1} step={0.01}
            onChange={(v) => updateParam('min_p', v)} isDark={isDarkTheme} />
          <ParamSlider label="Top K" value={currentPreset.top_k ?? 40} min={1} max={200} step={1}
            onChange={(v) => updateParam('top_k', v)} isDark={isDarkTheme} />
          <ParamSlider label="重复惩罚" value={currentPreset.repetition_penalty ?? 1.1} min={0.5} max={2} step={0.05}
            onChange={(v) => updateParam('repetition_penalty', v)} isDark={isDarkTheme} />

          <div className={cn('flex gap-1.5 pt-2 mt-2 border-t', isDarkTheme ? 'border-white/10' : 'border-[#ddd4c5]')}>
            {showSaveDialog ? (
              <div className="flex gap-1.5 flex-1">
                <Input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="输入预设名称..."
                  className="h-7 text-xs flex-1"
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveNew()}
                />
                <Button size="sm" className="h-7 text-xs px-2" onClick={handleSaveNew}>保存</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setShowSaveDialog(false)}>取消</Button>
              </div>
            ) : (
              <>
                <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={() => setShowSaveDialog(true)}>
                  <Save size={12} /> 另存为
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={handleImport} title="导入预设">
                  <Upload size={12} />
                </Button>
                {currentPreset && (
                  <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={() => handleExport(currentPreset.id)} title="导出预设">
                    <Download size={12} />
                  </Button>
                )}
                {currentPreset && !currentPreset.is_default && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs px-2 text-destructive" onClick={() => handleDelete(currentPreset.id)} title="删除预设">
                    <Trash2 size={12} />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  isDark = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  isDark?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={cn('text-xs', isDark ? 'text-slate-400' : 'text-slate-500')}>{label}</span>
        <span className={cn('text-xs font-mono tabular-nums', isDark ? 'text-white' : 'text-slate-900')}>{value}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        className="w-full"
      />
    </div>
  );
}
