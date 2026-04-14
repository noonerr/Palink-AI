import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { CodeBlock } from './CodeBlock';

interface ThinkingProcessProps {
  content: string;
  streaming?: boolean;
  t: Record<string, string>;
}

export const ThinkingProcess: React.FC<ThinkingProcessProps> = ({ 
  content, 
  streaming = false,
  t 
}) => {
  const [isExpanded, setIsExpanded] = useState(() => !!streaming);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streaming && content && !isExpanded) {
      setIsExpanded(true);
    }
  }, [streaming, content, isExpanded]);

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
    setIsExpanded(prev => !prev);
  }, []);

  const showContent = (streaming && !content) || !!content;

  if (!showContent) return null;

  const effectiveHeight = isExpanded ? measuredHeight : 0;
  const transitionStyle = isExpanded && streaming
    ? 'opacity 180ms ease-in-out'
    : 'max-height 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 250ms ease-in-out';

  return (
    <div className="mb-3 rounded-xl border border-border/50 bg-muted/50 overflow-hidden animate-fade-in-up">
      <button
        onClick={toggleExpand}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
      >
        <Brain 
          size={14} 
          className={cn(
            streaming && "animate-pulse text-primary"
          )} 
        />
        <span>{t.thinking || 'Thinking'}</span>
        {(content || !streaming) && (
          <span className="ml-auto transition-transform duration-300 ease-in-out">
            {isExpanded ? (
              <ChevronUp size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
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
          WebkitBackfaceVisibility: 'hidden',
          backfaceVisibility: 'hidden',
          WebkitTransform: 'translateZ(0)',
          transform: 'translateZ(0)'
        }}
      >
        <div 
          ref={contentRef}
          className="px-4 py-3 text-xs text-muted-foreground font-mono border-t border-border/50 bg-background/50"
        >
          {content ? (
            <ReactMarkdown components={{ code: CodeBlock }}>
              {content}
            </ReactMarkdown>
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
