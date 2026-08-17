import DOMPurify from 'dompurify';
import { REGEX_PLACEMENT, type RegexScript } from '@/lib/sillytavern/regex/engine';
import { normalizeRegexScriptList } from '@/lib/sillytavern/regex/adapter';
import { substituteParamsExtended } from '@/lib/sillytavern/macros';
import {
  messageFormatting,
  stripSillyTavernNamePrefix,
  normalizeSillyTavernDisplayMarkdown,
  formatMessage,
  getShowdownConverter,
  preprocessMarkdownForShowdown,
  extractHtmlBlocks,
  restoreHtmlBlocks,
  encodeStyleTags,
  decodeStyleTags,
} from '@/lib/sillytavern/formatting';
// 异步版本 formatMessage（CPU 密集步骤走 Web Worker，长消息渲染不卡顿）
import { formatMessageAsync } from '@/lib/sillytavern/formatting-worker';
import { looksLikeRenderableCardHtml, looksLikeSmartCardHtml } from '@/components/ui/custom/CharacterCardRenderer';

const GLOBAL_REGEX_TTL_MS = 90_000;
const PROTECTED_BLOCK_PREFIX = '\u0000PALINK_ST_PROTECTED_';
const PROTECTED_BLOCK_SUFFIX = '\u0000';

let globalRegexScripts: RegexScript[] = [];
let globalRegexFetchedAt = 0;
let globalRegexInflight: Promise<RegexScript[]> | null = null;

export type SillyTavernDisplayKind = 'smart-card' | 'html-display' | 'markdown';
export type SillyTavernFormattingStage = 'beforeRegex' | 'afterRegex' | 'afterMarkdown';

export const sillyTavernFormattingStage = {
  BEFORE_REGEX: 'beforeRegex',
  AFTER_REGEX: 'afterRegex',
  AFTER_MARKDOWN: 'afterMarkdown',
} as const;

export const sillyTavernHookOrder = {
  EARLIEST: 0,
  EARLY: 10,
  NORMAL: 50,
  LATE: 90,
  LATEST: 100,
} as const;

export interface SillyTavernFormattingContext {
  characterName: string;
  ch_name: string;
  isSystem: boolean;
  isUser: boolean;
  messageId: number;
  isReasoning: boolean;
  stage: SillyTavernFormattingStage;
  depth?: number;
  placement?: number;
}

type SillyTavernFormattingHook = (content: string, context: Readonly<SillyTavernFormattingContext>) => string;

class SillyTavernMessageFormatter {
  readonly stage = sillyTavernFormattingStage;
  readonly order = sillyTavernHookOrder;
  private revision = 0;
  private listeners = new Set<() => void>();
  private hooks = new Map<SillyTavernFormattingStage, Array<{ fn: SillyTavernFormattingHook; order: number }>>([
    [sillyTavernFormattingStage.BEFORE_REGEX, []],
    [sillyTavernFormattingStage.AFTER_REGEX, []],
    [sillyTavernFormattingStage.AFTER_MARKDOWN, []],
  ]);

