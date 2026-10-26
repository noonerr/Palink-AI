import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Download,
  FileJson,
  Loader2,
  RotateCcw,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';

/**
 * 预设模板库面板（后端 `GET/POST/DELETE /api/preset-library*`）。
 *
 * 四类清单：context / instruct / sysprompt / reasoning。
 * - 清单字段口径不完全一致：context/instruct 用 `id/name/display_name/is_builtin`，
 *   sysprompt/reasoning 用 `name/builtin`。归一化统一走 normalizePresetLibrary。
 * - 本批 sysprompt/reasoning **只做库管理**，不接「应用到生成」（见卡片底部说明）。
 * - 导入走 multipart（`file` + 可选 `kind`），复用 PresetManager 的同款写法。
 */

export type PresetLibraryKind = 'context' | 'instruct' | 'sysprompt' | 'reasoning';

export const PRESET_LIBRARY_KINDS: { key: PresetLibraryKind; label: string; hint: string }[] = [
  { key: 'context', label: '上下文模板', hint: 'Context Template' },
  { key: 'instruct', label: '指令模板', hint: 'Instruct Template' },
  { key: 'sysprompt', label: '系统提示词', hint: 'System Prompt' },
  { key: 'reasoning', label: '推理模板', hint: 'Reasoning' },
];

export const PRESET_LIBRARY_KIND_LABELS: Record<string, string> = PRESET_LIBRARY_KINDS.reduce(
  (acc, k) => {
    acc[k.key] = k.label;
    return acc;
  },
  {} as Record<string, string>,
);

export interface PresetLibraryItem {
  /** 删除/导出时用的定位键：有 id 优先 id，否则 name */
  key: string;
  /** 磁盘上的模板名（导出文件名 / 删除路径都用它对应的键） */
  name: string;
  displayName: string;
  builtin: boolean;
}

export interface PresetLibraryImportSummary {
  created: string[];
  skipped: string[];
  warnings: string[];
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

/** 把后端返回的单条模板归一化成 UI 需要的字段；无法解析返回 null（不抛）。 */
export function normalizePresetLibraryItem(raw: unknown): PresetLibraryItem | null {
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { key: name, name, displayName: name, builtin: false } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = asText(obj.name).trim();
  const id = obj.id == null ? '' : asText(obj.id).trim();
  if (!name && !id) return null;
  const displayName = asText(obj.display_name).trim() || name || id;
  return {
    key: id || name,
    name: name || id,
    displayName,
    builtin: obj.is_builtin === true || obj.builtin === true,
  };
}

/** 从未知响应归一化成四类清单；缺失/非数组的分组按空处理。 */
export function normalizePresetLibrary(raw: unknown): Record<PresetLibraryKind, PresetLibraryItem[]> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<PresetLibraryKind, PresetLibraryItem[]>;
  PRESET_LIBRARY_KINDS.forEach(({ key }) => {
    const list = Array.isArray(source[key]) ? (source[key] as unknown[]) : [];
    out[key] = list
      .map((entry) => normalizePresetLibraryItem(entry))
      .filter((entry): entry is PresetLibraryItem => entry !== null);
  });
  return out;
}

function describeEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const kind = asText(obj.kind).trim();
    const name = asText(obj.name).trim() || asText(obj.display_name).trim() || asText(obj.id).trim();
    const kindLabel = kind ? PRESET_LIBRARY_KIND_LABELS[kind] || kind : '';
    if (kindLabel && name) return `${kindLabel}：${name}`;
    return name || kindLabel;
  }
  return asText(entry).trim();
}

function describeWarning(entry: unknown): string {
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const detail =
      asText(obj.message).trim() ||
      asText(obj.reason).trim() ||
      asText(obj.detail).trim() ||
      asText(obj.warning).trim();
    const where = describeEntry(entry);
    if (detail) {
      // describeEntry 已带 kind/name，避免 "上下文模板：X：detail" 重复拼接
      return where && !detail.includes(where) && where !== asText(obj.name).trim()
        ? `${where}：${detail}`
        : detail;
    }
  }
  return describeEntry(entry);
}

/** POST /api/preset-library/import 的返回 → 展示用摘要。兼容字符串与对象两种条目。 */
export function summarizePresetLibraryImport(raw: unknown): PresetLibraryImportSummary {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    created: asList(source.created).map(describeEntry).filter(Boolean),
    skipped: asList(source.skipped).map(describeEntry).filter(Boolean),
    warnings: asList(source.warnings).map(describeWarning).filter(Boolean),
  };
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 文件名安全化：模板名可能带 `/`、空格、中文标点 */
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'preset';
}

