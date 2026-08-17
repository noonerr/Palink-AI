import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Check, Copy, AlertTriangle } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import DOMPurify from 'dompurify';
import { CharacterCardRenderer, looksLikeSmartCardHtml } from './CharacterCardRenderer';

interface CodeBlockProps {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const ensureHljsLanguages = () => {
  const languageEntries: Array<[string, any]> = [
    ['bash', bash],
    ['sh', bash],
    ['shell', bash],
    ['cpp', cpp],
    ['c++', cpp],
    ['c', cpp],
    ['css', css],
    ['go', go],
    ['java', java],
    ['javascript', javascript],
    ['js', javascript],
    ['json', json],
    ['markdown', markdown],
    ['md', markdown],
    ['plaintext', plaintext],
    ['text', plaintext],
    ['python', python],
    ['py', python],
    ['rust', rust],
    ['rs', rust],
    ['sql', sql],
    ['typescript', typescript],
    ['ts', typescript],
    ['tsx', typescript],
    ['html', xml],
    ['xml', xml],
  ];

  for (const [name, grammar] of languageEntries) {
    if (!hljs.getLanguage(name)) {
      hljs.registerLanguage(name, grammar);
    }
  }
};
ensureHljsLanguages();

const AUTO_HIGHLIGHT_MAX_CHARS = 12000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const CodeBlock = ({ inline, className, children }: CodeBlockProps) => {
  const [copied, setCopied] = useState(false);
  const [mermaidSvg, setMermaidSvg] = useState<string>('');
  const [mermaidError, setMermaidError] = useState<string>('');
  const [mathHtml, setMathHtml] = useState<string>('');
  const mermaidRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const extractPlainText = useCallback((node: React.ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') {
      return String(node);
    }
    if (Array.isArray(node)) {
      return node.map(extractPlainText).join('');
    }
    if (React.isValidElement(node)) {
      return extractPlainText((node.props as { children?: React.ReactNode }).children as React.ReactNode);
    }
    return '';
  }, []);

