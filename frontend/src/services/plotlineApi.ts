/**
 * PlotLine API service layer
 */
import { api } from './api';
import type {
  PlotLine,
  PlotLineDetail,
  PlotStage,
  SessionPlotLine,
  PlotLineStatus,
  PlotStageTransitionResult,
} from '@/types';

// ── PlotLine CRUD ──

export const plotlineApi = {
  /** 获取用户所有剧情线 */
  list: () => api.get<PlotLine[]>('/api/plotlines'),

  /** 创建剧情线 */
  create: (data: {
    name: string;
    description?: string;
    raw_content?: string;
  }) => api.post<PlotLine>('/api/plotlines', data),

  /** 获取剧情线详情（含阶段列表） */
  get: (id: string) => api.get<PlotLineDetail>(`/api/plotlines/${id}`),

  /** 编辑剧情线 */
  update: (id: string, data: {
    name?: string;
    description?: string;
    raw_content?: string;
  }) => api.put<PlotLine>(`/api/plotlines/${id}`, data),

  /** 删除剧情线 */
  delete: (id: string) => api.delete(`/api/plotlines/${id}`),

  /** AI 智能分段 */
  parse: (id: string, model: string) =>
    api.post<PlotLineDetail>(`/api/plotlines/${id}/parse`, { model }),

  /** 编辑单个阶段 */
  updateStage: (plotLineId: string, stageId: string, data: {
    title?: string;
    content?: string;
    summary?: string;
    transition_hint?: string;
    priority?: number;
  }) => api.put<PlotStage>(`/api/plotlines/${plotLineId}/stages/${stageId}`, data),

  // ── Session association ──

  /** 为对话关联剧情线 */
  associateSession: (sessionId: string, data: {
    plot_line_id: string;
    stage_transition_mode?: string;
  }) => api.post<SessionPlotLine>(`/api/character-sessions/${sessionId}/plotline`, data),

  /** 取消对话的剧情线关联 */
  disassociateSession: (sessionId: string) =>
    api.delete(`/api/character-sessions/${sessionId}/plotline`),

  /** 获取对话的剧情线状态 */
  getSessionStatus: (sessionId: string) =>
    api.get<PlotLineStatus>(`/api/character-sessions/${sessionId}/plotline/status`),

  /** 阶段跳转（prev/next/index） */
  transitionStage: (sessionId: string, data: {
    session_id: string;
    direction?: 'next' | 'prev';
    target_index?: number;
  }) => api.post<PlotStageTransitionResult>(`/api/character-sessions/${sessionId}/plotline/transition`, data),
};
