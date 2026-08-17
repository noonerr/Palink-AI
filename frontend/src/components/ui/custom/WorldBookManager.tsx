/**
 * WorldBookManager — 世界书管理界面（Phase 6B 关键词模式）
 * 列表、创建、编辑、导入、词条预览
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, ChevronLeft, BookOpen, FileJson, X, Layers } from 'lucide-react';
import { GlassCard } from './GlassCard';
import type { WorldBook, WorldBookDetail } from '@/types';
import type { Translations } from '@/types';
import type { Blueprint } from '@/lib/worldbook/types';
import { worldbookApi } from '@/services/worldbookApi';

interface WorldBookManagerProps {
  worldBooks: WorldBook[];
  selectedWorldBook: WorldBookDetail | null;
  loading: boolean;
  t: Translations;
  onLoad: (characterId?: string, type?: string) => void | Promise<void>;
  onCreate: (data: { name: string; description?: string; raw_content?: string }) => Promise<WorldBook>;
  onUpdate: (id: string, data: { name?: string; description?: string; raw_content?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onImport: (file: File) => Promise<WorldBook>;
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
  t: _t, onLoad, onCreate, onUpdate: _onUpdate, onDelete, onImport, onSelect, onClose,
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
    await onCreate({ name: formName.trim(), description: formDesc.trim() || undefined, raw_content: formContent.trim() || undefined });
    setFormName(''); setFormDesc(''); setFormContent(''); setShowCreate(false);
  }, [formName, formDesc, formContent, onCreate]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await onImport(file);
    e.target.value = '';
  }, [onImport]);

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
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setFormName(''); setFormDesc(''); setFormContent(''); }}
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
