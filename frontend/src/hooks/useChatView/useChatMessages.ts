/**
 * 消息管理Hook
 * 从useChatView中提取的消息CRUD逻辑
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { generateMessageId } from '@/lib/utils/messageUtils';
import type { Message as MessageType } from '@/types';

export interface UseChatMessagesParams {
  activeSessionId: string | null;
  t: Record<string, string>;
}

export function useChatMessages({ activeSessionId, t }: UseChatMessagesParams) {
  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [showMessageSelect, setShowMessageSelect] = useState(false);
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);

  const lastLoadedSessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // 消息 id → 数组下标索引：流式更新时以 O(1) 定位，避免每个 chunk 都 findIndex 全数组
  const messageIndexMapRef = useRef<Map<string, number>>(new Map());

  // 消息数组变化时重建索引（对齐 useCharacterChat 的 messageIndexMapRef 模式）
  useEffect(() => {
    const map = new Map<string, number>();
    messages.forEach((msg, idx) => {
      if (msg.id != null) map.set(String(msg.id), idx);
    });
    messageIndexMapRef.current = map;
  }, [messages]);

  // 加载消息
  const loadMessages = useCallback(async (sessionId: string) => {
    if (lastLoadedSessionIdRef.current === sessionId) return;
    lastLoadedSessionIdRef.current = sessionId;

    try {
      setSuggestions([]);
      const data = await api.get<MessageType[]>(`/api/sessions/${sessionId}/messages`);
      const loadedMessages = Array.isArray(data) ? data : [];
      setMessages(loadedMessages);
    } catch (error) {
      console.error('Failed to load messages:', error);
      setMessages([]);
    }
  }, []);

  // 编辑消息
  const handleEditMessage = useCallback(async (messageId: string | number, messageIndex: number, newContent: string) => {
    try {
      await api.put(`/api/sessions/${activeSessionId}/messages/${messageId}`, {
        content: newContent,
      });
      
      setMessages(prev => prev.map(msg => 
        msg.id === messageId ? { ...msg, content: newContent } : msg
      ));
      
      toast.success(t.message_edited || '消息已编辑');
    } catch (error) {
      console.error('Failed to edit message:', error);
      toast.error(t.edit_failed || '编辑失败');
    }
  }, [activeSessionId, t]);

  // 删除消息
  const handleDeleteMessage = useCallback(async (messageId: string | number, messageIndex: number) => {
    try {
      await api.delete(`/api/sessions/${activeSessionId}/messages/${messageId}`);
      
      setMessages(prev => prev.filter(msg => msg.id !== messageId));
      toast.success(t.message_deleted || '消息已删除');
    } catch (error) {
      console.error('Failed to delete message:', error);
      toast.error(t.delete_failed || '删除失败');
    }
  }, [activeSessionId, t]);

  // 清空消息
  const handleClearMessages = useCallback(async () => {
    if (!activeSessionId) return;
    
    try {
      await api.delete(`/api/sessions/${activeSessionId}/messages`);
      setMessages([]);
      setSuggestions([]);
      toast.success(t.messages_cleared || '消息已清空');
    } catch (error) {
      console.error('Failed to clear messages:', error);
      toast.error(t.clear_failed || '清空失败');
    }
  }, [activeSessionId, t]);

  // 导出消息
  const handleExportMessages = useCallback((format: string = 'markdown'): string => {
    if (format === 'json') {
      return JSON.stringify(messages, null, 2);
    }
    
    // Markdown格式
    return messages.map(msg => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      return `**${role}**: ${msg.content}`;
    }).join('\n\n');
  }, [messages]);

  // 更新助手消息快照
  const setAssistantMessageSnapshot = useCallback((messageId: string, content: string, reasoning?: string) => {
    setMessages(prev => {
      const next = [...prev];
      const idx = messageIndexMapRef.current.get(messageId) ?? next.findIndex(msg => msg.id === messageId);
      if (idx >= 0) {
        next[idx] = { 
          ...next[idx], 
          content: reasoning ? `<think>${reasoning}</think>\n${content}` : content,
        };
      }
      return next;
    });
  }, []);

  // 切换消息选择模式或选择特定消息
  const toggleMessageSelect = useCallback((messageId?: string) => {
    if (messageId) {
      // 切换特定消息的选择状态
      setSelectedMessages(prev => {
        const next = new Set(prev);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return next;
      });
    } else {
      // 切换消息选择模式
      setShowMessageSelect(prev => !prev);
      if (showMessageSelect) {
        setSelectedMessages(new Set());
      }
    }
  }, [showMessageSelect]);

  // 切换消息选择状态
  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessages(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  // 批量删除消息
  const handleBatchDeleteMessages = useCallback(async () => {
    if (selectedMessages.size === 0) return;
    
    try {
      const ids = Array.from(selectedMessages);
      await Promise.all(ids.map(id => 
        api.delete(`/api/sessions/${activeSessionId}/messages/${id}`)
      ));
      
      setMessages(prev => prev.filter(msg => !selectedMessages.has(String(msg.id))));
      setSelectedMessages(new Set());
      setShowMessageSelect(false);
      
      toast.success(t.messages_deleted || '消息已删除');
    } catch (error) {
      console.error('Failed to delete messages:', error);
      toast.error(t.delete_failed || '删除失败');
    }
  }, [selectedMessages, activeSessionId, t]);

  // 加载消息
  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    } else {
      setMessages([]);
      lastLoadedSessionIdRef.current = null;
    }
  }, [activeSessionId, loadMessages]);

  return {
    messages,
    setMessages,
    input,
    setInput,
    suggestions,
    setSuggestions,
    selectedMessages,
    showMessageSelect,
    regeneratingMessageIndex,
    setRegeneratingMessageIndex,
    loadMessages,
    handleEditMessage,
    handleDeleteMessage,
    handleClearMessages,
    handleExportMessages,
    setAssistantMessageSnapshot,
    toggleMessageSelect,
    toggleMessageSelection,
    handleBatchDeleteMessages,
  };
}