export interface PresetLibraryPanelProps {
  /** 库变更（导入 / 删除 / 恢复自带）后回调，供父组件刷新下拉等派生数据 */
  onChanged?: () => void | Promise<void>;
  /** 父组件需要强制重拉时递增该值 */
  refreshToken?: number;
  className?: string;
}

export function PresetLibraryPanel({ onChanged, refreshToken = 0, className }: PresetLibraryPanelProps) {
  const [library, setLibrary] = useState<Record<PresetLibraryKind, PresetLibraryItem[]>>(
    () => normalizePresetLibrary({}),
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [importKind, setImportKind] = useState<'' | PresetLibraryKind>('');
  const [summary, setSummary] = useState<PresetLibraryImportSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: PresetLibraryKind; item: PresetLibraryItem } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const notifyChanged = useCallback(() => {
    try {
      const result = onChanged?.();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      /* 父组件刷新失败不影响本面板 */
    }
  }, [onChanged]);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await api.get('/api/preset-library');
      if (!mountedRef.current) return;
      setLibrary(normalizePresetLibrary(data));
    } catch (e) {
      console.error('Failed to load preset library:', e);
      if (!mountedRef.current) return;
      setLoadError(true);
      toast.error('模板库加载失败');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary, refreshToken]);

  const handlePickImportFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 允许连续选择同一个文件（否则 onchange 不触发）
    event.target.value = '';
    if (!file || importing) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (importKind) formData.append('kind', importKind);
      const result = await api.post('/api/preset-library/import', formData);
      const nextSummary = summarizePresetLibraryImport(result);
      setSummary(nextSummary);
      await loadLibrary();
      notifyChanged();
      if (nextSummary.created.length > 0) {
        toast.success(`已导入 ${nextSummary.created.length} 项模板`);
      } else if (nextSummary.warnings.length > 0) {
        toast.error('未导入任何模板，请查看导入提示');
      } else {
        // 全被跳过时也给用户一个可见结果（摘要块始终渲染）
        toast.success('导入完成（没有新增模板）');
      }
    } catch (e: any) {
      console.error('Failed to import preset library:', e);
      toast.error(e?.message || '导入失败');
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  const handleExportOne = async (kind: PresetLibraryKind, item: PresetLibraryItem) => {
    try {
      const data = await api.get(
        `/api/preset-library/export?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(item.key)}`,
      );
      downloadJson(data, `${safeFilename(item.name)}.json`);
    } catch (e: any) {
      console.error('Failed to export preset:', e);
      toast.error(e?.message || '导出失败');
    }
  };

  const handleExportAll = async () => {
    try {
      const data = await api.get('/api/preset-library/export-all');
      downloadJson(data, 'preset-library-all.json');
    } catch (e: any) {
      console.error('Failed to export preset library:', e);
      toast.error(e?.message || '导出失败');
    }
  };

  const handleRestoreDefaults = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      await api.post('/api/preset-library/ensure-defaults');
      await loadLibrary();
      notifyChanged();
      toast.success('已恢复自带模板');
    } catch (e: any) {
      console.error('Failed to restore builtin presets:', e);
      toast.error(e?.message || '恢复自带模板失败');
    } finally {
      if (mountedRef.current) setRestoring(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const { kind, item } = pendingDelete;
    try {
      await api.delete(
        `/api/preset-library/${encodeURIComponent(kind)}/${encodeURIComponent(item.key)}`,
      );
      await loadLibrary();
      notifyChanged();
      toast.success(`已删除 ${item.displayName}`);
    } catch (e: any) {
      console.error('Failed to delete preset:', e);
      toast.error(e?.message || '删除失败');
    }
  };

  const total = PRESET_LIBRARY_KINDS.reduce((sum, k) => sum + library[k.key].length, 0);

  return (
    <div className={cn('space-y-4', className)} data-testid="preset-library-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-semibold text-base md:text-lg">模板库</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            上下文 / 指令模板与系统提示词、推理模板的统一管理入口
            {loading ? '' : `（共 ${total} 项）`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="导入类型"
            data-testid="preset-library-import-kind"
            value={importKind}
            onChange={(e) => setImportKind(e.target.value as '' | PresetLibraryKind)}
            className="text-sm rounded-md border border-border bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">自动识别</option>
            {PRESET_LIBRARY_KINDS.map(({ key, label }) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 md:h-9 rounded-md px-3"
            onClick={handlePickImportFile}
            disabled={importing}
            data-testid="preset-library-import"
          >
            {importing ? (
              <Loader2 size={14} className="mr-1.5 animate-spin" />
            ) : (
              <UploadCloud size={14} className="mr-1.5" />
            )}
            {importing ? '导入中…' : '导入预设'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 md:h-9 rounded-md px-3"
            onClick={() => void handleExportAll()}
            disabled={loading || total === 0}
            data-testid="preset-library-export-all"
          >
            <Download size={14} className="mr-1.5" />
            导出全部
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 md:h-9 rounded-md px-3"
            onClick={() => void handleRestoreDefaults()}
            disabled={restoring}
            data-testid="preset-library-restore"
          >
            <RotateCcw size={14} className={cn('mr-1.5', restoring && 'animate-spin')} />
            {restoring ? '恢复中…' : '恢复自带'}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="preset-library-file-input"
            onChange={handleFileSelected}
          />
        </div>
      </div>

      {summary && (
        <div
          className="rounded-xl border border-border/60 bg-secondary/40 px-3 py-2 text-xs space-y-1"
          data-testid="preset-library-import-summary"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium text-foreground">
              已导入 {summary.created.length} 项
              {summary.skipped.length > 0 ? `，跳过 ${summary.skipped.length} 项` : ''}
              {summary.warnings.length > 0 ? `，${summary.warnings.length} 条提示` : ''}
            </p>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => setSummary(null)}
              data-testid="preset-library-dismiss-summary"
            >
              关闭
            </button>
          </div>
          {summary.warnings.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
              {summary.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground text-sm py-4">加载中...</div>
      ) : loadError ? (
        <div className="flex items-center gap-3 py-4 text-sm">
          <span className="text-muted-foreground">模板库加载失败</span>
          <Button variant="outline" size="sm" onClick={() => void loadLibrary()}>
            重试
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2" data-testid="preset-library-groups">
          {PRESET_LIBRARY_KINDS.map(({ key, label, hint }) => {
            const items = library[key];
            return (
              <div
                key={key}
                className="overflow-hidden rounded-xl border border-border/50 bg-background/40"
                data-testid="preset-library-group"
                data-kind={key}
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-secondary/30">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{label}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{hint}</p>
                  </div>
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    data-testid="preset-library-count"
                    data-kind={key}
                  >
                    {items.length} 项
                  </span>
                </div>
                {items.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">暂无</div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {items.map((item) => (
                      <div
                        key={`${key}-${item.key}`}
                        className="flex items-center gap-2 px-3 py-2"
                        data-testid="preset-library-row"
                        data-kind={key}
                        data-key={item.key}
                        data-builtin={item.builtin ? 'true' : 'false'}
                      >
                        <FileJson size={14} className="shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate">{item.displayName}</p>
                          {item.displayName !== item.name && (
                            <p className="text-[11px] text-muted-foreground truncate">{item.name}</p>
                          )}
                        </div>
                        {item.builtin && (
                          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-secondary text-muted-foreground">
                            内置
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 shrink-0"
                          title="导出"
                          aria-label={`导出 ${item.displayName}`}
                          data-testid="preset-library-export-one"
                          data-kind={key}
                          data-key={item.key}
                          onClick={() => void handleExportOne(key, item)}
                        >
                          <Download size={13} />
                        </Button>
                        {!item.builtin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 shrink-0 text-destructive hover:text-destructive"
                            title="删除"
                            aria-label={`删除 ${item.displayName}`}
                            data-testid="preset-library-delete"
                            data-kind={key}
                            data-key={item.key}
                            onClick={() => setPendingDelete({ kind: key, item })}
                          >
                            <Trash2 size={13} />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground leading-relaxed" data-testid="preset-library-note">
        说明：原生对话暂未消费 sysprompt/reasoning，ST 插件面可使用。导入 ST 预设时，
        context 中无法映射的键会被丢弃并列入提示。
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="删除模板"
        description={
          pendingDelete
            ? `确定删除「${pendingDelete.item.displayName}」？该操作不可撤销。`
            : ''
        }
        confirmText="删除"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
