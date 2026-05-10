import { useState, useEffect, useRef } from 'react';

const MESSAGE_TO_COMPOSER_GAP_PX = 40;
const COMPOSER_CONTAINER_TOP_PADDING_PX = 8;
const MESSAGES_OUTER_BOTTOM_PADDING_PX = 16;

interface UseMobileKeyboardAdapterParams {
  isKeyboardOpen: boolean;
  displayWelcome: boolean;
  messagesLength: number;
  streaming: boolean;
  hasSentFirstMessage: boolean;
}

export function useMobileKeyboardAdapter({
  isKeyboardOpen,
  displayWelcome,
  messagesLength,
  streaming,
  hasSentFirstMessage,
}: UseMobileKeyboardAdapterParams) {
  const [composerBottomOffset, setComposerBottomOffset] = useState(90);
  const [needsTopSpacer, setNeedsTopSpacer] = useState(false);

  const mobileComposerRef = useRef<HTMLDivElement>(null);
  const messagesScrollWrapRef = useRef<HTMLDivElement>(null);
  const messageStackRef = useRef<HTMLDivElement>(null);
  const mobileTopBarRef = useRef<HTMLDivElement>(null);
  const keyboardWasOpenRef = useRef(isKeyboardOpen);
  const keyboardCloseGuardUntilRef = useRef(0);
  const stableComposerOffsetRef = useRef(90);
  const pendingInitialBottomLockRef = useRef(false);
  const initialBottomLockUntilRef = useRef(0);

  useEffect(() => {
    if (keyboardWasOpenRef.current && !isKeyboardOpen) {
      keyboardCloseGuardUntilRef.current = performance.now() + 700;
    }
    keyboardWasOpenRef.current = isKeyboardOpen;
  }, [isKeyboardOpen]);

  useEffect(() => {
    let rafId: number | null = null;
    const timeoutIds: number[] = [];

    const updateComposerOffset = () => {
      if (displayWelcome) return;

      if (isKeyboardOpen) {
        return;
      }

      const dockSurface = document.querySelector('nav[data-dock="true"] > div[data-dock="true"]') as HTMLElement | null;
      const dockTarget = dockSurface ?? (document.querySelector('nav[data-dock="true"]') as HTMLElement | null);
      if (!dockTarget) {
        setComposerBottomOffset((prev) => (prev > 0 ? prev : 90));
        return;
      }

      const dockRect = dockTarget.getBoundingClientRect();
      const measuredOffset = Math.max(0, Math.ceil(window.innerHeight - dockRect.top + 7));

      setComposerBottomOffset((prev) => {
        const prevStableOffset = prev > 0 ? prev : stableComposerOffsetRef.current;

        if (measuredOffset < 40) {
          return prevStableOffset > 0 ? prevStableOffset : 90;
        }

        if (performance.now() < keyboardCloseGuardUntilRef.current && measuredOffset < prevStableOffset) {
          return prevStableOffset;
        }

        stableComposerOffsetRef.current = measuredOffset;
        return prev === measuredOffset ? prev : measuredOffset;
      });
    };

    const scheduleUpdate = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateComposerOffset();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    scheduleUpdate();

    if (mobileComposerRef.current) {
      observer.observe(mobileComposerRef.current);
    }
    const dockNav = document.querySelector('nav[data-dock="true"]') as HTMLElement | null;
    if (dockNav) {
      observer.observe(dockNav);
    }

    const dockSurface = document.querySelector('nav[data-dock="true"] > div[data-dock="true"]') as HTMLElement | null;
    if (dockSurface) {
      observer.observe(dockSurface);
    }

    const onDockTransitionEnd = () => scheduleUpdate();
    dockNav?.addEventListener('transitionend', onDockTransitionEnd);
    dockSurface?.addEventListener('transitionend', onDockTransitionEnd);

    if (!isKeyboardOpen) {
      [80, 180, 320, 480].forEach((delay) => {
        const id = window.setTimeout(scheduleUpdate, delay);
        timeoutIds.push(id);
      });
    }

    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      observer.disconnect();
      dockNav?.removeEventListener('transitionend', onDockTransitionEnd);
      dockSurface?.removeEventListener('transitionend', onDockTransitionEnd);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
      timeoutIds.forEach((id) => window.clearTimeout(id));
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [displayWelcome, isKeyboardOpen]);

  useEffect(() => {
    if (displayWelcome) {
      setNeedsTopSpacer(false);
      return;
    }

    if (hasSentFirstMessage || messagesLength > 0) {
      setNeedsTopSpacer(true);
      return;
    }

    const stack = messageStackRef.current;
    const wrap = messagesScrollWrapRef.current;
    const viewport = wrap?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLDivElement | null;

    if (!stack || !viewport) return;

    let rafId: number | null = null;
    const checkOverflow = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        const isOverflown = stack.scrollHeight > viewport.clientHeight + 10;
        setNeedsTopSpacer(isOverflown);
        rafId = null;
      });
    };

    checkOverflow();

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(stack);
    observer.observe(viewport);

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [displayWelcome, messagesLength, streaming, hasSentFirstMessage]);

  const messageBottomPaddingPx = isKeyboardOpen
    ? 16
    : Math.max(
        16,
        (composerBottomOffset > 0 ? composerBottomOffset : 90)
          + COMPOSER_CONTAINER_TOP_PADDING_PX
          + MESSAGE_TO_COMPOSER_GAP_PX
          - MESSAGES_OUTER_BOTTOM_PADDING_PX
      );

  return {
    composerBottomOffset,
    needsTopSpacer,
    setNeedsTopSpacer,
    messageBottomPaddingPx,
    mobileComposerRef,
    messagesScrollWrapRef,
    messageStackRef,
    mobileTopBarRef,
    pendingInitialBottomLockRef,
    initialBottomLockUntilRef,
  };
}
