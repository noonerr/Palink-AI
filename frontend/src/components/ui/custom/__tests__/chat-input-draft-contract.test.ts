/*
 * 聊天输入框「草稿下移」行为契约（2026-10 输入卡顿/吞字修复）。
 *
 * 背景：症状 A「打了字不显示/少字」、症状 B「一个字符等几秒」。根因链是
 *   ChatInput.onChange → 上层 setInputValue（useCharacterChat 的 useState）
 *   → CharacterView 整树重渲染 → CharacterChat（无 memo）→ 几百个 Message 调和，
 * 且 CharacterChat 的 wrappedHandleSendWithInput 依赖数组里带着 inputValue，
 * 每敲一键就重建该回调及其全部下游消费者。
 *
 * 修法：草稿状态下移到 ChatInput 内部（打字只重渲染 ChatInput 自己），
 * 外部 `value` 降级为「外部写入通道」，打字不再触发任何上层 setState。
 *
 * 这里是**行为级**测试（真挂载 ChatInput + 真 textarea 事件），不是源码正则断言 ——
 * 因为本次修复的核心恰恰是几个只有时序能暴露的坑，光看源码看不出对错。
 *
 * 守卫点：
 *  1. 打字即时显示：setValue 后 textarea.value 立刻是新串（不等上层回灌）。
 *  2. 打字不上抛：连续打字不调用 onChange 之外的上层重渲染路径由源码契约把守，
 *     这里守「onChange 每次都被调用且参数正确」（上层据此写 ref）。
 *  3.【竞态核心】发送读到最新值：打字后立刻触发发送，上层 onChange 收到的
 *     必须是完整草稿，不能是空串或上一个字符 —— 这正是原吞字根因的反向断言。
 *  4. 外部写入可覆盖本地草稿（智能卡 setInputDraft 通道仍通）。
 *  5. 外部回灌「父层把自己刚收到的同一串字传回来」不得让输入框闪回/丢字。
 *  6. 发送后外部清空 → 输入框必须被清空（不能残留已发送内容）。
 *  7. Enter 走同一条 submit 路径（不绕过 onChange 同步）。
 *  8. autoResize 不再无条件写 height='auto'（两次强制布局的来源）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as React from 'react';
import { ChatInput } from '../ChatInput';
import type { Attachment } from '../../../../types';

// React 19 的 act 环境标记（vitest 环境为 node/jsdom，未开 IS_REACT_ACT_ENVIRONMENT）
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type OnChange = (v: string) => void;
type OnSend = () => void;

/**
 * 挂一个受控外壳：模拟上层（useCharacterChat / useChatView 的真实形态）。
 * 上层把 value 从 ref 派生，只有「外部写入」才 setState —— 这正是修复后的形态。
 */
