/**
 * PlotLineManager — 剧情线管理界面（Phase 6C）
 * 列表、创建、编辑、AI 分段、阶段预览与编辑、阶段跳转
 */
import React, { useState, useEffect } from 'react';
import { Plus, Sparkles, Trash2, ChevronDown, ChevronUp, BookOpen, X, Pencil, Unlink } from 'lucide-react';
import { GlassCard } from './GlassCard';
import type { PlotLine, PlotLineDetail } from '@/types';
import type { Translations } from '@/types';

interface PlotLineManagerProps {
  plotLines: PlotLine[];
  selectedPlotLine: PlotLineDetail | null;
  loading: boolean;
  parsing: boolean;
  models: Array<{ id: string; name?: string; alias?: string }>;
  selectedModel: string;
  t: Translations;
  onLoad: () => void;
  onCreate: (data: { name: string; description?: string; raw_content?: string }) => Promise<PlotLine>;
  onUpdate: (id: string, data: { name?: string; description?: string; raw_content?: string }) => Promise<void>;
  onUpdateStage: (plotLineId: string, stageId: string, data: { title?: string; content?: string; summary?: string; transition_hint?: string; priority?: number }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onParse: (id: string, model: string) => Promise<void>;
  onSelect: (id: string) => void;
  onJumpToStage?: (stageIndex: number) => void;
  onDisassociate?: () => Promise<void>;
  hasSessionAssociation?: boolean;
  onClose: () => void;
}

export function PlotLineManager({
  plotLines, selectedPlotLine, loading, parsing, models, selectedModel,
  t: _t, onLoad, onCreate, onUpdate, onUpdateStage, onDelete, onParse, onSelect, onJumpToStage, onDisassociate, hasSessionAssociation, onClose,
}: PlotLineManagerProps) {
  const [view, setView] = useState<'list' | 'create'>('list');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newContent, setNewContent] = useState('');
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const [localModel, setLocalModel] = useState(selectedModel);

  // 编辑 PlotLine 的状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editContent, setEditContent] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // 编辑阶段的状态：stageId -> 正在编辑
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [stageEditTitle, setStageEditTitle] = useState('');
  const [stageEditSummary, setStageEditSummary] = useState('');
  const [stageEditContent, setStageEditContent] = useState('');
  const [stageEditTransition, setStageEditTransition] = useState('');
  const [savingStage, setSavingStage] = useState(false);

  useEffect(() => { onLoad(); }, [onLoad]);
  useEffect(() => { setLocalModel(selectedModel); }, [selectedModel]);

