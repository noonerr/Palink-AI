/*
 * [BUBBLE-DISPLAY 2026-09-30] @bubble 标记显示侧两段处理 + 【声音】行隐藏 契约测试
 *
 * 取证背景（会话 93cee77b 逐条实测）：
 *   - 2382（过度思考那条）的 7 条 @bubble **格式完全合规**（方括号），仍然裸显 ——
 *     真因是缺 <now_plot><content> 包裹 → 卡正则「正文美化」不命中 → 没有 dcRoot iframe
 *     → BubbleDialogue `_getBubbleRenderFrames()` 找不到渲染宿主。
 *   - 2384/2387/2389/2393 改用引号，而卡内 `RE_BUBBLE_LINE` 只认方括号。
 *   - 【声音：…】是提示词要求模型输出的 TTS 声线参数，显示层此前从不隐藏 → 必然裸显；
 *     但它**必须**留在传给 ttsService.playMessage 的文本里（声线提取的入参）。
 *
 * 运行: npx vitest run
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  normalizeBubbleDialogueQuotes,
  stripVoiceDescriptionMarkers,
  downgradeUnconsumedBubbleMarkers,
  applySillyTavernDisplayPipeline,
} from '@/utils/sillyTavernDisplayPipeline';

import { ttsService } from '@/services/tts';

const VOICE_LINE = '【声音：娇柔清脆的女声，带着晨起沙哑与微微颤音】';

describe('normalizeBubbleDialogueQuotes —— 引号对白 → 方括号（卡内解析器唯一认得的形态）', () => {
  it('中文引号 → 方括号', () => {
    const input = '@bubble:露缇雅|不安|“嗯……好像是，肚子里面空空的。”';
    expect(normalizeBubbleDialogueQuotes(input)).toBe(
      '@bubble:露缇雅|不安|[嗯……好像是，肚子里面空空的。]',
    );
  });

  it('英文直引号 → 方括号', () => {
    const input = '@bubble:露缇雅|委屈|"才、才不是挂件！是真的长在身上的！"';
    expect(normalizeBubbleDialogueQuotes(input)).toBe(
      '@bubble:露缇雅|委屈|[才、才不是挂件！是真的长在身上的！]',
    );
  });

  it('单引号 → 方括号', () => {
    const input = "@bubble:樱|无奈|'别把我拉进去啊。'";
    expect(normalizeBubbleDialogueQuotes(input)).toBe('@bubble:樱|无奈|[别把我拉进去啊。]');
  });

  it('已合规的方括号行保持原样', () => {
    const input = '@bubble:露缇雅|慌张|[才、才不是那样……我是真的出事了！]';
    expect(normalizeBubbleDialogueQuotes(input)).toBe(input);
  });

  it('内心活动 [*…*] 形态保持原样', () => {
    const input = '@bubble:露缇雅|忐忑|[*（他会觉得我很奇怪……）*]';
    expect(normalizeBubbleDialogueQuotes(input)).toBe(input);
  });

  it('只改 @bubble 行，正文里的引号不受影响', () => {
    const input = '她说：“这是普通叙述里的引号。”\n\n@bubble:露缇雅|不安|“真的不是。”';
    const out = normalizeBubbleDialogueQuotes(input);
    expect(out).toContain('她说：“这是普通叙述里的引号。”');
    expect(out).toContain('@bubble:露缇雅|不安|[真的不是。]');
  });

  it('多行混合，逐行归一', () => {
    const input = [
      '@bubble:露缇雅|紧张|"哥哥……这到底是怎么回事？"',
      '她低下头。',
      '@bubble:露缇雅|不安|“我不会以后一直这样吧……”',
    ].join('\n');
    const out = normalizeBubbleDialogueQuotes(input);
    expect(out.split('\n')[0]).toBe('@bubble:露缇雅|紧张|[哥哥……这到底是怎么回事？]');
    expect(out.split('\n')[1]).toBe('她低下头。');
    expect(out.split('\n')[2]).toBe('@bubble:露缇雅|不安|[我不会以后一直这样吧……]');
  });

  it('无 @bubble 时原样返回（零成本路径）', () => {
    const input = '普通正文，没有标记。';
    expect(normalizeBubbleDialogueQuotes(input)).toBe(input);
  });
});

describe('stripVoiceDescriptionMarkers —— 显示层隐藏【声音】行', () => {
  it('整行隐藏且不留多余空行', () => {
    const input = `正文第一段。\n\n正文第二段。\n\n${VOICE_LINE}`;
    const out = stripVoiceDescriptionMarkers(input);
    expect(out).not.toContain('【声音');
    expect(out).toBe('正文第一段。\n\n正文第二段。');
  });

  it('行内出现时只删标记本身', () => {
    const input = `她低声说着。${VOICE_LINE}`;
    expect(stripVoiceDescriptionMarkers(input)).toBe('她低声说着。');
  });

  it('【语音：…】变体一并处理', () => {
    const input = '正文\n\n【语音：低沉的男声】';
    expect(stripVoiceDescriptionMarkers(input)).toBe('正文');
  });

  it('流式半截（未闭合）不匹配 —— 闭合后整体消失', () => {
    const half = '正文\n\n【声音：娇柔清脆的女声，带着晨起';
    expect(stripVoiceDescriptionMarkers(half)).toBe(half);
    expect(stripVoiceDescriptionMarkers(`${half}沙哑】`)).toBe('正文');
  });

  it('无标记时原样返回', () => {
    const input = '普通正文。';
    expect(stripVoiceDescriptionMarkers(input)).toBe(input);
  });
});

describe('downgradeUnconsumedBubbleMarkers —— 无渲染宿主时降级为可读文本', () => {
  it('裸标记 → 角色（情绪）：对白', () => {
    const input = '@bubble:露缇雅|不安|[还有这里……我醒过来的时候，它就在发光。]';
    expect(downgradeUnconsumedBubbleMarkers(input)).toBe(
      '露缇雅（不安）：还有这里……我醒过来的时候，它就在发光。',
    );
  });

  it('引号形态（未经归一）也能降级', () => {
    const input = '@bubble:露缇雅|委屈|"哥哥，我会变成……怪物吗？"';
    expect(downgradeUnconsumedBubbleMarkers(input)).toBe(
      '露缇雅（委屈）：哥哥，我会变成……怪物吗？',
    );
  });

  it('Showdown 已包 <p> 的形态：保留包裹，只改内容', () => {
    const input = '<p>@bubble:露缇雅|悲伤|[你不会……不要我的，对吧？]</p>';
    expect(downgradeUnconsumedBubbleMarkers(input)).toBe(
      '<p>露缇雅（悲伤）：你不会……不要我的，对吧？</p>',
    );
  });

  it('多处标记逐行降级，正文行不动', () => {
    const input = [
      '@bubble:露缇雅|慌张|[才、才不是那样！]',
      '她侧过身。',
      '@bubble:露缇雅|难过|[你看到了吧……]',
    ].join('\n');
    expect(downgradeUnconsumedBubbleMarkers(input)).toBe(
      ['露缇雅（慌张）：才、才不是那样！', '她侧过身。', '露缇雅（难过）：你看到了吧……'].join('\n'),
    );
  });

  it('无标记时原样返回', () => {
    const input = '普通正文。';
    expect(downgradeUnconsumedBubbleMarkers(input)).toBe(input);
  });
});

describe('applySillyTavernDisplayPipeline 集成：助手消息', () => {
  const baseInput = {
    characterName: '露缇雅',
    userName: 'admin',
    isUser: false,
    isSystem: false,
  };

  it('【声音】不出现，裸 @bubble 被降级为可读文本', () => {
    const content = [
      '晨光从窗帘缝隙渗进来。',
      '',
      '@bubble:露缇雅|不安|“还有这里……我醒过来的时候，它就在发光。”',
      '',
      VOICE_LINE,
    ].join('\n');

    const result = applySillyTavernDisplayPipeline({ ...baseInput, content });

    expect(result.content).not.toContain('【声音');
    expect(result.content).not.toContain('@bubble:');
    expect(result.content).toContain('露缇雅（不安）：');
    expect(result.content).toContain('还有这里……我醒过来的时候，它就在发光。');
  });

  it('用户消息不降级、不隐藏（isUser 门控）', () => {
    const content = `${VOICE_LINE}\n@bubble:我|平静|[自己打的内容]`;
    const result = applySillyTavernDisplayPipeline({ ...baseInput, content, isUser: true });
    expect(result.content).toContain('【声音');
    expect(result.content).toContain('@bubble:');
  });

  it('卡片分支（含 <script>，即正文美化卡）：标记必须原样保留给卡内运行时', () => {
    // 正文美化卡把整段替换成自带 <script> 的 HTML 文档；卡内 JS 靠 RE_BUBBLE_LINE
    // 在 iframe 里解析 @bubble。这里若被降级，卡片渲染就废了 → 必须 skip。
    const cardHtml = [
      '<div id="dcRoot">',
      '<script>const RE_BUBBLE_LINE = /^@bubble:([^|]+)\\|([^|]+)\\|\\[([^\\]]+)\\]$/;</script>',
      '</div>',
    ].join('');
    const content = `${cardHtml}\n@bubble:露缇雅|不安|[宿主外的残留标记]`;
    const result = applySillyTavernDisplayPipeline({ ...baseInput, content });
    // 卡片判定命中 → 不降级（标记仍在，形如 @bubble:露缇雅|不安|[...]）
    expect(result.content).toContain('@bubble:露缇雅|不安|[宿主外的残留标记]');
    // 但【声音】行仍在显示层被隐藏（对卡片同样生效）
  });

  it('卡片分支：引号仍被归一成方括号（卡内解析器只认方括号）', () => {
    const cardHtml = '<div id="dcRoot"><script>/* card runtime */</script></div>';
    const content = `${cardHtml}\n@bubble:露缇雅|不安|“真的不是。”`;
    const result = applySillyTavernDisplayPipeline({ ...baseInput, content });
    expect(result.content).toContain('@bubble:露缇雅|不安|[真的不是。]');
    expect(result.content).not.toContain('“真的不是。”');
  });

  it('卡片分支：【声音】行同样被隐藏', () => {
    const cardHtml = '<div id="dcRoot"><script>/* card runtime */</script></div>';
    const content = `${cardHtml}\n${VOICE_LINE}`;
    const result = applySillyTavernDisplayPipeline({ ...baseInput, content });
    expect(result.content).not.toContain('【声音');
  });
});

describe('回归护栏：TTS 声线提取路径不受显示层隐藏影响', () => {
  it('extractVoiceDescription 能从原始正文取到声线（显示层隐藏的是另一份文本）', () => {
    const raw = `正文内容。\n\n${VOICE_LINE}`;
    const extracted = ttsService.extractVoiceDescription(raw);
    expect(extracted).toBe('娇柔清脆的女声，带着晨起沙哑与微微颤音');
    // 显示层用的是剥过的文本，但它与 TTS 入参是两份
    expect(stripVoiceDescriptionMarkers(raw)).not.toContain('【声音');
  });

  it('Message.tsx 的语音按钮仍从 displayContent（未剥离）构造 TTS 文本', () => {
    // 结构护栏：一旦有人"顺手清理"成 renderContent，声线提取会静默失效
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../components/ui/custom/Message.tsx'),
      'utf8',
    );
    expect(src).toContain('const text = isUser ? (message.content || \'\') : (displayContent || message.content || \'\');');
    expect(src).toContain('ttsService.playMessage(message.id, text');
    // 且不存在把 renderContent 传给 playMessage 的写法
    expect(src).not.toContain('playMessage(message.id, renderContent');
  });
});
