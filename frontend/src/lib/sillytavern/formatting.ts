import DOMPurify from 'dompurify';
import katex from 'katex';
import { Converter } from 'showdown';
import type showdown from 'showdown';
import { getRegexedString, type RegexScript } from './regex/engine';
import { substituteParams, substituteParamsExtended } from './macros';

// ST 兼容的 DOMPurify hooks（只注册一次）
let stDomPurifyHooksRegistered = false;
function registerStDomPurifyHooks(): void {
  if (stDomPurifyHooksRegistered) return;
  stDomPurifyHooksRegistered = true;

  // V2 新增：安全加固 - 动态移除所有 on* 事件属性
  // 不检查 MESSAGE_SANITIZE（与链接安全一致，始终运行）
  // 比 FORBID_ATTR 列举更彻底，覆盖所有 on* 事件属性
  DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
    if (node.attributes) {
      // 从后往前删除，避免索引错乱
      for (let i = node.attributes.length - 1; i >= 0; i--) {
        const attr = node.attributes[i];
        if (attr.name.toLowerCase().startsWith('on')) {
          node.removeAttribute(attr.name);
        }
      }
    }
  });

  // 链接安全: 给真实外链添加 target="_blank" 和 rel="noopener noreferrer"
  // 不检查 MESSAGE_SANITIZE（与 ST 一致）
  // 但占位锚点（href 为空、#、纯片段、javascript:）除外：它们是"按钮式"锚点，
  // 卡片脚本被净化剥离后无任何真实跳转语义。给 href="#" 加 target="_blank" 后，
  // 点击会用当前完整 URL（含会话 id）新开窗口，表现为"相同网址 + 相同对话"的
  // 重复页面（对任意卡片通用）。这里同时移除卡片自带的 target，避免卡面自带
  // target="_blank" 时同样复现。
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName && node.tagName.toLowerCase() === 'a') {
      const href = (node.getAttribute('href') || '').trim().toLowerCase();
      const isPlaceholder = href === '' || href.startsWith('#') || href.startsWith('javascript:');
      if (isPlaceholder) {
        node.removeAttribute('target');
        return;
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // class 隔离: 添加 custom- 前缀（白名单前缀除外）
  // 仅在消息消毒时运行（MESSAGE_SANITIZE）
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data, config: any) => {
    if (!config?.MESSAGE_SANITIZE) return;
    if (data.attrName === 'class') {
      const value = data.attrValue;
      if (!value) {
        data.attrValue = '';
        return;
      }
      const classes = value.split(/\s+/).filter(c => c);
      const prefixList = ['fa-', 'note-', 'custom-', 'katex-'];
      const exactList = ['monospace', 'mes_text', 'mes_block', 'mes', 'last_mes', 'last_mes_text', 'swipe', 'swipes', 'reasoning', 'code', 'code-box', 'markdown-content', 'mes_reasoning_details', 'mes_reasoning_summary', 'mes_reasoning_header_title', 'mes_reasoning', 'katex'];
      const prefixed = classes.map(cls => {
        // 白名单:不前缀化（精确匹配或有效前缀匹配）
        if (exactList.includes(cls) || prefixList.some(prefix => cls.startsWith(prefix) && cls.length > prefix.length)) {
          return cls;
        }
        return 'custom-' + cls;
      });
      data.attrValue = prefixed.join(' ');
    }
  });

  // 换行转换: HTMLUnknownElement 中的 \n 转换为 <br>
  // 仅在消息消毒时运行（MESSAGE_SANITIZE）
  // 使用 uponSanitizeElement 事件，检查祖先 pre 元素（而非后代），避免破坏代码块格式
  // 使用 DOM API 而非 innerHTML 操作（除 trim 外），避免 XSS 向量
  DOMPurify.addHook('uponSanitizeElement', (node, _data, config: any) => {
    if (!config?.MESSAGE_SANITIZE) return;
    if (!(node instanceof HTMLUnknownElement)) return;
    // 检查祖先 pre 元素（而非后代），避免破坏代码块格式
    if (node.closest('pre')) {
      return;
    }
    // 先 trim innerHTML，去除首尾空白换行
    node.innerHTML = node.innerHTML.trim();
    // 安全地处理换行：遍历文本节点
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }
    textNodes.forEach(textNode => {
      if (textNode.textContent?.includes('\n')) {
        const parts = textNode.textContent.split('\n');
        const parent = textNode.parentNode;
        if (parent) {
          parts.forEach((part, i) => {
            // 跳过空文本部分
            if (part) {
              parent.insertBefore(document.createTextNode(part), textNode);
            }
            if (i < parts.length - 1) {
              parent.insertBefore(document.createElement('br'), textNode);
            }
          });
          parent.removeChild(textNode);
        }
      }
    });
  });
}

registerStDomPurifyHooks();

// ── 统一的 ST 兼容 DOMPurify 配置 ─────────────────────────────
// 所有调用 DOMPurify 的地方都应以此为基础配置，按需扩展
export const ST_DOMPURIFY_CONFIG = {
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_TRUSTED_TYPE: false,
  ADD_TAGS: [
    'custom-style', 'font', 'content', 'thinking', 'analysis', 'reasoning',
    'start', 'now_plot', 'sakura_status', 'style', 'nsfw',
    // F-1: KaTeX htmlAndMathml 输出的 MathML 标签（默认白名单部分缺失，显式兜底）
    'math', 'semantics', 'annotation', 'annotation-xml', 'mrow', 'mi', 'mo', 'mn',
    'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'mtext',
    'mspace', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'mmultiscripts',
    'mphantom',
  ],
  ADD_ATTR: [
    'color', 'face', 'size', 'target', 'rel', 'href', 'src', 'alt', 'title',
    'class', 'style', 'id', 'name', 'value', 'type', 'width', 'height',
    'colspan', 'rowspan', 'align', 'valign', 'bgcolor',
    // F-1: KaTeX MathML 属性
    'encoding', 'mathvariant', 'displaystyle', 'stretchy', 'fence', 'lspace',
    'rspace', 'voffset', 'depth', 'notation',
  ],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
};

// 构建消息消毒配置（ST 对齐：始终启用 MESSAGE_SANITIZE）
export function buildMessageSanitizeConfig(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...ST_DOMPURIFY_CONFIG,
    MESSAGE_SANITIZE: true,
    ...overrides,
  };
}

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`\n]+`/g;
const DISPLAY_MATH_REGEX = /\$\$[\s\S]*?\$\$/g;
const INLINE_MATH_REGEX = /\$[^$\n]+?\$/g;

