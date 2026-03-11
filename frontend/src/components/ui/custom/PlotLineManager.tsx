/**
 * PlotLineManager — 剧情线管理界面（Phase 6C）
 * 列表、创建、编辑、AI 分段、阶段预览
 */
import React, { useState, useEffect } from 'react';
import { Plus, Sparkles, Trash2, ChevronDown, ChevronUp, BookOpen, X } from 'lucide-react';
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
  onDelete: (id: string) => Promise<void>;
  onParse: (id: string, model: string) => Promise<void>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export const PlotLineManager: React.FC<PlotLineManagerProps> = ({
  plotLines, selectedPlotLine, loading, parsing, models, selectedModel,
  t: _t, onLoad, onCreate, onUpdate: _onUpdate, onDelete, onParse, onSelect, onClose,
}) => {
  const [view, setView] = useState<'list' | 'create'>('list');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newContent, setNewContent] = useState('');
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const [localModel, setLocalModel] = useState(selectedModel);

  useEffect(() => { onLoad(); }, []);
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

  // ── Detail View ─────────────────────────────────────────────────────────
  if (selectedPlotLine) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => onSelect('')} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
              <ChevronUp className="w-4 h-4 rotate-[-90deg]" />
            </button>
            <BookOpen className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold text-sm">{selectedPlotLine.name}</h3>
          </div>
          <div className="flex items-center gap-2">
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
              {selectedPlotLine.stages.map((stage) => (
                <GlassCard key={stage.id} className="overflow-hidden">
                  <button
                    onClick={() => toggleStage(stage.id)}
                    className="w-full flex items-center justify-between p-3 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 text-xs font-bold">
                        {stage.stage_index + 1}
                      </span>
                      <span className="font-medium text-sm">{stage.title || `阶段 ${stage.stage_index + 1}`}</span>
                      {stage.priority >= 8 && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-400">关键</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>~{stage.token_count} tokens</span>
                      {expandedStages.has(stage.id) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </button>
                  {expandedStages.has(stage.id) && (
                    <div className="px-3 pb-3 border-t border-white/5">
                      {stage.summary && (
                        <p className="text-xs text-muted-foreground mt-2 mb-1 italic">{stage.summary}</p>
                      )}
                      <pre className="text-xs mt-2 whitespace-pre-wrap text-foreground/80 max-h-48 overflow-y-auto">
                        {stage.content}
                      </pre>
                      {stage.transition_hint && (
                        <p className="text-[11px] text-purple-400/80 mt-2">
                          过渡条件: {stage.transition_hint}
                        </p>
                      )}
                    </div>
                  )}
                </GlassCard>
              ))}
            </div>
          )}
        </div>
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
          plotLines.map(pl => (
            <button
              key={pl.id}
              className="w-full text-left glass rounded-2xl flex items-center justify-between p-3 cursor-pointer hover:bg-white/5 transition-colors"
              onClick={() => onSelect(pl.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{pl.name}</span>
                  {pl.is_parsed && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-300">
                      {pl.stage_count}阶段
                    </span>
                  )}
                </div>
                {pl.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{pl.description}</p>
                )}
              </div>
              <button
                onClick={e => { e.stopPropagation(); onDelete(pl.id); }}
                className="p-1.5 rounded-lg hover:bg-red-500/20 hover:text-red-400 transition-colors flex-shrink-0 ml-2"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </button>
          ))
        )}
      </div>
    </div>
  );
};
