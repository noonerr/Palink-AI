/**
 * CharacterList — 角色列表/网格视图
 * 全新的响应式布局设计
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  Bot, Plus, Upload, Play, Sparkles, Download, Edit3, Trash2, Search,
  MessageSquare, Check, ChevronRight, ChevronLeft
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
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

const IOS_LIKE_LAYOUT_TRANSITION = {
  type: 'spring' as const,
  stiffness: 520,
  damping: 46,
  mass: 0.95,
  delay: 0.016,
  restSpeed: 0.08,
  restDelta: 0.001,
};

const IOS_LIKE_EXIT_TRANSITION = {
  duration: 0.18,
  ease: [0.4, 0, 1, 1] as [number, number, number, number],
};

const IOS_DOCK_LAYOUT_TRANSITION = {
  duration: 0.32,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

const hasSameCharacterOrder = (a: Character[], b: Character[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
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
    className={`group relative rounded-3xl cursor-pointer transition-all duration-500 overflow-hidden transform-gpu will-change-transform ${
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
        <div className={`absolute top-4 right-4 sm:top-5 sm:right-5 w-9 h-9 sm:w-10 sm:h-10 rounded-full border-2 flex items-center justify-center transition-all z-20 ${
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
            <div className="w-14 h-14 sm:w-18 sm:h-18 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4 sm:mb-5" />
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
      
      <div className="absolute bottom-0 left-0 right-0 p-3.5 sm:p-4 z-20 transition-opacity duration-300 group-hover:opacity-0 pointer-events-none rounded-b-3xl">
        <span className="inline-block px-2.5 py-1.25 sm:px-2.5 sm:py-1 bg-white/10 backdrop-blur-md rounded-full text-xs sm:text-sm font-medium text-white/80 mb-1.5 sm:mb-2">
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
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-30 flex items-end p-2.5 sm:p-2.5 rounded-3xl">
          <div className="w-full">
            <div className="flex flex-wrap items-center gap-1.25 mb-2.5">
              <Button 
                variant="default" 
                size="sm" 
                className="flex-1 text-xs h-9 bg-white/90 text-slate-900 hover:bg-white dark:bg-slate-700/90 dark:text-slate-100 dark:hover:bg-slate-600/90"
                onClick={(e) => { e.stopPropagation(); onStartChat(char); }}
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Play size={14} className="mr-1.25" />
                <span className="hidden sm:inline">开始对话</span>
                <span className="sm:hidden">对话</span>
              </Button>
            </div>
            <div className="flex items-center gap-2 justify-center">
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-8 w-8 p-0 bg-white/20 hover:bg-white/30 dark:bg-slate-700/55 dark:hover:bg-slate-600/65 backdrop-blur-md border-0"
                onClick={(e) => { e.stopPropagation(); onParseAndTranslateCharacter(char.id); }}
                disabled={char.is_processing || processingCharacter === char.id}
                title="AI解析并翻译角色卡"
              >
                <Sparkles size={16} className="text-white" />
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-8 w-8 p-0 bg-white/20 hover:bg-white/30 dark:bg-slate-700/55 dark:hover:bg-slate-600/65 backdrop-blur-md border-0 hidden sm:inline-flex"
                onClick={(e) => { e.stopPropagation(); onExportCharacter(char, 'png'); }}
                title="导出为PNG"
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Download size={16} className="text-white" />
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-8 w-8 p-0 bg-white/20 hover:bg-white/30 dark:bg-slate-700/55 dark:hover:bg-slate-600/65 backdrop-blur-md border-0"
                onClick={(e) => { e.stopPropagation(); onEditCharacter(char); }}
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Edit3 size={16} className="text-white" />
              </Button>
              <Button 
                variant="secondary" 
                size="sm" 
                className="h-8 w-8 p-0 bg-white/20 hover:bg-red-500/40 backdrop-blur-md border-0"
                onClick={(e) => { e.stopPropagation(); onDeleteCharacter(char.id); }}
                disabled={char.is_processing || processingCharacter === char.id}
              >
                <Trash2 size={16} className="text-white" />
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
  const expandedWidth = windowWidth >= 640 ? 224 : 192;

  return (
    <motion.div
      className="h-full flex flex-col border-l border-border bg-background flex-shrink-0 overflow-hidden"
      animate={{ width: sidebarCollapsed ? 0 : expandedWidth }}
      layout
      transition={{
        duration: 0.3,
        ease: [0.22, 1, 0.36, 1],
        layout: IOS_LIKE_LAYOUT_TRANSITION,
      }}
    >
      <div style={{ width: expandedWidth, flexShrink: 0 }} className="h-full flex flex-col">
        <div className="px-4 sm:px-5 flex-shrink-0 border-b border-border">
          <div className="py-4">
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium mb-1">欢迎回来</p>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-900 dark:text-white text-lg">角色扮演</h2>
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="p-2 rounded-xl hover:bg-muted transition-all duration-300 ease-in-out hover:scale-110 active:scale-95"
              >
                <ChevronRight size={20} className="transition-transform duration-300" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
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
                      ? 'bg-slate-900 dark:bg-[#343a56] text-white dark:text-slate-100'
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
    </motion.div>
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
  const maxScroll = 120;

  const filteredCharacters = characters.filter((char) => {
    const matchesSearch = !searchQuery.trim() ||
      char.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (char.description || '').toLowerCase().includes(searchQuery.toLowerCase());

    const charCategory = getCharacterCategory(char);
    const matchesCategory = activeCategory === 'all' || charCategory === activeCategory;

    return matchesSearch && matchesCategory;
  });

  const [visibleCharacters, setVisibleCharacters] = useState<Character[]>(filteredCharacters);
  const [pendingCategoryCharacters, setPendingCategoryCharacters] = useState<Character[] | null>(null);
  const prevCategoryRef = useRef(activeCategory);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;
    const progress = Math.min(Math.max(currentScrollY, 0), maxScroll) / maxScroll;
    setScrollProgress(progress);
    lastScrollY.current = currentScrollY;
  }, []);

  useEffect(() => {
    const categoryChanged = prevCategoryRef.current !== activeCategory;
    prevCategoryRef.current = activeCategory;

    if (!categoryChanged) {
      if (!hasSameCharacterOrder(visibleCharacters, filteredCharacters)) {
        setVisibleCharacters(filteredCharacters);
      }
      return;
    }

    const nextIds = new Set(filteredCharacters.map((c) => c.id));
    const stay = visibleCharacters.filter((c) => nextIds.has(c.id));
    const hasLeaving = stay.length !== visibleCharacters.length;

    if (!hasLeaving) {
      setVisibleCharacters(filteredCharacters);
      setPendingCategoryCharacters(null);
      return;
    }

    setPendingCategoryCharacters(filteredCharacters);
    setVisibleCharacters(stay);
  }, [filteredCharacters, activeCategory, visibleCharacters]);

  const handleCategoryExitComplete = useCallback(() => {
    if (pendingCategoryCharacters) {
      setVisibleCharacters(pendingCategoryCharacters);
      setPendingCategoryCharacters(null);
    }
  }, [pendingCategoryCharacters]);

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
  const getButtonGap = () => 2 - scrollProgress * 0.5;
  const getButtonHeight = () => 42 - scrollProgress * 3;

  return (
    <div className="flex flex-col w-full h-full pt-safe">
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
                  activeCategory === category.id ? 'bg-slate-900 dark:bg-[#343a56] text-white dark:text-slate-100' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
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
        {visibleCharacters.length === 0 && (
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
        
        {visibleCharacters.length > 0 && (
          <motion.div
            className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-5"
            layout
            transition={{
              layout: IOS_LIKE_LAYOUT_TRANSITION,
            }}
          >
            <AnimatePresence initial={false} onExitComplete={handleCategoryExitComplete}>
              {visibleCharacters.map((char) => (
                <motion.div
                  key={char.id}
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{
                    layout: IOS_LIKE_LAYOUT_TRANSITION,
                    opacity: IOS_LIKE_EXIT_TRANSITION,
                    y: IOS_LIKE_EXIT_TRANSITION,
                  }}
                  className="transform-gpu will-change-transform"
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
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
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
  const expandedWidth = windowWidth >= 640 ? 224 : 192;

  const filteredCharacters = characters.filter((char) => {
    const matchesSearch = !searchQuery.trim() ||
      char.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (char.description || '').toLowerCase().includes(searchQuery.toLowerCase());

    const charCategory = getCharacterCategory(char);
    const matchesCategory = activeCategory === 'all' || charCategory === activeCategory;

    return matchesSearch && matchesCategory;
  });

  const [visibleCharacters, setVisibleCharacters] = useState<Character[]>(filteredCharacters);

  useEffect(() => {
    let timeout: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        setWindowWidth(window.innerWidth);
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeout);
    };
  }, []);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter((i) => i !== id);
      }
      return [...prev, id];
    });
  };

  useEffect(() => {
    setVisibleCharacters(filteredCharacters);
  }, [filteredCharacters]);

  return (
    <div className="flex w-full h-full relative">
      <LayoutGroup>
        <motion.div
          className="flex-1 flex flex-col overflow-hidden"
          layout
          transition={{
            layout: IOS_LIKE_LAYOUT_TRANSITION,
          }}
        >
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto p-5 sm:p-6"
          >
            {visibleCharacters.length === 0 && (
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
            
            {visibleCharacters.length > 0 && (
              <motion.div
                className="grid gap-5 sm:gap-6 mx-auto"
                style={{ 
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  maxWidth: '1600px',
                  paddingLeft: '1.25rem',
                  paddingRight: '1.25rem'
                }}
                layout
                transition={{
                  layout: IOS_LIKE_LAYOUT_TRANSITION,
                }}
              >
                <AnimatePresence initial={false}>
                  {visibleCharacters.map((char) => (
                    <motion.div
                      key={char.id}
                      layout="position"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{
                        layout: IOS_LIKE_LAYOUT_TRANSITION,
                        opacity: IOS_LIKE_EXIT_TRANSITION,
                        y: IOS_LIKE_EXIT_TRANSITION,
                      }}
                      style={{
                        maxWidth: '240px',
                      }}
                      className="transform-gpu will-change-transform"
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
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </motion.div>
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
        </motion.div>

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
      </LayoutGroup>

      {sidebarCollapsed && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="absolute top-1/2 right-0 -translate-y-1/2 z-20 bg-background border border-r-0 border-border rounded-l-lg shadow-lg hover:bg-muted transition-all duration-300 ease-out p-2 pr-1.5 hover:scale-105 active:scale-95"
          title="展开侧边栏"
        >
          <ChevronLeft size={18} className="sm:w-5 sm:h-5 transition-transform duration-300" />
        </button>
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