export interface ProtectedBlocks {
  text: string;
  blocks: string[];
}

export function protectCodeBlocks(text: string, placeholder = '\x00CODE\x00'): ProtectedBlocks {
  const blocks: string[] = [];
  let protectedText = text.replace(CODE_BLOCK_REGEX, (match) => {
    blocks.push(match);
    return `${placeholder}${blocks.length - 1}${placeholder}`;
  });
  protectedText = protectedText.replace(INLINE_CODE_REGEX, (match) => {
    blocks.push(match);
    return `${placeholder}${blocks.length - 1}${placeholder}`;
  });
  return { text: protectedText, blocks };
}

export function protectMathBlocks(text: string, placeholder = '\x00MATH\x00'): ProtectedBlocks {
  const blocks: string[] = [];
  let protectedText = text.replace(DISPLAY_MATH_REGEX, (match) => {
    blocks.push(match);
    return `${placeholder}${blocks.length - 1}${placeholder}`;
  });
  protectedText = protectedText.replace(INLINE_MATH_REGEX, (match) => {
    blocks.push(match);
    return `${placeholder}${blocks.length - 1}${placeholder}`;
  });
  return { text: protectedText, blocks };
}

export function restoreProtectedBlocks(text: string, blocks: string[], placeholder = '\x00CODE\x00'): string {
  return text.replace(new RegExp(`${placeholder}(\\d+)${placeholder}`, 'g'), (_, index) => {
    return blocks[parseInt(index, 10)] || '';
  });
}

// ── LaTeX 渲染（完成态管线，F-1 修复 2026-08-23）────────────
// 流式期 MarkdownRenderer 走 remark-math + rehype-katex 可渲染公式；完成态
// showdown 管线此前无 katex 处理 → 公式塌回 $x^2$ 原文（流式/完成态突变）。
// 此处在 Showdown 之后、DOMPurify 之前把数学片段预渲染为 KaTeX HTML，
// 与流式引擎视觉对齐（katex.min.css 已在 index.html 全局加载）。

const DISPLAY_MATH_HTML_REGEX = /\$\$([\s\S]+?)\$\$/g;
// 行内 $...$：首尾非空白非$，避免 "价格 $5 和 $10" 类误配
const INLINE_MATH_HTML_REGEX = /\$([^\s$](?:[^$\n]*[^\s$])?)\$/g;
const PAREN_MATH_HTML_REGEX = /\\\(([\s\S]+?)\\\)/g;
const BRACKET_MATH_HTML_REGEX = /\\\[([\s\S]+?)\\\]/g;
const CODE_SEGMENT_SPLIT_REGEX = /(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/gi;

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function renderSingleMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'htmlAndMathml',
    });
  } catch {
    // 渲染失败保留原文（与"公式塌回原文"等价，但不影响其余内容）
    return displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
}

function renderMathInSegment(segment: string): string {
  if (!segment.includes('$') && !segment.includes('\\(') && !segment.includes('\\[')) {
    return segment;
  }
  let result = segment.replace(BRACKET_MATH_HTML_REGEX, (_, tex) => renderSingleMath(decodeBasicEntities(tex), true));
  result = result.replace(PAREN_MATH_HTML_REGEX, (_, tex) => renderSingleMath(decodeBasicEntities(tex), false));
  result = result.replace(DISPLAY_MATH_HTML_REGEX, (_, tex) => renderSingleMath(decodeBasicEntities(tex), true));
  result = result.replace(INLINE_MATH_HTML_REGEX, (_, tex) => renderSingleMath(decodeBasicEntities(tex), false));
  return result;
}

/**
 * 完成态 HTML 中的数学片段 → KaTeX HTML。
 * <pre>/<code> 段原样保留（代码里的 $ 不是公式）。
 */
export function renderMathInHtml(html: string): string {
  if (!html || (!html.includes('$') && !html.includes('\\(') && !html.includes('\\['))) {
    return html;
  }
  return html.split(CODE_SEGMENT_SPLIT_REGEX).map((part, idx) => {
    // split 带捕获组：奇数下标为 code/pre 段，原样保留
    if (idx % 2 === 1) return part;
    return renderMathInSegment(part);
  }).join('');
}

// ── HTML 块提取/还原 ─────────────────────────────────────────
// 解决 Showdown HTML mode 问题：Showdown 遇到 HTML 标签会进入 HTML mode，
// 导致 Markdown 标记不转换、未知标签被转义。
// 方案：在 Showdown 转换前提取 HTML 块为占位符，转换后还原。


// 占位符使用 Private Use Area 字符 (\uE000) 作为边界，
// 避免 HTML 注释被 Showdown 过滤，同时避免 \x00 控制字符被 DOMPurify 吞掉。
const HTML_BLOCK_PLACEHOLDER_PREFIX = '\uE000PALINK_HTMLBLOCK_';
const HTML_BLOCK_PLACEHOLDER_SUFFIX = '\uE000';

function makeHtmlBlockPlaceholder(index: number): string {
  return `${HTML_BLOCK_PLACEHOLDER_PREFIX}${index}${HTML_BLOCK_PLACEHOLDER_SUFFIX}`;
}

