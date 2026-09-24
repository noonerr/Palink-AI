/**
 * [P1.4] 消息配图渲染组件（pending / ready / failed 三态 + 多图切换 + 点击放大）。
 *
 * 输入是消息 `extra.media` 的数组（服务端权威快照），组件**不关心是谁写的**：
 * 第一方「为这条消息配图」与 ST 出图插件写的是同一份数据，所以两边共用这一套
 * 渲染（D2：一个渲染组件，两个消费方）。
 *
 * 三条硬要求：
 * 1. **骨架必须预留与最终图相同的宽高比**（防 CLS）：pending 与 ready 用同一个
 *    比例盒子，只有内部内容不同；
 * 2. **超时收敛**：`pending` 超过阈值在渲染期判为 failed（对齐后端
 *    `effective_media_status`），刷新/断线留下的悬挂占位不会永远转圈；
 * 3. **图片走 N-7 短令牌链路**（`AsyncUploadImg`）：生成图也在 `/api/uploads/`
 *    下，直连 `<img src>` 会 401。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  effectiveMediaStatus,
  isPendingTimedOut,
  type MediaItem,
  type MediaStatus,
} from '@/lib/messageMedia';
import { AsyncUploadImg, FullscreenImageViewer } from './ImageViewer';

interface MessageMediaProps {
  media: MediaItem[];
  /** 当前展示项（对齐 ST 的 `media_index`）。本地状态优先，不回写数据库。 */
  mediaIndex?: number;
  /** 失败重试：带上该条 media 的 id，服务端会原位复位同一项。 */
  onRetry?: (mediaId: string) => void;
  isCharacterChat?: boolean;
}

/** 比例盒子的高度上限：宽图不至于撑满屏幕，同时保持 pending/ready 同高。 */
const MAX_BOX_HEIGHT = 420;

function aspectBoxStyle(item: MediaItem): React.CSSProperties {
  return {
    aspectRatio: `${item.width} / ${item.height}`,
    maxHeight: MAX_BOX_HEIGHT,
  };
}

function elapsedSeconds(item: MediaItem, now: number): number {
  if (!item.created_at) return 0;
  const created = Date.parse(item.created_at);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((now - created) / 1000));
}

export function MessageMedia({ media, mediaIndex = 0, onRetry, isCharacterChat }: MessageMediaProps) {
  const [index, setIndex] = useState(mediaIndex);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);

  // 只在这条消息还有 pending 时才跑秒表：定时器的唯一消费者是「已等待 N 秒」，
  // 同时兼做超时判定——到点即渲染为 failed（不写库，见 messageMedia.ts）。
  const hasPending = useMemo(() => media.some((item) => item.status === 'pending'), [media]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasPending) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasPending]);

  // 数组长度变化时调整当前项：
  // - 变长（新配了一张图）→ 跳到最新的那条：用户刚点完「配图」，要看到的就是它
  //   （服务端 media_index 恒为 0，展示位置由前端本地决定）；
  // - 变短（删除）→ 夹紧下标，避免停在已不存在的项上。
  const lastLengthRef = useRef(media.length);
  useEffect(() => {
    const previousLength = lastLengthRef.current;
    if (previousLength === media.length) return;
    lastLengthRef.current = media.length;
    if (media.length > previousLength) {
      setIndex(media.length - 1);
      return;
    }
    setIndex((prev) => (media.length > 0 ? Math.min(Math.max(prev, 0), media.length - 1) : 0));
  }, [media.length]);

  /** 夹紧后的安全下标（长度瞬时变化的那一帧也不越界）。 */
  const safeIndex = media.length > 0 ? Math.min(Math.max(index, 0), media.length - 1) : 0;
  const current = media[safeIndex];
  const status: MediaStatus = current ? effectiveMediaStatus(current, now) : 'pending';
  const timedOut = current ? isPendingTimedOut(current, now) : false;

  const step = useCallback(
    (delta: number) => {
      setIndex((prev) => {
        if (media.length === 0) return 0;
        return (prev + delta + media.length) % media.length;
      });
    },
    [media.length],
  );

  const handleRetry = useCallback(() => {
    if (current && onRetry) onRetry(current.id);
  }, [current, onRetry]);

  const readyItems = useMemo(
    () => media.filter((item) => item.status === 'ready' && item.url).map((item) => ({ url: item.url as string })),
    [media],
  );

  if (!current) return null;

  return (
    <div className="mt-2 w-full" data-palink-message-media>
      <div className="relative">
        {status === 'ready' && current.url ? (
          <div
            className="w-full cursor-zoom-in overflow-hidden rounded-xl border border-border/50 bg-muted/20"
            style={aspectBoxStyle(current)}
            onClick={() => {
              const readyIdx = readyItems.findIndex((entry) => entry.url === current.url);
              setFullscreenIndex(readyIdx >= 0 ? readyIdx : 0);
            }}
          >
            <AsyncUploadImg
              src={current.url}
              alt={current.prompt ? current.prompt.slice(0, 80) : '生成图片'}
              className="h-full w-full object-contain transition-opacity hover:opacity-95"
              loading="lazy"
            />
          </div>
        ) : status === 'failed' ? (
          <div
            className={cn(
              'flex items-center justify-between gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2.5',
              isCharacterChat ? 'text-xs' : 'text-sm',
            )}
            role="alert"
          >
            <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <ImageOff size={14} className="shrink-0" />
              <span className="truncate" title={current.error || undefined}>
                {timedOut ? '生成超时，可能已中断' : current.error || '图片生成失败'}
              </span>
            </span>
            {onRetry && (
              <button
                type="button"
                onClick={handleRetry}
                className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                title="重新生成这张图"
                aria-label="重新生成这张图"
              >
                <RefreshCw size={11} />
                重试
              </button>
            )}
          </div>
        ) : (
          <div
            className="flex w-full animate-pulse flex-col items-center justify-center gap-1 rounded-xl border border-border/50 bg-muted/30"
            style={aspectBoxStyle(current)}
            role="status"
            aria-live="polite"
          >
            <span className="text-xs text-muted-foreground">正在生成配图…</span>
            <span className="text-[10px] tabular-nums text-muted-foreground/70">
              已等待 {elapsedSeconds(current, now)} 秒
            </span>
          </div>
        )}

        {/* 多图左右箭头：叠在图上，与消息下方的 swipe 候选箭头（纯文字 chevron）区分 */}
        {media.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 rounded-full bg-background/75 p-1 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-background hover:text-foreground"
              title="上一张"
              aria-label="上一张"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-background/75 p-1 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-background hover:text-foreground"
              title="下一张"
              aria-label="下一张"
            >
              <ChevronRight size={14} />
            </button>
            <span className="absolute bottom-1.5 right-2 rounded-full bg-background/75 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground backdrop-blur">
              {safeIndex + 1}/{media.length}
            </span>
          </>
        )}
      </div>

      {fullscreenIndex !== null && readyItems.length > 0 && (
        <FullscreenImageViewer
          images={readyItems}
          initialIndex={Math.min(fullscreenIndex, readyItems.length - 1)}
          onClose={() => setFullscreenIndex(null)}
        />
      )}
    </div>
  );
}

export default MessageMedia;