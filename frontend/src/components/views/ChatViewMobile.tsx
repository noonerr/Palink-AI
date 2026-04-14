import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, X, Edit3, Trash2, Menu } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import { buildMockSuggestions, streamMockAssistantReply } from '@/lib/mockChatStream';
import type { Message as MessageType, Model, Session } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

const WELCOME_DROP_DURATION_MS = 760;

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
  showModelReasoning?: boolean;
}

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
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
  showModelReasoning = true,
}) => {
  const bottomPadding = useMobileBottomPadding();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
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

  const [welcomeDropping, setWelcomeDropping] = useState(false);
  const [welcomeDropDistance, setWelcomeDropDistance] = useState(0);
  const [welcomeDropSnapshot, setWelcomeDropSnapshot] = useState<{ top: number; left: number; width: number } | null>(null);
  const [welcomeDropInputValue, setWelcomeDropInputValue] = useState('');
  const [needsTopSpacer, setNeedsTopSpacer] = useState(false);
  const [messageFadeState, setMessageFadeState] = useState<'visible' | 'fading-out' | 'fading-in'>('visible');
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);
  const [overscrollY, setOverscrollY] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const sessionIdSetRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const welcomeComposerRef = useRef<HTMLDivElement>(null);
  const messagesScrollWrapRef = useRef<HTMLDivElement>(null);
  const messageStackRef = useRef<HTMLDivElement>(null);
  const mobileTopBarRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);
  const isBouncing = useRef(false);
  const suppressSmoothScrollRef = useRef(false);
  const welcomeDropTimerRef = useRef<number | null>(null);

  const isWelcome = messages.length === 0 && !activeSessionId;
  const displayWelcome = isWelcome || welcomeDropping;
  const historyOpen = !sidebarCollapsed;

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
      alert(`记忆压缩完成！\n删除: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
      await loadMemoryStats(activeSessionId);
    } catch (e) {
      console.error('Manual compress failed:', e);
      alert('压缩失败');
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
        fullContent += chunk;
        setAssistantMessageSnapshot(assistantMessageId, fullContent, '');
      },
      { signal: abortControllerRef.current?.signal }
    );
    return fullContent;
  }, [setAssistantMessageSnapshot]);

  useEffect(() => {
    return () => {
      if (welcomeDropTimerRef.current !== null) {
        window.clearTimeout(welcomeDropTimerRef.current);
      }
    };
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
    setMessageFadeState('fading-out');
    setSidebarCollapsed(true);
    setHasSentFirstMessage(false); // 切换会话时重置状态
    setTimeout(() => {
      setActiveSessionId(sessionId);
      setMessageFadeState('fading-in');
      setTimeout(() => {
        setMessageFadeState('visible');
      }, 300);
    }, 300);
  };

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const data = await api.get<MessageType[]>(`/api/sessions/${sessionId}/messages`);
      setMessages(data);
      setSuggestions([]);

      await loadMemoryStats(sessionId);

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
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, [currentModel, loadMemoryStats]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (activeSessionId && !isSendingMessage) {
      setMemoryStats(null);
      loadMessages(activeSessionId);
    } else if (!activeSessionId) {
      setMessages([]);
      setSuggestions([]);
      setMemoryStats(null);
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

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const el = messagesScrollWrapRef.current;
    if (!el) return;
    const touchY = e.touches[0].clientY;
    const scrollTop = el.scrollTop;
    const isAtTop = scrollTop <= 0;
    const isAtBottom = scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((isAtTop && touchY > touchStartY.current) || (isAtBottom && touchY < touchStartY.current)) {
      isBouncing.current = true;
      const delta = touchY - touchStartY.current;
      const maxOverscroll = 80;
      let overscroll: number;
      if (isAtTop && delta > 0) {
        overscroll = Math.min(delta * 0.4, maxOverscroll);
      } else if (isAtBottom && delta < 0) {
        overscroll = Math.max(delta * 0.4, -maxOverscroll);
      } else {
        return;
      }
      setOverscrollY(overscroll);
    }
  };

  const handleTouchEnd = () => {
    if (!isBouncing.current) return;
    isBouncing.current = false;
    setOverscrollY(0);
    touchStartY.current = 0;
  };

  const handleUpload = async (file: File, type: 'image' | 'file') => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve) => {
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(file);
      });

      const data = await api.post('/api/upload', { filename: file.name, data: dataUrl });
      setAttachments((prev) => [...prev, { type, name: file.name, url: data.url }]);
    } catch (e) {
      console.error('Upload failed:', e);
    } finally {
      setUploading(false);
    }
  };

  const consumeSseStream = useCallback(
    async (res: Response, onJson: (json: Record<string, unknown>) => void) => {
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Invalid stream response');

      const decoder = new TextDecoder();
      let buffer = '';

      const processChunk = (chunk: string) => {
        buffer += chunk;
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const lines = event.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            try {
              onJson(JSON.parse(data));
            } catch {
              // Keep stream resilient for malformed chunks.
            }
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processChunk(decoder.decode(value, { stream: true }));
      }

      const tail = decoder.decode();
      if (tail) processChunk(tail);
    },
    []
  );

  const handleRegenerate = async (messageIndex: number) => {
    if (streaming || uploading || messageIndex < 1) return;

    const assistantMessageIndex = messageIndex;
    const userMessageIndex = assistantMessageIndex - 1;
    if (userMessageIndex < 0) return;

    const userMessage = messages[userMessageIndex];
    if (userMessage.role !== 'user') return;

    setRegeneratingMessageIndex(assistantMessageIndex);
    setStreaming(true);
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

    if (developerMode) {
      try {
        await streamMockIntoMessage(userMessage.content, assistantMessageId);
        setSuggestions(buildMockSuggestions());
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
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
        setStreaming(false);
        setRegeneratingMessageIndex(null);
        setIsSendingMessage(false);
        abortControllerRef.current = null;
      }
      return;
    }

    let fullContent = '';
    let fullReasoning = '';

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
        const content = typeof json.content === 'string' ? json.content : '';
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const reasoningDelta = `${reasoning}${modelReasoning}`;

        if (!content && !reasoningDelta) return;

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
      if ((e as Error).name !== 'AbortError') {
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
      setStreaming(false);
      setRegeneratingMessageIndex(null);
      setIsSendingMessage(false);
      abortControllerRef.current = null;
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = typeof overrideText === 'string' ? overrideText : input;
    if ((!text.trim() && attachments.length === 0) || streaming || uploading) return;

    if (!activeSessionId && messages.length === 0 && !welcomeDropping) {
      suppressSmoothScrollRef.current = true;
      runWelcomeInputDropAnimation(text);
    }

    setHasSentFirstMessage(true);
    sessionIdSetRef.current = false;
    setInput('');
    setAttachments([]);
    setStreaming(true);
    setSuggestions([]);
    setIsSendingMessage(true);

    let displayContent = text;
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach((att) => {
        displayContent += att.type === 'image' ? `![${att.name}](${att.url})\n` : `[📎 ${att.name}](${att.url})\n`;
      });
    }

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: 'user', content: displayContent },
    ]);

    abortControllerRef.current = new AbortController();

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
        if ((e as Error).name !== 'AbortError') {
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
        setStreaming(false);
        setIsSendingMessage(false);
        abortControllerRef.current = null;
      }
      return;
    }

    let fullContent = '';
    let fullReasoning = '';

    try {
      const res = await api.stream(
        '/api/chat',
        {
          session_id: activeSessionId,
          session_type: 'chat',
          message: text,
          model: currentModel,
          images: attachments.filter((a) => a.type === 'image').map((a) => a.url),
          files: attachments.filter((a) => a.type === 'file').map((a) => a.url),
        },
        { signal: abortControllerRef.current.signal }
      );

      if (!activeSessionId) {
        setTimeout(loadSessions, 1000);
      }

      await consumeSseStream(res, (json) => {
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

        if (reasoningDelta) {
          fullReasoning += reasoningDelta;
          setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        }

        if (content) {
          for (const char of Array.from(content)) {
            fullContent += char;
            setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning, true);
          }
        }
      });

      setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);

      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel }).then(setSuggestions).catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
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
      setStreaming(false);
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

  const handleDeleteMessage = (messageId: number, messageIndex: number) => {
    setPendingDelete({ type: 'message', messageId, messageIndex });
    setShowDeleteConfirm(true);
  };

  const handleEditMessage = async (messageId: number, messageIndex: number, newContent: string) => {
    if (!activeSessionId) return;
    try {
      await api.put(`/api/sessions/${activeSessionId}/messages/${messageId}`, { content: newContent });
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
        if (activeSessionId) {
          await api.delete(`/api/sessions/${activeSessionId}/messages/${pendingDelete.messageId}`);
          setMessages((prev) => prev.filter((_, idx) => idx !== pendingDelete.messageIndex));
        }
      }
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setPendingDelete(null);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className={cn('relative flex h-full overflow-hidden', isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)] text-slate-100' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)] text-slate-900')}>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 w-[280px] transform-gpu px-4 pb-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-transform duration-300 ease-in-out',
          showDeleteConfirm ? 'z-[31]' : 'z-[60]',
          isDark ? 'border-r border-slate-700/70 bg-[#1f2233] backdrop-blur-[24px]' : 'border-r border-[#ddd4c5] bg-[#FFFAFA] backdrop-blur-[20px]',
          historyOpen ? 'translate-x-0' : '-translate-x-full'
        )}
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
              setMessageFadeState('fading-out');
              setSidebarCollapsed(true);
              setTimeout(() => {
                setActiveSessionId(null);
                setMessageFadeState('fading-in');
                setTimeout(() => {
                  setMessageFadeState('visible');
                }, 300);
              }, 300);
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
          'relative z-10 flex h-full min-w-0 flex-1 flex-col overflow-hidden',
          'transition-transform duration-300 ease-in-out',
          historyOpen && 'translate-x-[280px]'
        )}
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
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-[30px] transition-all duration-300 ease-in-out',
                isDark ? 'border-slate-600/80 bg-[#2d3350] text-white' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700',
                historyOpen && (isDark
                  ? 'rotate-180 bg-[#3a4263] shadow-[0_0_12px_rgba(15,23,42,0.42)]'
                  : 'rotate-180 bg-[#f5eee2] shadow-[0_0_12px_rgba(120,106,79,0.2)]')
              )}
              data-history-toggle="true"
              aria-label="toggle-history"
            >
              <Menu size={20} />
            </button>

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

        <div
          className={cn(
            'flex flex-1 overflow-hidden transition-opacity duration-200',
            messageFadeState === 'fading-out' && 'opacity-0',
            messageFadeState === 'fading-in' && 'animate-fade-in',
            messageFadeState === 'visible' && 'opacity-100'
          )}
        >
          <div className={cn('flex flex-1 flex-col overflow-hidden', displayWelcome && 'items-center justify-center')}>
            {displayWelcome ? (
              <div className="w-full max-w-md -translate-y-[10vh] px-5 text-center">
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
                  disabled={streaming}
                  uploading={uploading}
                  placeholder={t.ask_anything}
                  streaming={streaming}
                  onStop={() => abortControllerRef.current?.abort()}
                  variant="mobile-demo"
                  theme={isDark ? 'dark' : 'light'}
                  showModelSelector={true}
                  modelSelectorTriggerStyle="icon"
                />
              </div>
              </div>
            ) : (
          <>
            <div
              ref={messagesScrollWrapRef}
              className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain"
              style={{ transform: `translateY(${overscrollY}px)`, transition: overscrollY === 0 ? 'transform 0.4s cubic-bezier(0.32, 0.72, 0, 1)' : 'none' }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <div className="px-3 pb-4">
                <div
                  ref={messageStackRef}
                  className={cn(
                    'mx-auto max-w-3xl space-y-6',
                    bottomPadding
                  )}
                >
                  {needsTopSpacer && (
                    <div style={{ height: 'calc(env(safe-area-inset-top) + 4.5rem)', width: '100%' }} />
                  )}
                  {!needsTopSpacer && <div className="h-2" />}
                  {messages.map((msg, idx) => (
                    <div key={msg.id || idx} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Message
                          message={msg}
                          userAvatar={user.avatar}
                          userName={user.username}
                          models={models}
                          streaming={(streaming && idx === messages.length - 1) || regeneratingMessageIndex === idx}
                          isLast={idx === messages.length - 1}
                          t={t}
                          tokens={msg.tokens}
                          memoryStats={memoryMode === 'rule' && idx === messages.length - 1 && msg.role === 'assistant' ? memoryStats : null}
                          onCompress={memoryMode === 'rule' && idx === messages.length - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                          compressing={compressing}
                          onRegenerate={msg.role === 'assistant' && !streaming ? () => handleRegenerate(idx) : undefined}
                          canRegenerate={msg.role === 'assistant' && !streaming && idx > 0 && messages[idx - 1]?.role === 'user'}
                          onDelete={msg.id ? () => handleDeleteMessage(msg.id as number, idx) : undefined}
                          onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id as number, idx, newContent) : undefined}
                          canEdit={msg.role === 'assistant' && !streaming}
                          showSelect={false}
                          isCharacterChat={false}
                          memoryMode={memoryMode}
                          showModelReasoning={showModelReasoning}
                        />
                      </div>
                    </div>
                  ))}

                  {suggestions.length > 0 && !streaming && (
                    <div className="flex flex-wrap gap-2 pl-10 animate-fade-in-up">
                      {suggestions.map((s, idx) => (
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
                'z-[20] px-3 pb-[calc(94px+min(env(safe-area-inset-bottom),8px))] pt-2 animate-chat-input-appear'
              )}
            >
              <div className="mx-auto max-w-3xl">
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
                  disabled={streaming}
                  uploading={uploading}
                  placeholder={t.ask_anything}
                  streaming={streaming}
                  onStop={() => abortControllerRef.current?.abort()}
                  variant="mobile-demo"
                  theme={isDark ? 'dark' : 'light'}
                  showModelSelector={true}
                  modelSelectorTriggerStyle="icon"
                />
              </div>
            </div>
            <p className={cn('z-[20] text-center text-[10px]', isDark ? 'text-white/60' : 'text-slate-500')}>
              {t.ai_disclaimer}
            </p>
          </>
        )}
        </div>
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
            />
          </div>
        )}
      </div>
    </div>
  );
};
