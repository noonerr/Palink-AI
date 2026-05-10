import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/services/api';
import { buildMockSuggestions, streamMockAssistantReply } from '@/lib/mockChatStream';
import type { Message as MessageType, Model, Session } from '@/types';

type StreamStatus = 'idle' | 'pending' | 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface MemoryStats {
  message_count: number;
  token_count: number;
  oldest_message_hours: number;
  compression_needed: boolean;
  compression_reason: string;
}

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
  thumbnail?: string;
  size?: number;
}

export interface UseChatViewParams {
  currentModel: string;
  t: Record<string, string>;
}

export const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

export function useChatView({ currentModel, t }: UseChatViewParams) {
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
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [showMessageSelect, setShowMessageSelect] = useState(false);
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [developerMode, setDeveloperMode] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);

  const streaming = streamStatus === 'pending' || streamStatus === 'queued' || streamStatus === 'streaming';

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const sessionIdSetRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const pendingInitialBottomLockRef = useRef(false);
  const initialBottomLockUntilRef = useRef(0);
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  const INITIAL_BOTTOM_LOCK_MS = 1500;

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
        if (data.compression_needed) {
          await autoCompressMemory(sessionId);
        }
      }
    } catch (e) {
      console.error('Failed to load memory stats:', e);
    }
  }, []);

  const autoCompressMemory = async (sessionId: string) => {
    if (loadingSessionRef.current !== sessionId) return;
    try {
      const data = await api.post('/api/memory/compress', { session_id: sessionId, compression_ratio: 0.5 });
      if (loadingSessionRef.current === sessionId && data?.compressed_count > 0) {
        console.log('Memory auto-compressed:', data.message);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.error('Auto compress failed:', e);
      }
    }
  };

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
    return `<<HIDE_THINKING_START>>${reasoning}<<HIDE_THINKING_END>>\n${content}`;
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

  const loadMessages = useCallback(async (sessionId: string) => {
    if (lastLoadedSessionIdRef.current === sessionId) return;
    lastLoadedSessionIdRef.current = sessionId;
    try {
      setSuggestions([]);
      const data = await api.get<MessageType[]>(`/api/sessions/${sessionId}/messages`);
      setMessages(data);
      pendingInitialBottomLockRef.current = data.length > 0;
      initialBottomLockUntilRef.current = performance.now() + INITIAL_BOTTOM_LOCK_MS;
      await loadMemoryStats(sessionId);
      const lastMsg = data[data.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.length > 20) {
        if (suggestionsAbortRef.current) {
          suggestionsAbortRef.current.abort();
        }
        suggestionsAbortRef.current = new AbortController();
        const currentAbortController = suggestionsAbortRef.current;
        api.post('/api/chat/suggestions', { message: lastMsg.content, model: currentModel }, { signal: currentAbortController.signal })
          .then((data: string[]) => {
            if (Array.isArray(data) && !currentAbortController.signal.aborted) {
              setSuggestions(data);
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
    if (!pendingInitialBottomLockRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streaming]);

  useEffect(() => {
    if (!activeSessionId || messages.length === 0) {
      pendingInitialBottomLockRef.current = false;
      return;
    }
    if (!pendingInitialBottomLockRef.current) return;
    if (performance.now() >= initialBottomLockUntilRef.current) {
      pendingInitialBottomLockRef.current = false;
      return;
    }
    let rafA: number | null = null;
    let rafB: number | null = null;
    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        pendingInitialBottomLockRef.current = false;
      });
    });
    return () => {
      if (rafA !== null) cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [activeSessionId, messages.length]);

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

  const handleRegenerate = useCallback(async (messageIndex: number) => {
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
    let fullContent = '';
    let fullReasoning = '';
    let streamHasError = false;
    let streamWasCancelled = false;
    let isQueued = false;

    if (developerMode) {
      try {
        fullContent = await streamMockIntoMessage(userMessage.content, assistantMessageId);
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
        setRegeneratingMessageIndex(null);
        setIsSendingMessage(false);
        abortControllerRef.current = null;
      }
      return;
    }

    try {
      const res = await api.stream('/api/chat', {
        session_id: activeSessionId,
        session_type: 'chat',
        message: userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim(),
        model: currentModel,
        images: [],
        files: [],
      }, { signal: abortControllerRef.current.signal });

      await consumeSseStream(res, (json) => {
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
        if (content.startsWith('Error:')) {
          streamHasError = true;
          const errorMsg = content.replace('Error: ', '');
          setMessages((prev) => {
            const newMessages = [...prev];
            if (newMessages[assistantMessageIndex]) {
              newMessages[assistantMessageIndex].content += `\n\n❌ 错误: ${errorMsg}`;
            }
            return newMessages;
          });
          return;
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
          fullContent += content;
          setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        }
      });

      setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel })
          .then(setSuggestions)
          .catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        streamWasCancelled = true;
      } else {
        streamHasError = true;
        setMessages((prev) => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex].content += `\n[Error: ${(e as Error).message}]`;
          return newMessages;
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
  }, [streaming, uploading, messages, currentModel, activeSessionId, developerMode, markStreamActive, setAssistantMessageSnapshot, streamMockIntoMessage, consumeSseStream]);

  const handleSend = useCallback(async (overrideText?: string, webSearchEnabled = false) => {
    const text = typeof overrideText === 'string' ? overrideText : input;
    if ((!text.trim() && attachments.length === 0) || streaming || uploading) return;

    let displayContent = text;
    const savedAttachments = [...attachments];
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach((att) => {
        displayContent += att.type === 'image' ? `![${att.name}](${att.url})\n` : `[📎 ${att.name}](${att.url})\n`;
      });
    }

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
      { id: assistantMessageId, role: 'assistant', content: '', model: currentModel },
    ]);

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    let streamHasError = false;
    let streamWasCancelled = false;
    let isQueued = false;

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
        fullContent = await streamMockIntoMessage(text, assistantMessageId);
        if (sessionId) {
          await api.post(`/api/sessions/${sessionId}/messages`, {
            role: 'assistant',
            content: fullContent,
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

    try {
      const res = await api.stream('/api/chat', {
        session_id: activeSessionId,
        session_type: 'chat',
        message: text,
        model: currentModel,
        images: savedAttachments.filter((a) => a.type === 'image').map((a) => a.url),
        files: savedAttachments.filter((a) => a.type === 'file').map((a) => a.url),
        display_content: displayContent,
        web_search: webSearchEnabled,
      }, { signal: abortControllerRef.current.signal });

      if (!activeSessionId) {
        setTimeout(loadSessions, 1000);
      }

      await consumeSseStream(res, (json) => {
        if (json.type === 'web_search' && json.results) {
          setMessages((prev) => prev.map((m) => m.id === assistantMessageId ? { ...m, webSearchResults: { query: json.query as string || '', results: json.results as { title: string; snippet: string; url: string }[] } } : m));
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
          fullContent += content;
          setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        }
      });

      setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel })
          .then(setSuggestions)
          .catch(() => {});
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
      setIsSendingMessage(false);
      abortControllerRef.current = null;
    }
  }, [input, attachments, streaming, uploading, currentModel, activeSessionId, developerMode, markStreamActive, setAssistantMessageSnapshot, streamMockIntoMessage, consumeSseStream, loadSessions, ensureDeveloperSession]);

  const handleSelectSession = (session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    setActiveSessionId(sessionId);
  };

  const handleBatchDelete = () => {
    if (selectedSessions.size === 0) return;
    setPendingDelete({ type: 'batch' });
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      if (pendingDelete.type === 'batch') {
        const idsToDelete = Array.from(selectedSessions);
        await api.delete('/api/sessions/batch', { session_ids: idsToDelete });
        if (activeSessionId && idsToDelete.includes(activeSessionId)) {
          setActiveSessionId(null);
        }
        setSelectedSessions(new Set());
        setIsDeleteMode(false);
        loadSessions();
      } else if (pendingDelete.type === 'single') {
        await api.delete(`/api/sessions/${pendingDelete.id}`);
        if (activeSessionId === pendingDelete.id) {
          setActiveSessionId(null);
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

  const toggleSessionSelect = (sessionId: string) => {
    const next = new Set(selectedSessions);
    if (next.has(sessionId)) {
      next.delete(sessionId);
    } else {
      next.add(sessionId);
    }
    setSelectedSessions(next);
  };

  const handleDeleteSession = (sessionId: string) => {
    setPendingDelete({ type: 'single', id: sessionId });
    setShowDeleteConfirm(true);
  };

  const handleDeleteMessage = (messageId: number, messageIndex: number) => {
    setPendingDelete({ type: 'message', messageId, messageIndex });
    setShowDeleteConfirm(true);
  };

  const toggleMessageSelect = (messageId: string) => {
    const next = new Set(selectedMessages);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    setSelectedMessages(next);
  };

  const handleDeleteSelectedMessages = async () => {
    if (!activeSessionId || selectedMessages.size === 0) return;
    try {
      for (const messageId of Array.from(selectedMessages)) {
        await api.delete(`/api/sessions/${activeSessionId}/messages/${messageId}`);
      }
      setMessages((prev) => prev.filter((m) => m.id === undefined || !selectedMessages.has(String(m.id))));
      setSelectedMessages(new Set());
      setShowMessageSelect(false);
    } catch (e) {
      console.error('Delete messages failed:', e);
    }
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

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    setMessages,
    input,
    setInput,
    streamStatus,
    setStreamStatus,
    queueInfo,
    setQueueInfo,
    attachments,
    setAttachments,
    uploading,
    isDeleteMode,
    setIsDeleteMode,
    selectedSessions,
    suggestions,
    setSuggestions,
    showDeleteConfirm,
    setShowDeleteConfirm,
    pendingDelete,
    selectedMessages,
    showMessageSelect,
    setShowMessageSelect,
    regeneratingMessageIndex,
    setRegeneratingMessageIndex,
    memoryStats,
    setMemoryStats,
    compressing,
    memoryMode,
    developerMode,
    isSendingMessage,
    setIsSendingMessage,
    streaming,
    messagesEndRef,
    abortControllerRef,
    handleStopStreaming,
    loadMemoryStats,
    manualCompressMemory,
    loadSessions,
    loadMessages,
    handleUpload,
    handleRegenerate,
    handleSend,
    handleSelectSession,
    handleBatchDelete,
    confirmDelete,
    toggleSessionSelect,
    handleDeleteSession,
    handleDeleteMessage,
    toggleMessageSelect,
    handleDeleteSelectedMessages,
    handleEditMessage,
    markStreamActive,
    consumeSseStream,
    setAssistantMessageSnapshot,
    ensureDeveloperSession,
    streamMockIntoMessage,
    sessionIdSetRef,
    loadingSessionRef,
    pendingInitialBottomLockRef,
    initialBottomLockUntilRef,
  };
}
