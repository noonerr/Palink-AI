import React, { useEffect, useState, useRef } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface SmoothOutputProps {
  content: string;
  streaming?: boolean;
}

export function SmoothOutput({
  content,
  streaming = false
}: SmoothOutputProps) {
  const [displayContent, setDisplayContent] = useState('');
  const rafRef = useRef<number | null>(null);
  const prevContentRef = useRef('');

  useEffect(() => {
    if (!streaming) {
      // Non-streaming: set directly, cancel any pending animation
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDisplayContent(content);
      prevContentRef.current = content;
      return;
    }

    // Streaming: upstream already throttles via RAF, no need for extra buffer
    if (content === prevContentRef.current) return;

    setDisplayContent(content);
    prevContentRef.current = content;
  }, [content, streaming]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div className="smooth-output">
      <MarkdownRenderer content={displayContent || (streaming ? '' : content)} />
      {streaming && (
        <span className="streaming-cursor" aria-hidden="true" />
      )}
    </div>
  );
};
