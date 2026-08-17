import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Copy, Check, Zap, Database, RefreshCw, Trash2, Globe, ExternalLink, ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn, parseThinkingContent } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CodeBlock } from './CodeBlock';
import { ThinkingProcess } from './ThinkingProcess';
import { SmoothOutput } from './SmoothOutput';
import { ImageThumbnails, FullscreenImageViewer, extractImagesFromContent } from './ImageViewer';
import { WebSearchResults } from './WebSearchResults';
import type { Message as MessageType, Model } from '@/types';
import DOMPurify from 'dompurify';
import { CharacterCardRenderer, InlineHtmlRenderer, type SmartCardAction, looksLikeSmartCardHtml } from './CharacterCardRenderer';
import { InlineCardRenderer, type InlineCardRendererProps } from './InlineCardRenderer';
import { shouldUseInlineCardRendering } from './smart-card-runtime/inline/inline-flags';
import { StatusBarPanel, type CharacterStatusBar } from './StatusBarPanel';
import TavernHelperPanel from './TavernHelperPanel';
import { extractCharacterStatusBars } from '@/lib/statusBar';
import { messageFormatter, applySillyTavernDisplayPipeline } from '@/utils/sillyTavernDisplayPipeline';
import { getGlobalSillyTavernRuntime } from '@/lib/sillytavern/runtime';
import { stripHtmlFenceLeftovers } from './smart-card-runtime/primitives';
import {
  attachContrastEnhancer,
  isContrastEnhancementEnabled,
  type ContrastEnhancerHandle,
} from './smart-card-runtime/contrast-enhancer';
import { SMART_CARD_UI_TEXT } from './smart-card-runtime/shared';
import { getCurrentInterfaceLanguage, htmlNeedsIframe } from './smart-card-runtime/helpers';

type RegexScript = any;

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

function MarkdownImg({ onClick, ...props }: any) {
  return (
    <img
      {...props}
      className="max-w-full h-auto max-h-64 object-contain rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
      loading="lazy"
      decoding="async"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        if (props.src && onClick) onClick(props.src);
      }}
    />
  );
}

const IMAGE_HOSTING_DOMAINS = [
  'imageshack.us', 'imageshack.com',
  'i.imgur.com', 'imgur.com',
  'postimg.cc', 'i.postimg.cc',
  'image.ibb.co', 'ibb.co',
  'i.redd.it', 'preview.redd.it',
  'cdn.discordapp.com', 'media.discordapp.net',
  'pbs.twimg.com',
  'i.pinimg.com',
];

const IMAGE_EXT_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)(?:\?[^\s]*)?(?=[\s)\]}>]|$)/i;

function isImageUrl(url: string): boolean {
  if (IMAGE_EXT_PATTERN.test(url)) return true;
  try {
    const u = new URL(url);
    if (IMAGE_HOSTING_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) return true;
  } catch {}
  return false;
}

function preprocessImageUrls(text: string): string {
  const lines = text.split('\n');
  const processed = lines.map(line => {
    const existingImageRefs: string[] = [];
    const imgRefPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = imgRefPattern.exec(line)) !== null) {
      existingImageRefs.push(m[1]);
    }
    const urlPattern = /(?<![(\[])(https?:\/\/[^\s<>"')\]]+)/g;
    return line.replace(urlPattern, (url) => {
      if (existingImageRefs.includes(url)) return url;
      if (isImageUrl(url)) {
        return `![image](${url})`;
      }
      return url;
    });
  });
  return processed.join('\n');
}

interface MessageProps {
  message: MessageType;
  userAvatar?: string;
  userName?: string;
  models?: Model[];
  streaming?: boolean;
  isLast?: boolean;
  t: Record<string, string>;
  tokens?: number;
  memoryStats?: {
    message_count: number;
    token_count: number;
    compression_needed: boolean;
  } | null;
  onCompress?: () => void;
  compressing?: boolean;
  onRegenerate?: (messageId?: string | number) => void;
  canRegenerate?: boolean;
  showModelReasoning?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id?: string) => void;
  onDelete?: () => void;
  showSelect?: boolean;
  isDeleteMode?: boolean;
  messageIndex?: number;
  selectedItems?: Set<string>;
  onSetMultipleItemsSelect?: (itemIds: string[], select: boolean) => void;
  onEdit?: (newContent: string, messageId?: string | number) => void;
  canEdit?: boolean;
  isMixedDeleteMode?: boolean;
  selectedWholeMessages?: Set<number>;
  selectedMessageParts?: Map<number, Set<string>>;
  onToggleWholeMessageSelect?: (messageIndex: number) => void;
  onToggleMessagePartSelect?: (messageIndex: number, partId: string) => void;
  onSelectAllPartsInMessage?: (messageIndex: number) => void;
  isCharacterChat?: boolean;
  characterAvatar?: string;
  characterName?: string;
  characterId?: string | number;
  characterFirstMes?: string;
  characterAlternateGreetings?: string[];
  sessionId?: string | number;
  sessionVariables?: { stat_data?: Record<string, unknown> } & Record<string, unknown>;
  characterExtensions?: Record<string, unknown> | null;
  characterPresetData?: Record<string, unknown> | null;
  memoryMode?: string;
  summary?: string;
  characterDisplayMode?: string;
  chatStyle?: 'flat' | 'bubbles' | 'document';
  useNativeStRendering?: boolean;
  onGenerateImage?: (messageId: string | number) => void;
  isGeneratingImage?: boolean;
  globalRegexScripts?: RegexScript[];
  totalMessages?: number;
  chatMessages?: Array<Record<string, unknown>>;
  onSmartCardAction?: (action: SmartCardAction) => void;
}

type ContentSegment = {
  type: 'character_thinking' | 'dialogue' | 'normal';
  text: string;
  openDelimiter?: string;
  closeDelimiter?: string;
};

/**
 * Decides whether a character message must render via the native HTML branch
 * (dangerouslySetInnerHTML) instead of the Palink segment (framed / frameless)
 * branch.
 *
 * Only *structural* / widget HTML is treated as native HTML — the kind
 * SillyTavern's formatMessage emits for real cards / panels / widgets, and
 * that markdown conversion never produces for plain prose. This deliberately
 * excludes `<p>` / `<q>` (SillyTavern's wrappers around normal dialogue) and
 * ordinary markdown tags (`<ul>`/`<ol>`/`<li>`/`<blockquote>`/`<code>`/
 * `<em>`/`<strong>`/`<a>`/`<br>`/`<img>`/headings), so a finished chat line
 * still takes the segment branch and keeps its boxes / colours.
 */
function isHtmlCardContent(content: string): boolean {
  const text = String(content || '').trim();
  if (!text) return false;
  if (looksLikeSmartCardHtml(text)) return true;
  return /<(?:div|span|section|article|main|aside|nav|header|footer|table|thead|tbody|tr|td|th|button|input|select|textarea|label|form|svg|canvas|details|summary|progress|meter|iframe)\b/i.test(text);
}

/**
 * ST 兼容内联 HTML 清洗：对齐原版 SillyTavern 的 formatMessage 行为——
 * 模型输出的原始 HTML（含 <style> / <div class="custom-nk-msg"> 等）直接内联渲染进 .mes_text，
 * 剥离 <script>/<iframe> 等危险标签，保留 <style>/<div>/<span>/<p>/<img> 等结构标签，
 * 且不重新 scope CSS（作者已用 .mes_text .xxx 选择器自我约束），使 Galgame 等 ST 插件
 * 能从 .mes_text 读取原始 HTML 并渲染 overlay。
 */
// 找到匹配的闭合大括号（正确处理引号/转义/嵌套），用于逐条解析 CSS 规则。
// 仅作为 CSSOM 解析失败时的降级兜底（CSSOM 解析对畸形 CSS 容错性更好）。
function findMatchingBraceCompat(css: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = openIndex; i < css.length; i += 1) {
    const char = css[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// 判定选择器片段是否"全局泄漏"：命中 html/body 元素，或 ::-webkit-scrollbar /
// ::selection 等作用于整个文档的伪元素。这些规则一旦进入主文档即全局生效，
// 会污染主页面布局（如角色卡写的 body{display:flex;justify-content:center} 在
// 移动端把 #root 宽度压成 0 → 白屏）或全局 UI（滚动条/选区样式）。
function isGlobalLeakSelector(segment: string): boolean {
  const seg = segment.trim();
  return /^(?:html|body)\b/i.test(seg) || /^::(?:-webkit-[\w-]+|selection|scrollbar)/i.test(seg);
}

// 逐条过滤 CSS 规则：丢弃全局泄漏规则（含选择器列表中出现 html/body/::-webkit-scrollbar 的，
// 如 "body, .foo"），:root 仅保留 CSS 变量声明，其余规则原样保留；递归处理 @media/@supports
// 分组规则；丢弃 @import。用浏览器原生 CSSOM 解析，对残缺/畸形 CSS（如未闭合引号、残缺的
// data URI 字符串）容错优于手工括号匹配：畸形声明被浏览器丢弃、正常规则照常保留，不会出现
// "解析失败后整段原样注入"的漏网（实测某卡 body 规则含悬空单引号导致手工匹配器误判未闭合）。
function sanitizeCssRuleList(rules: CSSRuleList): string {
  const parts: string[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (rule.type === CSSRule.STYLE_RULE) {
      const cssRule = rule as CSSStyleRule;
      const selector = cssRule.selectorText.trim();
      const hasGlobalLeak = selector.split(',').some(seg => isGlobalLeakSelector(seg));
      if (hasGlobalLeak) continue;
      if (/^:root\b/i.test(selector)) {
        // :root 仅保留 CSS 变量（--xxx: value），丢弃其余属性
        const vars = String(cssRule.style.cssText || '')
          .split(';')
          .map(s => s.trim())
          .filter(s => /^--[\w-]+\s*:/.test(s));
        if (vars.length > 0) parts.push(`:root{${vars.join(';')};}`);
        continue;
      }
      parts.push(cssRule.cssText);
    } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
      const group = rule as CSSMediaRule | CSSSupportsRule;
      const inner = sanitizeCssRuleList(group.cssRules);
      if (inner) {
        const header = rule.type === CSSRule.MEDIA_RULE
          ? `@media ${group.conditionText}`
          : `@supports ${group.conditionText}`;
        parts.push(`${header}{${inner}}`);
      }
    } else if (rule.type === CSSRule.IMPORT_RULE) {
      // 丢弃 @import，避免拉取外部资源
    } else {
      // @keyframes / @font-face 等：原样保留
      parts.push(rule.cssText);
    }
  }
  return parts.join('\n');
}

// 清洗 ST 兼容内联 HTML 的 <style> 内容（sanitizeStCompatHtml 与 style 移出 body 两处共用）。
// 优先用浏览器原生 CSSOM 解析，失败时降级到手工括号匹配。
// 注意：不能通过 document.createElement('style') + .sheet 解析——未挂载到文档的
// <style> 元素 .sheet 为 null（实测），而 CSSStyleSheet.replaceSync 无需挂载即可解析。
function sanitizeStCompatCss(css: string): string {
  if (!css) return '';
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sanitizeCssRuleList(sheet.cssRules);
  } catch {
    let result = '';
    let cursor = 0;
    while (cursor < css.length) {
      const openIndex = css.indexOf('{', cursor);
      if (openIndex === -1) { result += css.slice(cursor); break; }
      const selectorText = css.slice(cursor, openIndex).trim();
      const closeIndex = findMatchingBraceCompat(css, openIndex);
      if (closeIndex === -1) { result += css.slice(cursor); break; }
      const declarations = css.slice(openIndex + 1, closeIndex);
      if (isGlobalLeakSelector(selectorText)) {
        // 全局泄漏规则：丢弃，避免污染页面布局
      } else if (/^:root\b/i.test(selectorText)) {
        // :root 仅保留 CSS 变量（--xxx: value），丢弃其余属性
        const vars = declarations.split(';').map(s => s.trim()).filter(s => /^--[\w-]+\s*:/.test(s));
        if (vars.length > 0) result += `${selectorText}{${vars.join(';')};}`;
      } else {
        result += `${selectorText}{${declarations}}`;
      }
      cursor = closeIndex + 1;
    }
    return result;
  }
}

function sanitizeStCompatHtml(html: string): string {
  const cleaned = DOMPurify.sanitize(html, {
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style', 'class', 'id', 'data-*'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
  });
  // style 标签一旦进入主文档即全局生效：净化其内容，隔离 html/body 等全局布局规则
  return cleaned.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
    return `<style>${sanitizeStCompatCss(css)}</style>`;
  });
}

