/**
 * World Book API service layer
 */
import { api, invalidateCache } from './api';
import type {
  WorldBook,
  WorldBookDetail,
  WorldBookStage,
  SessionWorldBook,
  WorldBookStatus,
} from '@/types';
import type { Blueprint, BlueprintApplyResult } from '@/lib/worldbook/types';

// ── World Book CRUD ──

export const worldbookApi = {
  /** 获取用户所有世界书 */
  list: (params?: { character_id?: string; type?: string }) => {
    const query = new URLSearchParams();
    if (params?.character_id) query.set('character_id', params.character_id);
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    return api.get<WorldBook[]>(`/api/worldbooks${qs ? `?${qs}` : ''}`, { cacheTtlMs: 60_000 });
  },

  /** 创建世界书 */
  create: (data: {
    name: string;
    description?: string;
    source_type?: string;
    raw_content?: string;
    format?: string;
    tags?: string[];
  }) => api.post<WorldBook>('/api/worldbooks', data).then((res) => {
    invalidateCache('/api/worldbooks');
    return res;
  }),

  /** 获取世界书详情（含词条列表） */
  get: (id: string) => api.get<WorldBookDetail>(`/api/worldbooks/${id}`, { cacheTtlMs: 30_000 }),

  /** 编辑世界书 */
  update: (id: string, data: {
    name?: string;
    description?: string;
    raw_content?: string;
    tags?: string[];
  }) => api.put<WorldBook>(`/api/worldbooks/${id}`, data).then((res) => {
    invalidateCache('/api/worldbooks');
    return res;
  }),

  /** 删除世界书 */
  delete: (id: string) => api.delete(`/api/worldbooks/${id}`).then((res) => {
    invalidateCache('/api/worldbooks');
    return res;
  }),

  /** 导入 SillyTavern V2 JSON 世界书 */
  import: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<WorldBook>('/api/worldbooks/import', formData).then((res) => {
      invalidateCache('/api/worldbooks');
      return res;
    });
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
  }) => api.put<WorldBookStage>(`/api/worldbooks/${worldBookId}/stages/${stageId}`, data).then((res) => {
    invalidateCache('/api/worldbooks');
    return res;
  }),

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

  // ── Blueprints (ST 1.18.0) ──

  /** 列出所有世界书蓝图 */
  listBlueprints: () => api.get<Blueprint[]>('/api/worldbook-blueprints', { cacheTtlMs: 5 * 60_000 }),

  /** 获取蓝图详情 */
  getBlueprint: (id: number) => api.get<Blueprint>(`/api/worldbook-blueprints/${id}`),

  /** 将蓝图应用到指定世界书（幂等：通过 comment 去重） */
  applyBlueprint: (worldbookId: string, blueprintId: number) =>
    api.post<BlueprintApplyResult>(`/api/worldbook-blueprints/${blueprintId}/apply`, {
      worldbook_id: worldbookId,
    }).then((res) => {
      // 应用蓝图会改写世界书词条，需失效世界书缓存
      invalidateCache('/api/worldbooks');
      return res;
    }),
};

