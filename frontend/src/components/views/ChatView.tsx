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
import type { Message as MessageType, Model, Session } from '@/types';

// Generate unique ID for messages
const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

interface ChatViewProps {
  token: string;
  user: { avatar?: string; username: string };
  models: Model[];
  defaultModel: string;
  starterQuestions: string[];
  t: Record<string, string>;
}

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
}



export const ChatView: React.FC<ChatViewProps> = ({
  token: _token,
  user,
  models,
  defaultModel,
  starterQuestions,
  t
}) => {
  const bottomPadding = useMobileBottomPadding();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [currentModel, setCurrentModel] = useState(defaultModel);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ type: 'single'; id: string } | { type: 'batch' } | { type: 'message'; messageId: number; messageIndex: number } | null>(null);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [showMessageSelect, setShowMessageSelect] = useState(false);
  
  // Regenerate state
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  
  // Memory compression state
  const [memoryStats, setMemoryStats] = useState<{
    message_count: number;
    token_count: number;
    oldest_message_hours: number;
    compression_needed: boolean;
    compression_reason: string;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [memoryMode, setMemoryMode] = useState<string>("rule");
  const [isSendingMessage, setIsSendingMessage] = useState(false);

  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const sessionIdSetRef = useRef(false);
  
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
      alert(`记忆压缩完成！\n删除: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
      await loadMemoryStats(activeSessionId);
    } catch (e) {
      console.error('Manual compress failed:', e);
      alert('压缩失败');
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

  // Load messages for active session
  const handleSelectSession = (session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    setActiveSessionId(sessionId);
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
    setCurrentModel(defaultModel);
  }, [defaultModel]);

  const handleUpload = async (file: File, type: 'image' | 'file') => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve) => {
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(file);
      });

      const data = await api.post('/api/upload', { filename: file.name, data: dataUrl });
      setAttachments(prev => [...prev, { type, name: file.name, url: data.url }]);
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
              // Ignore malformed events to keep stream resilient.
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
        const content = typeof json.content === 'string' ? json.content : '';
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';

        if (content.startsWith('Error:')) {
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

        if (!content && !reasoning && !modelReasoning) {
          return;
        }

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) fullContent += content;

        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex] = {
            ...newMessages[assistantMessageIndex],
            content: fullContent
          };
          return newMessages;
        });
      });
      
      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel })
          .then(setSuggestions)
          .catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex].content += `\n[Error: ${(e as Error).message}]`;
          return newMessages;
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

    sessionIdSetRef.current = false; // 重置会话ID设置标记
    setInput('');
    setAttachments([]);
    setStreaming(true);
    setSuggestions([]);
    setIsSendingMessage(true);

    // Build display content with attachments
    let displayContent = text;
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach(att => {
        displayContent += att.type === 'image' 
          ? `![${att.name}](${att.url})\n`
          : `[📎 ${att.name}](${att.url})\n`;
      });
    }

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

    try {
      const res = await api.stream('/api/chat', {
          session_id: activeSessionId,
          session_type: 'chat',
          message: text,
          model: currentModel,
          images: attachments.filter(a => a.type === 'image').map(a => a.url),
          files: attachments.filter(a => a.type === 'file').map(a => a.url)
        }, { signal: abortControllerRef.current.signal });

      if (!activeSessionId) {
        setTimeout(loadSessions, 1000);
      }

      await consumeSseStream(res, (json) => {
        const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
        const content = typeof json.content === 'string' ? json.content : '';
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';

        // 处理会话 ID（新会话）- 只设置一次
        if (sessionId && !activeSessionId && !sessionIdSetRef.current) {
          sessionIdSetRef.current = true;
          setActiveSessionId(sessionId);
          loadSessions();
        }

        if (!content && !reasoning && !modelReasoning) {
          return;
        }

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) fullContent += content;

        setMessages(prev => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];
          newMessages[newMessages.length - 1] = {
            ...lastMessage,
            content: fullContent
          };
          return newMessages;
        });
      });

      // Get suggestions after message completes
      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel })
          .then(setSuggestions)
          .catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content += `\n[Error: ${(e as Error).message}]`;
          return newMessages;
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
          setMessages(prev => prev.filter((_, idx) => idx !== pendingDelete.messageIndex));
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

  const handleDeleteMessage = (messageId: number, messageIndex: number) => {
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

  const handleEditMessage = async (messageId: number, messageIndex: number, newContent: string) => {
    if (!activeSessionId) return;
    
    try {
      await api.put(`/api/sessions/${activeSessionId}/messages/${messageId}`, { content: newContent });
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

              {/* Starter Questions */}
              {starterQuestions.length > 0 && (
                <div className="w-full max-w-xl">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4 text-center">
                    <Sparkles size={12} className="inline mr-1" />
                    {t.suggested_topics}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {starterQuestions.map((q, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSend(q)}
                        className="px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-xl text-sm text-foreground/80 hover:text-foreground transition-all hover:scale-105"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
                models={models}
                currentModel={currentModel}
                onModelChange={setCurrentModel}
                disabled={streaming}
                uploading={uploading}
                placeholder={t.ask_anything}
                streaming={streaming}
                onStop={() => abortControllerRef.current?.abort()}
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
                      <span className="hidden sm:inline">删除 </span>{selectedMessages.size} 条
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
                      onDelete={msg.id ? () => handleDeleteMessage(msg.id as number, idx) : undefined}
                      onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id as number, idx, newContent) : undefined}
                      canEdit={msg.role === 'assistant' && !streaming}
                      isSelected={msg.id !== undefined ? selectedMessages.has(String(msg.id)) : false}
                      onToggleSelect={msg.id !== undefined ? () => toggleMessageSelect(String(msg.id)) : undefined}
                      showSelect={showMessageSelect}
                      isCharacterChat={false}
                      memoryMode={memoryMode}
                    />
                  </div>
                </div>
              ))}
              
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
              models={models}
              currentModel={currentModel}
              onModelChange={setCurrentModel}
              disabled={streaming}
              uploading={uploading}
              placeholder={t.ask_anything}
              streaming={streaming}
              onStop={() => abortControllerRef.current?.abort()}
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
