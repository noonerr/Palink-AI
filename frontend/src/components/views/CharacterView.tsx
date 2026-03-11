import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useCharacterChat } from '@/hooks/useCharacterChat';
import { useMessageSelection } from '@/hooks/useMessageSelection';
import { 
  Bot, 
  Plus, 
  X, 
  Save, 
  UploadCloud, 
  Image,
  Play,
  User,
  Sparkles,
  Zap,
  Database,
  Check,
  CheckSquare,
  ChevronDown,
  User as UserIcon,
  BookOpen,
  Edit3,
  Trash2,
  Download,
  Upload,
  GitBranch,
  MoreHorizontal,
  Clock
} from 'lucide-react';
import { cn, replacePlaceholders } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { ErrorToast } from '@/components/ui/custom/ErrorToast';
import StorylinePanel from '@/components/ui/custom/StorylinePanel';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import { WorldBookSelector } from '@/components/ui/custom/WorldBookSelector';
import { StageIndicator } from '@/components/ui/custom/StageIndicator';
import { StageControls } from '@/components/ui/custom/StageControls';
import { WorldBookOverview } from '@/components/ui/custom/WorldBookOverview';
import { WorldBookManager } from '@/components/ui/custom/WorldBookManager';
import { useWorldBook } from '@/hooks/useWorldBook';
import { api } from '@/services/api';
import { getOCData } from '@/components/ui/custom/OCSettings';
import type { Character, Model, User as UserType, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch } from '@/types';

interface CharacterViewProps {
  token: string;
  user: UserType;
  models: Model[];
  t: Record<string, string>;
  systemDefaults?: Record<string, string>;
  lang?: 'zh' | 'en';
}

type ViewState = 'list' | 'edit' | 'chat';

interface BranchSelectorProps {
  branches: CharacterChatSessionBranch[];
  selectedBranch: CharacterChatSessionBranch | null;
  onSelect: (branch: CharacterChatSessionBranch) => void;
  onCreate: (name: string) => void;
  onDelete: (branchId: string) => void;
}

