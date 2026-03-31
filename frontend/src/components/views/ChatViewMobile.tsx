import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, X, Edit3, Trash2, Menu, ChevronLeft } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import { buildMockSuggestions, streamMockAssistantReply } from '@/lib/mockChatStream';
import type { Message as MessageType, Model, Session } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

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
  const [welcomeDropOffset, setWelcomeDropOffset] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const sessionIdSetRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const welcomeComposerRef = useRef<HTMLDivElement>(null);

  const isWelcome = messages.length === 0 && !activeSessionId;
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
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((msg) => msg.id === assistantMessageId);
          if (idx === -1) return next;
          next[idx] = {
            ...next[idx],
            content: fullContent,
          };
          return next;
        });
      },
      { signal: abortControllerRef.current?.signal }
    );
    return fullContent;
  }, []);

  const runWelcomeInputDropAnimation = useCallback(async () => {
    const composer = welcomeComposerRef.current;
    const dock = document.querySelector('nav[data-dock="true"]');

    let offset = 220;
    if (composer && dock instanceof HTMLElement) {
      const composerRect = composer.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const targetTop = dockRect.top - composerRect.height - 14;
      offset = targetTop - composerRect.top;
    }

    setWelcomeDropOffset(offset);
    setWelcomeDropping(true);
    await new Promise((resolve) => setTimeout(resolve, 420));
  }, []);

  const handleSelectSession = (session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    setActiveSessionId(sessionId);
    setSidebarCollapsed(true);
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  useEffect(() => {
    if (isWelcome) {
      setWelcomeDropping(false);
      setWelcomeDropOffset(0);
    }
  }, [isWelcome]);

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
        if (!content) return;

        fullContent += content;
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((msg) => msg.id === assistantMessageId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              content: fullContent,
            };
          }
          return next;
        });
      });

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
      await runWelcomeInputDropAnimation();
    }

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
      { id: assistantMessageId, role: 'assistant', content: '', model: currentModel },
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

        if (sessionId && !activeSessionId && !sessionIdSetRef.current) {
          sessionIdSetRef.current = true;
          setActiveSessionId(sessionId);
          loadSessions();
        }

        if (!content) return;

        fullContent += content;
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((msg) => msg.id === assistantMessageId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              content: fullContent,
            };
          }
          return next;
        });
      });

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
      setIsSendingMessage(false);
      abortControllerRef.current = null;
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

  return (
    <div className={cn('relative flex h-full overflow-hidden mobile-theme-bg', isDark ? 'text-slate-100' : 'text-slate-900')}>
      {historyOpen && <div className={cn('fixed inset-0 z-[59]', isDark ? 'bg-black/45' : 'bg-black/25')} onClick={() => setSidebarCollapsed(true)} />}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-[60] w-[280px] transform-gpu px-4 pb-4 pt-20 transition-transform duration-300 ease-in-out',
          isDark ? 'border-r border-slate-700/70 bg-[#1f2233] backdrop-blur-[24px]' : 'border-r border-[#ddd4c5] bg-[#FFFAFA] backdrop-blur-[20px]',
          historyOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className={cn('mb-2 flex h-[54px] items-center justify-between', isDark ? 'border-b border-slate-700/70' : 'border-b border-[#ddd4c5]')}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarCollapsed(true)}
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-full border',
                  isDark ? 'border-slate-600/80 bg-[#2d3350] text-slate-100' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700'
                )}
                aria-label="close-history"
              >
                <ChevronLeft size={16} />
              </button>
              <span className={cn('text-sm font-semibold', isDark ? 'text-white/95' : 'text-slate-800')}>
                {isDeleteMode ? t.batch_manage : t.chat_history}
              </span>
            </div>
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
                'inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
                isDeleteMode && selectedSessions.size > 0
                  ? 'border-red-400/60 bg-red-500/20 text-red-100'
                  : isDark
                  ? 'border-slate-600/80 bg-[#2d3350] text-slate-100'
                  : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700'
              )}
              aria-label="toggle-delete-mode"
            >
              {isDeleteMode ? (selectedSessions.size > 0 ? <Trash2 size={14} /> : <X size={14} />) : <Edit3 size={14} />}
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
              setActiveSessionId(null);
              setSidebarCollapsed(true);
            }}
            onDeleteSession={handleDeleteSession}
            showNewButton={true}
            showDeleteButton={false}
            showHeaderActions={false}
            t={t}
          />
        </div>
      </aside>

      <div className={cn('relative z-10 flex h-full min-w-0 flex-1 flex-col overflow-hidden transition-transform duration-300 ease-in-out', historyOpen && 'translate-x-[280px]')}>
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className={cn(
            'fixed left-5 top-[calc(env(safe-area-inset-top)+24px)] z-[70] flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-[30px] transition-all duration-300 ease-in-out',
            isDark ? 'border-slate-600/80 bg-[#2d3350] text-slate-100' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700',
            historyOpen && (isDark
              ? 'left-[216px] rotate-180 bg-[#3a4263] shadow-[0_0_12px_rgba(15,23,42,0.42)]'
              : 'left-[216px] rotate-180 bg-[#f5eee2] shadow-[0_0_12px_rgba(120,106,79,0.2)]')
          )}
          data-history-toggle="true"
          aria-label="toggle-history"
        >
          <Menu size={20} />
        </button>

        {isWelcome ? (
          <div className="flex flex-1 items-center justify-center px-5 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-14">
            <div className="w-full max-w-md text-center">
              <h1 className={cn('text-3xl font-extrabold', isDark ? 'text-[#a8c8ff]' : 'text-slate-800')}>你好呀</h1>
              <p className={cn('mt-3 text-sm', isDark ? 'text-white/70' : 'text-slate-600')}>有什么问题，随时问 AI</p>

              {developerMode && (
                <p className={cn('mt-4 text-xs', isDark ? 'text-amber-200/90' : 'text-amber-700')}>开发者模式已开启：发送不会请求真实模型</p>
              )}

              <div
                ref={welcomeComposerRef}
                className="mx-auto mt-8 w-full transition-[transform,opacity]"
                style={{
                  transform: welcomeDropping ? `translateY(${welcomeDropOffset}px)` : 'translateY(0)',
                  opacity: welcomeDropping ? 0.86 : 1,
                  transitionDuration: '420ms',
                  transitionTimingFunction: 'cubic-bezier(0.22, 0.65, 0.22, 1)',
                }}
              >
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
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-hidden pt-14">
              <ScrollArea className="h-full px-3 py-4">
                <div className={`mx-auto max-w-3xl space-y-6 ${bottomPadding}`}>
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
              </ScrollArea>
            </div>

            <div className={cn(
              'border-t px-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl',
              isDark ? 'border-slate-700/70 bg-[#1f2233]' : 'border-[#ddd4c5] bg-[#FFFAFA]'
            )}>
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
                <p className={cn('mt-2 text-center text-[10px]', isDark ? 'text-white/60' : 'text-slate-500')}>
                  {t.ai_disclaimer}
                </p>
              </div>
            </div>
          </>
        )}

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
      </div>
    </div>
  );
};
