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

const IMAGE_HOSTING_DOMAINS = [
  'imageshack.us', 'imageshack.com',
  'i.imgur.com', 'imgur.com',
  'postimg.cc', 'i.postimg.cc',
  'image.ibb.co', 'ibb.co',
  'i.redd.it', 'preview.redd.it',
  'cdn.discordapp.com', 'media.discordapp.net',
  'pbs.twimg.com',
  'i.pinimg.com',
];

const IMAGE_EXT_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)(?:\?[^\s]*)?(?=[\s)\]}>]|$)/i;

function appendUploadToken(url: string): string {
  if (!url) return url;
  if (url.startsWith('/api/uploads/') || url.startsWith('/uploads/')) {
    const token = localStorage.getItem('palink_token');
    if (token) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}token=${encodeURIComponent(token)}`;
    }
  }
  return url;
}

function isImageUrl(url: string): boolean {
  if (IMAGE_EXT_PATTERN.test(url)) return true;
  try {
    const u = new URL(url);
    if (IMAGE_HOSTING_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) return true;
  } catch {}
  return false;
}

function preprocessImageUrls(text: string): string {
  const lines = text.split('\n');
  const processed = lines.map(line => {
    const existingImageRefs: string[] = [];
    const imgRefPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = imgRefPattern.exec(line)) !== null) {
      existingImageRefs.push(m[1]);
    }

    const urlPattern = /(?<![(\[])(https?:\/\/[^\s<>\"')\]]+)/g;
    return line.replace(urlPattern, (url) => {
      if (existingImageRefs.includes(url)) return url;
      if (isImageUrl(url)) {
        return `![image](${url})`;
      }
      return url;
    });
  });
  return processed.join('\n');
}

export function MarkdownRenderer({
  content,
  className,
  components,
  renderImage,
}: MarkdownRendererProps) {
  const processedContent = React.useMemo(() => preprocessImageUrls(content), [content]);

  const baseComponents: Components = {
    code: CodeBlock,
    p: ({ children, ...props }) => (
      <p className="break-words overflow-wrap-anywhere" {...props}>{children}</p>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      const safeHref = typeof href === 'string' ? appendUploadToken(href) : '';
      return (
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="break-words underline decoration-border underline-offset-2 transition-colors hover:text-primary"
          {...props}
        >
          {children}
        </a>
      );
    },
    table: ({ node: _node, children, ...props }) => (
      <div className="markdown-table-wrapper my-3 overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    img: ({ node: _node, src, alt, ...props }) => {
      const rawSrc = typeof src === 'string' ? src : '';
      const imageSrc = appendUploadToken(rawSrc);
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
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            const parent = target.parentElement;
            if (parent && !parent.querySelector(`a[href="${imageSrc}"]`)) {
              const fallback = document.createElement('a');
              fallback.href = imageSrc;
              fallback.target = '_blank';
              fallback.rel = 'noopener noreferrer nofollow';
              fallback.textContent = rawSrc;
              fallback.className = 'break-words underline decoration-border underline-offset-2 transition-colors hover:text-primary text-purple-700 dark:text-purple-300 italic';
              parent.appendChild(fallback);
            }
          }}
          {...props}
        />
      );
    },
  };

  return (
    <div className={cn('markdown-content w-full break-words overflow-wrap-anywhere', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ ...baseComponents, ...components }}
      >
        {processedContent || ' '}
      </ReactMarkdown>
    </div>
  );
};