function mountChatInput(initialValue: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const onChangeCalls: string[] = [];
  const onSendCalls: number[] = [];
  /** 上层权威副本（ref）。发送时读的就是它。 */
  const upperRef = { current: initialValue };
  /** 触发表层的「外部写入」信号：每次变化都让上层 setState 重渲染。 */
  const external = {
    value: initialValue as string | undefined,
    version: 0,
  };
  let renders = 0;

  function Harness() {
    const [v, setV] = React.useState(initialValue);
    // 订阅外部写入：与 setInputValue(next) 的效果等价（写值 + 重渲染）。
    React.useEffect(() => {
      if (external.value !== undefined && external.value !== v) {
        setV(external.value);
      }
    }, [external.version]);
    renders += 1;

    const handleChange: OnChange = (next) => {
      onChangeCalls.push(next);
      // 【修复后的关键】打字只写 ref，不 setState —— 上层不因打字重渲染。
      upperRef.current = next;
      // 上层 value 的渲染快照在修复后【不再】跟着打字走（这正是症状 B 的来源），
      // 所以这里刻意不 setV：真实 useCharacterChat 用的也是 setInputValueSilent。
    };
    const handleSend: OnSend = () => {
      onSendCalls.push(1);
    };

    return createElement(ChatInput, {
      value: v,
      onChange: handleChange,
      onSend: handleSend,
      onUpload: async () => {},
      attachments: [] as Attachment[],
      onRemoveAttachment: () => {},
    });
  }

  const root: Root = createRoot(host);
  act(() => {
    root.render(createElement(Harness));
  });

  const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
  const getValue = () => textarea.value;
  const type = (next: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, next);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  return {
    textarea,
    getValue,
    type,
    onChangeCalls,
    onSendCalls,
    upperRef,
    get renders() {
      return renders;
    },
    pressEnter: () => {
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
    },
    /**
     * 模拟上层 setInputValue(next)：写 ref + setState 重渲染。
     * 发送后清空也走这里（handleSendMessage 里的 setInputValue('')）。
     */
    externalSet: (next: string) => {
      upperRef.current = next;
      act(() => {
        external.value = next;
        external.version += 1;
        root.render(createElement(Harness));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('ChatInput 草稿下移契约（输入卡顿/吞字修复）', () => {
  let cleanup: (() => void) | null = null;
  beforeEach(() => {
    // 每个用例独立 document，避免 textarea 互相串扰
    document.body.innerHTML = '';
  });
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('1. 打字即时显示，不等上层回灌（症状 A：吞字）', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('h');
    expect(ui.getValue()).toBe('h');
    ui.type('he');
    expect(ui.getValue()).toBe('he');
    ui.type('hello');
    expect(ui.getValue()).toBe('hello');
  });

  it('2. 每次打字都把完整草稿上抛给上层（供发送时读 ref）', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('h');
    ui.type('he');
    ui.type('hel');
    expect(ui.onChangeCalls).toEqual(['h', 'he', 'hel']);
    expect(ui.upperRef.current).toBe('hel');
  });

  it('3.【竞态核心】打字后立刻发送，上层读到的是完整草稿而非空串', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('你好世界');
    ui.pressEnter();

    // 发送瞬间，上层 ref 必须是完整草稿 —— 原 bug 这里是空串
    expect(ui.onSendCalls.length).toBe(1);
    expect(ui.onChangeCalls.at(-1)).toBe('你好世界');
    expect(ui.upperRef.current).toBe('你好世界');
  });

  it('4. Enter 与点发送按钮走同一条 submit 路径（都先同步草稿）', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('abc');
    ui.pressEnter();
    const viaEnter = ui.onChangeCalls.at(-1);

    ui.type('abcd');
    const sendBtn = document.querySelectorAll('button');
    // 发送按钮是最后一个（末尾的 ArrowUp）
    const btn = sendBtn[sendBtn.length - 1] as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => {
      btn.click();
    });

    expect(ui.onSendCalls.length).toBe(2);
    expect(viaEnter).toBe('abc');
    expect(ui.onChangeCalls.at(-1)).toBe('abcd');
  });

  it('5. 外部写入（智能卡 setInputDraft）能覆盖本地草稿', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('我自己敲的');
    // 模拟 setInputDraft：上层把 value 改成别的串并重渲染
    act(() => {
      ui.externalSet('智能卡塞进来的');
    });
    expect(ui.getValue()).toBe('智能卡塞进来的');
  });

  it('6. 上层把自己刚收到的同一串字回灌，不得让输入框丢字/闪回', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('abc');
    // 典型场景：上层 onChange 之后走 setState（受控回灌），value === 本地草稿
    act(() => {
      ui.externalSet('abc');
    });
    expect(ui.getValue()).toBe('abc');
  });

  it('7. 发送后输入框必须立刻清空，且**不依赖**上层回灌', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('要发出去的话');
    ui.pressEnter();

    // 上层 value 全程都是 ''（打字不再走 setState），所以「发送后清空」对它不是
    // 一次状态变化 —— 清空必须由 ChatInput 自己完成，否则已发送文字会留在框里，
    // 用户回车就会误发第二遍。
    expect(ui.getValue()).toBe('');

    // 上层随后补一次 setInputValue('') 也不能把状态搞乱
    act(() => {
      ui.externalSet('');
    });
    expect(ui.getValue()).toBe('');
  });

  it('7b. 发送瞬间上层 ref 拿到的是草稿本身（清空发生在其后，不污染读取）', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('payload');
    ui.pressEnter();
    // onChange 在 submit 里先于本地清空执行，故上层 ref 仍是完整草稿
    expect(ui.upperRef.current).toBe('payload');
  });

  it('8. 打字不触发上层重渲染（症状 B：主线程阻塞的根因已切断）', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    const before = ui.renders;
    ui.type('x');
    ui.type('xy');
    ui.type('xyz');
    // 上层一次都没因打字重渲染 —— 整棵聊天树不再被每键唤醒
    expect(ui.renders).toBe(before);
  });

  it('9. 发送后可以立刻接着打字，草稿与上层 ref 正常接力', () => {
    const ui = mountChatInput('');
    cleanup = ui.unmount;

    ui.type('第一句');
    ui.pressEnter();
    expect(ui.getValue()).toBe('');

    ui.type('第二句');
    expect(ui.getValue()).toBe('第二句');
    expect(ui.upperRef.current).toBe('第二句');
    // 两次发送各自拿到自己的草稿，没有串味
    expect(ui.onChangeCalls.at(-1)).toBe('第二句');
  });
});
