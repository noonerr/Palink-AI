/**
 * useSessionSwitchAnimation — 会话切换动画 Hook
 * 从 CharacterChat 提取的会话切换淡入淡出动画逻辑
 */
import { useState, useRef, useCallback } from 'react';
import type { CharacterChatSession, CharacterChatMessage } from '@/types';

const HISTORY_SLIDE_DURATION_MS = 300;
const NEW_SESSION_FADE_DURATION_MS = 200;

export type SessionFadeState = 'idle' | 'fading-out' | 'fading-in';

export interface SessionVisualSnapshot {
  activeSessionId: string | null;
  messages: CharacterChatMessage[];
}

export interface UseSessionSwitchAnimationOptions {
  selectedSession: CharacterChatSession | null;
  messages: CharacterChatMessage[];
  sidebarCollapsed: boolean;
  isMobile: boolean;
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
  handleSelectSession: (s: CharacterChatSession) => Promise<void>;
  handleNewSession: () => void;
}

export function useSessionSwitchAnimation({
  selectedSession,
  messages,
  sidebarCollapsed,
  isMobile,
  setSidebarCollapsed,
  handleSelectSession,
  handleNewSession,
}: UseSessionSwitchAnimationOptions) {
  const [sessionVisualSnapshot, setSessionVisualSnapshot] = useState<SessionVisualSnapshot | null>(null);
  const [newSessionFadeState, setNewSessionFadeState] = useState<SessionFadeState>('idle');
  const sessionSwitchTokenRef = useRef(0);
  const sessionSwitchTimerRef = useRef<number | null>(null);
  const newSessionFadeTimerRef = useRef<number | null>(null);

  const cleanupTimers = useCallback(() => {
    if (sessionSwitchTimerRef.current !== null) {
      window.clearTimeout(sessionSwitchTimerRef.current);
      sessionSwitchTimerRef.current = null;
    }
    if (newSessionFadeTimerRef.current !== null) {
      window.clearTimeout(newSessionFadeTimerRef.current);
      newSessionFadeTimerRef.current = null;
    }
  }, []);

  const handleSessionSwitchWithFade = useCallback((session: CharacterChatSession) => {
    const switchToken = ++sessionSwitchTokenRef.current;

    setNewSessionFadeState('fading-out');
    setSessionVisualSnapshot({
      activeSessionId: selectedSession?.id || null,
      messages: [...messages],
    });

    cleanupTimers();

    // 只在桌面端自动关闭侧栏，移动端保持用户选择的状态
    if (!isMobile) {
      setSidebarCollapsed(true);
    }

    const applySessionSwitch = async () => {
      if (sessionSwitchTokenRef.current !== switchToken) return;

      await handleSelectSession(session);

      if (sessionSwitchTokenRef.current === switchToken) {
        setSessionVisualSnapshot(null);
        setNewSessionFadeState('fading-in');
        newSessionFadeTimerRef.current = window.setTimeout(() => {
          if (sessionSwitchTokenRef.current !== switchToken) return;
          setNewSessionFadeState('idle');
          newSessionFadeTimerRef.current = null;
        }, NEW_SESSION_FADE_DURATION_MS);
      }
    };

    if (!sidebarCollapsed) {
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
  }, [selectedSession, messages, sidebarCollapsed, isMobile, setSidebarCollapsed, handleSelectSession, cleanupTimers]);

  const handleNewSessionWithFade = useCallback(() => {
    const switchToken = ++sessionSwitchTokenRef.current;

    setNewSessionFadeState('fading-out');
    setSessionVisualSnapshot({
      activeSessionId: selectedSession?.id || null,
      messages: [...messages],
    });

    cleanupTimers();

    // 只在桌面端自动关闭侧栏，移动端保持用户选择的状态
    if (!isMobile) {
      setSidebarCollapsed(true);
    }

    const resetToNewSession = () => {
      if (sessionSwitchTokenRef.current !== switchToken) return;

      handleNewSession();
      setSessionVisualSnapshot(null);
      setNewSessionFadeState('fading-in');
      newSessionFadeTimerRef.current = window.setTimeout(() => {
        if (sessionSwitchTokenRef.current !== switchToken) return;
        setNewSessionFadeState('idle');
        newSessionFadeTimerRef.current = null;
      }, NEW_SESSION_FADE_DURATION_MS);
    };

    if (!sidebarCollapsed) {
      sessionSwitchTimerRef.current = window.setTimeout(() => {
        sessionSwitchTimerRef.current = null;
        resetToNewSession();
      }, HISTORY_SLIDE_DURATION_MS);
      return;
    }

    sessionSwitchTimerRef.current = window.setTimeout(() => {
      sessionSwitchTimerRef.current = null;
      resetToNewSession();
    }, NEW_SESSION_FADE_DURATION_MS);
  }, [selectedSession, messages, sidebarCollapsed, isMobile, setSidebarCollapsed, handleNewSession, cleanupTimers]);

  return {
    sessionVisualSnapshot,
    newSessionFadeState,
    setNewSessionFadeState,
    setSessionVisualSnapshot,
    handleSessionSwitchWithFade,
    handleNewSessionWithFade,
    cleanupTimers,
    HISTORY_SLIDE_DURATION_MS,
    NEW_SESSION_FADE_DURATION_MS,
  };
}

export default useSessionSwitchAnimation;
