/**
 * CharacterList — 角色列表/网格视图
 * 全新的响应式布局设计
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bot, Plus, Upload, Play, Sparkles, Download, Edit3, Trash2, Search,
  Sun, Moon, MessageSquare, X, Check, ChevronRight, ChevronLeft
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
  onViewProfile: (char: Character) => void;
  onCreateCharacter: () => void;
  onEditCharacter: (char: Character) => void;
  onDeleteCharacter: (id: string) => void;
  onConfirmDeleteCharacter: () => void;
  onSetShowDeleteCharacterConfirm: (open: boolean) => void;
  onImportCharacter: (file: File) => void;
  onParseAndTranslateCharacter: (id: string) => void;
  onExportCharacter: (char: Character, format: 'png' | 'json') => void;
  onStopProcessing: (id: string) => void;
  onSetShowImportOptions: (id: string | null) => void;
}

const CATEGORIES = [
  { id: 'all', name: '全部' },
  { id: '日常', name: '日常' },
  { id: '游戏', name: '游戏' },
  { id: '现代', name: '现代' },
  { id: 'Vtuber', name: 'Vtuber' },
];

const getCharacterCategory = (char: Character) => {
  const desc = (char.description || '').toLowerCase();
  if (desc.includes('vtuber') || desc.includes('虚拟主播')) return 'Vtuber';
  if (desc.includes('游戏') || desc.includes('game') || desc.includes('persona') || desc.includes('genshin')) return '游戏';
  if (desc.includes('现代') || desc.includes('日常')) return '日常';
  return '角色';
};

const CharacterCard = ({ 
  char, 
  onClick, 
  isSelectMode, 
  isSelected, 
  onToggleSelect,
  processingCharacter,
  forceShowOverlay,
  onStartChat,
  onParseAndTranslateCharacter,
  onExportCharacter,
  onEditCharacter,
  onDeleteCharacter,
  onStopProcessing
}: {
  char: Character;
  onClick: () => void;
  isSelectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  processingCharacter: string | null;
  forceShowOverlay: string | null;
  onStartChat: (char: Character) => void;
  onParseAndTranslateCharacter: (id: string) => void;
  onExportCharacter: (char: Character, format: 'png' | 'json') => void;
  onEditCharacter: (char: Character) => void;
  onDeleteCharacter: (id: string) => void;
  onStopProcessing: (id: string) => void;
}) => (
  <div 
    onClick={() => isSelectMode ? onToggleSelect(char.id) : onClick()}
    className={`group relative rounded-3xl cursor-pointer transition-all duration-800 cubic-bezier(0.25, 0.46, 0.45, 0.94) hover:scale-[1.05] overflow-hidden transform-gpu will-change-transform ${
      isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-slate-50 dark:ring-offset-slate-950' : ''
    }`}
  >
    <div className="aspect-[3/4] relative rounded-3xl overflow-hidden">
      {char.avatar ? (
        <img 
          src={char.avatar} 
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" 
          alt={char.name} 
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-700 dark:to-slate-800">
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1"
            className="w-14 h-14 sm:w-16 sm:h-16 text-slate-400 dark:text-slate-500"
          >
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
          </svg>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/95 via-slate-950/30 to-transparent rounded-3xl" />
      
      {isSelectMode && (
        <div className={`absolute top-4 right-4 sm:top-5 sm:right-5 w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 flex items-center justify-center transition-all z-20 ${
          isSelected 
            ? 'bg-primary border-primary shadow-lg shadow-primary/50' 
            : 'bg-black/30 border-white/60 backdrop-blur-md'
        }`}>
          {isSelected && <Check size={18} className="sm:w-6 sm:h-6 text-white" />}
        </div>
      )}
      
      {(processingCharacter === char.id || forceShowOverlay === char.id) && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 rounded-3xl">
          <div className="text-white text-center p-5 sm:p-7">
            <div className="w-14 h-14 sm:w-18 sm:h-18 border-3 sm:border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4 sm:mb-5" />
            <p className="text-lg sm:text-xl mb-5 sm:mb-6 font-semibold">
              {char.processing_status && !char.processing_status.includes('完成') && !char.processing_status.includes('重置') 
                ? char.processing_status 
                : "处理中..."}
            </p>
            <Button 
              variant="destructive" 
              size="sm"
              className="text-sm sm:text-base h-10 sm:h-11 px-6 sm:px-7"
              onClick={(e) => { 
                e.stopPropagation(); 
                onStopProcessing(char.id); 
              }}
            >
              停止
            </Button>
          </div>
        </div>
      )}
      
      <div className="absolute inset-0 bg-slate-950/20 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10 rounded-3xl" />
      
      <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 z-20 transition-opacity duration-300 group-hover:opacity-0 pointer-events-none rounded-b-3xl">
        <span className="inline-block px-2 py-1 sm:px-2.5 sm:py-1 bg-white/10 backdrop-blur-md rounded-full text-xs font-medium text-white/80 mb-1.5 sm:mb-2">
          {getCharacterCategory(char)}
        </span>
        <h3 className="text-white font-semibold text-base sm:text-lg leading-tight truncate">{char.name}</h3>
        {char.is_processing && (
          <p className="text-white/70 text-xs mt-1 truncate">
            {char.processing_status && !char.processing_status.includes('完成') && !char.processing_status.includes('重置') 
              ? char.processing_status 
              : "处理中..."}
          </p>
        )}
      </div>
      
      {!isSelectMode && (
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-30 flex items-end p-2 sm:p-2.5 rounded-3xl">
          <div className="w-full">
            <div className="flex flex-wrap items-center gap-1 mb-1.5">
              <Button 
                variant="default" 
                size="sm" 
                className="flex-1 text-[11px] h-7 bg-white/90 text-slate-900 hover:bg-white"
                onClick={(e) => { e.stopPropagation(); onStartChat(char); }}
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Play size={12} className="mr-1" />
                <span className="hidden sm:inline">开始对话</span>
                <span className="sm:hidden">对话</span>
              </Button>
            </div>
            <div className="flex items-center gap-1 justify-center">
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-7 w-7 p-0 bg-white/20 hover:bg-white/30 backdrop-blur-md border-0"
                onClick={(e) => { e.stopPropagation(); onParseAndTranslateCharacter(char.id); }}
                disabled={char.is_processing || processingCharacter === char.id}
                title="AI解析并翻译角色卡"
              >
                <Sparkles size={14} className="text-white" />
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-7 w-7 p-0 bg-white/20 hover:bg-white/30 backdrop-blur-md border-0 hidden sm:inline-flex"
                onClick={(e) => { e.stopPropagation(); onExportCharacter(char, 'png'); }}
                title="导出为PNG"
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Download size={14} className="text-white" />
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-7 w-7 p-0 bg-white/20 hover:bg-white/30 backdrop-blur-md border-0"
                onClick={(e) => { e.stopPropagation(); onEditCharacter(char); }}
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Edit3 size={14} className="text-white" />
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-7 w-7 p-0 bg-white/20 hover:bg-red-500/40 backdrop-blur-md border-0"
                onClick={(e) => { e.stopPropagation(); onDeleteCharacter(char.id); }}
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Trash2 size={14} className="text-white" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
);

const DesktopSidebar = ({
  searchQuery,
  setSearchQuery,
  activeCategory,
  setActiveCategory,
  sidebarCollapsed,
  setSidebarCollapsed,
  isSelectMode,
  setIsSelectMode,
  setSelectedIds,
  onImportCharacter,
  onCreateCharacter,
  windowWidth
}: {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeCategory: string;
  setActiveCategory: (id: string) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  isSelectMode: boolean;
  setIsSelectMode: (mode: boolean) => void;
  setSelectedIds: (ids: string[]) => void;
  onImportCharacter: (file: File) => void;
  onCreateCharacter: () => void;
  windowWidth: number;
}) => {
  return (
    <>
      <div className={`h-full flex flex-col border-r border-border transition-all duration-300 ${
        sidebarCollapsed ? 'w-0' : 'w-48 sm:w-56'
      }`}>
        <div className={`w-48 sm:w-56 h-full flex flex-col transition-all duration-300 ${
          sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
        }`}>
          <div className="px-4 sm:px-5 flex-shrink-0 border-b border-border">
            <div className="py-4">
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium mb-1">欢迎回来</p>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-slate-900 dark:text-white text-lg">角色扮演</h2>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="p-2 rounded-xl hover:bg-muted transition-colors"
                >
                  <ChevronLeft size={20} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button 
                variant={isSelectMode ? 'default' : 'ghost'} 
                onClick={() => { setIsSelectMode(!isSelectMode); setSelectedIds([]); }}
                className="text-xs sm:text-sm rounded-2xl h-10 col-span-2"
              >
                {isSelectMode ? '取消' : '多选'}
              </Button>
              <div className="relative">
                <Button variant="secondary" asChild className="rounded-2xl w-full h-10">
                  <label className="cursor-pointer flex items-center justify-center gap-1.5 text-xs sm:text-sm">
                    <Upload size={14} />
                    导入
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
              <Button onClick={onCreateCharacter} className="rounded-2xl text-xs sm:text-sm h-10">
                <Plus size={14} className="mr-1" />
                创建
              </Button>
            </div>

            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input
                  type="text"
                  placeholder="搜索角色..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-100 dark:bg-slate-800/50 rounded-2xl text-xs sm:text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs sm:text-sm font-medium text-muted-foreground mb-2">分类</h3>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((category) => (
                  <button
                    key={category.id}
                    onClick={() => setActiveCategory(category.id)}
                    className={`whitespace-nowrap px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                      activeCategory === category.id
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {sidebarCollapsed && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="absolute top-1/2 left-0 -translate-y-1/2 z-20 bg-background border border-l-0 border-border rounded-r-lg shadow-lg hover:bg-muted transition-all duration-300 p-2 pl-1.5"
          title="展开侧边栏"
        >
          <ChevronRight size={18} className="sm:w-5 sm:h-5" />
        </button>
      )}
    </>
  );
};

const MobileView = ({
  characters,
  processingCharacter,
  forceShowOverlay,
  showProcessingMessage,
  showImportOptions,
  showDeleteCharacterConfirm,
  onStartChat,
  onViewProfile,
  onCreateCharacter,
  onEditCharacter,
  onDeleteCharacter,
  onConfirmDeleteCharacter,
  onSetShowDeleteCharacterConfirm,
  onImportCharacter,
  onParseAndTranslateCharacter,
  onExportCharacter,
  onStopProcessing,
  onSetShowImportOptions,
}: Omit<CharacterListProps, 't'>) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const lastScrollY = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomPadding = useMobileBottomPadding();
  const maxScroll = 120;

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(i => i !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;
    const progress = Math.min(Math.max(currentScrollY, 0), maxScroll) / maxScroll;
    setScrollProgress(progress);
    lastScrollY.current = currentScrollY;
  }, []);

  const getHeaderStyle = () => {
    const pt = 20 - scrollProgress * 10;
    const pb = 12 - scrollProgress * 6;
    return {
      paddingTop: `${pt}px`,
      paddingBottom: `${pb}px`,
    };
  };

  const getWelcomeOpacity = () => 1 - scrollProgress;
  const getWelcomeMaxHeight = () => `${(1 - scrollProgress) * 35}px`;
  const getWelcomeMarginBottom = () => `${(1 - scrollProgress) * 3}px`;
  
  const getSearchBoxOpacity = () => 1 - scrollProgress;
  const getSearchBoxMaxHeight = () => `${(1 - scrollProgress) * 70}px`;
  const getSearchBoxMarginBottom = () => `${(1 - scrollProgress) * 12}px`;
  
  const getCategoriesOpacity = () => 1 - scrollProgress;
  const getCategoriesMaxHeight = () => `${(1 - scrollProgress) * 50}px`;
  
  const getRightButtonsOpacity = () => 1;
  const getH1Size = () => 22 - scrollProgress * 3;
  const getSmallSearchOpacity = () => scrollProgress;
  const getSmallSearchWidth = () => {
    const baseWidth = 140;
    const collapsedWidth = 100;
    return collapsedWidth + (baseWidth - collapsedWidth) * scrollProgress;
  };
  const getButtonGap = () => 1.2 - scrollProgress * 0.4;
  const getButtonHeight = () => 42 - scrollProgress * 3;

  const filteredCharacters = characters.filter((char) => {
    const matchesSearch = !searchQuery.trim() || 
      char.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (char.description || '').toLowerCase().includes(searchQuery.toLowerCase());
    
    const charCategory = getCharacterCategory(char);
    const matchesCategory = activeCategory === 'all' || charCategory === activeCategory;
    
    return matchesSearch && matchesCategory;
  });
  
  return (
    <div className="absolute inset-0 flex flex-col pt-safe">
      <header className="px-5 sm:px-6 flex-shrink-0 transition-all duration-400 ease-in-out" style={getHeaderStyle()}>
        <div className="flex items-center justify-between">
          <div className="relative">
            <p 
              className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium mb-0.5 sm:mb-1 transition-all duration-400 ease-in-out"
              style={{ opacity: getWelcomeOpacity(), maxHeight: getWelcomeMaxHeight(), overflow: 'hidden', marginBottom: getWelcomeMarginBottom() }}
            >
              欢迎回来
            </p>
            <div className="flex items-center gap-2.5 sm:gap-3 flex-nowrap min-w-0">
              <h1 
                className="font-semibold text-slate-900 dark:text-white transition-all duration-400 ease-in-out flex-shrink-0"
                style={{ fontSize: `${getH1Size()}px` }}
              >
                角色扮演
              </h1>
              <div 
                className="relative transition-all duration-400 ease-in-out flex-shrink-0"
                style={{ opacity: getSmallSearchOpacity(), width: `${getSmallSearchWidth()}px` }}
              >
                <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                  <Search size={14} className="sm:w-4 sm:h-4" />
                </div>
                <input
                  type="text"
                  placeholder="搜索..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-2.5 py-1.5 sm:py-2 bg-slate-100 dark:bg-slate-800/50 rounded-xl text-xs sm:text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all duration-400 ease-in-out"
                />
              </div>
            </div>
          </div>
          <div 
            className="flex items-center transition-all duration-400 ease-in-out"
            style={{ 
              opacity: getRightButtonsOpacity(), 
              gap: `${getButtonGap()}px`
            }}
          >
            <Button 
              variant={isSelectMode ? 'default' : 'ghost'} 
              onClick={() => { setIsSelectMode(!isSelectMode); setSelectedIds([]); }}
              className="text-xs sm:text-sm rounded-2xl transition-all duration-400 ease-in-out"
              style={{ 
                height: `${getButtonHeight()}px`,
                paddingLeft: `${14 - scrollProgress * 3}px`,
                paddingRight: `${14 - scrollProgress * 3}px`
              }}
            >
              {isSelectMode ? '取消' : '多选'}
            </Button>
            <div className="relative">
              <Button variant="secondary" asChild className="rounded-2xl transition-all duration-400 ease-in-out" style={{ 
                  height: `${getButtonHeight()}px`,
                  paddingLeft: `${14 - scrollProgress * 3}px`,
                  paddingRight: `${14 - scrollProgress * 3}px`
                }}>
                <label className="cursor-pointer flex items-center gap-1.5">
                  <Upload size={14 - scrollProgress * 1.5} className="sm:w-4 sm:h-4" />
                  <span className="transition-all duration-400 ease-in-out text-xs sm:text-sm">导入</span>
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
            <Button onClick={onCreateCharacter} className="rounded-2xl transition-all duration-400 ease-in-out text-xs sm:text-sm" style={{ 
                height: `${getButtonHeight()}px`,
                paddingLeft: `${14 - scrollProgress * 3}px`,
                paddingRight: `${14 - scrollProgress * 3}px`
              }}>
              <Plus size={14 - scrollProgress * 1.5} className="sm:w-4 sm:h-4 mr-1 sm:mr-1.5" style={{ marginRight: `${5 - scrollProgress * 3}px` }} />
              <span className="transition-all duration-400 ease-in-out">创建</span>
            </Button>
          </div>
        </div>

        <div 
          className="relative mb-3 sm:mb-4 transition-all duration-400 ease-in-out"
          style={{ 
            opacity: getSearchBoxOpacity(), 
            maxHeight: getSearchBoxMaxHeight(), 
            overflow: 'hidden', 
            marginBottom: getSearchBoxMarginBottom()
          }}
        >
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 transition-all duration-400 ease-in-out">
            <Search size={18} className="sm:w-5 sm:h-5" />
          </div>
          <input
            type="text"
            placeholder="搜索角色..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-3.5 py-3 sm:py-4 bg-slate-100 dark:bg-slate-800/50 rounded-2xl text-xs sm:text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all duration-400 ease-in-out"
          />
        </div>

        <div 
          className="flex items-center justify-between transition-all duration-400 ease-in-out"
          style={{ opacity: getCategoriesOpacity(), maxHeight: getCategoriesMaxHeight(), overflow: 'hidden' }}
        >
          <div className="flex space-x-1.5 sm:space-x-2 overflow-x-auto no-scrollbar">
            {CATEGORIES.map((category) => (
              <button 
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`whitespace-nowrap px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                  activeCategory === category.id ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div 
        ref={scrollContainerRef} 
        onScroll={handleScroll} 
        className="flex-1 overflow-y-auto px-5 sm:px-6 pb-[100px] sm:pb-[120px]"
      >
        {filteredCharacters.length === 0 && (
          <div className="text-center py-16 sm:py-20">
            <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-4xl sm:text-5xl mb-4 sm:mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20">
              <Bot size={40} className="sm:w-12 sm:h-12" />
            </div>
            <h3 className="text-lg sm:text-xl font-semibold mb-1.5 sm:mb-2">暂无角色</h3>
            <p className="text-xs sm:text-sm text-muted-foreground mb-4 sm:mb-6">创建您的第一个角色开始角色扮演吧！</p>
            <Button onClick={onCreateCharacter} className="text-xs sm:text-sm">
              <Plus size={16} className="sm:w-4.5 sm:h-4.5 mr-1.5 sm:mr-2" />
              创建角色
            </Button>
          </div>
        )}
        
        {filteredCharacters.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-5 transition-all duration-800 cubic-bezier(0.25, 0.46, 0.45, 0.94)">
              {filteredCharacters.map((char, index) => (
                <div
                  key={char.id}
                  className="transition-all duration-800 cubic-bezier(0.25, 0.46, 0.45, 0.94) transform-gpu will-change-transform"
                  style={{
                    transitionDelay: `${Math.min(index * 50, 400)}ms`,
                  }}
                >
                  <CharacterCard 
                    key={char.id} 
                    char={char}
                    isSelectMode={isSelectMode}
                    isSelected={selectedIds.includes(char.id)}
                    onToggleSelect={toggleSelect}
                    onClick={() => { if (!isSelectMode) onViewProfile(char); }}
                    processingCharacter={processingCharacter}
                    forceShowOverlay={forceShowOverlay}
                    onStartChat={onStartChat}
                    onParseAndTranslateCharacter={onParseAndTranslateCharacter}
                    onExportCharacter={onExportCharacter}
                    onEditCharacter={onEditCharacter}
                    onDeleteCharacter={onDeleteCharacter}
                    onStopProcessing={onStopProcessing}
                  />
                </div>
              ))}
            </div>
          )}
      </div>
      
      {isSelectMode && selectedIds.length > 0 && (
        <div className="fixed bottom-3.5 sm:bottom-4 left-3.5 sm:left-4 right-3.5 sm:right-4 z-40">
          <div className="bg-white/80 dark:bg-slate-950/80 backdrop-blur-2xl p-3.5 sm:p-4 rounded-2xl border border-slate-200/50 dark:border-slate-800 shadow-2xl flex items-center justify-between">
            <div className="flex items-center space-x-2.5 sm:space-x-3">
              <div className="flex -space-x-1.5 sm:-space-x-2">
                {selectedIds.slice(0, 4).map(id => {
                  const char = characters.find(c => c.id === id);
                  return char ? (
                    <img key={id} src={char.avatar || ''} className="w-8 h-8 sm:w-9 sm:h-9 rounded-2xl border-2 border-slate-900 dark:border-slate-900 object-cover" alt="" />
                  ) : null;
                })}
                {selectedIds.length > 4 && (
                  <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-2xl border-2 border-slate-900 dark:border-slate-900 bg-slate-800 flex items-center justify-center text-[10px] sm:text-xs font-bold text-slate-300">
                    +{selectedIds.length - 4}
                  </div>
                )}
              </div>
              <span className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white">已选 {selectedIds.length} 人</span>
            </div>
            <Button variant="default" className="h-10 sm:h-12 rounded-2xl text-xs sm:text-sm">
              <MessageSquare size={16} className="sm:w-4.5 sm:h-4.5 mr-1.5 sm:mr-2" />
              创建群聊
            </Button>
          </div>
        </div>
      )}

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
        <div className="fixed top-3.5 sm:top-4 right-3.5 sm:right-4 bg-background border border-border rounded-xl p-3.5 sm:p-4 shadow-xl z-[80] flex items-center gap-2.5 sm:gap-3">
          <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-xs sm:text-sm font-medium">{showProcessingMessage.message}</p>
        </div>
      )}
      
      {showImportOptions && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3.5 sm:p-4">
          <div className="bg-background border border-border rounded-2xl p-5 sm:p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-base sm:text-lg font-semibold mb-3.5 sm:mb-4">角色卡导入成功！</h3>
            <p className="text-xs sm:text-sm text-muted-foreground mb-5 sm:mb-6">是否需要使用AI解析和翻译这个角色卡？</p>
            <div className="flex flex-col gap-2.5 sm:gap-3">
              <Button 
                onClick={async () => {
                  onSetShowImportOptions(null);
                  onParseAndTranslateCharacter(showImportOptions);
                }}
                disabled={processingCharacter !== null}
                variant="default"
                className="text-xs sm:text-sm"
              >
                <Sparkles size={14} className="sm:w-4 sm:h-4 mr-1.5 sm:mr-2" />
                解析并翻译
              </Button>
              <Button 
                variant="secondary"
                onClick={() => onSetShowImportOptions(null)}
                className="text-xs sm:text-sm"
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

const DesktopView = ({
  characters,
  processingCharacter,
  forceShowOverlay,
  showProcessingMessage,
  showImportOptions,
  showDeleteCharacterConfirm,
  onStartChat,
  onViewProfile,
  onCreateCharacter,
  onEditCharacter,
  onDeleteCharacter,
  onConfirmDeleteCharacter,
  onSetShowDeleteCharacterConfirm,
  onImportCharacter,
  onParseAndTranslateCharacter,
  onExportCharacter,
  onStopProcessing,
  onSetShowImportOptions,
}: Omit<CharacterListProps, 't'>) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(i => i !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const filteredCharacters = characters.filter((char) => {
    const matchesSearch = !searchQuery.trim() || 
      char.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (char.description || '').toLowerCase().includes(searchQuery.toLowerCase());
    
    const charCategory = getCharacterCategory(char);
    const matchesCategory = activeCategory === 'all' || charCategory === activeCategory;
    
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="absolute inset-0 flex">
      <DesktopSidebar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        activeCategory={activeCategory}
        setActiveCategory={setActiveCategory}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        isSelectMode={isSelectMode}
        setIsSelectMode={setIsSelectMode}
        setSelectedIds={setSelectedIds}
        onImportCharacter={onImportCharacter}
        onCreateCharacter={onCreateCharacter}
        windowWidth={windowWidth}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <div 
          ref={scrollContainerRef} 
          className="flex-1 overflow-y-auto p-5 sm:p-6"
        >
          {filteredCharacters.length === 0 && (
            <div className="text-center py-16 sm:py-20">
              <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-4xl sm:text-5xl mb-4 sm:mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20">
                <Bot size={40} className="sm:w-12 sm:h-12" />
              </div>
              <h3 className="text-lg sm:text-xl font-semibold mb-1.5 sm:mb-2">暂无角色</h3>
              <p className="text-xs sm:text-sm text-muted-foreground mb-4 sm:mb-6">创建您的第一个角色开始角色扮演吧！</p>
              <Button onClick={onCreateCharacter} className="text-xs sm:text-sm">
                <Plus size={16} className="sm:w-4.5 sm:h-4.5 mr-1.5 sm:mr-2" />
                创建角色
              </Button>
            </div>
          )}
          
          {filteredCharacters.length > 0 && (
            <div className={`grid gap-5 sm:gap-6 transition-all duration-800 cubic-bezier(0.25, 0.46, 0.45, 0.94) ${
              sidebarCollapsed 
                ? 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5' 
                : 'grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
            }`}>
              {filteredCharacters.map((char, index) => (
                <div
                  key={char.id}
                  className="transition-all duration-800 cubic-bezier(0.25, 0.46, 0.45, 0.94) transform-gpu will-change-transform"
                  style={{
                    transitionDelay: `${Math.min(index * 50, 400)}ms`,
                  }}
                >
                  <CharacterCard 
                    char={char}
                    isSelectMode={isSelectMode}
                    isSelected={selectedIds.includes(char.id)}
                    onToggleSelect={toggleSelect}
                    onClick={() => { if (!isSelectMode) onViewProfile(char); }}
                    processingCharacter={processingCharacter}
                    forceShowOverlay={forceShowOverlay}
                    onStartChat={onStartChat}
                    onParseAndTranslateCharacter={onParseAndTranslateCharacter}
                    onExportCharacter={onExportCharacter}
                    onEditCharacter={onEditCharacter}
                    onDeleteCharacter={onDeleteCharacter}
                    onStopProcessing={onStopProcessing}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        
        {isSelectMode && selectedIds.length > 0 && (
          <div className="p-3.5 sm:p-4 border-t border-border">
            <div className="bg-background border border-border rounded-2xl p-3.5 sm:p-4 flex items-center justify-between">
              <div className="flex items-center space-x-2.5 sm:space-x-3">
                <div className="flex -space-x-1.5 sm:-space-x-2">
                  {selectedIds.slice(0, 4).map(id => {
                    const char = characters.find(c => c.id === id);
                    return char ? (
                      <img key={id} src={char.avatar || ''} className="w-8 h-8 sm:w-9 sm:h-9 rounded-2xl border-2 border-slate-900 dark:border-slate-900 object-cover" alt="" />
                    ) : null;
                  })}
                  {selectedIds.length > 4 && (
                    <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-2xl border-2 border-slate-900 dark:border-slate-900 bg-slate-800 flex items-center justify-center text-[10px] sm:text-xs font-bold text-slate-300">
                      +{selectedIds.length - 4}
                    </div>
                  )}
                </div>
                <span className="text-xs sm:text-sm font-bold">已选 {selectedIds.length} 人</span>
              </div>
              <Button variant="default" className="h-9 sm:h-10 rounded-xl text-xs sm:text-sm">
                <MessageSquare size={14} className="sm:w-4 sm:h-4 mr-1.5 sm:mr-2" />
                创建群聊
              </Button>
            </div>
          </div>
        )}
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
        <div className="fixed top-3.5 sm:top-4 right-3.5 sm:right-4 bg-background border border-border rounded-xl p-3.5 sm:p-4 shadow-xl z-[80] flex items-center gap-2.5 sm:gap-3">
          <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-xs sm:text-sm font-medium">{showProcessingMessage.message}</p>
        </div>
      )}
      
      {showImportOptions && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3.5 sm:p-4">
          <div className="bg-background border border-border rounded-2xl p-5 sm:p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-base sm:text-lg font-semibold mb-3.5 sm:mb-4">角色卡导入成功！</h3>
            <p className="text-xs sm:text-sm text-muted-foreground mb-5 sm:mb-6">是否需要使用AI解析和翻译这个角色卡？</p>
            <div className="flex flex-col gap-2.5 sm:gap-3">
              <Button 
                onClick={async () => {
                  onSetShowImportOptions(null);
                  onParseAndTranslateCharacter(showImportOptions);
                }}
                disabled={processingCharacter !== null}
                variant="default"
                className="text-xs sm:text-sm"
              >
                <Sparkles size={14} className="sm:w-4 sm:h-4 mr-1.5 sm:mr-2" />
                解析并翻译
              </Button>
              <Button 
                variant="secondary"
                onClick={() => onSetShowImportOptions(null)}
                className="text-xs sm:text-sm"
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

export const CharacterList: React.FC<CharacterListProps> = (props) => {
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < 768 : false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  if (isMobile) {
    return <MobileView {...props} />;
  }

  return <DesktopView {...props} />;
};