const HTML_BLOCK_REGEX = new RegExp(
  `${HTML_BLOCK_PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${HTML_BLOCK_PLACEHOLDER_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  'g'
);

// 需要保护的 HTML 块标签（块级 + 行内 + 自定义语义标签）
// V2 扩展：覆盖所有常见 HTML 标签，避免 Showdown 进入 HTML mode
const HTML_BLOCK_TAGS = [
  // 原有标签
  'style', 'div', 'font', 'span', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'section', 'article', 'main', 'aside', 'nav', 'header', 'footer', 'details',
  'summary', 'form', 'button', 'input', 'select', 'textarea', 'center', 'marquee',
  'content', 'thinking', 'analysis', 'reasoning', 'start', 'now_plot', 'sakura_status',
  'custom-style', 'q', 'blockquote', 'nsfw',
  // V2 新增：标题
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // V2 新增：段落与链接
  'p', 'a',
  // V2 新增：强调
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  // V2 新增：列表
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // V2 新增：代码
  'code', 'pre', 'kbd', 'samp',
  // V2 新增：媒体
  'figure', 'figcaption', 'picture', 'video', 'audio', 'source',
  // V2 新增：表格相关
  'caption', 'colgroup', 'col',
  // V2 新增：其他
  'address', 'cite', 'dfn', 'abbr', 'time', 'progress', 'meter',
];

export interface HtmlBlocks {
  text: string;
  blocks: string[];
}

/**
 * 判断内容中是否包含一份完整的 HTML 文档（`<!DOCTYPE html>…</html>` 或 `<html>…</html>`）。
 *
 * 用途：角色卡状态栏 / smart-card 的 regex_scripts 会把 `<StatusPlaceHolderImpl/>` 占位符
 * 替换为一整份 HTML 文档。DOMPurify 默认 `WHOLE_DOCUMENT: false`，会剥掉
 * `<!DOCTYPE>`/`<html>`/`<head>`/`<body>`，使文档结构残缺、`<head>` 内样式与 `<script>` 丢失，
 * iframe 最终只拿到一段"尸体" HTML，面板黑屏。
 *
 * 该判定刻意保持轻量、零依赖（`lib/` 不可反向依赖 `components/`，且 Worker 内也要能用）。
 * 阈值 200 字符用于避免误伤正文里偶然出现的 `<html>` 字样。
 */
export function containsFullHtmlDocument(text: string): boolean {
  if (!text || text.length < 200) return false;
  const match = /(?:<!DOCTYPE\s+html|<html\b)[\s\S]*?<\/html>/i.exec(text);
  if (!match) return false;
  return match[0].length > 200 && /<(?:body|script|head|style)\b/i.test(match[0]);
}

// 提取 HTML 块，替换为占位符，保护其内容不被 Showdown 处理
export function extractHtmlBlocks(text: string): HtmlBlocks {
  const blocks: string[] = [];
  // 保护 ``` 代码围栏包裹的完整 HTML 文档（角色卡状态栏 / smart-card 渲染源）。
  // 若不保护，Showdown 会将其转义为 <pre><code> 代码块，破坏后续 smart-card 识别与渲染。
  // 仅当围栏内部是 HTML 文档（含 <!DOCTYPE>/<html>/<script>/<style>）时才保护，
  // 普通代码块仍交给 Showdown 正常处理。
  let result = text.replace(/```[^\n]*\n([\s\S]*?)\n```/gi, (full, inner) => {
    if (/<!DOCTYPE\s+html|<html[\s>]|<script[\s>]|<style[\s>]/i.test(inner)) {
      const index = blocks.length;
      // 只保留围栏内部 HTML，丢弃 ```html / ``` 围栏标记：Showdown 会把占位符包进
      // <p>，恢复时若含围栏标记，会以可见文本（<p>```html…）残留在消息里（ST 不显示
      // 这些标记，开场白/状态栏 HTML 围栏只应贡献内部文档）。
      blocks.push(inner.trim());
      return makeHtmlBlockPlaceholder(index);
    }
    return full;
  });
  // 保护独立的完整 HTML 文档块（例如 regex_scripts 注入的状态栏 HTML）。
  // 这类文档通常没有 ``` 围栏包裹，若不被保护，Showdown 会把 <!DOCTYPE/<html/<script
  // 当作 markdown 文本转义或丢弃，导致 iframe 拿到的是残缺 HTML，面板黑屏。
  // 条件：块较大（>200 字符）且包含 body/script/head/style 之一，避免误伤普通文本。
  result = result.replace(/(?:<!DOCTYPE\s+html|<html\b)[\s\S]*?<\/html>/gi, (match) => {
    if (match.length > 200 && /<(?:body|script|head|style)\b/i.test(match)) {
      const index = blocks.length;
      blocks.push(match);
      return makeHtmlBlockPlaceholder(index);
    }
    return match;
  });
  // 先保护 <style> 块（避免内部 CSS 被 Showdown 破坏）
  result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (match) => {
    const index = blocks.length;
    blocks.push(match);
    return makeHtmlBlockPlaceholder(index);
  });
  // 保护其他 HTML 块（支持嵌套，循环处理直到无变化）
  const tagPattern = new RegExp(
    `<(${HTML_BLOCK_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
    'gi'
  );
  let prevResult = '';
  while (result !== prevResult) {
    prevResult = result;
    result = result.replace(tagPattern, (match) => {
      const index = blocks.length;
      blocks.push(match);
      return makeHtmlBlockPlaceholder(index);
    });
  }
  // 保护自闭合 HTML 标签
  result = result.replace(/<(?:br|hr|img|input|meta|link)\b[^>]*\/?>/gi, (match) => {
    const index = blocks.length;
    blocks.push(match);
    return makeHtmlBlockPlaceholder(index);
  });
  return { text: result, blocks };
}

// 还原 HTML 块占位符为原始内容
// 循环处理嵌套占位符：外层块还原后可能仍包含内层占位符，需持续替换直到无变化
export function restoreHtmlBlocks(text: string, blocks: string[]): string {
  let result = text;
  let prevResult = '';
  while (result !== prevResult) {
    prevResult = result;
    result = result.replace(HTML_BLOCK_REGEX, (_, index) => {
      return blocks[parseInt(index, 10)] || '';
    });
  }
  return result;
}

export function collapseNewlines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

export function fixMarkdown(text: string, aggressive = false): string {
  let result = text;
  result = result.replace(/```\s+\n/g, '```\n');
  result = result.replace(/^(\s*[-*+]\s+)\n+/gm, '$1');
  result = result.replace(/\n\n(\s*[-*+]\s+)/g, '\n$1');
  return result;
}

export function stripHtmlTags(text: string, allowedTags?: string[]): string {
  if (!allowedTags || allowedTags.length === 0) {
    return text.replace(/<[^>]+>/g, '');
  }
  const allowedPattern = new RegExp(`<(?!\\/?(?:${allowedTags.join('|')})\\b)[^>]*>`, 'gi');
  return text.replace(allowedPattern, '');
}

export function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function canUseNegativeLookbehind(): boolean {
  try {
    new RegExp('(?<!_)');
    return true;
  } catch {
    return false;
  }
}

