/**
 * CharacterList — 角色列表/网格视图
 * 从 CharacterView 提取的子组件
 */
import React from 'react';
import {
  Bot, Plus, Upload, Play, Sparkles, Zap, Download, Edit3, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import type { Character } from '@/types';

export interface CharacterListProps {
  characters: Character[];
  processingCharacter: string | null;
  forceShowOverlay: string | null;
  showProcessingMessage: { show: boolean; message: string };
  showImportOptions: string | null;
  showDeleteCharacterConfirm: boolean;
  t: Record<string, string>;
  onStartChat: (char: Character) => void;
  onCreateCharacter: () => void;
  onEditCharacter: (char: Character) => void;
  onDeleteCharacter: (id: string) => void;
  onConfirmDeleteCharacter: () => void;
  onSetShowDeleteCharacterConfirm: (open: boolean) => void;
  onImportCharacter: (file: File) => void;
  onParseCharacter: (id: string) => void;
  onTranslateCharacter: (id: string) => void;
  onExportCharacter: (char: Character, format: 'png' | 'json') => void;
  onStopProcessing: (id: string) => void;
  onSetShowImportOptions: (id: string | null) => void;
}

export const CharacterList: React.FC<CharacterListProps> = ({
  characters,
  processingCharacter,
  forceShowOverlay,
  showProcessingMessage,
  showImportOptions,
  showDeleteCharacterConfirm,
  t,
  onStartChat,
  onCreateCharacter,
  onEditCharacter,
  onDeleteCharacter,
  onConfirmDeleteCharacter,
  onSetShowDeleteCharacterConfirm,
  onImportCharacter,
  onParseCharacter,
  onTranslateCharacter,
  onExportCharacter,
  onStopProcessing,
  onSetShowImportOptions,
}) => {
  const headerClass = "h-[64px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0";
  const bottomPadding = useMobileBottomPadding();
  
  return (
    <div className="flex-1 flex flex-col w-full h-full">
      <div className={headerClass}>
        <h1 className="text-base font-semibold text-foreground truncate">
          {t.nav_characters || '角色扮演'}
        </h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button variant="secondary" asChild>
              <label className="cursor-pointer flex items-center gap-2">
                <Upload size={18} />
                导入角色卡
              </label>
            </Button>
            <input 
              type="file" 
              accept=".png,.json" 
              className="absolute inset-0 opacity-0 cursor-pointer"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  onImportCharacter(file);
                  e.target.value = '';
                }
              }}
            />
          </div>
          <Button onClick={onCreateCharacter}>
            <Plus size={18} className="mr-2" />
            创建角色
          </Button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto w-full max-h-full">
        <div className={`w-full px-6 py-6 ${bottomPadding}`}>
          {characters.length === 0 && (
            <div className="text-center py-20">
              <div className="w-24 h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20">
                <Bot size={48} />
              </div>
              <h3 className="text-xl font-semibold mb-2">暂无角色</h3>
              <p className="text-sm text-muted-foreground mb-6">创建您的第一个角色开始角色扮演吧！</p>
              <Button onClick={onCreateCharacter}>
                <Plus size={18} className="mr-2" />
                创建角色
              </Button>
            </div>
          )}
          
          {characters.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
              {characters.map((character) => (
                <div 
                  key={character.id}
                  className="group relative bg-background/50 border border-border rounded-2xl hover:border-primary/30 hover:bg-background transition-all cursor-pointer overflow-hidden"
                  onClick={() => onStartChat(character)}
                >
                  <div className="aspect-[3/4] sm:aspect-[4/5] bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800 relative overflow-hidden">
                    {character.avatar ? (
                      <img 
                        src={character.avatar} 
                        alt="" 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gray-200 dark:bg-gray-700">
                        <svg 
                          xmlns="http://www.w3.org/2000/svg" 
                          viewBox="0 0 24 24" 
                          fill="none" 
                          stroke="currentColor" 
                          strokeWidth="1"
                          className="w-20 h-20 text-gray-400 dark:text-gray-500"
                        >
                          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
                        </svg>
                      </div>
                    )}
                    
                    {(processingCharacter === character.id || forceShowOverlay === character.id) && (
                      <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
                        <div className="text-white text-center p-8">
                          <div className="w-20 h-20 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                          <p className="text-lg mb-6 font-semibold">
                            {character.processing_status && !character.processing_status.includes('完成') && !character.processing_status.includes('重置') 
                              ? character.processing_status 
                              : "处理中..."}
                          </p>
                          <Button 
                            variant="destructive" 
                            size="default" 
                            className="text-base h-10 px-6"
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              onStopProcessing(character.id); 
                            }}
                          >
                            停止
                          </Button>
                        </div>
                      </div>
                    )}
                    
                    <div className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                    
                    <div className="absolute bottom-0 left-0 right-0 p-2 sm:p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                        <Button 
                          variant="default" 
                          size="sm" 
                          className="flex-1 text-xs h-7 sm:h-8"
                          onClick={(e) => { e.stopPropagation(); onStartChat(character); }}
                          disabled={character.is_processing || processingCharacter === character.id}
                        >
                          <Play size={12} className="mr-1 sm:mr-1" />
                          <span className="hidden sm:inline">开始对话</span>
                          <span className="sm:hidden">对话</span>
                        </Button>
                        <div className="flex items-center gap-0.5 sm:gap-1">
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); onParseCharacter(character.id); }}
                            disabled={character.is_processing || processingCharacter === character.id}
                            title="AI解析角色卡"
                          >
                            <Sparkles size={12} />
                          </Button>
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); onTranslateCharacter(character.id); }}
                            disabled={character.is_processing || processingCharacter === character.id}
                            title="AI翻译角色卡"
                          >
                            <Zap size={12} />
                          </Button>
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); onExportCharacter(character, 'png'); }}
                            title="导出为PNG"
                            disabled={character.is_processing || processingCharacter === character.id}
                          >
                            <Download size={12} />
                          </Button>
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); onEditCharacter(character); }}
                            disabled={character.is_processing || processingCharacter === character.id}
                          >
                            <Edit3 size={12} />
                          </Button>
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="h-7 w-7 sm:h-8 sm:w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); onDeleteCharacter(character.id); }}
                            disabled={character.is_processing || processingCharacter === character.id}
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="p-2 sm:p-3">
                    <h3 className="font-semibold text-sm sm:text-base truncate">{character.name}</h3>
                    {character.is_processing && (
                      <p className="text-xs text-muted-foreground truncate">
                        {character.processing_status && !character.processing_status.includes('完成') && !character.processing_status.includes('重置') 
                          ? character.processing_status 
                          : "处理中..."}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={showDeleteCharacterConfirm}
        onOpenChange={onSetShowDeleteCharacterConfirm}
        title="删除这个角色？"
        description="确定要删除这个角色吗？此操作无法撤销。"
        onConfirm={onConfirmDeleteCharacter}
        confirmText="确定"
        cancelText="取消"
      />
      
      {showProcessingMessage.show && (
        <div className="fixed top-4 right-4 bg-background border border-border rounded-xl p-4 shadow-xl z-[80] flex items-center gap-3 animate-slide-in-right">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium">{showProcessingMessage.message}</p>
        </div>
      )}
      
      {showImportOptions && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background border border-border rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">角色卡导入成功！</h3>
            <p className="text-muted-foreground mb-6">是否需要使用AI解析和翻译这个角色卡？</p>
            <div className="flex flex-col gap-3">
              <Button 
                onClick={() => {
                  onParseCharacter(showImportOptions);
                  onSetShowImportOptions(null);
                }}
                disabled={processingCharacter !== null}
              >
                <Sparkles size={16} className="mr-2" />
                仅AI解析
              </Button>
              <Button 
                onClick={() => {
                  onTranslateCharacter(showImportOptions);
                  onSetShowImportOptions(null);
                }}
                disabled={processingCharacter !== null}
              >
                <Zap size={16} className="mr-2" />
                仅AI翻译
              </Button>
              <Button 
                onClick={async () => {
                  onSetShowImportOptions(null);
                  await onParseCharacter(showImportOptions);
                  await onTranslateCharacter(showImportOptions);
                }}
                disabled={processingCharacter !== null}
                variant="default"
              >
                解析并翻译
              </Button>
              <Button 
                variant="secondary"
                onClick={() => onSetShowImportOptions(null)}
              >
                跳过
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
