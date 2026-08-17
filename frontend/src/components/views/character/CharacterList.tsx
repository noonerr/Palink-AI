/**
 * CharacterList — 角色列表/网格视图
 * 全新的响应式布局设计
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  Bot, Plus, Upload, Play, Sparkles, Download, Edit3, Trash2, Search,
  MessageSquare, Check, ChevronRight, ChevronLeft, AlertCircle, RefreshCw, X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { useWindowSize } from '@/hooks/useWindowSize';
import type { Character } from '@/types';

/**
 * 角色列表项类型：既可以是真实角色，也可以是导入中的占位角色。
 * 占位角色通过 `_importing: true` 标识，并携带进度/状态信息。
 */
export type CharacterListItem = Character & {
  _importing?: boolean;
  _progress?: number;
  _status?: 'uploading' | 'processing' | 'success' | 'error';
  _message?: string;
  _fileName?: string;
  _avatarUrl?: string;
};

export interface CharacterListProps {
  characters: CharacterListItem[];
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
  onCloseImporting: (id: string) => void;
  loadFailed?: boolean;
  onRetry?: () => void;
}

/**
 * 保留 CharacterImportTask 接口定义以兼容外部引用，
 * 但不再用于独立标识卡渲染。
 */
export interface CharacterImportTask {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'processing' | 'success' | 'error';
  message: string;
  avatarUrl?: string;
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
  duration: 0.38,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

const hasSameCharacterOrder = (a: Character[], b: Character[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
};

const ImportTaskOverlay = ({ char, onClose }: { char: CharacterListItem; onClose: (id: string) => void }) => {
  const status = char._status || 'uploading';
  const isError = status === 'error';
  const isSuccess = status === 'success';
  const progress = Math.max(0, Math.min(100, Math.round(char._progress || 0)));

  return (
    <div className="absolute inset-0 z-40 rounded-3xl overflow-hidden bg-slate-200 dark:bg-slate-800">
      {char._avatarUrl ? (
        <img
          src={char._avatarUrl}
          className="absolute inset-0 w-full h-full object-cover blur-sm scale-105 opacity-70"
          alt=""
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-slate-200 via-slate-100 to-slate-300 dark:from-slate-800 dark:via-slate-900 dark:to-slate-700" />
      )}
      <div className="absolute inset-0 bg-slate-950/75 rounded-3xl" />
      <div className="absolute inset-0 z-10 flex flex-col justify-between p-4 text-white">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/80 backdrop-blur-md">
              {isError ? '导入失败' : isSuccess ? '导入完成' : '正在导入'}
            </span>
            <h3 className="mt-3 truncate text-base font-semibold leading-tight">{char._fileName || char.name}</h3>
          </div>
          <div className="flex items-center gap-2">
            {isError && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(char.id); }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 hover:bg-white/25 transition-colors"
                title="关闭"
              >
                <X size={16} />
              </button>
            )}
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isError ? 'bg-red-500/20' : 'bg-white/15'}`}>
              {isError ? <AlertCircle size={18} /> : <Upload size={17} />}
            </div>
          </div>
        </div>

        <div>
          <p className="mb-2 line-clamp-3 text-xs leading-5 text-white/80">{char._message || ''}</p>
          <div className="h-2 overflow-hidden rounded-full bg-white/15">
            <div
              className={`h-full rounded-full transition-all duration-300 ${isError ? 'bg-red-400' : isSuccess ? 'bg-emerald-400' : 'bg-white'}`}
              style={{ width: `${isError ? 100 : progress}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] font-medium text-white/70">
            <span>{isError ? '请重新获取原始文件' : status === 'processing' ? '解析角色卡' : '上传角色卡'}</span>
            <span>{isError ? '错误' : `${progress}%`}</span>
          </div>
        </div>
      </div>
    </div>
  );
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
  onStopProcessing,
  onCloseImporting,
}: {
  char: CharacterListItem;
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
  onCloseImporting: (id: string) => void;
}) => (
  <div 
    onClick={() => {
      if (char._importing) return;
      isSelectMode ? onToggleSelect(char.id) : onClick();
    }}
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
          loading="lazy"
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
      
      {char._importing && (
        <ImportTaskOverlay char={char} onClose={onCloseImporting} />
      )}
      
      {isSelectMode && !char._importing && (
        <div className={`absolute top-4 right-4 sm:top-5 sm:right-5 w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 flex items-center justify-center transition-all z-20 ${
          isSelected 
            ? 'bg-primary border-primary shadow-lg shadow-primary/50' 
            : 'bg-black/30 border-white/60 backdrop-blur-md'
        }`}>
          {isSelected && <Check size={18} className="sm:w-6 sm:h-6 text-white" />}
        </div>
      )}
      
      {(processingCharacter === char.id || forceShowOverlay === char.id) && !char._importing && (
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
      
      {!isSelectMode && !char._importing && (
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
  const expandedWidth = windowWidth >= 640 ? 224 : 192;

  return (
    <>
      <motion.div
        layout
        className="h-full flex flex-col border-l border-border overflow-hidden"
        style={{ width: sidebarCollapsed ? 0 : expandedWidth }}
        transition={{
          layout: IOS_DOCK_LAYOUT_TRANSITION,
        }}
      >
        <motion.div
          className="h-full flex flex-col"
          animate={{
            opacity: sidebarCollapsed ? 0 : 1,
            x: sidebarCollapsed ? 18 : 0,
            pointerEvents: sidebarCollapsed ? 'none' : 'auto',
          }}
          transition={{
            duration: 0.24,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <div className="px-4 sm:px-5 flex-shrink-0 border-b border-border">
            <div className="py-4">
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium mb-1">欢迎回来</p>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-slate-900 dark:text-white text-lg">角色扮演</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSidebarCollapsed(true)}
                  className="h-8 w-8"
                >
                  <ChevronRight size={20} className="transition-transform duration-300" />
                </Button>
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
        </motion.div>
      </motion.div>
      
      {sidebarCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSidebarCollapsed(false)}
          className="absolute top-1/2 right-0 -translate-y-1/2 z-20 h-8 w-8 rounded-l-lg shadow-lg"
          title="展开侧边栏"
        >
          <ChevronLeft size={18} className="sm:w-5 sm:h-5 transition-transform duration-300" />
        </Button>
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
  onCloseImporting,
  loadFailed,
  onRetry,
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
    // 占位角色始终显示，不受搜索/分类影响
    if (char._importing) return true;

    const matchesSearch = !searchQuery.trim() ||
      char.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (char.description || '').toLowerCase().includes(searchQuery.toLowerCase());

    const charCategory = getCharacterCategory(char);
    const matchesCategory = activeCategory === 'all' || charCategory === activeCategory;

    return matchesSearch && matchesCategory;
  });

  const [visibleCharacters, setVisibleCharacters] = useState<CharacterListItem[]>(filteredCharacters);
  const [pendingCategoryCharacters, setPendingCategoryCharacters] = useState<CharacterListItem[] | null>(null);
  const prevCategoryRef = useRef(activeCategory);
  const hasVisibleItems = visibleCharacters.length > 0;

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
    const pt = 12 - scrollProgress * 8;
    const pb = 10 - scrollProgress * 6;
    return {
      paddingTop: `max(env(safe-area-inset-top), ${pt}px)`,
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

  return (
    <div className="flex flex-col w-full h-full">
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
              className={`text-xs sm:text-sm rounded-2xl transition-all duration-400 ease-in-out backdrop-blur-[20px] ${!isSelectMode ? 'bg-[#FFFAFA]/40 dark:bg-white/[0.07] border border-[#d9cfbf]/50 dark:border-white/[0.15] text-slate-700 dark:text-white/80' : ''}`}
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
            <Button onClick={onCreateCharacter} className="rounded-2xl transition-all duration-400 ease-in-out text-xs sm:text-sm backdrop-blur-[20px] bg-[#FFFAFA]/40 dark:bg-white/[0.07] border border-[#d9cfbf]/50 dark:border-white/[0.15] text-slate-700 dark:text-white/80" style={{ 
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
        {loadFailed && !hasVisibleItems && (
          <div className="text-center py-16 sm:py-20">
            <div className="w-20 h-20 sm:w-24 sm:h-24 bg-red-500/10 rounded-3xl mx-auto flex items-center justify-center text-4xl sm:text-5xl mb-4 sm:mb-6 shadow-xl ring-1 ring-red-500/20">
              <AlertCircle size={40} className="sm:w-12 sm:h-12 text-red-500" />
            </div>
            <h3 className="text-lg sm:text-xl font-semibold mb-1.5 sm:mb-2">角色加载失败</h3>
            <p className="text-xs sm:text-sm text-muted-foreground mb-4 sm:mb-6">网络似乎不太稳定，请检查网络后重试</p>
            <Button onClick={onRetry} className="text-xs sm:text-sm">
              <RefreshCw size={16} className="sm:w-4.5 sm:h-4.5 mr-1.5 sm:mr-2" />
              重试
            </Button>
          </div>
        )}
        {!hasVisibleItems && !loadFailed && (
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
        
        {hasVisibleItems && (
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
                    onCloseImporting={onCloseImporting}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
      
      {isSelectMode && selectedIds.length > 0 && (
        <div className="fixed bottom-[max(0.875rem,env(safe-area-inset-bottom))] sm:bottom-4 left-3.5 sm:left-4 right-3.5 sm:right-4 z-40">
          <div className="bg-white/80 dark:bg-slate-950/80 backdrop-blur-2xl p-3.5 sm:p-4 rounded-2xl border border-slate-200/50 dark:border-slate-800 shadow-2xl flex items-center justify-between">
            <div className="flex items-center space-x-2.5 sm:space-x-3">
              <div className="flex -space-x-1.5 sm:-space-x-2">
                {selectedIds.slice(0, 4).map(id => {
                  const char = characters.find(c => c.id === id);
                  return char ? (
                    <img key={id} src={char.avatar || ''} loading="lazy" decoding="async" className="w-8 h-8 sm:w-9 sm:h-9 rounded-2xl border-2 border-slate-900 dark:border-slate-900 object-cover" alt="" />
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
        <div className="fixed top-[max(0.875rem,env(safe-area-inset-top))] sm:top-4 right-3.5 sm:right-4 bg-background border border-border rounded-xl p-3.5 sm:p-4 shadow-xl z-[80] flex items-center gap-2.5 sm:gap-3">
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
  onCloseImporting,
  loadFailed,
  onRetry,
}: Omit<CharacterListProps, 't'>) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { width: windowWidth } = useWindowSize();
  const [layoutKey, setLayoutKey] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const filteredCharacters = characters.filter((char) => {
    // 占位角色始终显示，不受搜索/分类影响
    if (char._importing) return true;

    const matchesSearch = !searchQuery.trim() ||
      char.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (char.description || '').toLowerCase().includes(searchQuery.toLowerCase());

    const charCategory = getCharacterCategory(char);
    const matchesCategory = activeCategory === 'all' || charCategory === activeCategory;

    return matchesSearch && matchesCategory;
  });

  const [visibleCharacters, setVisibleCharacters] = useState<CharacterListItem[]>(filteredCharacters);
  const [pendingCategoryCharacters, setPendingCategoryCharacters] = useState<CharacterListItem[] | null>(null);
  const prevCategoryRef = useRef(activeCategory);
  const hasVisibleItems = visibleCharacters.length > 0;

  useEffect(() => {
    setLayoutKey(prev => prev + 1);
  }, [windowWidth]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter((i) => i !== id);
      }
      return [...prev, id];
    });
  };

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

  return (
    <LayoutGroup id="character-desktop-reflow">
      <motion.div className="flex w-full h-full" layout transition={{ layout: IOS_DOCK_LAYOUT_TRANSITION }}>
      <motion.div className="flex-1 flex flex-col overflow-hidden" layout transition={{ layout: IOS_DOCK_LAYOUT_TRANSITION }}>
        <div 
          ref={scrollContainerRef} 
          className="flex-1 overflow-y-auto p-5 sm:p-6 transition-all duration-500 ease-in-out"
        >
          {loadFailed && !hasVisibleItems && (
            <div className="text-center py-16 sm:py-20">
              <div className="w-20 h-20 sm:w-24 sm:h-24 bg-red-500/10 rounded-3xl mx-auto flex items-center justify-center text-4xl sm:text-5xl mb-4 sm:mb-6 shadow-xl ring-1 ring-red-500/20">
                <AlertCircle size={40} className="sm:w-12 sm:h-12 text-red-500" />
              </div>
              <h3 className="text-lg sm:text-xl font-semibold mb-1.5 sm:mb-2">角色加载失败</h3>
              <p className="text-xs sm:text-sm text-muted-foreground mb-4 sm:mb-6">网络似乎不太稳定，请检查网络后重试</p>
              <Button onClick={onRetry} className="text-xs sm:text-sm">
                <RefreshCw size={16} className="sm:w-4.5 sm:h-4.5 mr-1.5 sm:mr-2" />
                重试
              </Button>
            </div>
          )}
          {!hasVisibleItems && !loadFailed && (
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
          
          {hasVisibleItems && (
            <motion.div 
              className="grid gap-5 sm:gap-6 mx-auto"
              style={{ 
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                maxWidth: '1600px',
                paddingLeft: '1.25rem',
                paddingRight: '1.25rem'
              }}
              layout
              layoutDependency={[sidebarCollapsed, layoutKey]}
              transition={{
                layout: IOS_DOCK_LAYOUT_TRANSITION,
              }}
            >
              <AnimatePresence initial={false} onExitComplete={handleCategoryExitComplete}>
                {visibleCharacters.map((char) => (
                  <motion.div
                    key={char.id}
                    layout
                    layoutDependency={layoutKey}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{
                      layout: IOS_DOCK_LAYOUT_TRANSITION,
                      opacity: IOS_LIKE_EXIT_TRANSITION,
                      y: IOS_LIKE_EXIT_TRANSITION,
                    }}
                    style={{
                      maxWidth: '240px',
                    }}
                    className="will-change-transform"
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
                      onCloseImporting={onCloseImporting}
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
      </motion.div>
    </LayoutGroup>
  );
};

export function CharacterList(props: CharacterListProps) {
  const isMobile = useIsMobile();

  // 空闲时预热前 12 个角色头像：列表图片是 loading=lazy，视口外不下载；
  // 预热后悬停/点击进聊天时头像即时显示（聊天页消息头像同 URL，共享缓存）。
  const avatarPrefetchKeyRef = useRef('');
  useEffect(() => {
    const urls = (props.characters || [])
      .map(c => c.avatar)
      .filter((u): u is string => !!u)
      .slice(0, 12);
    if (urls.length === 0) return;
    const key = urls.join('|');
    if (avatarPrefetchKeyRef.current === key) return;
    avatarPrefetchKeyRef.current = key;
    const prefetch = () => {
      for (const url of urls) {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(timer);
  }, [props.characters]);

  if (isMobile) {
    return <MobileView {...props} />;
  }

  return <DesktopView {...props} />;
};