  const languageMatch = /language-([A-Za-z0-9_+#-]+)/.exec(className || '');
  const language = (languageMatch?.[1] || 'text').toLowerCase();
  const codeString = useMemo(() => extractPlainText(children).replace(/\n$/, ''), [children, extractPlainText]);
  const highlightedCode = useMemo(() => {
    if (!codeString || language === 'mermaid' || ['math', 'latex', 'katex'].includes(language)) {
      return '';
    }

    try {
      if (!hljs.getLanguage('plaintext')) {
        hljs.registerLanguage('plaintext', plaintext);
      }

      if (hljs.getLanguage(language)) {
        return hljs.highlight(codeString, { language }).value;
      }

      if (codeString.length > AUTO_HIGHLIGHT_MAX_CHARS) {
        return escapeHtml(codeString);
      }

      return hljs.highlightAuto(codeString).value;
    } catch {
      return escapeHtml(codeString);
    }
  }, [codeString, language]);

  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    const check = () => setIsOverflowing(pre.scrollWidth > pre.clientWidth + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(pre);
    return () => ro.disconnect();
  }, [highlightedCode]);

  const prevCodeStringRef = useRef('');

  useEffect(() => {
    if (language !== 'mermaid' || !codeString) return;

    if (codeString === prevCodeStringRef.current) return;

    prevCodeStringRef.current = codeString;
    setMermaidSvg('');
    setMermaidError('');
    let cancelled = false;

    const timer = setTimeout(() => {
      const renderMermaid = async () => {
        try {
          const mermaid = (await import('mermaid')).default;
          mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'strict',
            fontFamily: 'inherit',
          });
          const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          const { svg } = await mermaid.render(id, codeString);
          if (cancelled) return;
          setMermaidSvg(DOMPurify.sanitize(svg));
        } catch (error) {
          if (cancelled) return;
          console.error('Mermaid render error:', error);
          setMermaidError(error instanceof Error ? error.message : 'Failed to render diagram');
        }
      };
      renderMermaid();
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [language, codeString]);

  const handleCopy = () => {
    if (codeString) {
      navigator.clipboard.writeText(codeString);
      setCopied(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 2000);
    }
  };

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const isMath = ['math', 'latex', 'katex'].includes(language);
  const isFullHtml = (language === 'html' || language === 'xml') && /<!DOCTYPE\s+html|<html[\s>]/i.test(codeString);
  const looksLikeHtml = /<\s*\/?\s*[a-zA-Z][^>]*>/.test(codeString) && /<\/?\s*(div|span|style|script|body|html|head|section|article|header|footer|nav|main|aside|table|tr|td|th|ul|ol|li|h[1-6]|p|br|hr|img|a|button|form|input|select|option|textarea|label|iframe|svg|canvas|video|audio|source|meta|link|figure|figcaption|details|summary|nav|menu|menuitem)\b/i.test(codeString);
  const knownNonHtmlLanguages = ['css', 'javascript', 'js', 'json', 'python', 'py', 'bash', 'sh', 'shell', 'sql', 'markdown', 'md', 'typescript', 'ts', 'tsx', 'jsx', 'mermaid', 'yaml', 'yml', 'xml', 'rust', 'go', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'kotlin', 'swift', 'r', 'lua', 'perl', 'haskell', 'scala', 'groovy', 'dockerfile', 'makefile', 'ini', 'toml'];
  const isHtmlFragment = language === 'html' || (language === 'text' && looksLikeHtml) || (language === '' && looksLikeHtml) || (!knownNonHtmlLanguages.includes(language) && looksLikeHtml);

  useEffect(() => {
    if (!isMath || !codeString) return;
    let cancelled = false;
    const renderMath = async () => {
      try {
        const katex = await import('katex');
        const html = katex.default.renderToString(codeString, {
          throwOnError: false,
          displayMode: true,
          strict: false,
        });
        if (cancelled) return;
        setMathHtml(DOMPurify.sanitize(html));
      } catch (error) {
        if (cancelled) return;
        setMathHtml('');
      }
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof requestIdleCallback !== 'undefined') {
      idleId = requestIdleCallback(renderMath);
    } else {
      timeoutId = setTimeout(renderMath, 0);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined) cancelIdleCallback(idleId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [isMath, codeString]);

  if (!codeString) return null;

  if (inline) {
    return (
      <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-primary">
        {children}
      </code>
    );
  }

  if (looksLikeSmartCardHtml(codeString)) {
    return (
      <CharacterCardRenderer
        content={codeString}
        mode="auto"
        className="my-4"
      />
    );
  }

  if (isMath) {
    if (!mathHtml) {
      return (
        <div className="math-block my-4 p-4">
          <div className="animate-pulse h-8 bg-muted rounded" />
        </div>
      );
    }
    return (
      <div className="math-block my-4 overflow-x-auto">
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-xs font-medium text-muted-foreground uppercase">
            Mathematics
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? (
              <>
                <Check size={14} className="text-green-500" />
                <span className="text-green-500">Copied</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <div
          className="katex-render px-4 py-3"
          dangerouslySetInnerHTML={{ __html: mathHtml }}
        />
      </div>
    );
  }

  if (language === 'mermaid') {
    return (
      <div className="mermaid-container my-4">
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-xs font-medium text-muted-foreground uppercase">
            Diagram
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? (
              <>
                <Check size={14} className="text-green-500" />
                <span className="text-green-500">Copied</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        {mermaidError ? (
          <div className="p-4 border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20 rounded-lg">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 mb-2">
              <AlertTriangle size={16} />
              <span className="text-sm font-medium">Diagram Render Error</span>
            </div>
            <p className="text-xs text-red-500 dark:text-red-400 mb-2">{mermaidError}</p>
            <pre className="text-sm text-red-700 dark:text-red-300 overflow-x-auto bg-white/50 dark:bg-black/20 p-2 rounded">
              {codeString}
            </pre>
          </div>
        ) : mermaidSvg ? (
          <div
            ref={mermaidRef}
            className="mermaid-svg-wrapper max-h-[70vh] overflow-auto rounded-lg bg-muted/30 p-4"
            dangerouslySetInnerHTML={{ __html: mermaidSvg }}
          />
        ) : (
          <div className="flex items-center justify-center p-8 text-muted-foreground">
            <div className="flex items-center gap-2">
              <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />
              <span className="text-sm">Rendering diagram...</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (isFullHtml || isHtmlFragment) {
    return (
      <CharacterCardRenderer
        content={codeString}
        mode="auto"
        className="my-4"
      />
    );
  }

  return (
    <div className="code-block my-4 group">
      <div className="code-block-header">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {language}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? (
            <>
              <Check size={14} className="text-green-500" />
              <span className="text-green-500">Copied</span>
            </>
          ) : (
            <>
              <Copy size={14} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="relative">
        <pre ref={preRef} className="overflow-x-auto code-block-scroll">
          <code
            className={`${className || ''} hljs font-mono text-sm`}
            dangerouslySetInnerHTML={{ __html: highlightedCode }}
          />
        </pre>
        {isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-6 flex items-center justify-center pointer-events-none bg-gradient-to-t from-black/5 dark:from-white/5 to-transparent">
            <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg>
              横向滚动查看更多
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
