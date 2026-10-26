/**
 * [P2-3 方案B 2026-10-26] 聊天气泡宽度契约：用户气泡 98% 上限 + 短消息按内容收缩。
 *
 * 背景（docs/OPEN_ISSUES.md P2-3 实测）：396px 屏下 AI 正文列 388px（屏宽 98%）
 * vs 用户气泡 349px（屏宽 88%），差 39px —— 病灶是用户外层气泡的
 * `max-w-[90%] md:max-w-[75%] lg:max-w-[65%]`。
 * 定案（主脑）：只放宽用户气泡（98%），**AI 正文列与卡片 iframe 宽度一律不动**。
 *
 * 本文件守三件事：
 * 1. 用户气泡外层：`max-w-[98%]` + `w-fit`（width:fit-content）同时存在，
 *    且旧的三档上限（90/75/65%）已消失、没有任何 `min-w-*` 把短消息撑开；
 * 2. 正文断行能力仍在（break-words + 真正生效的 overflow-wrap:anywhere），
 *    长英文单词 / URL 不会横向溢出，也不至于把短消息的 min-content 顶宽；
 * 3. AI 侧宽度类逐字节没动（bubbles 主题仍是 90/75/65% 上限，正文列仍 flex-1 min-w-0）。
 *
 * jsdom 没有布局引擎，量不出真实像素，故断言的是「决定布局的类」——这些类的
 * 组合语义（fit-content 收缩 + 98% 封顶）才是这次改动的契约本身。
 *
 * 运行: npx vitest run src/components/ui/custom/__tests__/message-bubble-width.test.tsx
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Message } from '@/components/ui/custom/Message';
import type { Message as MessageType } from '@/types';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

const SHORT_TEXT = '好';
const LONG_TEXT =
  '这是一条长消息，用来覆盖「超过一行显示宽度」时的表现：' +
  'https://example.com/a/very/long/url/without/any/spaces/that/never/breaks/'
  + 'x'.repeat(120);

function userMessage(content: string): MessageType {
  return { id: 'u_1', role: 'user', content };
}

function assistantMessage(content: string): MessageType {
  return { id: 'a_1', role: 'assistant', content };
}

/** 消息行 `.mes`（本组件最外层）。 */
function mesRow(el: HTMLElement): HTMLElement {
  const row = el.querySelector('.mes') as HTMLElement | null;
  expect(row).not.toBeNull();
  return row!;
}

/** 宽度包装层：`.mes` 下第一个元素（用户消息没有头像列，第一个就是包装层）。 */
function bubbleWrapper(el: HTMLElement): HTMLElement {
  const wrapper = mesRow(el).firstElementChild as HTMLElement | null;
  expect(wrapper).not.toBeNull();
  return wrapper!;
}

describe('[P2-3] 用户气泡宽度', () => {
  it('短消息：98% 封顶 + fit-content 收缩，且没有 min-width 把它撑开', async () => {
    const el = await mount(
      <Message message={userMessage(SHORT_TEXT)} t={{}} chatStyle="flat" />,
    );

    const wrapper = bubbleWrapper(el);
    // 上限 98%（相对消息列 .mes，396px 屏下即 ~380px，右边界与 AI 列对齐）
    expect(wrapper.className).toContain('max-w-[98%]');
    // 按内容收缩：width: fit-content（不是固定宽度、不是 w-full）
    expect(wrapper.className).toContain('w-fit');
    expect(wrapper.className).not.toContain('w-full');
    // 旧的三档上限必须消失（39px 差的来源）
    expect(wrapper.className).not.toContain('max-w-[90%]');
    expect(wrapper.className).not.toContain('max-w-[75%]');
    expect(wrapper.className).not.toContain('max-w-[65%]');
    // 不许用固定 min-width 撑开短消息
    expect(wrapper.className.split(/\s+/).some((c) => /^min-w-(?!0$)/.test(c))).toBe(false);
    // 右对齐不变
    expect(mesRow(el).className).toContain('justify-end');
  });

  it('长消息：仍被 98% 截住，正文具备断行能力（含长 URL 不横向溢出）', async () => {
    const el = await mount(
      <Message message={userMessage(LONG_TEXT)} t={{}} chatStyle="flat" />,
    );

    const wrapper = bubbleWrapper(el);
    expect(wrapper.className).toContain('max-w-[98%]');
    // 长消息同样带 w-fit —— fit-content 的语义是「取 max-content，但被 max-width 截断」，
    // 所以两档超长时会停在 98%，而不是溢出。
    expect(wrapper.className).toContain('w-fit');

    // 内容容器（.mes_text）：不横向溢出
    const text = el.querySelector('.mes_text') as HTMLElement | null;
    expect(text).not.toBeNull();
    expect(text!.className).toContain('break-words');
    // 真正生效的 overflow-wrap:anywhere（`overflow-wrap-anywhere` 在本仓无对应工具类，
    // 是个哑类；fit-content 下 min-content 由它决定，长 URL 不能把气泡顶到 98%）
    expect(text!.className).toContain('[overflow-wrap:anywhere]');
    const contentBox = text!.closest('.relative') as HTMLElement | null;
    expect(contentBox).not.toBeNull();
    expect(contentBox!.className).toContain('max-w-full');
    expect(contentBox!.className).toContain('w-full');
  });

  it('编辑态：切换为 w-full（保留 98% 上限），不把编辑框压成 textarea 的内在宽度', async () => {
    const el = await mount(
      <Message message={userMessage(SHORT_TEXT)} t={{}} chatStyle="flat" onEdit={() => {}} />,
    );

    expect(bubbleWrapper(el).className).toContain('w-fit');

    const editButton = el.querySelector('button[aria-label="编辑消息"]') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    act(() => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const wrapper = bubbleWrapper(el);
    expect(wrapper.className).toContain('w-full');
    expect(wrapper.className).not.toContain('w-fit');
    expect(wrapper.className).toContain('max-w-[98%]');

    const textarea = el.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe(SHORT_TEXT);
  });
});

describe('[P2-3] AI 正文列宽度未被改动', () => {
  it('非 bubbles 主题：AI 列仍是 w-full 的 items-start 行，没有 98% / fit-content', async () => {
    const el = await mount(
      <Message message={assistantMessage('你好')} t={{}} chatStyle="flat" isCharacterChat />,
    );

    const wrapper = bubbleWrapper(el);
    expect(wrapper.className).toContain('w-full');
    expect(wrapper.className).not.toContain('w-fit');
    expect(wrapper.className).not.toContain('max-w-[98%]');

    // 正文列（mes_block）仍是 flex-1 min-w-0，且不带宽度上限
    const block = el.querySelector('.mes_block') as HTMLElement | null;
    expect(block).not.toBeNull();
    expect(block!.className).toContain('flex-1');
    expect(block!.className).toContain('min-w-0');
    expect(block!.className).not.toContain('max-w-[98%]');
  });

  it('bubbles 主题：AI 气泡仍保留 90/75/65% 三档上限（未被一并放宽）', async () => {
    const el = await mount(
      <Message message={assistantMessage('你好')} t={{}} chatStyle="bubbles" isCharacterChat />,
    );

    const wrapper = bubbleWrapper(el);
    expect(wrapper.className).toContain('max-w-[90%]');
    expect(wrapper.className).toContain('md:max-w-[75%]');
    expect(wrapper.className).toContain('lg:max-w-[65%]');
    expect(wrapper.className).not.toContain('max-w-[98%]');
  });
});
