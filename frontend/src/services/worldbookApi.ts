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
    /**
     * [WB-CHAR-BIND 2026-10-03] 绑定角色（对齐 ST world_info.charLore）。
     * 不传 = 全局书（对所有卡生效）；传角色 id = 只对该角色注入。
     */
    character_id?: string | null;
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
    /**
     * [WB-CHAR-BIND 2026-10-03] 传 null = 解绑（回到全局）。
     * 不传该键 = 不改（后端用 model_fields_set 区分二者）。
     */
    character_id?: string | null;
    /**
     * [ST-BRIDGE-BOOKBIND 2026-10-20] 世界书类型（此前全仓无 API 写通道）。
     *
     * Palink 认「这张卡的角色书是哪本」依赖两列的合取：
     *   `character_id`（归属）+ `type == 'character_book'`（角色书标记）。
     * 后者同时决定 MVU 是否从这本书里抽 <initvar>/schema
     * （services/mvu_entry_filter.select_character_book_contents），
     * 也是 api/worldbook.py list_worldbooks 判 primary 的条件。
     * 不传 = 不改；只接受 'world_book' | 'character_book' 两档（其它值后端 422）。
     */
    type?: 'world_book' | 'character_book';
  }) => api.put<WorldBook>(`/api/worldbooks/${id}`, data).then((res) => {
    invalidateCache('/api/worldbooks');
    return res;
  }),

  /** 删除世界书 */
  delete: (id: string) => api.delete(`/api/worldbooks/${id}`).then((res) => {
    invalidateCache('/api/worldbooks');
    return res;
  }),

  /**
   * 导入 SillyTavern V2 JSON 世界书
   *
   * [WB-CHAR-BIND-IMPORT 2026-10-03] 可选 `characterId`：导入时就指定这本书记到
   * 哪张卡名下。**不传 = 全局书**（与修复前逐字一致）。
   * ⚠️ 必须走 FormData 追加字段（后端是 `Form(None)`，不是 query 参数）——
   * 传查询参数会被 FastAPI 静默忽略，书照样落成全局书，用户以为隔离了其实没有。
   */
  import: (file: File, characterId?: string | null) => {
    const formData = new FormData();
    formData.append('file', file);
    // 空串/空值一律不追加：与「不传」同义 = 全局书（后端 Form(None) 默认值）
    if (characterId) {
      formData.append('character_id', String(characterId));
    }
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
    /**
     * 语义召回勾选（SPEC §11 A 白名单之一）。
     * 不传 = 不修改（后端 Optional[bool]=None），只改内容时不会把勾选冲掉。
     */
    vectorized?: boolean;
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

