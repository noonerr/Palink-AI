/**
 * ST 兼容层降级桩统计面板
 *
 * 渲染 compat-stub-registry 收集的降级调用统计，让"插件在跑但相关
 * ST API 是无操作桩"这一事实在 UI 上可见（阶段1：静默桩显性化）。
 *
 * [UI-2b 2026-10-26] 顺带承载 style_removal 取证的**静默路径读数**：取证默认不再刷控制台
 * （用户裁定「只在真出问题才报」），但账目必须还能被人看到 —— 这里列出会话级聚合
 * （身份 / 次数 / 被吞掉的重复数 / 是否已升级上报）。两者都为空时不渲染任何内容。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  getCompatStubStats,
  type CompatStubStat,
} from '@/lib/plugin-system/compat-stub-registry';
import {
  getStyleRemovalForensicsSummary,
  type StyleRemovalForensicsSummary,
} from '@/components/ui/custom/smart-card-runtime/style-removal-forensics-aggregate';

export function CompatStubStatsCard() {
  const [entries, setEntries] = useState<Array<[string, CompatStubStat]>>([]);
  const [styleRemoval, setStyleRemoval] = useState<StyleRemovalForensicsSummary>(
    () => getStyleRemovalForensicsSummary(),
  );

  const refresh = useCallback(() => {
    setEntries(Array.from(getCompatStubStats().entries()));
    setStyleRemoval(getStyleRemovalForensicsSummary());
  }, []);

  useEffect(() => {
    refresh();
    // 统计由注入的插件脚本 / 卡帧取证驱动，React 感知不到变化，低频轮询同步一次
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (entries.length === 0 && styleRemoval.keys === 0) return null;

  const total = entries.reduce((sum, [, stat]) => sum + stat.count, 0);

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">ST 兼容层降级统计</p>
          <p className="text-xs text-muted-foreground mt-1">
            本会话共 {total} 次降级桩调用 — 这些 ST API 在 Palink 中为无操作/部分实现，相关插件功能可能不生效
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} className="shrink-0">
          <RefreshCw size={14} className="mr-1.5" />
          刷新
        </Button>
      </div>
      {entries.length > 0 ? (
        <div className="text-xs border rounded-md divide-y overflow-hidden">
          {entries.map(([name, stat]) => (
            <div key={name} className="flex items-start justify-between gap-4 px-3 py-2">
              <div className="min-w-0">
                <span className="font-mono font-medium">{name}</span>
                {stat.lastDetail ? (
                  <span className="text-muted-foreground ml-2">{stat.lastDetail}</span>
                ) : null}
              </div>
              <span className="shrink-0 tabular-nums">{stat.count} 次</span>
            </div>
          ))}
        </div>
      ) : null}
      {styleRemoval.keys > 0 || styleRemoval.unkeyed > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-medium">卡内样式移除取证（默认静默，仅真丢失才报警）</p>
          <p className="text-xs text-muted-foreground mt-1">
            本会话 {styleRemoval.events} 次取证事件 / {styleRemoval.keys} 个节点身份
            （静默汇总 {styleRemoval.suppressed} 条重复）；已判定真出问题 {styleRemoval.escalated} 个
            （刷出控制台 {styleRemoval.escalationReports} 条，超上限只记账 {styleRemoval.escalationReportsCapped} 条）；
            无法判定（帧不可达或文档已重建）{styleRemoval.probesSkipped} 次
            {styleRemoval.unkeyed > 0 ? `；无身份载荷 ${styleRemoval.unkeyed} 条` : ''}
          </p>
          <div className="text-xs border rounded-md divide-y overflow-hidden mt-2">
            {styleRemoval.entries.slice(0, 12).map((entry) => (
              <div key={entry.key} className="flex items-start justify-between gap-4 px-3 py-2">
                <div className="min-w-0">
                  <span className="font-mono">{entry.key}</span>
                  {entry.escalated ? (
                    <span className="text-destructive ml-2">已上报：{entry.escalationTrigger}</span>
                  ) : null}
                </div>
                <span className="shrink-0 tabular-nums">
                  {entry.count} 次（吞 {entry.suppressed}）
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground mt-2">
        也可在浏览器控制台访问 window.__palinkCompatStats、window.__palinkStyleRemovalAgg
        与 window.__palinkStyleRemovalSummary()
      </p>
    </div>
  );
}
