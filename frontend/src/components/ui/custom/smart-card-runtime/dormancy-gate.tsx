/*
 * 智能卡休眠门（T2）—— 从 Message.tsx 原样抽出（纯移动，行为零变化），
 * 目的：让「休眠 / 逐出 / 唤醒」这段接线可以被 jsdom 集成测试直接驱动
 * （伪造 IntersectionObserver），而不是只测纯逻辑内核 iframe-lru.ts。
 *
 * 2026-10-13 抽出背景：真机受控实验证明接线没生效（cap 从 16 降到 3，存活 iframe 一个没少），
 * 而单测只覆盖了策略内核 ⇒ 需要能对「组件 + 内核」的接缝写测试。
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { getSharedIframeLru } from './iframe-lru';

// [N-12] 出视口智能卡休眠：智能卡容器外包一层 IntersectionObserver（rootMargin 一屏缓冲）。
// 出视口 → 记录容器当前 offsetHeight → 让卡片休眠；重新入视口 → 恢复渲染。
// 仅包裹智能卡分支；普通文本/图片消息不参与。休眠状态不持久化（刷新即全部恢复）；
// 消毒在上游 pipelineResult 已完成，此处只做挂载/隐藏，与 N-1 不冲突。
// Observer 实例随组件卸载 disconnect（对齐 CodeBlock timer 清理模式）。
//
// [iOS-HISTORY] 休眠方式由「卸载 DOM」改为「隐藏 DOM」，默认不再卸载：
// 卸载后重新入视口会重建 iframe（srcDoc 重挂载）= 一次真实导航，而 Safari 的会话
// 历史是「联合」的（顶层 + 所有子框架），每次 iframe 导航都会往里面插一条幽灵条目
// （顶层 URL 不变，地址栏仍是当前页）。滑动返回 = 沿联合历史逐条 pop，于是先快速
// 闪过 N 个与当前页一模一样的快照，最后才回到真正的上一级。iOS 没有 API 删除已
// 存在的历史条目，只能从源头避免创建，因此这里保留 DOM、只做视觉休眠。
// 若确需恢复「卸载省内存」行为（超长会话内存吃紧），把下面常量置为 true 即可，
// 代价是重新引入 iframe 导航与 iOS 幽灵历史条目。
const PALINK_CARD_DORMANCY_UNMOUNT = false;

export function SmartCardDormancyGate({ children, cardId }: { children: React.ReactNode; cardId: string }) {
  // [T2 兜底 · 2026-10-13] cardId 由调用方算（`String(message.id ?? messageIndex ?? '')`），
  // 但 /chat 的两个渲染点（ChatViewMobile / ChatViewDesktop）**不传 messageIndex**，
  // 而 message.id 也可能为空（未落库的新消息）⇒ cardId 会落成**空串**，多张卡在 LRU 里
  // **共用一个条目** ⇒ registry size 永远小于卡数 ⇒ 配额形同虚设。
  // 这里用 useId（每个组件实例稳定且唯一）兜底，保证任何情况下配额身份不塌陷。
  const fallbackId = useId();
  const quotaId = cardId || `anon-${fallbackId}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dormant, setDormant] = useState(false);
  const [dormantHeight, setDormantHeight] = useState<number | null>(null);
  // [T2 2026-10-13] 被 LRU 配额逐出：与"出视野即卸载"同分支（等高占位），
  // 但只有**超出配额**才发生 —— 普通会话永不触发，iOS 上也不会每次滚动都重建 iframe。
  const [evicted, setEvicted] = useState(false);
  const lruRef = useRef(getSharedIframeLru());

  // 只做退订；**登记交给第一次 IntersectionObserver 上报**（见下面 IO 回调）。
  // 为什么不在挂载时就 register(cardId, false)：那时可见性还未知，注册成"隐藏项"
  // 会让一张其实在视口内的新卡被别的卡触发的逐出顺手卸掉（卸载即 iframe 重建 = 一次
  // 导航），而它的 IO 回调随后才到。状态未知的卡不进内核，就永远不会被误逐出。
  useEffect(() => {
    const lru = lruRef.current;
    return () => {
      lru.unregister(quotaId);
    };
  }, [quotaId]);

  // 被内核逐出时，由内核主动通知本人（不是"自己检查自己是不是受害者"——
  // 受害者按定义是更早变隐藏的那张卡，它的 IO 回调早已跑完，永远等不到第二次机会）。
  useEffect(() => {
    const lru = lruRef.current;
    return lru.onEviction(quotaId, () => {
      // 兜底量高：正常路径下休眠分支已经量过；这里只处理"从未量过"的边角，
      // 免得占位高度为 undefined 造成滚动条跳动。
      const h = containerRef.current?.offsetHeight ?? 0;
      if (h > 0) setDormantHeight((prev) => (prev != null && prev > 0 ? prev : h));
      setEvicted(true);
    });
  }, [quotaId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const lru = lruRef.current;
    // rootMargin 一屏缓冲：上下各扩一个视口高度，快速滚动时提前唤醒/延迟休眠
    const buffer = Math.max(window.innerHeight || 0, 480);
    // [PERF-2026-10-07 回归修复] 唤醒重绘踢（repaintKick）已删除。
    //
    // 删除理由（两条，任一条独立成立）：
    //
    // 1) 它声称要修的现象不存在。`REPORT_历史消息样式丢失_深度窗根因_2026-10-07.md`
    //    已证明"历史消息样式丢失"的真根因是角色卡正则的 maxDepth 深度窗，窗口外的
    //    消息压根没有生成 iframe —— 没有 iframe 可休眠、可重绘，这个踢在结构上就
    //    不可能修好它声称要修的东西。且 `content-visibility: hidden` 已在本轮移除，
    //    "浏览器跳过整棵子树渲染"这个载体随之消失；只剩 `visibility: hidden` 时，
    //    从 hidden 切到 visible 必然走主线程重绘，无需外力触发。
    //
    // 2) 它自己会制造自激闪烁。原实现把内层 div `display: none` 一帧再恢复，而该元素
    //    同时是下面这个 IntersectionObserver 的观察目标：display:none 让高度瞬间归零
    //    → 观察器立刻报"离开视口" → 走休眠分支（此刻 offsetHeight 为 0，dormantHeight
    //    被置 null）→ 高度恢复后观察器又报"进入视口" → 又 kick → 无限循环。
    //    真机表现为：卡片外框位置/高度不变，框内正文在"有→无→有"之间持续闪。
    //    `transform` 版本不破坏布局所以没暴露这个问题，改成 `display` 才引爆。
    //
    // ⚠️ 若将来真机复测发现"休眠唤醒后正文空白"回归，**禁止再用 display 切换**：
    // 它一定破坏布局并再次触发上面的观察器闭环。改用不改变几何的手段（例如只对
    // iframe 自身触发一次重排，或 visibility 翻转 + 读一次 offsetHeight 强制同步
    // 布局），并先确认观察器不会再收到 not-intersecting。
    let dormantNow = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const shouldSleep = !entry.isIntersecting;
        // 状态未变化 → 直接忽略。观察器在 rootMargin 边界附近会因布局的微小变化反复
        // 上报同一状态；无守卫时每次上报都要走一遍休眠/唤醒副作用（含 setState）。
        if (shouldSleep === dormantNow) continue;
        if (shouldSleep) {
          // 测不到高度就休眠 = 该消息行在文档流里塌陷，滚动条长度会突变。宁可不休眠，
          // 也不要制造一次布局抖动（配合 `overflow-anchor: none` 时，滚动位置不会被
          // 浏览器补偿）。
          const measured = el.offsetHeight > 0
            ? el.offsetHeight
            : Math.round(entry.boundingClientRect.height);
          if (measured <= 0) continue;
          dormantNow = true;
          setDormantHeight(measured);
          setDormant(true);
          // [T2 2026-10-13] 出视野：登记（首次上报）并标为不可见；逐出**由内核统一执行**，
          // 可能逐出的是别的卡（由订阅通知它们），所以这里不判断"受害者是不是我"。
          lru.register(quotaId, false);
          lru.markVisible(quotaId, false);
          lru.enforceCap();
        } else {
          dormantNow = false;
          setDormant(false);
          // [T2] 回到视野：重新登记为可见（可见项永不逐出），并立刻恢复渲染。
          // ⚠️ 不能只调 register：它对**已注册**条目是幂等空操作，不会把 visible 翻真，
          // 也不会刷新 lastSeen ⇒ 可见项会被当成隐藏项（真机 lruVisible 恒为 0 的成因，
          // 2026-10-13 受控实验 cap=16→3 存活 iframe 一个没少）。必须先 register 兜住
          // "曾被逐出、已不在册"的情况，再 markVisible 刷新可见性与 LRU 时间戳。
          lru.register(quotaId, true);
          lru.markVisible(quotaId, true);
          lru.enforceCap(); // 唤醒会重新占一个名额，可能把在册数推过配额 ⇒ 再逐出最久未见的隐藏项
          setEvicted(false);
        }
      }
    }, { rootMargin: `${buffer}px 0px ${buffer}px 0px` });
    observer.observe(el);
    return () => observer.disconnect();
  }, [quotaId]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      data-palink-card-dormancy={dormant ? 'sleeping' : 'awake'}
      // 真机取证用（生产包 console 被 terser 剥光，只能靠 DOM 信号）：把本门的配额身份写在 DOM 上，
      // 便于把 window.__palinkIframeLru 的快照与页面上的卡片一一对应。
      data-palink-card-gate-id={quotaId}
      data-palink-card-evicted={evicted ? 'true' : undefined}
    >
      {PALINK_CARD_DORMANCY_UNMOUNT && dormant || evicted ? (
        <div aria-hidden="true" style={{ height: dormantHeight != null ? `${dormantHeight}px` : undefined }} />
      ) : (
        // 隐藏而非卸载：保留 iframe 文档，重新入视口不产生新导航（不新增历史条目）。
        //
        // [PERF-2026-10-07 修正] 已移除 `content-visibility: hidden`。
        // 它不只是"看不见"，而是让浏览器**跳过整棵子树的渲染工作** —— 这正是
        // "iframe 在隐藏态加载完成、唤醒后不重绘"的载体（分支切换后正文整块空白的成因）。
        // 休眠的初衷只是避免 iframe 重建（iOS 幽灵历史条目），`visibility: hidden`
        // 已经满足该诉求：它不改变"是否需要渲染"的语义，退化为纯视觉隐藏。
        // 代价：失去 content-visibility 省下的那部分渲染开销；
        // 收益：彻底消除"休眠态加载 → 唤醒空白"这一整类问题。
        <div
          aria-hidden={dormant || undefined}
          style={dormant ? ({
            height: dormantHeight != null ? `${dormantHeight}px` : undefined,
            overflow: 'hidden',
            visibility: 'hidden',
          } as React.CSSProperties) : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}
