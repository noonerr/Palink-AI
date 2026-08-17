import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import DOMPurify from 'dompurify';
import { encodeStyleTags, decodeStyleTags } from '@/lib/sillytavern/formatting';
import { cn } from '@/lib/utils';
import { appendUploadToken } from '@/lib/uploadUrls';
import { CodeBlock } from './CodeBlock';
import { CharacterCardRenderer, looksLikeSmartCardHtml } from './CharacterCardRenderer';

let katexCssLoaded = false;
function ensureKatexCss() {
  if (katexCssLoaded || document.querySelector('link[href="/katex.min.css"]')) {
    katexCssLoaded = true;
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/katex.min.css';
  document.head.appendChild(link);
  katexCssLoaded = true;
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeRaw, rehypeKatex];

const HTML_TAG_PATTERN = /<[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/;
const MARKDOWN_PATTERN = /(```|`[^`\n]+`|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|[*_~]{1,3}[^*_~]+[*_~]{1,3}|\|[^\n]*\||\$\$?)/m;

// 标志保护:避免重复注册 DOMPurify hook
let markdownRendererHookRegistered = false;

if (!markdownRendererHookRegistered) {
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName?.startsWith('on')) {
      data.keepAttr = false;
    }
  });
  markdownRendererHookRegistered = true;
}

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

