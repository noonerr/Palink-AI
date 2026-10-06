import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CharacterCardRenderer, looksLikeSmartCardHtml } from './CharacterCardRenderer';

interface ThinkingProcessProps {
  content: string;
  streaming?: boolean;
  /** [P4 2026-10-06] 思考已结束（正文开始输出）：需求④⑤的收合触发信号，由 Message 侧计算 */
  reasoningEnded?: boolean;
  t: Record<string, string>;
  messageKey?: string;
}

const thinkingExpandedState = new Map<string, boolean>();

export function ThinkingProcess({
  content,
  streaming = false,
  reasoningEnded = false,
  t,
  messageKey,
}: ThinkingProcessProps) {
  // [P4 2026-10-06] 思考框默认折叠（需求①）：不再随流式自动展开。用户手动开合经
  // thinkingExpandedState 按消息记忆；流式结束时的收合策略见下方 transition effect。
  const [isExpanded, setIsExpanded] = useState(() => {
    if (messageKey && thinkingExpandedState.has(messageKey)) {
      return thinkingExpandedState.get(messageKey) ?? false;
    }
    return false;
  });
  // [P4 2026-10-06] 「已思考 X 秒」计时（需求②）：流式期间逐秒走表让用户感知模型仍在
  // 运行，思考结束后冻结在总耗时；历史消息（挂载即 streaming=false）无计时数据，回退旧标题。
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!messageKey) {
      return;
    }
    if (thinkingExpandedState.has(messageKey)) {
      setIsExpanded(thinkingExpandedState.get(messageKey) ?? false);
    }
  }, [messageKey]);

  // [P4 2026-10-06] 计时器：streaming=true 期间每秒走表；结束后 interval 清理、读数冻结。
  useEffect(() => {
    if (!streaming) {
      return undefined;
    }
    if (startedAtRef.current == null) {
      startedAtRef.current = Date.now();
    }
    setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current ?? Date.now();
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  // [P4 2026-10-06] 收合策略（需求④⑤）：折叠着的在思考结束点保持折叠，展开着的自动折叠。
  // 「思考结束」的正确信号是 reasoningEnded（streaming 期间正文首 chunk 到达，Message 侧计算），
  // 而非 streaming 翻转——isGenerating 在整轮生成期间恒为 true，思考结束、正文开始时它并不
  // 翻转，按 streaming 翻转判定会拖到整轮结束才收合（需求⑤实际不成立的根因，排查报告 §4.3）。
  // 自动折叠只在转变点发生一次；此后用户手动展开的不再被自动收起（需求③用户主动点击才展开）。
  const prevReasoningEndedRef = useRef(false);
  useEffect(() => {
    const wasEnded = prevReasoningEndedRef.current;
    prevReasoningEndedRef.current = reasoningEnded;
    if (!wasEnded && reasoningEnded && isExpanded) {
      setIsExpanded(false);
      if (messageKey) {
        thinkingExpandedState.set(messageKey, false);
      }
    }
  }, [reasoningEnded, isExpanded, messageKey]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    let rafId: number | null = null;
    const updateHeight = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        const nextHeight = node.scrollHeight;
        setMeasuredHeight((prev) => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev));
        rafId = null;
      });
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);

    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [content]);

  const toggleExpand = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      if (messageKey) {
        thinkingExpandedState.set(messageKey, next);
      }
      return next;
    });
  }, [messageKey]);

  const showContent = !!content || streaming;

  if (!showContent) return null;

  const effectiveHeight = isExpanded ? measuredHeight : 0;
  const transitionStyle = isExpanded && streaming
    ? 'opacity 350ms ease, transform 400ms cubic-bezier(0.22, 0.85, 0.24, 1)'
    : 'max-height 450ms cubic-bezier(0.22, 0.85, 0.24, 1), opacity 350ms ease, transform 450ms cubic-bezier(0.22, 0.85, 0.24, 1)';

  return (
    <div className="mb-3 overflow-hidden animate-fade-in-up">
      <button
        onClick={toggleExpand}
        className={cn(
          "w-full flex items-center gap-2 px-4 py-2 text-xs font-medium",
          "rounded-xl border border-border/40 bg-muted/20 dark:bg-muted/10",
          "text-muted-foreground hover:bg-muted/30 dark:hover:bg-muted/20",
          "transition-colors duration-200"
        )}
      >
        <Brain
          size={14}
          className={cn(
            streaming && "animate-pulse text-primary"
          )}
        />
        <span>
          {(streaming || elapsedSeconds > 0)
            ? `已思考 ${elapsedSeconds} 秒`
            : (t.thinking || 'Thinking')}
        </span>
        {(content || !streaming) && (
          <span className="ml-1">
            <ChevronDown
              size={14}
              className={cn(
                'transition-transform duration-300 ease-in-out',
                isExpanded && 'rotate-180'
              )}
            />
          </span>
        )}
        {streaming && !content && (
          <span className="ml-auto">
            <span className="inline-flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></span>
              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></span>
              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></span>
            </span>
          </span>
        )}
      </button>

      <div
        className={cn(
          "overflow-hidden will-change-[max-height,opacity]",
          isExpanded ? "opacity-100" : "opacity-0"
        )}
        style={{
          maxHeight: isExpanded ? `${effectiveHeight}px` : '0px',
          transition: transitionStyle,
          transform: isExpanded ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.985)',
          transformOrigin: 'top center',
          WebkitBackfaceVisibility: 'hidden',
          backfaceVisibility: 'hidden',
          WebkitTransform: 'translateZ(0)',
          perspective: '1000px'
        }}
      >
        <div
          ref={contentRef}
          className={cn(
            "mt-1.5 px-4 py-3 text-xs text-muted-foreground font-mono leading-relaxed",
            "rounded-xl border border-border/30 bg-muted/10 dark:bg-muted/5",
            "backdrop-blur-sm"
          )}
        >
          {content && looksLikeSmartCardHtml(content) ? (
            <CharacterCardRenderer content={content} mode="auto" />
          ) : content ? (
            <MarkdownRenderer content={content} />
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground/60">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse" style={{ animationDelay: '0ms', animationDuration: '1s' }}></span>
                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse" style={{ animationDelay: '200ms', animationDuration: '1s' }}></span>
                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse" style={{ animationDelay: '400ms', animationDuration: '1s' }}></span>
              </div>
              <span>正在思考...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
