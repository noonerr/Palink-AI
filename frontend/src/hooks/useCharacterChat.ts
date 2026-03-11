import { useState, useRef, useCallback } from 'react';
import { api } from '@/services/api';
import { analyzeError, type ErrorInfo } from '@/lib/errorHandler';
import type { Character, CharacterChatMessage, CharacterChatSession, CharacterChatSessionBranch } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

export interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
}

interface UseCharacterChatOptions {
  selectedCharacter: Character | null;
  selectedSession: CharacterChatSession | null;
  selectedModel: string;
  dialogueMode: 'first_person' | 'third_person';
  selectedBranch: CharacterChatSessionBranch | null;
  getDisplayName: (character?: Character | Partial<Character> | null) => string;
  messages: CharacterChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<CharacterChatMessage[]>>;
  setSelectedSession: (session: CharacterChatSession | null) => void;
  loadSessions: (characterId: string) => Promise<void>;
  loadMemoryStats: (sessionId: string) => Promise<void>;
}

const TIMEOUT_WARNING_MS = 15000;

export function useCharacterChat({
  selectedCharacter,
  selectedSession,
  selectedModel,
  dialogueMode,
  selectedBranch,
  getDisplayName,
  messages,
  setMessages,
  setSelectedSession,
  loadSessions,
  loadMemoryStats,
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
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

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

    try {
      const response = await api.stream('/api/character-chat', {
        session_id: selectedSession?.id || '',
        character_id: selectedCharacter.id,
        message: userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim(),
        model: selectedModel,
        temperature: 0.7,
        dialogue_mode: dialogueMode,
        branch_id: selectedBranch?.id,
        user_nickname: getDisplayName(selectedCharacter),
      }, { signal: abortControllerRef.current.signal });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              if (json.session_id && !selectedSession) {
                setSelectedSession({ ...json } as any);
                loadSessions(selectedCharacter.id);
              }
              if (json.reasoning) fullReasoning += json.reasoning;
              if (json.content) fullContent += json.content;

              setMessages(prev => {
                const newMessages = [...prev];
                newMessages[assistantMessageIndex] = {
                  ...newMessages[assistantMessageIndex],
                  content: fullReasoning
                    ? `<think>${fullReasoning}</think>${fullContent}`
                    : fullContent,
                };
                return newMessages;
              });
            } catch (_e) { /* parse error, skip */ }
          }
        }
      }

      if (selectedSession?.id) {
        await loadMemoryStats(selectedSession.id);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex].content += `\n[Error: ${e.message}]`;
          return newMessages;
        });
      }
    } finally {
      setIsGenerating(false);
      setRegeneratingMessageIndex(null);
      abortControllerRef.current = null;
    }
  }, [selectedCharacter, selectedSession, selectedModel, dialogueMode, selectedBranch, isGenerating, uploading, messages, getDisplayName, setMessages, setSelectedSession, loadSessions, loadMemoryStats]);

  const handleSendMessage = useCallback(async (content: string, images: string[]) => {
    if (!selectedCharacter) return;

    const text = content || inputValue;
    if ((!text.trim() && attachments.length === 0) || isGenerating || uploading) return;

    setCurrentError(null);
    setTimeoutWarning(false);
    setInputValue('');
    setAttachments([]);
    setIsGenerating(true);
    setSuggestions([]);

    setRetryMessageContent(text);
    setRetryMessageImages(images);

    setRequestStartTime(Date.now());
    timeoutRef.current = setTimeout(() => {
      setTimeoutWarning(true);
    }, TIMEOUT_WARNING_MS);

    let displayContent = text;
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach(att => {
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

    try {
      const response = await api.stream('/api/character-chat', {
        session_id: selectedSession?.id || '',
        character_id: selectedCharacter.id,
        message: text,
        model: selectedModel,
        temperature: 0.7,
        dialogue_mode: dialogueMode,
        branch_id: selectedBranch?.id,
        user_nickname: getDisplayName(selectedCharacter),
      }, { signal: abortControllerRef.current.signal });

      if (!selectedSession) {
        loadSessions(selectedCharacter.id);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!hasReceivedData) {
          hasReceivedData = true;
          setTimeoutWarning(false);
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
        }

        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              if (json.session_id && !selectedSession) {
                setSelectedSession({ ...json } as any);
                loadSessions(selectedCharacter.id);
              }
              if (json.reasoning) fullReasoning += json.reasoning;
              if (json.content) fullContent += json.content;

              setMessages(prev => {
                const newMessages = [...prev];
                const lastMessage = newMessages[newMessages.length - 1];
                newMessages[newMessages.length - 1] = {
                  ...lastMessage,
                  content: fullReasoning
                    ? `<think>${fullReasoning}</think>${fullContent}`
                    : fullContent,
                };
                return newMessages;
              });
            } catch (_e) { /* parse error, skip */ }
          }
        }
      }

      if (selectedSession?.id) {
        await loadMemoryStats(selectedSession.id);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        const errorInfo = analyzeError(e);
        setCurrentError(errorInfo);

        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content =
            `⚠️ **${errorInfo.title}**\n\n${errorInfo.description}\n\n💡 ${errorInfo.suggestion}`;
          return newMessages;
        });
      }
    } finally {
      setIsGenerating(false);
      setRequestStartTime(null);
      setTimeoutWarning(false);
      abortControllerRef.current = null;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    }
  }, [selectedCharacter, selectedSession, selectedModel, dialogueMode, selectedBranch, inputValue, attachments, isGenerating, uploading, getDisplayName, setMessages, setSelectedSession, loadSessions, loadMemoryStats]);

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
      setAttachments(prev => [...prev, { type, name: file.name, url: data.url }]);
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
      setMessages(prev => prev.filter((_, idx) => idx !== messageIndex));
    } catch (e) {
      console.error('Failed to delete message:', e);
    }
  }, [selectedSession, setMessages]);

  const handleEditMessage = useCallback(async (messageId: number, messageIndex: number, newContent: string) => {
    if (!selectedSession) return;
    try {
      await api.put(`/api/character-sessions/${selectedSession.id}/messages/${messageId}`, { content: newContent });
      setMessages(prev => {
        const newMessages = [...prev];
        newMessages[messageIndex] = {
          ...newMessages[messageIndex],
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
      clearTimeout(timeoutRef.current);
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