/**
 * 复刻 ST 卡片 MVU 行为：定位「状态栏」正则脚本——
 * 其特征为 replaceString 是完整 <html> 文档、findRegex 匹配 <StatusPlaceHolderImpl/> 占位符。
 * 在 ST 里，卡片的 MVU 脚本会在每条助手消息末尾自动追加该占位符，再由正则[4]替换为状态栏 HTML。
 * Palink 不执行卡片 JS，故此处补上占位符，交由既有显示管线原样渲染卡片自带面板。
 */
function findStatusPlaceholderRegexScript(extensions: any): any | null {
  const scripts = extensions?.regex_scripts;
  if (!Array.isArray(scripts)) return null;
  for (const s of scripts) {
    if (!s || s.disabled) continue;
    const rs = s.replaceString;
    const fr = s.findRegex;
    if (
      typeof rs === 'string' && rs.includes('<html') &&
      typeof fr === 'string' && /StatusPlaceHolderImpl/.test(fr)
    ) {
      return s;
    }
  }
  return null;
}

function parseContentSegments(displayContent: string, isStreaming: boolean = false): ContentSegment[] {
  const protectedBlocks: string[] = [];

  const openCodeBlockRegex = /```[^\n]*$/;
  let content = displayContent;
  if (isStreaming && openCodeBlockRegex.test(content)) {
    content = content.replace(openCodeBlockRegex, (match) => {
      protectedBlocks.push(match);
      return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
    });
  }

  const codeBlockRegex = /```[\s\S]*?```/g;
  content = content.replace(codeBlockRegex, (match) => {
    protectedBlocks.push(match);
    return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
  });

  const inlineCodeRegex = /`[^`\n]+`/g;
  content = content.replace(inlineCodeRegex, (match) => {
    protectedBlocks.push(match);
    return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
  });

  const displayMathRegex = /\$\$[\s\S]*?\$\$/g;
  content = content.replace(displayMathRegex, (match) => {
    protectedBlocks.push(match);
    return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
  });

  const openDisplayMathRegex = /\$\$[\s\S]*$/;
  if (isStreaming && openDisplayMathRegex.test(content)) {
    content = content.replace(openDisplayMathRegex, (match) => {
      protectedBlocks.push(match);
      return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
    });
  }

  const inlineMathRegex = /\$[^$\n]+?\$/g;
  content = content.replace(inlineMathRegex, (match) => {
    protectedBlocks.push(match);
    return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
  });

  // 保护 Markdown 表格 - 匹配包含 | 的多行格式
  const tableRegex = /(?:\|[^\n]*\|[^\n]*\n\|[-\s|]*\n(?:\|[^\n]*\n?)+)/g;
  content = content.replace(tableRegex, (match) => {
    protectedBlocks.push(match);
    return `\x00PBLOCK${protectedBlocks.length - 1}\x00`;
  });

  const segments: ContentSegment[] = [];
  // 支持半角引号 "..."、中文双引号 "..."、半角括号 (...)、全角括号 （...）
  const segmentRegex = /"([^"]*)"|\u201C([^\u201D]*)\u201D|\(([^)]*)\)|\uFF08([^\uFF09]*)\uFF09/g;
  let cursor = 0;
  let match;

  while ((match = segmentRegex.exec(content)) !== null) {
    if (match.index > cursor) {
      const normalText = content.slice(cursor, match.index).trim();
      if (normalText) {
        segments.push({ type: 'normal', text: normalText });
      }
    }

    const isCompleteDialogue = (match[1] !== undefined && match[0].endsWith('"')) ||
                               (match[2] !== undefined && match[0].endsWith('\u201D'));
    const isCompleteThinking = (match[3] !== undefined && match[0].endsWith(')')) ||
                               (match[4] !== undefined && match[0].endsWith('\uFF09'));

    if (isCompleteDialogue) {
      const isFullWidth = match[2] !== undefined;
      segments.push({
        type: 'dialogue',
        text: isFullWidth ? match[2] : match[1],
        openDelimiter: isFullWidth ? '\u201C' : '"',
        closeDelimiter: isFullWidth ? '\u201D' : '"',
      });
    } else if (isCompleteThinking) {
      const isFullWidth = match[4] !== undefined;
      segments.push({
        type: 'character_thinking',
        text: isFullWidth ? match[4] : match[3],
        openDelimiter: isFullWidth ? '\uFF08' : '(',
        closeDelimiter: isFullWidth ? '\uFF09' : ')',
      });
    } else {
      segments.push({ type: 'normal', text: match[0] });
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < content.length) {
    const remaining = content.slice(cursor);
    const trimmed = remaining.trimStart();
    const leadingSpaces = remaining.length - trimmed.length;

    if (isStreaming) {
      // 检测未闭合的引号/括号（支持半角和全角）
      const halfQuoteIdx = trimmed.lastIndexOf('"');
      const fullQuoteIdx = trimmed.lastIndexOf('\u201C');
      const halfParenIdx = trimmed.lastIndexOf('(');
      const fullParenIdx = trimmed.lastIndexOf('\uFF08');

      const bestQuoteIdx = Math.max(halfQuoteIdx, fullQuoteIdx);
      const bestParenIdx = Math.max(halfParenIdx, fullParenIdx);
      const isQuoteFullWidth = fullQuoteIdx > halfQuoteIdx;
      const isParenFullWidth = fullParenIdx > halfParenIdx;

      if (bestQuoteIdx > bestParenIdx && bestQuoteIdx >= 0) {
        const beforeOpen = trimmed.slice(0, bestQuoteIdx).trim();
        if (beforeOpen) {
          segments.push({ type: 'normal', text: beforeOpen });
        }
        const quotedContent = trimmed.slice(bestQuoteIdx + 1);
        if (quotedContent) {
          segments.push({
            type: 'dialogue',
            text: quotedContent,
            openDelimiter: isQuoteFullWidth ? '\u201C' : '"',
            closeDelimiter: isQuoteFullWidth ? '\u201D' : '"',
          });
        }
      } else if (bestParenIdx > bestQuoteIdx && bestParenIdx >= 0) {
        const beforeOpen = trimmed.slice(0, bestParenIdx).trim();
        if (beforeOpen) {
          segments.push({ type: 'normal', text: beforeOpen });
        }
        const parenContent = trimmed.slice(bestParenIdx + 1);
        if (parenContent) {
          segments.push({
            type: 'character_thinking',
            text: parenContent,
            openDelimiter: isParenFullWidth ? '\uFF08' : '(',
            closeDelimiter: isParenFullWidth ? '\uFF09' : ')',
          });
        }
      } else if (trimmed) {
        segments.push({ type: 'normal', text: trimmed });
      }
    } else {
      if (trimmed) {
        segments.push({ type: 'normal', text: trimmed });
      }
    }
  }

  if (segments.length === 0 && content.trim()) {
    segments.push({ type: 'normal', text: content.trim() });
  }

  for (const seg of segments) {
    seg.text = seg.text.replace(/\x00PBLOCK(\d+)\x00/g, (_, idx) => protectedBlocks[parseInt(idx)]);
  }

  return segments;
}

