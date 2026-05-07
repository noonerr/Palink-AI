import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, X, Edit3, Trash2, Menu, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { buildMockSuggestions, streamMockAssistantReply } from '@/lib/mockChatStream';
import { consumeSseStream } from '@/lib/sseStream';
import type { Message as MessageType, Model, Session } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

type StreamStatus = 'idle' | 'pending' | 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

const WELCOME_DROP_DURATION_MS = 760;
const HISTORY_PANEL_WIDTH_PX = 280;
const HISTORY_SLIDE_DURATION_MS = 300;
const NEW_SESSION_FADE_DURATION_MS = 200;
const MESSAGE_TO_COMPOSER_GAP_PX = 40;
const COMPOSER_CONTAINER_TOP_PADDING_PX = 8; // pt-2
const MESSAGES_OUTER_BOTTOM_PADDING_PX = 16; // pb-4
const INITIAL_BOTTOM_LOCK_MS = 1500;

interface ChatViewProps {
  token: string;
  user: { avatar?: string; username: string };
  models: Model[];
  currentModel: string;
  setCurrentModel: (modelId: string) => void;
  t: Record<string, string>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  isDark?: boolean;
  isKeyboardOpen?: boolean;
  showModelReasoning?: boolean;
}

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
  thumbnail?: string;
  size?: number;
}

interface SessionVisualSnapshot {
  activeSessionId: string | null;
  messages: MessageType[];
}

