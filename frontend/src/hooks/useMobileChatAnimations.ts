import { useState, useEffect, useRef, useCallback } from 'react';

const WELCOME_DROP_DURATION_MS = 760;
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

export function useMobileChatAnimations(activeSessionId: string | null, messages: any[]) {
  const [welcomeDropping, setWelcomeDropping] = useState(false);
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
  const newSessionFadeTimerRef = useRef<number | null>(null);
  const suppressSmoothScrollRef = useRef(false);

  const runWelcomeInputDropAnimation = useCallback((seedText: string) => {
    const composer = welcomeComposerRef.current;
    const dock = document.querySelector('nav[data-dock="true"]');

    let offset = 220;
    // Note: Using window.innerWidth directly for animation calculations (not mobile detection)
    const fallbackWidth = Math.min(Math.max(window.innerWidth - 40, 280), 448);
    let snapshot: { top: number; left: number; width: number } = {
      top: Math.max(140, Math.round(window.innerHeight * 0.4)),
    left: Math.max(20, Math.round((window.innerWidth - fallbackWidth) / 2)),
      width: fallbackWidth,
    };
    if (composer && dock instanceof HTMLElement) {
      const composerRect = composer.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const targetTop = dockRect.top - composerRect.height - 14;
      offset = targetTop - composerRect.top;
      snapshot = {
        top: composerRect.top,
        left: composerRect.left,
        width: composerRect.width,
      };
    }

    if (welcomeDropTimerRef.current !== null) {
      window.clearTimeout(welcomeDropTimerRef.current);
    }

    setWelcomeDropInputValue(seedText);
    setWelcomeDropSnapshot(snapshot);
    setWelcomeDropDistance(offset);
    setWelcomeDropping(true);

    welcomeDropTimerRef.current = window.setTimeout(() => {
      setWelcomeDropping(false);
      setWelcomeDropDistance(0);
      setWelcomeDropSnapshot(null);
      setWelcomeDropInputValue('');
      welcomeDropTimerRef.current = null;
    }, WELCOME_DROP_DURATION_MS);
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
    setWelcomeDropping(false);
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
  const displayedMessages = sessionVisualSnapshot ? sessionVisualSnapshot.messages : messages;
  const isWelcome = displayedMessages.length === 0 && !displayedActiveSessionId;
  const displayWelcome = isWelcome || welcomeDropping;

  return {
    welcomeDropping,
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
    NEW_SESSION_FADE_DURATION_MS,
    HISTORY_SLIDE_DURATION_MS,
  };
}
