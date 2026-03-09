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
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef<number>(0);

  useEffect(() => {
    if (streaming && content) {
      setIsExpanded(true);
    }
  }, [streaming, content]);

  const measureHeight = useCallback(() => {
    if (contentRef.current) {
      heightRef.current = contentRef.current.scrollHeight;
    }
  }, []);

  const toggleExpand = useCallback(() => {
    if (!isExpanded) {
      measureHeight();
    }
    setIsExpanded(!isExpanded);
  }, [isExpanded, measureHeight]);

  useEffect(() => {
    if (isExpanded) {
      measureHeight();
    }
  }, [content, isExpanded, measureHeight]);

  if (!content) return null;

  return (
    <div className="mb-4 rounded-xl border border-border/50 bg-muted/50 overflow-hidden">
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
        <span className="ml-auto transition-transform duration-300 ease-in-out">
          {isExpanded ? (
            <ChevronUp size={14} />
          ) : (
            <ChevronDown size={14} />
          )}
        </span>
      </button>
      
      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-in-out",
          isExpanded ? "opacity-100" : "opacity-0"
        )}
        style={{
          maxHeight: isExpanded ? `${heightRef.current}px` : '0px',
          transition: 'max-height 300ms ease-in-out, opacity 300ms ease-in-out'
        }}
      >
        <div 
          ref={contentRef}
          className="px-4 py-3 text-xs text-muted-foreground font-mono border-t border-border/50 bg-background/50"
        >
          <ReactMarkdown components={{ code: CodeBlock }}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
};
