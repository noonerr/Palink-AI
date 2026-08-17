/**
 * 智能卡内联渲染的 HTML 清洗 + 脚本抽取。
 *
 * 与 spec 原方案的差异（已确认为更优解，写入修正版 spec §4.1）：
 * 原方案要求新建一个「允许 script」的 DOMPurify 配置。实际不需要，也不应该——
 * 让 DOMPurify 放行 <script> 等于放弃它对脚本内容的全部约束，且 DOMPurify 对
 * script 内文本的处理在不同版本间行为不一致。
 *
 * 改为对齐项目自己的 ST 侧实现 frontend/public/st/palink-smart-card.js：
 *   1) 先把 <script> 抽走，原地留下占位 <div data-palink-script="id">
 *   2) 再对剩余 HTML 做清洗（此时已无 script，沿用严格配置即可）
 *   3) 渲染后由 inline-script-replay 用 createElement('script') 重放
 * 这样 DOMPurify 配置保持严格，脚本执行路径显式可控。
 *
 * CSS 策略（用户决策 C4）：**不 scope**。卡片作者用 `.mes_text .xxx` 自约束，
 * 与 SillyTavern 行为一致。故此处保留 <style> 原样，不调用 scopeCss。
 */

import DOMPurify from 'dompurify';
import { removeFullDocumentShell } from '../html-extract';

export interface InlineCardScript {
  id: string;
  type: 'inline' | 'external' | 'data';
  /** type==='inline' | 'data' 时为脚本源码 / 数据文本 */
  code?: string;
  /** type==='external' 时为 src */
  src?: string;
  /** type==='data' 时保留原始 type 属性，重放时原样还原（浏览器不会执行未知类型） */
  mimeType?: string;
  /** type==='data' 时保留原始属性串，确保 id/class 等不丢（卡片常用 getElementById 取数据） */
  rawAttrs?: string;
}

/**
 * 判断 <script type="..."> 是否为可执行 JS。
 * 空 / text|application/javascript / module 均视为可执行，其余（application/json、
 * text/template、text/x-handlebars 等数据块）不执行。
 *
 * 注意：ST 侧 palink-smart-card.js 没有这层判断，会把 JSON 数据块也当 JS 丢给引擎，
 * 抛 SyntaxError。这是它的缺陷，不是我们要对齐的「表现」，故此处加固。
 * type="module" 统一降级为经典脚本执行：module 有独立作用域且被 defer，
 * 会破坏用户决策 C5 要求的「多卡共享全局作用域」语义。
 */
function isExecutableScriptType(rawType: string | undefined): boolean {
  const t = String(rawType || '').trim().toLowerCase();
  if (!t) return true;
  if (t === 'module') return true;
  return /^(text|application)\/(java|ecma)script$/.test(t);
}

function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i');
  const m = re.exec(attrs || '');
  return m ? m[1] : undefined;
}

export interface InlineCardPrepared {
  /** 已清洗、脚本已被占位符替换的 HTML，可直接 dangerouslySetInnerHTML */
  html: string;
  /** 按文档顺序排列的脚本列表 */
  scripts: InlineCardScript[];
}

/** 与 palink-smart-card.js L34 保持同名，卡片脚本靠它替代 DOMContentLoaded。 */
export const INLINE_CARD_INIT_EVENT = 'palink-card-init';

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gims;
const SELF_CLOSING_SCRIPT_PATTERN = /<script\b([^>]*)\/>/gim;
/** 匹配 <style> 块（含 type/媒体等属性），保留完整标签壳以便回填。 */
const STYLE_TAG_PATTERN = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gims;

let styleCounter = 0;
let scriptCounter = 0;

/**
 * 把卡片脚本里的 DOMContentLoaded 改写为 palink-card-init。
 * 内联渲染发生在 document 早已 ready 之后，DOMContentLoaded 永远不会再触发，
 * 不改写会导致卡片初始化代码整段不执行。
 * 完全对齐 palink-smart-card.js L442-445。
 */
