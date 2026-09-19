// 移动端 dock 滑块 ↔ 主页面轨道 的位置桥。
// p ∈ [0, 3]：0=对话 1=工作空间 2=角色扮演 3=设置。
// 拖动 dock 时滑块跟手但【不】改写 p（页面保持不动）；松手判定/点击/路由切换
// 时 Sidebar 用弹簧把 p 从当前页写到目标页并 emit。MobilePager 订阅后直接写各
// 槽位 transform（不经 React 渲染），页面弹簧动画 60fps 平滑滑入。
type PagerListener = () => void;

const listeners = new Set<PagerListener>();

export const mobilePager = {
  p: 0,
  emit(): void {
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: PagerListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