  getRevision(): number {
    return this.revision;
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyChanged() {
    this.revision += 1;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('[MessageFormatter] Listener error:', error);
      }
    });
  }

  addHook(fn: SillyTavernFormattingHook, options: { stage?: SillyTavernFormattingStage; order?: number } = {}) {
    if (typeof fn !== 'function') throw new TypeError('MessageFormatter: hook must be a function');
    // 双重检测：constructor.name 检测 AsyncFunction/AsyncGeneratorFunction，
    // fn.toString() 检测转译后可能丢失 constructor 名称的 async 函数
    if (
      (fn as { constructor?: { name?: string } }).constructor?.name?.includes('Async')
      || fn.toString().startsWith('async')
    ) {
      throw new TypeError('MessageFormatter: hooks must be synchronous');
    }
    const stage = options.stage || sillyTavernFormattingStage.AFTER_MARKDOWN;
    const bucket = this.hooks.get(stage);
    if (!bucket) throw new RangeError(`MessageFormatter: unknown stage '${stage}'`);
    const entry = { fn, order: Number.isFinite(Number(options.order)) ? Number(options.order) : sillyTavernHookOrder.NORMAL };
    bucket.push(entry);
    this.notifyChanged();
    return () => {
      const index = bucket.indexOf(entry);
      if (index >= 0) {
        bucket.splice(index, 1);
        this.notifyChanged();
      }
    };
  }

  clearHooks(stage?: SillyTavernFormattingStage) {
    if (stage) {
      const bucket = this.hooks.get(stage);
      if (!bucket) throw new RangeError(`MessageFormatter: unknown stage '${stage}'`);
      if (bucket.length > 0) {
        bucket.splice(0, bucket.length);
        this.notifyChanged();
      }
      return;
    }
    let changed = false;
    this.hooks.forEach((bucket) => {
      if (bucket.length > 0) {
        bucket.splice(0, bucket.length);
        changed = true;
      }
    });
    if (changed) this.notifyChanged();
  }

  runStage(stage: SillyTavernFormattingStage, content: string, context: Omit<SillyTavernFormattingContext, 'stage'>): string {
    const bucket = this.hooks.get(stage);
    if (!bucket?.length) return content;
    const hookContext = Object.freeze({ ...context, stage });
    let result = content;
    for (const { fn } of bucket.slice().sort((a, b) => a.order - b.order)) {
      try {
        const next = fn(result, hookContext);
        if (typeof next === 'string') result = next;
      } catch (error) {
        console.error(`[MessageFormatter] Hook error at stage '${stage}':`, error);
      }
    }
    return result;
  }

  hasHooks(stage?: SillyTavernFormattingStage): boolean {
    if (stage) return Boolean(this.hooks.get(stage)?.length);
    return Array.from(this.hooks.values()).some((bucket) => bucket.length > 0);
  }
}

export const messageFormatter = new SillyTavernMessageFormatter();
export const MessageFormatter = messageFormatter;

function installBrowserMessageFormatterCompat() {
  if (typeof window === 'undefined') return;
  const target = window as typeof window & {
    PalinkSillyTavern?: Record<string, unknown>;
    MessageFormatter?: unknown;
    messageFormatter?: unknown;
  };
  target.PalinkSillyTavern = {
    ...(target.PalinkSillyTavern || {}),
    messageFormatter,
    MessageFormatter: messageFormatter,
    formattingStage: sillyTavernFormattingStage,
    hookOrder: sillyTavernHookOrder,
  };
  if (!target.MessageFormatter) target.MessageFormatter = messageFormatter;
  if (!target.messageFormatter) target.messageFormatter = messageFormatter;
}

installBrowserMessageFormatterCompat();

export interface SillyTavernDisplayPipelineInput {
  content: string;
  characterExtensions?: unknown;
  presetData?: unknown;
  globalRegexScripts?: unknown;
  userName?: string;
  characterName?: string;
  messageIndex?: number;
  totalMessages?: number;
  isStreaming?: boolean;
  isUser?: boolean;
  isSystem?: boolean;
  isReasoning?: boolean;
  messageName?: string;
  messageExtra?: Record<string, unknown> | null;
  chatMessages?: Array<{
    id?: string | number | null;
    role?: string;
    is_system?: boolean;
    extra?: Record<string, unknown>;
  }>;
}

export interface SillyTavernDisplayPipelineResult {
  content: string;
  kind: SillyTavernDisplayKind;
  depth: number;
  appliedRegex: boolean;
  markdownContent: string;
}

