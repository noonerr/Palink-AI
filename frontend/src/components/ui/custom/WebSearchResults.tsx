import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Globe, ExternalLink, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

interface WebSearchResultsProps {
  query: string;
  results: WebSearchResult[];
  messageId?: string | number;
}

export function WebSearchResults({ query, results, messageId }: WebSearchResultsProps) {
  const [expanded, setExpanded] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(false);
  }, [messageId]);

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
  }, [results]);

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  if (!results || results.length === 0) return null;

  const effectiveHeight = expanded ? measuredHeight : 0;

  return (
    <div className="mb-2 px-5 py-3 bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200/50 dark:border-emerald-800/50 rounded-3xl rounded-bl-lg w-full max-w-full overflow-hidden">
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleExpand();
        }}
        className="w-full flex items-center justify-between gap-2 hover:opacity-80 transition-opacity"
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <Globe size={14} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">网络搜索</span>
          <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70 truncate max-w-[200px]">
            {query}
          </span>
          <span className="text-[10px] text-emerald-600/50 dark:text-emerald-400/50">
            ({results.length} 条结果)
          </span>
        </div>
        <ChevronDown
          size={14}
          className={cn(
            'text-emerald-600 dark:text-emerald-400 shrink-0 transition-transform duration-300 ease-in-out',
            expanded && 'rotate-180'
          )}
        />
      </button>

      <div
        className={cn(
          "overflow-hidden will-change-[max-height,opacity]",
          expanded ? "opacity-100" : "opacity-0"
        )}
        style={{
          maxHeight: expanded ? `${effectiveHeight}px` : '0px',
          transition: 'max-height 450ms cubic-bezier(0.22, 0.85, 0.24, 1), opacity 350ms ease, transform 450ms cubic-bezier(0.22, 0.85, 0.24, 1)',
          transform: expanded ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.985)',
          transformOrigin: 'top center',
          WebkitBackfaceVisibility: 'hidden',
          backfaceVisibility: 'hidden',
          WebkitTransform: 'translateZ(0)',
          perspective: '1000px'
        }}
      >
        <div
          ref={contentRef}
          className="mt-2 space-y-1.5 min-w-0"
        >
          {results.map((r, i) => (
            <a
              key={i}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group block rounded-lg bg-white/60 dark:bg-white/5 px-3 py-2 hover:bg-white dark:hover:bg-white/10 transition-all border border-transparent hover:border-emerald-200 dark:hover:border-emerald-800"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-emerald-600/60 dark:text-emerald-400/60 shrink-0 mt-0.5 font-medium">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-1.5">
                    <div className="text-xs font-medium text-slate-900 dark:text-slate-100 leading-tight group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors line-clamp-2 flex-1">
                      {r.title}
                    </div>
                    <ExternalLink size={10} className="shrink-0 mt-0.5 text-emerald-600/50 dark:text-emerald-400/50 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors" />
                  </div>
                  {r.snippet && (
                    <div className="text-[10px] text-slate-600 dark:text-slate-400 leading-snug mt-1 line-clamp-2">
                      {r.snippet}
                    </div>
                  )}
                  <div className="text-[9px] text-emerald-600/60 dark:text-emerald-400/60 mt-1 truncate font-mono">
                    {new URL(r.url).hostname}
                  </div>
                </div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
};
