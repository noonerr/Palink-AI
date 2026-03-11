/**
 * useWorldBook — state management hook for world book system
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { worldbookApi } from '@/services/worldbookApi';
import type {
  WorldBook,
  WorldBookDetail,
  WorldBookStatus,
  StageTransitionResult,
} from '@/types';

interface UseWorldBookReturn {
  // Data
  worldBooks: WorldBook[];
  selectedWorldBook: WorldBookDetail | null;
  sessionStatus: WorldBookStatus | null;
  loading: boolean;
  parsing: boolean;

  // World book CRUD
  loadWorldBooks: () => Promise<void>;
  createWorldBook: (data: { name: string; description?: string; raw_content?: string; tags?: string[] }) => Promise<WorldBook>;
  updateWorldBook: (id: string, data: { name?: string; description?: string; raw_content?: string; tags?: string[] }) => Promise<void>;
  deleteWorldBook: (id: string) => Promise<void>;
  importWorldBook: (file: File) => Promise<WorldBook>;
  loadWorldBookDetail: (id: string) => Promise<void>;

  // AI parse
  parseWorldBook: (id: string, model?: string) => Promise<void>;

  // Session association
  associateSession: (sessionId: string, worldBookId: string, mode?: 'auto' | 'manual') => Promise<void>;
  disassociateSession: (sessionId: string) => Promise<void>;
  loadSessionStatus: (sessionId: string) => Promise<void>;

  // Stage control
  nextStage: (sessionId: string) => Promise<StageTransitionResult | null>;
  prevStage: (sessionId: string) => Promise<StageTransitionResult | null>;
  jumpToStage: (sessionId: string, index: number) => Promise<StageTransitionResult | null>;
}

export function useWorldBook(): UseWorldBookReturn {
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [selectedWorldBook, setSelectedWorldBook] = useState<WorldBookDetail | null>(null);
  const [sessionStatus, setSessionStatus] = useState<WorldBookStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const loadWorldBooks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await worldbookApi.list();
      if (mountedRef.current) setWorldBooks(data);
    } catch (e) {
      console.error('Failed to load world books:', e);
    } finally {
      if (mountedRef.current) setLoading(false);
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

  const parseWorldBook = useCallback(async (id: string, model?: string) => {
    setParsing(true);
    try {
      await worldbookApi.parse(id, model);
      // Reload the detail to get new stages
      const detail = await worldbookApi.get(id);
      if (mountedRef.current) {
        setSelectedWorldBook(detail);
        setWorldBooks(prev => prev.map(wb => wb.id === id ? { ...wb, is_parsed: true, stage_count: detail.stages.length } : wb));
      }
    } finally {
      if (mountedRef.current) setParsing(false);
    }
  }, []);

  const associateSession = useCallback(async (sessionId: string, worldBookId: string, mode: 'auto' | 'manual' = 'auto') => {
    const result = await worldbookApi.associateSession(sessionId, {
      world_book_id: worldBookId,
      stage_transition_mode: mode,
    });
    if (mountedRef.current && result) {
      setSessionStatus({
        active: true,
        world_book_id: result.world_book_id,
        world_book_name: result.world_book?.name,
        current_stage_index: result.current_stage_index,
        total_stages: result.stages?.length ?? 0,
        stage_transition_mode: result.stage_transition_mode,
        current_stage: result.stages?.[0] ?? undefined,
        stages_overview: result.stages?.map(s => ({ index: s.stage_index, title: s.title, summary: s.summary })),
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

  const nextStage = useCallback(async (sessionId: string) => {
    try {
      const result = await worldbookApi.transitionStage(sessionId, 'next');
      if (mountedRef.current) {
        setSessionStatus(prev => prev ? { ...prev, current_stage_index: result.current_stage_index } : prev);
      }
      return result;
    } catch { return null; }
  }, []);

  const prevStage = useCallback(async (sessionId: string) => {
    try {
      const result = await worldbookApi.transitionStage(sessionId, 'prev');
      if (mountedRef.current) {
        setSessionStatus(prev => prev ? { ...prev, current_stage_index: result.current_stage_index } : prev);
      }
      return result;
    } catch { return null; }
  }, []);

  const jumpToStage = useCallback(async (sessionId: string, index: number) => {
    try {
      const result = await worldbookApi.transitionStage(sessionId, 'jump', index);
      if (mountedRef.current) {
        setSessionStatus(prev => prev ? { ...prev, current_stage_index: result.current_stage_index } : prev);
      }
      return result;
    } catch { return null; }
  }, []);

  return {
    worldBooks,
    selectedWorldBook,
    sessionStatus,
    loading,
    parsing,
    loadWorldBooks,
    createWorldBook,
    updateWorldBook,
    deleteWorldBook,
    importWorldBook,
    loadWorldBookDetail,
    parseWorldBook,
    associateSession,
    disassociateSession,
    loadSessionStatus,
    nextStage,
    prevStage,
    jumpToStage,
  };
}
