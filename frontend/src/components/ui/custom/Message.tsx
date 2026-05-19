import React, { useState, useMemo, useCallback } from 'react';
import { Copy, Check, Zap, Database, RefreshCw, Trash2, Globe, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
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

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

function MarkdownImg({ onClick, ...props }: any) {
  return (
    <img
      {...props}
      className="max-w-full h-auto max-h-64 object-contain rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
      loading="lazy"
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
  onRegenerate?: () => void;
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
  onEdit?: (newContent: string) => void;
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
  memoryMode?: string;
  summary?: string;
  characterDisplayMode?: string;
}

type ContentSegment = {
  type: 'character_thinking' | 'dialogue' | 'normal';
  text: string;
};

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

  const segments: ContentSegment[] = [];
  const segmentRegex = /"([^"]*)"|\(([^)]*)\)/g;
  let cursor = 0;
  let match;

  while ((match = segmentRegex.exec(content)) !== null) {
    if (match.index > cursor) {
      const normalText = content.slice(cursor, match.index).trim();
      if (normalText) {
        segments.push({ type: 'normal', text: normalText });
      }
    }

    const isCompleteDialogue = match[1] !== undefined && match[0].endsWith('"');
    const isCompleteThinking = match[2] !== undefined && match[0].endsWith(')');

    if (isCompleteDialogue) {
      segments.push({ type: 'dialogue', text: match[1] });
    } else if (isCompleteThinking) {
      segments.push({ type: 'character_thinking', text: match[2] });
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
      const openQuoteIdx = trimmed.lastIndexOf('"');
      const openParenIdx = trimmed.lastIndexOf('(');

      if (openQuoteIdx > openParenIdx && openQuoteIdx >= 0) {
        const beforeOpen = trimmed.slice(0, openQuoteIdx).trim();
        if (beforeOpen) {
          segments.push({ type: 'normal', text: beforeOpen });
        }
        const quotedContent = trimmed.slice(openQuoteIdx + 1);
        if (quotedContent) {
          segments.push({ type: 'dialogue', text: quotedContent });
        }
      } else if (openParenIdx > openQuoteIdx && openParenIdx >= 0) {
        const beforeOpen = trimmed.slice(0, openParenIdx).trim();
        if (beforeOpen) {
          segments.push({ type: 'normal', text: beforeOpen });
        }
        const parenContent = trimmed.slice(openParenIdx + 1);
        if (parenContent) {
          segments.push({ type: 'character_thinking', text: parenContent });
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
      <div className="my-1 px-3 py-2 rounded-lg bg-purple-50/80 dark:bg-purple-950/30 border-l-2 border-purple-400 dark:border-purple-600">
        <div className="text-[15px] text-purple-700 dark:text-purple-300 italic leading-relaxed">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {`(${segment.text})`}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  if (segment.type === 'dialogue') {
    return (
      <div className="my-1 px-3 py-2 rounded-lg bg-blue-50/80 dark:bg-blue-950/30 border-l-2 border-blue-400 dark:border-blue-600">
        <div className="text-[15px] text-blue-600 dark:text-blue-400 font-semibold leading-relaxed">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {`"${segment.text}"`}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <div className="my-1 px-3 py-2">
      <div className="markdown-content w-full break-words overflow-wrap-anywhere text-[15px] text-slate-900 dark:text-white leading-relaxed">
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
    <div className="w-full break-words overflow-wrap-anywhere space-y-0.5">
      {segments.map((seg, i) => {
        if (seg.type === 'dialogue') {
          return (
            <div key={i} className="text-[15px] font-semibold text-blue-600 dark:text-blue-400 leading-relaxed">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
                unwrapDisallowed
                allowedElements={['p', 'span', 'em', 'strong', 'code', 'math', 'inlineMath']}
              >
                {`"${seg.text}"`}
              </ReactMarkdown>
            </div>
          );
        }
        if (seg.type === 'character_thinking') {
          return (
            <div key={i} className="text-[15px] text-purple-600 dark:text-purple-400 italic leading-relaxed">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
                unwrapDisallowed
                allowedElements={['p', 'span', 'em', 'strong', 'code', 'math', 'inlineMath']}
              >
                {`(${seg.text})`}
              </ReactMarkdown>
            </div>
          );
        }
        return (
          <span
            key={i}
            className="text-[15px] text-slate-900 dark:text-white leading-relaxed"
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
  memoryMode,
  summary,
  characterDisplayMode = 'framed',
}: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);
  const [webSearchExpanded, setWebSearchExpanded] = useState(false);
  const isUser = message.role === 'user';
  const isFrameless = isCharacterChat && characterDisplayMode === 'frameless';

  const messageModel = models.find(m => m.id === message.model);

  const { thinkingContent, displayContent, userTextContent, userImages } = useMemo(() => {
    const content = message.content || '';
    const { thinkingContent: parsedThinking, mainContent } = parseThinkingContent(content);
    const { textContent, images } = extractImagesFromContent(mainContent);

    return {
      thinkingContent: parsedThinking,
      displayContent: mainContent,
      userTextContent: textContent,
      userImages: images
    };
  }, [message.content]);

  const contentSegments = useMemo(() => {
    if (isUser || !isCharacterChat) return [];
    return parseContentSegments(displayContent, streaming && isLast);
  }, [isUser, isCharacterChat, displayContent, streaming, isLast]);

  const framelessSegments = useMemo(() => {
    if (!isFrameless || isUser) return [];
    return parseContentSegments(displayContent, streaming && isLast);
  }, [isFrameless, isUser, displayContent, streaming, isLast]);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
  }), [handleFullscreen]);

  const shouldUseSegments = isCharacterChat && !isUser && contentSegments.length > 0;

  return (
    <div
      className={cn(
        "flex gap-3 items-start group",
        (streaming && isLast) && "animate-fade-in-up",
        isUser && "justify-end",
        isItemSelected && "bg-primary/5 rounded-lg p-1 -m-1",
        isInDeleteMode && "cursor-pointer"
      )}
      onClick={() => {
        if (isInDeleteMode && isDeleteMode && onSetMultipleItemsSelect && message.id !== undefined && messageIndex !== undefined) {
          onSetMultipleItemsSelect([String(message.id)], !isItemSelected);
        } else if (isInDeleteMode && isMixedDeleteMode && onToggleWholeMessageSelect && messageIndex !== undefined) {
          onToggleWholeMessageSelect(messageIndex);
        }
      }}
    >
      <div className={cn(isUser && "max-w-[90%] md:max-w-[75%] lg:max-w-[65%]", isUser ? "items-end flex" : cn("items-start flex", isCharacterChat ? "w-full" : "gap-3 w-full"))}>
        {!isUser && !isCharacterChat && (
          <div className="w-9 h-9 rounded-2xl overflow-hidden flex-shrink-0">
            {characterAvatar ? (
              <img src={characterAvatar} alt="" className="w-full h-full object-cover" />
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
          "flex flex-col flex-1 min-w-0",
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
            {(!isUser && displayContent) || isUser ? (
            <div className={cn(
              "px-5 py-3 text-[15px] leading-relaxed w-full max-w-full break-words overflow-hidden",
              isUser
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-3xl rounded-br-lg'
                : shouldUseSegments
                  ? 'space-y-0.5'
                  : 'text-slate-900 dark:text-white',
              isMixedDeleteMode && isItemSelected && "ring-2 ring-primary"
            )}>
              {isUser ? (
                <>
                  {userTextContent && (
                    <div className="markdown-content w-full break-words overflow-wrap-anywhere">
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
              ) : streaming && isLast ? (
                <SmoothOutput
                  content={displayContent}
                  streaming={streaming}
                />
              ) : (
                <div className="markdown-content w-full break-words overflow-wrap-anywhere">
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={markdownComponents}
                  >
                    {preprocessImageUrls(displayContent)}
                  </ReactMarkdown>
                </div>
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
                  className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
                  title="Copy"
                >
                  {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                </button>

                {canRegenerate && onRegenerate && (
                  <button
                    onClick={onRegenerate}
                    className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
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
                      "p-1 rounded-sm transition-colors flex items-center gap-0.5 text-[10px] font-medium",
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
                    className="p-1 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
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
  if (prev.streaming !== next.streaming) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.showSelect !== next.showSelect) return false;
  if (prev.isDeleteMode !== next.isDeleteMode) return false;
  if (prev.isMixedDeleteMode !== next.isMixedDeleteMode) return false;
  if (prev.compressing !== next.compressing) return false;
  if (prev.showModelReasoning !== next.showModelReasoning) return false;
  if (prev.canRegenerate !== next.canRegenerate) return false;
  if (prev.memoryMode !== next.memoryMode) return false;
  if (prev.tokens !== next.tokens) return false;
  if (prev.isCharacterChat !== next.isCharacterChat) return false;
  if (prev.userAvatar !== next.userAvatar) return false;
  if (prev.userName !== next.userName) return false;
  if (prev.characterAvatar !== next.characterAvatar) return false;
  if (prev.characterName !== next.characterName) return false;
  if (prev.messageIndex !== next.messageIndex) return false;
  if (prev.characterDisplayMode !== next.characterDisplayMode) return false;
  const msgId = String(prev.message.id);
  if (prev.selectedItems?.has(msgId) !== next.selectedItems?.has(msgId)) return false;
  const idx = prev.messageIndex;
  if (idx !== undefined) {
    if (prev.selectedWholeMessages?.has(idx) !== next.selectedWholeMessages?.has(idx)) return false;
    if (prev.selectedMessageParts?.get(idx) !== next.selectedMessageParts?.get(idx)) return false;
  }
  if (prev.memoryStats !== next.memoryStats) return false;
  return true;
});