function patchDomContentLoaded(code: string): string {
  return code.replace(
    /document\s*\.\s*addEventListener\s*\(\s*(['"])DOMContentLoaded\1/g,
    'document.addEventListener($1' + INLINE_CARD_INIT_EVENT + '$1',
  );
}

/**
 * 抽取 <script> 并生成占位符。
 * 返回替换后的 HTML 与脚本清单（保持文档顺序）。
 */
export function extractInlineCardScripts(html: string, cardId: string): InlineCardPrepared {
  const scripts: InlineCardScript[] = [];

  // 先干掉自闭合写法（<script src=... />），浏览器不认，留着会吞掉后续内容
  let working = String(html || '').replace(SELF_CLOSING_SCRIPT_PATTERN, (_match, attrs: string) => {
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs || '');
    if (!srcMatch) return '';
    const id = `${cardId}-${++scriptCounter}`;
    scripts.push({ id, type: 'external', src: srcMatch[1] });
    return `<div data-palink-script="${id}"></div>`;
  });

  SCRIPT_TAG_PATTERN.lastIndex = 0;
  working = working.replace(SCRIPT_TAG_PATTERN, (_match, attrs: string, content: string) => {
    const id = `${cardId}-${++scriptCounter}`;
    const scriptType = readAttr(attrs, 'type');

    if (!isExecutableScriptType(scriptType)) {
      // JSON / 模板数据块：原样保留内容，重放时还原成同类型 <script>，浏览器不会执行它，
      // 但卡片脚本可以用 document.getElementById(...).textContent 把它读出来。
      scripts.push({
        id,
        type: 'data',
        code: String(content || ''),
        mimeType: scriptType,
        rawAttrs: String(attrs || ''),
      });
      return `<div data-palink-script="${id}"></div>`;
    }

    const src = readAttr(attrs, 'src');
    if (src) {
      scripts.push({ id, type: 'external', src });
    } else {
      scripts.push({ id, type: 'inline', code: patchDomContentLoaded(String(content || '')) });
    }
    return `<div data-palink-script="${id}"></div>`;
  });

  return { html: working, scripts };
}

/**
 * 内联卡片清洗：允许 <style> 与全部展示性标签，剥离嵌套 iframe/object/embed/base/form。
 * 不 scope CSS（C4）。占位 <div data-palink-script> 必须存活，故显式放行 data-* 属性。
 */
export function sanitizeInlineCardHtml(html: string): string {
  return DOMPurify.sanitize(String(html || ''), {
    ADD_TAGS: [
      'style', 'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
      'g', 'defs', 'use', 'ellipse', 'text', 'tspan', 'marker', 'clipPath',
      'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur',
      'mask', 'pattern', 'image', 'symbol', 'foreignObject',
    ],
    ADD_ATTR: [
      'style', 'class', 'id', 'data-*', 'role', 'aria-*', 'tabindex',
      'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
      'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
      'preserveAspectRatio', 'xmlns', 'loading', 'decoding', 'referrerpolicy',
    ],
    // 内联后卡片脚本已走独立重放路径，此处 script 必须继续禁；
    // iframe/object/embed 防嵌套，base 防篡改相对路径，form 防表单劫持。
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
  });
}

/**
 * CSS「轻保护」：把卡片 <style> 里会污染主页面全局的裸选择器收进卡片容器作用域。
 *
 * 用户决策 C4 是不 scope 类名（卡片作者用 .mes_text .xxx 自约束，对齐 ST）；
 * 但「不 scope 类名」不等于允许卡片随意改写主页面 html/body/:root 的全局样式。
 * 内联后这些裸选择器直接命中主文档，是「黑屏 + 按钮失灵」的元凶（实卡验证）：
 *
 *   1) `:root { --bg: ... }` 覆盖主页面全部 CSS 变量 → 主页面配色/背景全乱
 *   2) `body { background: transparent }` 直接改主页面 body
 *   3) `position: fixed` 的全屏遮罩（lightbox-overlay, z-index:99999）盖住整个
 *      主页面，且 opacity:0 时依然拦截所有点击（pointer-events 默认 auto）
 *
 * 做法（只动这四类，其余选择器原样保留 = 维持 C4）：
 *   - :root             → .palink-inline-card   （变量作用域收进容器，后代仍可继承）
 *   - 顶层 html/body     → .palink-inline-card   （body 语义映射为卡片容器）
 *   - position: fixed   → position: absolute    （全屏遮罩退化为容器内遮罩）
 *   - opacity:0 的元素   → 追加 pointer-events:none（透明元素不得拦截点击）
 *     .active 恢复       → 追加 pointer-events:auto
 *
 * 注意：本函数接收**纯 CSS 文本**（不含 <style> 包裹）。style 由
 * extractInlineCardStyles 提前抽出、绕过 DOMPurify（DOMPurify 会清空 <style>
 * 内容），本函数只做上述轻保护后由 prepareInlineCard 重新包回 <style>。
 */
function applyCssLightProtection(css: string): string {
  let out = css;
  // 1) :root → 容器（CSS 变量作用域化，卡片内部 var() 引用仍生效）
  out = out.replace(/:root\s*\{/g, '.palink-inline-card{');
  // 2) 顶层 html / body → 容器。匹配「行首或 { / } / , 之后紧跟 html 或 body 再跟 {」
  //    避免误伤 .world-bar body 这类嵌套选择器。
  out = out.replace(/(^|[,}\s])(?:html|body)\s*\{/gm, '$1.palink-inline-card{');
  // 2b) 常见组合 html, body { ... } 也要收（两段分开匹配）
  out = out.replace(/(^|[,}\s])(?:html|body)\s*,\s*(?:html|body)\s*\{/gm, '$1.palink-inline-card{');
  // 3) position: fixed → absolute（防全屏遮罩盖主页面）
  out = out.replace(/position\s*:\s*fixed\s*;/gi, 'position: absolute;');
  // 4) opacity:0（或接近 0）的规则块追加 pointer-events:none，避免透明元素吞掉点击
  out = out.replace(/([^{}]*?)\{([^{}]*?opacity\s*:\s*0(?:\.\d+)?\s*[^{}]*)\}/g, (match, sel: string, props: string) => {
    if (/pointer-events\s*:/i.test(props)) return match;
    return sel + '{' + props + 'pointer-events:none;}';
  });
  // 5) .active 等状态类恢复可点击（灯箱真正打开时才响应点击）
  out = out.replace(/([^{}]*?\.active[^{}]*?)\{([^{}]*?opacity[^{}]*)\}/g, (match, sel: string, props: string) => {
    if (/pointer-events\s*:/i.test(props)) return match;
    return sel + '{' + props + 'pointer-events:auto;}';
  });
  return out;
}

/**
 * 从 HTML 中抽出全部 <style> 块，避免 DOMPurify 清空其内容。
 *
 * DOMPurify 虽然 ADD_TAGS 放行了 <style>，但会清空 style 内的文本（其安全策略
 * 认为 style 内容不可信）。内联卡片大量依赖 <style> 里的 CSS（渐变/布局/变量），
 * 被清空就是「样式丢失」的根因。故在清洗前先把 <style> 整体抽走，清洗后由
 * prepareInlineCard 重新包回。
 *
 * @returns 剥离 <style> 后的 HTML，以及按文档顺序的 CSS 文本列表（含原标签壳）。
 */
export function extractInlineCardStyles(html: string): { html: string; styles: Array<{ css: string; tagAttrs: string }> } {
  const styles: Array<{ css: string; tagAttrs: string }> = [];
  STYLE_TAG_PATTERN.lastIndex = 0;
  const cleaned = String(html || '').replace(STYLE_TAG_PATTERN, (_match, tagAttrs: string, css: string) => {
    styles.push({ css: String(css || ''), tagAttrs: String(tagAttrs || '') });
    return '';
  });
  return { html: cleaned, styles };
}

/**
 * 内联渲染主入口：完整文档剥壳 → 抽脚本 → 抽样式 → 清洗 → CSS 轻保护并回填。
 * 返回可直接注入的 HTML 与待重放脚本。
 */
export function prepareInlineCard(rawHtml: string, cardId: string): InlineCardPrepared {
  const source = String(rawHtml || '');

  // 0) 先抽样式（关键：必须在剥壳前）。
  //    卡片常是完整 <!DOCTYPE html> 文档，<style> 既可能位于 <body>（模型生成的
  //    内联面板），也可能位于 <head>（作者手写的完整卡片文档）。removeFullDocumentShell
  //    只提取 body.innerHTML，会丢弃 <head> 中的 <style>——若等到剥壳后再抽，头部
  //    样式全部丢失（实测：lightbox 的默认隐藏规则 opacity:0/pointer-events:none 丢失，
  //    被主应用同名 .lightbox-overlay CSS 劫持，导致透明遮罩拦截点击、卡片不可交互）。
  const { html: rawNoStyle, styles: headStyles } = extractInlineCardStyles(source);

  // 1) 剥壳（html/head/body 外壳移除；此时 head 内 style 已抽走，不再丢失）
  const body = removeFullDocumentShell(rawNoStyle);

  // 2) 抽脚本（脚本占位符存活，DOMPurify 放行 data-*）
  const { html: noScriptHtml, scripts } = extractInlineCardScripts(body, cardId);

  // 3) 再抽 body 内残留的 <style>（与头部样式合并，保证顺序：头部在前、body 在后）
  const { html: noStyleHtml, styles: bodyStyles } = extractInlineCardStyles(noScriptHtml);
  const styles = [...headStyles, ...bodyStyles];

  // 4) 清洗剩余 HTML（此时已无 script/style，敏感标签仍被禁）
  const sanitized = sanitizeInlineCardHtml(noStyleHtml);

  // 5) 对抽出的纯 CSS 做「轻保护」后回填为 <style>，追加到清洗后 HTML 末尾。
  //    卡片作者用 .mes_text .xxx 自约束（C4），故保留原位置意义不大；统一追加到容器
  //    根部即可保证选择器（含 .mes_text .xxx）仍能命中，且顺序在结构之后不影响层叠。
  const reInjected = styles
    .map(({ css, tagAttrs }) => `<style${tagAttrs}>${applyCssLightProtection(css)}</style>`)
    .join('\n');

  return { html: reInjected ? `${sanitized}\n${reInjected}` : sanitized, scripts };
}
