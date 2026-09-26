/**
 * ImportPluginPicker.tsx — [PLUGIN-ON-DEMAND] 角色卡导入后的插件勾选步骤
 *
 * 权威 spec：docs/SPEC_插件按角色卡按需启用_2026-09-26.md（§2.4）
 *
 * 流程位置：导入成功 → 【本步骤：选插件】→ 现有的「是否 AI 解析翻译」弹窗。
 * 只有后端识别到建议清单时才插入本步骤；没有建议时直接走原流程，行为不变。
 *
 * 语义：
 * - 勾选结果以 allowlist 模式写入（该卡只启用勾选项）；
 * - 点「暂不设置」则该卡保持 inherit（沿用全局开关，与今天完全一致）；
 * - 无可用插件（列表为空）时只显示「暂不设置」，不显示空的勾选区。
 *
 * 移动端可操作性：整行可点（label 包裹 input），触控区 ≥44px，
 * 底部按钮固定、列表区可滚动。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';

export interface PluginSuggestion {
  plugin_id: string;
  plugin_name: string;
  plugin_type: string;
  reason: string;
  source: string;
}

interface PluginRow {
  plugin_id: string;
  plugin_name: string;
  plugin_type: string;
  enabled: boolean;
  /** 是否由识别器推荐（用于 UI 打标） */
  suggested: boolean;
  reason?: string;
}

export interface ImportPluginPickerProps {
  characterId: string;
  suggestions: PluginSuggestion[];
  /** 关掉本弹窗并继续后续流程（是否 AI 解析翻译） */
  onNext: () => void;
  /** 关掉本弹窗但不改任何东西 */
  onSkip: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  declared: '卡内声明',
  detected: '自动识别',
};

export function ImportPluginPicker({
  characterId,
  suggestions,
  onNext,
  onSkip,
}: ImportPluginPickerProps) {
  const [rows, setRows] = useState<PluginRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data: any = await api.get(
          `/api/characters/${encodeURIComponent(characterId)}/plugin-state`,
        );
        if (!alive) return;
        const suggested = new Set(suggestions.map((s) => s.plugin_id));
        const reasonById = new Map(suggestions.map((s) => [s.plugin_id, s.reason]));
        const list = Array.isArray(data?.plugins) ? data.plugins : [];
        // enabled === null 表示这张卡还没覆盖过 → 按识别结果默认勾选
        setRows(
          list.map((p: any) => ({
            plugin_id: p.plugin_id,
            plugin_name: p.plugin_name,
            plugin_type: p.plugin_type,
            enabled: p.enabled === null || p.enabled === undefined
              ? suggested.has(p.plugin_id)
              : !!p.enabled,
            suggested: suggested.has(p.plugin_id),
            reason: reasonById.get(p.plugin_id),
          })),
        );
      } catch (err) {
        console.warn('[ImportPluginPicker] 读取插件状态失败，跳过本步骤:', err);
        if (alive) onSkip();
        return;
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [characterId, suggestions, onSkip]);

  const toggle = useCallback((pluginId: string) => {
    setRows((prev) =>
      prev.map((r) => (r.plugin_id === pluginId ? { ...r, enabled: !r.enabled } : r)),
    );
  }, []);

  const confirm = useCallback(async () => {
    setSaving(true);
    try {
      await api.put(`/api/characters/${encodeURIComponent(characterId)}/plugin-state`, {
        mode: 'allowlist',
        plugins: rows.map((r) => ({ plugin_id: r.plugin_id, enabled: !!r.enabled })),
      });
    } catch (err) {
      // 写入失败不应卡住导入流程：降级为 inherit（行为与今天一致）
      console.error('[ImportPluginPicker] 保存插件名单失败:', err);
    } finally {
      setSaving(false);
      onNext();
    }
  }, [characterId, rows, onNext]);

  const enabledCount = rows.filter((r) => r.enabled).length;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-3.5 sm:p-4"
      data-testid="import-plugin-picker"
    >
      <div className="bg-background border border-border rounded-2xl p-5 sm:p-6 max-w-md w-full shadow-2xl max-h-[85vh] flex flex-col">
        <h3 className="text-base sm:text-lg font-semibold mb-1">为这张卡选择插件</h3>
        <p className="text-xs sm:text-sm text-muted-foreground mb-4">
          已自动识别出这张卡可能需要的插件，你可以自行调整。之后在聊天中切换角色卡会即时生效。
          {/* [PLUGIN-ON-DEMAND] spec §2.5.1 落地要求 4：明示"自动门控被接管" */}
          点「确认」后，这张卡只启用你勾选的插件，系统的自动判断将不再对这张卡生效。
        </p>

        <div className="overflow-y-auto flex-1 -mx-1 px-1 mb-4">
          {loading ? (
            <div className="flex items-center gap-2 py-6 justify-center text-xs sm:text-sm text-muted-foreground">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              正在读取插件列表...
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs sm:text-sm text-muted-foreground py-4">当前没有可用插件。</p>
          ) : (
            <ul className="flex flex-col gap-1.5 sm:gap-2">
              {rows.map((row) => (
                <li key={row.plugin_id}>
                  <label
                    className="flex items-start gap-3 p-3 sm:p-3.5 rounded-xl border border-border cursor-pointer hover:bg-accent/50 transition-colors min-h-[44px]"
                    data-testid={`plugin-row-${row.plugin_id}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 sm:w-[18px] sm:h-[18px] shrink-0 accent-primary"
                      checked={row.enabled}
                      onChange={() => toggle(row.plugin_id)}
                      data-testid={`plugin-toggle-${row.plugin_id}`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs sm:text-sm font-medium">{row.plugin_name}</span>
                        {row.suggested && (
                          <span className="text-[10px] sm:text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                            {SOURCE_LABEL[row.suggested ? 'detected' : ''] || '推荐'}
                          </span>
                        )}
                      </span>
                      {row.reason && (
                        <span className="block text-[11px] sm:text-xs text-muted-foreground mt-0.5">
                          {row.reason}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2.5 sm:gap-3">
          <Button
            onClick={confirm}
            disabled={saving || loading}
            variant="default"
            className="text-xs sm:text-sm"
            data-testid="plugin-picker-confirm"
          >
            {saving ? '保存中...' : `确认（启用 ${enabledCount} 个）`}
          </Button>
          <Button
            variant="secondary"
            onClick={onSkip}
            disabled={saving}
            className="text-xs sm:text-sm"
            data-testid="plugin-picker-skip"
          >
            暂不设置
          </Button>
        </div>
      </div>
    </div>
  );
}
