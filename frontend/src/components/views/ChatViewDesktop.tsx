import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, MessageSquarePlus, X, Edit3, Trash2, Menu, ChevronLeft, ChevronRight } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import { buildMockSuggestions, streamMockAssistantReply } from '@/lib/mockChatStream';
import { consumeSseStream } from '@/lib/sseStream';
import type { Message as MessageType, Model, Session } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

type StreamStatus = 'idle' | 'pending' | 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

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
  thumbnail?: string;
  size?: number;
}



export const ChatViewDesktop: React.FC<ChatViewProps> = ({
  token: _token,
  user,
  models,
  currentModel,
  setCurrentModel,
  t,
  sidebarCollapsed,
  setSidebarCollapsed,
  isDark: _isDark,
  showModelReasoning = true,
}) => {
  const bottomPadding = useMobileBottomPadding();
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
  const [pendingDelete, setPendingDelete] = useState<{ type: 'single'; id: string } | { type: 'batch' } | { type: 'message'; messageId: number; messageIndex: number } | null>(null);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [showMessageSelect, setShowMessageSelect] = useState(false);
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  const [memoryStats, setMemoryStats] = useState<{
    message_count: number;
    token_count: number;
    oldest_message_hours: number;
    compression_needed: boolean;
    compression_reason: string;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [memoryMode, setMemoryMode] = useState<string>("rule");
  const [developerMode, setDeveloperMode] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const streaming = streamStatus === 'pending' || streamStatus === 'queued' || streamStatus === 'streaming';

  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const sessionIdSetRef = useRef(false);
  const pendingInitialBottomLockRef = useRef(false);
  const initialBottomLockUntilRef = useRef(0);
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
  
  // Load memory stats with session ID tracking to prevent race conditions
  const loadingSessionRef = useRef<string | null>(null);
  
  const loadMemoryStats = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    
    // Track which session we're loading
    loadingSessionRef.current = sessionId;
    
    try {
      const data = await api.get(`/api/memory/stats?session_id=${sessionId}`);
      
      // Only update if this is still the current session being loaded
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

  // Auto compress memory
  const autoCompressMemory = async (sessionId: string) => {
    // Only proceed if this is still the current session
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

  // Manual compress memory
  const manualCompressMemory = async () => {
    if (!activeSessionId || compressing) return;
    setCompressing(true);
    try {
      const data = await api.post('/api/memory/compress', {
        session_id: activeSessionId,
        compression_ratio: 0.5
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

  // Load sessions
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

  // Load messages for active session
  const handleSelectSession = (session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    setActiveSessionId(sessionId);
  };

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      setMessages([]);
      setSuggestions([]);
      setMemoryStats(null);
      
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
        
        api.post('/api/chat/suggestions',
          { message: lastMsg.content, model: currentModel },
          { signal: currentAbortController.signal }
        )
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
      // Reset memory stats when switching sessions
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
    if (!pendingInitialBottomLockRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streaming]);

  useEffect(() => {
    if (!activeSessionId || messages.length === 0) {
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
      setAttachments(prev => [...prev, {
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
    
    setMessages(prev => {
      const newMessages = [...prev];
      newMessages[assistantMessageIndex] = { 
        id: assistantMessageId, 
        role: 'assistant', 
        content: '', 
        model: currentModel 
      };
      return newMessages;
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
          setMessages(prev => {
            const newMessages = [...prev];
            const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
            if (assistantIdx >= 0) {
              newMessages[assistantIdx].content += `\n[Error: ${(e as Error).message}]`;
            }
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
          files: []
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
          setMessages(prev => {
            const newMessages = [...prev];
            if (newMessages[assistantMessageIndex]) {
              newMessages[assistantMessageIndex].content += `\n\n❌ 错误: ${errorMsg}`;
            }
            return newMessages;
          });
          return;
        }

        if (!content && !reasoningDelta) {
          return;
        }

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
        setMessages(prev => {
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
  };

  const handleSend = async (overrideText?: string) => {
    const text = typeof overrideText === 'string' ? overrideText : input;
    if ((!text.trim() && attachments.length === 0) || streaming || uploading) return;

    // 在清空状态之前先构建好 displayContent 并保存 attachments
    let displayContent = text;
    const savedAttachments = [...attachments];
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach(att => {
        displayContent += att.type === 'image' 
          ? `![${att.name}](${att.url})\n`
          : `[📎 ${att.name}](${att.url})\n`;
      });
    }

    sessionIdSetRef.current = false; // 重置会话ID设置标记
    setInput('');
    setAttachments([]);
    setStreamStatus('pending');
    setSuggestions([]);
    setIsSendingMessage(true);

    // Add user message and placeholder for assistant with unique IDs
    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    setMessages(prev => [
      ...prev,
      { id: userMessageId, role: 'user', content: displayContent },
      { id: assistantMessageId, role: 'assistant', content: '', model: currentModel }
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
          setMessages(prev => {
            const newMessages = [...prev];
            const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
            if (assistantIdx >= 0) {
              newMessages[assistantIdx].content += `\n[Error: ${(e as Error).message}]`;
            }
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
          images: savedAttachments.filter(a => a.type === 'image').map(a => a.url),
          files: savedAttachments.filter(a => a.type === 'file').map(a => a.url),
          display_content: displayContent
        }, { signal: abortControllerRef.current.signal });

      if (!activeSessionId) {
        setTimeout(loadSessions, 1000);
      }

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

        if (!content && !reasoningDelta) {
          return;
        }

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

      // Get suggestions after message completes
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
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content += `\n[Error: ${(e as Error).message}]`;
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
      setIsSendingMessage(false);
      abortControllerRef.current = null;
    }
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
        if (activeSessionId && typeof pendingDelete.messageId === 'number') {
          await api.delete(`/api/sessions/${activeSessionId}/messages/${pendingDelete.messageId}`);
        }
        setMessages(prev => prev.filter((_, idx) => idx !== pendingDelete.messageIndex));
      }
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setPendingDelete(null);
      setShowDeleteConfirm(false);
    }
  };

  const toggleSessionSelect = (sessionId: string) => {
    const newSet = new Set(selectedSessions);
    if (newSet.has(sessionId)) {
      newSet.delete(sessionId);
    } else {
      newSet.add(sessionId);
    }
    setSelectedSessions(newSet);
  };

  const handleDeleteSession = (sessionId: string) => {
    setPendingDelete({ type: 'single', id: sessionId });
    setShowDeleteConfirm(true);
  };

  const handleDeleteMessage = (messageId: string | number, messageIndex: number) => {
    setPendingDelete({ type: 'message', messageId, messageIndex });
    setShowDeleteConfirm(true);
  };

  const toggleMessageSelect = (messageId: string) => {
    const newSet = new Set(selectedMessages);
    if (newSet.has(messageId)) {
      newSet.delete(messageId);
    } else {
      newSet.add(messageId);
    }
    setSelectedMessages(newSet);
  };

  const handleDeleteSelectedMessages = async () => {
    if (!activeSessionId || selectedMessages.size === 0) return;
    try {
      for (const messageId of Array.from(selectedMessages)) {
        await api.delete(`/api/sessions/${activeSessionId}/messages/${messageId}`);
      }
      setMessages(prev => prev.filter(m => m.id === undefined || !selectedMessages.has(String(m.id))));
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
      setMessages(prev => {
        const newMessages = [...prev];
        newMessages[messageIndex] = {
          ...newMessages[messageIndex],
          content: newContent
        };
        return newMessages;
      });
    } catch (e) {
      console.error('Failed to edit message:', e);
    }
  };



  // Welcome Screen
  if (messages.length === 0 && !activeSessionId) {
    const currentModelObj = models.find(m => m.id === currentModel) || models[0];

    return (
      <div className="flex h-full overflow-hidden">
        {/* Mobile Backdrop */}
        {!sidebarCollapsed && (
          <div
            className="fixed inset-0 z-[59] bg-black/40 md:hidden"
            onClick={() => setSidebarCollapsed(true)}
          />
        )}
        {/* Sidebar */}
        <div className={`transition-all duration-300 ease-in-out overflow-hidden fixed inset-y-0 left-0 z-[60] md:relative ${!sidebarCollapsed ? 'w-64 opacity-100' : 'w-0 opacity-0'}`}>
          <div className="w-64 h-full flex-shrink-0 glass flex flex-col overflow-hidden shadow-lg md:shadow-none pt-[env(safe-area-inset-top)]">
            {/* Header */}
            <div className="h-[54px] flex items-center justify-between px-4 shrink-0 border-b border-border/50">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setSidebarCollapsed(true)}
                >
                  <ChevronLeft size={16} />
                </Button>
                <span className="text-sm font-semibold text-foreground">
                  {isDeleteMode ? t.batch_manage : t.chat_history}
                </span>
              </div>
              <div className="flex gap-1">
                <Button
                  variant={isDeleteMode && selectedSessions.size > 0 ? "destructive" : "ghost"}
                  size="icon"
                  className={cn(
                    "h-8 w-8",
                    isDeleteMode && selectedSessions.size === 0 && "text-destructive hover:bg-destructive/10"
                  )}
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
                >
                  {isDeleteMode ? (
                    selectedSessions.size > 0 ? (
                      <Trash2 size={14} />
                    ) : (
                      <X size={14} />
                    )
                  ) : (
                    <Edit3 size={14} />
                  )}
                </Button>
              </div>
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
              onNewSession={() => setActiveSessionId(null)}
              onDeleteSession={handleDeleteSession}
              showNewButton={true}
              showDeleteButton={false}
              showHeaderActions={false}
              t={t}
            />
          </div>
        </div>


        {/* Chat Area */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {/* Header */}
          <div className="h-[54px] flex items-center justify-between px-3 md:px-6 border-b border-border/50 glass z-10">
            <div className="flex items-center gap-2 min-w-0">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className="md:hidden h-10 w-10 shrink-0"
              >
                <Menu size={18} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex h-8 w-8 rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-all shrink-0"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              >
                {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </Button>
              <div className="min-w-0 flex-1">
                <ModelSelector
                  models={models}
                  currentModel={currentModel}
                  onSelect={setCurrentModel}
                />
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                onClick={() => setActiveSessionId(null)}
                className="h-8 px-2 sm:px-3"
              >
                <MessageSquarePlus size={16} className="sm:mr-1.5" />
                <span className="hidden sm:inline">新对话</span>
              </Button>
            </div>
          </div>

          {/* Welcome Content */}
          <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-auto overscroll-y-contain">
            <div className={`w-full max-w-2xl flex flex-col items-center animate-fade-in-up ${bottomPadding}`}>
              {/* Model Display */}
              <div className="mb-10 text-center">
                <div className="w-24 h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                  {(() => {
                    const icon = currentModelObj?.icon;
                    if (icon && (icon.startsWith('/') || icon.startsWith('http') || icon.startsWith('data:'))) {
                      return <img src={icon} alt="" className="w-full h-full object-cover" />;
                    }
                    return <span>{icon || '🤖'}</span>;
                  })()}
                </div>
                <h1 className="text-3xl font-semibold mb-2">
                  {currentModelObj?.alias || currentModelObj?.name}
                </h1>
                <p className="text-muted-foreground">
                  {currentModelObj?.description || t.welcome_greeting}
                </p>
              </div>
            </div>
          </div>

          {/* Input Area */}
          <div className="p-2 border-t border-border/50 pb-20 md:pb-4">
            <div className="max-w-3xl mx-auto">
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onUpload={handleUpload}
                attachments={attachments}
                onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                disabled={streaming}
                uploading={uploading}
                placeholder={t.ask_anything}
                streaming={streaming}
                onStop={handleStopStreaming}
              />
              <p className="text-center mt-2 text-[10px] text-muted-foreground/60">
                {t.ai_disclaimer}
              </p>
            </div>
          </div>
        </div>
        <ConfirmDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
          title={pendingDelete?.type === 'batch' ? t.delete_selected + '?' : pendingDelete?.type === 'message' ? '删除消息?' : t.delete_chat + '?'}
          description={pendingDelete?.type === 'batch' 
            ? `确定要删除选中的 ${selectedSessions.size} 个对话吗？此操作无法撤销。`
            : pendingDelete?.type === 'message' 
              ? "确定要删除这条消息吗？删除后该内容将从上下文中移除，AI将不再保留此记忆。此操作无法撤销。"
              : "确定要删除这个对话吗？此操作无法撤销。"}
          onConfirm={confirmDelete}
          confirmText={t.ok}
          cancelText={t.cancel}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Mobile Backdrop */}
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 z-[59] bg-black/40 md:hidden"
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      {/* Sidebar */}
      <div className={`transition-all duration-300 ease-in-out overflow-hidden fixed inset-y-0 left-0 z-[60] md:relative ${!sidebarCollapsed ? 'w-64 opacity-100' : 'w-0 opacity-0'}`}>
        <div className="w-64 h-full flex-shrink-0 glass flex flex-col overflow-hidden shadow-lg md:shadow-none pt-[env(safe-area-inset-top)]">
          {/* Header */}
          <div className="h-14 flex items-center justify-between px-4 shrink-0 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full hover:bg-accent hover:text-accent-foreground"
                onClick={() => setSidebarCollapsed(true)}
              >
                <ChevronLeft size={16} />
              </Button>
              <span className="text-sm font-semibold text-foreground">
                {isDeleteMode ? t.batch_manage : t.chat_history}
              </span>
            </div>
            <div className="flex gap-1">
              <Button
                variant={isDeleteMode && selectedSessions.size > 0 ? "destructive" : "ghost"}
                size="icon"
                className={cn(
                  "h-8 w-8",
                  isDeleteMode && selectedSessions.size === 0 && "text-destructive hover:bg-destructive/10"
                )}
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
              >
                {isDeleteMode ? (
                  selectedSessions.size > 0 ? (
                    <Trash2 size={14} />
                  ) : (
                    <X size={14} />
                  )
                ) : (
                  <Edit3 size={14} />
                )}
              </Button>
            </div>
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
            onNewSession={() => setActiveSessionId(null)}
            onDeleteSession={handleDeleteSession}
            showNewButton={true}
            showDeleteButton={false}
            showHeaderActions={false}
            t={t}
          />
        </div>
      </div>


      {/* Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-3 md:px-6 border-b border-border/50 glass z-10">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="md:hidden h-10 w-10 shrink-0"
            >
              <Menu size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:flex h-8 w-8 rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-all shrink-0"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </Button>
            <div className="min-w-0 flex-1">
              <ModelSelector
                models={models}
                currentModel={currentModel}
                onSelect={setCurrentModel}
              />
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
              {activeSessionId && messages.length > 0 && (
                <>
                  <Button
                    variant={showMessageSelect ? "default" : "ghost"}
                    size="icon"
                    className="h-9 w-9 rounded-lg transition-all"
                    onClick={() => {
                      setShowMessageSelect(!showMessageSelect);
                      if (showMessageSelect) {
                        setSelectedMessages(new Set());
                      }
                    }}
                    title={showMessageSelect ? "退出选择模式" : "选择消息"}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="m9 12 2 2 4-4"/></svg>
                  </Button>
                  {showMessageSelect && selectedMessages.size > 0 && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-8 px-2 sm:px-3"
                      onClick={handleDeleteSelectedMessages}
                    >
                      <Trash2 size={14} className="sm:mr-1.5" />
                      <span className="hidden sm:inline">删除 </span>{selectedMessages.size} 条
                    </Button>
                  )}
                </>
              )}
              <Button
                size="sm"
                onClick={() => setActiveSessionId(null)}
                className="h-8 px-2 sm:px-3"
              >
                <MessageSquarePlus size={16} className="sm:mr-1.5" />
                <span className="hidden sm:inline">新对话</span>
              </Button>
            </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full px-3 sm:px-6 py-4 sm:py-6">
            <div className={`max-w-3xl mx-auto space-y-6 ${bottomPadding}`}>
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
                      onDelete={msg.id ? () => handleDeleteMessage(msg.id, idx) : undefined}
                      onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id, idx, newContent) : undefined}
                      canEdit={msg.role === 'assistant' && !streaming}
                      isSelected={msg.id !== undefined ? selectedMessages.has(String(msg.id)) : false}
                      onToggleSelect={msg.id !== undefined ? () => toggleMessageSelect(String(msg.id)) : undefined}
                      showSelect={showMessageSelect}
                      isCharacterChat={false}
                      memoryMode={memoryMode}
                      showModelReasoning={showModelReasoning}
                    />
                  </div>
                </div>
              ))}

              {streamStatus === 'queued' && queueInfo && (
                <div className="flex items-center gap-3 pl-12 animate-fade-in-up">
                  <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 text-amber-700 dark:text-amber-300 text-sm">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>排队中 · 第 {queueInfo.position + 1} 位</span>
                    {queueInfo.estimatedWait > 0 && (
                      <span className="text-amber-500 dark:text-amber-400">· 预计 {Math.ceil(queueInfo.estimatedWait)}s</span>
                    )}
                  </div>
                </div>
              )}
              
              {/* Suggestions */}
              {suggestions.length > 0 && !streaming && (
                <div className="flex flex-wrap gap-2 pl-12 animate-fade-in-up">
                  {suggestions.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSend(s)}
                      className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-full text-xs font-medium transition-colors"
                    >
                      <Sparkles size={10} className="inline mr-1" />
                      {s}
                    </button>
                  ))}
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
        </div>

        {/* Input Area */}
        <div className="p-2 border-t border-border/50 pb-20 md:pb-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              onUpload={handleUpload}
              attachments={attachments}
              onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
              disabled={streaming}
              uploading={uploading}
              placeholder={t.ask_anything}
              streaming={streaming}
              onStop={handleStopStreaming}
            />
            <p className="text-center mt-2 text-[10px] text-muted-foreground/60">
              {t.ai_disclaimer}
            </p>
          </div>
        </div>
        <ConfirmDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
          title={pendingDelete?.type === 'batch' ? t.delete_selected + '?' : pendingDelete?.type === 'message' ? '删除消息?' : t.delete_chat + '?'}
          description={pendingDelete?.type === 'batch' 
            ? `确定要删除选中的 ${selectedSessions.size} 个对话吗？此操作无法撤销。`
            : pendingDelete?.type === 'message' 
              ? "确定要删除这条消息吗？删除后该内容将从上下文中移除，AI将不再保留此记忆。此操作无法撤销。"
              : "确定要删除这个对话吗？此操作无法撤销。"}
          onConfirm={confirmDelete}
          confirmText={t.ok}
          cancelText={t.cancel}
        />

      </div>
    </div>
  );
};