  const toggleStage = (id: string) => {
    setExpandedStages(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await onCreate({ name: newName.trim(), description: newDesc.trim() || undefined, raw_content: newContent.trim() || undefined });
    setNewName(''); setNewDesc(''); setNewContent('');
    setView('list');
  };

  // 开启 PlotLine 编辑
  const handleStartEdit = (pl: PlotLine) => {
    setEditingId(pl.id);
    setEditName(pl.name || '');
    setEditDesc(pl.description || '');
    setEditContent((pl as any).raw_content || '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName(''); setEditDesc(''); setEditContent('');
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    setSavingEdit(true);
    try {
      await onUpdate(editingId, {
        name: editName.trim(),
        description: editDesc.trim() || undefined,
        raw_content: editContent.trim() || undefined,
      });
      setEditingId(null);
    } finally {
      setSavingEdit(false);
    }
  };

  // 开启阶段编辑
  const handleStartStageEdit = (stage: any) => {
    setEditingStageId(String(stage.id));
    setStageEditTitle(stage.title || '');
    setStageEditSummary(stage.summary || '');
    setStageEditContent(stage.content || '');
    setStageEditTransition(stage.transition_hint || '');
  };

  const handleCancelStageEdit = () => {
    setEditingStageId(null);
    setStageEditTitle(''); setStageEditSummary(''); setStageEditContent(''); setStageEditTransition('');
  };

  const handleSaveStageEdit = async () => {
    if (!editingStageId || !selectedPlotLine) return;
    setSavingStage(true);
    try {
      await onUpdateStage(selectedPlotLine.id, editingStageId, {
        title: stageEditTitle.trim() || undefined,
        summary: stageEditSummary.trim() || undefined,
        content: stageEditContent,
        transition_hint: stageEditTransition.trim() || undefined,
      });
      setEditingStageId(null);
    } finally {
      setSavingStage(false);
    }
  };

  // ── Detail View ─────────────────────────────────────────────────────────
  if (selectedPlotLine) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={() => onSelect('')} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors flex-shrink-0">
              <ChevronUp className="w-4 h-4 rotate-[-90deg]" />
            </button>
            <BookOpen className="w-5 h-5 text-purple-400 flex-shrink-0" />
            <h3 className="font-semibold text-sm truncate">{selectedPlotLine.name}</h3>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!selectedPlotLine.is_parsed && selectedPlotLine.raw_content && (
              <div className="flex items-center gap-1">
                <select
                  value={localModel}
                  onChange={e => setLocalModel(e.target.value)}
                  className="text-xs bg-white/5 border border-white/10 rounded-lg px-2 py-1 max-w-[120px] truncate"
                >
                  {models.map(m => (
                    <option key={m.id} value={m.id}>{m.alias || m.name || m.id}</option>
                  ))}
                </select>
                <button
                  onClick={() => onParse(selectedPlotLine.id, localModel)}
                  disabled={parsing}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors text-sm disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {parsing ? 'AI 分段中...' : 'AI 智能分段'}
                </button>
              </div>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {selectedPlotLine.description && (
            <p className="text-xs text-muted-foreground">{selectedPlotLine.description}</p>
          )}

          {selectedPlotLine.stages.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>暂无阶段</p>
              {selectedPlotLine.raw_content && (
                <button
                  onClick={() => onParse(selectedPlotLine.id, localModel)}
                  disabled={parsing}
                  className="mt-3 px-4 py-2 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors text-sm"
                >
                  <Sparkles className="w-4 h-4 inline mr-1" />
                  使用AI自动分段
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {selectedPlotLine.stages.map((stage: any) => {
                const stageId = String(stage.id);
                const isEditing = editingStageId === stageId;
                const isExpanded = expandedStages.has(stageId);
                return (
                  <GlassCard key={stage.id} className="overflow-hidden">
                    <div className="flex items-center justify-between p-3 gap-2">
                      <button
                        onClick={() => toggleStage(stageId)}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      >
                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 text-xs font-bold flex-shrink-0">
                          {stage.stage_index + 1}
                        </span>
                        <span className="font-medium text-sm truncate">
                          {stage.title || `阶段 ${stage.stage_index + 1}`}
                        </span>
                        {stage.priority >= 8 && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-400 flex-shrink-0">关键</span>
                        )}
                      </button>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
                        {onJumpToStage && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onJumpToStage(stage.stage_index); }}
                            title="跳到此阶段"
                            className="p-1.5 rounded-lg hover:bg-white/10 hover:text-foreground transition-colors"
                          >
                            <ChevronDown className="w-3.5 h-3.5 rotate-[-90deg]" />
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); isEditing ? handleCancelStageEdit() : handleStartStageEdit(stage); }}
                          title={isEditing ? '取消编辑' : '编辑阶段'}
                          className="p-1.5 rounded-lg hover:bg-white/10 hover:text-foreground transition-colors"
                        >
                          <Pencil className={`w-3.5 h-3.5 ${isEditing ? 'text-purple-300' : ''}`} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleStage(stageId); }}
                          className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                        >
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    {/* 阶段编辑表单 */}
                    {isEditing && (
                      <div className="px-3 pb-3 border-t border-white/5 pt-3 space-y-2">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">标题</label>
                          <input
                            value={stageEditTitle}
                            onChange={e => setStageEditTitle(e.target.value)}
                            placeholder="阶段标题"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">摘要</label>
                          <textarea
                            value={stageEditSummary}
                            onChange={e => setStageEditSummary(e.target.value)}
                            placeholder="简要描述此阶段的剧情走向..."
                            rows={2}
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50 resize-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">阶段内容</label>
                          <textarea
                            value={stageEditContent}
                            onChange={e => setStageEditContent(e.target.value)}
                            placeholder="剧情细节、角色行为、场景描述..."
                            rows={5}
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50 resize-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">过渡条件</label>
                          <input
                            value={stageEditTransition}
                            onChange={e => setStageEditTransition(e.target.value)}
                            placeholder="触发此阶段的条件（可选）"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50"
                          />
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={handleCancelStageEdit}
                            className="flex-1 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm"
                          >
                            取消
                          </button>
                          <button
                            onClick={handleSaveStageEdit}
                            disabled={savingStage}
                            className="flex-1 px-3 py-2 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors text-sm disabled:opacity-50"
                          >
                            {savingStage ? '保存中...' : '保存'}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 阶段内容展示 */}
                    {!isEditing && isExpanded && (
                      <div className="px-3 pb-3 border-t border-white/5 pt-3 space-y-2">
                        {stage.summary && (
                          <p className="text-xs text-muted-foreground italic">{stage.summary}</p>
                        )}
                        {stage.content && (
                          <pre className="text-xs whitespace-pre-wrap text-foreground/80 max-h-60 overflow-y-auto">
                            {stage.content}
                          </pre>
                        )}
                        {stage.transition_hint && (
                          <p className="text-[11px] text-purple-400/80">
                            过渡条件: {stage.transition_hint}
                          </p>
                        )}
                      </div>
                    )}
                  </GlassCard>
                );
              })}
            </div>
          )}
        </div>

        {/* 取消会话关联按钮（仅在有关联时显示） */}
        {onDisassociate && hasSessionAssociation && (
          <div className="p-3 border-t border-white/10 flex-shrink-0">
            <button
              onClick={onDisassociate}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors text-sm"
            >
              <Unlink className="w-3.5 h-3.5" />
              取消当前对话的剧情线关联
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Create View ─────────────────────────────────────────────────────────
  if (view === 'create') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b border-white/10 flex-shrink-0">
          <h3 className="font-semibold text-sm">新建剧情线</h3>
          <button onClick={() => setView('list')} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">名称 *</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="剧情线名称"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">描述</label>
            <input
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="简短描述..."
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">故事大纲（可选，用于AI分段）</label>
            <textarea
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder="粘贴故事大纲或世界设定，之后可使用AI自动分段..."
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50 h-36 resize-none"
            />
          </div>
        </div>
        <div className="p-4 border-t border-white/10 flex-shrink-0 flex gap-2">
          <button
            onClick={() => setView('list')}
            className="flex-1 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm"
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={!newName.trim()}
            className="flex-1 px-4 py-2 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors text-sm disabled:opacity-50"
          >
            创建
          </button>
        </div>
      </div>
    );
  }

  // ── List View ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-white/10 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-purple-400" />
          <h3 className="font-semibold text-sm">剧情线管理</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('create')}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            新建
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="text-center py-8 text-muted-foreground text-sm">加载中...</div>
        ) : plotLines.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">暂无剧情线</p>
            <p className="text-xs mt-1">创建剧情线后，可使用AI自动规划故事阶段</p>
          </div>
        ) : (
          plotLines.map(pl => {
            const isEditing = editingId === pl.id;
            return (
              <GlassCard key={pl.id} className="overflow-hidden">
                <div className="flex items-center justify-between p-3 gap-2">
                  <button
                    onClick={() => onSelect(pl.id)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{pl.name}</span>
                      {pl.is_parsed && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-300">
                          {(pl as any).stage_count ?? 0}阶段
                        </span>
                      )}
                    </div>
                    {pl.description && !isEditing && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{pl.description}</p>
                    )}
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); isEditing ? handleCancelEdit() : handleStartEdit(pl); }}
                      title={isEditing ? '取消编辑' : '编辑'}
                      className="p-1.5 rounded-lg hover:bg-white/10 hover:text-foreground transition-colors"
                    >
                      <Pencil className={`w-3.5 h-3.5 ${isEditing ? 'text-purple-300' : ''}`} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(pl.id); }}
                      title="删除"
                      className="p-1.5 rounded-lg hover:bg-red-500/20 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* PlotLine 编辑表单 */}
                {isEditing && (
                  <div className="px-3 pb-3 border-t border-white/5 pt-3 space-y-2">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">名称</label>
                      <input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">描述</label>
                      <input
                        value={editDesc}
                        onChange={e => setEditDesc(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">故事大纲</label>
                      <textarea
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        rows={4}
                        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-purple-500/50 resize-none"
                      />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={handleCancelEdit}
                        className="flex-1 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        disabled={savingEdit || !editName.trim()}
                        className="flex-1 px-3 py-2 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors text-sm disabled:opacity-50"
                      >
                        {savingEdit ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </div>
                )}
              </GlassCard>
            );
          })
        )}
      </div>
    </div>
  );
}
