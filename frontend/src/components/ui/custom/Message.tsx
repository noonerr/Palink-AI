import React, { useState } from 'react';
import { Copy, Check, Zap, Database, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ReactMarkdown from 'react-markdown';
import { CodeBlock } from './CodeBlock';
import { SmoothOutput } from './SmoothOutput';
import type { Message as MessageType, Model } from '@/types';

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
  memoryMode?: string;
}

const MessageInner: React.FC<MessageProps> = ({
  message,
  userAvatar,
  userName,
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
  selectedMessageParts,
  onToggleWholeMessageSelect,
  onToggleMessagePartSelect,
  isCharacterChat = false,
  memoryMode,
}) => {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  
  const messageModel = models.find(m => m.id === message.model);
  const aiIcon = messageModel?.icon || messageModel?.avatar;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isInDeleteMode = isDeleteMode || showSelect || isMixedDeleteMode;
  const isItemSelected = isDeleteMode 
    ? (selectedItems && message.id !== undefined && selectedItems.has(String(message.id)))
    : (isMixedDeleteMode && selectedWholeMessages && messageIndex !== undefined && selectedWholeMessages.has(messageIndex)) || isSelected;
  
  const getSelectedParts = () => {
    if (isMixedDeleteMode && selectedMessageParts && messageIndex !== undefined) {
      return selectedMessageParts.get(messageIndex) || new Set();
    }
    return new Set();
  };
  
  const selectedParts = getSelectedParts();

  const handleSelectClick = () => {
    if (isMixedDeleteMode && onToggleWholeMessageSelect && messageIndex !== undefined) {
      onToggleWholeMessageSelect(messageIndex);
    } else if (isDeleteMode && onToggleSelect && message.id !== undefined) {
      onToggleSelect(String(message.id));
    } else if (onToggleSelect) {
      onToggleSelect();
    }
  };

  const handleTogglePartSelect = (partId: string) => {
    if (isMixedDeleteMode && onToggleMessagePartSelect && messageIndex !== undefined) {
      onToggleMessagePartSelect(messageIndex, partId);
    }
  };

type MessagePart = {
    type: 'modelReasoning' | 'thinking' | 'action' | 'text';
    content: string;
    id: string;
  };
  
  let content = message.content;
  
  const cleanGrokOutput = (str: string): string => {
    let result = str;
    
    if (typeof result !== 'string') {
      result = String(result || '');
    }
    
    const patternsToRemove = [
      /<\/?think>[\s\S]*?<\/?think>/gi,
      /<\/?thinking>[\s\S]*?<\/?thinking>/gi,
      /<\/?\|t\|>[\s\S]*?<\/?\|t\|>/gi,
      /<\/?\|a\|>[\s\S]*?<\/?\|a\|>/gi,
      /<\/?action>[\s\S]*?<\/?action>/gi,
      /\[\/?action\][\s\S]*?\[\/?action\]/gi,
      /<\/?model_reasoning>[\s\S]*?<\/?model_reasoning>/gi,
      /<think>[\s\S]*?<\/think>/gi,
      /<thinking>[\s\S]*?<\/thinking>/gi,
      /<\|t\|>[\s\S]*?<\/\|t\|>/gi,
      /<\|a\|>[\s\S]*?<\/\|a\|>/gi,
      /<action>[\s\S]*?<\/action>/gi,
      /\[action\][\s\S]*?\[\/action\]/gi,
      /<model_reasoning>[\s\S]*?<\/model_reasoning>/gi,
      /<\/?think>/gi,
      /<\/?thinking>/gi,
      /<\/?\|t\|>/gi,
      /<\/?\|a\|>/gi,
      /<\/?action>/gi,
      /\[\/?action\]/gi,
      /<\/?model_reasoning>/gi,
      /\u0393\u03c1\u03bf\u03ba[\s\S]*?\u0393\u03c1\u03bf\u03ba/gi,
      /Handling\s+\w+[\s\S]*?-[\s\S]*?/gi,
      /Parsing\s+\w+[\s\S]*?-[\s\S]*?/gi,
    ];
    
    patternsToRemove.forEach(pattern => {
      result = result.replace(pattern, '');
    });
    
    result = result.replace(/\s{2,}/g, ' ');
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.trim();
    
    return result;
  };
  
  const decodeHTMLEntities = (str: any) => {
    let result = str;
    
    if (typeof result !== 'string') {
      result = String(result || '');
    }
    
    result = result.replace(/\\u003c/g, '<');
    result = result.replace(/\\u003e/g, '>');
    result = result.replace(/\\u0026/g, '&');
    
    result = result.replace(/&amp;/g, '&');
    result = result.replace(/&lt;/g, '<');
    result = result.replace(/&gt;/g, '>');
    result = result.replace(/&quot;/g, '"');
    result = result.replace(/&#39;/g, "'");
    result = result.replace(/&#x27;/g, "'");
    
    return result;
  };
  
  if (typeof content !== 'string') {
    content = String(content || '');
  }
  
  let prevContent;
  let iterations = 0;
  do {
    prevContent = content;
    content = decodeHTMLEntities(content);
    iterations++;
  } while (content !== prevContent && iterations < 5);
  
  content = cleanGrokOutput(content);
  
  let allTags = [
    { type: 'modelReasoning', start: '<model_reasoning>', end: '</model_reasoning>' }
  ];
  
  if (isCharacterChat) {
    allTags = [
      { type: 'modelReasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
      { type: 'thinking', start: '<thinking>', end: '</thinking>' },
      { type: 'thinking', start: '<think>', end: '</think>' },
      { type: 'thinking', start: '<|t|>', end: '</|t|>' },
      { type: 'thinking', start: '<|t|>', end: '<|/t|>' },
      { type: 'action', start: '<action>', end: '</action>' },
      { type: 'action', start: '[action]', end: '[/action]' },
      { type: 'action', start: '<|a|>', end: '</|a|>' },
      { type: 'action', start: '<|a|>', end: '<|/a|>' }
    ];
  }
  
  const parts: MessagePart[] = [];
  let remainingContent = content;
  let actionIndex = 0;
  let textIndex = 0;
  
  try {
    while (remainingContent.length > 0) {
      let bestMatch: { tag: any; startIdx: number; endIdx: number } | null = null;
      
      for (const tag of allTags) {
        const startIdx = remainingContent.indexOf(tag.start);
        if (startIdx !== -1) {
          const endIdx = remainingContent.indexOf(tag.end, startIdx + tag.start.length);
          if (endIdx !== -1) {
            const matchLength = endIdx - startIdx + tag.end.length;
            if (!bestMatch || 
                startIdx < bestMatch.startIdx || 
                (startIdx === bestMatch.startIdx && matchLength > (bestMatch.endIdx - bestMatch.startIdx + bestMatch.tag.end.length))) {
              bestMatch = { tag, startIdx, endIdx };
            }
          }
        }
      }
      
      if (bestMatch) {
        if (bestMatch.startIdx > 0) {
          const beforeText = remainingContent.substring(0, bestMatch.startIdx);
          if (typeof beforeText === 'string' && beforeText.trim()) {
            parts.push({ type: 'text', content: beforeText, id: `text-${textIndex++}` });
          }
        }
        
        const tagContent = remainingContent.substring(
          bestMatch.startIdx + bestMatch.tag.start.length,
          bestMatch.endIdx
        );
        const trimmedTagContent = typeof tagContent === 'string' ? tagContent.trim() : '';
        
        let partId: string;
        if (bestMatch.tag.type === 'action') {
          partId = `action-${actionIndex++}`;
        } else if (bestMatch.tag.type === 'modelReasoning') {
          partId = 'modelReasoning';
        } else {
          partId = 'thinking';
        }
        
        parts.push({ 
          type: bestMatch.tag.type as any, 
          content: trimmedTagContent, 
          id: partId 
        });
        
        remainingContent = remainingContent.substring(bestMatch.endIdx + bestMatch.tag.end.length);
      } else {
        if (typeof remainingContent === 'string' && remainingContent.trim()) {
          parts.push({ type: 'text', content: remainingContent, id: `text-${textIndex++}` });
        }
        break;
      }
    }
  } catch (e) {
    console.error('Error parsing message:', e);
    parts.length = 0;
  }

  return (
    <div 
      className={cn(
        "flex gap-3 sm:gap-4 items-start group animate-fade-in-up",
        isUser && "flex-row-reverse",
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
      <Avatar className={cn(
        "w-7 h-7 sm:w-8 sm:h-8 shrink-0",
        isUser ? "bg-primary" : "bg-secondary"
      )}>
        {isUser ? (
          <>
            <AvatarImage src={userAvatar} />
            <AvatarFallback className="bg-primary text-primary-foreground text-[10px] sm:text-xs font-medium">
              {userName?.[0]?.toUpperCase() || 'U'}
            </AvatarFallback>
          </>
        ) : (
          <AvatarFallback className="bg-transparent text-foreground text-[10px] sm:text-xs p-0">
            {aiIcon?.startsWith('http') || aiIcon?.startsWith('/') || aiIcon?.startsWith('data:') ? (
              <img src={aiIcon} alt="" className="w-full h-full object-cover rounded-full" />
            ) : (
              <span className="text-xs sm:text-sm">{aiIcon || '🤖'}</span>
            )}
          </AvatarFallback>
        )}
      </Avatar>

      <div className={cn(
        "flex flex-col max-w-[92%] sm:max-w-[85%]",
        isUser && "items-end"
      )}>
        {parts.length > 0 ? (
          parts.map((part, partIndex) => {
            if (part.type === 'modelReasoning') {
              if (!showModelReasoning || isUser) return null;
              return (
                <div key={`${partIndex}-${part.id}`} className="flex items-start gap-2 mb-3">
                  {isMixedDeleteMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePartSelect(part.id);
                      }}
                      className={cn(
                        "w-4 h-4 rounded border-2 flex items-center justify-center transition-all shrink-0 mt-1",
                        selectedParts.has(part.id)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/50 hover:border-primary"
                      )}
                    >
                      {selectedParts.has(part.id) && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      )}
                    </button>
                  )}
                  <div className={cn(
                    "flex-1 rounded-xl border-2 border-purple-200 bg-purple-50/30 dark:bg-purple-900/10 overflow-hidden",
                    isMixedDeleteMode && selectedParts.has(part.id) && "ring-2 ring-primary"
                  )}>
                    <div className="px-3 py-1 border-b border-purple-200 bg-purple-100/50 dark:bg-purple-900/20">
                      <span className="text-xs font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1">
                        <Zap size={12} />
                        模型深度思考
                      </span>
                    </div>
                    <div className="px-4 py-3 text-xs text-purple-800 dark:text-purple-200 font-mono bg-background/30">
                      <ReactMarkdown components={{ code: CodeBlock }}>
                        {part.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            } else if (part.type === 'thinking') {
              if (isUser) return null;
              return (
                <div key={`${partIndex}-${part.id}`} className="flex items-start gap-2 mt-2">
                  {isMixedDeleteMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePartSelect(part.id);
                      }}
                      className={cn(
                        "w-4 h-4 rounded border-2 flex items-center justify-center transition-all shrink-0 mt-1",
                        selectedParts.has(part.id)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/50 hover:border-primary"
                      )}
                    >
                      {selectedParts.has(part.id) && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      )}
                    </button>
                  )}
                  <div 
                    className={cn(
                      "flex-1 px-4 py-2 sm:px-5 sm:py-2.5 text-sm sm:text-[14px] leading-relaxed shadow-sm bg-purple-50 dark:bg-purple-900/20 rounded-xl",
                      isMixedDeleteMode && selectedParts.has(part.id) && "ring-2 ring-primary"
                    )}
                  >
                    <div className="whitespace-pre-wrap text-purple-800 dark:text-purple-200">
                      <ReactMarkdown components={{ code: CodeBlock }}>
                        {part.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            } else if (part.type === 'action') {
              if (isUser) return null;
              return (
                <div key={`${partIndex}-${part.id}`} className="flex items-start gap-2 mt-2">
                  {isMixedDeleteMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePartSelect(part.id);
                      }}
                      className={cn(
                        "w-4 h-4 rounded border-2 flex items-center justify-center transition-all shrink-0 mt-1",
                        selectedParts.has(part.id)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/50 hover:border-primary"
                      )}
                    >
                      {selectedParts.has(part.id) && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      )}
                    </button>
                  )}
                  <div 
                    className={cn(
                      "flex-1 px-4 py-2 sm:px-5 sm:py-2.5 text-sm sm:text-[14px] leading-relaxed shadow-sm bg-amber-50 dark:bg-amber-900/20 rounded-xl",
                      isMixedDeleteMode && selectedParts.has(part.id) && "ring-2 ring-primary"
                    )}
                  >
                    <div className="whitespace-pre-wrap text-amber-800 dark:text-amber-200">
                      {part.content}
                    </div>
                  </div>
                </div>
              );
            } else if (part.type === 'text') {
              return (
                <div key={`${partIndex}-${part.id}`} className="flex items-start gap-2 mt-2">
                  {isMixedDeleteMode && !isUser && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePartSelect(part.id);
                      }}
                      className={cn(
                        "w-4 h-4 rounded border-2 flex items-center justify-center transition-all shrink-0 mt-1",
                        selectedParts.has(part.id)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/50 hover:border-primary"
                      )}
                    >
                      {selectedParts.has(part.id) && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      )}
                    </button>
                  )}
                  <div 
                    key={`${partIndex}-${part.id}`} 
                    className={cn(
                      "flex-1 px-4 py-3 sm:px-5 sm:py-3.5 text-sm sm:text-[15px] leading-relaxed shadow-sm",
                      isUser ? "message-bubble-user" : "message-bubble-ai",
                      isMixedDeleteMode && !isUser && selectedParts.has(part.id) && "ring-2 ring-primary"
                    )}
                  >
                    {isUser ? (
                      <div className="whitespace-pre-wrap">{part.content}</div>
                    ) : streaming && isLast && partIndex === parts.length - 1 ? (
                      <SmoothOutput content={part.content || " "} streaming={true} />
                    ) : (
                      <div className="markdown-content">
                        <ReactMarkdown components={{ code: CodeBlock }}>
                          {part.content || " "}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return null;
          })
        ) : (
          <div className="flex items-start gap-2 mt-2">
            <div 
              className={cn(
                "flex-1 px-4 py-3 sm:px-5 sm:py-3.5 text-sm sm:text-[15px] leading-relaxed shadow-sm",
                isUser ? "message-bubble-user" : "message-bubble-ai"
              )}
            >
              {isUser ? (
                <div className="whitespace-pre-wrap">{content}</div>
              ) : (
                <div className="markdown-content">
                  <ReactMarkdown components={{ code: CodeBlock }}>
                    {content || " "}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        )}

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
  );
};

