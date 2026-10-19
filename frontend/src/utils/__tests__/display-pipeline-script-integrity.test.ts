/**
 * [包T 2026-10-19] 显示管线不得改写卡内 <script> 正文 —— 基线守卫
 *
 * 立项背景（真机取证，角色 bcf12cd3「猫娘重制卡」，站点 :16000）：
 * 控制台报 `Failed to execute 'appendChild' on 'Node': Unexpected token '}' @ about:srcdoc:81:1`。
 * 离线复核结论（详见 docs/_active/report/REPORT_包T_显示管线改写卡面板脚本_2026-10-19.md）：
 *   该报错**不是**显示管线改写出来的 —— 卡自己的 `extensions.tavern_helper.scripts[]`
 *   里那条 schema 脚本**在 PNG 原始卡数据里就已经少一个配对括号**（第 81 行多一个 `});`），
 *   直接 `node --check` 未落库的 PNG 原文即可在同名行号复现同一句 SyntaxError。
 *   管线侧对该脚本正文**逐字节未改动**（长度/行数/括号平衡与原文一致）。
 *
 * 但同一轮取证证明：**另一条路径真的会改写脚本正文**
 * —— `wrapSillyTavernQuotedText` 会把 `<script>` 里的成对英文引号包成 `<q>…</q>`，
 * 而 `extractHtmlBlocks` 的保护名单里没有 `script`。只要卡产出的脚本**不是**
 * 一份完整 HTML 文档（裸 `<script>` 片段 / 被 `<div>` 包着的片段），
 * 它的 JS 源码就会在进入沙箱 iframe 前被改坏。本文件锁住两个判据：
 *   ① 完整 HTML 文档形态（真机现状）：脚本正文逐字节不变；
 *   ② 裸脚本片段形态（本次修复对象）：脚本正文逐字节不变。
 *
 * 判据一律是结构量（逐字节相等 / 括号平衡 / 全角引号数），不依赖卡内正文。
 */
import { describe, it, expect } from 'vitest';
import { applySillyTavernDisplayPipeline } from '@/utils/sillyTavernDisplayPipeline';
import {
  extractHtmlBlocks,
  restoreHtmlBlocks,
  preprocessMarkdownForShowdown,
  wrapSillyTavernQuotedText,
} from '@/lib/sillytavern/formatting';

/** 面板脚本正文：成对英文引号、对象字面量、模板里带 `<`/`>`、注释里带中文 —— 全是改写器的靶子 */
const PANEL_SCRIPT_BODY = [
  '',
  '  // 状态栏面板：引号与花括号都会被文本改写器盯上',
  '  const label = "爱意";',
  '  const map = { "a": 1, "b": 2 };',
  '  const arrow = (x) => x + "→" + map["a"];',
  '  const cmp = 1 < 2 && 3 > 2;',
  '  document.getElementById("box").textContent = label + ":" + arrow(cmp);',
  '',
].join('\n');

const PANEL_STYLE_BODY = '\n  .bar::before { content: "●"; width: 10px; }\n';

function fullDocumentPanel(): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    `<style>${PANEL_STYLE_BODY}</style>`,
    '</head>',
    '<body>',
    '<div id="box">状态栏</div>',
    `<script type="module">${PANEL_SCRIPT_BODY}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function bareScriptPanel(): string {
  return [
    '<div id="box">状态栏</div>',
    `<style>${PANEL_STYLE_BODY}</style>`,
    `<script type="module">${PANEL_SCRIPT_BODY}</script>`,
  ].join('\n');
}

function fencedPanel(): string {
  return '```html\n' + fullDocumentPanel() + '\n```';
}

function firstScriptBody(html: string): string {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) throw new Error('管线产出里找不到 <script>（被整段吞掉了）');
  return m[1];
}
function firstStyleBody(html: string): string {
  const m = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(html);
  if (!m) throw new Error('管线产出里找不到 <style>（被整段吞掉了）');
  return m[1];
}

function balance(src: string, open: string, close: string): number {
  return (src.split(open).length - 1) - (src.split(close).length - 1);
}

function runPipeline(content: string) {
  return applySillyTavernDisplayPipeline({
    content,
    characterName: '猫娘',
    userName: '训练师',
    messageIndex: 1,
    totalMessages: 2,
    isStreaming: false,
    isUser: false,
    isSystem: false,
  });
}

/** 三种卡产出形态：完整文档 / ``` 围栏包裹 / 裸片段 */
const FORMS: Array<[string, string]> = [
  ['完整 HTML 文档', fullDocumentPanel()],
  ['围栏包裹的完整文档', fencedPanel()],
  ['裸 <script> 片段', bareScriptPanel()],
];