function SegmentBox({ segment, markdownComponents }: {
  segment: ContentSegment;
  markdownComponents: Record<string, React.ComponentType<any>>;
}) {
  if (segment.type === 'character_thinking') {
    return (
      <div className="my-1 px-3 py-2 rounded-lg bg-purple-50/80 dark:bg-purple-950/30 border-l-2 border-purple-400 dark:border-purple-600 rp-segment-thinking">
        <div className="text-[15px] text-purple-700 dark:text-purple-300 italic leading-relaxed">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {`${segment.openDelimiter || '('}${segment.text}${segment.closeDelimiter || ')'}`}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  if (segment.type === 'dialogue') {
    return (
      <div className="my-1 px-3 py-2 rounded-lg bg-blue-50/80 dark:bg-blue-950/30 border-l-2 border-blue-400 dark:border-blue-600 rp-segment-dialogue">
        <div className="text-[15px] text-blue-600 dark:text-blue-400 font-semibold leading-relaxed">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {`${segment.openDelimiter || '"'}${segment.text}${segment.closeDelimiter || '"'}`}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <div className="my-1 px-3 py-2 rounded-lg">
      <div className="markdown-content mes_text w-full break-words overflow-wrap-anywhere text-[15px] text-[var(--rp-color-main-text)] leading-relaxed rp-segment-normal">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={markdownComponents}
        >
          {preprocessImageUrls(segment.text)}
        </ReactMarkdown>
      </div>
    </div>
  );
};

function FramelessContent({ segments, streaming, markdownComponents }: {
  segments: ContentSegment[];
  streaming?: boolean;
  markdownComponents: Record<string, React.ComponentType<any>>;
}) {
  return (
    <div className="w-full break-words overflow-wrap-anywhere space-y-0.5 rp-frameless-content">
      {segments.map((seg, i) => {
        if (seg.type === 'dialogue') {
          return (
            <div key={i} className="text-[15px] leading-relaxed rp-segment-dialogue">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
                unwrapDisallowed
                allowedElements={['p', 'span', 'em', 'strong', 'code', 'math', 'inlineMath']}
              >
                {`${seg.openDelimiter || '"'}${seg.text}${seg.closeDelimiter || '"'}`}
              </ReactMarkdown>
            </div>
          );
        }
        if (seg.type === 'character_thinking') {
          return (
            <div key={i} className="text-[15px] italic leading-relaxed rp-segment-thinking">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
                unwrapDisallowed
                allowedElements={['p', 'span', 'em', 'strong', 'code', 'math', 'inlineMath']}
              >
                {`${seg.openDelimiter || '('}${seg.text}${seg.closeDelimiter || ')'}`}
              </ReactMarkdown>
            </div>
          );
        }
        return (
          <span
            key={i}
            className="text-[15px] text-[var(--rp-color-main-text)] leading-relaxed rp-segment-normal"
          >
            {seg.text}
          </span>
        );
      })}
      {streaming && (
        <span className="inline-block w-1.5 h-5 bg-primary/70 animate-pulse ml-0.5 align-text-bottom" />
      )}
    </div>
  );
};

function MessageInner({
  message,
  userAvatar: _userAvatar,
  userName: _userName,
  models = [],
  streaming = false,
  isLast = false,
  t: _t,
  tokens,
  memoryStats,
  onCompress,
  compressing,
  onRegenerate,
  canRegenerate = false,
  showModelReasoning = false,
  isSelected = false,
  onToggleSelect,
  onDelete,
  showSelect = false,
  isDeleteMode = false,
  messageIndex,
  selectedItems,
  onSetMultipleItemsSelect,
  onEdit: _onEdit,
  canEdit: _canEdit = false,
  isMixedDeleteMode = false,
  selectedWholeMessages,
  onToggleWholeMessageSelect,
  onSelectAllPartsInMessage: _onSelectAllPartsInMessage,
  isCharacterChat = false,
  characterAvatar,
  characterName,
  characterId: _characterId,
  characterFirstMes: _characterFirstMes,
  characterAlternateGreetings: _characterAlternateGreetings,
  sessionId: _sessionId,
  sessionVariables: _sessionVariables,
  characterExtensions: _characterExtensions,
  characterPresetData: _characterPresetData,
  memoryMode,
  summary,
  characterDisplayMode = 'framed',
  chatStyle = 'flat',
  useNativeStRendering = false,
  onGenerateImage: _onGenerateImage,
  isGeneratingImage: _isGeneratingImage,
  globalRegexScripts: _globalRegexScripts,
  totalMessages: _totalMessages,
  chatMessages: _chatMessages,
  onSmartCardAction,
}: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);
  const [webSearchExpanded, setWebSearchExpanded] = useState(false);
  const isUser = message.role === 'user';
  const isFrameless = isCharacterChat && characterDisplayMode === 'frameless';

  // 亮色模式对比度增强：作用于本消息内容容器（覆盖 .nk-msg 内联 HTML /
  // InlineHtmlRenderer / ReactMarkdown / 智能卡内联渲染等所有主文档内联路径）。
  const interfaceLanguage = getCurrentInterfaceLanguage();
  const smartCardText = SMART_CARD_UI_TEXT[interfaceLanguage];
  const [contrastAdjustedCount, setContrastAdjustedCount] = useState(0);
  const [contrastBadgeDismissed, setContrastBadgeDismissed] = useState(false);
  const contentContainerRef = useRef<HTMLDivElement | null>(null);
  const contrastEnhancerRef = useRef<ContrastEnhancerHandle | null>(null);

  // 设置页开关切换 → 立即重判（注入/清除）
  useEffect(() => {
    const handleContrastToggle = () => {
      contrastEnhancerRef.current?.run();
      setContrastBadgeDismissed(false);
    };
    window.addEventListener('palink-auto-contrast-changed', handleContrastToggle);
    return () => window.removeEventListener('palink-auto-contrast-changed', handleContrastToggle);
  }, []);

  // 角色扮演角色卡头像展示开关（localStorage 持久化，设置页实时切换；默认开启）
  const [showCharacterAvatar, setShowCharacterAvatar] = useState<boolean>(() => {
    try {
      return localStorage.getItem('palink-rp-character-avatar') !== '0';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const handleAvatarToggle = () => {
      try {
        setShowCharacterAvatar(localStorage.getItem('palink-rp-character-avatar') !== '0');
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('palink-rp-character-avatar-changed', handleAvatarToggle);
    return () => window.removeEventListener('palink-rp-character-avatar-changed', handleAvatarToggle);
  }, []);

  const messageModel = models.find(m => m.id === message.model);

  // 角色卡是否带「状态栏」正则脚本（regex[4]：findRegex 匹配 <StatusPlaceHolderImpl/>、replaceString 为完整 <html> 文档）。
  // 用途：① 在助手消息末尾注入占位符；② 强制该 smart-card 走内联渲染（presentationMode:'inline'），
  // 对齐 ST——状态栏内联在聊天气泡里、始终可见、随每次 AI 输出刷新，而非折叠成黑按钮/全屏面板。
  const hasStatusBarScript = useMemo(
    () => !!findStatusPlaceholderRegexScript(_characterExtensions),
    [_characterExtensions],
  );

  // 酒馆助手（Tavern Helper）兼容面板：仅当卡片「没有」界面状态栏正则脚本时用作兜底渲染。
  // 完全对齐 ST——ST 中状态栏只有「<StatusPlaceHolderImpl/> 占位符 + 界面正则」一条管线，
  // 有正则走正则（原生 smart-card），无正则则无原生状态栏；此处用 stat_data+schema 生成通用面板补位。
  const tavernHelper = useMemo(
    () => (_characterExtensions as any)?.tavern_helper ?? null,
    [_characterExtensions],
  );
  const statData = useMemo(
    () =>
      (message.extra?.variables as any)?.stat_data ??
      (_sessionVariables as any)?.stat_data ??
      null,
    [message.extra, _sessionVariables],
  );

  const { thinkingContent, displayContent, userTextContent, userImages, statusBars } = useMemo(() => {
    const content = message.content || '';
    const { thinkingContent: parsedThinking, mainContent: rawMainContent } = parseThinkingContent(content);
    // 前端双保险：移除 palink-status 标记（后端已剥离，此处防御遗漏）
    let mainContent = rawMainContent.replace(/<palink-status>[\s\S]*?<\/palink-status>/gi, '');
    // 角色助手消息：剥离 <UpdateVariable> 指令块（stat_data 更新指令，非对话内容；
    // 后端已剥离，此处兜底旧消息/流式中间态），并清理剥离后残留的 markdown 代码
    // 围栏（模型常把该块包在 ```html … ``` 内输出，剥离块后围栏行会残留成正文泄漏）。
    // 剥离两步对齐后端 strip_update_variable_blocks：整行块连同块后换行一并移除，
    // 内联块仅移除块本身，避免在正文中留下孤立空行。
    if (isCharacterChat && !isUser) {
      mainContent = stripHtmlFenceLeftovers(
        mainContent
          .replace(/^[ \t]*<UpdateVariable>[\s\S]*?<\/UpdateVariable>[ \t]*$\n?/gim, '')
          .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
          .replace(/\n{3,}/g, '\n\n'),
      );
    }
    mainContent = mainContent.trim();
    const { textContent, images } = extractImagesFromContent(mainContent);

    // 角色扮演助手消息：提取 NSFW 状态栏块，从正文剥离原始标签
    const extracted = isCharacterChat && !isUser ? extractCharacterStatusBars(mainContent) : { bars: [] as CharacterStatusBar[], clean: mainContent };
    const cleanContent = extracted.clean;

    // 角色扮演模式下，只有当 showModelReasoning 为 false 时才丢弃推理内容
    if (isCharacterChat && !isUser && parsedThinking && !showModelReasoning) {
      return {
        thinkingContent: null,
        displayContent: cleanContent,
        userTextContent: textContent,
        userImages: images,
        statusBars: extracted.bars,
      };
    }

    return {
      thinkingContent: parsedThinking,
      displayContent: cleanContent,
      userTextContent: textContent,
      userImages: images,
      statusBars: extracted.bars,
    };
  }, [message.content, isCharacterChat, isUser, showModelReasoning]);

  const hasDisplayContent = !isUser && !!displayContent;

  const [formatterRevision, setFormatterRevision] = useState(() => messageFormatter.getRevision());
  useEffect(() => {
    return messageFormatter.subscribe(() => setFormatterRevision(messageFormatter.getRevision()));
  }, []);

  const pipelineResult = useMemo(() => {
    if (!isCharacterChat || isUser) return null;
    if (!displayContent) return null;

    if (useNativeStRendering) {
      const runtime = getGlobalSillyTavernRuntime();
      if (runtime) {
        const html = runtime.messageFormatting(
          displayContent,
          characterName || '',
          false,
          false,
          typeof messageIndex === 'number' ? messageIndex : undefined
        );
        return { kind: 'html-display' as const, content: html, markdownContent: html };
      }
    }

    // 复刻 ST 卡片 MVU 行为：若角色卡含「状态栏」正则脚本，在助手消息末尾补上
    // <StatusPlaceHolderImpl/> 占位符（ST 里由卡片 MVU 脚本自动追加），让既有显示管线
    // 通过正则[4]把占位符替换为状态栏 HTML，再走 smart-card → CharacterCardRenderer + MVU 运行时
    // 原样渲染卡片自带面板。已含占位符/已渲染 HTML 时跳过，避免重复注入。
    // 例外：开场白（会话第一条 AI 消息，messageIndex === 0）不注入——ST 中状态栏由 MVU
    // 脚本在 AI 回复后追加，开场白本身（first_mes）不含状态栏；若给开场白注入占位符，
    // 会被「[界面]状态栏」正则替换成整块世界界面面板，凭空出现在第一段对话里（实测）。
    const isGreetingMessage = !isUser && typeof messageIndex === 'number' && messageIndex === 0;
    let pipelineContent = displayContent;
    if (
      hasStatusBarScript &&
      !isGreetingMessage &&
      !/StatusPlaceHolderImpl/i.test(displayContent) &&
      !/<!DOCTYPE\s+html|<html[\s>]/i.test(displayContent)
    ) {
      pipelineContent = `${displayContent}\n<StatusPlaceHolderImpl/>`;
    }

    const result = applySillyTavernDisplayPipeline({
      content: pipelineContent,
      characterName: characterName || '',
      userName: _userName || '',
      messageIndex: typeof messageIndex === 'number' ? messageIndex : undefined,
      totalMessages: typeof _totalMessages === 'number' ? _totalMessages : undefined,
      isStreaming: streaming && isLast,
      isUser: false,
      isSystem: false,
      globalRegexScripts: _globalRegexScripts,
      characterExtensions: _characterExtensions,
      presetData: _characterPresetData,
      chatMessages: _chatMessages as any,
    });

    return result;
  }, [isCharacterChat, isUser, displayContent, useNativeStRendering, characterName, _userName, messageIndex, _totalMessages, streaming, isLast, _globalRegexScripts, _characterExtensions, _characterPresetData, _chatMessages, formatterRevision, hasStatusBarScript]);

  // [FULLSCREEN-ADAPT] 全屏界面检测：smart-card 内容若为「开局界面/星空启动器」等界面文档
  // （body 撑满视口 height:100vh/100dvh、或含 #launcher/.launcher 主体、或 mg-launcher 家族），
  // 在 ST 中该类界面是原样渲染在页面视口上的全屏效果，Palink 应允许其进入沉浸式全屏分支；
  // 否则（状态栏面板等）保持内联。CharacterCardRenderer 会对内容中的每个 HTML 块独立判定
  // （htmlPrefersImmersive 已收紧，不再把状态栏的 position:fixed 装饰层误判为沉浸式）。
  const cardAllowsImmersive = useMemo(() => {
    const content = pipelineResult?.content || '';
    // 仅以显式 launcher 元素 / mg-launcher 家族为准（与 htmlPrefersImmersive 一致）：
    // 不能用 body{height:100vh} 等样式特征判定——状态栏面板文档的 body 同样写 100vh。
    const result = /(?:id\s*=\s*["']launcher["']|class\s*=\s*["'][^"']*\blauncher\b[^"']*["']|\bmg-launcher\b)/i.test(content);
    return result;
  }, [pipelineResult]);

  // [CONTRAST-ENHANCE] 主文档内联路径对比度增强：挂载到本消息内容容器，
  // 覆盖 .nk-msg 内联 HTML / InlineHtmlRenderer / ReactMarkdown 等所有内联路径
  // （对齐 CharacterCardRenderer 的 iframe 路径，恢复"亮色模式自动增加对比度"）。
  // 开场白同样参与增强：ST 中开场白文字色由卡片作者定义（如浅薰衣草 #d8cce8），
  // 在亮色浅背景上对比度不足 4.5，增强器保持色相只加深亮度，使其清晰可读。
  useEffect(() => {
    const container = contentContainerRef.current;
    if (!container || !isCharacterChat || isUser) return;
    contrastEnhancerRef.current = attachContrastEnhancer({
      container,
      doc: document,
      themeRoot: document.documentElement,
      isEnabled: isContrastEnhancementEnabled,
      onAdjusted: setContrastAdjustedCount,
    });
    return () => {
      contrastEnhancerRef.current?.dispose();
      contrastEnhancerRef.current = null;
    };
    // 增强器内部 MutationObserver 已覆盖内容变化（流式/正则处理），无需随 pipelineResult 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUser, isCharacterChat]);

  // [ST 兼容] 消息正文的渲染与显示剥离：Palink 消息 content 含渲染美化用的 <style>
  // （如 `.mes_text .custom-nk-msg{...}`），若留在 .mes_text 内，Galgame 等 ST 插件
  // 从 DOM 读取消息文本（innerHTML / textContent）会拿到 <style> 源码或 CSS 文本
  // （原版 ST 的 chat[i].mes 是纯文本、无 style）。这里把 .mes_text 内的 <style> 元素
  // 净化后物理移出到 document.body——CSS 选择器（.mes_text .xxx）与 style 元素位置无关，
  // 界面美化照常生效；而 .mes_text 的 innerHTML/textContent 不再含 CSS，插件读到纯净正文。
  // 净化（sanitizeStCompatCss）是关键兜底：角色卡可能写出未约束的全局规则（如
  // body{display:flex}），style 一旦注入主文档即全局生效，会污染页面布局（移动端 #root
  // 宽度塌陷 → 白屏）。此处对所有进入 document.body 的 style 统一过滤 html/body 等全局规则。
  useEffect(() => {
    const container = contentContainerRef.current;
    if (!container) return;
    const movedStyles: HTMLStyleElement[] = [];
    const detachStyleFromMesText = () => {
      const styles = Array.from(container.querySelectorAll('style'));
      for (const styleEl of styles) {
        if (styleEl.getAttribute('data-palink-mes-style-moved') === '1') continue;
        const cleanCss = sanitizeStCompatCss(styleEl.textContent || '');
        styleEl.remove();
        // 净化后无有效规则的直接丢弃，不注入 body（避免空 style 及泄漏）
        if (!cleanCss) continue;
        const clone = document.createElement('style');
        clone.setAttribute('data-palink-mes-style-moved', '1');
        clone.textContent = cleanCss;
        document.body.appendChild(clone);
        movedStyles.push(clone);
      }
    };
    detachStyleFromMesText();
    // 流式/正则处理会持续更新 .mes_text 内容（React 替换 innerHTML 时新 style 重新出现），
    // 用 MutationObserver 兜底持续移出。
    const observer = new MutationObserver(detachStyleFromMesText);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const styleEl of movedStyles) styleEl.remove();
    };
  }, []);

  // [双路径] 智能卡渲染路径：普通智能卡按 isLast 分流（最新内联、历史 iframe）。
  // 但「全屏界面」（cardAllowsImmersive，如开局 launcher/星空启动器）必须始终走
  // CharacterCardRenderer 的沉浸式全屏分支——InlineCardRenderer 是消息内嵌面板，
  // 没有全屏能力，会把 100vh 的全屏界面压缩成消息内面板（实测：重置后开局界面
  // 被内联渲染、immersive=0，全屏丢失）。CharacterCardRenderer 会按内容中每个
  // HTML 块独立判定沉浸式/内联（launcher 块全屏、状态栏块内联）。
  // 移动端 WebView 行为差异大，shouldUseInlineCardRendering 恒 false，一律 iframe 防黑屏。
  // [R-4] 桌面端默认也统一走 iframe（shouldUseInlineCardRendering 需显式 flag 才开启），
  // 消除"开场白内联、历史 iframe"的脚本全局不共享漂移；全屏 launcher 不受影响。
  const SmartCardComponent = useMemo<React.ComponentType<InlineCardRendererProps>>(
    () => {
      // 开场白（会话第一条 AI 消息，messageIndex===0）强制内联仅在内联 flag 显式
      // 开启时生效：双路径分流按 isLast 切内联/iframe，发送第二段后开场白 isLast
      // 变 false 会从内联漂移成 iframe（渲染路径突变）。默认（无 flag）统一 iframe，
      // 开场白稳定呈现，无漂移。全屏 launcher（cardAllowsImmersive）走沉浸式 iframe
      // 保留全屏。
      const isGreeting = !isUser && typeof messageIndex === 'number' && messageIndex === 0;
      const forceInlineGreeting = isGreeting && !cardAllowsImmersive && shouldUseInlineCardRendering();
      return (forceInlineGreeting || (shouldUseInlineCardRendering() && isLast && !cardAllowsImmersive)
        ? InlineCardRenderer
        : (CharacterCardRenderer as unknown as React.ComponentType<InlineCardRendererProps>));
    },
    [isLast, cardAllowsImmersive, isUser, messageIndex],
  );

  const contentSegments = useMemo(() => {
    if (isUser || !isCharacterChat) return [];
    // 统一使用 pipelineResult.markdownContent 作为分段解析源：
    // - 流式时：markdownContent 等于 pipelineResult.content（流式路径处理后的 markdown）
    // - 完成态：markdownContent 是 formatMessage 调用前的流式路径处理结果
    // 这样流式和完成态使用相同的处理链路，确保分段解析结果一致
    const source = pipelineResult?.markdownContent || displayContent;
    return parseContentSegments(source, streaming && isLast);
  }, [isUser, isCharacterChat, displayContent, streaming, isLast, pipelineResult]);

  const framelessSegments = useMemo(() => {
    if (!isFrameless || isUser) return [];
    const source = pipelineResult?.markdownContent || displayContent;
    return parseContentSegments(source, streaming && isLast);
  }, [isFrameless, isUser, displayContent, streaming, isLast, pipelineResult]);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // [ST 兼容] 消息内占位锚点点击防护（通用修复，不逐卡适配）：
  // 角色卡常把按钮写成 <a href="#">，卡片脚本被净化剥离后无任何真实跳转语义。
  // 显示管线（formatting.ts afterSanitizeAttributes）已不给占位锚点加 target，
  // 这里再兜底阻止默认行为：href="#" 会整页跳顶、href="" 会重新加载当前页、
  // javascript: 不应执行。真实外链（http/https/mailto/tel 等）不受影响。
  const handleMessageClick = useCallback((e: React.MouseEvent) => {
    const el = e.target as Element;
    if (!(el instanceof Element)) return;
    const anchor = el.closest('a');
    if (!anchor) return;
    const href = (anchor.getAttribute('href') || '').trim().toLowerCase();
    if (href === '' || href === '#' || href.startsWith('javascript:')) {
      e.preventDefault();
    }
  }, []);

  const handleFullscreen = useCallback((srcOrIndex: number | string) => {
    if (typeof srcOrIndex === 'number') {
      setFullscreenIndex(srcOrIndex);
    } else {
      const idx = userImages.findIndex(img => {
        const imgSrc = typeof img === 'string' ? img : img.url || '';
        return imgSrc === srcOrIndex;
      });
      setFullscreenIndex(idx >= 0 ? idx : 0);
    }
  }, [userImages]);

  const handleCloseFullscreen = useCallback(() => {
    setFullscreenIndex(null);
  }, []);

  const isInDeleteMode = isDeleteMode || showSelect || isMixedDeleteMode;
  const isItemSelected = isDeleteMode
    ? (selectedItems && message.id !== undefined && selectedItems.has(String(message.id)))
    : (isMixedDeleteMode && selectedWholeMessages && messageIndex !== undefined && selectedWholeMessages.has(messageIndex)) || isSelected;

  const handleSelectClick = () => {
    if (isMixedDeleteMode && onToggleWholeMessageSelect && messageIndex !== undefined) {
      onToggleWholeMessageSelect(messageIndex);
    } else if (isDeleteMode && onToggleSelect && message.id !== undefined) {
      onToggleSelect(String(message.id));
    } else if (onToggleSelect) {
      onToggleSelect();
    }
  };

  const markdownComponents = useMemo(() => ({
    code: CodeBlock,
    img: (props: any) => <MarkdownImg {...props} onClick={handleFullscreen} />,
    table: ({ children, ...props }: any) => (
      <div className="markdown-table-wrapper my-3 overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    thead: ({ children, ...props }: any) => {
      const allThEmpty = React.Children.toArray(children).every((child: any) => {
        const trChildren = child?.props?.children;
        if (!Array.isArray(trChildren)) return true;
        return trChildren.every((th: any) => {
          const text = typeof th?.props?.children === 'string'
            ? th.props.children
            : Array.isArray(th?.props?.children)
              ? th.props.children.join('')
              : '';
          return text.trim() === '';
        });
      });
      if (allThEmpty) return null;
      return <thead {...props}>{children}</thead>;
    },
    td: ({ children, ...props }: any) => {
      const text = React.Children.toArray(children).join('');
      const isStatusCell = ['🧥', '💖', '🎬', '💭', '🎯', '📍'].some(e => text.includes(e));
      if (isStatusCell) {
        return <td data-character-status {...props}>{children}</td>;
      }
      return <td {...props}>{children}</td>;
    },
  }), [handleFullscreen]);

  // Streaming: keep the proven pipeline-kind decision. Completed: decide from
  // the content essence (structural/widget HTML only) so a finished chat line
  // still uses the segment branch instead of being swallowed by html-display.
  // ST 兼容：角色聊天消息若含任何结构 HTML（<div>/<span>/<style> 等），对齐原版 ST
  // formatMessage 行为——直接内联渲染原始 HTML 进 .mes_text（含 <style>/<div>），
  // 不走分段渲染（分段会把 HTML 转义成纯文本，且 FramelessContent 无 .mes_text class，
  // 导致 Galgame 等依赖 .mes_text 的 ST 插件读不到消息内容）。
  // 关键：必须检查 pipelineResult?.content（经过正则脚本处理后的结果）而非 displayContent（原始内容），
  // 因为正则脚本（如[美化]猫神对话框）会将 <猫神>...</猫神> 转换为 <div class="nk-msg">...</div>，
  // 检查原始内容会漏检，导致正则生成的 HTML 被分段渲染转义为纯文本。
  // 额外检查：同时检查 markdownContent（分段源），因为 markdownContent 也可能包含 HTML。
  const isHtmlOrCard = (streaming && isLast)
    ? (pipelineResult && (pipelineResult.kind === 'html-display' || pipelineResult.kind === 'smart-card'))
    : isHtmlCardContent(pipelineResult?.content || pipelineResult?.markdownContent || displayContent);

  // ST 兼容：角色聊天消息统一走 .mes_text 容器渲染（对齐原版 ST 默认样式），
  // 停用 Palink 分段渲染（FramelessContent/SegmentBox 无 .mes_text class），
  // 使 ST 插件能稳定从 .mes_text 读取消息正文。
  const shouldUseSegments = false;

  // ST 兼容：开场白（会话首条 AI 消息）本质是普通内联 HTML，不走智能卡片渲染。
  // 智能卡片容器（palink-inline-card）没有 .mes_text 祖先，而 formatMessage 已把
  // <style> 选择器 re-scope 成 .mes_text .xxx（对齐 ST），导致 .custom-nk-msg 等
  // 样式作用域无法匹配、flex 布局失效（表现为开场白被堆叠成一张大卡片）。与 ST 一致，
  // 开场白应作为内联 HTML 渲染进 .mes_text 容器。除非是真正的沉浸式全屏卡（launcher）
  // 或需要 iframe/脚本隔离的智能卡片（htmlNeedsIframe，如状态栏/启动器依赖脚本）。
  const isGreetingInlineHtml =
    !isUser && typeof messageIndex === 'number' && messageIndex === 0 && !cardAllowsImmersive
    && !htmlNeedsIframe(pipelineResult?.content || pipelineResult?.markdownContent || displayContent);

  // 视口外跳过布局/绘制（.mes-render-skip）：仅用于"较早的纯文本/markdown 消息"。
  // 排除项：智能卡/HTML 卡（isHtmlOrCard）、TavernHelper 面板、状态栏脚本、NSFW 状态栏、
  // 沉浸式全屏卡——这些路径含 iframe 或脚本，跳过渲染会破坏 iframe 高度测量同步与
  // 插件 DOM 测量。最近 6 条消息不跳过，避免流式更新与贴底滚动时高度估算抖动。
  // 派生输入（streaming/isLast/messageIndex/totalMessages/message.content/
  // characterExtensions）均已在 React.memo 比较器中比较，memo 语义不受影响。
  const canSkipOffscreenRender =
    !streaming
    && !isLast
    && typeof messageIndex === 'number'
    && typeof _totalMessages === 'number'
    && messageIndex < _totalMessages - 6
    && !isHtmlOrCard
    && !tavernHelper
    && !hasStatusBarScript
    && statusBars.length === 0
    && !cardAllowsImmersive;

  return (
    <div
      className={cn(
        "flex gap-3 items-start group",
        // Fix 1: 追加 ST 兼容 mes class，使 ST 插件能通过 .mes[mesid="X"] 定位消息
        "mes",
        (streaming && isLast) && "animate-fade-in-up",
        isUser && "justify-end",
        isItemSelected && "bg-primary/5 rounded-lg p-1 -m-1",
        isInDeleteMode && "cursor-pointer",
        canSkipOffscreenRender && "mes-render-skip"
      )}
      data-mesid={messageIndex}
      // Fix 1: mesid / is_user / is_system 是 ST 标准属性（非 data-*），插件用 getAttribute('is_user')
      // 与 [is_user="false"] 选择器定位 AI 消息（如 Galgame 插件 applyGalgameMode 用 #chat > .mes[is_user!="true"]）
      // 用 spread cast 绕过 TS JSX 内置属性白名单（React 19 会原样渲染 lowercase 属性到 DOM）
      {...{ 
        mesid: messageIndex !== undefined ? String(messageIndex) : undefined,
        is_user: isUser ? 'true' : 'false',
        is_system: message.role === 'system' ? 'true' : 'false',
        // ST 兼容：角色 AI 消息携带 ch_name 属性，供插件读取当前角色名
        ch_name: isCharacterChat && !isUser ? characterName : undefined,
      } as Record<string, string | undefined>}
      onClick={() => {
        if (isInDeleteMode && isDeleteMode && onSetMultipleItemsSelect && message.id !== undefined && messageIndex !== undefined) {
          onSetMultipleItemsSelect([String(message.id)], !isItemSelected);
        } else if (isInDeleteMode && isMixedDeleteMode && onToggleWholeMessageSelect && messageIndex !== undefined) {
          onToggleWholeMessageSelect(messageIndex);
        }
      }}
    >
      <div className={cn(
        isUser && "max-w-[90%] md:max-w-[75%] lg:max-w-[65%]",
        isUser ? "items-end flex" : cn("items-start flex", isCharacterChat ? "w-full" : "gap-3 w-full"),
        chatStyle === 'bubbles' && !isUser && "max-w-[90%] md:max-w-[75%] lg:max-w-[65%]"
      )}>
        {!isUser && chatStyle !== 'document' && (!isCharacterChat || showCharacterAvatar) && (
          <div className="w-9 h-9 rounded-2xl overflow-hidden flex-shrink-0">
            {characterAvatar ? (
              <img src={characterAvatar} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
            ) : (
              <Avatar className={cn(
                "w-9 h-9 shrink-0 rounded-2xl"
              )}>
                <AvatarFallback className="bg-secondary text-foreground text-xs font-medium rounded-2xl">
                  {characterName?.[0]?.toUpperCase() || '🤖'}
                </AvatarFallback>
              </Avatar>
            )}
          </div>
        )}
        {(isInDeleteMode || showSelect) && (
          <div
            className={cn(
              "shrink-0 pt-1 cursor-pointer",
              isUser ? "order-last" : "order-first"
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleSelectClick();
            }}
          >
            <div className={cn(
              "w-5 h-5 rounded border-2 flex items-center justify-center transition-all",
              isItemSelected
                ? "bg-primary border-primary text-primary-foreground"
                : "border-muted-foreground/50 hover:border-primary"
            )}>
              {isItemSelected && (
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              )}
            </div>
          </div>
        )}

        <div className={cn(
          // ST 兼容：mes_block 容器。酒馆助手等 ST 插件用 $mes.find('.mes_block').append()
          // 注入消息级 UI（如 Galgame「进入 Galgame 模式」按钮），Palink 正文列是
          // flex-col，按钮 append 后换行到正文下方，行为对齐原版 ST；若无此 class，
          // 插件 fallback 到 $mes.append()，把块级按钮直接塞进 .mes 的 flex 行容器，
          // 与正文并排挤压导致正文被压缩到看不见。
          "flex flex-col flex-1 min-w-0 mes_block",
          isUser && "items-end"
        )}>
          <div className="flex flex-col">
            {!isUser && thinkingContent && showModelReasoning && (
              <ThinkingProcess
                content={thinkingContent}
                streaming={streaming && isLast}
                t={_t}
                messageKey={message.id ? String(message.id) : (messageIndex !== undefined ? `msg-${messageIndex}` : undefined)}
              />
            )}
         {!isUser && message.webSearchResults && message.webSearchResults.results.length > 0 && (
            <WebSearchResults
            query={message.webSearchResults.query}
                results={message.webSearchResults.results}
              messageId={message.id}
              />
            )}
            {/* ST 兼容：角色 AI 消息显示角色名（ch_name > name_text），对齐原版 ST 默认消息样式 */}
            {!isUser && isCharacterChat && (
              <div className="ch_name flex-container justifySpaceBetween">
                <div className="flex-container flex1 alignitemscenter">
                  <div className="flex-container alignItemsBaseline">
                    <span className="name_text">{characterName}</span>
                  </div>
                </div>
              </div>
            )}
            {(!isUser && displayContent) || isUser ? (
            <div
              ref={contentContainerRef}
              onClick={handleMessageClick}
              className={cn(
              "text-[15px] leading-relaxed w-full max-w-full break-words overflow-hidden relative",
              isUser
                ? chatStyle === 'bubbles'
                  ? 'px-5 py-3 bg-slate-900 text-white rounded-3xl rounded-br-lg border border-[var(--rp-color-ui-border)]'
                  : chatStyle === 'document'
                    ? 'px-3 py-2 bg-transparent text-[var(--rp-color-main-text)] border-b border-[var(--rp-color-ui-border)]'
                    : useNativeStRendering
                      ? 'px-5 py-3 text-[var(--rp-color-main-text)]'
                      : 'px-5 py-3 bg-slate-900 text-white rounded-3xl rounded-br-lg'
                : chatStyle === 'bubbles'
                  ? 'px-5 py-3 bg-[var(--rp-color-bot-msg)] text-[var(--rp-color-main-text)] rounded-3xl rounded-bl-lg border border-[var(--rp-color-ui-border)]'
                  : chatStyle === 'document'
                    ? 'px-3 py-2 bg-transparent text-[var(--rp-color-main-text)] border-b border-[var(--rp-color-ui-border)]'
                    : useNativeStRendering
                      ? 'px-5 py-3 text-[var(--rp-color-main-text)]'
                      : shouldUseSegments
                        ? 'px-5 py-3 space-y-0.5'
                        : 'px-5 py-3 text-[var(--rp-color-main-text)]',
              isMixedDeleteMode && isItemSelected && "ring-2 ring-primary"
            )}>
              {!isUser && contrastAdjustedCount > 0 && !contrastBadgeDismissed && (
                <div className="absolute bottom-1 right-2 z-10 flex items-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-2.5 py-1 text-[11px] leading-none text-muted-foreground shadow-sm backdrop-blur">
                  {/* P2-2（问题 10）: 角标从 right-2 top-1（遮挡卡片右上角/折叠按钮）
                      移至内容区底部内侧，悬浮于气泡底边之上，不遮挡卡片内容。 */}
                  <span>{smartCardText.contrastAdjustedBadge.replace('{n}', String(contrastAdjustedCount))}</span>
                  <button
                    type="button"
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => setContrastBadgeDismissed(true)}
                    aria-label={smartCardText.contrastAdjustedBadgeClose}
                    title={smartCardText.contrastAdjustedBadgeClose}
                  >
                    <X size={10} />
                  </button>
                </div>
              )}
              {isUser ? (
                <>
                  {userTextContent && (
                    // 用户消息气泡为黑底白字，须用 !text-white 覆盖 .roleplay-container .markdown-content 的全局颜色规则
                    <div className="markdown-content mes_text w-full break-words overflow-wrap-anywhere !text-white">
                      <ReactMarkdown
                        remarkPlugins={REMARK_PLUGINS}
                        rehypePlugins={REHYPE_PLUGINS}
                        components={markdownComponents}
                      >
                        {preprocessImageUrls(userTextContent)}
                      </ReactMarkdown>
                    </div>
                  )}
                </>
              ) : shouldUseSegments && isFrameless ? (
                <FramelessContent
                  segments={framelessSegments}
                  streaming={streaming && isLast}
                  markdownComponents={markdownComponents}
                />
              ) : shouldUseSegments ? (
                contentSegments.map((segment, i) => (
                  <SegmentBox key={i} segment={segment} markdownComponents={markdownComponents} />
                ))
              ) : streaming && isLast && isHtmlOrCard ? (
                // P2-1（问题 5）: 流式输出期间 HTML/智能卡内容不按 markdown 转义显示
                // （未完成的 HTML 会被当文本渲染，结束后突变 iframe）。渲染轻量占位，
                // 结束后由下方 smart-card/html-display 分支进入正式渲染，消除突变。
                <div
                  className="palink-smart-card-streaming w-full animate-pulse rounded-lg border border-muted/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <svg className="h-3.5 w-3.5 animate-spin text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>正在加载卡片…</span>
                  </span>
                </div>
              ) : streaming && isLast ? (
                <SmoothOutput
                  content={displayContent}
                  streaming={streaming}
                />
              ) : isCharacterChat && !isUser && !useNativeStRendering && isHtmlOrCard && (pipelineResult?.kind !== 'smart-card' || isGreetingInlineHtml) ? (
                <div
                  className="markdown-content mes_text w-full break-words overflow-wrap-anywhere"
                  dangerouslySetInnerHTML={{ __html: sanitizeStCompatHtml(pipelineResult?.content || displayContent) }}
                />
              ) : pipelineResult?.kind === 'smart-card' ? (
                <SmartCardComponent
                  content={pipelineResult.content}
                  onAction={onSmartCardAction}
                  renderRemaining={(remaining) => (
                    <div
                      className="markdown-content mes_text w-full break-words overflow-wrap-anywhere"
                      dangerouslySetInnerHTML={{ __html: sanitizeStCompatHtml(remaining) }}
                    />
                  )}
                  context={{
                    // [FULLSCREEN-ADAPT] 不再无条件强制内联：全屏界面文档（开局启动器/星空启动器，
                    // body{height:100vh} 或 #launcher）允许走沉浸式全屏分支，对齐 ST 原样渲染；
                    // 状态栏等普通面板仍为 inline（其 HTML 的 position:fixed 装饰层不会再被
                    // htmlPrefersImmersive 误判为沉浸式）。CharacterCardRenderer 会按内容中每个
                    // HTML 块独立判定沉浸式/内联，故同一条消息可同时含全屏 launcher 与内联状态栏。
                    presentationMode: cardAllowsImmersive ? 'immersive-sandbox' : 'inline',
                    characterId: _characterId ? String(_characterId) : undefined,
                    characterName,
                    userName: _userName,
                    messageId: message.id,
                    messageContent: displayContent,
                    firstMes: _characterFirstMes,
                    alternateGreetings: _characterAlternateGreetings,
                    sessionId: _sessionId ? String(_sessionId) : undefined,
                    characterExtensions: _characterExtensions as any,
                    variables: (message.extra?.variables as any) ?? _sessionVariables ?? { stat_data: {} },
                  }}
                />
              ) : pipelineResult && pipelineResult.kind === 'html-display' ? (
                <InlineHtmlRenderer
                  html={pipelineResult.content}
                  className="markdown-content mes_text w-full break-words overflow-wrap-anywhere"
                />
              ) : (
                <div className="markdown-content mes_text w-full break-words overflow-wrap-anywhere">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {preprocessImageUrls(pipelineResult?.content || displayContent)}
                  </ReactMarkdown>
                </div>
              )}
              {statusBars && statusBars.length > 0 ? (
                <div className="mt-1" data-palink-contrast-skip>
                  {statusBars.map((bar, i) => (
                    <StatusBarPanel key={i} data={bar} />
                  ))}
                </div>
              ) : null}
              {/* 兼容酒馆助手面板：仅当卡片无「界面状态栏」正则（!hasStatusBarScript）时兜底渲染，
                  与原生 smart-card 状态栏互斥，完全对齐 ST。仅最新一条消息默认展开。 */}
              {!hasStatusBarScript && tavernHelper && (
                <TavernHelperPanel
                  tavernHelper={tavernHelper}
                  statData={statData}
                  defaultCollapsed={!isLast}
                />
              )}
            </div>
            ) : null}

            {isUser && userImages.length > 0 && (
              <div className="mt-1 flex justify-end">
                <ImageThumbnails
                  images={userImages}
                  onFullscreen={handleFullscreen}
                  compact={false}
                />
              </div>
            )}

            {!isUser && summary && (
              <div className={cn(
                "mt-2 px-5 py-2 text-xs leading-relaxed",
                'bg-slate-50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 rounded-2xl'
              )}>
                <span className="font-medium">摘要: </span>
                {summary}
              </div>
            )}
          </div>

          {!isUser && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 max-w-full">
              <div className="flex items-center gap-0.5 bg-muted/30 rounded px-1 py-0.5 shrink-0">
                <button
                  onClick={handleCopy}
                  className="palink-mes-action-btn p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
                  title="Copy"
                >
                  {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                </button>

                {canRegenerate && onRegenerate && (
                  <button
                    onClick={() => onRegenerate(message.id)}
                    className="palink-mes-action-btn p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
                    title="重新生成"
                  >
                    <RefreshCw size={12} />
                  </button>
                )}

                {memoryMode !== 'vector' && memoryStats && onCompress && (
                  <button
                    onClick={onCompress}
                    disabled={compressing || memoryStats.message_count < 5}
                    className={cn(
                      "palink-mes-action-btn p-1 rounded-sm transition-colors flex items-center gap-0.5 text-[10px] font-medium",
                      compressing || memoryStats.message_count < 5
                        ? "opacity-40 cursor-not-allowed text-muted-foreground"
                        : memoryStats.compression_needed
                          ? "text-amber-600 hover:text-amber-700 hover:bg-amber-100/50"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary/80"
                    )}
                    title={memoryStats.message_count < 5 ? '记忆太少，无需压缩' : '压缩记忆'}
                  >
                    <Zap size={12} />
                    <span className="hidden sm:inline">{compressing ? '...' : '压缩'}</span>
                  </button>
                )}

                {onDelete && (
                  <button
                    onClick={onDelete}
                    className="palink-mes-action-btn p-1 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title="删除消息"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              {isCharacterChat && messageModel && (
                <span className="text-[10px] text-muted-foreground/50 font-mono truncate max-w-[100px]" title={messageModel.id}>
                  {messageModel.alias || messageModel.id?.split('/').pop()}
                </span>
              )}

              <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs shrink-0">
                {tokens !== undefined && tokens > 0 && (
                  <div className="flex items-center gap-0.5 text-muted-foreground">
                    <span className="font-mono tabular-nums">{tokens.toLocaleString()}</span>
                    <span className="text-muted-foreground/70">tokens</span>
                  </div>
                )}

                {memoryMode !== 'vector' && memoryStats && (
                  <div
                    className="flex items-center gap-1"
                    title={`记忆: ${memoryStats.message_count}条 / ${memoryStats.token_count}tokens`}
                  >
                    <div className="relative w-5 h-5 sm:w-6 sm:h-6">
                      <svg className="w-5 h-5 sm:w-6 sm:h-6 transform -rotate-90">
                        <circle
                          cx="10"
                          cy="10"
                          r="8"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="text-muted/30"
                        />
                        <circle
                          cx="10"
                          cy="10"
                          r="8"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          className={cn(
                            "transition-colors duration-300",
                            memoryStats.token_count < 4000 ? "text-primary" :
                            memoryStats.token_count < 6400 ? "text-amber-500" :
                            "text-red-500"
                          )}
                          style={{
                            strokeDasharray: `${2 * Math.PI * 8}`,
                            strokeDashoffset: `${2 * Math.PI * 8 * (1 - Math.min(memoryStats.token_count / 8000, 1))}`,
                            transition: 'stroke-dashoffset 0.5s ease-out'
                          }}
                        />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className={cn(
                          "text-[7px] sm:text-[8px] font-semibold tabular-nums",
                          memoryStats.token_count < 4000 ? "text-muted-foreground" :
                          memoryStats.token_count < 6400 ? "text-amber-600" :
                          "text-red-600"
                        )}>
                          {Math.round(Math.min(memoryStats.token_count / 8000 * 100, 100))}%
                        </span>
                      </div>
                    </div>

                    <Database
                      size={10}
                      className={cn(
                        "sm:w-3 sm:h-3 transition-colors duration-300",
                        memoryStats.token_count < 4000 ? "text-muted-foreground/60" :
                        memoryStats.token_count < 6400 ? "text-amber-500/80" :
                        "text-red-500/80"
                      )}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {fullscreenIndex !== null && userImages.length > 0 && (
        <FullscreenImageViewer
          images={userImages}
          initialIndex={fullscreenIndex}
          onClose={handleCloseFullscreen}
        />
      )}
    </div>
  );
};

export const Message = React.memo(MessageInner, (prev, next) => {
  if (prev.message.id !== next.message.id) return false;
  if (prev.message.content !== next.message.content) return false;
  if (prev.message.role !== next.message.role) return false;
  if (prev.message.model !== next.message.model) return false;
  if (prev.message.webSearchResults !== next.message.webSearchResults) return false;
  if (prev.streaming !== next.streaming) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.showSelect !== next.showSelect) return false;
  if (prev.isDeleteMode !== next.isDeleteMode) return false;
  if (prev.isMixedDeleteMode !== next.isMixedDeleteMode) return false;
  if (prev.compressing !== next.compressing) return false;
  if (prev.showModelReasoning !== next.showModelReasoning) return false;
  if (prev.canRegenerate !== next.canRegenerate) return false;
  if (prev.canEdit !== next.canEdit) return false;
  if (prev.memoryMode !== next.memoryMode) return false;
  if (prev.tokens !== next.tokens) return false;
  if (prev.isCharacterChat !== next.isCharacterChat) return false;
  if (prev.userAvatar !== next.userAvatar) return false;
  if (prev.userName !== next.userName) return false;
  if (prev.characterAvatar !== next.characterAvatar) return false;
  if (prev.characterName !== next.characterName) return false;
  if (prev.characterId !== next.characterId) return false;
  if (prev.characterFirstMes !== next.characterFirstMes) return false;
  if (prev.characterAlternateGreetings !== next.characterAlternateGreetings) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.messageIndex !== next.messageIndex) return false;
  if (prev.characterDisplayMode !== next.characterDisplayMode) return false;
  if (prev.chatStyle !== next.chatStyle) return false;
  if (prev.useNativeStRendering !== next.useNativeStRendering) return false;
  if (prev.summary !== next.summary) return false;
  if (prev.models !== next.models) return false;
  if (prev.t !== next.t) return false;
  if (prev.isGeneratingImage !== next.isGeneratingImage) return false;
  // 回调函数引用比较
  if (prev.onCompress !== next.onCompress) return false;
  if (prev.onRegenerate !== next.onRegenerate) return false;
  if (prev.onToggleSelect !== next.onToggleSelect) return false;
  if (prev.onDelete !== next.onDelete) return false;
  if (prev.onSetMultipleItemsSelect !== next.onSetMultipleItemsSelect) return false;
  if (prev.onEdit !== next.onEdit) return false;
  if (prev.onToggleWholeMessageSelect !== next.onToggleWholeMessageSelect) return false;
  if (prev.onToggleMessagePartSelect !== next.onToggleMessagePartSelect) return false;
  if (prev.onSelectAllPartsInMessage !== next.onSelectAllPartsInMessage) return false;
  if (prev.onGenerateImage !== next.onGenerateImage) return false;
  if (prev.onSmartCardAction !== next.onSmartCardAction) return false;
  const msgId = String(prev.message.id);
  if (prev.selectedItems?.has(msgId) !== next.selectedItems?.has(msgId)) return false;
  const idx = prev.messageIndex;
  if (idx !== undefined) {
    if (prev.selectedWholeMessages?.has(idx) !== next.selectedWholeMessages?.has(idx)) return false;
    if (prev.selectedMessageParts?.get(idx) !== next.selectedMessageParts?.get(idx)) return false;
  }
  if (prev.memoryStats !== next.memoryStats) return false;
  if (prev.globalRegexScripts !== next.globalRegexScripts) return false;
  if (prev.characterExtensions !== next.characterExtensions) return false;
  if (prev.characterPresetData !== next.characterPresetData) return false;
  if (prev.sessionVariables !== next.sessionVariables) return false;
  if (prev.totalMessages !== next.totalMessages) return false;
  if (prev.chatMessages !== next.chatMessages) return false;
  return true;
});
