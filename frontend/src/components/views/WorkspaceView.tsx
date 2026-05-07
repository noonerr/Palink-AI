import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  UploadCloud,
  FolderPlus,
  Grid,
  List,
  Trash2,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  Home,
  MessageSquarePlus,
  BrainCircuit,
  X,
  Check,
  Loader2,
  Sparkles,
  Menu
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MarkdownRenderer } from '@/components/ui/custom/MarkdownRenderer';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { api } from '@/services/api';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import { useIsMobile } from '@/hooks/use-mobile';
import type { FileItem, Folder as FolderType, Model, WorkspaceItems } from '@/types';

interface WorkspaceViewProps {
  token: string;
  user?: any;
  models: Model[];
  systemDefaults: any;
  t: Record<string, string>;
  isDark?: boolean;
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  token: _token,
  user: _user,
  models,
  systemDefaults,
  t,
  isDark = false
}) => {
  const bottomPadding = useMobileBottomPadding();
  const isMobile = useIsMobile();
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<WorkspaceItems>({ folders: [], files: [], usage: 0, limit: 0 });
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [isCreateFolder, setIsCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<FileItem>>(new Set());
  const [sidebarTab, setSidebarTab] = useState<'files' | 'projects'>('files');
  const [workspaceMode, setWorkspaceMode] = useState<'browser' | 'chat'>('browser');
  const [insightFile, setInsightFile] = useState<FileItem | null>(null);
  const [insightModel, setInsightModel] = useState('');
  const [insightAnalyzing, setInsightAnalyzing] = useState(false);
  const [insightContent, setInsightContent] = useState('');
  const [insightPanelOpen, setInsightPanelOpen] = useState(false);
  const [mobileInsightOpen, setMobileInsightOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    // 从 sessionStorage 读取状态，默认展开
    const saved = sessionStorage.getItem('workspace_sidebar_collapsed');
    return saved ? JSON.parse(saved) : false;
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; type: 'file' | 'folder' } | null>(null);
  
  // 保存状态到 sessionStorage
  useEffect(() => {
    sessionStorage.setItem('workspace_sidebar_collapsed', JSON.stringify(sidebarCollapsed));
  }, [sidebarCollapsed]);
  
  // Mobile sidebar state
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentFolderId = path.length > 0 ? path[path.length - 1].id : '';

  useEffect(() => {
    if (models.length) {
      setInsightModel(systemDefaults.default_outline_model || models[0]?.id);
    }
  }, [models, systemDefaults]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get(`/api/workspace?parent_id=${currentFolderId || ''}`);
      setItems(data);
    } catch (e) {
      console.error('Failed to fetch items:', e);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setIsCreateFolder(false);
      return;
    }
    try {
      await api.post('/api/workspace/folder', {
        name: newFolderName,
        parent_id: currentFolderId || ''
      });
      setNewFolderName('');
      setIsCreateFolder(false);
      fetchItems();
    } catch (e) {
      console.error('Failed to create folder:', e);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder_id', currentFolderId || '');

      try {
        await api.post('/api/workspace/upload', formData);
      } catch (e) {
        console.error('Upload failed:', e);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    fetchItems();
  };

  const handleDelete = async (id: string, type: 'file' | 'folder') => {
    setPendingDelete({ id, type });
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    
    const { id, type } = pendingDelete;
    const body = type === 'file' 
      ? { file_ids: [id] } 
      : { folder_ids: [id] };

    try {
      await api.delete('/api/workspace/delete', body);
      fetchItems();
      
      if (type === 'file') {
        const newSet = new Set(Array.from(selectedFiles).filter(f => f.id !== id));
        setSelectedFiles(newSet);
      }
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setPendingDelete(null);
    }
  };

  const toggleSelection = (file: FileItem) => {
    const newSet = new Set(selectedFiles);
    const exists = Array.from(newSet).find(f => f.id === file.id);
    
    if (exists) {
      newSet.delete(exists);
    } else {
      newSet.add(file);
    }
    
    setSelectedFiles(newSet);
  };

  const handleStreamAnalyze = async () => {
    if (!insightFile || !insightModel) return;

    setInsightAnalyzing(true);
    setInsightContent('');

    try {
      const currentLang = t.lang_switch === 'English' ? 'zh' : 'en';
      const res = await api.stream('/api/workspace/analyze/stream', {
        file_id: insightFile.id,
        model: insightModel,
        lang: currentLang,
      });

      const reader = res.body?.getReader();
      if (!reader) {
        setInsightAnalyzing(false);
        return;
      }

      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                accumulated += parsed.content;
                setInsightContent(accumulated);
              }
              if (parsed.error) {
                console.error('Stream error:', parsed.error);
              }
            } catch {
              // skip non-JSON lines
            }
          }
        }
      }

      if (accumulated) {
        setItems((prev: WorkspaceItems) => ({
          ...prev,
          files: prev.files.map((f: FileItem) =>
            f.id === insightFile.id ? { ...f, summary: accumulated } : f
          )
        }));
        setInsightFile((prev: FileItem | null) => prev ? { ...prev, summary: accumulated } : null);
      }
    } catch (e) {
      console.error('Stream analysis failed:', e);
    } finally {
      setInsightAnalyzing(false);
    }
  };

  const openInsightPanel = (file: FileItem) => {
    setInsightFile(file);
    setInsightContent(file.summary || '');
    if (isMobile) {
      setMobileInsightOpen(true);
    } else {
      setInsightPanelOpen(true);
    }
  };

  const isSelected = (id: string) => Array.from(selectedFiles).some(f => f.id === id);
  const fmtSize = (s: number) => {
    if (s < 1024) return s + 'B';
    if (s < 1024 * 1024) return (s / 1024).toFixed(1) + 'KB';
    return (s / 1024 / 1024).toFixed(1) + 'MB';
  };

  if (workspaceMode === 'chat') {
    return (
      <div className={cn('flex h-full relative', isMobile ? (isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]') : 'bg-background')}>
        {/* Placeholder for workspace chat - would need ChatInterface component */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground mb-4">Workspace Chat Mode</p>
            <Button onClick={() => setWorkspaceMode('browser')}>
              Back to Files
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full relative', isMobile ? (isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]') : 'bg-background')}>
      {/* Desktop Sidebar with smooth fade animation */}
      <div 
        className={cn(
          "hidden md:flex h-full flex-col",
          "transition-all duration-300 ease-in-out will-change-[width,opacity]",
          sidebarCollapsed 
            ? "w-0 opacity-0 border-r-0 bg-transparent" 
            : "w-64 opacity-100 glass"
        )}
      >
        <div className={cn(
          "w-64 h-full flex flex-col transition-opacity duration-300 ease-in-out",
          sidebarCollapsed ? 'opacity-0' : 'opacity-100'
        )}>
        {/* Header */}
        <div className="h-[54px] flex items-center justify-between px-4 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{t.workspace_title || '工作空间'}</span>
          </div>
        </div>
        <div className="flex-1 p-4">
          {/* Tabs */}
          <div className={cn('p-1 rounded-lg flex text-xs font-medium mb-4', isDark ? 'bg-slate-700/30' : 'bg-[#f5eee2]/50')}>
            <button
              onClick={() => setSidebarTab('files')}
              className={cn(
                "flex-1 py-1.5 rounded-md transition-all",
                sidebarTab === 'files'
                  ? isDark ? "bg-slate-600/80 text-white shadow-sm" : "bg-[#FFFAFA] text-slate-800 shadow-sm"
                  : isDark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"
              )}
            >
              {t.tab_files}
            </button>
            <button
              onClick={() => setSidebarTab('projects')}
              className={cn(
                "flex-1 py-1.5 rounded-md transition-all",
                sidebarTab === 'projects'
                  ? isDark ? "bg-slate-600/80 text-white shadow-sm" : "bg-[#FFFAFA] text-slate-800 shadow-sm"
                  : isDark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"
              )}
            >
              {t.tab_projects}
            </button>
          </div>

          {sidebarTab === 'files' ? (
            <>
              {/* Selected Files */}
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold text-sm">
                  {t.files_selected} ({selectedFiles.size})
                </h3>
                {selectedFiles.size > 0 && (
                  <button
                    onClick={() => setSelectedFiles(new Set())}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    {t.clear}
                  </button>
                )}
              </div>

              <div className="space-y-2 mb-4">
                {selectedFiles.size === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-xs border-2 border-dashed border-border rounded-xl">
                    {t.empty_selection}
                  </div>
                )}
                {Array.from(selectedFiles).map(file => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 p-2 bg-background rounded-lg border border-border text-sm"
                  >
                    <span className="text-lg">{file.type.includes('image') ? '🖼️' : '📄'}</span>
                    <span className="flex-1 truncate text-sm">{file.filename}</span>
                    <button
                      onClick={() => toggleSelection(file)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Start Project Button */}
              <div className="mt-4 pt-4 border-t border-border/50">
                <button
                  onClick={() => setWorkspaceMode('chat')}
                  disabled={selectedFiles.size === 0}
                  className={cn(
                    'flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-[28px] border backdrop-blur-[30px] px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out',
                    isDark
                      ? 'border-slate-600/80 bg-[#2d3350] text-white hover:bg-[#3a4263] disabled:opacity-50'
                      : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f5eee2] disabled:opacity-50'
                  )}
                >
                  <MessageSquarePlus size={16} />
                  {t.create_project}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {/* Projects list would go here */}
              <div className="text-center py-8 text-muted-foreground text-sm">
                {t.no_projects || '暂无项目'}
              </div>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Mobile Fullscreen Sidebar Overlay */}
      {mobileSidebarOpen && (
        <div 
          className="fixed inset-0 z-50 md:hidden animate-fade-in"
          onClick={() => setMobileSidebarOpen(false)}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div 
            className="absolute left-0 top-0 bottom-0 w-[85%] max-w-[320px] bg-background shadow-2xl animate-slide-in-left flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile Sidebar Header */}
            <div className="min-h-[3.5rem] flex items-center justify-between px-4 border-b border-border/50 shrink-0 py-2" style={{ paddingTop: `max(0.5rem, env(safe-area-inset-top))` }}>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileSidebarOpen(false)}
                  className="h-8 w-8"
                >
                  <ChevronLeft size={20} />
                </Button>
                <span className="text-sm font-semibold">{t.workspace_title || '工作空间'}</span>
              </div>
            </div>
            {/* Mobile Sidebar Content */}
            <div className="flex-1 p-4 overflow-y-auto overscroll-y-contain">
              {/* Tabs */}
              <div className={cn('p-1 rounded-lg flex text-xs font-medium mb-4', isDark ? 'bg-slate-700/30' : 'bg-[#f5eee2]/50')}>
                <button
                  onClick={() => setSidebarTab('files')}
                  className={cn(
                    "flex-1 py-2 rounded-md transition-all touch-target",
                    sidebarTab === 'files'
                      ? isDark ? "bg-slate-600/80 text-white shadow-sm" : "bg-[#FFFAFA] text-slate-800 shadow-sm"
                      : isDark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  {t.tab_files}
                </button>
                <button
                  onClick={() => setSidebarTab('projects')}
                  className={cn(
                    "flex-1 py-2 rounded-md transition-all touch-target",
                    sidebarTab === 'projects'
                      ? isDark ? "bg-slate-600/80 text-white shadow-sm" : "bg-[#FFFAFA] text-slate-800 shadow-sm"
                      : isDark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  {t.tab_projects}
                </button>
              </div>

              {sidebarTab === 'files' ? (
                <>
                  {/* Selected Files */}
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold text-sm">
                      {t.files_selected} ({selectedFiles.size})
                    </h3>
                    {selectedFiles.size > 0 && (
                      <button
                        onClick={() => setSelectedFiles(new Set())}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        {t.clear}
                      </button>
                    )}
                  </div>

                  <div className="space-y-2 mb-4">
                    {selectedFiles.size === 0 && (
                      <div className="text-center py-8 text-muted-foreground text-xs border-2 border-dashed border-border rounded-xl">
                        {t.empty_selection}
                      </div>
                    )}
                    {Array.from(selectedFiles).map(file => (
                      <div
                        key={file.id}
                        className="flex items-center gap-2 p-2 bg-background rounded-lg border border-border text-sm"
                      >
                        <span className="text-lg">{file.type.includes('image') ? '🖼️' : '📄'}</span>
                        <span className="flex-1 truncate text-sm">{file.filename}</span>
                        <button
                          onClick={() => toggleSelection(file)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Create Project Button */}
                  <div className="mt-4 pt-4 border-t border-border/50">
                    <button
                      onClick={() => {
                        setWorkspaceMode('chat');
                        setMobileSidebarOpen(false);
                      }}
                      disabled={selectedFiles.size === 0}
                      className={cn(
                        'flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-[28px] border backdrop-blur-[30px] px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out',
                        isDark
                          ? 'border-slate-600/80 bg-[#2d3350] text-white hover:bg-[#3a4263] disabled:opacity-50'
                          : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f5eee2] disabled:opacity-50'
                      )}
                    >
                      <MessageSquarePlus size={16} />
                      {t.create_project}
                    </button>
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    {t.no_projects || '暂无项目'}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="h-[48px] flex items-center justify-between px-4 sm:px-6 border-b border-border/50 backdrop-blur-xl bg-background/80 z-10 sm:pt-3" style={{ paddingTop: 'max(env(safe-area-inset-top), 6px)' }}>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-sm text-muted-foreground min-w-0 flex-1">
            {/* Mobile Sidebar Toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileSidebarOpen(true)}
              className="md:hidden h-9 w-9"
            >
              <Menu size={18} />
            </Button>
            {/* Desktop Sidebar Toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="hidden md:flex h-9 w-9"
            >
              {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setPath([])}
              className="h-9 w-9"
            >
              <Home size={16} />
            </Button>
            <div className="flex items-center gap-1 min-w-0">
              {path.map((p, idx) => (
                <React.Fragment key={p.id}>
                  <ChevronRight size={14} className="text-border shrink-0" />
                  <button
                    onClick={() => setPath(path.slice(0, idx + 1))}
                    className={cn(
                      "hover:bg-secondary px-2 py-1 rounded-md transition-colors truncate",
                      isMobile && idx < path.length - 1 && "hidden"
                    )}
                  >
                    {p.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchItems}
              disabled={loading}
              className="shrink-0"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </Button>

            <div className="hidden sm:block w-px h-4 bg-border" />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className={cn(
                'hidden sm:flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[28px] border backdrop-blur-[30px] px-4 py-2 text-sm font-medium transition-all duration-300 ease-in-out',
                isDark ? 'border-slate-600/80 bg-[#2d3350] text-white hover:bg-[#3a4263] disabled:opacity-50' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f5eee2] disabled:opacity-50'
              )}
            >
              {uploading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <UploadCloud size={16} />
              )}
              {t.upload}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className={cn(
                'sm:hidden flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-[30px] shrink-0 transition-all duration-300 ease-in-out',
                isDark ? 'border-slate-600/80 bg-[#2d3350] text-white hover:bg-[#3a4263] disabled:opacity-50' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f5eee2] disabled:opacity-50'
              )}
            >
              {uploading ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
            </button>

            <button
              onClick={() => setIsCreateFolder(true)}
              className={cn(
                'hidden sm:flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[28px] border backdrop-blur-[30px] px-4 py-2 text-sm font-medium transition-all duration-300 ease-in-out',
                isDark ? 'border-slate-600/80 bg-[#2d3350] text-white hover:bg-[#3a4263]' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f5eee2]'
              )}
            >
              <FolderPlus size={16} />
              {t.new_folder}
            </button>
            <button
              onClick={() => setIsCreateFolder(true)}
              className={cn(
                'sm:hidden flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-[30px] shrink-0 transition-all duration-300 ease-in-out',
                isDark ? 'border-slate-600/80 bg-[#2d3350] text-white hover:bg-[#3a4263]' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f5eee2]'
              )}
            >
              <FolderPlus size={16} />
            </button>

            <div className="block w-px h-4 bg-border" />

            <div className="flex bg-secondary/50 p-1 rounded-lg">
              <button
                onClick={() => setViewMode('list')}
                className={cn(
                  "p-1.5 rounded-md transition-all",
                  viewMode === 'list' 
                    ? "bg-background shadow-sm" 
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <List size={16} />
              </button>
              <button
                onClick={() => setViewMode('grid')}
                className={cn(
                  "p-1.5 rounded-md transition-all",
                  viewMode === 'grid' 
                    ? "bg-background shadow-sm" 
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Grid size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* File List */}
        <ScrollArea className="flex-1 p-6">
          <div className={`${bottomPadding}`}>
          {/* Create Folder Input */}
          {isCreateFolder && (
            <div className="mb-4 flex items-center gap-2 animate-fade-in-up">
              <Folder className="text-yellow-400" size={24} />
              <input
                autoFocus
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
                className="bg-transparent text-lg font-semibold border-b-2 border-primary outline-none w-full max-w-64"
                placeholder={t.folder_name_placeholder}
              />
              <Button size="sm" onClick={handleCreateFolder}>{t.ok}</Button>
              <Button size="sm" variant="ghost" onClick={() => setIsCreateFolder(false)}>
                {t.cancel}
              </Button>
            </div>
          )}

          {/* List View */}
          {viewMode === 'list' && (
            <div className="space-y-1">
              {items.folders.map((folder: FolderType) => (
                <div
                  key={folder.id}
                  onClick={() => setPath([...path, { id: folder.id, name: folder.name }])}
                  className="group flex items-center p-3 rounded-xl hover:bg-secondary/50 cursor-pointer transition-colors"
                >
                  <Folder className="text-yellow-400 fill-yellow-400/20 mr-4" size={24} />
                  <div className="flex-1 font-medium">{folder.name}</div>
                  <div className="text-xs text-muted-foreground mr-4">
                    {new Date(folder.created_at).toLocaleDateString()}
                  </div>
                  <div className={cn(
                    "transition-opacity",
                    isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 text-destructive hover:bg-destructive/10"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleDelete(folder.id, 'folder');
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              ))}

              {items.files.map((file: FileItem) => (
                <div
                  key={file.id}
                  onClick={() => toggleSelection(file)}
                  className={cn(
                    "group flex items-center p-3 rounded-xl cursor-pointer transition-colors",
                    isSelected(file.id)
                      ? "bg-primary/10"
                      : "hover:bg-secondary/50"
                  )}
                >
                  <div className="mr-4 text-xl">
                    {file.type.includes('image') ? '🖼️' : '📄'}
                  </div>
                  <div className="flex-1 font-medium truncate pr-4">{file.filename}</div>
                  <div className="text-xs text-muted-foreground mr-4 w-20 text-right">
                    {fmtSize(file.size)}
                  </div>
                  <div className={cn(
                    "flex gap-1 transition-opacity",
                    isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 text-primary hover:bg-primary/10"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        openInsightPanel(file);
                      }}
                    >
                      <BrainCircuit size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 text-destructive hover:bg-destructive/10"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleDelete(file.id, 'file');
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Grid View */}
          {viewMode === 'grid' && (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4">
              {items.folders.map(folder => (
                <div
                  key={folder.id}
                  onClick={() => setPath([...path, { id: folder.id, name: folder.name }])}
                  className="flex flex-col items-center p-6 rounded-2xl bg-secondary/30 hover:bg-secondary/50 cursor-pointer transition-all"
                >
                  <Folder className="text-yellow-400 fill-yellow-400/20 mb-3" size={48} />
                  <span className="text-sm font-medium text-center truncate w-full">
                    {folder.name}
                  </span>
                </div>
              ))}

              {items.files.map(file => (
                <div
                  key={file.id}
                  onClick={() => toggleSelection(file)}
                  className={cn(
                    "relative flex flex-col items-center p-6 rounded-2xl cursor-pointer transition-all border-2",
                    isSelected(file.id)
                      ? "bg-primary/10 border-primary"
                      : "bg-background border-transparent hover:shadow-lg hover:bg-secondary/30"
                  )}
                >
                  {isSelected(file.id) && (
                    <div className="absolute top-2 right-2 text-primary">
                      <Check size={16} />
                    </div>
                  )}
                  <div className="mb-3 text-4xl">
                    {file.type.includes('image') ? '🖼️' : '📄'}
                  </div>
                  <span className="text-sm font-medium text-center truncate w-full">
                    {file.filename}
                  </span>
                  <span className="text-xs text-muted-foreground mt-1">
                    {fmtSize(file.size)}
                  </span>
                </div>
              ))}
            </div>
          )}
          </div>
        </ScrollArea>
      </div>

      {/* Desktop Insight Panel */}
      {insightPanelOpen && insightFile && (
        <div className={cn(
          "hidden md:flex flex-col h-full border-l border-border/50 bg-background",
          "w-80 lg:w-96 transition-all duration-300"
        )}>
          {/* Panel Header */}
          <div className="h-[48px] flex items-center justify-between px-4 border-b border-border/50 shrink-0" style={{ paddingTop: 'max(env(safe-area-inset-top), 6px)' }}>
            <div className="flex items-center gap-2 min-w-0">
              <BrainCircuit size={16} className="text-primary shrink-0" />
              <span className="text-sm font-semibold truncate">{t.insight_panel_title || t.outline_title}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setInsightPanelOpen(false)}
            >
              <X size={16} />
            </Button>
          </div>

          {/* File Info */}
          <div className="px-4 py-3 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span className="text-lg">{insightFile.type.includes('image') ? '🖼️' : '📄'}</span>
              <span className="text-sm font-medium truncate flex-1">{insightFile.filename}</span>
            </div>
          </div>

          {/* Model Selector + Generate Button */}
          <div className="px-4 py-3 border-b border-border/50">
            <div className="flex gap-2">
              <select
                value={insightModel}
                onChange={e => setInsightModel(e.target.value)}
                className="flex-1 text-xs p-2 rounded-lg bg-secondary border-none outline-none"
              >
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={handleStreamAnalyze}
                disabled={insightAnalyzing}
              >
                {insightAnalyzing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : insightFile.summary ? (
                  <RefreshCw size={14} />
                ) : (
                  <Sparkles size={14} />
                )}
                <span className="ml-1">{insightAnalyzing ? (t.insight_generating || '分析中...') : insightFile.summary ? (t.insight_regenerate || '重新分析') : t.btn_generate}</span>
              </Button>
            </div>
          </div>

          {/* Insight Content */}
          <div className="flex-1 overflow-y-auto overscroll-y-contain p-4">
            {insightContent ? (
              <div className="text-sm">
                <MarkdownRenderer content={insightContent} />
                {insightAnalyzing && (
                  <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            ) : (
              <div className="text-center italic py-8 text-muted-foreground text-xs opacity-50">
                {t.outline_placeholder}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile Insight Sheet */}
      <Sheet open={mobileInsightOpen} onOpenChange={setMobileInsightOpen}>
        <SheetContent side="bottom" className="h-[80vh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <BrainCircuit size={16} className="text-primary" />
              {t.insight_panel_title || t.outline_title}
            </SheetTitle>
          </SheetHeader>
          {insightFile && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* File Info */}
              <div className="py-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{insightFile.type.includes('image') ? '🖼️' : '📄'}</span>
                  <span className="text-sm font-medium truncate flex-1">{insightFile.filename}</span>
                </div>
              </div>

              {/* Model Selector + Generate Button */}
              <div className="py-2">
                <div className="flex gap-2">
                  <select
                    value={insightModel}
                    onChange={e => setInsightModel(e.target.value)}
                    className="flex-1 text-xs p-2 rounded-lg bg-secondary border-none outline-none"
                  >
                    {models.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    onClick={handleStreamAnalyze}
                    disabled={insightAnalyzing}
                  >
                    {insightAnalyzing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : insightFile.summary ? (
                      <RefreshCw size={14} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    <span className="ml-1">{insightAnalyzing ? (t.insight_generating || '分析中...') : insightFile.summary ? (t.insight_regenerate || '重新分析') : t.btn_generate}</span>
                  </Button>
                </div>
              </div>

              {/* Insight Content */}
              <div className="flex-1 overflow-y-auto overscroll-y-contain py-2">
                {insightContent ? (
                  <div className="text-sm">
                    <MarkdownRenderer content={insightContent} />
                    {insightAnalyzing && (
                      <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
                    )}
                  </div>
                ) : (
                  <div className="text-center italic py-8 text-muted-foreground text-xs opacity-50">
                    {t.outline_placeholder}
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <input
        type="file"
        className="hidden"
        ref={fileInputRef}
        onChange={handleUpload}
        multiple
      />
      
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={t.delete_selected + "?"}
        description={pendingDelete?.type === 'file' ? "确定要删除这个文件吗？此操作无法撤销。" : "确定要删除这个文件夹吗？此操作无法撤销。"}
        onConfirm={confirmDelete}
        confirmText={t.ok}
        cancelText={t.cancel}
      />
    </div>
  );
};
