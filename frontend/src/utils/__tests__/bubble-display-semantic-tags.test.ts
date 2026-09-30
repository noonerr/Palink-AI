/*
 * [SEMANTIC-TAG-STRIP + 引号形态 2026-10-01] 显示管线契约测试
 *
 * 取证背景（会话 a0accf94，消息 2405 / 2415）：
 *   1) 2405 带完整 `<now_plot><content>` 包裹，但卡正则没产出 dcRoot iframe ——
 *      标签无人消费，原样漏进正文（用户看到 "content 标签"）。
 *   2) Showdown 会把段内换行渲染成 `<br>`，@bubble 行与正文挤在同一行
 *      （"…浮木。<br><br>@bubble:露缇雅|慌张|[…]<br><br>…"），行首锚点 `^` 失效，
 *      原本的降级逻辑整条漏掉。
 *   3) 注入规范自 2026-10-01 起改为中文引号，降级必须同时吃得下引号与方括号。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from 'vitest';

import {
  applySillyTavernDisplayPipeline,
  stripUnrenderedSemanticTags,
} from '@/utils/sillyTavernDisplayPipeline';

function run(content: string) {
  return applySillyTavernDisplayPipeline({
    content,
    characterName: '露缇雅',
    userName: 'admin',
    isUser: false,
    isStreaming: false,
    isSystem: false,
    globalRegexScripts: [],
    characterExtensions: undefined,
    presetData: undefined,
    chatMessages: [],
  } as any);
}

describe('stripUnrenderedSemanticTags —— 未被卡消费的包裹标签', () => {
  it('剥掉 now_plot / content，正文保留', () => {
    const input = '<now_plot>\n<content>\n露缇雅的手指抓紧了床单边缘。\n</content>\n</now_plot>';
    const out = stripUnrenderedSemanticTags(input);
    expect(out).not.toContain('<content>');
    expect(out).not.toContain('<now_plot>');
    expect(out).toContain('露缇雅的手指抓紧了床单边缘。');
  });

  it('剥标签后不留首尾悬空的 <br>', () => {
    const input = '<now_plot><br><content><br>正文<br></content><br></now_plot>';
    const out = stripUnrenderedSemanticTags(input);
    expect(out.startsWith('<br>')).toBe(false);
    expect(out.endsWith('<br>')).toBe(false);
  });

  it('存在 dcRoot 宿主时原样返回（标签是卡脚本的输入）', () => {
    const withHost =
      '<iframe srcdoc="&lt;div id=&quot;dcRoot&quot;&gt;&lt;/div&gt;"></iframe>\n<now_plot>\n<content>正文</content>\n</now_plot>';
    expect(stripUnrenderedSemanticTags(withHost)).toBe(withHost);
  });

  it('无标签时零成本返回原串', () => {
    const plain = '露缇雅轻轻咬住下唇，低下头。';
    expect(stripUnrenderedSemanticTags(plain)).toBe(plain);
  });
});

describe('applySillyTavernDisplayPipeline —— 真实形态端到端', () => {
  it('有包裹：标签剥离 + @bubble 降级', () => {
    const input = [
      '<now_plot>',
      '<content>',
      '露缇雅的手指抓紧了床单边缘。',
      '',
      '@bubble:露缇雅|慌张|[哥哥……这不是梦，是真的……]',
      '',
      '她把脸埋在他的胸口。',
      '</content>',
      '</now_plot>',
    ].join('\n');
    const r = run(input);
    expect(r.content).not.toContain('<content>');
    expect(r.content).not.toContain('<now_plot>');
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('露缇雅（慌张）：哥哥……这不是梦，是真的……');
  });

  it('<br> 同行形态：@bubble 仍被降级（2405 真因回归）', () => {
    // Showdown 产物：段内换行已被渲染成 <br>，@bubble 不在行首
    const input = '她软软地往前倾倒，额头抵在他的胸口。<br><br>@bubble:露缇雅|害怕|[我早上醒来就变成这样了。]<br><br>她松开床单。';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('露缇雅（害怕）：我早上醒来就变成这样了。');
  });

  it('引号形态（2026-10-01 起的新规范）：同样被降级', () => {
    const input = '她低下头。<br><br>@bubble:露缇雅|犹豫|“我……我其实也不太清楚……”<br><br>她想了想。';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('露缇雅（犹豫）：我……我其实也不太清楚……');
  });

  it('引号形态行首：同样被降级', () => {
    const input = '她低下头。\n\n@bubble:露缇雅|害羞|“我、我不是那个意思！”\n\n她赶紧摆手。';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('露缇雅（害羞）：我、我不是那个意思！');
  });

  it('内心活动 *…* 形态：星号保留，情绪进括号', () => {
    const input = '@bubble:露缇雅|低落|“*（他说得那么轻巧……可我知道这一定很疼的。）*”';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('露缇雅（低落）：*（他说得那么轻巧……可我知道这一定很疼的。）*');
  });

  it('卡正则产出"像卡片"的 HTML 但无 dcRoot 宿主：仍降级（HOST-GATE 回归）', () => {
    // 实测场景：卡正则「正文美化」把正文包成卡片 HTML，但其中的 iframe 会被
    // ST_DOMPURIFY_CONFIG.FORBID_TAGS 的 'iframe' 消毒掉 → 没有宿主 → 标记无人消费。
    // 旧判据（looksLikeRenderableCardHtml）会误判为"已交给卡"而跳过降级。
    const cardLike =
      '<div class="dc-msg" style="color:#fff">@bubble:露缇雅|犹豫|[我……我其实也不太清楚……]</div>';
    const r = run(cardLike);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('露缇雅（犹豫）：我……我其实也不太清楚……');
  });

  it('真有 dcRoot 宿主时不降级（交给卡内运行时渲染）', () => {
    // 注意：不能用 iframe 构造 —— FORBID_TAGS 含 'iframe'，管线里 iframe 会被移除，
    // 反而测不出宿主存在。这里用不被引擎移除的形态表达"宿主已就位"。
    const withHost =
      '<div id="dcRoot"></div>' +
      '<div class="dc-msg">@bubble:露缇雅|犹豫|[我……]</div>';
    const r = run(withHost);
    expect(r.content).toContain('@bubble:');
  });

  it('用户消息不动', () => {
    const r = applySillyTavernDisplayPipeline({
      content: '@bubble:露缇雅|慌张|[哥哥……]',
      characterName: '露缇雅',
      userName: 'admin',
      isUser: true,
      isStreaming: false,
      isSystem: false,
      globalRegexScripts: [],
      chatMessages: [],
    } as any);
    expect(r.content).toContain('@bubble:');
  });
});
