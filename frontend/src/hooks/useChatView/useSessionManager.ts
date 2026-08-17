/**
 * 会话管理Hook
 * 从useChatView中提取的会话CRUD逻辑
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { emitEvent } from '@/lib/event-bus';
import type { Session } from '@/types';

export interface UseSessionManagerParams {
  t: Record<string, string>;
}

export function useSessionManager({ t }: UseSessionManagerParams) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    { type: 'single'; id: string } | { type: 'batch' } | { type: 'message'; messageId: string | number; messageIndex: number } | null
  >(null);

  const sessionIdSetRef = useRef(false);

  // 加载会话列表
  const loadSessions = useCallback(async () => {
    try {
      const data = await api.get<Session[]>('/api/sessions', { cacheTtlMs: 5000 });
      if (Array.isArray(data)) {
        setSessions(data);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  }, []);

  // 选择会话
  const handleSelectSession = useCallback((session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    setActiveSessionId(sessionId);
    emitEvent('session:switched', { sessionId });
  }, []);

  // 删除单个会话
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await api.delete(`/api/sessions/${sessionId}`);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
      toast.success(t.session_deleted || '会话已删除');
    } catch (error) {
      console.error('Failed to delete session:', error);
      toast.error(t.delete_failed || '删除失败');
    }
  }, [activeSessionId, t]);

  // 批量删除会话
  const handleBatchDelete = useCallback(async () => {
    if (selectedSessions.size === 0) return;
    
    try {
      const ids = Array.from(selectedSessions);
      await Promise.all(ids.map(id => api.delete(`/api/sessions/${id}`)));
      
      setSessions(prev => prev.filter(s => !selectedSessions.has(s.id)));
      setSelectedSessions(new Set());
      setIsDeleteMode(false);
      setShowDeleteConfirm(false);
      
      if (activeSessionId && selectedSessions.has(activeSessionId)) {
        setActiveSessionId(null);
      }
      
      toast.success(t.sessions_deleted || '会话已删除');
    } catch (error) {
      console.error('Failed to delete sessions:', error);
      toast.error(t.delete_failed || '删除失败');
    }
  }, [selectedSessions, activeSessionId, t]);

  // 切换选择状态
  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedSessions.size === sessions.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(sessions.map(s => s.id)));
    }
  }, [sessions, selectedSessions.size]);

  // 进入/退出删除模式
  const toggleDeleteMode = useCallback(() => {
    setIsDeleteMode(prev => !prev);
    if (isDeleteMode) {
      setSelectedSessions(new Set());
    }
  }, [isDeleteMode]);

  // 确认删除
  const confirmDelete = useCallback(() => {
    if (pendingDelete?.type === 'single') {
      handleDeleteSession(pendingDelete.id);
    } else if (pendingDelete?.type === 'batch') {
      handleBatchDelete();
    }
    setShowDeleteConfirm(false);
    setPendingDelete(null);
  }, [pendingDelete, handleDeleteSession, handleBatchDelete]);

  // 取消删除
  const cancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
    setPendingDelete(null);
  }, []);

  // 加载会话列表
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    isDeleteMode,
    selectedSessions,
    showDeleteConfirm,
    pendingDelete,
    loadSessions,
    handleSelectSession,
    handleDeleteSession,
    handleBatchDelete,
    toggleSessionSelection,
    toggleSelectAll,
    toggleDeleteMode,
    confirmDelete,
    cancelDelete,
    setPendingDelete,
    setShowDeleteConfirm,
  };
}