function isImageUrl(url: string): boolean {
  if (IMAGE_EXT_PATTERN.test(url)) return true;
  try {
    const u = new URL(url);
    if (IMAGE_HOSTING_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) return true;
  } catch {
    // Invalid URL strings are treated as non-image text.
  }
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

    const urlPattern = /(?<![([])(https?:\/\/[^\s<>"')\]]+)/g;
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

function MarkdownContentRenderer({
  content,
  className,
  components,
  renderImage,
}: MarkdownRendererProps) {
  const processedContent = React.useMemo(() => {
    let text = preprocessImageUrls(content);
    if (HTML_TAG_PATTERN.test(text)) {
      const palinkHtmlBlocks: string[] = [];
      let protectedText = text.replace(/<palink-html>([\s\S]*?)<\/palink-html>/g, (match) => {
        palinkHtmlBlocks.push(match);
        return `[[[PALINK_HTML_${palinkHtmlBlocks.length - 1}]]]`;
      });

      const codeBlocks: string[] = [];
      protectedText = protectedText.replace(/(`{3,})[\s\S]*?\n\1/g, (match) => {
        codeBlocks.push(match);
        return `[[[PALINK_CODEBLOCK_${codeBlocks.length - 1}]]]`;
      });

      const inlineCodes: string[] = [];
      protectedText = protectedText.replace(/`[^`\n]+`/g, (m) => {
        inlineCodes.push(m);
        return `[[[PALINK_INLINECODE_${inlineCodes.length - 1}]]]`;
      });

      protectedText = decodeStyleTags(
        String(DOMPurify.sanitize(encodeStyleTags(protectedText), {
          MESSAGE_SANITIZE: true,
          ADD_TAGS: ['style', 'div', 'span', 'font', 'center', 'marquee', 'hr', 'br', 'details', 'summary', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'figure', 'figcaption', 'progress', 'meter'],
          ADD_ATTR: ['class', 'style', 'color', 'bgcolor', 'align', 'valign', 'data-*', 'role', 'aria-*', 'tabindex', 'placeholder', 'disabled', 'readonly', 'contenteditable', 'hidden', 'type', 'value', 'name', 'for', 'label', 'selected', 'checked', 'multiple', 'cols', 'rows', 'wrap', 'maxlength', 'min', 'max', 'step', 'optimum', 'open'],
          uponSanitizeElement: (node: any, data: any) => {
            if (data.tagName === 'style') {
              const content = node.textContent || '';
              // 未闭合的 <style> 标签会吞掉后续 HTML 内容,检测到 HTML 标签则移除
              if (/<\/[a-zA-Z][^>]*>/.test(content)) {
                node.parentNode?.removeChild(node);
              }
            }
          },
        } as any)),
        { prefix: '.markdown-content ' }
      );

      protectedText = protectedText.replace(/\[\[\[PALINK_INLINECODE_(\d+)\]\]\]/g, (_, idx) => inlineCodes[parseInt(idx)]);
      protectedText = protectedText.replace(/\[\[\[PALINK_CODEBLOCK_(\d+)\]\]\]/g, (_, idx) => codeBlocks[parseInt(idx)]);
      protectedText = protectedText.replace(/\[\[\[PALINK_HTML_(\d+)\]\]\]/g, (_, idx) => palinkHtmlBlocks[parseInt(idx)]);
      text = protectedText;
    }
    return text;
  }, [content]);

  const baseComponents: Components = React.useMemo(() => ({
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
    table: ({ children, ...props }) => (
      <div className="markdown-table-wrapper my-3 overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    thead: ({ children, ...props }) => {
      const allThEmpty = React.Children.toArray(children).every((child: any) => {
        const trChildren = child?.props?.children;
        if (!Array.isArray(trChildren)) return true;
        return trChildren.every((th: any) => {
          const text = typeof th?.props?.children === 'string'
            ? th.props.children
            : Array.isArray(th?.props?.children)
              ? th.props.children.join('')
              : '';
          return text.trim() === '';
        });
      });
      if (allThEmpty) return null;
      return <thead {...props}>{children}</thead>;
    },
    td: ({ children, ...props }) => {
      const text = React.Children.toArray(children).join('');
      const isStatusCell = ['🧥', '💖', '🎬', '💭', '🎯', '📍'].some(e => text.includes(e));
      if (isStatusCell) {
        return <td data-character-status {...props}>{children}</td>;
      }
      return <td {...props}>{children}</td>;
    },
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
            const hasFallback = parent
              ? Array.from(parent.querySelectorAll<HTMLAnchorElement>('a[data-palink-image-fallback="true"]'))
                  .some((link) => link.getAttribute('href') === imageSrc)
              : false;
            if (parent && !hasFallback) {
              const fallback = document.createElement('a');
              fallback.href = imageSrc;
              fallback.target = '_blank';
              fallback.rel = 'noopener noreferrer nofollow';
              fallback.dataset.palinkImageFallback = 'true';
              fallback.textContent = rawSrc;
              fallback.className = 'break-words underline decoration-border underline-offset-2 transition-colors hover:text-primary text-purple-700 dark:text-purple-300 italic';
              parent.appendChild(fallback);
            }
          }}
          {...props}
        />
      );
    },
  }), [renderImage]);

  const mergedComponents = React.useMemo(() => ({ ...baseComponents, ...components }), [baseComponents, components]);

  ensureKatexCss();

  return (
    <div className={cn('markdown-content w-full break-words overflow-wrap-anywhere', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={mergedComponents}
      >
        {processedContent || ' '}
      </ReactMarkdown>
    </div>
  );
}

function shouldUseMarkdownPipeline(text: string): boolean {
  if (!text) return false;
  return HTML_TAG_PATTERN.test(text) || MARKDOWN_PATTERN.test(text) || isImageUrl(text.trim());
}

function PlainTextContent({ content, className }: Pick<MarkdownRendererProps, 'content' | 'className'>) {
  return (
    <div className={cn('markdown-content w-full break-words overflow-wrap-anywhere whitespace-pre-wrap', className)}>
      {content || ' '}
    </div>
  );
}

function MarkdownRendererInner(props: MarkdownRendererProps) {
  if (looksLikeSmartCardHtml(props.content)) {
    return (
      <CharacterCardRenderer
        content={props.content}
        className={props.className}
        mode="auto"
      />
    );
  }

  if (!props.components && !props.renderImage && !shouldUseMarkdownPipeline(props.content)) {
    return <PlainTextContent content={props.content} className={props.className} />;
  }

  return <MarkdownContentRenderer {...props} />;
}

export const MarkdownRenderer = React.memo(MarkdownRendererInner);
