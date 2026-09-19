import { useEffect } from 'react';

/**
 * [iOS-HISTORY] 幽灵历史条目探针：只观测与记录，不改变任何导航行为。
 *
 * 背景：Safari 的会话历史是「联合」的（joint session history）——顶层框架与所有子框架
 * 的导航共用同一条历史列表。iframe 的每次导航（srcdoc 首次加载、重挂载、整页重载、
 * fragment 变化）都会往里插一条条目，而这些条目**不改变顶层 URL**，地址栏仍是当前页。
 * iOS 的边缘返回手势沿联合历史逐条 pop，于是表现为：先快速闪过 N 个与当前页一模一样
 * 的快照，最后才落到真正的上一级（上一级预览"是错的"）。
 *
 * 判定：popstate 时若 pathname + search 与上一次完全相同，说明刚穿过一条幽灵条目。
 * 计数用 console.warn 输出（production 构建的 pure_funcs 只剔除 console.log）。
 * 真机连 Safari 远程调试即可看到 [GHOST-HISTORY] 计数，用于验证修复效果；
 * 稳定为 0 即表示滑动返回不会再闪。
 */
export function useGhostHistoryProbe(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    let lastKey = `${window.location.pathname}${window.location.search}`;
    let ghostCount = 0;
    const handlePopState = () => {
      const key = `${window.location.pathname}${window.location.search}`;
      if (key === lastKey) {
        ghostCount += 1;
        console.warn(`[GHOST-HISTORY] 穿过一条幽灵历史条目（累计 ${ghostCount}）：${key}`);
        return;
      }
      lastKey = key;
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [enabled]);
}
