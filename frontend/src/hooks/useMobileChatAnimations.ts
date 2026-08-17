import { useState, useEffect, useRef, useCallback } from 'react';

const WELCOME_DROP_DURATION_MS = 760;
const WELCOME_DROP_START_DELAY_MS = 40;
const WELCOME_DROP_HANDOFF_AT_MS = Math.round(WELCOME_DROP_DURATION_MS * 0.92);
const WELCOME_DROP_HANDOFF_HOLD_MS = 120;
const NEW_SESSION_FADE_DURATION_MS = 200;
const HISTORY_SLIDE_DURATION_MS = 300;

interface SessionVisualSnapshot {
  activeSessionId: string | null;
  messages: any[];
}

interface StartSessionSwitchParams {
  activeSessionId: string | null;
  messages: any[];
  historyOpen: boolean;
  onApplySwitch: (sessionId: string) => Promise<void>;
  sessionId: string;
  setSidebarCollapsed: (v: boolean) => void;
  setHasSentFirstMessage: (v: boolean) => void;
  setMemoryStats: (v: any) => void;
}

interface StartWelcomeFadeTransitionParams {
  onTransitionReady: () => void;
}

interface WelcomeInputDropOptions {
  targetBottomPx?: number;
}

export function useMobileChatAnimations(activeSessionId: string | null, messages: any[]) {
  const [welcomeDropping, setWelcomeDropping] = useState(false);
  const [welcomeDropAnimating, setWelcomeDropAnimating] = useState(false);
  const [welcomeDropHandoffReady, setWelcomeDropHandoffReady] = useState(false);
  const [welcomeDropDistance, setWelcomeDropDistance] = useState(0);
  const [welcomeDropSnapshot, setWelcomeDropSnapshot] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [welcomeDropInputValue, setWelcomeDropInputValue] = useState('');
  const [sessionVisualSnapshot, setSessionVisualSnapshot] =
    useState<SessionVisualSnapshot | null>(null);
  const [newSessionFadeState, setNewSessionFadeState] = useState<
    'idle' | 'fading-out' | 'fading-in'
  >('idle');
  const [showNewContentView, setShowNewContentView] = useState(false);

  const welcomeComposerRef = useRef<HTMLDivElement>(null);
  const sessionSwitchTargetRef = useRef<string | null>(null);
  const sessionSwitchTokenRef = useRef(0);
  const sessionSwitchTimerRef = useRef<number | null>(null);
  const welcomeDropTimerRef = useRef<number | null>(null);
  const welcomeDropHandoffTimerRef = useRef<number | null>(null);
  const welcomeDropRafRef = useRef<number | null>(null);
  const newSessionFadeTimerRef = useRef<number | null>(null);
  const suppressSmoothScrollRef = useRef(false);

  const runWelcomeInputDropAnimation = useCallback((seedText: string, options: WelcomeInputDropOptions = {}) => {
    const composer = welcomeComposerRef.current;
    const dock = document.querySelector('nav[data-dock="true"]');
    const targetBottomPx =
      typeof options.targetBottomPx === 'number' && Number.isFinite(options.targetBottomPx)
        ? Math.max(0, options.targetBottomPx)
        : null;

    let offset = 220;
    // Note: Using window.innerWidth directly for animation calculations (not mobile detection)
    const fallbackWidth = Math.min(Math.max(window.innerWidth - 40, 280), 448);
    let snapshot: { top: number; left: number; width: number } = {
      top: Math.max(140, Math.round(window.innerHeight * 0.4)),
      left: Math.max(20, Math.round((window.innerWidth - fallbackWidth) / 2)),
      width: fallbackWidth,
    };
    if (composer) {
      const composerRect = composer.getBoundingClientRect();
      let targetTop: number | null = null;
      if (targetBottomPx !== null) {
        targetTop = window.innerHeight - targetBottomPx - composerRect.height;
      } else if (dock instanceof HTMLElement) {
        const dockRect = dock.getBoundingClientRect();
        targetTop = dockRect.top - composerRect.height - 14;
      }
      if (targetTop !== null) {
        offset = Math.max(0, Math.round(targetTop - composerRect.top));
      }
      snapshot = {
        top: composerRect.top,
        left: composerRect.left,
        width: composerRect.width,
      };
    } else if (targetBottomPx !== null) {
      const estimatedComposerHeight = 96;
      const targetTop = window.innerHeight - targetBottomPx - estimatedComposerHeight;
      offset = Math.max(0, Math.round(targetTop - snapshot.top));
    }

    if (welcomeDropTimerRef.current !== null) {
      window.clearTimeout(welcomeDropTimerRef.current);
      welcomeDropTimerRef.current = null;
    }
    if (welcomeDropHandoffTimerRef.current !== null) {
      window.clearTimeout(welcomeDropHandoffTimerRef.current);
      welcomeDropHandoffTimerRef.current = null;
    }
    if (welcomeDropRafRef.current !== null) {
      window.cancelAnimationFrame(welcomeDropRafRef.current);
      welcomeDropRafRef.current = null;
    }

    setWelcomeDropInputValue(seedText);
    setWelcomeDropSnapshot(snapshot);
    setWelcomeDropDistance(offset);
    setWelcomeDropping(true);
    setWelcomeDropAnimating(false);
    setWelcomeDropHandoffReady(false);

    const finishWelcomeDrop = () => {
      setWelcomeDropping(false);
      setWelcomeDropAnimating(false);
      setWelcomeDropHandoffReady(false);
      setWelcomeDropDistance(0);
      setWelcomeDropSnapshot(null);
      setWelcomeDropInputValue('');
      welcomeDropTimerRef.current = null;
      welcomeDropHandoffTimerRef.current = null;
    };

    welcomeDropRafRef.current = window.requestAnimationFrame(() => {
      welcomeDropRafRef.current = window.requestAnimationFrame(() => {
        welcomeDropRafRef.current = null;
        setWelcomeDropAnimating(true);
        welcomeDropHandoffTimerRef.current = window.setTimeout(() => {
          welcomeDropHandoffTimerRef.current = null;
          setWelcomeDropHandoffReady(true);
        }, WELCOME_DROP_HANDOFF_AT_MS);
        welcomeDropTimerRef.current = window.setTimeout(
          finishWelcomeDrop,
          WELCOME_DROP_DURATION_MS + WELCOME_DROP_HANDOFF_HOLD_MS,
        );
      });
    });
  }, []);

  const startSessionSwitchAnimation = useCallback(
    (params: StartSessionSwitchParams) => {
      const {
        activeSessionId: currentActiveSessionId,
        messages: currentMessages,
        historyOpen,
        onApplySwitch,
        sessionId,
        setSidebarCollapsed,
        setHasSentFirstMessage,
        setMemoryStats,
      } = params;

      const switchToken = sessionSwitchTokenRef.current + 1;
      sessionSwitchTokenRef.current = switchToken;
      sessionSwitchTargetRef.current = sessionId;

      setNewSessionFadeState('fading-out');

      setSessionVisualSnapshot({
        activeSessionId: currentActiveSessionId,
        messages: [...currentMessages],
      });

      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
        sessionSwitchTimerRef.current = null;
      }
      if (newSessionFadeTimerRef.current !== null) {
        window.clearTimeout(newSessionFadeTimerRef.current);
        newSessionFadeTimerRef.current = null;
      }

      setSidebarCollapsed(true);
      setHasSentFirstMessage(false);
      setMemoryStats(null);

      const applySessionSwitch = async () => {
        if (
          sessionSwitchTokenRef.current !== switchToken ||
          sessionSwitchTargetRef.current !== sessionId
        ) {
          return;
        }
        await onApplySwitch(sessionId);
        if (
          sessionSwitchTokenRef.current === switchToken &&
          sessionSwitchTargetRef.current === sessionId
        ) {
          sessionSwitchTargetRef.current = null;
          setSessionVisualSnapshot(null);
          setNewSessionFadeState('fading-in');
          newSessionFadeTimerRef.current = window.setTimeout(() => {
            if (sessionSwitchTokenRef.current !== switchToken) {
              return;
            }
            setNewSessionFadeState('idle');
            newSessionFadeTimerRef.current = null;
          }, NEW_SESSION_FADE_DURATION_MS);
        }
      };

      if (historyOpen) {
        sessionSwitchTimerRef.current = window.setTimeout(() => {
          sessionSwitchTimerRef.current = null;
          void applySessionSwitch();
        }, HISTORY_SLIDE_DURATION_MS);
        return;
      }

      sessionSwitchTimerRef.current = window.setTimeout(() => {
        sessionSwitchTimerRef.current = null;
        void applySessionSwitch();
      }, NEW_SESSION_FADE_DURATION_MS);
    },
    [],
  );

  const startWelcomeFadeTransition = useCallback(
    (params: StartWelcomeFadeTransitionParams) => {
      const { onTransitionReady } = params;

      const switchToken = sessionSwitchTokenRef.current + 1;
      sessionSwitchTokenRef.current = switchToken;

      setShowNewContentView(true);
      setNewSessionFadeState('fading-out');

      if (newSessionFadeTimerRef.current !== null) {
        window.clearTimeout(newSessionFadeTimerRef.current);
        newSessionFadeTimerRef.current = null;
      }

      newSessionFadeTimerRef.current = window.setTimeout(() => {
        if (sessionSwitchTokenRef.current !== switchToken) return;

        setSessionVisualSnapshot(null);
        setNewSessionFadeState('fading-in');

        newSessionFadeTimerRef.current = window.setTimeout(() => {
          if (sessionSwitchTokenRef.current !== switchToken) return;
          setNewSessionFadeState('idle');
          setShowNewContentView(false);
          newSessionFadeTimerRef.current = null;
        }, NEW_SESSION_FADE_DURATION_MS);

        onTransitionReady();
      }, NEW_SESSION_FADE_DURATION_MS);
    },
    [],
  );

  const resetWelcomeAnimation = useCallback(() => {
    if (welcomeDropRafRef.current !== null) {
      window.cancelAnimationFrame(welcomeDropRafRef.current);
      welcomeDropRafRef.current = null;
    }
    if (welcomeDropTimerRef.current !== null) {
      window.clearTimeout(welcomeDropTimerRef.current);
      welcomeDropTimerRef.current = null;
    }
    if (welcomeDropHandoffTimerRef.current !== null) {
      window.clearTimeout(welcomeDropHandoffTimerRef.current);
      welcomeDropHandoffTimerRef.current = null;
    }
    setWelcomeDropping(false);
    setWelcomeDropAnimating(false);
    setWelcomeDropHandoffReady(false);
    setWelcomeDropDistance(0);
    setWelcomeDropSnapshot(null);
    setWelcomeDropInputValue('');
  }, []);

  useEffect(() => {
    return () => {
      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
        sessionSwitchTimerRef.current = null;
      }
      if (welcomeDropTimerRef.current !== null) {
        window.clearTimeout(welcomeDropTimerRef.current);
        welcomeDropTimerRef.current = null;
      }
      if (welcomeDropHandoffTimerRef.current !== null) {
        window.clearTimeout(welcomeDropHandoffTimerRef.current);
        welcomeDropHandoffTimerRef.current = null;
      }
      if (welcomeDropRafRef.current !== null) {
        window.cancelAnimationFrame(welcomeDropRafRef.current);
        welcomeDropRafRef.current = null;
      }
      if (newSessionFadeTimerRef.current !== null) {
        window.clearTimeout(newSessionFadeTimerRef.current);
        newSessionFadeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
        sessionSwitchTimerRef.current = null;
      }
      if (newSessionFadeTimerRef.current !== null) {
        window.clearTimeout(newSessionFadeTimerRef.current);
        newSessionFadeTimerRef.current = null;
      }
      sessionSwitchTargetRef.current = null;
    };
  }, []);

  const displayedActiveSessionId = sessionVisualSnapshot
    ? sessionVisualSnapshot.activeSessionId
    : activeSessionId;
  const displayedMessages = sessionVisualSnapshot
    ? (Array.isArray(sessionVisualSnapshot.messages) ? sessionVisualSnapshot.messages : [])
    : (Array.isArray(messages) ? messages : []);
  const isWelcome = displayedMessages.length === 0 && !displayedActiveSessionId && !welcomeDropping;
  const displayWelcome =
    isWelcome || (welcomeDropping && displayedMessages.length === 0 && !displayedActiveSessionId);

  return {
    welcomeDropping,
    welcomeDropAnimating,
    welcomeDropHandoffReady,
    welcomeDropDistance,
    welcomeDropSnapshot,
    welcomeDropInputValue,
    sessionVisualSnapshot,
    newSessionFadeState,
    showNewContentView,
    welcomeComposerRef,
    sessionSwitchTargetRef,
    sessionSwitchTokenRef,
    sessionSwitchTimerRef,
    welcomeDropTimerRef,
    welcomeDropHandoffTimerRef,
    welcomeDropRafRef,
    newSessionFadeTimerRef,
    suppressSmoothScrollRef,
    setWelcomeDropping,
    setWelcomeDropDistance,
    setWelcomeDropSnapshot,
    setWelcomeDropInputValue,
    setSessionVisualSnapshot,
    setNewSessionFadeState,
    setShowNewContentView,
    runWelcomeInputDropAnimation,
    startSessionSwitchAnimation,
    startWelcomeFadeTransition,
    resetWelcomeAnimation,
    displayedActiveSessionId,
    displayedMessages,
    isWelcome,
    displayWelcome,
    WELCOME_DROP_DURATION_MS,
    WELCOME_DROP_START_DELAY_MS,
    WELCOME_DROP_HANDOFF_AT_MS,
    WELCOME_DROP_HANDOFF_HOLD_MS,
    NEW_SESSION_FADE_DURATION_MS,
    HISTORY_SLIDE_DURATION_MS,
  };
}
