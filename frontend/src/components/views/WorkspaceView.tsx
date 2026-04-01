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
  Sparkles
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { api } from '@/services/api';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
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
  const [analyzingFile, setAnalyzingFile] = useState<FileItem | null>(null);
  const [outlineModel, setOutlineModel] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
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
      setOutlineModel(systemDefaults.default_outline_model || models[0]?.id);
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
    
    if (!exists && newSet.size === 1) {
      setAnalyzingFile(file);
    } else if (newSet.size !== 1) {
      setAnalyzingFile(null);
    }
  };

  const handleGenerateOutline = async () => {
    if (!analyzingFile || !outlineModel) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    setAnalyzing(true);
    try {
      const data = await api.post('/api/workspace/analyze', {
        file_id: analyzingFile.id,
        model: outlineModel,
        lang: 'zh'
      }, { signal: controller.signal } as any);

      setAnalyzingFile((prev: FileItem | null) => prev ? { ...prev, summary: data.summary } : null);
      setItems((prev: WorkspaceItems) => ({
        ...prev,
        files: prev.files.map((f: FileItem) =>
          f.id === analyzingFile.id ? { ...f, summary: data.summary } : f
        )
      }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        console.error('Analysis timed out after 60s');
      } else {
        console.error('Analysis failed:', e);
      }
    } finally {
      clearTimeout(timeoutId);
      setAnalyzing(false);
    }
  };

  const isSelected = (id: string) => Array.from(selectedFiles).some(f => f.id === id);
  const fmtSize = (s: number) => {
    if (s < 1024) return s + 'B';
    if (s < 1024 * 1024) return (s / 1024).toFixed(1) + 'KB';
    return (s / 1024 / 1024).toFixed(1) + 'MB';
  };

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

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
    <div className={cn('flex h-full relative pb-[max(4rem,calc(env(safe-area-inset-bottom)+3.5rem))] md:pb-0', isMobile ? (isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]') : 'bg-background')}>
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
          <div className="bg-secondary/50 p-1 rounded-lg flex text-xs font-medium mb-4">
            <button
              onClick={() => setSidebarTab('files')}
              className={cn(
                "flex-1 py-1.5 rounded-md transition-all",
                sidebarTab === 'files'
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.tab_files}
            </button>
            <button
              onClick={() => setSidebarTab('projects')}
              className={cn(
                "flex-1 py-1.5 rounded-md transition-all",
                sidebarTab === 'projects'
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
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

              {/* Analysis Panel */}
              {analyzingFile && (
                <GlassCard className="p-4 animate-fade-in-up">
                  <div className="flex items-center gap-2 mb-3 text-sm font-semibold">
                    <BrainCircuit size={16} className="text-primary" />
                    {t.outline_title}
                  </div>
                  <div className="flex gap-2 mb-3">
                    <select
                      value={outlineModel}
                      onChange={e => setOutlineModel(e.target.value)}
                      className="flex-1 text-xs p-2 rounded-lg bg-secondary border-none outline-none"
                    >
                      {models.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      onClick={handleGenerateOutline}
                      disabled={analyzing}
                    >
                      {analyzing ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      <span className="ml-1">{t.btn_generate}</span>
                    </Button>
                  </div>
                  <div className="max-h-[200px] overflow-y-auto overscroll-y-contain text-xs text-muted-foreground bg-secondary/50 rounded-lg p-3">
                    {analyzingFile.summary ? (
                      <div className="prose prose-sm">{analyzingFile.summary}</div>
                    ) : (
                      <div className="text-center italic py-4 opacity-50">
                        {t.outline_placeholder}
                      </div>
                    )}
                  </div>
                </GlassCard>
              )}

              {/* Start Project Button */}
              <div className="mt-4 pt-4 border-t border-border/50">
                <Button
                  onClick={() => setWorkspaceMode('chat')}
                  disabled={selectedFiles.size === 0}
                  className="w-full"
                >
                  <MessageSquarePlus size={16} className="mr-2" />
                  {t.create_project}
                </Button>
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
            <div className="h-14 flex items-center justify-between px-4 border-b border-border/50 shrink-0">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setMobileSidebarOpen(false)}
                  className="p-2 rounded-lg hover:bg-secondary/80 transition-all"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                </button>
                <span className="text-sm font-semibold">{t.workspace_title || '工作空间'}</span>
              </div>
            </div>
            {/* Mobile Sidebar Content */}
            <div className="flex-1 p-4 overflow-y-auto overscroll-y-contain">
              {/* Tabs */}
              <div className="bg-secondary/50 p-1 rounded-lg flex text-xs font-medium mb-4">
                <button
                  onClick={() => setSidebarTab('files')}
                  className={cn(
                    "flex-1 py-2 rounded-md transition-all touch-target",
                    sidebarTab === 'files'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t.tab_files}
                </button>
                <button
                  onClick={() => setSidebarTab('projects')}
                  className={cn(
                    "flex-1 py-2 rounded-md transition-all touch-target",
                    sidebarTab === 'projects'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
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
                    <Button
                      onClick={() => {
                        setWorkspaceMode('chat');
                        setMobileSidebarOpen(false);
                      }}
                      disabled={selectedFiles.size === 0}
                      className="w-full"
                    >
                      <MessageSquarePlus size={16} className="mr-2" />
                      {t.create_project}
                    </Button>
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
        <div className="h-[54px] flex items-center justify-between px-4 sm:px-6 border-b border-border/50 bg-background z-10">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-sm text-muted-foreground min-w-0 flex-1">
            {/* Mobile Sidebar Toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 md:hidden rounded-lg hover:bg-secondary/80 transition-all shrink-0"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>
            </Button>
            {/* Desktop Sidebar Toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:flex h-8 w-8 rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-all shrink-0"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setPath([])}
            >
              <Home size={16} />
            </Button>
            <div className="hidden sm:flex items-center gap-1 min-w-0">
              {path.map((p, idx) => (
                <React.Fragment key={p.id}>
                  <ChevronRight size={14} className="text-border shrink-0" />
                  <button
                    onClick={() => setPath(path.slice(0, idx + 1))}
                    className="hover:bg-secondary px-2 py-1 rounded-md transition-colors truncate"
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

            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="hidden sm:flex"
            >
              {uploading ? (
                <Loader2 size={16} className="animate-spin mr-2" />
              ) : (
                <UploadCloud size={16} className="mr-2" />
              )}
              {t.upload}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="sm:hidden shrink-0"
            >
              {uploading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <UploadCloud size={16} />
              )}
            </Button>

            <Button
              variant="default"
              size="sm"
              onClick={() => setIsCreateFolder(true)}
              className="hidden sm:flex"
            >
              <FolderPlus size={16} className="mr-2" />
              {t.new_folder}
            </Button>
            <Button
              variant="default"
              size="icon"
              onClick={() => setIsCreateFolder(true)}
              className="sm:hidden shrink-0"
            >
              <FolderPlus size={16} />
            </Button>

            <div className="hidden sm:block w-px h-4 bg-border" />

            <div className="hidden sm:flex bg-secondary/50 p-1 rounded-lg">
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
                className="bg-transparent text-lg font-semibold border-b-2 border-primary outline-none w-64"
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
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleDelete(folder.id, 'folder');
                      }}
                    >
                      <Trash2 size={14} />
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
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-primary hover:bg-primary/10"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        setAnalyzingFile(file);
                        setSidebarTab('files');
                      }}
                    >
                      <BrainCircuit size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleDelete(file.id, 'file');
                      }}
                    >
                      <Trash2 size={14} />
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