export const ChatViewMobile: React.FC<ChatViewProps> = ({
  token: _token,
  user,
  models,
  currentModel,
  setCurrentModel,
  t,
  sidebarCollapsed,
  setSidebarCollapsed,
  isDark = false,
  isKeyboardOpen = false,
  showModelReasoning = true,
}) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState('');
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle');
  const [queueInfo, setQueueInfo] = useState<{ requestId: string; position: number; estimatedWait: number } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    { type: 'single'; id: string } | { type: 'batch' } | { type: 'message'; messageId: number; messageIndex: number } | null
  >(null);

  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  const [memoryStats, setMemoryStats] = useState<{
    message_count: number;
    token_count: number;
    oldest_message_hours: number;
    compression_needed: boolean;
    compression_reason: string;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [developerMode, setDeveloperMode] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchAvailable, setWebSearchAvailable] = useState(true);

  const streaming = streamStatus === 'pending' || streamStatus === 'queued' || streamStatus === 'streaming';

  const [welcomeDropping, setWelcomeDropping] = useState(false);
  const [welcomeDropDistance, setWelcomeDropDistance] = useState(0);
  const [welcomeDropSnapshot, setWelcomeDropSnapshot] = useState<{ top: number; left: number; width: number } | null>(null);
  const [welcomeDropInputValue, setWelcomeDropInputValue] = useState('');
  const [needsTopSpacer, setNeedsTopSpacer] = useState(false);
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);
  const [composerBottomOffset, setComposerBottomOffset] = useState(90);
  const [sessionVisualSnapshot, setSessionVisualSnapshot] = useState<SessionVisualSnapshot | null>(null);
  const [newSessionFadeState, setNewSessionFadeState] = useState<'idle' | 'fading-out' | 'fading-in'>('idle');
  const [showNewContentView, setShowNewContentView] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const sessionIdSetRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const welcomeComposerRef = useRef<HTMLDivElement>(null);
  const mobileComposerRef = useRef<HTMLDivElement>(null);
  const messagesScrollWrapRef = useRef<HTMLDivElement>(null);
  const messageStackRef = useRef<HTMLDivElement>(null);
  const mobileTopBarRef = useRef<HTMLDivElement>(null);
  const suppressSmoothScrollRef = useRef(false);
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  const sessionSwitchTargetRef = useRef<string | null>(null);
  const sessionSwitchTokenRef = useRef(0);
  const messagesRequestSeqRef = useRef(0);
  const sessionSwitchTimerRef = useRef<number | null>(null);
  const welcomeDropTimerRef = useRef<number | null>(null);
  const newSessionFadeTimerRef = useRef<number | null>(null);
  const keyboardWasOpenRef = useRef(isKeyboardOpen);
  const keyboardCloseGuardUntilRef = useRef(0);
  const stableComposerOffsetRef = useRef(90);
  const pendingInitialBottomLockRef = useRef(false);
  const initialBottomLockUntilRef = useRef(0);

  const markStreamActive = useCallback(() => {
    setStreamStatus((prev) => (prev === 'pending' ? 'streaming' : prev));
  }, []);

  const handleStopStreaming = useCallback(() => {
    if (queueInfo?.requestId) {
      api.post(`/api/chat/queue/cancel/${queueInfo.requestId}`).catch(() => {});
    }
    if (!abortControllerRef.current) return;
    setStreamStatus('cancelled');
    setQueueInfo(null);
    abortControllerRef.current.abort();
  }, [queueInfo]);

  const displayedActiveSessionId = sessionVisualSnapshot ? sessionVisualSnapshot.activeSessionId : activeSessionId;
  const displayedMessages = sessionVisualSnapshot ? sessionVisualSnapshot.messages : messages;
  const displayedSuggestions = sessionVisualSnapshot ? [] : suggestions;
  const isWelcome = displayedMessages.length === 0 && !displayedActiveSessionId;
  const displayWelcome = isWelcome || welcomeDropping;
  const historyOpen = !sidebarCollapsed;
  const messageBottomPaddingPx = isKeyboardOpen
    ? 16
    : Math.max(
        16,
        (composerBottomOffset > 0 ? composerBottomOffset : 90)
          + COMPOSER_CONTAINER_TOP_PADDING_PX
          + MESSAGE_TO_COMPOSER_GAP_PX
          - MESSAGES_OUTER_BOTTOM_PADDING_PX
      );

  const loadMemoryStats = useCallback(async (sessionId: string) => {
    if (!sessionId) return;

    loadingSessionRef.current = sessionId;

    try {
      const data = await api.get(`/api/memory/stats?session_id=${sessionId}`);
      if (loadingSessionRef.current === sessionId) {
        const stats = data.stats || {};
        setMemoryStats({
          message_count: stats.message_count ?? 0,
          token_count: stats.token_count ?? 0,
          oldest_message_hours: stats.oldest_message_hours ?? 0,
          compression_needed: data.compression_needed ?? false,
          compression_reason: data.reason ?? '',
        });
      }
    } catch (e) {
      console.error('Failed to load memory stats:', e);
    }
  }, []);

  const manualCompressMemory = async () => {
    if (!activeSessionId || compressing) return;
    setCompressing(true);
    try {
      const data = await api.post('/api/memory/compress', {
        session_id: activeSessionId,
        compression_ratio: 0.5,
      });
      console.info(`记忆压缩完成！\n删除: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
      await loadMemoryStats(activeSessionId);
    } catch (e) {
      console.error('Manual compress failed:', e);
      console.error('压缩失败');
    } finally {
      setCompressing(false);
    }
  };

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.get<Session[]>('/api/sessions?type=chat');
      setSessions(data);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }, []);

  const buildAssistantContent = useCallback((content: string, reasoning: string) => {
    if (!reasoning) {
      return content;
    }
    return `<think>${reasoning}</think>\n${content}`;
  }, []);

  const normalizeAssistantAnswer = useCallback((rawContent: string) => {
    if (!rawContent) {
      return rawContent;
    }

    const finalAnswerParts = rawContent
      .split(/Final\s*Answer\s*[:：]?/gi)
      .map((part) => part.trim())
      .filter(Boolean);

    if (finalAnswerParts.length > 1) {
      return finalAnswerParts[finalAnswerParts.length - 1];
    }

    return rawContent;
  }, []);

  const setAssistantMessageSnapshot = useCallback(
    (assistantMessageId: string, content: string, reasoning: string, _forceSync = false) => {
      const nextContent = buildAssistantContent(normalizeAssistantAnswer(content), reasoning);
      setMessages((prev) => {
        const next = [...prev];
        const idx = next.findIndex((msg) => msg.id === assistantMessageId);
        if (idx === -1) {
          next.push({
            id: assistantMessageId,
            role: 'assistant',
            content: nextContent,
            model: currentModel,
          });
          return next;
        }
        next[idx] = {
          ...next[idx],
          content: nextContent,
        };
        return next;
      });
    },
    [buildAssistantContent, currentModel, normalizeAssistantAnswer]
  );

  const ensureDeveloperSession = useCallback(async (seedText: string) => {
    if (activeSessionId) {
      return activeSessionId;
    }

    try {
      const title = (seedText || '').trim().slice(0, 24) || t.new_chat || 'New Chat';
      const created = await api.post<{ id: string }>('/api/sessions', {
        type: 'chat',
        title,
      });
      if (created?.id) {
        setActiveSessionId(created.id);
        return created.id;
      }
    } catch (error) {
      console.error('Failed to create developer-mode session:', error);
    }

    return null;
  }, [activeSessionId, t.new_chat]);

  const streamMockIntoMessage = useCallback(async (seedText: string, assistantMessageId: string) => {
    let fullContent = '';
    await streamMockAssistantReply(
      seedText,
      (chunk) => {
        markStreamActive();
        fullContent += chunk;
        setAssistantMessageSnapshot(assistantMessageId, fullContent, '');
      },
      { signal: abortControllerRef.current?.signal }
    );
    return fullContent;
  }, [markStreamActive, setAssistantMessageSnapshot]);

  useEffect(() => {
    return () => {
      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
      }
      if (welcomeDropTimerRef.current !== null) {
        window.clearTimeout(welcomeDropTimerRef.current);
      }
      if (newSessionFadeTimerRef.current !== null) {
        window.clearTimeout(newSessionFadeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    api.get('/api/admin/web-search').then((data: any) => {
      if (data && data.enabled === false) setWebSearchAvailable(false);
    }).catch(() => {});
  }, []);

  const runWelcomeInputDropAnimation = useCallback((seedText: string) => {
    const composer = welcomeComposerRef.current;
    const dock = document.querySelector('nav[data-dock="true"]');

    let offset = 220;
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

  const handleSelectSession = (session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    const switchToken = sessionSwitchTokenRef.current + 1;
    sessionSwitchTokenRef.current = switchToken;
    sessionSwitchTargetRef.current = sessionId;

    setNewSessionFadeState('fading-out');

    setSessionVisualSnapshot({
      activeSessionId,
      messages: [...messages],
    });

    if (sessionSwitchTimerRef.current !== null) {
      window.clearTimeout(sessionSwitchTimerRef.current);
      sessionSwitchTimerRef.current = null;
    }
    if (newSessionFadeTimerRef.current !== null) {
      window.clearTimeout(newSessionFadeTimerRef.current);
      newSessionFadeTimerRef.current = null;
    }

    // 先完成侧栏收起动画，再替换会话内容，避免中途出现错位补位。
    setSidebarCollapsed(true);
    setHasSentFirstMessage(false);
    setMemoryStats(null);

    const applySessionSwitch = async () => {
      if (sessionSwitchTokenRef.current !== switchToken || sessionSwitchTargetRef.current !== sessionId) {
        return;
      }
      setActiveSessionId(sessionId);
      await loadMessages(sessionId, { bypassCache: true });
      if (sessionSwitchTokenRef.current === switchToken && sessionSwitchTargetRef.current === sessionId) {
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
  };

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

  const loadMessages = useCallback(async (sessionId: string, options?: { bypassCache?: boolean }) => {
    if (!options?.bypassCache && lastLoadedSessionIdRef.current === sessionId) {
      return false;
    }

    lastLoadedSessionIdRef.current = sessionId;
    const requestSeq = ++messagesRequestSeqRef.current;

    try {
      const data = await api.get<MessageType[]>(`/api/sessions/${sessionId}/messages`);
      const isLatestRequest = requestSeq === messagesRequestSeqRef.current;
      const isExpectedSession =
        activeSessionId === sessionId || sessionSwitchTargetRef.current === sessionId;

      if (!isLatestRequest || !isExpectedSession) {
        return false;
      }

      setMessages(data);
      setSuggestions([]);
      pendingInitialBottomLockRef.current = data.length > 0;
      initialBottomLockUntilRef.current = performance.now() + INITIAL_BOTTOM_LOCK_MS;

      loadMemoryStats(sessionId);

      const lastMsg = data[data.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.length > 20) {
        if (suggestionsAbortRef.current) {
          suggestionsAbortRef.current.abort();
        }
        suggestionsAbortRef.current = new AbortController();
        const currentAbortController = suggestionsAbortRef.current;

        api
          .post('/api/chat/suggestions', { message: lastMsg.content, model: currentModel }, { signal: currentAbortController.signal })
          .then((items: string[]) => {
            if (Array.isArray(items) && !currentAbortController.signal.aborted) {
              setSuggestions(items);
            }
          })
          .catch(() => {});
      }

      return true;
    } catch (e) {
      console.error('Failed to load messages:', e);
      return false;
    }
  }, [activeSessionId, currentModel, loadMemoryStats]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (activeSessionId && !isSendingMessage) {
      setMemoryStats(null);
      // 只在没有预先加载过的情况下才加载
      if (lastLoadedSessionIdRef.current !== activeSessionId) {
        loadMessages(activeSessionId);
      }
    } else if (!activeSessionId) {
      setMessages([]);
      setSuggestions([]);
      setMemoryStats(null);
      lastLoadedSessionIdRef.current = null;
    }
  }, [activeSessionId, loadMessages, isSendingMessage]);

  useEffect(() => {
    const fetchUserSettings = async () => {
      try {
        const settings = await api.get('/api/users/me/settings');
        setMemoryMode(settings.memory_mode || 'rule');
        setDeveloperMode(settings.developer_mode === true);
      } catch (e) {
        console.error('Failed to fetch user settings:', e);
      }
    };

    fetchUserSettings();
    window.addEventListener('userSettingsUpdated', fetchUserSettings);
    return () => window.removeEventListener('userSettingsUpdated', fetchUserSettings);
  }, []);

  useEffect(() => {
    const behavior: ScrollBehavior = streaming || welcomeDropping || suppressSmoothScrollRef.current ? 'auto' : 'smooth';
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, [messages, streaming, welcomeDropping]);

  useEffect(() => {
    if (displayWelcome || messages.length === 0) {
      pendingInitialBottomLockRef.current = false;
      return;
    }

    if (!pendingInitialBottomLockRef.current) {
      return;
    }

    if (performance.now() >= initialBottomLockUntilRef.current) {
      pendingInitialBottomLockRef.current = false;
      return;
    }

    let rafA: number | null = null;
    let rafB: number | null = null;

    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    });

    return () => {
      if (rafA !== null) cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [displayWelcome, messages.length, messageBottomPaddingPx]);

  useEffect(() => {
    if (isWelcome) {
      setWelcomeDropping(false);
      setWelcomeDropDistance(0);
      setWelcomeDropSnapshot(null);
      setWelcomeDropInputValue('');
    }
  }, [isWelcome]);

  useEffect(() => {
    if (displayWelcome) {
      setNeedsTopSpacer(false);
      return;
    }

    // 如果有历史消息（即使还没在这个会话发送新消息），也显示spacer
    if (hasSentFirstMessage || messages.length > 0) {
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
  }, [displayWelcome, messages.length, streaming, hasSentFirstMessage]);

  useEffect(() => {
    if (keyboardWasOpenRef.current && !isKeyboardOpen) {
      // iOS 键盘收起到 viewport/dock 稳定有延迟，短窗口内禁止偏移变小。
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
        // 保留上一次有效偏移，避免键盘收起首帧因状态仍为 0 而与 dock 重叠。
        return;
      }

      const dockSurface = document.querySelector('nav[data-dock="true"] > div[data-dock="true"]') as HTMLElement | null;
      const dockTarget = dockSurface ?? (document.querySelector('nav[data-dock="true"]') as HTMLElement | null);
      if (!dockTarget) {
        // 回退到稳定默认值，避免偶发查询不到 dock 时输入框掉到最底部
        setComposerBottomOffset((prev) => (prev > 0 ? prev : 90));
        return;
      }

      const dockRect = dockTarget.getBoundingClientRect();
      const measuredOffset = Math.max(0, Math.ceil(window.innerHeight - dockRect.top + 7));

      setComposerBottomOffset((prev) => {
        const prevStableOffset = prev > 0 ? prev : stableComposerOffsetRef.current;

        // 键盘收起动画过程中可能短暂测到极小值（如 7px），会导致输入框掉到底部
        // 这类值直接用上一次有效值或默认值兜底，等待后续复测覆盖。
        if (measuredOffset < 40) {
          return prevStableOffset > 0 ? prevStableOffset : 90;
        }

        // 键盘刚收起的一小段时间内，忽略偏小的瞬时值，避免先与 dock 重叠。
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
      // 键盘收起后做多次延迟复测，覆盖 iOS/Android 视口与 transform 动画不同步。
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



  const handleUpload = async (file: File, type: 'image' | 'file') => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve) => {
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(file);
      });

      const data = await api.post('/api/upload', { filename: file.name, data: dataUrl });
      setAttachments((prev) => [...prev, {
        type,
        name: file.name,
        url: data.url,
        thumbnail: type === 'image' ? dataUrl : undefined,
        size: file.size,
      }]);
    } catch (e) {
      console.error('Upload failed:', e);
    } finally {
      setUploading(false);
    }
  };

  const handleRegenerate = async (messageIndex: number) => {
    if (streaming || uploading || messageIndex < 1) return;

    const assistantMessageIndex = messageIndex;
    const userMessageIndex = assistantMessageIndex - 1;
    if (userMessageIndex < 0) return;

    const userMessage = messages[userMessageIndex];
    if (userMessage.role !== 'user') return;

    setRegeneratingMessageIndex(assistantMessageIndex);
    setStreamStatus('pending');
    setSuggestions([]);
    setIsSendingMessage(true);

    const assistantMessageId = generateMessageId();
    setMessages((prev) => {
      const next = [...prev];
      next[assistantMessageIndex] = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        model: currentModel,
      };
      return next;
    });

    abortControllerRef.current = new AbortController();
    let streamHasError = false;
    let streamWasCancelled = false;

    if (developerMode) {
      try {
        await streamMockIntoMessage(userMessage.content, assistantMessageId);
        setSuggestions(buildMockSuggestions());
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          streamWasCancelled = true;
        } else {
          streamHasError = true;
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.findIndex((msg) => msg.id === assistantMessageId);
            if (idx >= 0) {
              next[idx].content += `\n[Error: ${(e as Error).message}]`;
            }
            return next;
          });
        }
      } finally {
        if (streamWasCancelled) {
          setStreamStatus('cancelled');
        } else if (streamHasError) {
          setStreamStatus('error');
        } else {
          setStreamStatus('done');
        }
        setQueueInfo(null);
        setRegeneratingMessageIndex(null);
        setIsSendingMessage(false);
        abortControllerRef.current = null;
      }
      return;
    }

    let fullContent = '';
    let fullReasoning = '';
    let isQueued = false;

    try {
      const res = await api.stream(
        '/api/chat',
        {
          session_id: activeSessionId,
          session_type: 'chat',
          message: userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim(),
          model: currentModel,
          images: [],
          files: [],
        },
        { signal: abortControllerRef.current.signal }
      );

      await consumeSseStream(res, (json) => {
        if (json.type === 'web_search' && json.results) {
          setMessages(prev => prev.map(m => m.id === assistantMessageId ? { ...m, webSearchResults: { query: json.query as string || '', results: json.results as { title: string; snippet: string; url: string }[] } } : m));
          return;
        }
        if (json.type === 'queue' && json.request_id) {
          setStreamStatus('queued');
          isQueued = true;
          setQueueInfo({
            requestId: json.request_id as string,
            position: typeof json.position === 'number' ? json.position : 0,
            estimatedWait: typeof json.estimated_wait === 'number' ? json.estimated_wait : 0,
          });
          return;
        }

        const content = typeof json.content === 'string' ? json.content : '';
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const reasoningDelta = `${reasoning}${modelReasoning}`;

        if (!content && !reasoningDelta) return;

        if (isQueued) {
          setQueueInfo(null);
          isQueued = false;
        }
        markStreamActive();

        if (reasoningDelta) {
          fullReasoning += reasoningDelta;
          setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        }

        if (content) {
          fullContent += content;
          setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        }
      });

      setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);

      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel }).then(setSuggestions).catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        streamWasCancelled = true;
      } else {
        streamHasError = true;
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((msg) => msg.id === assistantMessageId);
          if (idx >= 0) {
            next[idx].content += `\n[Error: ${(e as Error).message}]`;
          }
          return next;
        });
      }
    } finally {
      if (streamWasCancelled) {
        setStreamStatus('cancelled');
      } else if (streamHasError) {
        setStreamStatus('error');
      } else {
        setStreamStatus('done');
      }
      setQueueInfo(null);
      setRegeneratingMessageIndex(null);
      setIsSendingMessage(false);
      abortControllerRef.current = null;
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = typeof overrideText === 'string' ? overrideText : input;
    if ((!text.trim() && attachments.length === 0) || streaming || uploading) return;

    // 如果从欢迎页面进入，需要先淡出欢迎页面
    const isFromWelcome = !activeSessionId && messages.length === 0 && !welcomeDropping;
    const switchToken = sessionSwitchTokenRef.current + 1;
    
    // 在清空状态之前先构建好 displayContent 并保存 attachments
    let displayContent = text;
    const savedAttachments = [...attachments];
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach((att) => {
        displayContent += att.type === 'image' ? `![${att.name}](${att.url})\n` : `[📎 ${att.name}](${att.url})\n`;
      });
    }
    
    if (isFromWelcome) {
      sessionSwitchTokenRef.current = switchToken;
      suppressSmoothScrollRef.current = true;
      
      // 先准备好新内容（在淡出的同时就添加好）
      setHasSentFirstMessage(true);
      sessionIdSetRef.current = false;
      setInput('');
      setAttachments([]);
      setStreamStatus('pending');
      setSuggestions([]);
      setIsSendingMessage(true);

      const userMessageId = generateMessageId();
      const assistantMessageId = generateMessageId();
      setMessages((prev) => [
        ...prev,
        { id: userMessageId, role: 'user', content: displayContent },
      ]);
      
      // 保存当前状态（显示欢迎页面），但新内容已经在 state 里了
      setSessionVisualSnapshot({
        activeSessionId: null,
        messages: [], // 保持欢迎页面状态
      });
      
      // 同时显示新内容容器（但 opacity=0）
      setShowNewContentView(true);
      
      // 开始淡出旧内容
      setNewSessionFadeState('fading-out');
      
      // 播放欢迎动画
      runWelcomeInputDropAnimation(text);
      
      // 等淡出完全完成
      await new Promise(resolve => setTimeout(resolve, NEW_SESSION_FADE_DURATION_MS));
      
      if (sessionSwitchTokenRef.current !== switchToken) return;
      
      // 移除 snapshot（此时新内容容器已经存在且 opacity=0，不会闪烁）
      setSessionVisualSnapshot(null);
      
      // 立即开始淡入新内容（同一帧内完成 DOM 切换 + opacity 变化）
      setNewSessionFadeState('fading-in');
      setTimeout(() => {
        if (sessionSwitchTokenRef.current === switchToken) {
          setNewSessionFadeState('idle');
          setShowNewContentView(false);
        }
      }, NEW_SESSION_FADE_DURATION_MS);

      // 剩下的逻辑继续执行（流式请求等）
      abortControllerRef.current = new AbortController();
      let streamHasError = false;
      let streamWasCancelled = false;
      
      if (developerMode) {
        try {
          const sessionId = await ensureDeveloperSession(text);
          if (sessionId) {
            await api.post(`/api/sessions/${sessionId}/messages`, {
              role: 'user',
              content: displayContent,
              model: currentModel,
            });
            if (!activeSessionId) {
              setActiveSessionId(sessionId);
            }
          }

          const mockContent = await streamMockIntoMessage(text, assistantMessageId);

          if (sessionId) {
            await api.post(`/api/sessions/${sessionId}/messages`, {
              role: 'assistant',
              content: mockContent,
              model: currentModel,
            });
            await loadSessions();
          }

          setSuggestions(buildMockSuggestions());
        } catch (e) {
          if ((e as Error).name === 'AbortError') {
            streamWasCancelled = true;
          } else {
            streamHasError = true;
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((msg) => msg.id === assistantMessageId);
              if (idx >= 0) {
                next[idx].content += `\n[Error: ${(e as Error).message}]`;
              } else {
                next.push({
                  id: assistantMessageId,
                  role: 'assistant',
                  content: `[Error: ${(e as Error).message}]`,
                  model: currentModel,
                });
              }
              return next;
            });
          }
        } finally {
          if (streamWasCancelled) {
            setStreamStatus('cancelled');
          } else if (streamHasError) {
            setStreamStatus('error');
          } else {
            setStreamStatus('done');
          }
          setQueueInfo(null);
          setIsSendingMessage(false);
          abortControllerRef.current = null;
        }
        return;
      }

      let fullContent = '';
      let fullReasoning = '';
      let isQueued = false;

      try {
        const res = await api.stream(
          '/api/chat',
          {
            session_id: activeSessionId,
            session_type: 'chat',
            message: text,
            model: currentModel,
            images: savedAttachments.filter((a) => a.type === 'image').map((a) => a.url),
            files: savedAttachments.filter((a) => a.type === 'file').map((a) => a.url),
            display_content: displayContent,
            web_search: webSearchEnabled
          },
          { signal: abortControllerRef.current.signal }
        );

        if (!activeSessionId) {
          setTimeout(loadSessions, 1000);
        }

        await consumeSseStream(res, (json) => {
          if (json.type === 'web_search' && json.results) {
            setMessages(prev => prev.map(m => m.id === assistantMessageId ? { ...m, webSearchResults: { query: json.query as string || '', results: json.results as { title: string; snippet: string; url: string }[] } } : m));
            return;
          }
          if (json.type === 'queue' && json.request_id) {
            setStreamStatus('queued');
            isQueued = true;
            setQueueInfo({
              requestId: json.request_id as string,
              position: typeof json.position === 'number' ? json.position : 0,
              estimatedWait: typeof json.estimated_wait === 'number' ? json.estimated_wait : 0,
            });
            return;
          }

          const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
          const content = typeof json.content === 'string' ? json.content : '';
          const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
          const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
          const reasoningDelta = `${reasoning}${modelReasoning}`;

          if (sessionId && !activeSessionId && !sessionIdSetRef.current) {
            sessionIdSetRef.current = true;
            setActiveSessionId(sessionId);
            loadSessions();
          }

          if (!content && !reasoningDelta) return;

          if (isQueued) {
            setQueueInfo(null);
            isQueued = false;
          }
          markStreamActive();

          if (reasoningDelta) {
            fullReasoning += reasoningDelta;
            setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
          }

          if (content) {
            let batchBuffer = '';
            let batchCount = 0;
            const BATCH_SIZE = 5;
            for (const char of Array.from(content)) {
              fullContent += char;
              batchBuffer += char;
              batchCount++;
              if (batchCount >= BATCH_SIZE) {
                setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning, true);
                batchBuffer = '';
                batchCount = 0;
              }
            }
            if (batchBuffer.length > 0) {
              setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning, true);
            }
          }
        });

        setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);

        if (fullContent.length > 20) {
          api.post('/api/chat/suggestions', { message: fullContent, model: currentModel }).then(setSuggestions).catch(() => {});
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          streamWasCancelled = true;
        } else {
          streamHasError = true;
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.findIndex((msg) => msg.id === assistantMessageId);
            if (idx >= 0) {
              next[idx].content += `\n[Error: ${(e as Error).message}]`;
            }
            return next;
          });
        }
      } finally {
        if (streamWasCancelled) {
          setStreamStatus('cancelled');
        } else if (streamHasError) {
          setStreamStatus('error');
        } else {
          setStreamStatus('done');
        }
        setRegeneratingMessageIndex(null);
        setIsSendingMessage(false);
        abortControllerRef.current = null;
      }
      return;
    }

    setHasSentFirstMessage(true);
    sessionIdSetRef.current = false;
    setInput('');
    setAttachments([]);
    setStreamStatus('pending');
    setSuggestions([]);
    setIsSendingMessage(true);

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: 'user', content: displayContent },
    ]);

    abortControllerRef.current = new AbortController();
    let streamHasError = false;
    let streamWasCancelled = false;

    if (developerMode) {
      try {
        const sessionId = await ensureDeveloperSession(text);
        if (sessionId) {
          await api.post(`/api/sessions/${sessionId}/messages`, {
            role: 'user',
            content: displayContent,
            model: currentModel,
          });
          if (!activeSessionId) {
            setActiveSessionId(sessionId);
          }
        }

        const mockContent = await streamMockIntoMessage(text, assistantMessageId);

        if (sessionId) {
          await api.post(`/api/sessions/${sessionId}/messages`, {
            role: 'assistant',
            content: mockContent,
            model: currentModel,
          });
          await loadSessions();
        }

        setSuggestions(buildMockSuggestions());
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          streamWasCancelled = true;
        } else {
          streamHasError = true;
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.findIndex((msg) => msg.id === assistantMessageId);
            if (idx >= 0) {
              next[idx].content += `\n[Error: ${(e as Error).message}]`;
            } else {
              next.push({
                id: assistantMessageId,
                role: 'assistant',
                content: `[Error: ${(e as Error).message}]`,
                model: currentModel,
              });
            }
            return next;
          });
        }
      } finally {
        if (streamWasCancelled) {
          setStreamStatus('cancelled');
        } else if (streamHasError) {
          setStreamStatus('error');
        } else {
          setStreamStatus('done');
        }
        setIsSendingMessage(false);
        abortControllerRef.current = null;
      }
      return;
    }

    let fullContent = '';
    let fullReasoning = '';
    let isQueued = false;

    try {
      const res = await api.stream(
        '/api/chat',
        {
          session_id: activeSessionId,
          session_type: 'chat',
          message: text,
          model: currentModel,
          images: savedAttachments.filter((a) => a.type === 'image').map((a) => a.url),
          files: savedAttachments.filter((a) => a.type === 'file').map((a) => a.url),
          display_content: displayContent,
          web_search: webSearchEnabled
        },
        { signal: abortControllerRef.current.signal }
      );

      if (!activeSessionId) {
        setTimeout(loadSessions, 1000);
      }

      await consumeSseStream(res, (json) => {
        if (json.type === 'web_search' && json.results) {
          setMessages(prev => prev.map(m => m.id === assistantMessageId ? { ...m, webSearchResults: { query: json.query as string || '', results: json.results as { title: string; snippet: string; url: string }[] } } : m));
          return;
        }
        if (json.type === 'queue' && json.request_id) {
          setStreamStatus('queued');
          isQueued = true;
          setQueueInfo({
            requestId: json.request_id as string,
            position: typeof json.position === 'number' ? json.position : 0,
            estimatedWait: typeof json.estimated_wait === 'number' ? json.estimated_wait : 0,
          });
          return;
        }

        const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
        const content = typeof json.content === 'string' ? json.content : '';
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const reasoningDelta = `${reasoning}${modelReasoning}`;

        if (sessionId && !activeSessionId && !sessionIdSetRef.current) {
          sessionIdSetRef.current = true;
          setActiveSessionId(sessionId);
          loadSessions();
        }

        if (!content && !reasoningDelta) return;

        if (isQueued) {
          setQueueInfo(null);
          isQueued = false;
        }
        markStreamActive();

        if (reasoningDelta) {
          fullReasoning += reasoningDelta;
          setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        }

        if (content) {
          let batchBuffer = '';
          let batchCount = 0;
          const BATCH_SIZE = 5;
          for (const char of Array.from(content)) {
            fullContent += char;
            batchBuffer += char;
            batchCount++;
            if (batchCount >= BATCH_SIZE) {
              setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning, true);
              batchBuffer = '';
              batchCount = 0;
            }
          }
          if (batchBuffer.length > 0) {
            setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning, true);
          }
        }
      });

      setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);

      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel }).then(setSuggestions).catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        streamWasCancelled = true;
      } else {
        streamHasError = true;
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((msg) => msg.id === assistantMessageId);
          if (idx >= 0) {
            next[idx].content += `\n[Error: ${(e as Error).message}]`;
          } else {
            next.push({
              id: assistantMessageId,
              role: 'assistant',
              content: `[Error: ${(e as Error).message}]`,
              model: currentModel,
            });
          }
          return next;
        });
      }
    } finally {
      if (streamWasCancelled) {
        setStreamStatus('cancelled');
      } else if (streamHasError) {
        setStreamStatus('error');
      } else {
        setStreamStatus('done');
      }
      setQueueInfo(null);
      setIsSendingMessage(false);
      abortControllerRef.current = null;
      suppressSmoothScrollRef.current = false;
    }
  };

  const handleBatchDelete = () => {
    if (selectedSessions.size === 0) return;
    setPendingDelete({ type: 'batch' });
    setShowDeleteConfirm(true);
  };

  const handleDeleteSession = (sessionId: string) => {
    setPendingDelete({ type: 'single', id: sessionId });
    setShowDeleteConfirm(true);
  };

  const handleDeleteMessage = (messageId: string | number, messageIndex: number) => {
    setPendingDelete({ type: 'message', messageId, messageIndex });
    setShowDeleteConfirm(true);
  };

  const handleEditMessage = async (messageId: string | number, messageIndex: number, newContent: string) => {
    if (!activeSessionId) return;
    try {
      if (typeof messageId === 'number') {
        await api.put(`/api/sessions/${activeSessionId}/messages/${messageId}`, { content: newContent });
      }
      setMessages((prev) => {
        const next = [...prev];
        next[messageIndex] = {
          ...next[messageIndex],
          content: newContent,
        };
        return next;
      });
    } catch (e) {
      console.error('Failed to edit message:', e);
    }
  };

  const toggleSessionSelect = (sessionId: string) => {
    const next = new Set(selectedSessions);
    if (next.has(sessionId)) {
      next.delete(sessionId);
    } else {
      next.add(sessionId);
    }
    setSelectedSessions(next);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;

    try {
      if (pendingDelete.type === 'batch') {
        const idsToDelete = Array.from(selectedSessions);
        await api.delete('/api/sessions/batch', { session_ids: idsToDelete });

        if (activeSessionId && idsToDelete.includes(activeSessionId)) {
          setActiveSessionId(null);
          setHasSentFirstMessage(false);
        }

        setSelectedSessions(new Set());
        setIsDeleteMode(false);
        loadSessions();
      } else if (pendingDelete.type === 'single') {
        await api.delete(`/api/sessions/${pendingDelete.id}`);

        if (activeSessionId === pendingDelete.id) {
          setActiveSessionId(null);
          setHasSentFirstMessage(false);
        }

        loadSessions();
      } else if (pendingDelete.type === 'message') {
        if (activeSessionId && typeof pendingDelete.messageId === 'number') {
          await api.delete(`/api/sessions/${activeSessionId}/messages/${pendingDelete.messageId}`);
        }
        setMessages((prev) => prev.filter((_, idx) => idx !== pendingDelete.messageIndex));
      }
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setPendingDelete(null);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <>
      <div className={cn('relative h-full overflow-hidden', isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)] text-slate-100' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)] text-slate-900')}>

      <aside
        className={cn(
          'mobile-history-sidebar fixed inset-y-0 left-0 w-[280px] transform-gpu px-4 pb-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-transform ease-in-out',
          showDeleteConfirm ? 'z-[31]' : 'z-[60]',
          isDark ? 'border-r border-slate-700/70 bg-[#1f2233] backdrop-blur-[24px]' : 'border-r border-[#ddd4c5] bg-[#FFFAFA] backdrop-blur-[20px]'
        )}
        style={{
          transform: `translate3d(${historyOpen ? 0 : -HISTORY_PANEL_WIDTH_PX}px, 0, 0)`,
          transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms`,
        }}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className={cn('mb-2 flex h-[60px] items-center justify-between', isDark ? 'border-b border-slate-700/70' : 'border-b border-[#ddd4c5]')}>
            <span className={cn('text-sm font-semibold', isDark ? 'text-white/95' : 'text-slate-800')}>
              {isDeleteMode ? t.batch_manage : t.chat_history}
            </span>
            <button
              onClick={() => {
                if (isDeleteMode) {
                  if (selectedSessions.size > 0) {
                    handleBatchDelete();
                  } else {
                    setIsDeleteMode(false);
                  }
                } else {
                  setIsDeleteMode(true);
                }
              }}
              className={cn(
                'inline-flex h-11 w-11 items-center justify-center rounded-full border transition-colors',
                isDeleteMode && selectedSessions.size > 0
                  ? 'border-red-400/60 bg-red-500/20 text-red-100'
                  : isDark
                  ? 'border-slate-600/80 bg-[#2d3350] text-slate-100'
                  : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700'
              )}
              aria-label="toggle-delete-mode"
            >
              {isDeleteMode ? (selectedSessions.size > 0 ? <Trash2 size={18} /> : <X size={18} />) : <Edit3 size={18} />}
            </button>
          </div>

          <ChatSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSessionSelect={handleSelectSession}
            isDeleteMode={isDeleteMode}
            setIsDeleteMode={setIsDeleteMode}
            selectedSessions={selectedSessions}
            toggleSessionSelect={toggleSessionSelect}
            onBatchDelete={handleBatchDelete}
            onNewSession={() => {
              const switchToken = sessionSwitchTokenRef.current + 1;
              sessionSwitchTokenRef.current = switchToken;
              sessionSwitchTargetRef.current = null;

              setNewSessionFadeState('fading-out');

              setSessionVisualSnapshot({
                activeSessionId,
                messages: [...messages],
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

              const resetToNewSession = () => {
                if (sessionSwitchTokenRef.current !== switchToken) {
                  return;
                }
                setActiveSessionId(null);
                setMessages([]);
                setSuggestions([]);
                setSessionVisualSnapshot(null);
                setNewSessionFadeState('fading-in');

                newSessionFadeTimerRef.current = window.setTimeout(() => {
                  if (sessionSwitchTokenRef.current !== switchToken) {
                    return;
                  }
                  setNewSessionFadeState('idle');
                  newSessionFadeTimerRef.current = null;
                }, NEW_SESSION_FADE_DURATION_MS);
              };

              if (historyOpen) {
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
            }}
            onDeleteSession={handleDeleteSession}
            showNewButton={true}
            showDeleteButton={false}
            showHeaderActions={false}
            t={t}
          />
        </div>
      </aside>

      <div
        className={cn(
          'mobile-history-main absolute inset-0 z-10 flex h-full w-full flex-col overflow-hidden transition-transform ease-in-out will-change-transform',
          isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]'
        )}
        style={{
          transform: `translate3d(${historyOpen ? HISTORY_PANEL_WIDTH_PX : 0}px, 0, 0)`,
          transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms`,
        }}
        onClick={() => {
          if (historyOpen) {
            setSidebarCollapsed(true);
          }
        }}
      >
        <div
          id="mobile-chat-top-bar"
          ref={mobileTopBarRef}
          className={cn(
            'absolute left-0 right-0 top-0 z-[18] px-5 pb-2 pt-[calc(env(safe-area-inset-top)+20px)]',
            'bg-gradient-to-b',
            isDark
              ? 'from-slate-900/100 via-slate-900/80 to-slate-900/5'
              : 'from-[#FFFAFA]/100 via-[#FFFAFA]/80 to-[#FFFAFA]/5'
          )}
        >
          <div className="mx-auto flex max-w-3xl items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className={cn(
                'h-11 w-11 rounded-full transition-all duration-300 ease-in-out',
                historyOpen && 'rotate-180'
              )}
              data-history-toggle="true"
              aria-label="toggle-history"
            >
              <Menu size={20} />
            </Button>

            <div className="flex items-center gap-2">
              {webSearchAvailable && !isWelcome && (
                <button
                  onClick={() => setWebSearchEnabled(prev => !prev)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200',
                    webSearchEnabled
                      ? cn(
                          isDark
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                        )
                      : cn(
                          isDark
                            ? 'bg-slate-700/40 text-slate-400 border border-slate-600/30 hover:bg-slate-700/60'
                            : 'bg-gray-100/80 text-slate-500 border border-gray-200/50 hover:bg-gray-200/80'
                        )
                  )}
                >
                  <Globe size={12} className={cn('transition-colors', webSearchEnabled ? 'text-emerald-500' : '')} />
                  <span>{webSearchEnabled ? '搜索开' : '搜索关'}</span>
                </button>
              )}

              <ModelSelector
                models={models}
                currentModel={currentModel}
                onSelect={setCurrentModel}
                size="sm"
                triggerStyle="mobile-inline"
                theme={isDark ? 'dark' : 'light'}
              />
            </div>
          </div>
        </div>

        {/* 双容器交叉淡入淡出：解决 iOS Safari DOM 切换闪烁问题 */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* 容器A：旧内容（欢迎页）- 淡出 */}
          <div
            className={cn(
              'flex flex-col overflow-hidden transition-opacity ease-in-out',
              newSessionFadeState === 'fading-out' || newSessionFadeState === 'fading-in' ? 'opacity-0 absolute inset-0 w-full h-full' : 'opacity-100 w-full h-full'
            )}
            style={{ 
              transitionDuration: `${NEW_SESSION_FADE_DURATION_MS}ms`,
              pointerEvents: (newSessionFadeState === 'fading-out' || newSessionFadeState === 'fading-in') ? 'none' : 'auto'
            }}
          >
            <div className={cn('flex flex-1 flex-col overflow-hidden', displayWelcome && 'items-center justify-center')}>
              {displayWelcome ? (
                <div className="w-full max-w-md -translate-y-[10vh] px-5 text-center mx-auto">
                <h1 className={cn('text-3xl font-extrabold', isDark ? 'text-[#a8c8ff]' : 'text-slate-800')}>你好呀</h1>
                <p className={cn('mt-3 text-sm', isDark ? 'text-white/70' : 'text-slate-600')}>有什么问题，随时问 AI</p>

                {developerMode && (
                  <p className={cn('mt-4 text-xs', isDark ? 'text-amber-200/90' : 'text-amber-700')}>开发者模式已开启：发送不会请求真实模型</p>
                )}

                <div ref={welcomeComposerRef} className={cn('mx-auto mt-8 w-full', welcomeDropping && 'invisible')}>
                  <ChatInput
                    value={input}
                    onChange={setInput}
                    onSend={handleSend}
                    onUpload={handleUpload}
                    attachments={attachments}
                    onRemoveAttachment={(idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                    models={models}
                    currentModel={currentModel}
                    onModelChange={setCurrentModel}
                    disabled={streaming || isSendingMessage}
                    uploading={uploading}
                    placeholder={t.ask_anything}
                    streaming={streaming}
                    onStop={handleStopStreaming}
                    variant="mobile-demo"
                    theme={isDark ? 'dark' : 'light'}
                    showModelSelector={true}
                    modelSelectorTriggerStyle="icon"
                    webSearchEnabled={webSearchEnabled}
                    onToggleWebSearch={() => setWebSearchEnabled(prev => !prev)}
                    showWebSearch={webSearchAvailable}
                  />
                </div>
                </div>
              ) : (
          <>
            <div
              ref={messagesScrollWrapRef}
              className="flex-1 min-h-0 overflow-y-auto"
            >
              <div className="px-3 pb-4">
                <div
                  ref={messageStackRef}
                  className="mx-auto max-w-3xl space-y-6"
                  style={{ paddingBottom: `${messageBottomPaddingPx}px` }}
                >
                  {needsTopSpacer && (
                    <div style={{ height: 'calc(env(safe-area-inset-top) + 4.5rem)', width: '100%' }} />
                  )}
                  {!needsTopSpacer && <div className="h-2" />}
                  {displayedMessages.map((msg, idx) => (
                    <div key={msg.id || idx} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Message
                          message={msg}
                          userAvatar={user.avatar}
                          userName={user.username}
                          models={models}
                          streaming={(streaming && idx === displayedMessages.length - 1) || regeneratingMessageIndex === idx}
                          isLast={idx === displayedMessages.length - 1}
                          t={t}
                          tokens={msg.tokens}
                          memoryStats={memoryMode === 'rule' && idx === displayedMessages.length - 1 && msg.role === 'assistant' ? memoryStats : null}
                          onCompress={memoryMode === 'rule' && idx === displayedMessages.length - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                          compressing={compressing}
                          onRegenerate={msg.role === 'assistant' && !streaming ? () => handleRegenerate(idx) : undefined}
                          canRegenerate={msg.role === 'assistant' && !streaming && idx > 0 && displayedMessages[idx - 1]?.role === 'user'}
                          onDelete={msg.id ? () => handleDeleteMessage(msg.id, idx) : undefined}
                          onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id, idx, newContent) : undefined}
                          canEdit={msg.role === 'assistant' && !streaming}
                          showSelect={false}
                          isCharacterChat={false}
                          memoryMode={memoryMode}
                          showModelReasoning={showModelReasoning}
                        />
                      </div>
                    </div>
                  ))}

                  {streamStatus === 'queued' && queueInfo && (
                    <div className="flex items-center gap-3 pl-10 animate-fade-in-up">
                      <div className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm',
                        isDark
                          ? 'bg-amber-900/20 border border-amber-700/50 text-amber-300'
                          : 'bg-amber-50 border border-amber-200 text-amber-700'
                      )}>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>排队中 · 第 {queueInfo.position + 1} 位</span>
                        {queueInfo.estimatedWait > 0 && (
                          <span className={isDark ? 'text-amber-400' : 'text-amber-500'}>· 预计 {Math.ceil(queueInfo.estimatedWait)}s</span>
                        )}
                      </div>
                    </div>
                  )}

                  {displayedSuggestions.length > 0 && !streaming && (
                    <div className="flex flex-wrap gap-2 pl-10 animate-fade-in-up">
                      {displayedSuggestions.map((s, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSend(s)}
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                            isDark
                              ? 'border-slate-600/80 bg-[#2b314c] text-slate-100 hover:bg-[#363d5c]'
                              : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f8f2e8]'
                          )}
                        >
                          <Sparkles size={10} className="mr-1 inline" />
                          {s}
                        </button>
                      ))}
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </div>
            </div>

            <div
              className={cn(
                'fixed left-0 right-0 z-[20] px-3 pt-2 animate-chat-input-appear',
                'bg-gradient-to-t from-transparent via-transparent to-transparent'
              )}
              style={{
                bottom: isKeyboardOpen ? 0 : `${composerBottomOffset > 0 ? composerBottomOffset : 90}px`,
              }}
            >
              <div ref={mobileComposerRef} className="mx-auto max-w-3xl">
                <ChatInput
                  value={input}
                  onChange={setInput}
                  onSend={handleSend}
                  onUpload={handleUpload}
                  attachments={attachments}
                  onRemoveAttachment={(idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  models={models}
                  currentModel={currentModel}
                  onModelChange={setCurrentModel}
                  disabled={streaming || isSendingMessage}
                  uploading={uploading}
                  placeholder={t.ask_anything}
                  streaming={streaming}
                  onStop={handleStopStreaming}
                  variant="mobile-demo"
                  theme={isDark ? 'dark' : 'light'}
                  showModelSelector={true}
                  modelSelectorTriggerStyle="icon"
                  webSearchEnabled={webSearchEnabled}
                  onToggleWebSearch={() => setWebSearchEnabled(prev => !prev)}
                  showWebSearch={false}
                />
              </div>
            </div>
          </>
        )}
            </div>
          </div>
          
          {/* 容器B：新内容（对话页）- 淡入 */}
          {showNewContentView && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity ease-in-out',
                newSessionFadeState === 'fading-in' || newSessionFadeState === 'idle' ? 'opacity-100' : 'opacity-0'
              )}
              style={{ transitionDuration: `${NEW_SESSION_FADE_DURATION_MS}ms` }}
            >
              <div className="flex flex-1 flex-col overflow-hidden">
            <div
              ref={messagesScrollWrapRef}
              className="flex-1 min-h-0 overflow-y-auto"
            >
              <div className="px-3 pb-4">
                <div
                  ref={messageStackRef}
                  className="mx-auto max-w-3xl space-y-6"
                  style={{ paddingBottom: `${messageBottomPaddingPx}px` }}
                >
                  {needsTopSpacer && (
                    <div style={{ height: 'calc(env(safe-area-inset-top) + 4.5rem)', width: '100%' }} />
                  )}
                  {!needsTopSpacer && <div className="h-2" />}
                  {displayedMessages.map((msg, idx) => (
                    <div key={msg.id || idx} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Message
                          message={msg}
                          userAvatar={user.avatar}
                          userName={user.username}
                          models={models}
                          streaming={(streaming && idx === displayedMessages.length - 1) || regeneratingMessageIndex === idx}
                          isLast={idx === displayedMessages.length - 1}
                          t={t}
                          tokens={msg.tokens}
                          memoryStats={memoryMode === 'rule' && idx === displayedMessages.length - 1 && msg.role === 'assistant' ? memoryStats : null}
                          onCompress={memoryMode === 'rule' && idx === displayedMessages.length - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                          compressing={compressing}
                          onRegenerate={msg.role === 'assistant' && !streaming ? () => handleRegenerate(idx) : undefined}
                          canRegenerate={msg.role === 'assistant' && !streaming && idx > 0 && displayedMessages[idx - 1]?.role === 'user'}
                          onDelete={msg.id ? () => handleDeleteMessage(msg.id, idx) : undefined}
                          onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id, idx, newContent) : undefined}
                          canEdit={msg.role === 'assistant' && !streaming}
                          showSelect={false}
                          isCharacterChat={false}
                          memoryMode={memoryMode}
                          showModelReasoning={showModelReasoning}
                        />
                      </div>
                    </div>
                  ))}

                  {streamStatus === 'queued' && queueInfo && (
                    <div className="flex items-center gap-3 pl-10 animate-fade-in-up">
                      <div className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm',
                        isDark
                          ? 'bg-amber-900/20 border border-amber-700/50 text-amber-300'
                          : 'bg-amber-50 border border-amber-200 text-amber-700'
                      )}>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>排队中 · 第 {queueInfo.position + 1} 位</span>
                        {queueInfo.estimatedWait > 0 && (
                          <span className={isDark ? 'text-amber-400' : 'text-amber-500'}>· 预计 {Math.ceil(queueInfo.estimatedWait)}s</span>
                        )}
                      </div>
                    </div>
                  )}

                  {displayedSuggestions.length > 0 && !streaming && (
                    <div className="flex flex-wrap gap-2 pl-10 animate-fade-in-up">
                      {displayedSuggestions.map((s, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSend(s)}
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                            isDark
                              ? 'border-slate-600/80 bg-[#2b314c] text-slate-100 hover:bg-[#363d5c]'
                              : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f8f2e8]'
                          )}
                        >
                          <Sparkles size={10} className="mr-1 inline" />
                          {s}
                        </button>
                      ))}
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </div>
            </div>

            <div
              className={cn(
                'fixed left-0 right-0 z-[20] px-3 pt-2 animate-chat-input-appear',
                'bg-gradient-to-t from-transparent via-transparent to-transparent'
              )}
              style={{
                bottom: isKeyboardOpen ? 0 : `${composerBottomOffset > 0 ? composerBottomOffset : 90}px`,
              }}
            >
              <div ref={mobileComposerRef} className="mx-auto max-w-3xl">
                <ChatInput
                  value={input}
                  onChange={setInput}
                  onSend={handleSend}
                  onUpload={handleUpload}
                  attachments={attachments}
                  onRemoveAttachment={(idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  models={models}
                  currentModel={currentModel}
                  onModelChange={setCurrentModel}
                  disabled={streaming || isSendingMessage}
                  uploading={uploading}
                  placeholder={t.ask_anything}
                  streaming={streaming}
                  onStop={handleStopStreaming}
                  variant="mobile-demo"
                  theme={isDark ? 'dark' : 'light'}
                  showModelSelector={true}
                  modelSelectorTriggerStyle="icon"
                  webSearchEnabled={webSearchEnabled}
                  onToggleWebSearch={() => setWebSearchEnabled(prev => !prev)}
                  showWebSearch={false}
                />
              </div>
            </div>
              </div>
            </div>
          )}
        </div>

      <ConfirmDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
          title={
            pendingDelete?.type === 'batch'
              ? `${t.delete_selected}?`
              : pendingDelete?.type === 'message'
              ? '删除消息?'
              : `${t.delete_chat}?`
          }
          description={
            pendingDelete?.type === 'batch'
              ? `确定要删除选中的 ${selectedSessions.size} 个对话吗？此操作无法撤销。`
              : pendingDelete?.type === 'message'
              ? '确定要删除这条消息吗？此操作无法撤销。'
              : '确定要删除这个对话吗？此操作无法撤销。'
          }
          onConfirm={confirmDelete}
          confirmText={t.ok}
          cancelText={t.cancel}
        />

        {welcomeDropping && welcomeDropSnapshot && (
          <div
            className="pointer-events-none fixed z-[24] animate-welcome-drop"
            style={{
              top: `${welcomeDropSnapshot.top}px`,
              left: `${welcomeDropSnapshot.left}px`,
              width: `${welcomeDropSnapshot.width}px`,
              ['--welcome-drop-distance' as string]: `${welcomeDropDistance}px`,
              ['--welcome-drop-duration' as string]: `${WELCOME_DROP_DURATION_MS}ms`,
            }}
          >
            <ChatInput
              value={welcomeDropInputValue}
              onChange={() => {}}
              onSend={() => {}}
              onUpload={() => Promise.resolve()}
              attachments={[]}
              onRemoveAttachment={() => {}}
              models={models}
              currentModel={currentModel}
              onModelChange={() => {}}
              disabled={true}
              uploading={false}
              placeholder={t.ask_anything}
              streaming={false}
              onStop={() => {}}
              variant="mobile-demo"
              theme={isDark ? 'dark' : 'light'}
              showModelSelector={true}
              modelSelectorTriggerStyle="icon"
              showWebSearch={false}
            />
          </div>
        )}
      </div>
      </div>
    </>
  );
};
