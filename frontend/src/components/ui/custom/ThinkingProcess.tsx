import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThinkingProcessProps {
  content: string;
  streaming?: boolean;
  t: Record<string, string>;
  messageKey?: string;
}

const thinkingExpandedState = new Map<string, boolean>();

export const ThinkingProcess: React.FC<ThinkingProcessProps> = ({
  content,
  streaming = false,
  t,
  messageKey,
}) => {
  const [isExpanded, setIsExpanded] = useState(() => {
    if (messageKey && thinkingExpandedState.has(messageKey)) {
      return thinkingExpandedState.get(messageKey) ?? true;
    }
    return !!streaming;
  });
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const streamAutoExpandedRef = useRef(false);

  useEffect(() => {
    if (!messageKey) {
      return;
    }
    if (thinkingExpandedState.has(messageKey)) {
      setIsExpanded(thinkingExpandedState.get(messageKey) ?? true);
      return;
    }
    const initial = !!streaming;
    thinkingExpandedState.set(messageKey, initial);
    setIsExpanded(initial);
  }, [messageKey, streaming]);

  useEffect(() => {
    if (streaming && !streamAutoExpandedRef.current) {
      streamAutoExpandedRef.current = true;
      setIsExpanded(true);
      if (messageKey) {
        thinkingExpandedState.set(messageKey, true);
      }
    }

    if (!streaming) {
      streamAutoExpandedRef.current = false;
    }
  }, [streaming, messageKey]);

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
        <span>{t.thinking || 'Thinking'}</span>
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
          {content ? (
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
