/**
 * 智能卡「完全内联渲染」容器（PoC，受 inline-flags 开关控制，默认关闭）。
 *
 * 与 CharacterCardRenderer(iframe) 并存，一行旧代码未删，可随时切回。
 *
 * ── 如何避免上次回滚的 NotFoundError ────────────────────────────────────
 * primitives.ts L637-640 记录了历史事故：inline-html 路径导致
 * "NotFoundError: Failed to execute 'insertBefore'/'removeChild' on 'Node'"。
 * 根因是 React 认为自己拥有该子树，而卡片脚本在运行时增删了 DOM 节点，
 * 下一次 reconcile 时 React 拿着失效的引用去 removeChild，直接崩栈。
 *
 * 本组件用「React 逃逸区」根治：
 *   1) 宿主 div 始终携带一个**内容恒为空串**的 dangerouslySetInnerHTML。
 *      React 见到 dangerouslySetInnerHTML 就完全放弃对该节点子树的 diff；
 *      且前后都是 ''，React 不会真的去写 DOM。
 *   2) 真实内容由 useLayoutEffect 通过 ref 手写 innerHTML —— React 全程不知情。
 *   3) 卸载时 React 只移除宿主 div 本身（整棵子树跟着走），
 *      不会逐个 removeChild 那些它没创建过的节点。
 * 这样脚本可以任意改写 DOM，React 与之彻底解耦。
 *
 * ── 两个 effect 必须分开 ─────────────────────────────────────────────────
 * effect A（内容变化）：重写 innerHTML + 重放脚本
 * effect B（变量变化）：只刷新 ST 变量并广播事件，**绝不碰 DOM**
 * 合成一个的话，每次变量更新都会擦掉卡片 DOM、丢失卡片内部状态，
 * 而指纹守卫又会跳过脚本重放，结果就是卡片变成一具空壳。
 */

import React, { Component, useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { CharacterSmartCardContext } from '@/types';
import type { SmartCardAction } from './smart-card-runtime/shared';
import {
  extractHtmlRenderParts,
  getHtmlRenderSignature,
  hashSmartCardSource,
} from './smart-card-runtime/helpers';
import { prepareInlineCard } from './smart-card-runtime/inline/inline-sanitize';
import {
  replayInlineCardScripts,
  resetInlineCardReplayState,
} from './smart-card-runtime/inline/inline-script-replay';
import {
  beginInlineCardScriptScope,
  cleanupInlineCardListeners,
  endInlineCardScriptScope,
  ensureInlineStGlobals,
  exportInlineCardVariables,
  importInlineCardVariables,
  setInlineStVariables,
} from './smart-card-runtime/inline/inline-st-globals';
import {
  registerInlineHostCapabilities,
  unregisterInlineHostCapabilitiesByCard,
} from './smart-card-runtime/inline/inline-host-registry';

/**
 * 错误边界：内联渲染把卡片脚本直接跑在主页面全局，任何未捕获异常都会向上冒泡到
 * React 根导致整页崩溃（黑屏）。用边界把故障限制在单张卡内——渲染失败就退化为
 * 纯文本，绝不拖垮整页。这是桌面端（甚至 flag 已开）的最后一道保险。
 */
class InlineCardErrorBoundary extends Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.warn('[inline-card] 单卡渲染崩溃，已隔离（不影响整页）：', error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="palink-inline-card-error text-sm text-red-500 p-2 border border-red-300 rounded">
          卡片内联渲染失败，已降级为文本。请关闭内联渲染开关或刷新页面。
        </div>
      );
    }
    return this.props.children;
  }
}


/** 恒定空内容：React 靠它放弃子树 diff，且前后相等不触发真实写入。 */
const REACT_ESCAPE_HATCH = { __html: '' } as const;

export interface InlineCardRendererProps {
  content: string;
  className?: string;
  context?: CharacterSmartCardContext;
  onAction?: (action: SmartCardAction) => void;
  renderRemaining?: (remaining: string) => React.ReactNode;
}

interface InlineCardHostProps {
  html: string;
  cardId: string;
  context?: CharacterSmartCardContext;
  onAction?: (action: SmartCardAction) => void;
}

