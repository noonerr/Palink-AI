// 移动端 dock 滑块 ↔ 主页面轨道 的连续位置桥。
// p ∈ [0, 3]：0=对话 1=工作空间 2=角色扮演 3=设置。
// dock 的拖动/弹簧每帧写入 p 并 emit；MobilePager 订阅后直接写各槽位
// transform（不经 React 渲染），保证两侧行逐帧同步、60fps 跟手。
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
