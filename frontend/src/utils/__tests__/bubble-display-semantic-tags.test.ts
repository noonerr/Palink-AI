/*
 * [SEMANTIC-TAG-STRIP + BUBBLE-SHELL-STRIP 2026-10-01] 显示管线契约测试
 *
 * 取证背景（会话 a0accf94，消息 2405 / 2415）：
 *   1) 2405 带完整 `<now_plot><content>` 包裹，但卡正则没产出 dcRoot iframe ——
 *      标签无人消费，原样漏进正文（用户看到 "content 标签"）。
 *   2) Showdown 会把段内换行渲染成 `<br>`、卡正则会把标记包进 `<div class="dc-msg">`，
 *      两者都让 @bubble 不再位于行首 → 行首锚点 `^` 失效，降级整条漏掉。
 *   3) 用户裁定：角色卡没要求 @bubble 时，应还原成**最普通的对话文本**（只留说话内容），
 *      不要 `角色（情绪）：台词` 这种带加工痕迹的形态。
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
  it('有包裹：标签剥离 + 标记还原成纯对话', () => {
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
    expect(r.content).not.toContain('（慌张）');
    expect(r.content).toContain('“哥哥……这不是梦，是真的……”');
  });

  it('<br> 同行形态：标记仍被还原（2405 真因回归）', () => {
    const input = '她软软地往前倾倒，额头抵在他的胸口。<br><br>@bubble:露缇雅|害怕|[我早上醒来就变成这样了。]<br><br>她松开床单。';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('“我早上醒来就变成这样了。”');
  });

  it('引号形态：原样保留引号，不加角色名前缀', () => {
    const input = '她低下头。<br><br>@bubble:露缇雅|犹豫|“我……我其实也不太清楚……”<br><br>她想了想。';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).not.toContain('（犹豫）');
    expect(r.content).toContain('“我……我其实也不太清楚……”');
  });

  it('行首引号形态：同样只留内容', () => {
    const input = '她低下头。\n\n@bubble:露缇雅|害羞|“我、我不是那个意思！”\n\n她赶紧摆手。';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('“我、我不是那个意思！”');
  });

  it('内心活动 [*…*]：去掉星号壳，不加引号', () => {
    const input = '@bubble:露缇雅|低落|[*（他说得那么轻巧……可我知道这一定很疼的。）*]';
    const r = run(input);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).not.toContain('*');
    expect(r.content).toContain('（他说得那么轻巧……可我知道这一定很疼的。）');
  });

  it('英文直引号 / 单引号：统一成中文引号', () => {
    expect(run('@bubble:露缇雅|委屈|"才、才不是挂件！"').content).toContain('“才、才不是挂件！”');
    expect(run("@bubble:樱|无奈|'别把我拉进去啊。'").content).toContain('“别把我拉进去啊。”');
  });

  it('卡正则产出"像卡片"的 HTML 但无 dcRoot 宿主：仍还原（HOST-GATE 回归）', () => {
    const cardLike =
      '<div class="dc-msg" style="color:#fff">@bubble:露缇雅|犹豫|[我……我其实也不太清楚……]</div>';
    const r = run(cardLike);
    expect(r.content).not.toContain('@bubble:');
    expect(r.content).toContain('“我……我其实也不太清楚……”');
  });

  it('真有 dcRoot 宿主时不还原（交给卡内运行时渲染）', () => {
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
