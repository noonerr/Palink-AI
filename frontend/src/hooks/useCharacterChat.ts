import { useState, useRef, useCallback } from 'react';
import { api } from '@/services/api';
import { analyzeError, type ErrorInfo } from '@/lib/errorHandler';
import { consumeSseStream } from '@/lib/sseStream';
import type { Character, CharacterChatMessage, CharacterChatSession, CharacterChatSessionBranch, GenerationPreset } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

export interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
  thumbnail?: string;
  size?: number;
}

interface UseCharacterChatOptions {
  selectedCharacter: Character | null;
  selectedSession: CharacterChatSession | null;
  selectedModel: string;
  dialogueMode: 'first_person' | 'third_person';
  selectedBranch: CharacterChatSessionBranch | null;
  currentPreset: GenerationPreset | null;
  getDisplayName: (character?: Character | Partial<Character> | null) => string;
  messages: CharacterChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<CharacterChatMessage[]>>;
  setSelectedSession: (session: CharacterChatSession | null) => void;
  loadSessions: (characterId: string) => Promise<void>;
  loadMemoryStats: (sessionId: string) => Promise<void>;
  forkPoint: { branchId: string; messageId: number } | null;
  onForkCreated: () => void;
  onBranchCreated: (branch: { id: string; branch_name: string; is_active: boolean }) => void;
}

const TIMEOUT_WARNING_MS = 15000;

