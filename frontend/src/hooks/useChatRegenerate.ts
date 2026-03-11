import { useState, useRef, useCallback } from 'react';
import { api } from '@/services/api';

interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  tokens?: number;
}

interface UseChatRegenerateOptions {
  token: string;
  apiEndpoint: string;
  generateMessageId: () => string;
  additionalPayload?: Record<string, any>;
}

export const useChatRegenerate = <T extends Message>({
  token: _token,
  apiEndpoint,
  generateMessageId,
  additionalPayload = {}
}: UseChatRegenerateOptions) => {
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleRegenerate = useCallback(async (
    messageIndex: number,
    messages: T[],
    setMessages: React.Dispatch<React.SetStateAction<T[]>>,
    setStreaming: React.Dispatch<React.SetStateAction<boolean>>,
    setSuggestions: React.Dispatch<React.SetStateAction<string[]>>,
    currentModel: string,
    onSessionUpdate?: (sessionData: any) => void,
    loadSessions?: () => void,
    loadMemoryStats?: (sessionId: string) => Promise<void>,
    selectedSession?: { id: string } | null
  ) => {
    if (messageIndex < 1) return;

    const assistantMessageIndex = messageIndex;
    const userMessageIndex = assistantMessageIndex - 1;

    if (userMessageIndex < 0) return;

    const userMessage = messages[userMessageIndex];
    if (userMessage.role !== 'user') return;

    setRegeneratingMessageIndex(assistantMessageIndex);
    setStreaming(true);
    setSuggestions([]);

    const assistantMessageId = generateMessageId();

    setMessages(prev => {
      const newMessages = [...prev];
      newMessages[assistantMessageIndex] = {
        ...newMessages[assistantMessageIndex],
        id: assistantMessageId,
        content: '',
        model: currentModel
      };
      return newMessages;
    });

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';

    try {
      const res = await api.stream(apiEndpoint, {
        ...additionalPayload,
        message: userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim(),
        model: currentModel,
        images: [],
        files: []
      }, { signal: abortControllerRef.current.signal });

      const reader = res.body?.getReader();
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
              
              if (json.session_id && onSessionUpdate && !selectedSession) {
                onSessionUpdate(json);
                if (loadSessions) loadSessions();
              }
              
              if (json.reasoning) fullReasoning += json.reasoning;
              if (json.content) fullContent += json.content;

              setMessages(prev => {
                const newMessages = [...prev];
                newMessages[assistantMessageIndex] = {
                  ...newMessages[assistantMessageIndex],
                  content: fullReasoning
                    ? `<think>${fullReasoning}</think>${fullContent}`
                    : fullContent
                };
                return newMessages;
              });
            } catch (e) {}
          }
        }
      }

      if (fullContent.length > 20) {
        api.post('/api/chat/suggestions', { message: fullContent, model: currentModel })
          .then(setSuggestions)
          .catch(() => {});
      }

      if (selectedSession?.id && loadMemoryStats) {
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
      setStreaming(false);
      setRegeneratingMessageIndex(null);
      abortControllerRef.current = null;
    }
  }, [apiEndpoint, generateMessageId, additionalPayload]);

  return {
    regeneratingMessageIndex,
    handleRegenerate,
    abortControllerRef
  };
};
