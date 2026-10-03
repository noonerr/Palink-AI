/**
 * WorldBookManager — 世界书管理界面（Phase 6B 关键词模式）
 * 列表、创建、编辑、导入、词条预览
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, ChevronLeft, BookOpen, FileJson, X, Layers } from 'lucide-react';
import { GlassCard } from './GlassCard';
import type { WorldBook, WorldBookDetail, WorldBookStage, Character } from '@/types';
import type { Translations } from '@/types';
import type { Blueprint } from '@/lib/worldbook/types';
import { worldbookApi } from '@/services/worldbookApi';
import { api } from '@/services/api';

interface WorldBookManagerProps {
  worldBooks: WorldBook[];
  selectedWorldBook: WorldBookDetail | null;
  loading: boolean;
  t: Translations;
  onLoad: (characterId?: string, type?: string) => void | Promise<void>;
  onCreate: (data: { name: string; description?: string; raw_content?: string; character_id?: string | null }) => Promise<WorldBook>;
  onUpdate: (id: string, data: { name?: string; description?: string; raw_content?: string; character_id?: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /**
   * [WB-CHAR-BIND-IMPORT 2026-10-03] characterId：导入前在界面上选好的归属角色；
   * 不传 = 未绑定（不注入任何对话，2026-10-03 起）。
   */
  onImport: (file: File, characterId?: string | null) => Promise<WorldBook>;
  onSelect: (id: string) => void;
  onClose: () => void;
  onBackToList?: () => void;
  characterId?: string;
  selectedForProfileId?: string | null;
  onSelectForProfile?: (id: string | null) => void;
  typeFilter?: 'character_book' | 'world_book' | null;
  onTypeFilterChange?: (type: 'character_book' | 'world_book' | null) => void;
}