export function encodeTags(text: string): string {
  if (canUseNegativeLookbehind()) {
    return text.replaceAll('<', '&lt;').replace(new RegExp('(?<!^|\n\s*)>', 'g'), '&gt;');
  }
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function stripSillyTavernNamePrefix(
  content: string,
  characterName?: string,
  isUser?: boolean,
  isSystem?: boolean
): string {
  const name = String(characterName || '').trim();
  if (!name || isUser || isSystem) return content;
  const pattern = new RegExp(`(^|\n)\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*[:：]\s*`, 'g');
  return String(content || '').replace(pattern, '$1');
}

export function wrapSillyTavernQuotedText(content: string): string {
  // 引号字符一律使用 \uXXXX 转义（对齐 ST script.js L1870-1896 原版写法）。
  // 历史 bug：此前正则中的中文弯引号等字面字符曾被编码损坏为 ASCII 引号，
  // 导致中文对话 “...” 永远无法包裹成 <q>、正文引号着色失效（2026-08-21 实测）。
  return String(content || '').replace(
    /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?```|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
    (match, p1, p2, p3, p4, p5, p6) => {
      if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
      if (p2) return `<q>\u201C${p2.slice(1, -1)}\u201D</q>`;
      if (p3) return `<q>\u00AB${p3.slice(1, -1)}\u00BB</q>`;
      if (p4) return `<q>\u300C${p4.slice(1, -1)}\u300D</q>`;
      if (p5) return `<q>\u300E${p5.slice(1, -1)}\u300F</q>`;
      if (p6) return `<q>\uFF02${p6.slice(1, -1)}\uFF02</q>`;
      return match;
    },
  );
}

export function stripDisplayOnlySemanticTags(content: string): string {
  // 注意: summary 标签不处理,因为 HTML5 有合法的 <summary> 标签(用于 <details>),
  // 处理会破坏合法 HTML 结构
  // V3 调整: content 不再视为 display-only 语义标签,避免掩藏角色卡正文;
  //          message/response 也保留,因为它们可能包含正文内容
  const tagPattern = /<(think|thinking|thought|analysis|reasoning|reflection|plan|hidden|private|internal|system|note|memo)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let result = String(content || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<comment\b[^>]*>[\s\S]*?<\/comment>/gi, '');

  // 循环处理嵌套标签
  let prevResult = '';
  while (result !== prevResult) {
    prevResult = result;
    result = result.replace(tagPattern, '');
  }

  // 移除未闭合的标签(单边)
  result = result
    .replace(/<(?:think|thinking|thought|analysis|reasoning|reflection|plan|hidden|private|internal|system|note|memo)\b[^>]*>/gi, '')
    .replace(/<\/(?:think|thinking|thought|analysis|reasoning|reflection|plan|hidden|private|internal|system|note|memo)>/gi, '')
    .trim();

  return result;
}

export function normalizeSillyTavernDisplayMarkdown(content: string): string {
  return String(content || '')
    .replaceAll('\\begin{align*}', '$$')
    .replaceAll('\\end{align*}', '$$');
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract reasoning/thinking tags from the message content. Returns the cleaned
// content and an array of reasoning blocks. This mirrors how ST stores reasoning
// in message.extra.reasoning separately from the message body.
const REASONING_TAGS = ['think', 'thinking', 'reasoning', 'analysis'];
const FUNCTION_CALL_BEGIN = '<|FunctionCallBegin|>';
const FUNCTION_CALL_END = '<|FunctionCallEnd|>';

export function extractReasoningTags(text: string): { content: string; reasoning: string[] } {
  if (!text) return { content: text, reasoning: [] };
  let content = text;
  const reasoning: string[] = [];

  // 1. Extract HTML-style reasoning tags (<think>, <reasoning>, ...)
  for (const tag of REASONING_TAGS) {
    const openRegex = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    content = content.replace(openRegex, () => `\u0000REASONING_OPEN_${tag}\u0000`);
    content = content.replace(new RegExp(`</${tag}>`, 'gi'), `\u0000REASONING_CLOSE_${tag}\u0000`);
  }

  for (const tag of REASONING_TAGS) {
    const openMarker = `\u0000REASONING_OPEN_${tag}\u0000`;
    const closeMarker = `\u0000REASONING_CLOSE_${tag}\u0000`;
    let cursor = 0;
    let cleaned = '';
    while (cursor < content.length) {
      const start = content.indexOf(openMarker, cursor);
      if (start === -1) {
        cleaned += content.slice(cursor);
        break;
      }
      cleaned += content.slice(cursor, start);
      const contentStart = start + openMarker.length;
      const end = content.indexOf(closeMarker, contentStart);
      if (end === -1) {
        const tail = content.slice(contentStart).trim();
        if (tail) reasoning.push(tail);
        cursor = content.length;
        break;
      }
      const section = content.slice(contentStart, end).trim();
      if (section) reasoning.push(section);
      cursor = end + closeMarker.length;
    }
    content = cleaned;
  }

  // 2. Extract ST function-call markers (<|FunctionCallBegin|>...<|FunctionCallEnd|>)
  //    These are non-HTML markers used by some backends/presets to wrap reasoning.
  const fcBeginRegex = new RegExp(escapeRegex(FUNCTION_CALL_BEGIN), 'gi');
  const fcEndRegex = new RegExp(escapeRegex(FUNCTION_CALL_END), 'gi');
  content = content.replace(fcBeginRegex, '\u0000FUNCTION_CALL_OPEN\u0000');
  content = content.replace(fcEndRegex, '\u0000FUNCTION_CALL_CLOSE\u0000');

  const fcOpen = '\u0000FUNCTION_CALL_OPEN\u0000';
  const fcClose = '\u0000FUNCTION_CALL_CLOSE\u0000';
  let cursor = 0;
  let cleanedFc = '';
  while (cursor < content.length) {
    const start = content.indexOf(fcOpen, cursor);
    if (start === -1) {
      cleanedFc += content.slice(cursor);
      break;
    }
    cleanedFc += content.slice(cursor, start);
    const contentStart = start + fcOpen.length;
    const end = content.indexOf(fcClose, contentStart);
    if (end === -1) {
      const tail = content.slice(contentStart).trim();
      if (tail) reasoning.push(tail);
      cursor = content.length;
      break;
    }
    const section = content.slice(contentStart, end).trim();
    if (section) reasoning.push(section);
    cursor = end + fcClose.length;
  }
  content = cleanedFc;

  return { content: content.trim(), reasoning };
}

// 切除 prompt bias 内容（防止泄漏到用户可见区）
// ST 兼容：移除 {"bias": [...]} 标记
function stripPromptBias(text: string): string {
  // 匹配 {"bias": [...]} 格式的 bias 标记
  // ST 原版使用 JSON.parse 检测，这里用正则简化
  return text.replace(/\{"bias"\s*:\s*\[[\s\S]*?\]\}/g, '');
}

// Render extracted reasoning blocks as a ST-compatible <details> foldable block.
export function renderReasoningDetails(reasoningHtml: string, title = '模型思考'): string {
  if (!reasoningHtml) return '';
  // 对 title 做 HTML 转义保护，防止 XSS
  const safeTitle = escapeHtmlEntities(title);
  // 对 reasoning 内容中的特殊字符做转义保护
  const protectedReasoning = reasoningHtml
    .replace(/<script/gi, '&lt;script')
    .replace(/<\/script/gi, '&lt;/script');
  return `<details class="mes_reasoning_details"><summary class="mes_reasoning_summary"><span class="mes_reasoning_header_title">${safeTitle}</span></summary><div class="mes_reasoning">${protectedReasoning}</div></details>`;
}

// Showdown extension: replace words surrounded by singular underscores with <em> tags
// (ported from ST's showdown-underscore.js)
export function markdownUnderscoreExt(): showdown.ShowdownExtension[] {
  try {
    if (!canUseNegativeLookbehind()) {
      return [];
    }
    return [{
      type: 'output',
      regex: new RegExp('(<code(?:\\s+[^>]*)?>[\\s\\S]*?<\\/code>|<style(?:\\s+[^>]*)?>[\\s\\S]*?<\\/style>)|\\b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\\b', 'gi'),
      replace: function (match: string, tagContent: string, italicContent: string) {
        if (tagContent) {
          return match;
        } else if (italicContent) {
          return '<em>' + italicContent + '</em>';
        }
        return match;
      },
    }];
  } catch {
    return [];
  }
}

// Showdown converter singleton (ST-compatible config)
let showdownConverter: Converter | null = null;

export function getShowdownConverter(): Converter {
  if (!showdownConverter) {
    showdownConverter = new Converter({
      emoji: true,
      literalMidWordUnderscores: true,
      parseImgDimensions: true,
      tables: true,
      underline: true,
      simpleLineBreaks: true,
      strikethrough: true,
      disableForced4SpacesIndentedSublists: true,
      extensions: [markdownUnderscoreExt()],
    });
  }
  return showdownConverter;
}

export function resetShowdownConverter(): void {
  showdownConverter = null;
}

// encodeStyleTags / decodeStyleTags: protect <style> blocks during DOMPurify
export function encodeStyleTags(html: string): string {
  return html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, cssContent: string) => {
    return `<custom-style>${encodeURIComponent(cssContent)}</custom-style>`;
  });
}

// 移除危险的 CSS 构造（@import、javascript:/data:/vbscript:/file: URL、expression()、-moz-binding）
export function sanitizeCss(css: string): string {
  return String(css || '')
    .replace(/@import\s+[^;]+;/gi, '')
    .replace(/url\(\s*(['"]?)\s*javascript:[^)]+\)/gi, 'url()')
    .replace(/url\(\s*(['"]?)\s*(?:data|vbscript|file):[^)]+\)/gi, 'url()')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/-moz-binding\s*:[^;]+;/gi, '');
}

// 简单选择器的类名前缀化：将 .cls 改为 .custom-cls
// 跳过已以 custom- 开头的类名（与 ST 的 sanitizeSimpleSelector 对齐）
function sanitizeSimpleSelector(selector: string): string {
  return selector.replace(/\.([a-zA-Z0-9_-]+)/g, (match, cls) => {
    if (cls.startsWith('custom-')) return match;
    return '.custom-' + cls;
  });
}

// 处理选择器中的类名前缀化，包括 :has()/:not()/:where()/:is()/:matches()/:any() 内的嵌套选择器
// 对伪类函数内部内容调用 sanitizeSimpleSelector，再对外部类名进行前缀化
function sanitizeSelector(selector: string): string {
  // 匹配伪类函数 :has()/:not()/:where()/:is()/:matches()/:any()
  const pseudoFnPattern = /(:)(has|not|where|is|matches|any)(\s*\()([^)]*)(\))/gi;
  // 先处理伪类函数内的嵌套选择器
  let result = selector.replace(pseudoFnPattern, (_match, colon, fnName, openParen, inner, closeParen) => {
    return colon + fnName + openParen + sanitizeSimpleSelector(inner) + closeParen;
  });
  // 再处理外部的类名（sanitizeSimpleSelector 跳过已前缀化的类名，重复调用安全）
  result = sanitizeSimpleSelector(result);
  return result;
}

// 为单个选择器添加作用域前缀
function scopeSelector(selector: string, scopeSelectorText: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  // 先对选择器进行类名前缀化（与 DOMPurify class 前缀化 hook 对齐）
  const sanitized = sanitizeSelector(trimmed);
  // 支持原生 CSS 嵌套（& 选择器）
  if (sanitized.includes('&')) {
    return sanitized.replace(/&/g, scopeSelectorText.trim());
  }
  if (sanitized.startsWith(scopeSelectorText)) return sanitized;
  // SubTask 9.3: :root 选择器保持全局（CSS 变量定义等需要全局作用域）
  // :root 和 :root.xxx 不添加作用域前缀
  if (/^:root$/i.test(sanitized) || /^:root\./i.test(sanitized)) return sanitized;
  // html:root 选择器保持全局
  if (/^html:root/i.test(sanitized)) return sanitized;
  if (/^(?:html|body)$/i.test(sanitized)) return scopeSelectorText;
  if (/^(?:html|body)\b/i.test(sanitized)) {
    return sanitized.replace(/^(?:html|body)\b/i, scopeSelectorText);
  }
  return `${scopeSelectorText} ${sanitized}`;
}

// 找到匹配的闭合大括号，正确处理引号和转义
function findMatchingBrace(css: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = openIndex; i < css.length; i += 1) {
    const char = css[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

// 智能分割选择器列表,不破坏 :is()/:not()/:has()/:where() 函数内逗号
function splitSelectors(selectorText: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of selectorText) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) result.push(current);
  return result;
}

// 用 CSSOM 递归地为 CSS 规则列表添加作用域前缀（scopeSelector 复用既有逻辑）。
// 与手工括号匹配不同，浏览器原生解析对畸形 CSS（未闭合引号/残缺 data URI 等）容错：
// 畸形声明被浏览器丢弃、正常规则照常保留，不会出现"解析失败后整段原样输出"的漏网
// （实测某卡 body 规则的 SVG data URI 含悬空单引号，手工匹配器误判未闭合 → 整段 CSS
// 未被作用域化 → 卡片样式全部失效，与 ST 显示不一致）。
function scopeCssRuleList(rules: CSSRuleList, scopeSelectorText: string): string {
  const parts: string[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (rule.type === CSSRule.STYLE_RULE) {
      const cssRule = rule as CSSStyleRule;
      const selectors = splitSelectors(cssRule.selectorText)
        .map((selector) => scopeSelector(selector, scopeSelectorText))
        .filter(Boolean)
        .join(', ');
      let declarations = cssRule.style.cssText;
      // 卡片 html/body 全局规则作用域化到消息容器时，若未显式声明 color，注入卡片主题
      // 文字色 var(--text-main)（卡片 :root 定义的设计系统文字色，深色界面卡通常都有）。
      // 否则在浅色宿主主题下 .mes_text 继承深色文字，落在卡片的深色背景上不可读（ST 中
      // 该问题由宿主默认深色主题掩盖；Palink 需自行兜底）。未定义 --text-main 时回退
      // inherit（保持宿主原色，不改变既有行为）。
      if (/^(?:html|body)\b/i.test(cssRule.selectorText.trim()) && !hasExplicitColorDeclaration(declarations)) {
        // !important 是为了压过宿主主题对 .mes_text 的文字色规则（如
        // .roleplay-container .markdown-content 特异性更高），否则浅色主题下深色文字
        // 落在卡片深色背景上不可读。仅作用于继承文字色，不影响子元素自身声明的颜色。
        declarations = `${declarations}color: var(--text-main, inherit) !important;`;
      }
      parts.push(selectors ? `${selectors}{${declarations}}` : cssRule.cssText);
    } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
      const group = rule as CSSMediaRule | CSSSupportsRule;
      const inner = scopeCssRuleList(group.cssRules, scopeSelectorText);
      if (inner) {
        const header = rule.type === CSSRule.MEDIA_RULE
          ? `@media ${group.conditionText}`
          : `@supports ${group.conditionText}`;
        parts.push(`${header}{${inner}}`);
      }
    } else if (rule.type === CSSRule.IMPORT_RULE) {
      // 丢弃 @import，避免拉取外部资源
    } else {
      // @keyframes / @font-face 等 at-rule：原样保留
      parts.push(rule.cssText);
    }
  }
  return parts.join('\n');
}

// 判断声明块是否已显式声明 color（精确匹配 color:，避免误中 background-color 等）
function hasExplicitColorDeclaration(declarations: string): boolean {
  return String(declarations || '').split(';').some((decl) => /^\s*color\s*:/.test(decl));
}

// 递归地为 CSS 规则添加作用域前缀
// 处理 @media/@supports/@container/@layer 嵌套规则、@keyframes 等 at-rules、
// :hover/:focus/:active 伪类、::before/::after 伪元素、组合器、逗号分隔选择器列表
// 优先使用浏览器原生 CSSOM 解析（对畸形 CSS 容错），失败时降级到手工括号匹配。
export function scopeCss(css: string, scopeSelectorText: string): string {
  const safeCss = sanitizeCss(css);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(safeCss);
    return scopeCssRuleList(sheet.cssRules, scopeSelectorText);
  } catch {
    let result = '';
    let cursor = 0;
    while (cursor < safeCss.length) {
      const openIndex = safeCss.indexOf('{', cursor);
      if (openIndex === -1) {
        result += safeCss.slice(cursor);
        break;
      }
      const selectorText = safeCss.slice(cursor, openIndex).trim();
      const closeIndex = findMatchingBrace(safeCss, openIndex);
      if (closeIndex === -1) {
        result += safeCss.slice(cursor);
        break;
      }
      const body = safeCss.slice(openIndex + 1, closeIndex);
      if (!selectorText) {
        result += safeCss.slice(cursor, closeIndex + 1);
      } else if (/^@(?:media|supports|container|layer)\b/i.test(selectorText)) {
        // 嵌套 at-rules: 递归处理内部规则
        result += `${selectorText}{${scopeCss(body, scopeSelectorText)}}`;
      } else if (/^@/i.test(selectorText)) {
        // 其他 at-rules（如 @keyframes）: 保持内部内容不变
        result += `${selectorText}{${body}}`;
      } else {
        // 普通选择器: 拆分逗号列表,为每个选择器添加前缀
        // 使用智能分割,不破坏 :is()/:not()/:has()/:where() 函数内逗号
        const selectors = splitSelectors(selectorText)
          .map((selector) => scopeSelector(selector, scopeSelectorText))
          .filter(Boolean)
          .join(', ');
        let declarations = body;
        if (/^(?:html|body)\b/i.test(selectorText) && !hasExplicitColorDeclaration(declarations)) {
          declarations = `${declarations}color: var(--text-main, inherit) !important;`;
        }
        result += selectors ? `${selectors}{${declarations}}` : `${selectorText}{${declarations}}`;
      }
      cursor = closeIndex + 1;
    }
    return result;
  }
}

export function decodeStyleTags(text: string, options: { prefix?: string } = {}): string {
  const prefix = options.prefix ?? '.mes_text ';
  const styleDecodeRegex = /<custom-style>([\s\S]+?)<\/custom-style>/gi;
  return text.replace(styleDecodeRegex, (_match, encoded: string) => {
    try {
      const styleCleaned = decodeURIComponent(encoded).replace(/<br\/>/g, '');
      if (!prefix) {
        return `<style>${sanitizeCss(styleCleaned)}</style>`;
      }
      const scoped = scopeCss(styleCleaned, prefix);
      return `<style>${scoped}</style>`;
    } catch (error) {
      return `CSS ERROR: ${error}`;
    }
  });
}

/**
 * 预处理 Markdown 文本，为 showdown 转换做准备。
 * 包含双引号保护、引号文本包裹、LaTeX align 环境归一化。
 * 抽取自 formatMessage，供流式与非流式路径复用以保证产出 HTML 一致。
 */
export function preprocessMarkdownForShowdown(rawText: string, encodeTagsEnabled = false): string {
  let mes = String(rawText || '');

  // Save double quotes in tags to prevent encoding
  if (!encodeTagsEnabled) {
    mes = mes.replace(/<([^>]+)>/g, (_, contents) => {
      return '<' + contents.replace(/"/g, '\ufffe') + '>';
    });
  }

  mes = wrapSillyTavernQuotedText(mes);

  if (!encodeTagsEnabled) {
    mes = mes.replace(/\ufffe/g, '"');
  }

  mes = normalizeSillyTavernDisplayMarkdown(mes);

  return mes;
}

export interface FormatMessageContext {
  characterName?: string;
  isSystem?: boolean;
  isUser?: boolean;
  messageId?: number;
  isReasoning?: boolean;
  depth?: number;
  userName?: string;
  modelName?: string;
  dynamicMacros?: Record<string, string | (() => string)>;
  postProcessFn?: (text: string) => string;
  sanitizerOverrides?: Record<string, unknown>;
  encodeTagsEnabled?: boolean;
  allowName2Display?: boolean;
  autoFixMarkdown?: boolean;
}

export interface RegexParams {
  characterOverride?: string;
  isMarkdown?: boolean;
  isPrompt?: boolean;
  isEdit?: boolean;
  depth?: number;
  globalScripts?: RegexScript[];
  scopedScripts?: RegexScript[];
  presetScripts?: RegexScript[];
  allowedOnly?: boolean;
  characterAllowed?: string[];
  characterAvatar?: string;
  presetApiId?: string;
  presetName?: string;
  userName?: string;
  characterName?: string;
}

export interface FormatMessageOptions {
  runRegex?: boolean;
  regexPlacement?: number | number[];
  regexParams?: RegexParams;
  beforeRegexHooks?: Array<(content: string, ctx: FormatMessageContext) => string>;
  afterRegexHooks?: Array<(content: string, ctx: FormatMessageContext) => string>;
  afterMarkdownHooks?: Array<(content: string, ctx: FormatMessageContext) => string>;
  /** Skip DOMPurify sanitization and CSS scoping — use when the output will be
   *  rendered inside an iframe sandbox (e.g. CharacterCardRenderer) that has
   *  its own sanitization. */
  skipSanitize?: boolean;
  /** Keep <script> tags in the sanitized output. Only safe when the content is
   *  destined for a sandboxed iframe (smart-card / status-bar renderer) where
   *  scripts run inside the frame, never in the parent document. Other XSS
   *  protections (iframe/object/embed/base/form, event-handler attrs) remain
   *  active. Use together with a smart-card kind so the output goes to the
   *  iframe renderer. */
  preserveScripts?: boolean;
}

export function formatMessage(
  rawText: string,
  context: FormatMessageContext = {},
  options: FormatMessageOptions & { messageId?: number } = {},
): string {
  if (!rawText) return '';

  const {
    characterName = '',
    isSystem = false,
    isUser = false,
    messageId = -1,
    isReasoning = false,
    userName = '',
    modelName = '',
    dynamicMacros,
    postProcessFn,
    sanitizerOverrides = {},
    encodeTagsEnabled = false,
    allowName2Display = false,
    autoFixMarkdown = true,
  } = context;

  // 0. Extract reasoning/thinking tags so they are not rendered inline.
  //    Palink stores reasoning embedded in content as <think>...</think>; ST
  //    stores it in message.extra.reasoning and renders it in a separate
  //    foldable details block. We extract here to match ST's visual behavior.
  let extractedReasoningHtml = '';
  if (!isReasoning && !isSystem) {
    const { content: contentWithoutReasoning, reasoning } = extractReasoningTags(rawText);
    if (reasoning.length > 0) {
      rawText = contentWithoutReasoning;
      const reasoningText = reasoning.join('\n\n');
      extractedReasoningHtml = formatMessage(
        reasoningText,
        { ...context, isReasoning: true },
        options
      );
    }
  }

  let mes = rawText;

  // 0.5. 切除 prompt bias（防止泄漏到用户可见区）
  mes = stripPromptBias(mes);

  // 1. Prompt-bias stripping (message 0 only) — simplified; Palink handles bias differently
  // ST does substituteParams on message 0 here; we skip since Palink does it upstream

  // 2. Comment / hidden-message normalisation
  if (isSystem) {
    // Let hidden messages have markdown in ST; we keep as-is for Palink
  }

  // 3. beforeRegex extension hooks
  if (!isSystem && options.beforeRegexHooks) {
    for (const hook of options.beforeRegexHooks) {
      try {
        const result = hook(mes, context);
        if (typeof result === 'string') mes = result;
      } catch (e) {
        console.error('[formatMessage] beforeRegex hook error:', e);
      }
    }
  }

  // 4. Custom regex rules
  if (!isSystem && options.runRegex && options.regexParams) {
    mes = getRegexedString(mes, options.regexPlacement ?? 0, options.regexParams as any);
  }

  // 5. afterRegex extension hooks
  if (!isSystem && options.afterRegexHooks) {
    for (const hook of options.afterRegexHooks) {
      try {
        const result = hook(mes, context);
        if (typeof result === 'string') mes = result;
      } catch (e) {
        console.error('[formatMessage] afterRegex hook error:', e);
      }
    }
  }

  // 5.5. Macros / parameters substitution ({{char}}, {{user}}, {{time}}, {{random}}, etc.)
  if (!isSystem) {
    mes = substituteParamsExtended(mes, {
      userName,
      characterName,
      charName: characterName,
      modelName,
      dynamicMacros,
      postProcessFn,
    });
  }

  // 首条消息特殊处理：ST 对 messageId===0 做额外宏替换
  if (options.messageId === 0) {
    mes = substituteParams(mes, {
      userName: context.userName,
      characterName: context.characterName,
    });
  }

  // 6. Markdown auto-fix (skip for iframe sandbox content and HTML fragments)
  if (autoFixMarkdown && !options.skipSanitize) {
    mes = fixMarkdown(mes, true);
  }

  // 7. HTML tag encoding
  if (!isSystem && encodeTagsEnabled) {
    mes = encodeTags(mes);
  }

  // 8. Showdown Markdown → HTML conversion (ST-aligned: let Showdown handle HTML natively)
  if (!isSystem && !options.skipSanitize) {
    // P1-a: extract regex-generated HTML blocks (e.g. <details>/<div> status panels,
    // <style> tags) into placeholders BEFORE markdown preprocessing. This protects
    // inline HTML — especially style="..." attributes whose ASCII double quotes would
    // otherwise be mangled by wrapSillyTavernQuotedText — and prevents Showdown's HTML
    // mode from breaking the generated markup. Blocks are restored verbatim after Showdown.
    const htmlBlocks = extractHtmlBlocks(mes);
    mes = preprocessMarkdownForShowdown(htmlBlocks.text, encodeTagsEnabled);

    const converter = getShowdownConverter();
    mes = converter.makeHtml(mes);

    // Firefox newline fix in code blocks
    mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => {
      return match.replace(/\n/gm, '\u0000');
    });
    mes = mes.replace(/\u0000/g, '\n');
    mes = mes.trim();

    // Restore & in code blocks
    mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => {
      return match.replace(/&amp;/g, '&');
    });

    // Restore the HTML blocks extracted before Showdown (verbatim, so generated
    // markup and its attributes survive intact for the final DOMPurify + CSS scoping).
    mes = restoreHtmlBlocks(mes, htmlBlocks.blocks);

    // F-1 修复（2026-08-23）: 完成态 LaTeX 渲染——在 DOMPurify 之前把
    // $$..$$ / $..$ / \(..\) / \[..\] 片段预渲染为 KaTeX HTML，消除
    // "流式可渲染、完成态塌回原文"的引擎切换突变（与流式 remark-math +
    // rehype-katex 对齐；katex.min.css 全局加载）。
    mes = renderMathInHtml(mes);

    // 9. afterMarkdown extension hooks
    if (options.afterMarkdownHooks) {
      for (const hook of options.afterMarkdownHooks) {
        try {
          const result = hook(mes, context);
          if (typeof result === 'string') mes = result;
        } catch (e) {
          console.error('[formatMessage] afterMarkdown hook error:', e);
        }
      }
    }
  }

  // 10. Name-prefix stripping
  if (!allowName2Display && characterName && !isUser && !isSystem) {
    mes = mes.replace(new RegExp(`(^|\n)${escapeRegex(characterName)}:`, 'g'), '$1');
  }

  // 11. Re-insert extracted reasoning as a ST-compatible foldable block
  //     (must happen before skipSanitize early return to ensure thinking box always shows,
  //      even when content is rendered as smart card HTML with skipSanitize=true)
  if (extractedReasoningHtml) {
    mes = renderReasoningDetails(extractedReasoningHtml) + mes;
  }

  // 12. DOMPurify sanitization (skip for content that will be rendered in iframe sandbox)
  if (options.skipSanitize) {
    return mes;
  }
  // 状态栏 / smart-card：内容已是一份完整 HTML 文档，且调用方明确声明脚本需保留
  // （preserveScripts）——这意味着它必然被路由到 CharacterCardRenderer 的沙箱 iframe。
  // DOMPurify 默认 WHOLE_DOCUMENT:false，会剥掉 <!DOCTYPE>/<html>/<head>/<body>，
  // 使进入 iframe 的文档结构残缺（面板黑屏，hasDoctype/hasBody/hasScript 全为 false）。
  // 故此处整体跳过父文档消毒，安全性由 iframe 沙箱保证。
  // 注意：两个条件缺一不可，普通 Markdown 消息不会命中，XSS 面不扩大。
  // 额外兜底：正则产物自身已是完整 HTML 文档且含脚本/事件属性时，即使调用方未
  // 显式声明 preserveScripts（如"开局"正则把占位符替换成完整文档，而
  // preserveScripts 在正则执行前基于占位符文本计算，无法预知产物形态），也整体
  // 跳过父文档消毒。这类内容必然被 kind='smart-card' 判定捕获并路由到
  // CharacterCardRenderer 的沙箱 iframe（sandbox="allow-scripts"、opaque origin），
  // 脚本仅在 frame 内执行，不落入父文档执行面；普通消息（非完整文档）不受影响。
  const isFullDocumentOutput = containsFullHtmlDocument(mes);
  if (isFullDocumentOutput && (options.preserveScripts || /<script[\s>]|\son[a-z]+\s*=/i.test(mes))) {
    return mes;
  }
  const config = buildMessageSanitizeConfig(sanitizerOverrides);
  // 保留 <script>：仅当内容最终会进入沙箱 iframe（smart-card / 状态栏渲染器）时。
  // 此时脚本在 frame 内执行，不在父文档执行，其余 XSS 防护（iframe/object/embed 等、
  // 事件处理属性）仍然生效。若内容只是普通 Markdown 消息则不会进入此分支。
  if (options.preserveScripts) {
    if (Array.isArray(config.FORBID_TAGS)) {
      (config as Record<string, unknown>).FORBID_TAGS = config.FORBID_TAGS.filter(
        (tag: unknown) => tag !== 'script'
      );
    }
    // 仅从 FORBID_TAGS 移除 script 还不够：DOMPurify 默认 ALLOWED_TAGS 不含 script，
    // 不在白名单且不在黑名单的标签会被整体丢弃（含其内容）。必须把 script 显式加回
    // ALLOWED 列表，<script> 及其内容（状态栏/智能卡脚本）才能保留到输出，进入沙箱 iframe 执行。
    // 用新数组避免污染共享的 ST_DOMPURIFY_CONFIG.ADD_TAGS。
    const currentAdd = Array.isArray(config.ADD_TAGS) ? (config.ADD_TAGS as unknown[]) : [];
    if (!currentAdd.includes('script')) {
      (config as Record<string, unknown>).ADD_TAGS = [...currentAdd, 'script'];
    }
  }
  mes = encodeStyleTags(mes);
  mes = String(DOMPurify.sanitize(mes, config as any));
  mes = decodeStyleTags(mes, { prefix: '.mes_text ' });

  return mes;
}

export interface MessageFormattingOptions {
  collapseNewlines?: boolean;
  fixMarkdown?: boolean;
  stripHtml?: boolean;
  allowedHtmlTags?: string[];
  protectBlocks?: boolean;
}

export function messageFormatting(
  text: string,
  options: MessageFormattingOptions = {}
): string {
  let workingText = text;
  let codeBlocks: string[] = [];
  let mathBlocks: string[] = [];

  if (options.protectBlocks !== false) {
    const codeResult = protectCodeBlocks(workingText);
    workingText = codeResult.text;
    codeBlocks = codeResult.blocks;

    const mathResult = protectMathBlocks(workingText);
    workingText = mathResult.text;
    mathBlocks = mathResult.blocks;
  }

  if (options.collapseNewlines !== false) {
    workingText = collapseNewlines(workingText);
  }

  if (options.fixMarkdown !== false) {
    workingText = fixMarkdown(workingText);
  }

  if (options.stripHtml) {
    workingText = stripHtmlTags(workingText, options.allowedHtmlTags);
  }

  if (options.protectBlocks !== false) {
    workingText = restoreProtectedBlocks(workingText, mathBlocks, '\x00MATH\x00');
    workingText = restoreProtectedBlocks(workingText, codeBlocks, '\x00CODE\x00');
  }

  return workingText;
}
