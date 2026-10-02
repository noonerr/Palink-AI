// 移动端 dock 滑块 ↔ 主页面轨道 的位置桥。
// p ∈ [0, 3]：0=对话 1=工作空间 2=角色扮演 3=设置。
// 拖动 dock 时滑块跟手但【不】改写 p（页面保持不动）；松手判定/点击/路由切换
// 时 Sidebar 把 p 写到目标页并 emit(animate=true)，MobilePager 订阅后给各槽位
// 挂 CSS transition 再直写最终 transform——吸附动画在合成器上跑（跟随面板
// 120Hz）。【K21g 2026-10-01】此前是 framer-motion JS 弹簧逐帧 emit（rAF 驱动，
// WebApp 内 rAF 实测 60Hz ⇒ 页面切换 60fps、原生滚动却 120 的割裂即源于此）。
type PagerListener = (animate?: boolean) => void;

const listeners = new Set<PagerListener>();

export const mobilePager = {
  p: 0,
  emit(animate = false): void {
    listeners.forEach((listener) => listener(animate));
  },
  subscribe(listener: PagerListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
