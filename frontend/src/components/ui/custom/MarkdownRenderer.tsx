import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { cn } from '@/lib/utils';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  components?: Components;
  renderImage?: (src: string, alt: string) => React.ReactNode;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className,
  components,
  renderImage,
}) => {
  const baseComponents: Components = {
    code: CodeBlock,
    a: ({ node: _node, href, children, ...props }) => (
      <a
        href={typeof href === 'string' ? href : ''}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="break-words underline decoration-border underline-offset-2 transition-colors hover:text-primary"
        {...props}
      >
        {children}
      </a>
    ),
    table: ({ node: _node, children, ...props }) => (
      <div className="markdown-table-wrapper my-3 overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    img: ({ node: _node, src, alt, ...props }) => {
      const imageSrc = typeof src === 'string' ? src : '';
      const imageAlt = typeof alt === 'string' ? alt : 'image';

      if (renderImage) {
        return <>{renderImage(imageSrc, imageAlt)}</>;
      }

      return (
        <img
          src={imageSrc}
          alt={imageAlt}
          className="my-2 max-w-full rounded-xl border border-border/50"
          loading="lazy"
          {...props}
        />
      );
    },
  };

  return (
    <div className={cn('markdown-content', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ ...baseComponents, ...components }}
      >
        {content || ' '}
      </ReactMarkdown>
    </div>
  );
};