function InlineCardHost({ html, cardId, context, onAction }: InlineCardHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  const prepared = useMemo(() => prepareInlineCard(html, cardId), [html, cardId]);
  const fingerprint = useMemo(() => hashSmartCardSource(prepared.html), [prepared.html]);
  // 跨路径存储命名空间指纹：必须与 iframe 路径一致（iframe = hash(原始html + '\n' + customCss)，
  // customCss 恒空），否则内联↔iframe 切换时读不到同一份 bucket 数据。
  const storageFingerprint = useMemo(() => hashSmartCardSource(`${html}\n`), [html]);
  const variables = context?.variables;

  // context 对象随每条消息变量更新而变化；effect A 只关心 characterId/sessionId，
  // 用 ref 读取以免 context 变化触发重写 DOM（丢失卡片内部状态）。
  const contextRef = useRef(context);
  contextRef.current = context;

  // effect A：内容变化才动 DOM
  useLayoutEffect(() => {
    try {
      ensureInlineStGlobals();

      // 内联卡挂载：从公共 bucket 导入该卡在 iframe 路径写入的变量（后端变量优先，只补缺）
      importInlineCardVariables(contextRef.current?.characterId, contextRef.current?.sessionId, storageFingerprint);

      if (onAction) {
        // 卡片脚本跑在主页面全局里，调用 sendMessage 时无法回溯是哪张卡触发的。
        // ST 本身也是单一全局上下文，故这里映射到会话级回调即可（最后挂载者生效）。
        registerInlineHostCapabilities({
          sendMessage: (content) => onAction({ type: 'send-message', payload: content } as unknown as SmartCardAction),
          sendMessageAsUser: (content) => onAction({ type: 'send-user-message', payload: content } as unknown as SmartCardAction),
          setChatMessage: (content) => onAction({ type: 'set-message', payload: content } as unknown as SmartCardAction),
          triggerGeneration: () => onAction({ type: 'trigger-generation' } as unknown as SmartCardAction),
          reportError: (message) => console.warn('[inline-card] 卡片上报错误:', message),
        }, cardId);
      }

      const host = hostRef.current;
      if (!host) return;

      // 手写 innerHTML —— React 对此完全无感（见文件头说明）
      host.innerHTML = prepared.html;
      // innerHTML 只清子节点，宿主自身的指纹属性还在，必须显式清掉才会重放
      resetInlineCardReplayState(host);
      // 脚本重放期间标记卡片作用域：脚本同步注册的 document/window/eventSource 监听
      // 按 cardId 记录，卸载时统一注销（防幽灵监听误伤新卡）
      beginInlineCardScriptScope(cardId);
      try {
        replayInlineCardScripts(host, prepared.scripts, fingerprint);
      } finally {
        endInlineCardScriptScope();
      }
    } catch (error) {
      // 任何异常只影响本卡：记日志 + 抛出交由边界捕获降级，绝不冒泡到 React 根
      console.warn('[inline-card] 内联渲染失败（已隔离）: ', error);
      throw error;
    }

    return () => {
      // 卸载清理：跨路径状态迁移 + 幽灵监听/宿主能力注销
      try {
        // 1) 变量导出到公共 bucket——该卡切到 iframe 时经 persistedStorage 注入读回
        exportInlineCardVariables(contextRef.current?.characterId, contextRef.current?.sessionId, storageFingerprint);
        // 2) 注销该卡脚本注册的全局监听（document/window/eventSource）
        cleanupInlineCardListeners(cardId);
        // 3) 注销该卡注册的宿主能力（仅删本卡注册过的 key）
        unregisterInlineHostCapabilitiesByCard(cardId);
      } catch {
        /* 卸载清理异常不影响 React 卸载 */
      }
    };
  }, [prepared, fingerprint, storageFingerprint, cardId, onAction]);

  // effect B：变量变化只广播，不碰 DOM
  useLayoutEffect(() => {
    setInlineStVariables(variables);
  }, [variables]);

  return (
    <div
      ref={hostRef}
      className="palink-inline-card w-full"
      data-palink-inline-card={cardId}
      // position:relative 让卡片内 position:absolute 的遮罩（lightbox 等）
      // 相对卡片容器定位，而不是相对整页——配合 CSS 轻保护防全屏盖板。
      style={{ position: 'relative' }}
      dangerouslySetInnerHTML={REACT_ESCAPE_HATCH}
    />
  );
}

const InlineCardHostMemo = React.memo(InlineCardHost);

function InlineCardRendererInner({
  content,
  className,
  context,
  onAction,
  renderRemaining,
}: InlineCardRendererProps) {
  const renderParts = useMemo(() => extractHtmlRenderParts(content), [content]);
  const messageId = context?.messageId ? String(context.messageId) : 'msg';

  if (!renderParts) {
    return (
      <div className={cn('markdown-content w-full whitespace-pre-wrap break-words', className)}>
        {content}
      </div>
    );
  }

  // 去重逻辑与 CharacterCardRendererInner L1321-1352 保持一致：
  // 同一签名只保留最后一次出现，避免流式过程中的中间态卡片重复渲染。
  const signatureLastIndex = new Map<string, number>();
  renderParts.forEach((part, index) => {
    if (part.type === 'html') signatureLastIndex.set(getHtmlRenderSignature(part.content), index);
  });
  const seenHtml = new Set<string>();

  return (
    <div
      className={cn('character-card-renderer markdown-content mes_text w-full break-words', className)}
      data-palink-smart-card="true"
      data-palink-render-path="inline"
    >
      {renderParts.map((part, index) => {
        if (part.type === 'markdown') {
          return renderRemaining ? (
            <React.Fragment key={`markdown-${index}`}>{renderRemaining(part.content)}</React.Fragment>
          ) : (
            <div key={`markdown-${index}`} className="w-full whitespace-pre-wrap break-words">
              {part.content}
            </div>
          );
        }

        const html = part.content;
        const signature = getHtmlRenderSignature(html);
        if (signatureLastIndex.get(signature) !== index) return null;
        const htmlKey = html.trim().replace(/\s+/g, ' ');
        if (!htmlKey || seenHtml.has(htmlKey)) return null;
        seenHtml.add(htmlKey);

        return (
          <InlineCardErrorBoundary key={`html-${index}`}>
            <InlineCardHostMemo
              html={html}
              cardId={`${messageId}-${index}`}
              context={context}
              onAction={onAction}
            />
          </InlineCardErrorBoundary>
        );
      })}
    </div>
  );
}

export const InlineCardRenderer = React.memo(InlineCardRendererInner);
export default InlineCardRenderer;