export function WorldBookManager({
  worldBooks, selectedWorldBook, loading: _loading,
  t: _t, onLoad, onCreate, onUpdate, onDelete, onImport, onSelect, onClose,
  onBackToList, characterId, selectedForProfileId, onSelectForProfile,
  typeFilter: typeFilterProp, onTypeFilterChange: onTypeFilterChangeProp,
}: WorldBookManagerProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [_editingId, _setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formContent, setFormContent] = useState('');
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [internalTypeFilter, setInternalTypeFilter] = useState<'character_book' | 'world_book' | null>(null);

  // [WB-CHAR-ISOLATION 2026-10-03] 角色绑定控件状态。
  // 绑定维度 = 这本书只对哪个角色生效（对齐 ST world_info.charLore）。
  // 不绑 = 未绑定（不注入任何对话）。世界书都该随角色卡走。
  const [bindableChars, setBindableChars] = useState<Character[]>([]);
  const [bindSaving, setBindSaving] = useState(false);
  const [bindError, setBindError] = useState('');
  const [createBindCharId, setCreateBindCharId] = useState<string>('');

  // 角色下拉只拉 id/name（fields=basic），不要把整卡正文拖进来。
  const loadBindableChars = useCallback(async () => {
    try {
      const list = await api.get('/api/characters?fields=basic', { cacheTtlMs: 60_000 });
      if (Array.isArray(list)) setBindableChars(list as Character[]);
    } catch (e) {
      console.error('Failed to load characters for world book binding:', e);
      setBindError('角色列表加载失败，暂时改不了绑定');
    }
  }, []);

  useEffect(() => { void loadBindableChars(); }, [loadBindableChars]);

  // 换书时清空绑定错误态，避免上一本书的报错串到新书
  useEffect(() => { setBindError(''); }, [selectedWorldBook?.id]);

  // [WB-CHAR-BIND-IMPORT 2026-10-03] 导入归属预选当前对话角色。
  // 只在用户**还没自己选过**时跟随（``importBindCharDirty`` 标记）—— 否则切一次卡
  // 就把用户明确选好的目标改回去，那是更糟的静默行为。
  const [importBindCharDirty, setImportBindCharDirty] = useState(false);
  useEffect(() => {
    if (importBindCharDirty) return;
    setImportBindCharId(characterId || '');
  }, [characterId, importBindCharDirty]);

  const handleChangeBinding = useCallback(async (nextCharId: string) => {
    if (!selectedWorldBook || bindSaving) return;
    setBindSaving(true);
    setBindError('');
    // 空串 = 解绑（传 null，后端 model_fields_set 判定为"显式解绑"）
    const payload = { character_id: nextCharId || null };
    try {
      await onUpdate(selectedWorldBook.id, payload);
    } catch (e) {
      setBindError('保存失败，绑定没有改');
      console.error('Failed to update world book character binding:', e);
    } finally {
      setBindSaving(false);
    }
  }, [selectedWorldBook, bindSaving, onUpdate]);

  // 语义召回勾选（SPEC §11 D）：本组件此前无任何写通道（展开区全 readOnly），
  // 勾选走 worldbookApi.updateStage 单独落库；本地乐观更新 + 失败回滚，
  // 其余字段仍保持只读展示（不在本批范围内）。
  const [vectorOverride, setVectorOverride] = useState<Record<string, boolean>>({});
  const [vectorSaving, setVectorSaving] = useState<Record<string, boolean>>({});
  const [vectorError, setVectorError] = useState<string>('');

  // 换书时清空乐观覆盖，避免上一本书的勾选状态串到新书
  useEffect(() => {
    setVectorOverride({});
    setVectorSaving({});
    setVectorError('');
  }, [selectedWorldBook?.id]);

  const handleToggleVectorRecall = useCallback(async (stage: WorldBookStage, next: boolean) => {
    if (!selectedWorldBook || vectorSaving[stage.id]) return;
    setVectorSaving((s) => ({ ...s, [stage.id]: true }));
    setVectorError('');
    setVectorOverride((o) => ({ ...o, [stage.id]: next }));  // 乐观更新
    try {
      const updated = await worldbookApi.updateStage(
        selectedWorldBook.id, stage.id, { vectorized: next },
      );
      // 以服务端回读值为准（后端 _stage_to_response 是真白名单）
      setVectorOverride((o) => ({ ...o, [stage.id]: !!updated.vectorized }));
    } catch (e) {
      setVectorOverride((o) => ({ ...o, [stage.id]: !!stage.vectorized }));  // 回滚
      setVectorError('保存失败，「按意思找」的勾选没有生效');
      console.error('Failed to update stage vectorized:', e);
    } finally {
      setVectorSaving((s) => ({ ...s, [stage.id]: false }));
    }
  }, [selectedWorldBook, vectorSaving]);

  // Blueprint apply state
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [showBlueprintMenu, setShowBlueprintMenu] = useState(false);
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<number | null>(null);
  const [applyingBlueprint, setApplyingBlueprint] = useState(false);
  const [blueprintStatus, setBlueprintStatus] = useState<string>('');

  const typeFilter = typeFilterProp ?? internalTypeFilter;
  const handleTypeFilterChange = useCallback((type: 'character_book' | 'world_book' | null) => {
    if (onTypeFilterChangeProp) {
      onTypeFilterChangeProp(type);
    } else {
      setInternalTypeFilter(type);
    }
  }, [onTypeFilterChangeProp]);

  useEffect(() => {
    setListLoading(true);
    Promise.resolve(onLoad(characterId, typeFilter || undefined)).finally(() => setListLoading(false));
  }, [onLoad, characterId, typeFilter]);

  const handleCreate = useCallback(async () => {
    if (!formName.trim()) return;
    await onCreate({
      name: formName.trim(),
      description: formDesc.trim() || undefined,
      raw_content: formContent.trim() || undefined,
      // [WB-CHAR-ISOLATION 2026-10-03 / 同日修订] 建书时绑角色；留空 = 未绑定（不生效）
      character_id: createBindCharId || null,
    });
    setFormName(''); setFormDesc(''); setFormContent(''); setCreateBindCharId(''); setShowCreate(false);
  }, [formName, formDesc, formContent, createBindCharId, onCreate]);

  // [WB-CHAR-BIND-IMPORT 2026-10-03] 导入前的归属选择。
  // 默认预选**当前对话角色**（characterId prop）：从某个角色的对话里点导入，
  // 用户主观上就是要导入给这张卡用，预选可免去一次选择动作；
  // 不想要就下拉选「未绑定」（空串），那本书不会注入任何对话。
  // ⚠️ 预选只是默认值，**用户可改**。不预选的后果已从「串味」降级为
  // 「这本书不生效」，且有 [WB-UNBOUND] 告警暴露。
  const [importBindCharId, setImportBindCharId] = useState<string>('');
  // 导入完的提示：没选角色 → 这本未绑定（不生效），明确告诉用户「要不要绑」
  const [importNotice, setImportNotice] = useState<{ name: string; id: string } | null>(null);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 与建书走同一个 selector 语义：空串 = 未绑定（不生效）
    const targetCharId = importBindCharId || null;
    try {
      const wb = await onImport(file, targetCharId);
      // [WB-CHAR-BIND-IMPORT] 没指定归属 → 这本未绑定（不生效），明说。
      // 不静默：用户以为「导入的这本会生效」而实际不生效，需要他知道。
      if (!targetCharId) {
        setImportNotice({ name: wb?.name || file.name, id: wb?.id });
      } else {
        setImportNotice(null);
      }
    } finally {
      e.target.value = '';
    }
  }, [importBindCharId, onImport]);

  const handleLoadBlueprints = useCallback(async () => {
    if (blueprints.length > 0) return;
    try {
      const list = await worldbookApi.listBlueprints();
      setBlueprints(list);
    } catch (e) {
      console.error('Failed to load blueprints:', e);
      setBlueprintStatus('蓝图加载失败');
    }
  }, [blueprints.length]);

  const handleApplyBlueprint = useCallback(async () => {
    if (!selectedWorldBook || selectedBlueprintId == null || applyingBlueprint) return;
    setApplyingBlueprint(true);
    setBlueprintStatus('应用中...');
    try {
      const result = await worldbookApi.applyBlueprint(selectedWorldBook.id, selectedBlueprintId);
      setBlueprintStatus(`已创建 ${result.created_count} 条，跳过 ${result.skipped_count} 条（幂等去重）`);
      setShowBlueprintMenu(false);
      setSelectedBlueprintId(null);
      // 重新加载世界书详情以显示新条目
      onSelect(selectedWorldBook.id);
    } catch (e) {
      console.error('Failed to apply blueprint:', e);
      setBlueprintStatus('应用蓝图失败');
    } finally {
      setApplyingBlueprint(false);
    }
  }, [selectedWorldBook, selectedBlueprintId, applyingBlueprint, onSelect]);

  const toggleStage = (stageId: string) => {
    setExpandedStages(prev => {
      const next = new Set(prev);
      if (next.has(stageId)) {
        next.delete(stageId);
      } else {
        next.add(stageId);
      }
      return next;
    });
  };

  // Detail view
  if (selectedWorldBook) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <button onClick={onBackToList || onClose} className="p-1.5 rounded-lg hover:bg-muted/30 transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <BookOpen className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            <h3 className="font-semibold text-lg">{selectedWorldBook.name}</h3>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => {
                  const next = !showBlueprintMenu;
                  setShowBlueprintMenu(next);
                  if (next) handleLoadBlueprints();
                }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-500/15 dark:bg-purple-500/20 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 dark:hover:bg-purple-500/30 transition-colors text-sm"
                title="应用蓝图"
              >
                <Layers className="w-3.5 h-3.5" />
                应用蓝图
              </button>
              {showBlueprintMenu && (
                <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-lg border border-border/50 bg-background shadow-lg p-2 space-y-2">
                  {blueprints.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">暂无可用蓝图</p>
                  ) : (
                    <>
                      <select
                        value={selectedBlueprintId ?? ''}
                        onChange={e => setSelectedBlueprintId(e.target.value ? Number(e.target.value) : null)}
                        className="w-full px-2 py-1.5 rounded-lg bg-muted/20 border border-border/50 text-sm focus:outline-none focus:border-primary/50"
                      >
                        <option value="">选择蓝图...</option>
                        {blueprints.map(bp => (
                          <option key={bp.id} value={bp.id}>{bp.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleApplyBlueprint}
                        disabled={selectedBlueprintId == null || applyingBlueprint}
                        className="w-full px-3 py-1.5 rounded-lg bg-purple-500/15 dark:bg-purple-500/20 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 dark:hover:bg-purple-500/30 text-sm transition-colors disabled:opacity-40"
                      >
                        {applyingBlueprint ? '应用中...' : '应用'}
                      </button>
                    </>
                  )}
                  {blueprintStatus && (
                    <p className="text-[11px] text-muted-foreground text-center">{blueprintStatus}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {selectedWorldBook.description && (
          <p className="px-4 pt-3 text-sm text-muted-foreground">{selectedWorldBook.description}</p>
        )}

        {/* [WB-CHAR-ISOLATION 2026-10-03] 绑定角色选择器（只加控件，不改布局结构） */}
        <div className="px-4 pt-3">
          <label className="text-[11px] text-muted-foreground mb-1 block">这本书对哪个角色生效</label>
          <select
            value={selectedWorldBook.character_id || ''}
            disabled={bindSaving}
            onChange={(e) => void handleChangeBinding(e.target.value)}
            className="w-full px-2 py-1.5 rounded-lg bg-muted/20 border border-border/50 text-xs focus:outline-none focus:border-primary/50 disabled:opacity-50"
          >
            <option value="">未绑定（不生效）</option>
            {bindableChars.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
            {selectedWorldBook.character_id
              ? '只跟着这个角色走，换角色就不会带这本书。'
              : '没绑角色的书不注入任何对话（2026-10-03 起）—— 世界书都该随角色卡走。挑一个角色就能启用它。'}
          </p>
          {bindSaving && <p className="text-[11px] text-muted-foreground">保存中…</p>}
          {bindError && <p className="text-[11px] text-red-500 dark:text-red-400">{bindError}</p>}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {selectedWorldBook.stages.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>暂无词条</p>
              <p className="text-xs mt-1">导入 SillyTavern 世界书 JSON 或自行添加词条</p>
            </div>
          ) : (
            selectedWorldBook.stages.map((stage) => (
              <GlassCard key={stage.id} className="p-0 overflow-hidden" hover>
                <button
                  onClick={() => toggleStage(stage.id)}
                  className="w-full flex items-center justify-between p-3 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-500/15 dark:bg-blue-500/20 text-blue-500 dark:text-blue-400 text-xs font-bold">
                      {stage.stage_index + 1}
                    </span>
                    <span className="font-medium text-sm">{stage.title || `词条 ${stage.stage_index + 1}`}</span>
                    {(vectorOverride[stage.id] ?? stage.vectorized) && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-teal-500/15 dark:bg-teal-500/20 text-teal-600 dark:text-teal-300">按意思找</span>
                    )}
                    {stage.constant && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400">常量</span>
                    )}
                    {stage.priority >= 8 && !stage.constant && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 dark:bg-orange-500/20 text-orange-500 dark:text-orange-400">高优先</span>
                    )}
                    {(stage.keys ?? []).length > 0 && (
                      <span className="text-[10px] text-blue-500/60 dark:text-blue-400/60">
                        {(stage.keys ?? []).slice(0, 2).join(', ')}{(stage.keys ?? []).length > 2 ? '...' : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>~{stage.token_count} tokens</span>
                    {expandedStages.has(stage.id) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>
                {expandedStages.has(stage.id) && (
                  <div className="px-3 pb-3 border-t border-border/30 space-y-2">
                    <div className="mt-2">
                      <label className="text-[11px] text-muted-foreground mb-1 block">关键词（英文逗号分隔）</label>
                      <input
                        defaultValue={(stage.keys ?? []).join(', ')}
                        placeholder="dragon, magic sword, castle..."
                        className="w-full px-2 py-1.5 rounded-lg bg-muted/20 border border-border/50 text-xs focus:outline-none focus:border-primary/50"
                        readOnly
                      />
                    </div>
                    {(stage.selective) && stage.secondary_keys && stage.secondary_keys.length > 0 && (
                      <div>
                        <label className="text-[11px] text-muted-foreground mb-1 block">二级关键词</label>
                        <input
                          defaultValue={(stage.secondary_keys ?? []).join(', ')}
                          className="w-full px-2 py-1.5 rounded-lg bg-muted/20 border border-border/50 text-xs focus:outline-none focus:border-primary/50"
                          readOnly
                        />
                      </div>
                    )}
                    <div className="flex gap-4 text-[11px] text-muted-foreground">
                      <span>概率: {stage.probability}%</span>
                      <span>扫描深度: {stage.scan_depth}</span>
                      {stage.selective && <span className="text-orange-500 dark:text-orange-400">双键模式</span>}
                    </div>
                    {/* 语义召回勾选（SPEC §11 D）：文案一律人话，不出现英文键名 */}
                    <div className="pt-1">
                      <label className="flex items-center gap-2 text-[12px] cursor-pointer">
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 accent-primary"
                          disabled={!!vectorSaving[stage.id]}
                          checked={vectorOverride[stage.id] ?? stage.vectorized}
                          onChange={(e) => void handleToggleVectorRecall(stage, e.target.checked)}
                        />
                        <span className="font-medium">按意思找这条设定</span>
                        {vectorSaving[stage.id] && (
                          <span className="text-[11px] text-muted-foreground">保存中…</span>
                        )}
                      </label>
                      <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
                        勾上后这条<strong className="font-medium text-foreground">不再靠关键词触发</strong>，
                        而是按语义相似度找；写了关键词的条目建议不要勾。
                      </p>
                      {(vectorOverride[stage.id] ?? stage.vectorized) && (stage.keys ?? []).length === 0 && (
                        <p className="mt-1 text-[11px] text-orange-500 dark:text-orange-400 leading-relaxed">
                          这条没写关键词，只能靠语义召回；语义服务不可用时这条不会被注入。
                        </p>
                      )}
                      {(vectorOverride[stage.id] ?? stage.vectorized) && (
                        <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
                          还要在「设置 → 角色扮演引擎 → 世界书全局设置」里打开「世界书语义召回」：
                          打开总开关后才会开始为这本书建立索引，现在还没开始算；
                          第一次打开后的下一条消息开始准备，再下一条才生效。
                        </p>
                      )}
                    </div>
                    {vectorError && (
                      <p className="text-[11px] text-red-500 dark:text-red-400">{vectorError}</p>
                    )}
                    {stage.summary && (
                      <p className="text-xs text-muted-foreground italic">{stage.summary}</p>
                    )}
                    <pre className="text-xs whitespace-pre-wrap text-foreground/80 max-h-48 overflow-y-auto">
                      {stage.content}
                    </pre>
                  </div>
                )}
              </GlassCard>
            ))
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-border/50">
        <div className="flex items-center gap-2">
            <BookOpen className={`w-5 h-5 ${typeFilter === 'character_book' ? 'text-purple-500 dark:text-purple-400' : 'text-blue-500 dark:text-blue-400'}`} />
            <h3 className="font-semibold text-lg">
              {typeFilter === 'character_book' ? '角色书' : typeFilter === 'world_book' ? '世界书' : '知识库'}
            </h3>
          </div>
        <div className="flex items-center gap-2">
          {/* [WB-CHAR-BIND-IMPORT 2026-10-03] 导入归属选择：放在「导入」按钮旁边，
              让用户在点之前就看清「这本书会进谁名下」。默认预选当前对话角色。 */}
          <select
            value={importBindCharId}
            onChange={(e) => { setImportBindCharDirty(true); setImportBindCharId(e.target.value); }}
            title="导入的这本书对哪个角色生效"
            className="max-w-[9rem] px-2 py-1.5 rounded-lg bg-muted/20 border border-border/50 text-xs focus:outline-none focus:border-primary/50"
          >
            <option value="">导入为未绑定（不生效）</option>
            {bindableChars.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors text-sm cursor-pointer">
            <FileJson className="w-3.5 h-3.5" />
            导入
            <input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
          {typeFilter !== 'character_book' && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-500/15 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300 hover:bg-blue-500/25 dark:hover:bg-blue-500/30 transition-colors text-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              新建
            </button>
          )}
        </div>
      </div>

      {/* [WB-CHAR-BIND-IMPORT 2026-10-03] 导入了「未绑定」书后的明说提示。
          直接给出「点这里绑定到当前角色」的入口 —— 后端 PUT 的 character_id 绑定
          早已存在（详情页有选择器），这里只是把入口前移到刚导入完的那一刻。 */}
      {importNotice && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-700 dark:text-amber-300 flex items-center justify-between gap-2">
          <span className="leading-relaxed">
            「{importNotice.name}」现在是<b>未绑定</b> —— 不会注入任何对话。要绑到当前这张卡吗？
          </span>
          <span className="flex items-center gap-2 shrink-0">
            {characterId && (
              <button
                onClick={() => {
                  void onUpdate(importNotice.id, { character_id: characterId });
                  setImportNotice(null);
                }}
                className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 transition-colors"
              >
                绑到当前角色
              </button>
            )}
            <button onClick={() => setImportNotice(null)} className="px-1 text-amber-600/70 hover:text-amber-500" title="关闭">
              <X className="w-3 h-3" />
            </button>
          </span>
        </div>
      )}

      {/* Type filter tabs */}
      <div className="flex gap-1 px-4 py-2 border-b border-border/30">
        <button
          onClick={() => handleTypeFilterChange(null)}
          className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${!typeFilter ? 'bg-blue-500/15 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300' : 'bg-muted/20 text-muted-foreground hover:bg-muted/30'}`}
        >
          全部
        </button>
        <button
          onClick={() => handleTypeFilterChange('character_book')}
          className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${typeFilter === 'character_book' ? 'bg-purple-500/15 dark:bg-purple-500/20 text-purple-600 dark:text-purple-300' : 'bg-muted/20 text-muted-foreground hover:bg-muted/30'}`}
        >
          角色书
        </button>
        <button
          onClick={() => handleTypeFilterChange('world_book')}
          className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${typeFilter === 'world_book' ? 'bg-blue-500/15 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300' : 'bg-muted/20 text-muted-foreground hover:bg-muted/30'}`}
        >
          世界书
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Create form */}
        {showCreate && (
          <GlassCard className="p-4 space-y-3" strong>
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="世界书名称"
              className="w-full px-3 py-2 rounded-lg bg-muted/20 border border-border/50 text-sm focus:outline-none focus:border-primary/50"
            />
            <input
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
              placeholder="简介（可选）"
              className="w-full px-3 py-2 rounded-lg bg-muted/20 border border-border/50 text-sm focus:outline-none focus:border-primary/50"
            />
            <textarea
              value={formContent}
              onChange={e => setFormContent(e.target.value)}
              placeholder="在此编写世界书/剧本内容...&#10;&#10;或先创建后通过导入功能添加内容"
              rows={6}
              className="w-full px-3 py-2 rounded-lg bg-muted/20 border border-border/50 text-sm focus:outline-none focus:border-primary/50 resize-none"
            />
            {/* [WB-CHAR-ISOLATION 2026-10-03 / 同日修订] 建书时选角色；不选 = 未绑定 */}
            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">这本书对哪个角色生效（可选）</label>
              <select
                value={createBindCharId}
                onChange={e => setCreateBindCharId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-muted/20 border border-border/50 text-sm focus:outline-none focus:border-primary/50"
              >
                <option value="">未绑定（不生效）</option>
                {bindableChars.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                绑了角色就只有那个角色会带上它；不绑则这本书不注入任何对话。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setFormName(''); setFormDesc(''); setFormContent(''); setCreateBindCharId(''); }}
                className="px-3 py-1.5 rounded-lg bg-muted/20 hover:bg-muted/30 text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={!formName.trim()}
                className="px-3 py-1.5 rounded-lg bg-blue-500/15 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300 hover:bg-blue-500/25 dark:hover:bg-blue-500/30 text-sm transition-colors disabled:opacity-40"
              >
                创建
              </button>
            </div>
          </GlassCard>
        )}

        {/* World book list */}
        {listLoading && worldBooks.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">加载中...</div>
        ) : worldBooks.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>{typeFilter === 'character_book' ? '暂无角色书' : typeFilter === 'world_book' ? '暂无世界书' : '暂无知识库'}</p>
            <p className="text-xs mt-1">
              {typeFilter === 'character_book' 
                ? '导入带有角色书的角色卡后会显示在这里' 
                : typeFilter === 'world_book'
                  ? '创建或导入一个世界书来增强角色扮演体验'
                  : '创建或导入知识库来增强角色扮演体验'
              }
            </p>
          </div>
        ) : (
          worldBooks.map(wb => {
            const isCharacterBook = wb.type === 'character_book';
            return (
              <GlassCard 
                key={wb.id} 
                className={`p-3 ${selectedForProfileId === wb.id ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
                hover
              >
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => {
                      if (onSelectForProfile) {
                        onSelectForProfile(selectedForProfileId === wb.id ? null : wb.id);
                      } else {
                        onSelect(wb.id);
                      }
                    }}
                    className="flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <BookOpen className={`w-4 h-4 shrink-0 ${isCharacterBook ? 'text-purple-500 dark:text-purple-400' : 'text-blue-500 dark:text-blue-400'}`} />
                      <span className="font-medium text-sm">{wb.name}</span>
                      {wb.is_parsed && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/15 dark:bg-green-500/20 text-green-500 dark:text-green-400">
                          {wb.stage_count}词条
                        </span>
                      )}
                      {wb.format === 'silly_tavern_v2' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 dark:bg-orange-500/20 text-orange-500 dark:text-orange-400">ST</span>
                      )}
                      {isCharacterBook && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/15 dark:bg-purple-500/20 text-purple-500 dark:text-purple-400">角色书</span>
                      )}
                      {/* [WB-CHAR-ISOLATION 2026-10-03] 来源徽标：绑了角色 = 只给它；
                          没绑 = 不生效（不注入任何对话）。 */}
                      {!isCharacterBook && (wb.character_id ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/15 dark:bg-sky-500/20 text-sky-600 dark:text-sky-300">已绑角色</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300">未绑定</span>
                      ))}
                    </div>
                    {wb.description && (
                      <p className="text-xs text-muted-foreground mt-1 ml-6 line-clamp-1">{wb.description}</p>
                    )}
                  </button>
                  <div className="flex items-center gap-1 ml-2">
                    {confirmDelete === wb.id ? (
                      <>
                        <button
                          onClick={() => { onDelete(wb.id); setConfirmDelete(null); }}
                          className="px-2 py-1 rounded text-xs bg-red-500/15 dark:bg-red-500/20 text-red-500 dark:text-red-400 hover:bg-red-500/25 dark:hover:bg-red-500/30"
                        >
                          确认
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-1 rounded text-xs bg-muted/20 hover:bg-muted/30"
                        >
                          取消
                        </button>
                      </>
                    ) : !isCharacterBook && (
                      <button
                        onClick={() => setConfirmDelete(wb.id)}
                        className="p-1.5 rounded-lg hover:bg-muted/30 transition-colors text-muted-foreground"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </GlassCard>
            );
          })
        )}
      </div>
    </div>
  );
};
