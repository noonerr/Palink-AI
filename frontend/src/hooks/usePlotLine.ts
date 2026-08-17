/**
 * usePlotLine — state management hook for plot line system (Phase 6C)
 * Mirrors the old linear-stage behavior that was removed from useWorldBook.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { plotlineApi } from '@/services/plotlineApi';
import type {
  PlotLine,
  PlotLineDetail,
  PlotLineStatus,
} from '@/types';

interface UsePlotLineReturn {
  // Data
  plotLines: PlotLine[];
  selectedPlotLine: PlotLineDetail | null;
  sessionStatus: PlotLineStatus | null;
  loading: boolean;
  parsing: boolean;

  // CRUD
  loadPlotLines: () => Promise<void>;
  createPlotLine: (data: { name: string; description?: string; raw_content?: string }) => Promise<PlotLine>;
  updatePlotLine: (id: string, data: { name?: string; description?: string; raw_content?: string }) => Promise<void>;
  updatePlotLineStage: (plotLineId: string, stageId: string, data: { title?: string; content?: string; summary?: string; transition_hint?: string; priority?: number }) => Promise<void>;
  deletePlotLine: (id: string) => Promise<void>;
  loadPlotLineDetail: (id: string) => Promise<void>;
  parsePlotLine: (id: string, model: string) => Promise<void>;

  // Session association
  associateSession: (sessionId: string, plotLineId: string, mode?: string) => Promise<void>;
  disassociateSession: (sessionId: string) => Promise<void>;
  loadSessionStatus: (sessionId: string) => Promise<void>;

  // Stage navigation
  nextStage: (sessionId: string) => Promise<void>;
  prevStage: (sessionId: string) => Promise<void>;
  jumpToStage: (sessionId: string, index: number) => Promise<void>;
}

export function usePlotLine(): UsePlotLineReturn {
  const [plotLines, setPlotLines] = useState<PlotLine[]>([]);
  const [selectedPlotLine, setSelectedPlotLine] = useState<PlotLineDetail | null>(null);
  const [sessionStatus, setSessionStatus] = useState<PlotLineStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const loadPlotLines = useCallback(async () => {
    setLoading(true);
    try {
      const data = await plotlineApi.list();
      if (mountedRef.current) setPlotLines(data);
    } catch (e) {
      console.error('Failed to load plot lines:', e);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const createPlotLine = useCallback(async (data: { name: string; description?: string; raw_content?: string }) => {
    const pl = await plotlineApi.create(data);
    if (mountedRef.current) setPlotLines(prev => [pl, ...prev]);
    return pl;
  }, []);

  const updatePlotLine = useCallback(async (id: string, data: { name?: string; description?: string; raw_content?: string }) => {
    const updated = await plotlineApi.update(id, data);
    if (mountedRef.current) {
      setPlotLines(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p));
      // 同步更新 selectedPlotLine
      setSelectedPlotLine(prev => prev && prev.id === id ? { ...prev, ...updated } : prev);
    }
  }, []);

  // 编辑单个阶段；成功后尝试刷新当前选中的剧情线详情
  const updatePlotLineStage = useCallback(async (
    plotLineId: string,
    stageId: string,
    data: { title?: string; content?: string; summary?: string; transition_hint?: string; priority?: number },
  ) => {
    await plotlineApi.updateStage(plotLineId, stageId, data);
    if (mountedRef.current) {
      // 刷新详情以同步本地状态
      try {
        const detail = await plotlineApi.get(plotLineId);
        if (mountedRef.current) {
          setSelectedPlotLine(prev => prev && prev.id === plotLineId ? detail : prev);
        }
      } catch (e) {
        console.warn('updatePlotLineStage 后刷新详情失败:', e);
      }
    }
  }, []);

  const deletePlotLine = useCallback(async (id: string) => {
    await plotlineApi.delete(id);
    if (mountedRef.current) {
      setPlotLines(prev => prev.filter(p => p.id !== id));
      if (selectedPlotLine?.id === id) setSelectedPlotLine(null);
    }
  }, [selectedPlotLine]);

  const loadPlotLineDetail = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const detail = await plotlineApi.get(id);
      if (mountedRef.current) setSelectedPlotLine(detail);
    } catch (e) {
      console.error('Failed to load plot line detail:', e);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const parsePlotLine = useCallback(async (id: string, model: string) => {
    setParsing(true);
    try {
      const detail = await plotlineApi.parse(id, model);
      if (mountedRef.current) {
        setSelectedPlotLine(detail);
        setPlotLines(prev => prev.map(p => p.id === id ? { ...p, is_parsed: true, stage_count: detail.stages?.length ?? 0 } : p));
      }
    } catch (e) {
      console.error('Failed to parse plot line:', e);
      throw e;
    } finally {
      if (mountedRef.current) setParsing(false);
    }
  }, []);

  const associateSession = useCallback(async (sessionId: string, plotLineId: string, mode = 'manual') => {
    await plotlineApi.associateSession(sessionId, { plot_line_id: plotLineId, stage_transition_mode: mode });
    const status = await plotlineApi.getSessionStatus(sessionId);
    if (mountedRef.current) setSessionStatus(status);
  }, []);

  const disassociateSession = useCallback(async (sessionId: string) => {
    await plotlineApi.disassociateSession(sessionId);
    if (mountedRef.current) setSessionStatus(null);
  }, []);

  const loadSessionStatus = useCallback(async (sessionId: string) => {
    try {
      const status = await plotlineApi.getSessionStatus(sessionId);
      if (mountedRef.current) setSessionStatus(status?.active ? status : null);
    } catch (e) {
      console.error('Failed to load plot line status:', e);
    }
  }, []);

  const nextStage = useCallback(async (sessionId: string) => {
    await plotlineApi.transitionStage(sessionId, { session_id: sessionId, direction: 'next' });
  }, []);

  const prevStage = useCallback(async (sessionId: string) => {
    await plotlineApi.transitionStage(sessionId, { session_id: sessionId, direction: 'prev' });
  }, []);

  const jumpToStage = useCallback(async (sessionId: string, index: number) => {
    await plotlineApi.transitionStage(sessionId, { session_id: sessionId, target_index: index });
  }, []);

  return {
    plotLines,
    selectedPlotLine,
    sessionStatus,
    loading,
    parsing,
    loadPlotLines,
    createPlotLine,
    updatePlotLine,
    updatePlotLineStage,
    deletePlotLine,
    loadPlotLineDetail,
    parsePlotLine,
    associateSession,
    disassociateSession,
    loadSessionStatus,
    nextStage,
    prevStage,
    jumpToStage,
  };
}
