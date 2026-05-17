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
  const [isAnimating, setIsAnimating] = useState(false);
  const rafRef = useRef<number | null>(null);
  const prevContentRef = useRef('');

  useEffect(() => {
    if (!streaming) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDisplayContent(content);
      setIsAnimating(false);
      prevContentRef.current = content;
      return;
    }

    if (content === prevContentRef.current) return;

    setIsAnimating(true);

    const updateContent = () => {
      setDisplayContent(content);
      prevContentRef.current = content;
      rafRef.current = null;
    };

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(updateContent);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [content, streaming]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div className={isAnimating ? 'smooth-output' : 'smooth-output'}>
      <MarkdownRenderer content={displayContent || (streaming ? '' : content)} />
      {streaming && (
        <span className="streaming-cursor" aria-hidden="true" />
      )}
    </div>
  );
};
