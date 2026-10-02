// [CONTENT-UNLOCK 2026-09-30] prefersAvailableHeight 卡的内容高度解锁判定。
//
// 背景：htmlUsesViewportHeight 命中（如卡片 body{min-height:100vh}）的卡走「按可用空间
// 渲染」模式，iframe 高度=卡片顶→输入框顶的视口切片，与内容高度无关——该边界本意是
// 防 pinned-vh 界面卡（body height:100vh）在内容测量模式下形成 100vh 正反馈。
// 但 min-height:100vh 的流式长文卡（正文美化/故事卡）也被扫进该模式：内容高度上报
// （帧内 realContent，已带 fixed 装饰层排除/裁切修正/去抖防反馈）被父页面直接丢弃，
// 正文永远被视口切片截断（"点一下才多显示一点"= click→focusin→updateAvailableHeight 重适配）。
//
// 规则：
//   - 帧内上报 realContent ≥ 当前可用空间 + 阈值 → 解锁，改按内容高渲染（follow 后续上报）；
//   - pinned 界面卡的 realContent ≤ 帧内视口高 ≈ 可用空间 → 永不解锁，行为不变；
//   - 解锁是单向的（本次挂载生命周期内不回退）：可用空间随滚动变化，若按它回退会在
//     「内容高↔切片高」两支间互相推（历史 HEIGHT-OSCILLATION 同款极限环）；内容高本身
//     与滚动无关，follow 它恒稳定。卡片源变更（sourceFingerprint→iframe 重建）时由
//     调用方重置解锁态，重新从可用空间模式起步。

import { IFRAME_INLINE_MAX_HEIGHT, INLINE_MIN_HEIGHT, SMART_CARD_AVAILHEIGHT_UNLOCK_MARGIN_PX } from './shared';

export type AvailableHeightResizeDecision =
  | { action: 'follow-content'; height: number }
  | { action: 'unlock-content'; height: number }
  | { action: 'keep-available-height' };

/** 解锁态采用的高度夹取：[INLINE_MIN_HEIGHT, IFRAME_INLINE_MAX_HEIGHT]，与内联卡上限一致。 */
export function clampSmartCardOverrideHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  return Math.min(Math.max(Math.ceil(height), INLINE_MIN_HEIGHT), IFRAME_INLINE_MAX_HEIGHT);
}

export function resolveAvailableHeightCardResize(params: {
  /** 帧内 resize 上报的 height 字段（postMessage 主通道，恒存在且有限）。 */
  reportedHeight: number;
  /** 帧内上报的 realContent 字段；缺省/无效传 0。vh 卡（本分支全部人口）恒携带。 */
  reportedRealContent: number;
  /** 当前可用空间（stableAvailableHeightRef，随滚动更新的视口切片高度）。 */
  currentAvailableHeight: number;
  /** 是否已处于内容高解锁态。 */
  overrideActive: boolean;
}): AvailableHeightResizeDecision {
  // realContent 优先：vh 卡的 height 与 realContent 同源，但 realContent 语义明确是
  // 「排除装饰层/裁切修正后的真实内容高度」；缺失时（防御）退回 height。
  const reported = params.reportedRealContent > 0
    ? params.reportedRealContent
    : params.reportedHeight;
  if (params.overrideActive) {
    return reported > 0
      ? { action: 'follow-content', height: clampSmartCardOverrideHeight(reported) }
      : { action: 'keep-available-height' };
  }
  // 可用空间未知（首帧几何未就绪）时不解锁，维持现状，等下一次上报再判。
  if (!(params.currentAvailableHeight > 0)) return { action: 'keep-available-height' };
  if (reported >= params.currentAvailableHeight + SMART_CARD_AVAILHEIGHT_UNLOCK_MARGIN_PX) {
    const height = clampSmartCardOverrideHeight(reported);
    if (height > 0) return { action: 'unlock-content', height };
  }
  return { action: 'keep-available-height' };
}
