/*
 * 包 F F-2 · 新补 ST 命令的确定性契约（2026-10-18）
 *
 * 每条命令一个用例，期望值抄自 ST 1.18 参照源码（注释里写明出处文件与行号），
 * 不是"实现完再照着实现编期望"。薄转发两条（translate / summarize）用 vi.mock 打桩
 * `@/services/api` ⇒ 测试零网络、零计费（红线）。
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/st-compat-commands-f2-contract.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock('@/services/api', () => ({ api: apiMock }));

import { SlashCommandEngine } from '@/lib/slash-engine';
import { ensureSlashCommandsBootstrapped } from '@/lib/slash-engine/bootstrap';
import { ST_118_COMMAND_NAMES } from '@/lib/slash-engine/st-command-catalog';

ensureSlashCommandsBootstrapped();

const run = async (input: string) => (await SlashCommandEngine.execute(input)).output;

describe('F-2 trimend（ST utils.js:883 trimToEndSentence）', () => {
  it('ST JSDoc 自带用例：尾句不完整就切到上一个句末标点', async () => {
    // utils.js:878 示例：trimToEndSentence('Hello, world! I am from') → 'Hello, world!'
    expect(await run('/trimend Hello, world! I am from')).toBe('Hello, world!');
  });

  it('中文标点 。 也在集合里；无标点时只 trimEnd', async () => {
    expect(await run('/trimend 你好。世界')).toBe('你好。');
    // 整串没有标点 → last=-1 → input.trimEnd()
    expect(await run('/trimend abc')).toBe('abc');
  });

  it('空输入返回空串（slash-commands.js:2881 trimEndCallback 的 !value 分支）', async () => {
    expect(await run('/trimend')).toBe('');
  });
});

describe('F-2 trimstart（ST utils.js:914 trimToStartSentence）', () => {
  it('ST helpString 用例：切掉第一个句号之前的内容', async () => {
    // slash-commands.js:2858 示例：/trimstart This is a sentence. And here is another sentence.
    expect(await run('/trimstart This is a sentence. And here is another sentence.'))
      .toBe('And here is another sentence.');
  });

  it('照抄 ST 的怪癖：没有 . 时 ! 和 ? 不当切点（first 起点取 indexOf(\'.\')）', async () => {
    // p1 = -1 ⇒ p2/p3 的 `> 0 && < first` 恒假 ⇒ first 仍是 -1 ⇒ 原样返回
    expect(await run('/trimstart Wow! Again? More')).toBe('Wow! Again? More');
  });

  it('空输入返回空串', async () => {
    expect(await run('/trimstart')).toBe('');
  });
});

describe('F-2 clipboard-get / clipboard-set（ST slash-commands.js:3506/3527）', () => {
  const defineClipboard = (clipboard: Partial<Clipboard> | undefined) => {
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboard as Clipboard,
      configurable: true,
      writable: true,
    });
  };
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    apiMock.post.mockReset();
  });

  it('clipboard-get 返回 readText 的原文', async () => {
    const readText = vi.fn().mockResolvedValue('从剪贴板来的文本');
    defineClipboard({ readText } as unknown as Clipboard);
    expect(await run('/clipboard-get')).toBe('从剪贴板来的文本');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('clipboard-get 读失败 → 空串（不抛、不假成功）', async () => {
    defineClipboard({ readText: vi.fn().mockRejectedValue(new Error('denied')) } as unknown as Clipboard);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run('/clipboard-get')).toBe('');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('clipboard-set 调 writeText 并返回空串（ST helpString: Returns an empty string）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    defineClipboard({ writeText } as unknown as Clipboard);
    expect(await run('/clipboard-set 要复制的内容')).toBe('');
    expect(writeText).toHaveBeenCalledWith('要复制的内容');
  });

  it('无 Clipboard API 时 clipboard-get 只 warn 并返回空串', async () => {
    defineClipboard(undefined);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await run('/clipboard-get')).toBe('');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('F-2 translate（薄转发到包C 的真实端点）', () => {
  beforeEach(() => {
    apiMock.post.mockReset();
  });

  it('语义：unnamed=文本、named target=语言码 → POST /api/extra/translate', async () => {
    apiMock.post.mockResolvedValue('こんにちは');
    expect(await run('/translate target=ja Hello world')).toBe('こんにちは');
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    expect(apiMock.post.mock.calls[0][0]).toBe('/api/extra/translate');
    // 后端 TranslateRequest{ text, lang }（st_extras.py:422-427）
    expect(apiMock.post.mock.calls[0][1]).toEqual({ text: 'Hello world', lang: 'ja' });
  });

  it('target 缺省时按后端缺省 zh-CN 传，不自造语言判定', async () => {
    apiMock.post.mockResolvedValue('你好');
    expect(await run('/translate Hello')).toBe('你好');
    expect(apiMock.post.mock.calls[0][1]).toEqual({ text: 'Hello', lang: 'zh-CN' });
  });

  it('provider 走 /api/translate/<provider>（白名单在后端，前端不放宽）', async () => {
    apiMock.post.mockResolvedValue('salut');
    expect(await run('/translate provider=google target=fr Hello')).toBe('salut');
    expect(apiMock.post.mock.calls[0][0]).toBe('/api/translate/google');
  });

  it('空文本不打后端（零计费），直接空串', async () => {
    expect(await run('/translate')).toBe('');
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('后端报错时不假装成功：引擎把错误透出为 Error:', async () => {
    apiMock.post.mockRejectedValue(new Error('502 上游不可用'));
    const output = await run('/translate Hello');
    expect(output).toContain('Error:');
    expect(output).toContain('502');
  });
});

describe('F-2 summarize（薄转发到包C 的真实端点）', () => {
  beforeEach(() => {
    apiMock.post.mockReset();
  });

  it('有文本 → POST /api/summarize { text, params } 并取 response.summary', async () => {
    apiMock.post.mockResolvedValue({ summary: '一段摘要' });
    expect(await run('/summarize 今天发生了很多事')).toBe('一段摘要');
    expect(apiMock.post.mock.calls[0][0]).toBe('/api/summarize');
    expect(apiMock.post.mock.calls[0][1]).toEqual({ text: '今天发生了很多事', params: {} });
  });

  it('named prompt 进 params.prompt（SummarizeRequest.params，st_extras.py:378-380）', async () => {
    apiMock.post.mockResolvedValue({ summary: '按指令摘要' });
    expect(await run('/summarize prompt=三句话以内 长文本')).toBe('按指令摘要');
    expect(apiMock.post.mock.calls[0][1]).toEqual({ text: '长文本', params: { prompt: '三句话以内' } });
  });

  it('无文本时不摘要整段聊天（宿主引擎拿不到消息历史）→ warn + 空串，不打后端', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await run('/summarize')).toBe('');
    expect(spy).toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('F-2 注册口径', () => {
  const NEW_COMMANDS = ['trimend', 'trimstart', 'clipboard-get', 'clipboard-set', 'translate', 'summarize'];

  it('新命令都注册进了宿主引擎，且都在 ST 权威名单里（没有造 ST 没有的名字）', () => {
    for (const name of NEW_COMMANDS) {
      expect(SlashCommandEngine.getCommand(name), name).toBeTruthy();
      expect(ST_118_COMMAND_NAMES.includes(name), `${name} 不在 ST 1.18 权威名单`).toBe(true);
    }
  });

  it('C 类（ST UI）仍不注册：bg / panels / theme 执行报 Unknown command', async () => {
    for (const name of ['bg', 'panels', 'theme']) {
      expect(SlashCommandEngine.getCommand(name)).toBeFalsy();
      expect(await run(`/${name} x`)).toContain('Unknown command');
    }
  });
});
