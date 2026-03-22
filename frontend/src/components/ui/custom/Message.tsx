import React, { useState } from 'react';
import { Copy, Check, Zap, Database, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ReactMarkdown from 'react-markdown';
import { CodeBlock } from './CodeBlock';
// import { SmoothOutput } from './SmoothOutput';
// import { RpSegmentRenderer } from './RpSegmentRenderer';
// import { TagSegmentRenderer } from './TagSegmentRenderer';
// import { MessageParserService } from '@/services/messageParserService';
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
  characterAvatar?: string;
  characterName?: string;
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
  onSelectAllPartsInMessage,
  isCharacterChat = false,
  characterAvatar,
  characterName,
  memoryMode,
}) => {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  
  const messageModel = models.find(m => m.id === message.model);

  // const segments = useMemo(() => {
  //   return MessageParserService.parseMessage(message.content, {
  //     isCharacterChat,
  //     isUser,
  //     showModelReasoning
  //   });
  // }, [message.content, isCharacterChat, isUser, showModelReasoning]);

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

  return (
    <div 
      className={cn(
        "flex gap-3 items-start group animate-fade-in-up",
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
      <div className={cn("max-w-[82%] md:max-w-[60%] lg:max-w-[55%]", isUser ? "items-end flex" : "items-start flex gap-3")}>
        {!isUser && (
          <div className="w-9 h-9 rounded-2xl overflow-hidden flex-shrink-0">
            {isCharacterChat && characterAvatar ? (
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
          "flex flex-col",
          isUser && "items-end"
        )}>
          <div className={cn(
            "px-5 py-3.5 text-[15px] leading-relaxed",
            isUser 
              ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-3xl rounded-br-lg' 
              : 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white rounded-3xl rounded-bl-lg',
            isMixedDeleteMode && isItemSelected && "ring-2 ring-primary"
          )}>
            {isUser ? (
              <div className="whitespace-pre-wrap">{message.content}</div>
            ) : (
              <div className="markdown-content">
                <ReactMarkdown components={{ code: CodeBlock }}>
                  {message.content || " "}
                </ReactMarkdown>
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
                  {(messageModel as any).alias || messageModel.id?.split('/').pop()}
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
