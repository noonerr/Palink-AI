/**
 * World Book API service layer
 */
import { api } from './api';
import type {
  WorldBook,
  WorldBookDetail,
  WorldBookStage,
  SessionWorldBook,
  WorldBookStatus,
} from '@/types';

// ── World Book CRUD ──

export const worldbookApi = {
  /** 获取用户所有世界书 */
  list: () => api.get<WorldBook[]>('/api/worldbooks'),

  /** 创建世界书 */
  create: (data: {
    name: string;
    description?: string;
    source_type?: string;
    raw_content?: string;
    format?: string;
    tags?: string[];
  }) => api.post<WorldBook>('/api/worldbooks', data),

  /** 获取世界书详情（含词条列表） */
  get: (id: string) => api.get<WorldBookDetail>(`/api/worldbooks/${id}`),

  /** 编辑世界书 */
  update: (id: string, data: {
    name?: string;
    description?: string;
    raw_content?: string;
    tags?: string[];
  }) => api.put<WorldBook>(`/api/worldbooks/${id}`, data),

  /** 删除世界书 */
  delete: (id: string) => api.delete(`/api/worldbooks/${id}`),

  /** 导入 SillyTavern V2 JSON 世界书 */
  import: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<WorldBook>('/api/worldbooks/import', formData);
  },

  /** 编辑单个词条 */
  updateStage: (worldBookId: string, stageId: string, data: {
    title?: string;
    content?: string;
    summary?: string;
    transition_hint?: string;
    priority?: number;
    image_prompt?: string;
    keys?: string[];
    secondary_keys?: string[];
    scan_depth?: number;
    position?: number;
    selective?: boolean;
    probability?: number;
    constant?: boolean;
  }) => api.put<WorldBookStage>(`/api/worldbooks/${worldBookId}/stages/${stageId}`, data),

  // ── Session association ──

  /** 为对话关联世界书 */
  associateSession: (sessionId: string, data: {
    world_book_id: string;
  }) => api.post<SessionWorldBook>(`/api/character-sessions/${sessionId}/worldbook`, data),

  /** 取消对话的世界书关联 */
  disassociateSession: (sessionId: string) =>
    api.delete(`/api/character-sessions/${sessionId}/worldbook`),

  /** 获取对话的世界书状态 */
  getSessionStatus: (sessionId: string) =>
    api.get<WorldBookStatus>(`/api/character-sessions/${sessionId}/worldbook/status`),
};