export function useCharacterChat({
  selectedCharacter,
  selectedSession,
  selectedModel,
  dialogueMode,
  selectedBranch,
  currentPreset,
  getDisplayName,
  messages,
  setMessages,
  setSelectedSession,
  loadSessions,
  loadMemoryStats,
  forkPoint,
  onForkCreated,
  onBranchCreated,
}: UseCharacterChatOptions) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);

  // Error handling state
  const [currentError, setCurrentError] = useState<ErrorInfo | null>(null);
  const [retryMessageContent, setRetryMessageContent] = useState<string>('');
  const [retryMessageImages, setRetryMessageImages] = useState<string[]>([]);

  // Timeout state
  const [timeoutWarning, setTimeoutWarning] = useState(false);
  const [requestStartTime, setRequestStartTime] = useState<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleRegenerate = useCallback(async (messageIndex: number) => {
    if (!selectedCharacter || isGenerating || uploading || messageIndex < 1) return;

    const assistantMessageIndex = messageIndex;
    const userMessageIndex = assistantMessageIndex - 1;
    if (userMessageIndex < 0) return;

    const userMessage = messages[userMessageIndex];
    if (userMessage.role !== 'user') return;

    setRegeneratingMessageIndex(assistantMessageIndex);
    setIsGenerating(true);
    setSuggestions([]);

    const assistantMessageId = generateMessageId();
    setMessages(prev => {
      const newMessages = [...prev];
      newMessages[assistantMessageIndex] = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        model: selectedModel,
      };
      return newMessages;
    });

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    let resolvedSessionId: string | null = selectedSession?.id || null;
    let sessionSynced = false;
    let effectiveBranchId = selectedBranch?.id;

    if (forkPoint && selectedSession) {
      try {
        const resp = await api.post(`/api/character-sessions/${selectedSession.id}/branches`, {
          session_id: selectedSession.id,
          parent_branch_id: forkPoint.branchId,
          parent_message_id: forkPoint.messageId,
          same_level: false,
        });
        if (resp?.branch?.id) {
          effectiveBranchId = resp.branch.id;
          onBranchCreated(resp.branch);
        }
        onForkCreated();
      } catch (e: any) {
        console.error('Failed to create fork branch:', e);
        onForkCreated();
      }
    }

    try {
      const response = await api.stream('/api/character-chat', {
        session_id: selectedSession?.id ?? null,
        character_id: selectedCharacter.id,
        message: userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim(),
        model: selectedModel,
        temperature: currentPreset?.temperature ?? 0.7,
        top_p: currentPreset?.top_p ?? 0.9,
        max_tokens: currentPreset?.max_tokens ?? 2048,
        frequency_penalty: currentPreset?.frequency_penalty ?? 0,
        presence_penalty: currentPreset?.presence_penalty ?? 0,
        dialogue_mode: dialogueMode,
        branch_id: effectiveBranchId,
        user_nickname: getDisplayName(selectedCharacter),
        images: [],
        files: [],
      }, { signal: abortControllerRef.current.signal });

      await consumeSseStream(response, (json) => {
        const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const content = typeof json.content === 'string' ? json.content : '';

        if (sessionId) {
          resolvedSessionId = sessionId;
          if (!selectedSession && !sessionSynced) {
            sessionSynced = true;
            const now = new Date().toISOString();
            setSelectedSession({
              id: sessionId,
              dialogue_mode: dialogueMode,
              created_at: now,
              updated_at: now,
            });
            loadSessions(selectedCharacter.id);
          }
        }

        if (!reasoning && !modelReasoning && !content) return;

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) fullContent += content;

        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
          if (assistantIdx === -1) return newMessages;

          newMessages[assistantIdx] = {
            ...newMessages[assistantIdx],
            content: fullReasoning
              ? `<think>${fullReasoning}</think>${fullContent}`
              : fullContent,
          };
          return newMessages;
        });
      });

      if (resolvedSessionId) {
        await loadMemoryStats(resolvedSessionId);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
          if (assistantIdx >= 0) {
            newMessages[assistantIdx].content += `\n[Error: ${e.message}]`;
          }
          return newMessages;
        });
      }
    } finally {
      setIsGenerating(false);
      setRegeneratingMessageIndex(null);
      abortControllerRef.current = null;
    }
  }, [selectedCharacter, selectedSession, selectedModel, dialogueMode, selectedBranch, currentPreset, isGenerating, uploading, messages, getDisplayName, setMessages, setSelectedSession, loadSessions, loadMemoryStats]);

  const handleSendMessage = useCallback(async (content: string, images: string[]) => {
    if (!selectedCharacter) return;

    const text = content || inputValue;
    if ((!text.trim() && attachments.length === 0) || isGenerating || uploading) return;

    let effectiveBranchId = selectedBranch?.id;

    if (forkPoint && selectedSession) {
      try {
        const resp = await api.post(`/api/character-sessions/${selectedSession.id}/branches`, {
          session_id: selectedSession.id,
          parent_branch_id: forkPoint.branchId,
          parent_message_id: forkPoint.messageId,
          same_level: false,
        });
        if (resp?.branch?.id) {
          effectiveBranchId = resp.branch.id;
          onBranchCreated(resp.branch);
        }
        onForkCreated();
      } catch (e: any) {
        console.error('Failed to create fork branch:', e);
        onForkCreated();
      }
    }

    const pendingAttachments = attachments;
    const outgoingImages = pendingAttachments.length > 0
      ? pendingAttachments.filter(a => a.type === 'image').map(a => a.url)
      : images;
    const outgoingFiles = pendingAttachments.filter(a => a.type === 'file').map(a => a.url);

    setCurrentError(null);
    setTimeoutWarning(false);
    setInputValue('');
    setAttachments([]);
    setIsGenerating(true);
    setSuggestions([]);

    setRetryMessageContent(text);
    setRetryMessageImages(outgoingImages);

    setRequestStartTime(Date.now());
    timeoutRef.current = window.setTimeout(() => {
      setTimeoutWarning(true);
    }, TIMEOUT_WARNING_MS);

    let displayContent = text;
    if (pendingAttachments.length > 0) {
      displayContent += '\n\n';
      pendingAttachments.forEach(att => {
        displayContent += att.type === 'image'
          ? `![${att.name}](${att.url})\n`
          : `[📎 ${att.name}](${att.url})\n`;
      });
    }

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    setMessages(prev => [
      ...prev,
      { id: userMessageId, role: 'user', content: displayContent, model: selectedModel },
      { id: assistantMessageId, role: 'assistant', content: '', model: selectedModel },
    ]);

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    let hasReceivedData = false;
    let resolvedSessionId: string | null = selectedSession?.id || null;
    let sessionSynced = false;

    try {
      const response = await api.stream('/api/character-chat', {
        session_id: selectedSession?.id ?? null,
        character_id: selectedCharacter.id,
        message: text,
        model: selectedModel,
        temperature: currentPreset?.temperature ?? 0.7,
        top_p: currentPreset?.top_p ?? 0.9,
        max_tokens: currentPreset?.max_tokens ?? 2048,
        frequency_penalty: currentPreset?.frequency_penalty ?? 0,
        presence_penalty: currentPreset?.presence_penalty ?? 0,
        dialogue_mode: dialogueMode,
        branch_id: effectiveBranchId,
        user_nickname: getDisplayName(selectedCharacter),
        images: outgoingImages,
        files: outgoingFiles,
      }, { signal: abortControllerRef.current.signal });

      if (!selectedSession) {
        loadSessions(selectedCharacter.id);
      }

      await consumeSseStream(response, (json) => {
        if (!hasReceivedData) {
          hasReceivedData = true;
          setTimeoutWarning(false);
          if (timeoutRef.current) {
            window.clearTimeout(timeoutRef.current);
          }
        }

        const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const content = typeof json.content === 'string' ? json.content : '';

        if (sessionId) {
          resolvedSessionId = sessionId;
          if (!selectedSession && !sessionSynced) {
            sessionSynced = true;
            const now = new Date().toISOString();
            setSelectedSession({
              id: sessionId,
              dialogue_mode: dialogueMode,
              created_at: now,
              updated_at: now,
            });
            loadSessions(selectedCharacter.id);
          }
        }

        if (!reasoning && !modelReasoning && !content) return;

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) fullContent += content;

        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
          if (assistantIdx === -1) return newMessages;

          newMessages[assistantIdx] = {
            ...newMessages[assistantIdx],
            content: fullReasoning
              ? `<think>${fullReasoning}</think>${fullContent}`
              : fullContent,
          };
          return newMessages;
        });
      });

      if (resolvedSessionId) {
        await loadMemoryStats(resolvedSessionId);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        const errorInfo = analyzeError(e);
        setCurrentError(errorInfo);

        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
          if (assistantIdx >= 0) {
            newMessages[assistantIdx].content =
              `⚠️ **${errorInfo.title}**\n\n${errorInfo.description}\n\n💡 ${errorInfo.suggestion}`;
          }
          return newMessages;
        });
      }
    } finally {
      setIsGenerating(false);
      setRequestStartTime(null);
      setTimeoutWarning(false);
      abortControllerRef.current = null;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    }
  }, [selectedCharacter, selectedSession, selectedModel, dialogueMode, selectedBranch, currentPreset, inputValue, attachments, isGenerating, uploading, getDisplayName, setMessages, setSelectedSession, loadSessions, loadMemoryStats, forkPoint, onForkCreated, onBranchCreated]);

  const handleSendWithInput = useCallback(async () => {
    if (inputValue.trim() || attachments.length > 0) {
      await handleSendMessage(inputValue, attachments.filter(a => a.type === 'image').map(a => a.url));
    }
  }, [inputValue, attachments, handleSendMessage]);

  const handleRetry = useCallback(() => {
    if (retryMessageContent) {
      setCurrentError(null);
      handleSendMessage(retryMessageContent, retryMessageImages);
    }
  }, [retryMessageContent, retryMessageImages, handleSendMessage]);

  const handleCloseError = useCallback(() => {
    setCurrentError(null);
  }, []);

  const handleUpload = useCallback(async (file: File, type: 'image' | 'file') => {
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
  }, []);

  const handleDeleteMessage = useCallback(async (messageId: number, messageIndex: number) => {
    if (!selectedSession) return;
    try {
      await api.delete(`/api/character-sessions/${selectedSession.id}/messages/${messageId}`);
      setMessages(prev => prev.filter((msg, idx) => {
        if (msg.id != null) {
          return String(msg.id) !== String(messageId);
        }
        return idx !== messageIndex;
      }));
    } catch (e) {
      console.error('Failed to delete message:', e);
    }
  }, [selectedSession, setMessages]);

  const handleEditMessage = useCallback(async (messageId: string | number, messageIndex: number, newContent: string) => {
    if (!selectedSession) return;
    try {
      if (typeof messageId === 'number') {
        await api.put(`/api/character-sessions/${selectedSession.id}/messages/${messageId}`, { content: newContent });
      }
      setMessages(prev => {
        const newMessages = [...prev];
        const targetIndex = newMessages.findIndex((msg) => String(msg.id) === String(messageId));
        const safeIndex = targetIndex >= 0 ? targetIndex : messageIndex;
        if (safeIndex < 0 || safeIndex >= newMessages.length) {
          return newMessages;
        }

        newMessages[safeIndex] = {
          ...newMessages[safeIndex],
          content: newContent,
        };
        return newMessages;
      });
    } catch (e) {
      console.error('Failed to edit message:', e);
    }
  }, [selectedSession, setMessages]);

  // Cleanup on unmount
  const cleanupTimeout = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }
  }, []);

  return {
    // State
    isGenerating,
    inputValue,
    setInputValue,
    attachments,
    setAttachments,
    uploading,
    suggestions,
    setSuggestions,
    regeneratingMessageIndex,
    currentError,
    retryMessageContent,
    timeoutWarning,
    requestStartTime,

    // Handlers
    handleSendMessage,
    handleSendWithInput,
    handleRegenerate,
    handleRetry,
    handleCloseError,
    handleUpload,
    handleDeleteMessage,
    handleEditMessage,
    abortControllerRef,
    cleanupTimeout,
  };
}