function isAlreadyRenderedSmartCardDisplay(content: string): boolean {
  const text = String(content || '').trim();
  if (!text) return false;

  if (
    looksLikeSmartCardHtml(text)
    && !/<\/?(?:start|now_plot|sakura_status|GameStart|UpdateVariable|StatusPlaceHolderImpl)\b/i.test(text)
  ) {
    return true;
  }

  // 注意：之前有一个过于激进的检查 `looksLikeRenderableCardHtml(text) && text.startsWith('<')`
  // 会将混合了 HTML + Markdown 的角色卡内容误判为"已渲染"，跳过 Showdown 转换，
  // 导致 Markdown 标记（## 标题、**粗体**等）不被转换，渲染效果与 ST 官方不一致。
  // 已移除：真正"已渲染"的内容已由下方的精确检查覆盖。

  // Older Palink builds persisted SillyTavern display-regex HTML into the DB. Those
  // messages must not run through display regex again, otherwise status/opening UIs
  // are appended repeatedly and old chats grow multiple huge iframes.
  return /^\s*`{3,}html\s*\r?\n/i.test(text)
    || /<palink-html>[\s\S]*?<\/palink-html>/i.test(text)
    || /^\s*(?:<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>])/i.test(text);
}

function normalizeDepth(messageIndex?: number, totalMessages?: number): number {
  if (typeof messageIndex !== 'number' || typeof totalMessages !== 'number' || totalMessages <= 0) {
    return 0;
  }
  return Math.max(0, totalMessages - 1 - messageIndex);
}

function normalizeSillyTavernDepth(input: SillyTavernDisplayPipelineInput): number {
  const index = typeof input.messageIndex === 'number' ? input.messageIndex : -1;
  const chatMessages = Array.isArray(input.chatMessages) ? input.chatMessages : [];
  if (index >= 0 && chatMessages.length > 0) {
    const usableMessages = chatMessages
      .map((message, messageIndex) => ({ message, messageIndex }))
      .filter(({ message }) => !(message?.is_system || message?.role === 'system'));
    const usableIndex = usableMessages.findIndex(({ messageIndex }) => messageIndex === index);
    if (usableIndex >= 0) return Math.max(0, usableMessages.length - usableIndex - 1);
  }
  return normalizeDepth(input.messageIndex, input.totalMessages);
}

function getSillyTavernRegexPlacement(input: SillyTavernDisplayPipelineInput): number {
  if (input.isReasoning) return REGEX_PLACEMENT.REASONING;
  if (input.isUser) return REGEX_PLACEMENT.USER_INPUT;
  const extraType = typeof input.messageExtra?.type === 'string' ? input.messageExtra.type : '';
  if (extraType === 'narrator' || extraType === 'slash' || extraType === 'command') return REGEX_PLACEMENT.SLASH_COMMAND;
  return REGEX_PLACEMENT.AI_OUTPUT;
}

function getMessageFormatterBase(input: SillyTavernDisplayPipelineInput, depth?: number, placement?: number): Omit<SillyTavernFormattingContext, 'stage'> {
  const characterName = String(input.messageName || input.characterName || '').trim();
  return {
    characterName,
    ch_name: characterName,
    isSystem: Boolean(input.isSystem),
    isUser: Boolean(input.isUser),
    messageId: typeof input.messageIndex === 'number' ? input.messageIndex : -1,
    isReasoning: Boolean(input.isReasoning),
    depth,
    placement,
  };
}

function buildRegexScope(scripts: RegexScript[], source: 'global' | 'scoped' | 'preset'): RegexScript[] {
  return scripts
    .map((script, index) => ({
      ...script,
      order: typeof script.order === 'number' ? script.order : index,
      __palink_source: source,
    } as RegexScript & { __palink_source: string }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function normalizePresetRegexScripts(presetData: unknown): RegexScript[] {
  if (!presetData || typeof presetData !== 'object') return [];
  const extensions = (presetData as Record<string, unknown>).extensions;
  if (extensions && typeof extensions === 'object') {
    return normalizeRegexScriptList(extensions);
  }
  const prompts = (presetData as Record<string, unknown>).prompts;
  if (Array.isArray(prompts)) {
    const scriptGroups = prompts
      .map((prompt) => (prompt && typeof prompt === 'object' ? (prompt as Record<string, unknown>).extensions : null))
      .flatMap((extensions) => normalizeRegexScriptList(extensions));
    return scriptGroups;
  }
  return [];
}

function preprocessSillyTavernRawDisplay(content: string, _input: SillyTavernDisplayPipelineInput): string {
  // 宏替换由 formatMessage（非流式路径）或 fallback 路径统一处理，
  // 此处不再重复执行 substituteParamsExtended，避免双重替换导致的不一致。
  return content;
}

function applySillyTavernDisplayFormatting(content: string, input: SillyTavernDisplayPipelineInput): string {
  // isSystem 消息仍执行 collapseNewlines/fixMarkdown/protectBlocks（via messageFormatting）
  // 与 normalizeSillyTavernDisplayMarkdown；仅跳过 regex 与扩展钩子（在管线中处理）。
  let result = normalizeSillyTavernDisplayMarkdown(content);
  result = messageFormatting(result, { collapseNewlines: true, fixMarkdown: true, protectBlocks: true });
  if (!input.isSystem) {
    // wrapSillyTavernQuotedText 由 preprocessMarkdownForShowdown 统一处理，避免嵌套 <q>
    result = stripSillyTavernNamePrefix(result, input.messageName || input.characterName, input.isUser, input.isSystem);
  }
  return result;
}

function renderSillyTavernMarkdownToHtml(content: string): string {
  if (!content) return '';
  try {
    // P1-a (mirrors formatMessage): protect regex-generated HTML blocks from
    // quote-wrapping / Showdown HTML-mode before markdown preprocessing.
    const htmlBlocks = extractHtmlBlocks(content);
    const preprocessed = preprocessMarkdownForShowdown(htmlBlocks.text);
    const converter = getShowdownConverter();
    let html = converter.makeHtml(preprocessed);
    // Firefox newline fix in code blocks (mirrors formatMessage)
    html = html.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => {
      return match.replace(/\n/gm, '\u0000');
    });
    html = html.replace(/\u0000/g, '\n');
    html = html.trim();
    // Restore & in code blocks (mirrors formatMessage)
    html = html.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => {
      return match.replace(/&amp;/g, '&');
    });
    // Restore HTML blocks extracted before Showdown (mirrors formatMessage)
    html = restoreHtmlBlocks(html, htmlBlocks.blocks);
    // DOMPurify sanitize (mirrors formatMessage): protect <style> blocks,
    // then sanitize, then restore them. Closes XSS gap on streaming path.
    html = encodeStyleTags(html);
    html = String(DOMPurify.sanitize(html, {
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
      RETURN_TRUSTED_TYPE: false,
      MESSAGE_SANITIZE: true,
      ADD_TAGS: ['custom-style'],
    } as any));
    html = decodeStyleTags(html, { prefix: '.mes_text ' });
    return html;
  } catch {
    return content;
  }
}

export function applySillyTavernDisplayPipeline(input: SillyTavernDisplayPipelineInput): SillyTavernDisplayPipelineResult {
  const depth = normalizeSillyTavernDepth(input);
  const placement = getSillyTavernRegexPlacement(input);
  const formatterBase = getMessageFormatterBase(input, depth, placement);
  let content = preprocessSillyTavernRawDisplay(input.content || '', input);
  let appliedRegex = false;
  let markdownContent: string;
  const alreadyRenderedDisplay = isAlreadyRenderedSmartCardDisplay(content);

  // 状态栏/智能卡信号：消息含状态栏占位符（被正则[4]替换为 HTML 文档）或本身已是
  // smart-card HTML。此时 formatMessage 产出的 <script> 必须保留——它会进入
  // CharacterCardRenderer 的沙箱 iframe 内执行，而非父文档，安全由 frame 沙箱保证。
  const preserveScripts =
    looksLikeSmartCardHtml(content)
    || /StatusPlaceHolderImpl|sakura_status|now_plot|<GameStart|UpdateVariable/i.test(content);

  // Use new formatMessage for non-streaming, non-system, non-already-rendered content
  if (content && !input.isSystem && !input.isStreaming && !alreadyRenderedDisplay) {
    const before = content;

    // Compute markdownContent: streaming-path-style processed markdown
    // (macros + normalizeSillyTavernDisplayMarkdown + messageFormatting + stripSillyTavernNamePrefix)
    // for consistent segment parsing between streaming and completed states.
    let streamingPathMarkdown = substituteParamsExtended(content, {
      userName: input.userName || '',
      characterName: input.characterName || '',
      charName: input.characterName || '',
    });
    streamingPathMarkdown = applySillyTavernDisplayFormatting(streamingPathMarkdown, input);
    markdownContent = streamingPathMarkdown;

    // Collect hooks from messageFormatter
    const beforeRegexHooks: Array<(c: string) => string> = [];
    const afterRegexHooks: Array<(c: string) => string> = [];
    const afterMarkdownHooks: Array<(c: string) => string> = [];

    // Build hook wrappers that inject formatter context
    // runStage 内部对空 bucket 短路，无需外部 hasHooks 守卫
    beforeRegexHooks.push((c: string) => messageFormatter.runStage(sillyTavernFormattingStage.BEFORE_REGEX, c, formatterBase));
    afterRegexHooks.push((c: string) => messageFormatter.runStage(sillyTavernFormattingStage.AFTER_REGEX, c, formatterBase));
    afterMarkdownHooks.push((c: string) => messageFormatter.runStage(sillyTavernFormattingStage.AFTER_MARKDOWN, c, formatterBase));

    // Build regex params
    const globalScripts = buildRegexScope(normalizeRegexScriptList(input.globalRegexScripts), 'global');
    const scopedScripts = buildRegexScope(normalizeRegexScriptList(input.characterExtensions), 'scoped');
    const presetScripts = buildRegexScope(normalizePresetRegexScripts(input.presetData), 'preset');

    content = formatMessage(content, {
      characterName: input.characterName || '',
      isSystem: input.isSystem || false,
      isUser: input.isUser || false,
      messageId: typeof input.messageIndex === 'number' ? input.messageIndex : -1,
      isReasoning: input.isReasoning || false,
      depth,
      userName: input.userName || '',
      encodeTagsEnabled: false,
      allowName2Display: false,
      autoFixMarkdown: true,
    }, {
      runRegex: true,
      regexPlacement: placement,
      regexParams: {
        globalScripts,
        scopedScripts,
        presetScripts,
        isMarkdown: true,
        isPrompt: false,
        depth,
        userName: input.userName || '',
        characterName: input.characterName || '',
        characterOverride: input.characterName || '',
      } as any,
      beforeRegexHooks: beforeRegexHooks.length > 0 ? beforeRegexHooks : undefined,
      afterRegexHooks: afterRegexHooks.length > 0 ? afterRegexHooks : undefined,
      afterMarkdownHooks: afterMarkdownHooks.length > 0 ? afterMarkdownHooks : undefined,
      preserveScripts,
    });

    appliedRegex = before !== content;
  } else if (!looksLikeRenderableCardHtml(content)) {
    // Fallback to legacy path for streaming / already-rendered / system messages

    // BEFORE_REGEX hook: skip during streaming (consistent with AFTER_REGEX)
    // runStage 内部对空 bucket 短路，无需外部 hasHooks 守卫
    if (!input.isStreaming && !input.isSystem) {
      content = messageFormatter.runStage(sillyTavernFormattingStage.BEFORE_REGEX, content, formatterBase);
    }

    content = substituteParamsExtended(content, {
      userName: input.userName || '',
      characterName: input.characterName || '',
      charName: input.characterName || '',
    });

    let formattedMarkdown = applySillyTavernDisplayFormatting(content, input);

    // AFTER_REGEX hook: run only at streaming end to avoid blocking token reception
    // runStage 内部对空 bucket 短路，无需外部 hasHooks 守卫
    if (!input.isStreaming && !input.isSystem) {
      formattedMarkdown = messageFormatter.runStage(sillyTavernFormattingStage.AFTER_REGEX, formattedMarkdown, formatterBase);
    }

    // HTML stage: run when not streaming.
    // - isSystem: still run showdown (mirrors formatMessage), but skip AFTER_MARKDOWN hook
    // - non-system: run if AFTER_MARKDOWN hooks present or HTML tags detected
    const shouldRunHtmlStage = !input.isStreaming && (
      input.isSystem
      || messageFormatter.hasHooks(sillyTavernFormattingStage.AFTER_MARKDOWN)
      || /<\/?[a-z][\s\S]*>/i.test(formattedMarkdown)
    );

    if (shouldRunHtmlStage) {
      const renderedHtml = renderSillyTavernMarkdownToHtml(formattedMarkdown);
      // runStage 内部对空 bucket 短路，无需外部 hasHooks 守卫
      if (!input.isSystem) {
        content = messageFormatter.runStage(sillyTavernFormattingStage.AFTER_MARKDOWN, renderedHtml, formatterBase);
      } else {
        content = renderedHtml;
      }
    } else {
      content = formattedMarkdown;
    }
    markdownContent = content;
  } else {
    // Already-rendered HTML (smart-card / palink-html / DOCTYPE): run text-only
    // operations (BEFORE_REGEX hook + macros) which won't break rendered HTML,
    // but skip regex / formatting / showdown to preserve the existing HTML.
    // runStage 内部对空 bucket 短路，无需外部 hasHooks 守卫
    if (!input.isStreaming && !input.isSystem) {
      content = messageFormatter.runStage(sillyTavernFormattingStage.BEFORE_REGEX, content, formatterBase);
    }
    content = substituteParamsExtended(content, {
      userName: input.userName || '',
      characterName: input.characterName || '',
      charName: input.characterName || '',
    });
    markdownContent = content;
  }

  const kind: SillyTavernDisplayKind = looksLikeSmartCardHtml(content)
    ? 'smart-card'
    : looksLikeRenderableCardHtml(content) || /<\/?(?:p|div|span|q|em|strong|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|section|article|aside|header|footer|nav|main)\b/i.test(content)
      ? 'html-display'
      : 'markdown';

  return { content, kind, depth, appliedRegex, markdownContent };
}

/**
 * 异步版本 applySillyTavernDisplayPipeline
 *
 * 与同步版本行为一致，但 formatMessage 调用走 Web Worker（formatMessageAsync），
 * CPU 密集步骤（正则/宏/Showdown）不阻塞主线程，长消息渲染不卡顿。
 *
 * 调用方需为异步模式（useState + useEffect），不适用于 useMemo。
 *
 * Hooks 优化：
 *   - 仅在 messageFormatter 实际注册了对应 stage 的 hook 时才传入 hooks 数组
 *   - 避免无 hook 时传入空数组触发 formatMessageAsync 的 afterRegexHooks fallback
 *
 * Fallback：
 *   - Worker 不可用 / 出错 / afterRegexHooks 存在 → formatMessageAsync 内部回退同步 formatMessage
 *   - 流式 / 已渲染 / 系统消息 → 走与同步版本相同的轻量路径（不调用 formatMessage）
 */
export async function applySillyTavernDisplayPipelineAsync(
  input: SillyTavernDisplayPipelineInput,
): Promise<SillyTavernDisplayPipelineResult> {
  const depth = normalizeSillyTavernDepth(input);
  const placement = getSillyTavernRegexPlacement(input);
  const formatterBase = getMessageFormatterBase(input, depth, placement);
  let content = preprocessSillyTavernRawDisplay(input.content || '', input);
  let appliedRegex = false;
  let markdownContent: string;
  const alreadyRenderedDisplay = isAlreadyRenderedSmartCardDisplay(content);

  const preserveScripts =
    looksLikeSmartCardHtml(content)
    || /StatusPlaceHolderImpl|sakura_status|now_plot|<GameStart|UpdateVariable/i.test(content);

  // Use formatMessageAsync for non-streaming, non-system, non-already-rendered content
  if (content && !input.isSystem && !input.isStreaming && !alreadyRenderedDisplay) {
    const before = content;

    // Compute markdownContent (same as sync version)
    let streamingPathMarkdown = substituteParamsExtended(content, {
      userName: input.userName || '',
      characterName: input.characterName || '',
      charName: input.characterName || '',
    });
    streamingPathMarkdown = applySillyTavernDisplayFormatting(streamingPathMarkdown, input);
    markdownContent = streamingPathMarkdown;

    // 仅在 messageFormatter 实际注册了 hook 时才传入 hooks 数组
    // （避免 formatMessageAsync 因 afterRegexHooks 非空而 fallback 到同步路径）
    const beforeRegexHooks = messageFormatter.hasHooks(sillyTavernFormattingStage.BEFORE_REGEX)
      ? [(c: string) => messageFormatter.runStage(sillyTavernFormattingStage.BEFORE_REGEX, c, formatterBase)]
      : undefined;
    const afterRegexHooks = messageFormatter.hasHooks(sillyTavernFormattingStage.AFTER_REGEX)
      ? [(c: string) => messageFormatter.runStage(sillyTavernFormattingStage.AFTER_REGEX, c, formatterBase)]
      : undefined;
    const afterMarkdownHooks = messageFormatter.hasHooks(sillyTavernFormattingStage.AFTER_MARKDOWN)
      ? [(c: string) => messageFormatter.runStage(sillyTavernFormattingStage.AFTER_MARKDOWN, c, formatterBase)]
      : undefined;

    // Build regex params
    const globalScripts = buildRegexScope(normalizeRegexScriptList(input.globalRegexScripts), 'global');
    const scopedScripts = buildRegexScope(normalizeRegexScriptList(input.characterExtensions), 'scoped');
    const presetScripts = buildRegexScope(normalizePresetRegexScripts(input.presetData), 'preset');

    content = await formatMessageAsync(content, {
      characterName: input.characterName || '',
      isSystem: input.isSystem || false,
      isUser: input.isUser || false,
      messageId: typeof input.messageIndex === 'number' ? input.messageIndex : -1,
      isReasoning: input.isReasoning || false,
      depth,
      userName: input.userName || '',
      encodeTagsEnabled: false,
      allowName2Display: false,
      autoFixMarkdown: true,
    }, {
      runRegex: true,
      regexPlacement: placement,
      regexParams: {
        globalScripts,
        scopedScripts,
        presetScripts,
        isMarkdown: true,
        isPrompt: false,
        depth,
        userName: input.userName || '',
        characterName: input.characterName || '',
        characterOverride: input.characterName || '',
      } as any,
      beforeRegexHooks,
      afterRegexHooks,
      afterMarkdownHooks,
      preserveScripts,
    });

    appliedRegex = before !== content;
  } else if (!looksLikeRenderableCardHtml(content)) {
    // Fallback to legacy path for streaming / already-rendered / system messages
    // （与同步版本完全一致，不走 formatMessage，无需异步化）
    if (!input.isStreaming && !input.isSystem) {
      content = messageFormatter.runStage(sillyTavernFormattingStage.BEFORE_REGEX, content, formatterBase);
    }

    content = substituteParamsExtended(content, {
      userName: input.userName || '',
      characterName: input.characterName || '',
      charName: input.characterName || '',
    });

    let formattedMarkdown = applySillyTavernDisplayFormatting(content, input);

    if (!input.isStreaming && !input.isSystem) {
      formattedMarkdown = messageFormatter.runStage(sillyTavernFormattingStage.AFTER_REGEX, formattedMarkdown, formatterBase);
    }

    const shouldRunHtmlStage = !input.isStreaming && (
      input.isSystem
      || messageFormatter.hasHooks(sillyTavernFormattingStage.AFTER_MARKDOWN)
      || /<\/?[a-z][\s\S]*>/i.test(formattedMarkdown)
    );

    if (shouldRunHtmlStage) {
      const renderedHtml = renderSillyTavernMarkdownToHtml(formattedMarkdown);
      if (!input.isSystem) {
        content = messageFormatter.runStage(sillyTavernFormattingStage.AFTER_MARKDOWN, renderedHtml, formatterBase);
      } else {
        content = renderedHtml;
      }
    } else {
      content = formattedMarkdown;
    }
    markdownContent = content;
  } else {
    // Already-rendered HTML
    if (!input.isStreaming && !input.isSystem) {
      content = messageFormatter.runStage(sillyTavernFormattingStage.BEFORE_REGEX, content, formatterBase);
    }
    content = substituteParamsExtended(content, {
      userName: input.userName || '',
      characterName: input.characterName || '',
      charName: input.characterName || '',
    });
    markdownContent = content;
  }

  const kind: SillyTavernDisplayKind = looksLikeSmartCardHtml(content)
    ? 'smart-card'
    : looksLikeRenderableCardHtml(content) || /<\/?(?:p|div|span|q|em|strong|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|section|article|aside|header|footer|nav|main)\b/i.test(content)
      ? 'html-display'
      : 'markdown';

  return { content, kind, depth, appliedRegex, markdownContent };
}

export function getCachedGlobalRegexScripts(): RegexScript[] {
  return globalRegexScripts;
}

export async function preloadGlobalRegexScripts(fetcher: (url: string) => Promise<unknown>): Promise<RegexScript[]> {
  const now = Date.now();
  if (globalRegexScripts.length > 0 && now - globalRegexFetchedAt < GLOBAL_REGEX_TTL_MS) {
    return globalRegexScripts;
  }
  if (globalRegexInflight) return globalRegexInflight;

  globalRegexInflight = fetcher('/api/plugins/active/regex')
    .then((result) => {
      globalRegexScripts = normalizeRegexScriptList(result);
      globalRegexFetchedAt = Date.now();
      return globalRegexScripts;
    })
    .catch(() => globalRegexScripts)
    .finally(() => {
      globalRegexInflight = null;
    });

  return globalRegexInflight;
}

export interface SillyTavernEngineConfig {
  globalRegexScripts: RegexScript[];
  customCSS: string;
  themePreset: Record<string, unknown> | null;
  generationPreset: Record<string, unknown> | null;
}

export function createDefaultEngineConfig(): SillyTavernEngineConfig {
  return {
    globalRegexScripts: [],
    customCSS: '',
    themePreset: null,
    generationPreset: null,
  };
}

const ENGINE_CONFIG_KEY = 'palink-silly-tavern-engine-config';

export function loadEngineConfig(): SillyTavernEngineConfig {
  try {
    const raw = localStorage.getItem(ENGINE_CONFIG_KEY);
    if (!raw) return createDefaultEngineConfig();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createDefaultEngineConfig();
    return {
      globalRegexScripts: Array.isArray(parsed.globalRegexScripts) ? parsed.globalRegexScripts : [],
      customCSS: typeof parsed.customCSS === 'string' ? parsed.customCSS : '',
      themePreset: parsed.themePreset && typeof parsed.themePreset === 'object' ? parsed.themePreset : null,
      generationPreset: parsed.generationPreset && typeof parsed.generationPreset === 'object' ? parsed.generationPreset : null,
    };
  } catch {
    return createDefaultEngineConfig();
  }
}

export function saveEngineConfig(config: SillyTavernEngineConfig): void {
  try {
    localStorage.setItem(ENGINE_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('Failed to save engine config:', error);
  }
}
