/**
 * CharacterPluginsTab.tsx — [PLUGIN-ON-DEMAND P1] 角色设置页的「插件」Tab
 *
 * 权威 spec：docs/SPEC_插件按角色卡按需启用_2026-09-26.md（§3 P1 第 1 项）
 *
 * 解决的问题：白名单"可管理"缺口 —— P0 只有导入时一个入口，导入后想改这张卡启用
 * 哪些插件只能重新导入。这里复用同一个后端端点，随时查看与修改。
 *
 * 后端契约（backend/app/api/character.py）：
 *   GET  /api/characters/{id}/plugin-state → { mode, plugins[], suggestions[] }
 *   PUT  /api/characters/{id}/plugin-state → { status, mode, count }
 *   mode = 'inherit'（沿用全局开关，老卡默认） | 'allowlist'（只启用勾选项）
 *
 * 优先级语义（spec §2.5.1）：用户在这里的显式选择 > 装配层自动判定。切到 allowlist
 * 并勾选后，装配层的 @bubble 自动门控对该卡让位（roleplay_prompt_assembly 已实现）。
 *
 * 保存时机：改动**不即时落库**，由父级「保存」按钮统一提交（useImperativeHandle
 * 暴露 save/isDirty），避免"点了复选框就改了线上状态但最后取消"的脏写。
 * Tab 切换时不卸载（父级用 className 隐藏），因此改动不会丢。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '@/services/api';

export interface CharacterPluginsTabHandle {
  /** 有改动时才写库；未改动时 no-op（幂等） */
  save: () => Promise<void>;
  /** 相对上次保存是否有未落库的改动（父级据此决定是否调用 save） */
  isDirty: () => boolean;
}

interface PluginRow {
  plugin_id: string;
  plugin_name: string;
  plugin_type: string;
  enabled: boolean;
  suggested: boolean;
  reason?: string;
}

interface CharacterPluginsTabProps {
  characterId: string;
}

type ScopeMode = 'inherit' | 'allowlist';

function snapshot(mode: ScopeMode, rows: PluginRow[]) {
  return JSON.stringify({
    mode,
    plugins: rows.map((r) => ({ p: r.plugin_id, e: !!r.enabled })),
  });
}