/**
 * React.memo 包装：仅在影响渲染的 props 变化时才重新渲染
 * 自定义比较函数跳过回调函数引用比较（行为不变，仅引用变化）
 */
export const Message = React.memo(MessageInner, (prev, next) => {
  // 消息内容与身份
  if (prev.message.id !== next.message.id) return false;
  if (prev.message.content !== next.message.content) return false;
  if (prev.message.role !== next.message.role) return false;
  if (prev.message.model !== next.message.model) return false;

  // 流式与位置状态
  if (prev.streaming !== next.streaming) return false;
  if (prev.isLast !== next.isLast) return false;

  // 选择/删除模式
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.showSelect !== next.showSelect) return false;
  if (prev.isDeleteMode !== next.isDeleteMode) return false;
  if (prev.isMixedDeleteMode !== next.isMixedDeleteMode) return false;

  // 功能状态
  if (prev.compressing !== next.compressing) return false;
  if (prev.showModelReasoning !== next.showModelReasoning) return false;
  if (prev.canRegenerate !== next.canRegenerate) return false;
  if (prev.memoryMode !== next.memoryMode) return false;
  if (prev.tokens !== next.tokens) return false;
  if (prev.isCharacterChat !== next.isCharacterChat) return false;

  // 身份信息
  if (prev.userAvatar !== next.userAvatar) return false;
  if (prev.userName !== next.userName) return false;
  if (prev.messageIndex !== next.messageIndex) return false;

  // 按当前消息检查选中状态（避免整体 Set/Map 引用比较）
  const msgId = String(prev.message.id);
  if (prev.selectedItems?.has(msgId) !== next.selectedItems?.has(msgId)) return false;

  const idx = prev.messageIndex;
  if (idx !== undefined) {
    if (prev.selectedWholeMessages?.has(idx) !== next.selectedWholeMessages?.has(idx)) return false;
    if (prev.selectedMessageParts?.get(idx) !== next.selectedMessageParts?.get(idx)) return false;
  }

  // 记忆统计（引用比较，父组件应保持稳定引用）
  if (prev.memoryStats !== next.memoryStats) return false;

  return true;
});
