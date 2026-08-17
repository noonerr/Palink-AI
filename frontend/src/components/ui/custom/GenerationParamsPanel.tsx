import { useState, useCallback, useEffect } from 'react';
import { X, RotateCcw, Save, Upload, Download } from 'lucide-react';
import { api } from '@/services/api';
import type { GenerationPreset } from '@/types';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface GenerationParamsPanelProps {
  currentPreset: GenerationPreset | null;
  onPresetChange: (preset: GenerationPreset) => void;
  theme?: 'dark' | 'light';
  open?: boolean;
  onClose?: () => void;
}

const DEFAULT_PARAMS: Partial<GenerationPreset> = {
  temperature: 0.7,
  top_p: 0.95,
  max_tokens: 1024,
  frequency_penalty: 0,
  presence_penalty: 0,
  min_p: 0.05,
  top_k: 40,
  repetition_penalty: 1.0,
};

interface ParamDef {
  key: keyof GenerationPreset;
  label: string;
  min: number;
  max: number;
  step: number;
}

const PARAMS: ParamDef[] = [
  { key: 'temperature', label: '温度 (Temperature)', min: 0, max: 2, step: 0.05 },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05 },
  { key: 'max_tokens', label: '最大令牌数', min: 1, max: 8192, step: 1 },
  { key: 'frequency_penalty', label: '频率惩罚', min: 0, max: 2, step: 0.05 },
  { key: 'presence_penalty', label: '存在惩罚', min: 0, max: 2, step: 0.05 },
  { key: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.01 },
  { key: 'top_k', label: 'Top K', min: 1, max: 200, step: 1 },
  { key: 'repetition_penalty', label: '重复惩罚', min: 0.5, max: 2, step: 0.05 },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function GenerationParamsPanel({
  currentPreset,
  onPresetChange,
  theme = 'dark',
  open = false,
  onClose,
}: GenerationParamsPanelProps) {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [localPreset, setLocalPreset] = useState<GenerationPreset | null>(currentPreset);
  // ban_sequences edited as multiline text (one sequence per line) for UX.
  const [banSequencesText, setBanSequencesText] = useState('');
  // logit_bias edited as raw JSON text with validation feedback.
  const [logitBiasText, setLogitBiasText] = useState('');
  const [logitBiasError, setLogitBiasError] = useState<string | null>(null);
  const isDark = theme === 'dark';

  useEffect(() => {
    setLocalPreset(currentPreset);
    if (currentPreset) {
      setBanSequencesText((currentPreset.ban_sequences ?? []).join('\n'));
      const lb = currentPreset.logit_bias ?? {};
      setLogitBiasText(Object.keys(lb).length > 0 ? JSON.stringify(lb, null, 2) : '');
      setLogitBiasError(null);
    }
  }, [currentPreset]);

  const updateParam = useCallback((key: keyof GenerationPreset, value: number) => {
    if (!localPreset) return;
    const next = { ...localPreset, [key]: value };
    setLocalPreset(next);
    onPresetChange(next);
  }, [localPreset, onPresetChange]);

  const updateBanSequences = useCallback((text: string) => {
    setBanSequencesText(text);
    if (!localPreset) return;
    const seqs = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    const next = { ...localPreset, ban_sequences: seqs };
    setLocalPreset(next);
    onPresetChange(next);
  }, [localPreset, onPresetChange]);

  const updateLogitBias = useCallback((text: string) => {
    setLogitBiasText(text);
    if (!localPreset) return;
    const trimmed = text.trim();
    if (trimmed === '') {
      setLogitBiasError(null);
      const next = { ...localPreset, logit_bias: {} };
      setLocalPreset(next);
      onPresetChange(next);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!isPlainObject(parsed)) {
        setLogitBiasError('必须是 JSON 对象，例如 {"123": -100}');
        return;
      }
      const normalized: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          setLogitBiasError(`token "${k}" 的 bias 不是有效数字`);
          return;
        }
        // Clamp to ST/OpenAI range [-100, 100]
        normalized[k] = Math.max(-100, Math.min(100, n));
      }
      setLogitBiasError(null);
      const next = { ...localPreset, logit_bias: normalized };
      setLocalPreset(next);
      onPresetChange(next);
    } catch {
      setLogitBiasError('JSON 格式错误');
    }
  }, [localPreset, onPresetChange]);

  const handleReset = useCallback(() => {
    if (!localPreset) return;
    const next: GenerationPreset = { ...localPreset, ...DEFAULT_PARAMS };
    setLocalPreset(next);
    setBanSequencesText((next.ban_sequences ?? []).join('\n'));
    const lb = next.logit_bias ?? {};
    setLogitBiasText(Object.keys(lb).length > 0 ? JSON.stringify(lb, null, 2) : '');
    setLogitBiasError(null);
    onPresetChange(next);
  }, [localPreset, onPresetChange]);

  const handleSaveNew = useCallback(async () => {
    if (!newPresetName.trim() || !localPreset) return;
    if (logitBiasError) return;
    try {
      const created: GenerationPreset = await api.post('/api/roleplay/presets', {
        name: newPresetName.trim(),
        temperature: localPreset.temperature,
        top_p: localPreset.top_p,
        max_tokens: localPreset.max_tokens,
        frequency_penalty: localPreset.frequency_penalty,
        presence_penalty: localPreset.presence_penalty,
        min_p: localPreset.min_p,
        top_k: localPreset.top_k,
        repetition_penalty: localPreset.repetition_penalty,
        ban_sequences: localPreset.ban_sequences ?? [],
        logit_bias: localPreset.logit_bias ?? {},
      });
      setNewPresetName('');
      setShowSaveDialog(false);
      onPresetChange(created);
    } catch (e) {
      console.error('Failed to save preset:', e);
    }
  }, [newPresetName, localPreset, onPresetChange, logitBiasError]);

  // Persist current edits (including ban_sequences / logit_bias) to the active preset.
  const handleSaveCurrent = useCallback(async () => {
    if (!localPreset || logitBiasError) return;
    try {
      const updated: GenerationPreset = await api.put(`/api/roleplay/presets/${localPreset.id}`, {
        ban_sequences: localPreset.ban_sequences ?? [],
        logit_bias: localPreset.logit_bias ?? {},
      });
      onPresetChange(updated);
    } catch (e) {
      console.error('Failed to save preset bias fields:', e);
    }
  }, [localPreset, onPresetChange, logitBiasError]);

  const handleExport = useCallback(async () => {
    if (!localPreset) return;
    try {
      const data = await api.get(`/api/roleplay/presets/${localPreset.id}/export`);
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
  }, [localPreset]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append('file', file);
        const created: GenerationPreset = await api.post('/api/roleplay/presets/import', formData);
        onPresetChange(created);
      } catch (err) {
        console.error('Failed to import preset:', err);
      }
    };
    input.click();
  }, [onPresetChange]);

  if (!open || !localPreset) return null;

  return (
    <div className={cn(
      'absolute right-0 top-full mt-2 z-50 w-80 rounded-xl shadow-lg border backdrop-blur-[20px] p-4',
      isDark
        ? 'bg-[rgba(15,23,42,0.95)] border-[rgba(255,255,255,0.18)]'
        : 'bg-[rgba(255,250,250,0.95)] border-[#ddd4c5]'
    )}>
      <div className="flex items-center justify-between mb-4">
        <div className={cn('text-sm font-semibold', isDark ? 'text-white' : 'text-slate-900')}>
          生成参数
        </div>
        <button
          className={cn(
            'h-7 w-7 rounded-md flex items-center justify-center transition-colors',
            isDark ? 'text-slate-400 hover:bg-white/10' : 'text-slate-500 hover:bg-[#FFFAFA]/50'
          )}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
        {PARAMS.map((param) => (
          <ParamSlider
            key={param.key}
            label={param.label}
            value={(localPreset[param.key] as number) ?? (DEFAULT_PARAMS[param.key] as number)}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(v) => updateParam(param.key, v)}
            isDark={isDark}
          />
        ))}

        {/* ST 1.18.0 ban_sequences — multiline text, one sequence per line */}
        <div className="space-y-1 pt-2">
          <div className="flex items-center justify-between">
            <span className={cn('text-xs', isDark ? 'text-slate-400' : 'text-slate-500')}>
              禁止序列 (ban_sequences)
            </span>
            <span className={cn('text-[10px]', isDark ? 'text-slate-500' : 'text-slate-400')}>
              每行一个
            </span>
          </div>
          <Textarea
            value={banSequencesText}
            onChange={(e) => updateBanSequences(e.target.value)}
            placeholder={"例如：\n示例文本\n<bad>"}
            className={cn(
              'min-h-20 text-xs font-mono resize-y',
              isDark
                ? 'bg-white/5 border-white/10 text-slate-200 placeholder:text-slate-600'
                : 'bg-slate-50/50 border-[#ddd4c5] text-slate-700 placeholder:text-slate-400'
            )}
          />
        </div>

        {/* ST 1.18.0 logit_bias — JSON object editor {token_id: bias_value} */}
        <div className="space-y-1 pt-2">
          <div className="flex items-center justify-between">
            <span className={cn('text-xs', isDark ? 'text-slate-400' : 'text-slate-500')}>
              Logit Bias (JSON)
            </span>
            {logitBiasError ? (
              <span className="text-[10px] text-red-500">{logitBiasError}</span>
            ) : (
              <span className={cn('text-[10px]', isDark ? 'text-slate-500' : 'text-slate-400')}>
                范围 -100 ~ 100
              </span>
            )}
          </div>
          <Textarea
            value={logitBiasText}
            onChange={(e) => updateLogitBias(e.target.value)}
            placeholder={'例如：\n{\n  "123": -100,\n  "456": 5\n}'}
            aria-invalid={!!logitBiasError}
            className={cn(
              'min-h-24 text-xs font-mono resize-y',
              isDark
                ? 'bg-white/5 border-white/10 text-slate-200 placeholder:text-slate-600'
                : 'bg-slate-50/50 border-[#ddd4c5] text-slate-700 placeholder:text-slate-400',
              logitBiasError && 'border-red-500/60'
            )}
          />
        </div>
      </div>

      <div className={cn('flex flex-col gap-2 pt-3 mt-3 border-t', isDark ? 'border-white/10' : 'border-[#ddd4c5]')}>
        {showSaveDialog ? (
          <div className="flex gap-2">
            <Input
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="输入预设名称..."
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleSaveNew()}
            />
            <Button size="sm" className="h-8 text-xs px-2" onClick={handleSaveNew}>保存</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs px-2" onClick={() => setShowSaveDialog(false)}>取消</Button>
          </div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="h-8 text-xs flex-1 gap-1" onClick={() => setShowSaveDialog(true)}>
              <Save size={12} /> 保存为新预设
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1"
              onClick={handleSaveCurrent}
              disabled={!!logitBiasError}
              title="将禁止序列 / logit_bias 保存到当前预设"
            >
              <Save size={12} /> 保存当前
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={handleReset}>
              <RotateCcw size={12} /> 重置
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs px-2" onClick={handleImport} title="导入预设">
              <Upload size={12} />
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs px-2" onClick={handleExport} title="导出预设">
              <Download size={12} />
            </Button>
          </div>
        )}
      </div>
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
        <span className={cn('text-xs font-mono tabular-nums', isDark ? 'text-white' : 'text-slate-900')}>
          {value}
        </span>
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
