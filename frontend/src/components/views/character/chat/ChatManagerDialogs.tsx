/**
 * ChatManagerDialogs — 聊天管理器对话框集合
 * 从 CharacterChat 提取的世界书、剧情线、预设管理器对话框
 */
import React from 'react';
import { WorldBookOverview } from '@/components/ui/custom/WorldBookOverview';
import { WorldBookManager } from '@/components/ui/custom/WorldBookManager';
import { PlotLineManager } from '@/components/ui/custom/PlotLineManager';
import { PresetManager } from '@/components/ui/custom/PresetManager';
import type { Character, Model, GenerationPreset } from '@/types';

export interface ChatManagerDialogsProps {
  // 通用
  isDark: boolean;
  t: Record<string, string>;
  models: Model[];
  selectedModel: string;
  selectedCharacter: Character;
  selectedSessionId?: string;
  // 预设
  currentPreset: GenerationPreset | null;
  setCurrentPreset: (preset: GenerationPreset) => void;
  showPresetManager: boolean;
  onShowPresetManagerChange: (v: boolean) => void;
  // 世界书
  showWorldBookManager: boolean;
  onShowWorldBookManagerChange: (v: boolean) => void;
  showWorldBookOverview: boolean;
  onShowWorldBookOverviewChange: (v: boolean) => void;
  worldBookStatus: any;
  wb: any;
  // 剧情线
  showPlotLineManager: boolean;
  onShowPlotLineManagerChange: (v: boolean) => void;
  pl: any;
}

export function ChatManagerDialogs({
  isDark,
  t,
  models,
  selectedModel,
  selectedCharacter,
  selectedSessionId,
  currentPreset,
  setCurrentPreset,
  showPresetManager,
  onShowPresetManagerChange,
  showWorldBookManager,
  onShowWorldBookManagerChange,
  showWorldBookOverview,
  onShowWorldBookOverviewChange,
  worldBookStatus,
  wb,
  showPlotLineManager,
  onShowPlotLineManagerChange,
  pl,
}: ChatManagerDialogsProps) {
  return (
    <>
      {/* World Book Overview Panel */}
      <WorldBookOverview
        status={worldBookStatus || { active: false }}
        isOpen={showWorldBookOverview}
        onClose={() => onShowWorldBookOverviewChange(false)}
      />

      {/* Plot Line Manager Dialog */}
      {showPlotLineManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => onShowPlotLineManagerChange(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-lg h-[80vh] glass-strong rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <PlotLineManager
              plotLines={pl.plotLines}
              selectedPlotLine={pl.selectedPlotLine}
              loading={pl.loading}
              parsing={pl.parsing}
              models={models}
              selectedModel={selectedModel}
              t={t}
              onLoad={pl.loadPlotLines}
              onCreate={pl.createPlotLine}
              onUpdate={pl.updatePlotLine}
              onUpdateStage={pl.updatePlotLineStage}
              onDelete={pl.deletePlotLine}
              onParse={pl.parsePlotLine}
              onSelect={(id: string) => pl.loadPlotLineDetail(id)}
              onJumpToStage={(stageIndex: number) => selectedSessionId && pl.jumpToStage(selectedSessionId, stageIndex)}
              onDisassociate={() => selectedSessionId && pl.disassociateSession(selectedSessionId)}
              hasSessionAssociation={!!pl.sessionStatus?.active}
              onClose={() => onShowPlotLineManagerChange(false)}
            />
          </div>
        </div>
      )}

      {/* World Book Manager Dialog */}
      {showWorldBookManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => onShowWorldBookManagerChange(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-lg h-[80vh] glass-strong rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <WorldBookManager
              worldBooks={wb.worldBooks}
              selectedWorldBook={wb.selectedWorldBook}
              loading={wb.loading}
              t={t}
              characterId={selectedCharacter.id}
              onLoad={wb.loadWorldBooks}
              onCreate={wb.createWorldBook}
              onUpdate={wb.updateWorldBook}
              onDelete={wb.deleteWorldBook}
              onImport={wb.importWorldBook}
              onSelect={(id) => wb.loadWorldBookDetail(id)}
              onClose={() => onShowWorldBookManagerChange(false)}
            />
          </div>
        </div>
      )}

      {/* Preset Manager Dialog */}
      <PresetManager
        currentPreset={currentPreset}
        onPresetChange={setCurrentPreset}
        theme={isDark ? 'dark' : 'light'}
        open={showPresetManager}
        onClose={() => onShowPresetManagerChange(false)}
      />
    </>
  );
}

export default ChatManagerDialogs;
