/**
 * WorldBookManager — 世界书管理界面（Phase 6B 关键词模式）
 * 列表、创建、编辑、导入、词条预览
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, BookOpen, FileJson, X } from 'lucide-react';
import { GlassCard } from './GlassCard';
import type { WorldBook, WorldBookDetail } from '@/types';
import type { Translations } from '@/types';

interface WorldBookManagerProps {
  worldBooks: WorldBook[];
  selectedWorldBook: WorldBookDetail | null;
  loading: boolean;
  t: Translations;
  onLoad: () => void;
  onCreate: (data: { name: string; description?: string; raw_content?: string }) => Promise<WorldBook>;
  onUpdate: (id: string, data: { name?: string; description?: string; raw_content?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onImport: (file: File) => Promise<WorldBook>;
  onSelect: (id: string) => void;
  onClose: () => void;
  selectedForProfileId?: string | null;
  onSelectForProfile?: (id: string | null) => void;
}

export function WorldBookManager({
  worldBooks, selectedWorldBook, loading,
  t: _t, onLoad, onCreate, onUpdate: _onUpdate, onDelete, onImport, onSelect, onClose,
  selectedForProfileId, onSelectForProfile,
}: WorldBookManagerProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [_editingId, _setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formContent, setFormContent] = useState('');
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => { onLoad(); }, [onLoad]);

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
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
            <BookOpen className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold text-lg">{selectedWorldBook.name}</h3>
          </div>
          <div className="flex items-center gap-2">
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
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs font-bold">
                      {stage.stage_index + 1}
                    </span>
                    <span className="font-medium text-sm">{stage.title || `词条 ${stage.stage_index + 1}`}</span>
                    {stage.constant && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400">常量</span>
                    )}
                    {stage.priority >= 8 && !stage.constant && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-400">高优先</span>
                    )}
                    {(stage.keys ?? []).length > 0 && (
                      <span className="text-[10px] text-blue-400/60">
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
                  <div className="px-3 pb-3 border-t border-white/5 space-y-2">
                    <div className="mt-2">
                      <label className="text-[11px] text-muted-foreground mb-1 block">关键词（英文逗号分隔）</label>
                      <input
                        defaultValue={(stage.keys ?? []).join(', ')}
                        placeholder="dragon, magic sword, castle..."
                        className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs focus:outline-none focus:border-blue-500/50"
                        readOnly
                      />
                    </div>
                    {(stage.selective) && stage.secondary_keys && stage.secondary_keys.length > 0 && (
                      <div>
                        <label className="text-[11px] text-muted-foreground mb-1 block">二级关键词</label>
                        <input
                          defaultValue={(stage.secondary_keys ?? []).join(', ')}
                          className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs focus:outline-none focus:border-blue-500/50"
                          readOnly
                        />
                      </div>
                    )}
                    <div className="flex gap-4 text-[11px] text-muted-foreground">
                      <span>概率: {stage.probability}%</span>
                      <span>扫描深度: {stage.scan_depth}</span>
                      {stage.selective && <span className="text-orange-400">双键模式</span>}
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
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-blue-400" />
          <h3 className="font-semibold text-lg">世界书</h3>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm cursor-pointer">
            <FileJson className="w-3.5 h-3.5" />
            导入
            <input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors text-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            新建
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Create form */}
        {showCreate && (
          <GlassCard className="p-4 space-y-3" strong>
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="世界书名称"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-blue-500/50"
            />
            <input
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
              placeholder="简介（可选）"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-blue-500/50"
            />
            <textarea
              value={formContent}
              onChange={e => setFormContent(e.target.value)}
              placeholder="在此编写世界书/剧本内容...&#10;&#10;或先创建后通过导入功能添加内容"
              rows={6}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-blue-500/50 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setFormName(''); setFormDesc(''); setFormContent(''); }}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={!formName.trim()}
                className="px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 text-sm transition-colors disabled:opacity-40"
              >
                创建
              </button>
            </div>
          </GlassCard>
        )}

        {/* World book list */}
        {loading && worldBooks.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">加载中...</div>
        ) : worldBooks.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>暂无世界书</p>
            <p className="text-xs mt-1">创建或导入一个世界书来增强角色扮演体验</p>
          </div>
        ) : (
          worldBooks.map(wb => (
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
                    <BookOpen className="w-4 h-4 text-blue-400 shrink-0" />
                    <span className="font-medium text-sm">{wb.name}</span>
                    {wb.is_parsed && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/20 text-green-400">
                        {wb.stage_count}词条
                      </span>
                    )}
                    {wb.format === 'silly_tavern_v2' && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-400">ST</span>
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
                        className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(wb.id)}
                      className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-muted-foreground"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </GlassCard>
          ))
        )}
      </div>
    </div>
  );
};