const BranchSelector: React.FC<BranchSelectorProps> = ({
  branches,
  selectedBranch,
  onSelect,
  onCreate,
  onDelete
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setIsOpen(false));

  const handleCreate = () => {
    if (newBranchName.trim()) {
      onCreate(newBranchName);
      setNewBranchName('');
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium",
          "bg-secondary hover:bg-secondary/80 transition-all",
          isOpen && "ring-2 ring-primary/20"
        )}
      >
        <GitBranch size={16} />
        <span>{selectedBranch?.branch_name || 'Main'}</span>
        <ChevronDown 
          size={14} 
          className={cn("transition-transform", isOpen && "rotate-180")} 
        />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-2 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Input
                placeholder="新分支名称"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
                className="text-sm h-8"
              />
              <Button 
                size="sm" 
                className="h-8 px-3"
                onClick={handleCreate}
                disabled={!newBranchName.trim()}
              >
                <Plus size={14} />
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {branches.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No branches / 暂无分支
              </div>
            ) : (
              branches.map((branch) => (
                <div
                  key={branch.id}
                  className={cn(
                    "flex items-center justify-between px-3 py-2.5 text-sm transition-all",
                    selectedBranch?.id === branch.id
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-muted"
                  )}
                >
                  <button
                    onClick={() => {
                      onSelect(branch);
                      setIsOpen(false);
                    }}
                    className="flex items-center gap-2 flex-1 text-left"
                  >
                    <GitBranch size={14} />
                    <div className="flex-1">
                      <div className="font-medium">{branch.branch_name}</div>
                      {branch.is_active && (
                        <div className="text-xs opacity-70">Current / 当前</div>
                      )}
                    </div>
                    {selectedBranch?.id === branch.id && <Check size={14} />}
                  </button>
                  {!branch.is_active && branches.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-50 hover:opacity-100 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(branch.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

interface DialogueModeSelectorProps {
  currentMode: 'first_person' | 'third_person';
  onSelect: (mode: 'first_person' | 'third_person') => void;
  lang?: 'zh' | 'en';
}

const DialogueModeSelector: React.FC<DialogueModeSelectorProps> = ({
  currentMode,
  onSelect,
  lang = 'zh'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setIsOpen(false));

  const modes = [
    { id: 'first_person', name: lang === 'zh' ? '第一人称' : '1st Person' },
    { id: 'third_person', name: lang === 'zh' ? '故事模式' : 'Story' }
  ];

  const getIcon = (modeId: string) => {
    if (modeId === 'first_person') {
      return <UserIcon size={16} />;
    }
    return <BookOpen size={16} />;
  };

  const currentModeObj = modes.find(m => m.id === currentMode) || modes[0];

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium",
          "bg-secondary hover:bg-secondary/80 transition-all",
          isOpen && "ring-2 ring-primary/20"
        )}
      >
        {getIcon(currentModeObj.id)}
        <span>{currentModeObj.name}</span>
        <ChevronDown 
          size={14} 
          className={cn("transition-transform", isOpen && "rotate-180")} 
        />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-44 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-1.5">
            {modes.map(mode => (
              <button
                key={mode.id}
                onClick={() => {
                  onSelect(mode.id as 'first_person' | 'third_person');
                  setIsOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all",
                  currentMode === mode.id
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                )}
              >
                <span className="text-xl">{getIcon(mode.id)}</span>
                <div className="flex-1 text-left">
                  <div className="font-medium">{mode.name}</div>
                </div>
                {currentMode === mode.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const CharacterView: React.FC<CharacterViewProps> = ({
  token: _token,
  user,
  models,
  t,
  systemDefaults,
  lang
}) => {
  const [viewState, setViewState] = useState<ViewState>('list');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [editingCharacter, setEditingCharacter] = useState<Partial<Character>>({});
  
  const getDisplayName = (character?: Character | Partial<Character> | null): string => {
    const ocData = getOCData();
    if (ocData?.name) return ocData.name;
    if (character?.user_nickname) return character.user_nickname;
    return user.username || '用户';
  };
  
  const [sessions, setSessions] = useState<CharacterChatSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<CharacterChatSession | null>(null);
  const [messages, setMessages] = useState<CharacterChatMessage[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(systemDefaults?.default_character_chat_model || models[0]?.id || '');
  const [dialogueMode, setDialogueMode] = useState<'first_person' | 'third_person'>('first_person');
  const [loading, setLoading] = useState(true);
  
  // 对话分支相关状态
  const [branches, setBranches] = useState<CharacterChatSessionBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<CharacterChatSessionBranch | null>(null);
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [showStoryline, setShowStoryline] = useState(false);
  const [branchTree, setBranchTree] = useState<BranchTree | null>(null);
  
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  
  const [memoryStats, setMemoryStats] = useState<{
    message_count: number;
    token_count: number;
    oldest_message_hours: number;
    compression_needed: boolean;
    compression_reason: string;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ type: 'single'; id: string } | { type: 'batch' } | null>(null);
  const [showDeleteCharacterConfirm, setShowDeleteCharacterConfirm] = useState(false);
  const [pendingDeleteCharacter, setPendingDeleteCharacter] = useState<string | null>(null);
  const [showDeleteBranchConfirm, setShowDeleteBranchConfirm] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [initializingChat, setInitializingChat] = useState(false);
  const [showImportOptions, setShowImportOptions] = useState<string | null>(null);
  const [processingCharacter, setProcessingCharacter] = useState<string | null>(null);
  const [forceShowOverlay, setForceShowOverlay] = useState<string | null>(null);
  const [showProcessingMessage, setShowProcessingMessage] = useState<{ show: boolean; message: string }>({ show: false, message: '' });
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [showModelReasoning, setShowModelReasoning] = useState(false);
  const [showWorldBookManager, setShowWorldBookManager] = useState(false);
  const [showWorldBookOverview, setShowWorldBookOverview] = useState(false);
  const [selectedWorldBookId, setSelectedWorldBookId] = useState<string | null>(null);
  
  // World Book hook
  const wb = useWorldBook();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadingSessionRef = useRef<string | null>(null);

  // Forward-declare loadSessions and loadMemoryStats for hooks
  const loadSessions = useCallback(async (characterId: string) => {
    try {
      const data = await api.get(`/api/characters/${characterId}/sessions`);
      setSessions(data);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }, []);

  const autoCompressMemory = async (sessionId: string) => {
    if (loadingSessionRef.current !== sessionId) return;
    try {
      const data = await api.get(`/api/memory/check-auto-compress?session_id=${sessionId}`);
      if (loadingSessionRef.current === sessionId && data.auto_compressed) {
        console.log('Memory auto-compressed:', data.message);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.error('Auto compress failed:', e);
      }
    }
  };

  const loadMemoryStats = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    loadingSessionRef.current = sessionId;
    try {
      const data = await api.get(`/api/memory/stats?session_id=${sessionId}`);
      if (loadingSessionRef.current === sessionId) {
        setMemoryStats(data);
        if (data.compression_needed) {
          await autoCompressMemory(sessionId);
        }
      }
    } catch (e) {
      console.error('Failed to load memory stats:', e);
    }
  }, []);

  // ── Chat hook ──────────────────────────────────────────
  const {
    isGenerating,
    inputValue,
    setInputValue,
    attachments,
    setAttachments,
    uploading,
    suggestions,
    setSuggestions,
    regeneratingMessageIndex,
    currentError,
    retryMessageContent,
    timeoutWarning,
    handleSendMessage,
    handleSendWithInput,
    handleRegenerate,
    handleRetry,
    handleCloseError,
    handleUpload,
    handleDeleteMessage,
    handleEditMessage,
    abortControllerRef,
    cleanupTimeout,
  } = useCharacterChat({
    selectedCharacter,
    selectedSession,
    selectedModel,
    dialogueMode,
    selectedBranch,
    getDisplayName,
    messages,
    setMessages,
    setSelectedSession,
    loadSessions,
    loadMemoryStats,
  });

  // ── Message selection hook ─────────────────────────────
  const {
    isMixedDeleteMode,
    setIsMixedDeleteMode,
    selectedWholeMessages,
    selectedMessageParts,
    showDeleteMixedConfirm,
    setShowDeleteMixedConfirm,
    toggleWholeMessageSelect,
    toggleMessagePartSelect,
    selectAllPartsInMessage,
    handleMixedDelete,
    confirmDeleteMixed,
    clearSelection,
  } = useMessageSelection({
    messages,
    handleDeleteMessage,
    handleEditMessage,
  });

  useEffect(() => {
    loadCharacters();
    fetchUserSettings();
    wb.loadWorldBooks();
    
    // 监听用户设置更新事件
    const handleSettingsUpdate = (e: any) => {
      if (e.detail?.showModelReasoning !== undefined) {
        setShowModelReasoning(e.detail.showModelReasoning);
      }
    };
    window.addEventListener('userSettingsUpdated', handleSettingsUpdate);
    return () => window.removeEventListener('userSettingsUpdated', handleSettingsUpdate);
  }, []);

  useEffect(() => {
    const newDefaultModel = systemDefaults?.default_character_chat_model || models[0]?.id || '';
    setSelectedModel(newDefaultModel);
  }, [systemDefaults, models]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => cleanupTimeout();
  }, [cleanupTimeout]);

  const fetchUserSettings = async () => {
    try {
      const settings = await api.get('/api/users/me/settings');
      setShowModelReasoning(settings.show_model_reasoning || false);
    } catch (e) {
      console.error('Failed to fetch user settings:', e);
    }
  };

  const loadCharacters = async () => {
    try {
      const data = await api.get('/api/characters');
      setCharacters(data);
      
      const processingChar = data.find((c: any) => c.is_processing);
      if (processingChar) {
        if (!processingCharacter) {
          setProcessingCharacter(processingChar.id);
          pollCharacterStatus(processingChar.id);
        }
      }
      // 不要在这里清除 processingCharacter，让轮询函数自己处理
    } catch (e) {
      console.error('Failed to load characters:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadBranches = useCallback(async (sessionId: string) => {
    try {
      const data = await api.get(`/api/character-sessions/${sessionId}/branches`);
      setBranches(data);
      const active = data.find((b: CharacterChatSessionBranch) => b.is_active);
      if (active) {
        setSelectedBranch(active);
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    }
  }, []);

  const createBranch = async (branchName: string) => {
    if (!selectedSession || !branchName.trim()) return;
    try {
      await api.post(`/api/character-sessions/${selectedSession.id}/branches`, {
        session_id: selectedSession.id,
        branch_name: branchName,
        parent_message_id: messages.length > 0 ? messages[messages.length - 1].id : null
      });
      await loadBranches(selectedSession.id);
      setNewBranchName('');
      setShowBranchSelector(false);
    } catch (e) {
      console.error('Failed to create branch:', e);
    }
  };

  const switchBranch = async (branch: CharacterChatSessionBranch) => {
    if (!selectedSession) return;
    try {
      const data = await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branch.id}/switch`);
      setSelectedBranch(branch);
      setMessages(data.messages || []);
      await loadBranches(selectedSession.id);
    } catch (e) {
      console.error('Failed to switch branch:', e);
    }
  };

  const deleteBranch = (branchId: string) => {
    if (!selectedSession) return;
    setPendingDeleteBranch(branchId);
    setShowDeleteBranchConfirm(true);
  };

  const confirmDeleteBranch = async () => {
    if (!pendingDeleteBranch || !selectedSession) return;
    try {
      await api.delete(`/api/character-sessions/${selectedSession.id}/branches/${pendingDeleteBranch}`);
      await loadBranches(selectedSession.id);
      if (selectedBranch?.id === pendingDeleteBranch) {
        setSelectedBranch(null);
      }
    } catch (e) {
      console.error('Failed to delete branch:', e);
    } finally {
      setShowDeleteBranchConfirm(false);
      setPendingDeleteBranch(null);
    }
  };

  const fetchBranchTree = useCallback(async () => {
    if (!selectedSession) return;
    try {
      const data = await api.get(`/api/character-sessions/${selectedSession.id}/branch-tree`);
      setBranchTree(data);
      setShowStoryline(true);
    } catch (e) {
      console.error('Failed to fetch branch tree:', e);
    }
  }, [selectedSession]);

  const handleStorylineNavigate = useCallback(async (branchId: string, _messageId: number | null, _isLeaf: boolean) => {
    if (!selectedSession) return;
    try {
      await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branchId}/switch`);
      const data = await api.get(`/api/character-sessions/${selectedSession.id}/messages`);
      setMessages(data);
      await loadBranches(selectedSession.id);
    } catch (e) {
      console.error('Failed to navigate storyline:', e);
    }
  }, [selectedSession, loadBranches]);

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const data = await api.get(`/api/character-sessions/${sessionId}/messages`);
      setMessages(data);
      setSuggestions([]);
      
      await loadMemoryStats(sessionId);
      await loadBranches(sessionId);
      
      // 角色扮演禁用推荐对话功能（节省 tokens）
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, [selectedModel, loadMemoryStats, loadBranches]);

  const manualCompressMemory = async () => {
    if (!selectedSession?.id || compressing) return;
    setCompressing(true);
    try {
      const data = await api.post('/api/memory/compress', {
        session_id: selectedSession.id,
        compression_ratio: 0.5
      });
      alert(`记忆压缩完成！\n删除: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
      await loadMemoryStats(selectedSession.id);
    } catch (e: any) {
      console.error('Manual compress failed:', e);
      alert('压缩失败: ' + (e.message || ''));
    } finally {
      setCompressing(false);
    }
  };

  const handleCreateCharacter = () => {
    setEditingCharacter({
      name: '',
      description: '',
      background: '',
      personality: '',
      avatar: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
      user_nickname: ''
    });
    setViewState('edit');
  };

  const handleEditCharacter = (character: Character) => {
    setEditingCharacter({ ...character });
    setSelectedCharacter(character);
    setViewState('edit');
  };

  const handleSaveCharacter = async () => {
    try {
      const url = selectedCharacter 
        ? `/api/characters/${selectedCharacter.id}`
        : '/api/characters';
      
      if (selectedCharacter) {
        await api.put(url, editingCharacter);
      } else {
        await api.post(url, editingCharacter);
      }
      
      await loadCharacters();
      setViewState('list');
      setEditingCharacter({});
      setSelectedCharacter(null);
    } catch (e) {
      console.error('Failed to save character:', e);
    }
  };

  const handleDeleteCharacter = (characterId: string) => {
    setPendingDeleteCharacter(characterId);
    setShowDeleteCharacterConfirm(true);
  };

  const confirmDeleteCharacter = async () => {
    if (!pendingDeleteCharacter) return;
    try {
      await api.delete(`/api/characters/${pendingDeleteCharacter}`);
      await loadCharacters();
    } catch (e: any) {
      console.error('Failed to delete character:', e);
      alert('删除失败: ' + (e.message || ''));
    } finally {
      setShowDeleteCharacterConfirm(false);
      setPendingDeleteCharacter(null);
    }
  };

  const handleImportCharacter = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const result = await api.post('/api/characters/import', formData);
      await loadCharacters();
      setShowImportOptions(result.character.id);
    } catch (e: any) {
      console.error('Failed to import character:', e);
      alert('导入失败: ' + (e.message || ''));
    }
  };

  const handleParseCharacter = async (characterId: string) => {
    try {
      setProcessingCharacter(characterId);
      setForceShowOverlay(characterId);
      setShowImportOptions(null);
      await api.post('/api/characters/parse', { character_id: characterId, model: selectedModel });
      
      setShowProcessingMessage({ show: true, message: '已经开始解析，请稍候...' });
      pollCharacterStatus(characterId);
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    } catch (e: any) {
      console.error('Failed to parse character:', e);
      setShowProcessingMessage({ show: true, message: '解析失败: ' + (e.message || '') });
      setProcessingCharacter(null);
      setForceShowOverlay(null);
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    }
  };

  const handleTranslateCharacter = async (characterId: string) => {
    try {
      setProcessingCharacter(characterId);
      setForceShowOverlay(characterId);
      setShowImportOptions(null);
      await api.post('/api/characters/translate', { character_id: characterId, target_language: 'zh', model: selectedModel });
      
      setShowProcessingMessage({ show: true, message: '已经开始翻译，请稍候...' });
      pollCharacterStatus(characterId);
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    } catch (e: any) {
      console.error('Failed to translate character:', e);
      setShowProcessingMessage({ show: true, message: '翻译失败: ' + (e.message || '') });
      setProcessingCharacter(null);
      setForceShowOverlay(null);
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    }
  };

  const stopPolling = () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
    setProcessingCharacter(null);
    setForceShowOverlay(null);
  };

  const handleStopProcessing = async (characterId: string) => {
    try {
      await api.post(`/api/characters/${characterId}/reset-status`);
      stopPolling();
      await loadCharacters();
      setShowProcessingMessage({ show: true, message: '已停止处理' });
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    } catch (e) {
      console.error('Failed to stop processing:', e);
    }
  };

  const pollCharacterStatus = async (characterId: string) => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    const interval = setInterval(async () => {
      try {
        const status = await api.get(`/api/characters/${characterId}/status`);
          
        if (!status.is_processing) {
          if (pollingInterval) {
            clearInterval(pollingInterval);
            setPollingInterval(null);
          }
          setProcessingCharacter(null);
          setForceShowOverlay(null);
          await loadCharacters();
          if (selectedCharacter?.id === characterId) {
            try {
              const charData = await api.get(`/api/characters/${characterId}`);
              setSelectedCharacter(charData);
            } catch { /* ignore */ }
          }
            
          if (status.processing_status?.includes('完成')) {
            setShowProcessingMessage({ show: true, message: '角色卡处理完成！' });
            setTimeout(() => {
              setShowProcessingMessage({ show: false, message: '' });
            }, 3000);
          } else if (status.processing_status?.includes('失败')) {
            setShowProcessingMessage({ show: true, message: `角色卡处理失败：${status.processing_status}` });
            setTimeout(() => {
              setShowProcessingMessage({ show: false, message: '' });
            }, 3000);
          }
        }
      } catch (e) {
        console.error('Failed to poll status:', e);
      }
    }, 2000);
    
    setPollingInterval(interval);
  };

  const handleExportCharacter = async (character: Character, format: 'png' | 'json' = 'png') => {
    try {
      const res = await api.raw(`/api/characters/${character.id}/export?format=${format}`);
      
      if (res.ok) {
        if (format === 'json') {
          const data = await res.json();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${character.name}.json`;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${character.name}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }
      } else {
        const error = await res.text();
        alert('导出失败: ' + error);
      }
    } catch (e) {
      console.error('Failed to export character:', e);
      alert('导出失败');
    }
  };

  const handleStartChat = async (character: Character) => {
    setSelectedCharacter(character);
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setSuggestions([]);
    await loadSessions(character.id);
    setViewState('chat');
  };

  const handleInitiateConversation = async (initialMessage?: string) => {
    if (!selectedCharacter) return;
    
    setInitializingChat(true);
    
    try {
      // 如果没有现有会话，并且角色有第一条消息，创建一个新会话来初始化
      if (sessions.length === 0 && selectedCharacter.first_mes && selectedCharacter.first_mes.trim()) {
        const data = await api.post('/api/character-chat', {
          character_id: selectedCharacter.id,
          message: '__INIT__',
          model: selectedModel,
          temperature: 0.7,
          dialogue_mode: dialogueMode,
          user_nickname: getDisplayName(selectedCharacter)
        });
        
        await loadSessions(selectedCharacter.id);
        if (data.session_id) {
          const newSession = {
            id: data.session_id,
            title: selectedCharacter.name,
            character_id: selectedCharacter.id,
            user_id: user.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            dialogue_mode: dialogueMode
          };
          setSelectedSession(newSession as any);
          await loadMessages(data.session_id);
          // Associate world book if selected
          if (selectedWorldBookId) {
            try {
              await wb.associateSession(data.session_id, selectedWorldBookId);
              await wb.loadSessionStatus(data.session_id);
            } catch (err) {
              console.error('Failed to associate world book:', err);
            }
          }
        }
      } else if (initialMessage) {
        // 如果用户提供了初始消息，直接发送
        await handleSendMessage(initialMessage, []);
      }
    } catch (e) {
      console.error('Failed to initialize chat:', e);
    } finally {
      setInitializingChat(false);
    }
  };

  const handleSelectSession = async (session: CharacterChatSession) => {
    setSelectedSession(session);
    setMemoryStats(null);
    await loadMessages(session.id);
    await loadMemoryStats(session.id);
    // Load world book status for this session
    try {
      await wb.loadSessionStatus(session.id);
    } catch {
      // Session may not have a world book associated
    }
  };

  const handleNewSession = () => {
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setSuggestions([]);
  };

  const handleDeleteSession = (sessionId: string) => {
    setPendingDelete({ type: 'single', id: sessionId });
    setShowDeleteConfirm(true);
  };

  const toggleSessionSelect = (sessionId: string) => {
    const newSet = new Set(selectedSessions);
    if (newSet.has(sessionId)) {
      newSet.delete(sessionId);
    } else {
      newSet.add(sessionId);
    }
    setSelectedSessions(newSet);
  };

  const handleBatchDelete = () => {
    if (selectedSessions.size === 0) return;
    setPendingDelete({ type: 'batch' });
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;

    try {
      if (pendingDelete.type === 'batch') {
        for (const sessionId of Array.from(selectedSessions)) {
          await api.delete(`/api/character-sessions/${sessionId}`);
        }
        
        setSelectedSessions(new Set());
        setIsDeleteMode(false);
        await loadSessions(selectedCharacter!.id);
        
        if (selectedSession && selectedSessions.has(selectedSession.id)) {
          setSelectedSession(null);
          setMessages([]);
          setMemoryStats(null);
        }
      } else if (pendingDelete.type === 'single') {
        await api.delete(`/api/character-sessions/${pendingDelete.id}`);
        await loadSessions(selectedCharacter!.id);
        if (selectedSession?.id === pendingDelete.id) {
          setSelectedSession(null);
          setMessages([]);
          setMemoryStats(null);
        }
      }
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setPendingDelete(null);
      setShowDeleteConfirm(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setEditingCharacter(prev => ({ ...prev, avatar: e.target?.result as string }));
      };
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin text-primary">
          <Bot size={32} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full h-full">
      {viewState === 'list' && (
        <div className="flex-1 flex flex-col w-full h-full">
          <div className="h-[54px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0">
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
                      handleImportCharacter(file);
                      e.target.value = '';
                    }
                  }}
                />
              </div>
              <Button onClick={handleCreateCharacter}>
                <Plus size={18} className="mr-2" />
                创建角色
              </Button>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto w-full max-h-full">
            <div className="w-full px-6 py-6">
              {characters.length === 0 && (
                <div className="text-center py-20">
                  <div className="w-24 h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20">
                    <Bot size={48} />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">暂无角色</h3>
                  <p className="text-sm text-muted-foreground mb-6">创建您的第一个角色开始角色扮演吧！</p>
                  <Button onClick={handleCreateCharacter}>
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
                      onClick={() => handleStartChat(character)}
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
                                  handleStopProcessing(character.id); 
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
                              onClick={(e) => { e.stopPropagation(); handleStartChat(character); }}
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
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  handleParseCharacter(character.id); 
                                }}
                                disabled={character.is_processing || processingCharacter === character.id}
                                title="AI解析角色卡"
                              >
                                <Sparkles size={12} />
                              </Button>
                              <Button 
                                variant="secondary" 
                                size="sm" 
                                className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  handleTranslateCharacter(character.id); 
                                }}
                                disabled={character.is_processing || processingCharacter === character.id}
                                title="AI翻译角色卡"
                              >
                                <Zap size={12} />
                              </Button>
                              <Button 
                                variant="secondary" 
                                size="sm" 
                                className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  handleExportCharacter(character, 'png'); 
                                }}
                                title="导出为PNG"
                                disabled={character.is_processing || processingCharacter === character.id}
                              >
                                <Download size={12} />
                              </Button>
                              <Button 
                                variant="secondary" 
                                size="sm" 
                                className="h-7 w-7 sm:h-8 sm:w-8 p-0"
                                onClick={(e) => { e.stopPropagation(); handleEditCharacter(character); }}
                                disabled={character.is_processing || processingCharacter === character.id}
                              >
                                <Edit3 size={12} />
                              </Button>
                              <Button 
                                variant="secondary" 
                                size="sm" 
                                className="h-7 w-7 sm:h-8 sm:w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                                onClick={(e) => { e.stopPropagation(); handleDeleteCharacter(character.id); }}
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
            onOpenChange={setShowDeleteCharacterConfirm}
            title="删除这个角色？"
            description="确定要删除这个角色吗？此操作无法撤销。"
            onConfirm={confirmDeleteCharacter}
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
                      handleParseCharacter(showImportOptions);
                      setShowImportOptions(null);
                    }}
                    disabled={processingCharacter !== null}
                  >
                    <Sparkles size={16} className="mr-2" />
                    仅AI解析
                  </Button>
                  <Button 
                    onClick={() => {
                      handleTranslateCharacter(showImportOptions);
                      setShowImportOptions(null);
                    }}
                    disabled={processingCharacter !== null}
                  >
                    <Zap size={16} className="mr-2" />
                    仅AI翻译
                  </Button>
                  <Button 
                    onClick={async () => {
                      setShowImportOptions(null);
                      await handleParseCharacter(showImportOptions);
                      await handleTranslateCharacter(showImportOptions);
                    }}
                    disabled={processingCharacter !== null}
                    variant="default"
                  >
                    解析并翻译
                  </Button>
                  <Button 
                    variant="secondary"
                    onClick={() => setShowImportOptions(null)}
                  >
                    跳过
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {viewState === 'edit' && (
        <div className="flex-1 flex flex-col w-full h-full overflow-hidden">
          <div className="h-[54px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0">
            <h1 className="text-base font-semibold text-foreground truncate">
              {selectedCharacter ? '编辑角色' : '创建角色'}
            </h1>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => {
                setViewState('list');
                setEditingCharacter({});
                setSelectedCharacter(null);
              }}>
                <X size={18} className="mr-2" />
                返回
              </Button>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="max-w-4xl mx-auto w-full pb-6">
              <div className="p-8 glass-strong rounded-2xl space-y-8">
                <div className="flex items-start gap-8">
                  <div className="relative">
                    <div className="w-32 h-32 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center text-5xl shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                      {editingCharacter.avatar ? (
                        <img src={editingCharacter.avatar} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span>{editingCharacter.name?.[0]?.toUpperCase() || '?'}</span>
                      )}
                    </div>
                    <label className="absolute bottom-0 right-0 p-2.5 bg-primary rounded-full cursor-pointer hover:bg-primary/90 transition-colors shadow-lg shadow-primary/25">
                      <Image size={18} className="text-primary-foreground" />
                      <input 
                        type="file" 
                        accept="image/*" 
                        className="hidden" 
                        onChange={handleImageUpload}
                      />
                    </label>
                  </div>
                  
                  <div className="flex-1 space-y-4">
                    <div>
                      <label className="text-sm font-semibold mb-2 block">角色名称</label>
                      <Input 
                        placeholder="输入角色名称" 
                        value={editingCharacter.name || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, name: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-semibold mb-2 block">创建者</label>
                      <Input 
                        placeholder="角色创建者名称" 
                        value={editingCharacter.creator || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, creator: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-semibold mb-2 block">标签</label>
                      <Input 
                        placeholder="用逗号分隔多个标签" 
                        value={editingCharacter.tags?.join(', ') || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, tags: e.target.value.split(',').map(t => t.trim()).filter(t => t) }))}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-semibold mb-2 block">用户称呼</label>
                      <Input 
                        placeholder="角色对你的称呼（留空则使用默认昵称）" 
                        value={editingCharacter.user_nickname || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, user_nickname: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-6">
                    <div>
                      <label className="text-sm font-semibold mb-2 block">角色描述</label>
                      <Textarea 
                        placeholder="描述这个角色的外貌、特点等基本信息" 
                        value={editingCharacter.description || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, description: e.target.value }))}
                        className="h-32"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-semibold mb-2 block">性格特点</label>
                      <Textarea 
                        placeholder="描述这个角色的性格特点" 
                        value={editingCharacter.personality || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, personality: e.target.value }))}
                        className="h-32"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-semibold mb-2 block">场景</label>
                      <Textarea 
                        placeholder="角色所处的场景或环境" 
                        value={editingCharacter.scenario || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, scenario: e.target.value }))}
                        className="h-32"
                      />
                    </div>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <label className="text-sm font-semibold mb-2 block">背景故事</label>
                      <Textarea 
                        placeholder="讲述这个角色的背景故事" 
                        value={editingCharacter.background || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, background: e.target.value }))}
                        className="h-32"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-semibold mb-2 block">第一条消息</label>
                      <Textarea 
                        placeholder="角色的第一条消息，设定对话风格" 
                        value={editingCharacter.first_mes || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, first_mes: e.target.value }))}
                        className="h-32"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-semibold mb-2 block">系统提示</label>
                      <Textarea 
                        placeholder="自定义系统提示词" 
                        value={editingCharacter.system_prompt || ''}
                        onChange={(e) => setEditingCharacter(prev => ({ ...prev, system_prompt: e.target.value }))}
                        className="h-32"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-semibold mb-2 block">对话示例</label>
                  <Textarea 
                    placeholder="使用 &lt;START&gt; 标记分隔不同示例对话，使用 {{char}} 和 {{user}} 作为占位符" 
                    value={editingCharacter.mes_example || ''}
                    onChange={(e) => setEditingCharacter(prev => ({ ...prev, mes_example: e.target.value }))}
                    className="h-48"
                  />
                </div>

                <div className="flex justify-end gap-4 pt-6 border-t border-border/50">
                  <Button variant="secondary" onClick={() => {
                    setViewState('list');
                    setEditingCharacter({});
                    setSelectedCharacter(null);
                  }}>
                    取消
                  </Button>
                  <Button onClick={handleSaveCharacter}>
                    <Save size={18} className="mr-2" />
                    保存
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {viewState === 'chat' && selectedCharacter && (
        <div className="flex w-full h-full overflow-hidden">
          {/* Mobile Sidebar Overlay */}
          {mobileSidebarOpen && (
            <div 
              className="fixed inset-0 z-[59] md:hidden animate-fade-in"
              onClick={() => setMobileSidebarOpen(false)}
            >
              <div className="absolute inset-0 bg-black/40" />
              <div 
                className="absolute left-0 top-0 bottom-0 w-[85%] max-w-[320px] bg-background shadow-2xl animate-slide-in-left flex flex-col z-[60]"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="h-14 flex items-center justify-between px-4 border-b border-border/50 shrink-0">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setMobileSidebarOpen(false)}
                      className="p-2 rounded-lg hover:bg-secondary/80 transition-all"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                    </button>
                    <span className="text-sm font-semibold">{t.chat_history || '聊天记录'}</span>
                  </div>
                </div>
                <ChatSessionList
                  sessions={sessions}
                  activeSessionId={selectedSession?.id || null}
                  onSessionSelect={async (session) => {
                    setSelectedSession(session);
                    setMessages([]);
                    if (session?.id) {
                      await loadMessages(session.id);
                    }
                    setMobileSidebarOpen(false);
                  }}
                  isDeleteMode={isDeleteMode}
                  setIsDeleteMode={setIsDeleteMode}
                  selectedSessions={selectedSessions}
                  toggleSessionSelect={toggleSessionSelect}
                  onDeleteSession={handleDeleteSession}
                  showDeleteButton={false}
                  showHeaderActions={false}
                  headerTitle="历史对话"
                />
              </div>
            </div>
          )}

          <div className={`transition-all duration-300 ease-in-out hidden md:flex ${!sidebarCollapsed ? 'w-64 opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
            <div className="w-64 h-full flex-shrink-0 border-r border-border/50 glass flex flex-col">
              <div className="h-[54px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center text-lg shadow-lg shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                    {selectedCharacter.avatar ? (
                      <img src={selectedCharacter.avatar} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <svg 
                        xmlns="http://www.w3.org/2000/svg" 
                        viewBox="0 0 24 24" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="1"
                        className="w-full h-full text-gray-400 dark:text-gray-500"
                      >
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
                      </svg>
                    )}
                  </div>
                  <span className="text-base font-semibold text-foreground truncate">
                    {selectedCharacter.name}
                  </span>
                </div>
                <div className="flex gap-1">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-8 w-8"
                    onClick={handleBatchDelete}
                    title="删除对话"
                  >
                    <Trash2 size={16} />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-8 w-8"
                    onClick={() => setViewState('list')}
                  >
                    <X size={16} />
                  </Button>
                </div>
              </div>
              
              <ChatSessionList
                sessions={sessions}
                activeSessionId={selectedSession?.id || null}
                onSessionSelect={handleSelectSession}
                isDeleteMode={isDeleteMode}
                setIsDeleteMode={setIsDeleteMode}
                selectedSessions={selectedSessions}
                toggleSessionSelect={toggleSessionSelect}
                onBatchDelete={handleBatchDelete}
                onNewSession={handleNewSession}
                onDeleteSession={handleDeleteSession}
                showNewButton={true}
                showDeleteButton={false}
                showHeaderActions={false}
                headerTitle="历史对话"
              />
            </div>
          </div>

          <div className="flex-1 flex flex-col h-full overflow-hidden pb-[max(4rem,calc(env(safe-area-inset-bottom)+3.5rem))] md:pb-0">
            <div className="h-[54px] flex items-center justify-between px-4 md:px-6 border-b border-border/50 glass z-10 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 md:hidden rounded-lg hover:bg-secondary/80 transition-all"
                  onClick={() => setMobileSidebarOpen(true)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>
                </Button>
                <Button
                  variant="default"
                  size="icon"
                  className="h-8 w-8 rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-all hidden md:flex"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                >
                  {!sidebarCollapsed ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-chevron-left"><path d="m15 18-6-6 6-6"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-chevron-right"><path d="m9 18 6-6-6-6"/></svg>
                  )}
                </Button>
                <ModelSelector 
                  models={models} 
                  currentModel={selectedModel} 
                  onSelect={setSelectedModel}
                />
                {selectedSession && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={fetchBranchTree}
                    title="故事线"
                  >
                    <GitBranch size={14} />
                    <span className="hidden sm:inline">故事线</span>
                  </Button>
                )}
                {selectedSession && wb.sessionStatus?.active && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => setShowWorldBookOverview(true)}
                      title="世界书阶段"
                    >
                      <BookOpen size={14} />
                      <span className="hidden sm:inline">
                        阶段 {(wb.sessionStatus.current_stage_index ?? 0) + 1}/{wb.sessionStatus.total_stages ?? '?'}
                      </span>
                    </Button>
                    <StageControls
                      status={wb.sessionStatus}
                      onPrev={async () => {
                        if (selectedSession) {
                          await wb.prevStage(selectedSession.id);
                          await wb.loadSessionStatus(selectedSession.id);
                        }
                      }}
                      onNext={async () => {
                        if (selectedSession) {
                          await wb.nextStage(selectedSession.id);
                          await wb.loadSessionStatus(selectedSession.id);
                        }
                      }}
                      onJump={async (index) => {
                        if (selectedSession) {
                          await wb.jumpToStage(selectedSession.id, index);
                          await wb.loadSessionStatus(selectedSession.id);
                        }
                      }}
                    />
                  </>
                )}
              </div>
              
              <DialogueModeSelector 
                currentMode={dialogueMode} 
                onSelect={setDialogueMode}
                lang={lang}
              />
              {selectedSession && (
                <div className="flex items-center gap-1 ml-2">
                  <Button
                    variant={(selectedWholeMessages.size > 0 || selectedMessageParts.size > 0) ? "destructive" : (isMixedDeleteMode ? "default" : "secondary")}
                    size="icon"
                    onClick={async () => {
                      if (isMixedDeleteMode && (selectedWholeMessages.size > 0 || selectedMessageParts.size > 0)) {
                        await handleMixedDelete();
                      } else {
                        setIsMixedDeleteMode(!isMixedDeleteMode);
                        if (isMixedDeleteMode) {
                          clearSelection();
                        }
                      }
                    }}
                    title={(selectedWholeMessages.size > 0 || selectedMessageParts.size > 0) ? "删除选中" : (isMixedDeleteMode ? "取消选择模式" : "选择删除")}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              )}



            </div>

            {messages.length === 0 && !selectedSession && !initializingChat && (
              <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
                <div className="w-full max-w-2xl flex flex-col items-center animate-fade-in-up">
                  <div className="mb-10 text-center">
                    <div className="w-24 h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                      {selectedCharacter.avatar ? (
                        <img src={selectedCharacter.avatar} alt="" className="w-full h-full object-cover" />
                      ) : (
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
                      )}
                    </div>
                    <h1 className="text-3xl font-semibold mb-2">
                      {selectedCharacter.name}
                    </h1>
                    <p className="text-muted-foreground">
                      开始与这个角色对话吧！
                    </p>
                  </div>

                  {/* World Book Selector */}
                  <div className="w-full max-w-md mb-6">
                    <WorldBookSelector
                      worldBooks={wb.worldBooks}
                      selectedId={selectedWorldBookId}
                      onSelect={setSelectedWorldBookId}
                      loading={wb.loading}
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setShowWorldBookManager(true)}
                    >
                      <BookOpen size={14} />
                      管理世界书
                    </Button>
                  </div>
                  <div className="mt-4">
                  <Button 
                    size="lg"
                    className="text-base h-12 px-8"
                    onClick={() => handleInitiateConversation()}
                    disabled={initializingChat}
                  >
                    {initializingChat ? (
                      <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                    ) : (
                      <Play size={20} className="mr-2" />
                    )}
                    开始对话
                  </Button>
                  </div>
                </div>
              </div>
            )}
            
            {initializingChat && (
              <div className="flex-1 flex items-center justify-center p-8 w-full overflow-y-auto">
                <div className="w-full flex flex-col items-center animate-fade-in-up">
                  <div className="animate-spin text-primary mb-4">
                    <Bot size={32} />
                  </div>
                  <p className="text-muted-foreground">正在加载对话...</p>
                </div>
              </div>
            )}

            {(messages.length > 0 || selectedSession) && (
              <div className="flex-1 overflow-y-auto">
                {/* World Book Stage Indicator */}
                {wb.sessionStatus?.active && (
                  <StageIndicator
                    status={wb.sessionStatus}
                    onStageClick={() => setShowWorldBookOverview(true)}
                  />
                )}
                <div className="px-6 py-6">
                  <div className="w-full space-y-6">
                    {messages.map((msg, idx) => (
                      <div key={msg.id || idx} className="flex items-start gap-2">
                        <div className="flex-1">
                          <Message
                            message={msg}
                            userAvatar={msg.role === 'assistant' ? selectedCharacter.avatar : user.avatar}
                            userName={msg.role === 'assistant' ? selectedCharacter.name : user.username}
                            models={models}
                            streaming={(isGenerating && idx === messages.length - 1) || regeneratingMessageIndex === idx}
                            isLast={idx === messages.length - 1}
                            t={t}
                            tokens={msg.tokens}
                            memoryStats={idx === messages.length - 1 && msg.role === 'assistant' ? memoryStats : null}
                            onCompress={idx === messages.length - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                            compressing={compressing}
                            onRegenerate={msg.role === 'assistant' && !isGenerating ? () => handleRegenerate(idx) : undefined}
                            canRegenerate={msg.role === 'assistant' && !isGenerating && idx > 0 && messages[idx - 1]?.role === 'user'}
                            showModelReasoning={showModelReasoning}
                            onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id as number, idx, newContent) : undefined}
                            canEdit={msg.role === 'assistant' && !isGenerating}
                            isMixedDeleteMode={isMixedDeleteMode}
                            messageIndex={idx}
                            selectedWholeMessages={selectedWholeMessages}
                            selectedMessageParts={selectedMessageParts}
                            onToggleWholeMessageSelect={toggleWholeMessageSelect}
                            onToggleMessagePartSelect={toggleMessagePartSelect}
                            onSelectAllPartsInMessage={selectAllPartsInMessage}
                          />
                        </div>
                      </div>
                    ))}
                    
                    {suggestions.length > 0 && !isGenerating && (
                      <div className="flex flex-wrap gap-2 pl-12 animate-fade-in-up">
                        {suggestions.map((s, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleSendMessage(s, [])}
                            className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-full text-xs font-medium transition-colors"
                          >
                            <Sparkles size={10} className="inline mr-1" />
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                    
                    <div ref={messagesEndRef} />
                  </div>
                </div>
              </div>
            )}



            <div className="p-4 pb-0 md:pb-4 border-t border-border/50 flex-shrink-0">
              <div className="w-full">
                <ChatInput
                  value={inputValue}
                  onChange={setInputValue}
                  onSend={handleSendWithInput}
                  onUpload={handleUpload}
                  attachments={attachments}
                  onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                  models={models}
                  currentModel={selectedModel}
                  onModelChange={setSelectedModel}
                  disabled={isGenerating}
                  uploading={uploading}
                  placeholder={`与 ${selectedCharacter.name} 对话...`}
                  streaming={isGenerating}
                  onStop={() => abortControllerRef.current?.abort()}
                />
              </div>
            </div>
          </div>
          <ConfirmDialog
            open={showDeleteConfirm}
            onOpenChange={setShowDeleteConfirm}
            title={pendingDelete?.type === 'batch' ? '删除选中的对话？' : '删除这个对话？'}
            description={pendingDelete?.type === 'batch' 
              ? `确定要删除选中的 ${selectedSessions.size} 个对话吗？此操作无法撤销。`
              : "确定要删除这个对话吗？此操作无法撤销。"}
            onConfirm={confirmDelete}
            confirmText="确定"
            cancelText="取消"
          />
          <ConfirmDialog
            open={showDeleteBranchConfirm}
            onOpenChange={setShowDeleteBranchConfirm}
            title="删除这个分支？"
            description="确定要删除这个分支吗？此操作无法撤销。"
            onConfirm={confirmDeleteBranch}
            confirmText="确定"
            cancelText="取消"
          />
          <ConfirmDialog
            open={showDeleteMixedConfirm}
            onOpenChange={setShowDeleteMixedConfirm}
            title="删除选中的内容？"
            description="确定要删除选中的内容吗？此操作无法撤销。"
            onConfirm={confirmDeleteMixed}
            confirmText="确定"
            cancelText="取消"
          />

          {/* Error Toast Component */}
          {currentError && (
            <ErrorToast
              errorInfo={currentError}
              onClose={handleCloseError}
              onRetry={handleRetry}
              showRetry={!!retryMessageContent}
            />
          )}

          {/* Timeout Warning */}
          {timeoutWarning && isGenerating && (
            <div className="fixed bottom-4 right-4 z-50 max-w-sm w-full">
              <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 shadow-lg">
                <div className="flex items-start gap-3">
                  <Clock className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-yellow-800 dark:text-yellow-200">
                      请求时间较长
                    </h4>
                    <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                      AI模型正在处理您的请求，这可能需要一些时间。请耐心等待，或尝试切换到其他模型。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      {/* Storyline Panel */}
      {showStoryline && branchTree && (
        <StorylinePanel
          branchTree={branchTree}
          activeBranchName={selectedBranch?.branch_name || 'Main'}
          characterName={selectedCharacter?.name || ''}
          onClose={() => setShowStoryline(false)}
          onNavigate={handleStorylineNavigate}
          isDark={document.documentElement.classList.contains('dark')}
        />
      )}

      {/* World Book Overview Panel */}
      <WorldBookOverview
        status={wb.sessionStatus || { active: false }}
        isOpen={showWorldBookOverview}
        onClose={() => setShowWorldBookOverview(false)}
        onJump={async (index) => {
          if (selectedSession) {
            await wb.jumpToStage(selectedSession.id, index);
            await wb.loadSessionStatus(selectedSession.id);
          }
        }}
      />

      {/* World Book Manager Dialog */}
      {showWorldBookManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowWorldBookManager(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-lg h-[80vh] glass-strong rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <WorldBookManager
              worldBooks={wb.worldBooks}
              selectedWorldBook={wb.selectedWorldBook}
              loading={wb.loading}
              parsing={wb.parsing}
              models={models}
              selectedModel={selectedModel}
              t={t}
              onLoad={wb.loadWorldBooks}
              onCreate={wb.createWorldBook}
              onUpdate={wb.updateWorldBook}
              onDelete={wb.deleteWorldBook}
              onImport={wb.importWorldBook}
              onParse={wb.parseWorldBook}
              onSelect={(id) => wb.loadWorldBookDetail(id)}
              onClose={() => setShowWorldBookManager(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
