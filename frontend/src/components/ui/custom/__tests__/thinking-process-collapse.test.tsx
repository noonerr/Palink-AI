/**
 * [P4 2026-10-06] 思考框收合策略与计时回归测试。
 *
 * 需求（用户拍板）：
 * ① 思考框默认折叠（原先流式时自动展开，是反的）；
 * ② 标题显示「已思考 X 秒」计时，流式结束后冻结；
 * ③ 用户主动点击才展开；
 * ④ 折叠状态下思考结束 → 保持折叠；
 * ⑤ 展开状态下思考结束 → 自动折叠。
 *
 * 「思考结束」的信号是 reasoningEnded（正文开始输出，Message 侧计算），不是 streaming
 * 翻转——isGenerating 在整轮生成期间恒为 true，思考结束、正文开始时它并不翻转，
 * 用 streaming 翻转判定会拖到整轮结束才收合（排查报告 §4.3 判定的触发时机缺陷）。
 *
 * 用 react-dom/client + React.act 真实挂载（项目惯例，不引 testing-library）。
 * 可观测面：内容包裹层 className 的 opacity-0/opacity-100（折叠/展开）与
 * maxHeight '0px'；标题文本的「已思考 X 秒」。
 * **反证**：把 ThinkingProcess 的默认值翻回 `!!streaming`，或把 reasoningEnded
 * 转变收合 effect 改回 streaming 翻转判定，对应断言立刻变红。
 *
 * 注意：thinkingExpandedState 是模块级 Map，用例间必须用唯一 messageKey 隔离，
 * 否则前一个用例的手动展开会污染后一个用例的初始态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThinkingProcess } from '@/components/ui/custom/ThinkingProcess';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

function mount(props: React.ComponentProps<typeof ThinkingProcess>): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ThinkingProcess {...props} />);
  });
  return container;
}

function rerender(props: React.ComponentProps<typeof ThinkingProcess>) {
  act(() => {
    root!.render(<ThinkingProcess {...props} />);
  });
}

// 每个用例唯一 messageKey：模块级 thinkingExpandedState 会跨用例残留
let keySeq = 0;
const baseProps = () => ({
  t: {},
  messageKey: `msg-${++keySeq}`,
});

function contentLayer(el: HTMLElement): HTMLElement | null {
  // 内容包裹层：opacity-0/opacity-100 + maxHeight 都挂在这一层
  return el.querySelector('.will-change-\\[max-height\\,opacity\\]');
}

function clickTitle(el: HTMLElement) {
  const button = el.querySelector('button')!;
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('ThinkingProcess 收合策略（P4）', () => {
  it('需求①：流式期间默认折叠，不自动展开', () => {
    const el = mount({ ...baseProps(), content: '', streaming: true });
    const layer = contentLayer(el);
    expect(layer).not.toBeNull();
    expect(layer!.className).toContain('opacity-0');
    expect(layer!.style.maxHeight).toBe('0px');
  });

  it('需求②：流式期间标题逐秒显示「已思考 X 秒」，结束后冻结', () => {
    vi.useFakeTimers();
    const el = mount({ ...baseProps(), content: '', streaming: true });
    const button = el.querySelector('button')!;
    expect(button.textContent).toContain('已思考 0 秒');
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(button.textContent).toContain('已思考 3 秒');
    // 思考结束：读数冻结在 3 秒（不归零、不清除）
    rerender({ ...baseProps(), content: '思考完了', streaming: false });
    expect(button.textContent).toContain('已思考 3 秒');
  });

  it('需求③：点击标题展开，内容层转 opacity-100', () => {
    const el = mount({ ...baseProps(), content: '思考中...', streaming: true });
    clickTitle(el);
    const layer = contentLayer(el);
    expect(layer!.className).toContain('opacity-100');
  });

  it('需求④：折叠状态下思考结束（reasoningEnded 翻 true，streaming 仍 true）→ 保持折叠', () => {
    const el = mount({ ...baseProps(), content: '', streaming: true, reasoningEnded: false });
    rerender({ ...baseProps(), content: '思考完了', streaming: true, reasoningEnded: true });
    const layer = contentLayer(el);
    expect(layer!.className).toContain('opacity-0');
    expect(layer!.style.maxHeight).toBe('0px');
  });

  it('需求⑤：展开状态下思考结束（reasoningEnded 翻 true）→ 自动折叠', () => {
    const el = mount({ ...baseProps(), content: '思考中...', streaming: true, reasoningEnded: false });
    clickTitle(el);
    expect(contentLayer(el)!.className).toContain('opacity-100');
    // 正文开始：reasoningEnded 翻 true，streaming 仍 true（isGenerating 整轮恒 true）
    rerender({ ...baseProps(), content: '思考完了', streaming: true, reasoningEnded: true });
    const layer = contentLayer(el);
    expect(layer!.className).toContain('opacity-0');
    expect(layer!.style.maxHeight).toBe('0px');
  });

  it('streaming 翻转（整轮结束）不是收合信号：reasoningEnded 未触发的展开态保持展开', () => {
    // 纯思考无正文等 reasoningEnded 从未翻 true 的场景：整轮结束不自动收合，
    // 展开与否交还给用户（需求③）。
    const el = mount({ ...baseProps(), content: '只有思考', streaming: true, reasoningEnded: false });
    clickTitle(el);
    expect(contentLayer(el)!.className).toContain('opacity-100');
    rerender({ ...baseProps(), content: '只有思考', streaming: false, reasoningEnded: false });
    expect(contentLayer(el)!.className).toContain('opacity-100');
  });

  it('思考结束后用户手动重新展开 → 整轮结束不再自动折叠（需求③）', () => {
    const el = mount({ ...baseProps(), content: '思考中...', streaming: true, reasoningEnded: false });
    // 正文开始 → 自动折叠（需求⑤）
    rerender({ ...baseProps(), content: '思考完了', streaming: true, reasoningEnded: true });
    expect(contentLayer(el)!.className).toContain('opacity-0');
    // 用户手动重新展开
    clickTitle(el);
    expect(contentLayer(el)!.className).toContain('opacity-100');
    // 整轮结束（streaming 翻转）不折叠用户的主动选择
    rerender({ ...baseProps(), content: '思考完了', streaming: false, reasoningEnded: true });
    expect(contentLayer(el)!.className).toContain('opacity-100');
  });

  it('历史消息（挂载即 streaming=false）保持折叠且标题回退', () => {
    const el = mount({ ...baseProps(), content: '一段已完成的思考', streaming: false });
    const layer = contentLayer(el);
    expect(layer!.className).toContain('opacity-0');
    const button = el.querySelector('button')!;
    // 无计时数据（elapsedSeconds=0）：标题回退为 t.thinking
    expect(button.textContent).toContain('Thinking');
  });
});
