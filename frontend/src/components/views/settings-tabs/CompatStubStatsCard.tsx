/**
 * ST 兼容层降级桩统计面板
 *
 * 渲染 compat-stub-registry 收集的降级调用统计，让"插件在跑但相关
 * ST API 是无操作桩"这一事实在 UI 上可见（阶段1：静默桩显性化）。
 * 无命中时不渲染任何内容。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import {
  getCompatStubStats,
  type CompatStubStat,
} from '@/lib/plugin-system/compat-stub-registry';

export function CompatStubStatsCard() {
  const [entries, setEntries] = useState<Array<[string, CompatStubStat]>>([]);

  const refresh = useCallback(() => {
    setEntries(Array.from(getCompatStubStats().entries()));
  }, []);

  useEffect(() => {
    refresh();
    // 统计由注入的插件脚本驱动，React 感知不到变化，低频轮询同步一次
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, stat]) => sum + stat.count, 0);

  return (
    <GlassCard className="p-4 sm:p-5">
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
      <p className="text-[11px] text-muted-foreground mt-2">
        也可在浏览器控制台访问 window.__palinkCompatStats
      </p>
    </GlassCard>
  );
}
