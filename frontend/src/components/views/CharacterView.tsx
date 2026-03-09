import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { analyzeError, type ErrorInfo } from '@/lib/errorHandler';
import { getOCData } from '@/components/ui/custom/OCSettings';
import type { Character, Model, User as UserType, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch } from '@/types';

const generateMessageId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

interface CharacterViewProps {
  token: string;
  user: UserType;
  models: Model[];
  t: Record<string, string>;
  systemDefaults?: Record<string, string>;
}

type ViewState = 'list' | 'edit' | 'chat';

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
}

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

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
        <div className="absolute top-full right-0 mt-2 w-72 glass-strong rounded-xl shadow-xl border border-border z-50 overflow-hidden animate-fade-in-up">
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
                暂无分支
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
                        <div className="text-xs opacity-70">当前</div>
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
}

const DialogueModeSelector: React.FC<DialogueModeSelectorProps> = ({
  currentMode,
  onSelect
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const modes = [
    { id: 'first_person', name: '第一人称' },
    { id: 'third_person', name: '故事模式' }
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
        <div className="absolute top-full right-0 mt-2 w-48 glass-strong rounded-xl shadow-xl border border-border z-50 overflow-hidden animate-fade-in-up">
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
  token,
  user,
  models,
  t,
  systemDefaults
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
  const [isGenerating, setIsGenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  
  // 对话分支相关状态
  const [branches, setBranches] = useState<CharacterChatSessionBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<CharacterChatSessionBranch | null>(null);
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  
  // Regenerate state
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  
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
  const [isMixedDeleteMode, setIsMixedDeleteMode] = useState(false);
  const [selectedWholeMessages, setSelectedWholeMessages] = useState<Set<number>>(new Set());
  const [selectedMessageParts, setSelectedMessageParts] = useState<Map<number, Set<string>>>(new Map());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ type: 'single'; id: string } | { type: 'batch' } | null>(null);
  const [showDeleteCharacterConfirm, setShowDeleteCharacterConfirm] = useState(false);
  const [pendingDeleteCharacter, setPendingDeleteCharacter] = useState<string | null>(null);
  const [showDeleteBranchConfirm, setShowDeleteBranchConfirm] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [showDeleteMixedConfirm, setShowDeleteMixedConfirm] = useState(false);
  const [initializingChat, setInitializingChat] = useState(false);
  const [showImportOptions, setShowImportOptions] = useState<string | null>(null);
  const [processingCharacter, setProcessingCharacter] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [forceShowOverlay, setForceShowOverlay] = useState<string | null>(null);
  const [showProcessingMessage, setShowProcessingMessage] = useState<{ show: boolean; message: string }>({ show: false, message: '' });
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [showModelReasoning, setShowModelReasoning] = useState(false);
  
  // Error handling state
  const [currentError, setCurrentError] = useState<ErrorInfo | null>(null);
  const [retryMessageContent, setRetryMessageContent] = useState<string>('');
  const [retryMessageImages, setRetryMessageImages] = useState<string[]>([]);
  
  // Request timeout state
  const [requestStartTime, setRequestStartTime] = useState<number | null>(null);
  const [timeoutWarning, setTimeoutWarning] = useState(false);
  const TIMEOUT_WARNING_MS = 15000; // 15 seconds before showing warning
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suggestionsAbortRef = useRef<AbortController | null>(null);
  const loadingSessionRef = useRef<string | null>(null);

  useEffect(() => {
    loadCharacters();
    fetchUserSettings();
    
    // 监听用户设置更新事件
    const handleSettingsUpdate = (e: any) => {
      if (e.detail?.showModelReasoning !== undefined) {
        setShowModelReasoning(e.detail.showModelReasoning);
      }
    };
    window.addEventListener('userSettingsUpdated', handleSettingsUpdate);
    return () => window.removeEventListener('userSettingsUpdated', handleSettingsUpdate);
  }, [token]);

  useEffect(() => {
    const newDefaultModel = systemDefaults?.default_character_chat_model || models[0]?.id || '';
    setSelectedModel(newDefaultModel);
  }, [systemDefaults, models]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const fetchUserSettings = async () => {
    try {
      const res = await fetch('/api/users/me/settings', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const settings = await res.json();
        setShowModelReasoning(settings.show_model_reasoning || false);
      }
    } catch (e) {
      console.error('Failed to fetch user settings:', e);
    }
  };

  const loadCharacters = async () => {
    try {
      const res = await fetch('/api/characters', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setCharacters(data);
        
        const processingChar = data.find((c: any) => c.is_processing);
        if (processingChar) {
          if (!processingCharacter) {
            setProcessingCharacter(processingChar.id);
            pollCharacterStatus(processingChar.id);
          }
        }
        // 不要在这里清除 processingCharacter，让轮询函数自己处理
      }
    } catch (e) {
      console.error('Failed to load characters:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadSessions = useCallback(async (characterId: string) => {
    try {
      const res = await fetch(`/api/characters/${characterId}/sessions`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }, [token]);

  const autoCompressMemory = async (sessionId: string) => {
    if (loadingSessionRef.current !== sessionId) return;
    
    try {
      const res = await fetch(`/api/memory/check-auto-compress?session_id=${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok && loadingSessionRef.current === sessionId) {
        const data = await res.json();
        if (data.auto_compressed) {
          console.log('Memory auto-compressed:', data.message);
        }
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
      const res = await fetch(`/api/memory/stats?session_id=${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (res.ok && loadingSessionRef.current === sessionId) {
        const data = await res.json();
        setMemoryStats(data);
        
        if (data.compression_needed) {
          await autoCompressMemory(sessionId);
        }
      }
    } catch (e) {
      console.error('Failed to load memory stats:', e);
    }
  }, [token]);

  const loadBranches = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/character-sessions/${sessionId}/branches`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setBranches(data);
        const active = data.find((b: CharacterChatSessionBranch) => b.is_active);
        if (active) {
          setSelectedBranch(active);
        }
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    }
  }, [token]);

  const createBranch = async (branchName: string) => {
    if (!selectedSession || !branchName.trim()) return;
    try {
      const res = await fetch(`/api/character-sessions/${selectedSession.id}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          session_id: selectedSession.id,
          branch_name: branchName,
          parent_message_id: messages.length > 0 ? messages[messages.length - 1].id : null
        })
      });
      if (res.ok) {
        await loadBranches(selectedSession.id);
        setNewBranchName('');
        setShowBranchSelector(false);
      }
    } catch (e) {
      console.error('Failed to create branch:', e);
    }
  };

  const switchBranch = async (branch: CharacterChatSessionBranch) => {
    if (!selectedSession) return;
    try {
      const res = await fetch(`/api/character-sessions/${selectedSession.id}/branches/${branch.id}/switch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedBranch(branch);
        setMessages(data.messages || []);
        await loadBranches(selectedSession.id);
      }
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
      const res = await fetch(`/api/character-sessions/${selectedSession.id}/branches/${pendingDeleteBranch}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        await loadBranches(selectedSession.id);
        if (selectedBranch?.id === pendingDeleteBranch) {
          setSelectedBranch(null);
        }
      }
    } catch (e) {
      console.error('Failed to delete branch:', e);
    } finally {
      setShowDeleteBranchConfirm(false);
      setPendingDeleteBranch(null);
    }
  };

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/character-sessions/${sessionId}/messages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
        setSuggestions([]);
        
        await loadMemoryStats(sessionId);
        await loadBranches(sessionId);
        
        // 角色扮演禁用推荐对话功能以节省tokens
        // if (data.length > 0) {
        //   const lastMsg = data[data.length - 1];
        //   if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.length > 20) {
        //     if (suggestionsAbortRef.current) {
        //       suggestionsAbortRef.current.abort();
        //     }
        //     suggestionsAbortRef.current = new AbortController();
        //     const currentAbortController = suggestionsAbortRef.current;
        //     
        //     fetch('/api/chat/suggestions', {
        //       method: 'POST',
        //       headers: {
        //         Authorization: `Bearer ${token}`,
        //         'Content-Type': 'application/json'
        //       },
        //       body: JSON.stringify({ message: lastMsg.content, model: selectedModel }),
        //       signal: currentAbortController.signal
        //     })
        //       .then(r => r.json())
        //       .then(data => {
        //         if (Array.isArray(data) && !currentAbortController.signal.aborted) {
        //           setSuggestions(data);
        //         }
        //       })
        //       .catch(() => {});
        //   }
        // }
      }
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, [token, selectedModel, loadMemoryStats, loadBranches]);

  const manualCompressMemory = async () => {
    if (!selectedSession?.id || compressing) return;
    setCompressing(true);
    try {
      const res = await fetch('/api/memory/compress', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session_id: selectedSession.id,
          compression_ratio: 0.5
        })
      });
      if (res.ok) {
        const data = await res.json();
        alert(`记忆压缩完成！\n删除: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
        await loadMemoryStats(selectedSession.id);
      } else {
        const error = await res.text();
        alert('压缩失败: ' + error);
      }
    } catch (e) {
      console.error('Manual compress failed:', e);
      alert('压缩失败');
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
      const method = selectedCharacter ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify(editingCharacter)
      });
      
      if (res.ok) {
        await loadCharacters();
        setViewState('list');
        setEditingCharacter({});
        setSelectedCharacter(null);
      }
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
      const res = await fetch(`/api/characters/${pendingDeleteCharacter}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        await loadCharacters();
      } else {
        const error = await res.text();
        alert('删除失败: ' + error);
      }
    } catch (e) {
      console.error('Failed to delete character:', e);
      alert('删除失败');
    } finally {
      setShowDeleteCharacterConfirm(false);
      setPendingDeleteCharacter(null);
    }
  };

  const handleImportCharacter = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch('/api/characters/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      
      if (res.ok) {
        const result = await res.json();
        await loadCharacters();
        setShowImportOptions(result.character.id);
      } else {
        const error = await res.text();
        alert('导入失败: ' + error);
      }
    } catch (e) {
      console.error('Failed to import character:', e);
      alert('导入失败');
    }
  };

  const handleParseCharacter = async (characterId: string) => {
    try {
      setProcessingCharacter(characterId);
      setIsProcessing(true);
      setForceShowOverlay(characterId);
      const res = await fetch('/api/characters/parse', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ character_id: characterId, model: selectedModel })
      });
      
      if (res.ok) {
        setShowProcessingMessage({ show: true, message: '已经开始解析，请稍候...' });
        setShowImportOptions(null);
        pollCharacterStatus(characterId);
        setTimeout(() => {
          setShowProcessingMessage({ show: false, message: '' });
        }, 3000);
      } else {
        const error = await res.text();
        setShowProcessingMessage({ show: true, message: '解析失败: ' + error });
        setProcessingCharacter(null);
        setIsProcessing(false);
        setForceShowOverlay(null);
        setTimeout(() => {
          setShowProcessingMessage({ show: false, message: '' });
        }, 3000);
      }
    } catch (e) {
      console.error('Failed to parse character:', e);
      setShowProcessingMessage({ show: true, message: '解析失败' });
      setProcessingCharacter(null);
      setIsProcessing(false);
      setForceShowOverlay(null);
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    }
  };

  const handleTranslateCharacter = async (characterId: string) => {
    try {
      setProcessingCharacter(characterId);
      setIsProcessing(true);
      setForceShowOverlay(characterId);
      const res = await fetch('/api/characters/translate', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ character_id: characterId, target_language: 'zh', model: selectedModel })
      });
      
      if (res.ok) {
        setShowProcessingMessage({ show: true, message: '已经开始翻译，请稍候...' });
        setShowImportOptions(null);
        pollCharacterStatus(characterId);
        setTimeout(() => {
          setShowProcessingMessage({ show: false, message: '' });
        }, 3000);
      } else {
        const error = await res.text();
        setShowProcessingMessage({ show: true, message: '翻译失败: ' + error });
        setProcessingCharacter(null);
        setIsProcessing(false);
        setForceShowOverlay(null);
        setTimeout(() => {
          setShowProcessingMessage({ show: false, message: '' });
        }, 3000);
      }
    } catch (e) {
      console.error('Failed to translate character:', e);
      setShowProcessingMessage({ show: true, message: '翻译失败' });
      setProcessingCharacter(null);
      setIsProcessing(false);
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
    setIsProcessing(false);
    setForceShowOverlay(null);
  };

  const handleStopProcessing = async (characterId: string) => {
    try {
      const res = await fetch(`/api/characters/${characterId}/reset-status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (res.ok) {
        stopPolling();
        await loadCharacters();
        setShowProcessingMessage({ show: true, message: '已停止处理' });
        setTimeout(() => {
          setShowProcessingMessage({ show: false, message: '' });
        }, 3000);
      }
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
        const res = await fetch(`/api/characters/${characterId}/status`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (res.ok) {
          const status = await res.json();
          
          if (!status.is_processing) {
            if (pollingInterval) {
              clearInterval(pollingInterval);
              setPollingInterval(null);
            }
            setProcessingCharacter(null);
            setIsProcessing(false);
            setForceShowOverlay(null);
            await loadCharacters();
            if (selectedCharacter?.id === characterId) {
              const charRes = await fetch(`/api/characters/${characterId}`, {
                headers: { Authorization: `Bearer ${token}` }
              });
              if (charRes.ok) {
                setSelectedCharacter(await charRes.json());
              }
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
        }
      } catch (e) {
        console.error('Failed to poll status:', e);
      }
    }, 2000);
    
    setPollingInterval(interval);
  };

  const handleExportCharacter = async (character: Character, format: 'png' | 'json' = 'png') => {
    try {
      const res = await fetch(`/api/characters/${character.id}/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
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
        const response = await fetch('/api/character-chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            character_id: selectedCharacter.id,
            message: '__INIT__',
            model: selectedModel,
            temperature: 0.7,
            dialogue_mode: dialogueMode,
            user_nickname: getDisplayName(selectedCharacter)
          })
        });
        
        if (response.ok) {
          const data = await response.json();
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

  const getAllMessagePartIds = (content: string): string[] => {
    let processedContent = content;
    for (let i = 0; i < 3; i++) {
      processedContent = processedContent
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
    
    const allTags = [
      { type: 'action', start: '<|a|>', end: '</|a|>' },
      { type: 'thinking', start: '<|t|>', end: '</|t|>' },
      { type: 'action', start: '<|a|>', end: '<|/a|>' },
      { type: 'thinking', start: '<|t|>', end: '<|/t|>' },
      { type: 'modelReasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
      { type: 'thinking', start: '<thinking>', end: '</thinking>' },
      { type: 'thinking', start: '<think>', end: '</think>' },
      { type: 'action', start: '<action>', end: '</action>' },
      { type: 'action', start: '[action]', end: '[/action]' }
    ];
    
    type MessagePart = { type: string; id: string };
    const parts: MessagePart[] = [];
    let remainingContent = processedContent;
    let actionIndex = 0;
    let textIndex = 0;
    
    while (remainingContent.length > 0) {
      let bestMatch: { tag: any; startIdx: number; endIdx: number } | null = null;
      
      for (const tag of allTags) {
        const startIdx = remainingContent.indexOf(tag.start);
        if (startIdx !== -1) {
          const endIdx = remainingContent.indexOf(tag.end, startIdx + tag.start.length);
          if (endIdx !== -1) {
            if (!bestMatch || startIdx < bestMatch.startIdx) {
              bestMatch = { tag, startIdx, endIdx };
            }
          }
        }
      }
      
      if (bestMatch) {
        if (bestMatch.startIdx > 0) {
          const beforeText = remainingContent.substring(0, bestMatch.startIdx);
          if (beforeText.trim()) {
            parts.push({ type: 'text', id: `text-${textIndex++}` });
          }
        }
        
        let partId: string;
        if (bestMatch.tag.type === 'action') {
          partId = `action-${actionIndex++}`;
        } else if (bestMatch.tag.type === 'modelReasoning') {
          partId = 'modelReasoning';
        } else {
          partId = 'thinking';
        }
        
        parts.push({ type: bestMatch.tag.type, id: partId });
        remainingContent = remainingContent.substring(bestMatch.endIdx + bestMatch.tag.end.length);
      } else {
        if (remainingContent.trim()) {
          parts.push({ type: 'text', id: `text-${textIndex++}` });
        }
        break;
      }
    }
    
    return parts.map(part => part.id);
  };

  const toggleWholeMessageSelect = (messageIndex: number) => {
    const msg = messages[messageIndex];
    if (!msg) return;
    
    const isSelecting = !selectedWholeMessages.has(messageIndex);
    
    if (isSelecting) {
      setSelectedWholeMessages(prev => {
        const newSet = new Set(prev);
        newSet.add(messageIndex);
        return newSet;
      });
      
      const partsToSelect = getAllMessagePartIds(msg.content);
      
      if (partsToSelect.length > 0) {
        setSelectedMessageParts(prev => {
          const newMap = new Map(prev);
          newMap.set(messageIndex, new Set(partsToSelect));
          return newMap;
        });
      }
    } else {
      setSelectedWholeMessages(prev => {
        const newSet = new Set(prev);
        newSet.delete(messageIndex);
        return newSet;
      });
      setSelectedMessageParts(prev => {
        const newMap = new Map(prev);
        newMap.delete(messageIndex);
        return newMap;
      });
    }
  };

  const toggleMessagePartSelect = (messageIndex: number, partId: string) => {
    setSelectedMessageParts(prev => {
      const newMap = new Map(prev);
      const currentParts = newMap.get(messageIndex) || new Set();
      const newParts = new Set(currentParts);
      if (newParts.has(partId)) {
        newParts.delete(partId);
      } else {
        newParts.add(partId);
      }
      if (newParts.size === 0) {
        newMap.delete(messageIndex);
        setSelectedWholeMessages(prev => {
          const newSet = new Set(prev);
          newSet.delete(messageIndex);
          return newSet;
        });
      } else {
        newMap.set(messageIndex, newParts);
      }
      return newMap;
    });
  };

  const selectAllPartsInMessage = (messageIndex: number) => {
    const msg = messages[messageIndex];
    if (!msg) return;
    
    const partsToSelect = getAllMessagePartIds(msg.content);
    
    setSelectedMessageParts(prev => {
      const newMap = new Map(prev);
      newMap.set(messageIndex, new Set(partsToSelect));
      return newMap;
    });
    
    if (partsToSelect.length > 0) {
      setSelectedWholeMessages(prev => {
        const newSet = new Set(prev);
        newSet.add(messageIndex);
        return newSet;
      });
    }
  };

  const handleBatchDelete = () => {
    if (selectedSessions.size === 0) return;
    setPendingDelete({ type: 'batch' });
    setShowDeleteConfirm(true);
  };

  const handleMixedDelete = () => {
    if (selectedWholeMessages.size === 0 && selectedMessageParts.size === 0) return;
    setShowDeleteMixedConfirm(true);
  };

  const confirmDeleteMixed = async () => {
    try {
      const sortedIndices = Array.from(selectedWholeMessages).sort((a, b) => b - a);
      
      for (const idx of sortedIndices) {
        const msg = messages[idx];
        if (msg && msg.id !== undefined) {
          await handleDeleteMessage(msg.id as number, idx);
        }
      }
      
      const partIndices = Array.from(selectedMessageParts.keys()).sort((a, b) => b - a);
      
      for (const idx of partIndices) {
        if (!selectedWholeMessages.has(idx)) {
          const msg = messages[idx];
          if (msg && msg.id !== undefined) {
            const selectedParts = selectedMessageParts.get(idx) || new Set();
            
            let content = msg.content;
            for (let i = 0; i < 3; i++) {
              content = content
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");
            }
            
            const allTags = [
              { type: 'action', start: '<|a|>', end: '</|a|>' },
              { type: 'thinking', start: '<|t|>', end: '</|t|>' },
              { type: 'action', start: '<|a|>', end: '<|/a|>' },
              { type: 'thinking', start: '<|t|>', end: '<|/t|>' },
              { type: 'modelReasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
              { type: 'thinking', start: '<thinking>', end: '</thinking>' },
              { type: 'thinking', start: '<think>', end: '</think>' },
              { type: 'action', start: '<action>', end: '</action>' },
              { type: 'action', start: '[action]', end: '[/action]' }
            ];
            
            const partsToKeep: string[] = [];
            let remainingContent = content;
            let actionIndex = 0;
            let textIndex = 0;
            
            while (remainingContent.length > 0) {
              let bestMatch: { tag: any; startIdx: number; endIdx: number } | null = null;
              
              for (const tag of allTags) {
                const startIdx = remainingContent.indexOf(tag.start);
                if (startIdx !== -1) {
                  const endIdx = remainingContent.indexOf(tag.end, startIdx + tag.start.length);
                  if (endIdx !== -1) {
                    if (!bestMatch || startIdx < bestMatch.startIdx) {
                      bestMatch = { tag, startIdx, endIdx };
                    }
                  }
                }
              }
              
              if (bestMatch) {
                if (bestMatch.startIdx > 0) {
                  const beforeText = remainingContent.substring(0, bestMatch.startIdx);
                  const textId = `text-${textIndex++}`;
                  if (!selectedParts.has(textId)) {
                    partsToKeep.push(beforeText);
                  }
                }
                
                let partId: string;
                if (bestMatch.tag.type === 'action') {
                  partId = `action-${actionIndex++}`;
                } else if (bestMatch.tag.type === 'modelReasoning') {
                  partId = 'modelReasoning';
                } else {
                  partId = 'thinking';
                }
                
                const fullMatch = remainingContent.substring(
                  bestMatch.startIdx,
                  bestMatch.endIdx + bestMatch.tag.end.length
                );
                
                if (!selectedParts.has(partId)) {
                  partsToKeep.push(fullMatch);
                }
                
                remainingContent = remainingContent.substring(bestMatch.endIdx + bestMatch.tag.end.length);
              } else {
                const textId = `text-${textIndex++}`;
                if (!selectedParts.has(textId)) {
                  partsToKeep.push(remainingContent);
                }
                break;
              }
            }
            
            const result = partsToKeep.join('');
            await handleEditMessage(msg.id as number, idx, result);
          }
        }
      }
      
      setSelectedWholeMessages(new Set());
      setSelectedMessageParts(new Map());
      setIsMixedDeleteMode(false);
    } catch (e) {
      console.error('Failed to delete:', e);
    } finally {
      setShowDeleteMixedConfirm(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;

    try {
      if (pendingDelete.type === 'batch') {
        for (const sessionId of Array.from(selectedSessions)) {
          await fetch(`/api/character-sessions/${sessionId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
          });
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
        const res = await fetch(`/api/character-sessions/${pendingDelete.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          await loadSessions(selectedCharacter!.id);
          if (selectedSession?.id === pendingDelete.id) {
            setSelectedSession(null);
            setMessages([]);
            setMemoryStats(null);
          }
        }
      }
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setPendingDelete(null);
      setShowDeleteConfirm(false);
    }
  };

  const handleRegenerate = async (messageIndex: number) => {
    if (!selectedCharacter || isGenerating || uploading || messageIndex < 1) return;
    
    const assistantMessageIndex = messageIndex;
    const userMessageIndex = assistantMessageIndex - 1;
    
    if (userMessageIndex < 0) return;
    
    const userMessage = messages[userMessageIndex];
    if (userMessage.role !== 'user') return;
    
    setRegeneratingMessageIndex(assistantMessageIndex);
    setIsGenerating(true);
    setSuggestions([]);
    
    const assistantMessageId = generateMessageId();
    
    setMessages(prev => {
      const newMessages = [...prev];
      newMessages[assistantMessageIndex] = { 
        id: assistantMessageId, 
        role: 'assistant', 
        content: '', 
        model: selectedModel 
      };
      return newMessages;
    });
    
    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    
    try {
      const response = await fetch('/api/character-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          session_id: selectedSession?.id || '',
          character_id: selectedCharacter.id,
          message: userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim(),
          model: selectedModel,
          temperature: 0.7,
          dialogue_mode: dialogueMode,
          branch_id: selectedBranch?.id,
          user_nickname: getDisplayName(selectedCharacter)
        }),
        signal: abortControllerRef.current.signal
      });
      
      if (!response.ok) throw new Error('Failed to send message');
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const json = JSON.parse(data);
              if (json.session_id && !selectedSession) {
                setSelectedSession({ ...json } as any);
                loadSessions(selectedCharacter.id);
              }
              if (json.reasoning) fullReasoning += json.reasoning;
              if (json.content) fullContent += json.content;
              
              setMessages(prev => {
                const newMessages = [...prev];
                newMessages[assistantMessageIndex] = {
                  ...newMessages[assistantMessageIndex],
                  content: fullReasoning 
                    ? `<think>${fullReasoning}</think>${fullContent}` 
                    : fullContent
                };
                return newMessages;
              });
            } catch (e) {}
          }
        }
      }
      
      // 角色扮演暂时禁用推荐对话功能以节省tokens
      // if (fullContent.length > 20) {
      //   fetch('/api/chat/suggestions', {
      //     method: 'POST',
      //     headers: {
      //       Authorization: `Bearer ${token}`,
      //       'Content-Type': 'application/json'
      //     },
      //     body: JSON.stringify({ message: fullContent, model: selectedModel })
      //   })
      //     .then(r => r.json())
      //     .then(setSuggestions)
      //     .catch(() => {});
      // }
      
      if (selectedSession?.id) {
        await loadMemoryStats(selectedSession.id);
      }
      
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex].content += `\n[Error: ${e.message}]`;
          return newMessages;
        });
      }
    } finally {
      setIsGenerating(false);
      setRegeneratingMessageIndex(null);
      abortControllerRef.current = null;
    }
  };

  const handleSendMessage = async (content: string, images: string[]) => {
    if (!selectedCharacter) return;
    
    const text = content || inputValue;
    if ((!text.trim() && attachments.length === 0) || isGenerating || uploading) return;
    
    // Clear any previous error
    setCurrentError(null);
    setTimeoutWarning(false);
    
    setInputValue('');
    setAttachments([]);
    setIsGenerating(true);
    setSuggestions([]);
    
    // Save message for potential retry
    setRetryMessageContent(text);
    setRetryMessageImages(images);
    
    // Start timeout timer
    setRequestStartTime(Date.now());
    timeoutRef.current = setTimeout(() => {
      setTimeoutWarning(true);
    }, TIMEOUT_WARNING_MS);

    let displayContent = text;
    if (attachments.length > 0) {
      displayContent += '\n\n';
      attachments.forEach(att => {
        displayContent += att.type === 'image' 
          ? `![${att.name}](${att.url})\n`
          : `[📎 ${att.name}](${att.url})\n`;
      });
    }

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    setMessages(prev => [
      ...prev,
      { id: userMessageId, role: 'user', content: displayContent, model: selectedModel },
      { id: assistantMessageId, role: 'assistant', content: '', model: selectedModel }
    ]);

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    let hasReceivedData = false;

    try {
      const response = await fetch('/api/character-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          session_id: selectedSession?.id || '',
          character_id: selectedCharacter.id,
          message: text,
          model: selectedModel,
          temperature: 0.7,
          dialogue_mode: dialogueMode,
          branch_id: selectedBranch?.id,
          user_nickname: getDisplayName(selectedCharacter)
        }),
        signal: abortControllerRef.current.signal
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error: ${response.status} - ${errorText || response.statusText}`);
      }
      
      if (!selectedSession) {
        setTimeout(() => loadSessions(selectedCharacter.id), 1000);
      }
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // We received data, clear timeout warning
        if (!hasReceivedData) {
          hasReceivedData = true;
          setTimeoutWarning(false);
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
        }
        
        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const json = JSON.parse(data);
              if (json.session_id && !selectedSession) {
                setSelectedSession({ ...json } as any);
                loadSessions(selectedCharacter.id);
              }
              if (json.reasoning) fullReasoning += json.reasoning;
              if (json.content) fullContent += json.content;
              
              setMessages(prev => {
                const newMessages = [...prev];
                const lastMessage = newMessages[newMessages.length - 1];
                newMessages[newMessages.length - 1] = {
                  ...lastMessage,
                  content: fullReasoning 
                    ? `<think>${fullReasoning}</think>${fullContent}` 
                    : fullContent
                };
                return newMessages;
              });
            } catch (e) {}
          }
        }
      }
      
      // 角色扮演禁用推荐对话功能以节省tokens
      // if (fullContent.length > 20) {
      //   fetch('/api/chat/suggestions', {
      //     method: 'POST',
      //     headers: {
      //       Authorization: `Bearer ${token}`,
      //       'Content-Type': 'application/json'
      //     },
      //     body: JSON.stringify({ message: fullContent, model: selectedModel })
      //   })
      //     .then(r => r.json())
      //     .then(setSuggestions)
      //     .catch(() => {});
      // }
      
      if (selectedSession?.id) {
        await loadMemoryStats(selectedSession.id);
      }
      
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        const errorInfo = analyzeError(e);
        setCurrentError(errorInfo);
        
        // Update the assistant message with user-friendly error
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content = 
            `⚠️ **${errorInfo.title}**\n\n${errorInfo.description}\n\n💡 ${errorInfo.suggestion}`;
          return newMessages;
        });
      }
    } finally {
      setIsGenerating(false);
      setRequestStartTime(null);
      setTimeoutWarning(false);
      abortControllerRef.current = null;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    }
  };

  const handleSendWithInput = async () => {
    if (inputValue.trim() || attachments.length > 0) {
      await handleSendMessage(inputValue, attachments.filter(a => a.type === 'image').map(a => a.url));
    }
  };

  const handleRetry = () => {
    if (retryMessageContent) {
      setCurrentError(null);
      handleSendMessage(retryMessageContent, retryMessageImages);
    }
  };

  const handleCloseError = () => {
    setCurrentError(null);
  };

  const handleUpload = async (file: File, type: 'image' | 'file') => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve) => {
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ filename: file.name, data: dataUrl })
      });

      if (res.ok) {
        const data = await res.json();
        setAttachments(prev => [...prev, { type, name: file.name, url: data.url }]);
      }
    } catch (e) {
      console.error('Upload failed:', e);
    } finally {
      setUploading(false);
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

  const handleDeleteMessage = async (messageId: number, messageIndex: number) => {
    if (!selectedSession) return;
    
    try {
      await fetch(`/api/character-sessions/${selectedSession.id}/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessages(prev => prev.filter((_, idx) => idx !== messageIndex));
    } catch (e) {
      console.error('Failed to delete message:', e);
    }
  };

  const handleEditMessage = async (messageId: number, messageIndex: number, newContent: string) => {
    if (!selectedSession) return;
    
    try {
      const res = await fetch(`/api/character-sessions/${selectedSession.id}/messages/${messageId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: newContent })
      });
      
      if (res.ok) {
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[messageIndex] = {
            ...newMessages[messageIndex],
            content: newContent
          };
          return newMessages;
        });
      }
    } catch (e) {
      console.error('Failed to edit message:', e);
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
                        
                        <div className="absolute bottom-0 left-0 right-0 p-2 sm:p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200 transform translate-y-2 group-hover:translate-y-0">
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
            <div className="fixed top-4 right-4 bg-background border border-border rounded-xl p-4 shadow-xl z-50 flex items-center gap-3 animate-slide-in">
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
                      await handleParseCharacter(showImportOptions);
                      if (!showImportOptions) return;
                      await handleTranslateCharacter(showImportOptions);
                      setShowImportOptions(null);
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
              className="fixed inset-0 z-50 md:hidden animate-fade-in"
              onClick={() => setMobileSidebarOpen(false)}
            >
              <div className="absolute inset-0 bg-black/50" />
              <div 
                className="absolute left-0 top-0 bottom-0 w-[85%] max-w-[320px] bg-background shadow-2xl animate-slide-in-left flex flex-col"
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

          <div className="flex-1 flex flex-col h-full overflow-hidden pb-16 md:pb-0">
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
                  <BranchSelector
                    branches={branches}
                    selectedBranch={selectedBranch}
                    onSelect={switchBranch}
                    onCreate={createBranch}
                    onDelete={deleteBranch}
                  />
                )}
              </div>
              
              <DialogueModeSelector 
                currentMode={dialogueMode} 
                onSelect={setDialogueMode} 
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
                          setSelectedWholeMessages(new Set());
                          setSelectedMessageParts(new Map());
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
    </div>
  );
};
