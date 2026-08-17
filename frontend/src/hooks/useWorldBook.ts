/**
 * useWorldBook — state management hook for world book system (Phase 6B)
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { worldbookApi } from '@/services/worldbookApi';
import type {
  WorldBook,
  WorldBookDetail,
  WorldBookStatus,
} from '@/types';

interface UseWorldBookReturn {
  // Data
  worldBooks: WorldBook[];
  selectedWorldBook: WorldBookDetail | null;
  sessionStatus: WorldBookStatus | null;
  loading: boolean;

  // World book CRUD
  loadWorldBooks: (characterId?: string, type?: string) => Promise<void>;
  createWorldBook: (data: { name: string; description?: string; raw_content?: string; tags?: string[] }) => Promise<WorldBook>;
  updateWorldBook: (id: string, data: { name?: string; description?: string; raw_content?: string; tags?: string[] }) => Promise<void>;
  deleteWorldBook: (id: string) => Promise<void>;
  importWorldBook: (file: File) => Promise<WorldBook>;
  loadWorldBookDetail: (id: string) => Promise<void>;

  // Session association
  associateSession: (sessionId: string, worldBookId: string) => Promise<void>;
  disassociateSession: (sessionId: string) => Promise<void>;
  loadSessionStatus: (sessionId: string) => Promise<void>;
}

export function useWorldBook(): UseWorldBookReturn {
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [selectedWorldBook, setSelectedWorldBook] = useState<WorldBookDetail | null>(null);
  const [sessionStatus, setSessionStatus] = useState<WorldBookStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const loadVersionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadWorldBooks = useCallback(async (characterId?: string, type?: string) => {
    const version = ++loadVersionRef.current;
    setLoading(true);
    try {
      const params: { character_id?: string; type?: string } = {};
      if (characterId) params.character_id = characterId;
      if (type) params.type = type;
      const data = await worldbookApi.list(Object.keys(params).length > 0 ? params : undefined);
      if (mountedRef.current && version === loadVersionRef.current) {
        setWorldBooks(data);
      }
    } catch (e) {
      console.error('Failed to load world books:', e);
    } finally {
      if (mountedRef.current && version === loadVersionRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const createWorldBook = useCallback(async (data: { name: string; description?: string; raw_content?: string; tags?: string[] }) => {
    const wb = await worldbookApi.create(data);
    if (mountedRef.current) setWorldBooks(prev => [wb, ...prev]);
    return wb;
  }, []);

  const updateWorldBook = useCallback(async (id: string, data: { name?: string; description?: string; raw_content?: string; tags?: string[] }) => {
    const updated = await worldbookApi.update(id, data);
    if (mountedRef.current) {
      setWorldBooks(prev => prev.map(wb => wb.id === id ? { ...wb, ...updated } : wb));
    }
  }, []);

  const deleteWorldBook = useCallback(async (id: string) => {
    await worldbookApi.delete(id);
    if (mountedRef.current) {
      setWorldBooks(prev => prev.filter(wb => wb.id !== id));
      if (selectedWorldBook?.id === id) setSelectedWorldBook(null);
    }
  }, [selectedWorldBook]);

  const importWorldBook = useCallback(async (file: File) => {
    const wb = await worldbookApi.import(file);
    if (mountedRef.current) setWorldBooks(prev => [wb, ...prev]);
    return wb;
  }, []);

  const loadWorldBookDetail = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const detail = await worldbookApi.get(id);
      if (mountedRef.current) setSelectedWorldBook(detail);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const associateSession = useCallback(async (sessionId: string, worldBookId: string) => {
    const result = await worldbookApi.associateSession(sessionId, {
      world_book_id: worldBookId,
    });
    if (mountedRef.current && result) {
      setSessionStatus({
        active: true,
        world_book_id: result.world_book_id,
        world_book_name: result.world_book?.name,
        active_entries_count: result.stages?.length ?? 0,
        entries_overview: result.stages?.map(s => ({
          id: s.id,
          title: s.title,
          keys_preview: (s.keys ?? []).slice(0, 3).join(', ') || (s.constant ? '[constant]' : ''),
        })),
      });
    }
  }, []);

  const disassociateSession = useCallback(async (sessionId: string) => {
    await worldbookApi.disassociateSession(sessionId);
    if (mountedRef.current) setSessionStatus(null);
  }, []);

  const loadSessionStatus = useCallback(async (sessionId: string) => {
    try {
      const status = await worldbookApi.getSessionStatus(sessionId);
      if (mountedRef.current) setSessionStatus(status);
    } catch {
      if (mountedRef.current) setSessionStatus(null);
    }
  }, []);

  return {
    worldBooks,
    selectedWorldBook,
    sessionStatus,
    loading,
    loadWorldBooks,
    createWorldBook,
    updateWorldBook,
    deleteWorldBook,
    importWorldBook,
    loadWorldBookDetail,
    associateSession,
    disassociateSession,
    loadSessionStatus,
  };
}
