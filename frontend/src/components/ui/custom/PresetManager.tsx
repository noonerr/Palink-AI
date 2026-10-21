import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Plus, Upload, Download, Trash2, Check, ChevronDown,
  Sliders, Search, FileJson, Globe,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import type { GenerationPreset } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  fetchPresetSelection,
  fetchSessionPresetSource,
  putPresetSelection,
  type SessionPresetSource,
} from '@/lib/promptPresetSelection';

export interface PresetManagerProps {
  currentPreset: GenerationPreset | null;
  onPresetChange: (preset: GenerationPreset) => void;
  theme?: 'dark' | 'light';
  open?: boolean;
  onClose?: () => void;
  /** [批次UI1] 当前会话 id —— 只用于只读展示"本对话副本 / 全局默认"。 */
  sessionId?: string;
}

export function PresetManager({
  currentPreset,
  onPresetChange,
  theme = 'dark',
  open = false,
  onClose,
  sessionId,
}: PresetManagerProps) {
  const [presets, setPresets] = useState<GenerationPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  // [批次UI1] 后端"选中哪份"（GET /presets/selection）；此前这个 UI 只有组件内 state。
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectionSource, setSelectionSource] = useState<string>('none');
  const [savingSelectionName, setSavingSelectionName] = useState<string | null>(null);
  // [批次UI1] 本对话来源：**只读**展示（source=session/global），不做任何写操作。
  const [sessionPreset, setSessionPreset] = useState<SessionPresetSource | null>(null);
  const [sessionPresetError, setSessionPresetError] = useState(false);
  // [批次UI1] 用 ref 承接"当前预设/回调"：loadPresets 只应在**打开时**跑一次。
  // 旧实现把二者放进 useCallback 依赖，而父组件每次渲染都可能传新函数 ⇒ 打开期间
  // 每次渲染都重拉名单；本批加了 selection 回写后这会**覆盖刚写入的选中态**
  // （实测：点选预设后被一次重拉的旧 selection 顶回去）。
  const currentPresetRef = useRef(currentPreset);
  const onPresetChangeRef = useRef(onPresetChange);
  useEffect(() => {
    currentPresetRef.current = currentPreset;
  }, [currentPreset]);
  useEffect(() => {
    onPresetChangeRef.current = onPresetChange;
  }, [onPresetChange]);
  const isDark = theme === 'dark';

  const loadPresets = useCallback(async () => {
    setLoading(true);
    try {
      await api.post('/api/roleplay/presets/ensure-defaults');
      // [批次UI1] 名单与"后端选中份"并行取：当前预设不再由本组件猜默认值。
      const [data, selection] = await Promise.all([
        api.get<GenerationPreset[]>('/api/roleplay/presets'),
        fetchPresetSelection().catch(() => null),
      ]);
      setPresets(data);
      if (selection) {
        setSelectedName(selection.selected_name ?? null);
        setSelectionSource(selection.source || 'none');
      }
      if (!currentPresetRef.current && data.length > 0) {
        // 口径优先级：后端已解析出的选中份 > is_default > 列表第一条。
        // （`resolved_name` 在"从未选过"时是兼容回落份，仍然比前端瞎猜可靠。）
        // 先按 resolved_id 命中（同名多行/共享行同名时名字不可靠），再退回名字。
        const backendPicked = selection
          ? (selection.resolved_id != null
              ? data.find((p) => p.id === selection.resolved_id)
              : undefined)
            || (selection.resolved_name
              ? data.find((p) => p.name === selection.resolved_name)
              : undefined)
          : undefined;
        const def = backendPicked || data.find((p) => p.is_default) || data[0];
        onPresetChangeRef.current(def);
      }
    } catch (e) {
      console.error('Failed to load presets:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // [批次UI1] 本对话预设来源 —— 只读；窗口关闭或没有会话时不发请求。
  useEffect(() => {
    if (!open || !sessionId) {
      setSessionPreset(null);
      setSessionPresetError(false);
      return undefined;
    }
    let cancelled = false;
    setSessionPreset(null);
    setSessionPresetError(false);
    fetchSessionPresetSource(sessionId)
      .then((data) => {
        if (!cancelled) setSessionPreset(data);
      })
      .catch(() => {
        if (!cancelled) setSessionPresetError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  // 每次"打开"拉一次（关闭时不打请求）；关掉再开能看到别处新增/改名的预设。
  useEffect(() => {
    if (!open) return;
    loadPresets();
  }, [open, loadPresets]);

  const filteredPresets = presets.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  /**
   * [批次UI1] "选用" = 本地切换 + 写后端全局选中（PUT /presets/selection）。
   * 写失败不回滚本地选择，但必须 toast 出来（用户要能看出"这次没存上"）。
   */
  const handleSelectPreset = useCallback(async (preset: GenerationPreset) => {
    onPresetChange(preset);
    if (selectedName === preset.name) return;
    setSavingSelectionName(preset.name);
    try {
      const res = await putPresetSelection(preset.name);
      setSelectedName(res.selected_name ?? preset.name);
      setSelectionSource(res.source || 'selected');
    } catch (e) {
      console.error('Failed to save preset selection:', e);
      toast.error(`全局选中保存失败：${preset.name}`);
    } finally {
      setSavingSelectionName(null);
    }
  }, [onPresetChange, selectedName]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const created: GenerationPreset = await api.post('/api/roleplay/presets', {
        name: newName.trim(),
        temperature: 0.7,
        top_p: 0.95,
        max_tokens: 1024,
        frequency_penalty: 0,
        presence_penalty: 0,
        min_p: 0.05,
        top_k: 40,
        repetition_penalty: 1.0,
      });
      setNewName('');
      setShowCreate(false);
      await loadPresets();
      // 新建即选中（与旧行为一致），同时把它写成后端全局选中。
      await handleSelectPreset(created);
    } catch (e) {
      console.error('Failed to create preset:', e);
    }
  };

  const handleDelete = async (id: number) => {
    const deleted = presets.find((p) => p.id === id);
    try {
      await api.delete(`/api/roleplay/presets/${id}`);
      const remaining = presets.filter((p) => p.id !== id);
      await loadPresets();
      if (currentPreset?.id === id && remaining.length > 0) {
        onPresetChange(remaining[0]);
      }
      // 删掉的正是后端选中份 ⇒ 显式改选剩下第一份（或清除），
      // 不把"指向已删名字的选中名"留给后端回落（否则 UI 与后端都是隐性状态）。
      if (deleted && selectedName === deleted.name) {
        const nextName = remaining[0]?.name ?? null;
        try {
          const res = await putPresetSelection(nextName);
          setSelectedName(res.selected_name ?? nextName);
          setSelectionSource(res.source || 'none');
        } catch (e) {
          console.error('Failed to clear deleted preset selection:', e);
          toast.error('删除后更新全局选中失败');
        }
      }
    } catch (e) {
      console.error('Failed to delete preset:', e);
    }
  };

  const handleSetDefault = async (id: number) => {
    try {
      await api.put(`/api/roleplay/presets/${id}`, { is_default: true });
      await loadPresets();
    } catch (e) {
      console.error('Failed to set default preset:', e);
    }
  };

  const handleRename = async (id: number) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await api.put(`/api/roleplay/presets/${id}`, { name: editName.trim() });
      setEditingId(null);
      await loadPresets();
    } catch (e) {
      console.error('Failed to rename preset:', e);
    }
  };

  const handleExport = async (preset: GenerationPreset) => {
    try {
      const data = await api.get(`/api/roleplay/presets/${preset.id}/export`);
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
        await loadPresets();
        await handleSelectPreset(created);
      } catch (err) {
        console.error('Failed to import preset:', err);
      }
    };
    input.click();
  }, [loadPresets, handleSelectPreset]);

  const handleExportAll = useCallback(() => {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'presets-all.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [presets]);

  if (!open) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-[60] flex items-center justify-center',
      )}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className={cn(
          'relative w-full max-w-lg max-h-[80vh] rounded-2xl shadow-xl border overflow-hidden flex flex-col',
          isDark
            ? 'bg-[rgba(15,23,42,0.95)] border-[rgba(255,255,255,0.18)]'
            : 'bg-[rgba(255,250,250,0.95)] border-[#ddd4c5]'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={cn(
          'flex items-center justify-between px-4 py-3 border-b',
          isDark ? 'border-white/10' : 'border-[#ddd4c5]'
        )}>
          <div className="flex items-center gap-2">
            <Sliders size={16} className={isDark ? 'text-slate-300' : 'text-slate-600'} />
            <span className={cn('text-sm font-semibold', isDark ? 'text-white' : 'text-slate-900')}>
              预设管理
            </span>
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

        {/* Toolbar */}
        <div className={cn(
          'flex items-center gap-2 px-4 py-2 border-b',
          isDark ? 'border-white/10' : 'border-[#ddd4c5]'
        )}>
          <div className="relative flex-1">
            <Search size={13} className={cn(
              'absolute left-2.5 top-1/2 -translate-y-1/2',
              isDark ? 'text-slate-500' : 'text-slate-400'
            )} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索预设..."
              className="h-8 text-xs pl-8"
            />
          </div>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => setShowCreate(true)}>
            <Plus size={12} /> 新建
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs px-2" onClick={handleImport} title="导入">
            <Upload size={12} />
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs px-2" onClick={handleExportAll} title="导出全部">
            <Download size={12} />
          </Button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className={cn(
            'flex items-center gap-2 px-4 py-2 border-b',
            isDark ? 'border-white/10 bg-white/5' : 'border-[#ddd4c5] bg-slate-50/50'
          )}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="输入新预设名称..."
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <Button size="sm" className="h-8 text-xs px-2" onClick={handleCreate}>创建</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs px-2" onClick={() => { setShowCreate(false); setNewName(''); }}>取消</Button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && presets.length === 0 ? (
            <div className={cn('text-center text-xs py-8', isDark ? 'text-slate-400' : 'text-slate-500')}>
              加载中...
            </div>
          ) : filteredPresets.length === 0 ? (
            <div className={cn('text-center text-xs py-8', isDark ? 'text-slate-400' : 'text-slate-500')}>
              {search ? '未找到匹配的预设' : '暂无预设'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredPresets.map((preset) => (
                <div
                  key={preset.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                    currentPreset?.id === preset.id
                      ? (isDark ? 'bg-white/10' : 'bg-[#d7cab2]/15')
                      : (isDark ? 'hover:bg-white/5' : 'hover:bg-[#FFFAFA]/60')
                  )}
                >
                  <FileJson size={14} className={cn(
                    'shrink-0',
                    isDark ? 'text-slate-400' : 'text-slate-500'
                  )} />

                  <div className="flex-1 min-w-0">
                    {editingId === preset.id ? (
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-xs"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(preset.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => handleRename(preset.id)}
                      />
                    ) : (
                      <button
                        className={cn(
                          'text-left truncate w-full',
                          currentPreset?.id === preset.id
                            ? (isDark ? 'text-white font-medium' : 'text-slate-900 font-medium')
                            : (isDark ? 'text-slate-200' : 'text-slate-700')
                        )}
                        onClick={() => handleSelectPreset(preset)}
                      >
                        {preset.name}
                      </button>
                    )}
                  </div>

                  {selectedName === preset.name && (
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                        isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700'
                      )}
                      title="后端全局选中：没有本对话副本的对话默认用它"
                    >
                      全局选中
                    </span>
                  )}

                  {preset.is_default && (
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                      isDark ? 'bg-white/10 text-slate-300' : 'bg-[#d7cab2]/20 text-slate-600'
                    )}>
                      默认
                    </span>
                  )}

                  <div className="flex items-center gap-0.5 shrink-0">
                    {selectedName !== preset.name && (
                      <button
                        className={cn(
                          'h-7 w-7 rounded-md flex items-center justify-center transition-colors',
                          isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-500 hover:bg-[#FFFAFA]/80 hover:text-slate-700'
                        )}
                        onClick={() => handleSelectPreset(preset)}
                        disabled={savingSelectionName === preset.name}
                        title="设为全局选中（写入后端 selection）"
                        data-testid={`preset-select-global-${preset.id}`}
                      >
                        <Globe size={12} />
                      </button>
                    )}
                    {!preset.is_default && (
                      <button
                        className={cn(
                          'h-7 w-7 rounded-md flex items-center justify-center transition-colors',
                          isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-500 hover:bg-[#FFFAFA]/80 hover:text-slate-700'
                        )}
                        onClick={() => handleSetDefault(preset.id)}
                        title="设为默认"
                      >
                        <Check size={12} />
                      </button>
                    )}
                    <button
                      className={cn(
                        'h-7 w-7 rounded-md flex items-center justify-center transition-colors',
                        isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-500 hover:bg-[#FFFAFA]/80 hover:text-slate-700'
                      )}
                      onClick={() => {
                        setEditingId(preset.id);
                        setEditName(preset.name);
                      }}
                      title="重命名"
                    >
                      <ChevronDown size={12} className="rotate-180" />
                    </button>
                    <button
                      className={cn(
                        'h-7 w-7 rounded-md flex items-center justify-center transition-colors',
                        isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-500 hover:bg-[#FFFAFA]/80 hover:text-slate-700'
                      )}
                      onClick={() => handleExport(preset)}
                      title="导出"
                    >
                      <Download size={12} />
                    </button>
                    {!preset.is_default && (
                      <button
                        className={cn(
                          'h-7 w-7 rounded-md flex items-center justify-center transition-colors text-destructive',
                          isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-50'
                        )}
                        onClick={() => handleDelete(preset.id)}
                        title="删除"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer summary */}
        <div className={cn(
          'px-4 py-2 text-[11px] border-t space-y-0.5',
          isDark ? 'border-white/10 text-slate-400' : 'border-[#ddd4c5] text-slate-500'
        )}>
          <div>
            共 {presets.length} 个预设{search ? `，筛选后 ${filteredPresets.length} 个` : ''}
            {currentPreset && (
              <span className="ml-2">
                · 当前: <span className={isDark ? 'text-slate-200' : 'text-slate-700'}>{currentPreset.name}</span>
              </span>
            )}
          </div>
          <div data-testid="preset-global-selection-summary">
            · 全局选中:{' '}
            {selectedName ? (
              <span className={isDark ? 'text-slate-200' : 'text-slate-700'}>{selectedName}</span>
            ) : selectionSource === 'fallback' ? (
              <span>未选择（回落「{currentPreset?.name || '—'}」）</span>
            ) : (
              <span>无</span>
            )}
          </div>
          {sessionId && (
            <div data-testid="preset-session-source">
              {sessionPreset
                ? sessionPreset.source === 'session'
                  ? `· 本对话: 使用副本（基于「${sessionPreset.base_name || sessionPreset.name || '—'}」）`
                  : `· 本对话: 跟随全局默认${sessionPreset.name ? `「${sessionPreset.name}」` : ''}`
                : sessionPresetError
                  ? '· 本对话: 预设来源读取失败'
                  : '· 本对话: 来源读取中…'}
            </div>
          )}
          <div className={cn('pt-0.5', isDark ? 'text-slate-500' : 'text-slate-400')}>
            全局选中只决定「还没有本对话副本」的对话用哪份；已有副本时仍以副本为准。
          </div>
        </div>
      </div>
    </div>
  );
}