describe('显示管线对卡内脚本正文：逐字节不得改写', () => {
  for (const [name, panel] of FORMS) {
    it(`${name}：脚本正文过管线后逐字节不变`, () => {
      const out = runPipeline(panel).content;
      expect(firstScriptBody(out)).toBe(PANEL_SCRIPT_BODY);
    });

    it(`${name}：样式正文过管线后逐字节不变`, () => {
      const out = runPipeline(panel).content;
      expect(firstStyleBody(out)).toBe(PANEL_STYLE_BODY);
    });

    it(`${name}：脚本正文括号平衡仍为 0、全角引号为 0、宏占位符不被留下`, () => {
      const out = runPipeline(panel).content;
      const body = firstScriptBody(out);
      expect(balance(body, '{', '}')).toBe(0);
      expect(balance(body, '(', ')')).toBe(0);
      expect(body.match(/[“”‘’]/g) || []).toHaveLength(0);
      expect(body.match(/\{\{|\}\}/g) || []).toHaveLength(0);
      // 改写器若命中脚本正文，唯一痕迹就是往里塞 <q>…</q>
      expect(body.match(/<q>/g) || []).toHaveLength(0);
    });
  }
});

describe('markdown 层区域保护：extract → preprocess → restore 这一组真函数', () => {
  /**
   * 这三步就是 `renderSillyTavernMarkdownToHtml`（formatting 的 markdown 出口）与
   * `formatMessage` 的 HTML 段所用的真实组合。分开调单函数测不出问题：
   * `wrapSillyTavernQuotedText` 单独喂裸脚本必然把它改坏（实测 q=6），
   * 但管线在它前面有一层 `extractHtmlBlocks` —— **保护是不是真的生效，只有走组合才看得见**。
   */
  const passThroughMarkdownLayer = (content: string): string => {
    const extracted = extractHtmlBlocks(content);
    const preprocessed = preprocessMarkdownForShowdown(extracted.text);
    return restoreHtmlBlocks(preprocessed, extracted.blocks);
  };

  const BARE = `<script type="module">${PANEL_SCRIPT_BODY}</script>`;

  it('裸脚本片段：进 markdown 层出来仍是原样（不出现 <q>）', () => {
    expect(firstScriptBody(passThroughMarkdownLayer(BARE))).toBe(PANEL_SCRIPT_BODY);
  });

  it('裸脚本片段：这段 script 确实被收进了保护区', () => {
    expect(extractHtmlBlocks(BARE).blocks.some((b) => /<script\b/i.test(b))).toBe(true);
  });

  it('靶子存在性：单看引号着色器，它确实会把裸脚本改坏（这就是区域保护存在的理由）', () => {
    expect(wrapSillyTavernQuotedText(BARE)).toContain('<q>');
  });

  it('正文引号着色不受影响（保护只圈住 script，没有连带废掉 markdown 特性）', () => {
    expect(passThroughMarkdownLayer('她说："今天也在一起吧。"')).toContain('<q>');
  });

  it('不是一刀切：含脚本的消息里，样式与脚本都还在，状态栏正则照常命中', () => {
    const out = runPipeline(bareScriptPanel()).content;
    expect(out).toContain('<style');
    expect(out).toContain('<script');
  });
});