export const CharacterPluginsTab = forwardRef<CharacterPluginsTabHandle, CharacterPluginsTabProps>(
  function CharacterPluginsTab({ characterId }, ref) {
    const [rows, setRows] = useState<PluginRow[]>([]);
    const [mode, setMode] = useState<ScopeMode>('inherit');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const baselineRef = useRef<string>('');

    useEffect(() => {
      let alive = true;
      (async () => {
        setLoading(true);
        setLoadError(null);
        try {
          const data: any = await api.get(
            `/api/characters/${encodeURIComponent(characterId)}/plugin-state`,
          );
          if (!alive) return;
          const suggested = new Set<string>(
            (Array.isArray(data?.suggestions) ? data.suggestions : []).map((s: any) => s.plugin_id),
          );
          const reasonById = new Map<string, string>(
            (Array.isArray(data?.suggestions) ? data.suggestions : []).map((s: any) => [
              s.plugin_id,
              s.reason,
            ]),
          );
          const nextMode: ScopeMode = data?.mode === 'allowlist' ? 'allowlist' : 'inherit';
          const list = Array.isArray(data?.plugins) ? data.plugins : [];
          const nextRows: PluginRow[] = list.map((p: any) => ({
            plugin_id: p.plugin_id,
            plugin_name: p.plugin_name,
            plugin_type: p.plugin_type,
            // enabled 为 null/undefined = 该卡还没覆盖过 → 按识别建议默认勾选
            enabled:
              p.enabled === null || p.enabled === undefined
                ? suggested.has(p.plugin_id)
                : !!p.enabled,
            suggested: suggested.has(p.plugin_id),
            reason: reasonById.get(p.plugin_id),
          }));
          setMode(nextMode);
          setRows(nextRows);
          baselineRef.current = snapshot(nextMode, nextRows);
        } catch (err) {
          console.warn('[CharacterPluginsTab] 读取插件状态失败:', err);
          if (alive) setLoadError('读取插件列表失败，请稍后重试。');
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => {
        alive = false;
      };
    }, [characterId]);

    const toggle = useCallback((pluginId: string) => {
      setRows((prev) =>
        prev.map((r) => (r.plugin_id === pluginId ? { ...r, enabled: !r.enabled } : r)),
      );
    }, []);

    const isDirty = useCallback(() => {
      return baselineRef.current !== '' && snapshot(mode, rows) !== baselineRef.current;
    }, [mode, rows]);

    const save = useCallback(async () => {
      if (saving) return;
      // 幂等：没有改动就别写库（父级保存、重复点击都可能走到这里，
      // 无脑写会把"继承模式 + 建议默认勾选"误落成一张真的白名单）。
      if (!isDirty()) return;
      setSaving(true);
      try {
        await api.put(`/api/characters/${encodeURIComponent(characterId)}/plugin-state`, {
          mode,
          plugins: rows.map((r) => ({ plugin_id: r.plugin_id, enabled: !!r.enabled })),
        });
        baselineRef.current = snapshot(mode, rows);
      } catch (err) {
        console.error('[CharacterPluginsTab] 保存插件名单失败:', err);
        throw err;
      } finally {
        setSaving(false);
      }
    }, [characterId, mode, rows, saving]);

    useImperativeHandle(ref, () => ({ save, isDirty }), [save, isDirty]);

    const enabledCount = rows.filter((r) => r.enabled).length;

    return (
      <div className="p-4 md:p-8 glass-strong rounded-2xl space-y-5 md:space-y-6" data-testid="character-plugins-tab">
        <div>
          <h2 className="text-base md:text-lg font-semibold">这张卡启用哪些插件</h2>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            切换角色卡时会即时生效（不用刷新页面）。改动随本页右下角「保存」一起提交。
          </p>
        </div>

        {/* 模式选择：inherit = 沿用全局开关；allowlist = 只启用勾选项 */}
        <div className="flex flex-col gap-2">
          {(
            [
              {
                value: 'inherit' as ScopeMode,
                title: '跟随全局开关（默认）',
                desc: '沿用插件管理里的全局启停，与没有设置过这张卡时完全一致。',
              },
              {
                value: 'allowlist' as ScopeMode,
                title: '为这张卡自定义',
                desc: '只启用下面勾选的插件；系统会跳过对这张卡的自动判断，以你的选择为准。',
              },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              className="flex items-start gap-3 p-3 md:p-3.5 rounded-xl border border-border cursor-pointer hover:bg-accent/50 transition-colors min-h-[44px]"
              data-testid={`plugin-mode-${opt.value}`}
            >
              <input
                type="radio"
                name="plugin-scope-mode"
                className="mt-0.5 w-4 h-4 md:w-[18px] md:h-[18px] shrink-0 accent-primary"
                checked={mode === opt.value}
                onChange={() => setMode(opt.value)}
              />
              <span className="flex-1 min-w-0">
                <span className="block text-xs md:text-sm font-medium">{opt.title}</span>
                <span className="block text-[11px] md:text-xs text-muted-foreground mt-0.5">
                  {opt.desc}
                </span>
              </span>
            </label>
          ))}
        </div>

        {loadError && (
          <p className="text-xs md:text-sm text-destructive" data-testid="plugin-tab-error">
            {loadError}
          </p>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs md:text-sm font-semibold">插件列表</span>
            {mode === 'allowlist' && (
              <span className="text-[11px] md:text-xs text-muted-foreground">
                已启用 {enabledCount} / {rows.length}
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-6 justify-center text-xs md:text-sm text-muted-foreground">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              正在读取插件列表...
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs md:text-sm text-muted-foreground py-4">
              {loadError ? '—' : '当前账号没有可用插件。'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5 md:gap-2">
              {rows.map((row) => (
                <li key={row.plugin_id}>
                  <label
                    className={`flex items-start gap-3 p-3 md:p-3.5 rounded-xl border border-border transition-colors min-h-[44px] ${
                      mode === 'inherit'
                        ? 'opacity-60 cursor-not-allowed'
                        : 'cursor-pointer hover:bg-accent/50'
                    }`}
                    data-testid={`plugin-tab-row-${row.plugin_id}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 md:w-[18px] md:h-[18px] shrink-0 accent-primary"
                      checked={mode === 'inherit' ? false : row.enabled}
                      disabled={mode === 'inherit'}
                      onChange={() => toggle(row.plugin_id)}
                      data-testid={`plugin-tab-toggle-${row.plugin_id}`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs md:text-sm font-medium">{row.plugin_name}</span>
                        {row.suggested && (
                          <span className="text-[10px] md:text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                            推荐
                          </span>
                        )}
                      </span>
                      {row.reason && (
                        <span className="block text-[11px] md:text-xs text-muted-foreground mt-0.5">
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

        {isDirty() && (
          <p className="text-[11px] md:text-xs text-primary" data-testid="plugin-tab-dirty-hint">
            有未保存的改动，点右下角「保存」提交。
          </p>
        )}
      </div>
    );
  },
);
