/**
 * useChatView 组合Hook
 * 将多个子Hook组合在一起，保持原有接口兼容
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { emitEvent } from '@/lib/event-bus';
import { generateMessageId, buildDisplayContent, stripAttachmentMarkdown } from '@/lib/utils/messageUtils';
import { StreamEngine, type StreamStatus } from '@/lib/stream-engine';
import { AppError } from '@/lib/error-handler';
import { useSessionManager } from './useSessionManager';
import { useChatMessages } from './useChatMessages';
import { useAttachments } from './useAttachments';
import type { Model, MemoryStats } from '@/types';

export interface UseChatViewParams {
  currentModel: string;
  t: Record<string, string>;
}

export function useChatView({ currentModel, t }: UseChatViewParams) {
  // 子Hook
  const sessionManager = useSessionManager({ t });
  const chatMessages = useChatMessages({ 
    activeSessionId: sessionManager.activeSessionId, 
    t 
  });
  const attachments = useAttachments({ t });

  // 从chatMessages中解构suggestions
  const { suggestions, setSuggestions, ...restChatMessages } = chatMessages;

  // 流式传输状态
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle');
  const [queueInfo, setQueueInfo] = useState<{ 
    requestId: string; 
    position: number; 
    estimatedWait: number 
  } | null>(null);
  const [isSendingMessage, setIsSendingMessage] = useState(false);

  // 内存管理
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [developerMode, setDeveloperMode] = useState(false);

  // UI状态
  const [generatingImageMessageIds, setGeneratingImageMessageIds] = useState<Set<string>>(new Set());

  // Refs
  const streamEngineRef = useRef<StreamEngine | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isAtBottomRef = useRef(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 流式渲染 RAF 批处理：SSE chunk 频率远高于帧率，若每个 chunk 直接 setState，
  // 每条消息（含 ReactMarkdown 解析）都会重复渲染，长消息时阻塞主线程。
  // 与 useCharacterChat 的 scheduleStreamUpdate 同款：一帧内多个 chunk 合并为一次更新。
  const streamRafRef = useRef<number | null>(null);
  const streamPendingRef = useRef<{ assistantId: string; content: string; reasoning: string } | null>(null);

  // 初始化流式引擎
  useEffect(() => {
    streamEngineRef.current = new StreamEngine();
    return () => {
      streamEngineRef.current?.cancel();
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
    };
  }, []);

  const flushStreamUpdate = useCallback(() => {
    streamRafRef.current = null;
    const pending = streamPendingRef.current;
    if (!pending) return;
    streamPendingRef.current = null;
    chatMessages.setAssistantMessageSnapshot(pending.assistantId, pending.content, pending.reasoning);
  }, [chatMessages]);

  const scheduleStreamUpdate = useCallback((assistantId: string, content: string, reasoning: string) => {
    streamPendingRef.current = { assistantId, content, reasoning };
    if (streamRafRef.current === null) {
      streamRafRef.current = requestAnimationFrame(flushStreamUpdate);
    }
  }, [flushStreamUpdate]);

  // 发送消息（向后兼容：接受额外参数但忽略）
  const handleSend = useCallback(async (overrideText?: string, _webSearch?: boolean, _options?: any) => {
    const { input, setInput, setMessages } = chatMessages;
    const { attachments: currentAttachments, clearAttachments } = attachments;
    const { activeSessionId } = sessionManager;

    const text = overrideText ?? input;
    if (!text.trim() || isSendingMessage) return;

    // 构建显示内容
    const displayContent = buildDisplayContent(input, currentAttachments);
    const messageContent = stripAttachmentMarkdown(input);

    // 乐观更新UI
    setInput('');
    clearAttachments();
    setStreamStatus('pending');
    setIsSendingMessage(true);

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();

    chatMessages.setMessages(prev => [
      ...prev,
      { id: userMessageId, role: 'user', content: displayContent },
      { id: assistantMessageId, role: 'assistant', content: '', model: currentModel },
    ]);

    // 创建AbortController
    abortControllerRef.current = new AbortController();

    // 准备请求
    const request = {
      session_id: activeSessionId,
      session_type: 'chat' as const,
      message: messageContent,
      model: currentModel,
      images: currentAttachments.filter(a => a.type === 'image').map(a => a.url),
      files: currentAttachments.filter(a => a.type === 'file').map(a => a.url),
      display_content: displayContent,
    };

    // 设置回调
    streamEngineRef.current?.setCallbacks({
      onChunk: (content, reasoning) => {
        scheduleStreamUpdate(assistantMessageId, content, reasoning);
      },
      onDone: (fullContent, fullReasoning) => {
        // 完成时立即冲刷挂起的 RAF 帧，再写入最终内容，避免最后一段内容延迟一帧
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        streamPendingRef.current = null;
        chatMessages.setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
        
        // 获取建议
        if (fullContent.length > 20) {
          api.post('/api/chat/suggestions', { message: fullContent, model: currentModel })
            .then(setSuggestions)
            .catch(() => {});
        }
      },
      onError: (error) => {
        // 使用AppError的方法
        const userMessage = error.toUserMessage();
        // 错误时丢弃挂起的流式更新，直接展示错误信息
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        streamPendingRef.current = null;
        chatMessages.setMessages(prev => {
          const next = [...prev];
          const idx = next.findIndex(msg => msg.id === assistantMessageId);
          if (idx >= 0) {
            next[idx] = { 
              ...next[idx], 
              content: `⚠️ **错误**\n\n${userMessage}`,
            };
          }
          return next;
        });
      },
      onCancelled: () => {
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        streamPendingRef.current = null;
        setStreamStatus('cancelled');
      },
      onSessionCreated: (sessionId) => {
        sessionManager.setActiveSessionId(sessionId);
        sessionManager.loadSessions();
      },
      onQueued: (requestId, position, estimatedWait) => {
        setQueueInfo({ requestId, position, estimatedWait });
      },
      onStatusChange: (status) => {
        setStreamStatus(status);
      },
    });

    // 发送请求
    try {
      await streamEngineRef.current?.sendViaSSE(request, api);
    } catch (error) {
      console.error('Stream error:', error);
    } finally {
      setIsSendingMessage(false);
      abortControllerRef.current = null;
    }
  }, [chatMessages, attachments, sessionManager, currentModel, isSendingMessage, scheduleStreamUpdate]);

  // 停止生成
  const handleStopStreaming = useCallback(() => {
    streamEngineRef.current?.cancel();
    abortControllerRef.current?.abort();
    setStreamStatus('cancelled');
    setIsSendingMessage(false);
  }, []);

  // 重新生成
  const handleRegenerate = useCallback(async (messageIndex: number) => {
    const { messages, setMessages } = chatMessages;
    const { activeSessionId } = sessionManager;

    if (isSendingMessage || messageIndex < 1) return;

    const assistantMessageIndex = messageIndex;
    const userMessageIndex = assistantMessageIndex - 1;
    if (userMessageIndex < 0) return;

    const userMessage = messages[userMessageIndex];
    if (userMessage.role !== 'user') return;

    chatMessages.setRegeneratingMessageIndex(assistantMessageIndex);
    setStreamStatus('pending');
    setIsSendingMessage(true);

    const assistantMessageId = generateMessageId();
    setMessages(prev => {
      const next = [...prev];
      next[assistantMessageIndex] = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        model: currentModel,
      };
      return next;
    });

    // 创建AbortController
    abortControllerRef.current = new AbortController();

    // 准备请求
    const request = {
      session_id: activeSessionId,
      session_type: 'chat' as const,
      message: stripAttachmentMarkdown(userMessage.content),
      model: currentModel,
      images: [],
      files: [],
    };

    // 设置回调
    streamEngineRef.current?.setCallbacks({
      onChunk: (content, reasoning) => {
        scheduleStreamUpdate(assistantMessageId, content, reasoning);
      },
      onDone: (fullContent, fullReasoning) => {
        // 完成时立即冲刷挂起的 RAF 帧，再写入最终内容，避免最后一段内容延迟一帧
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        streamPendingRef.current = null;
        chatMessages.setAssistantMessageSnapshot(assistantMessageId, fullContent, fullReasoning);
      },
      onError: (error) => {
        // 使用AppError的方法
        const userMessage = error.toUserMessage();
        // 错误时丢弃挂起的流式更新，直接展示错误信息
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        streamPendingRef.current = null;
        setMessages(prev => {
          const next = [...prev];
          const idx = next.findIndex(msg => msg.id === assistantMessageId);
          if (idx >= 0) {
            next[idx] = { 
              ...next[idx], 
              content: `⚠️ **错误**\n\n${userMessage}`,
            };
          }
          return next;
        });
      },
      onCancelled: () => {
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        streamPendingRef.current = null;
        setStreamStatus('cancelled');
      },
      onStatusChange: (status) => {
        setStreamStatus(status);
      },
    });

    // 发送请求
    try {
      await streamEngineRef.current?.sendViaSSE(request, api);
    } catch (error) {
      console.error('Regenerate error:', error);
    } finally {
      chatMessages.setRegeneratingMessageIndex(null);
      setIsSendingMessage(false);
      abortControllerRef.current = null;
    }
  }, [chatMessages, sessionManager, currentModel, isSendingMessage, scheduleStreamUpdate]);

  // 滚动到底部
  const scrollToBottom = useCallback((options?: { smooth?: boolean }) => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ 
        behavior: options?.smooth ? 'smooth' : 'auto' 
      });
    }
  }, []);

  // 检查是否在底部
  const checkIfAtBottom = useCallback(() => {
    return isAtBottomRef.current;
  }, []);

  // 向后兼容：computed streaming状态
  const streaming = streamStatus === 'pending' || streamStatus === 'queued' || streamStatus === 'streaming';

  // 向后兼容：内存压缩
  const manualCompressMemory = useCallback(async () => {
    if (!sessionManager.activeSessionId) return;
    setCompressing(true);
    try {
      await api.post(`/api/memory/compress`, { session_id: sessionManager.activeSessionId });
      toast.success(t.compress_success || '压缩成功');
    } catch (e) {
      console.error('Failed to compress memory:', e);
    } finally {
      setCompressing(false);
    }
  }, [sessionManager.activeSessionId, setCompressing, t]);

  // 向后兼容：图片生成
  const handleGenerateImage = useCallback(async (messageId: string | number) => {
    if (!sessionManager.activeSessionId) return;
    const key = String(messageId);
    setGeneratingImageMessageIds(prev => new Set(prev).add(key));
    try {
      const result = await api.imageGeneration.generateForChatMessage(sessionManager.activeSessionId, messageId);
      chatMessages.setMessages(prev => prev.map(msg =>
        String(msg.id) === key ? { ...msg, content: result.updated_message.content } : msg
      ));
      toast.success('图片已生成');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '图片生成失败';
      toast.error(message);
    } finally {
      setGeneratingImageMessageIds(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [sessionManager.activeSessionId, chatMessages.setMessages, setGeneratingImageMessageIds]);

  // 向后兼容：滚动处理
  const handleScroll = useCallback(() => {
    // no-op for now
  }, []);

  return {
    // 会话管理
    ...sessionManager,
    setIsDeleteMode: (value?: boolean) => {
      if (typeof value === 'boolean') {
        sessionManager.setShowDeleteConfirm(false);
        // 如果传入了具体值，根据值决定
        if (value !== sessionManager.isDeleteMode) {
          sessionManager.toggleDeleteMode();
        }
      } else {
        sessionManager.toggleDeleteMode();
      }
    },
    toggleSessionSelect: sessionManager.toggleDeleteMode,
    
    // 消息管理
    ...restChatMessages,
    suggestions,
    setSuggestions,
    handleDeleteSelectedMessages: chatMessages.handleBatchDeleteMessages,
    setShowMessageSelect: (value: boolean) => chatMessages.toggleMessageSelect(),
    
    // 附件管理
    ...attachments,
    
    // 流式传输
    streaming,  // 向后兼容
    streamStatus,
    setStreamStatus,
    queueInfo,
    isSendingMessage,
    handleSend,
    handleStopStreaming,
    handleRegenerate,
    
    // 内存管理
    memoryStats,
    setMemoryStats,
    compressing,
    setCompressing,
    memoryMode,
    setMemoryMode,
    developerMode,
    setDeveloperMode,
    manualCompressMemory,
    
    // UI状态
    generatingImageMessageIds,
    setGeneratingImageMessageIds,
    handleGenerateImage,
    
    // 滚动
    messagesEndRef,
    isAtBottomRef,
    scrollToBottom,
    checkIfAtBottom,
    handleScroll,
  };
}
