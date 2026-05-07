import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useCharacterChat } from '@/hooks/useCharacterChat';
import { useMessageSelection } from '@/hooks/useMessageSelection';
import { Bot } from 'lucide-react';
import { useWorldBook } from '@/hooks/useWorldBook';
import { usePlotLine } from '@/hooks/usePlotLine';
import { api } from '@/services/api';
import { toast } from 'sonner';
import { getOCData } from '@/components/ui/custom/OCSettings';
import { CharacterList } from './character/CharacterList';
import { CharacterEditor } from './character/CharacterEditor';
import { CharacterChat } from './character/CharacterChat';
import { WorldBookManager } from '@/components/ui/custom/WorldBookManager';
import { PlotLineManager } from '@/components/ui/custom/PlotLineManager';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import type { Character, Model, User as UserType, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch, GenerationPreset } from '@/types';

interface CharacterViewProps {
  token: string;
  user: UserType;
  models: Model[];
  t: Record<string, string>;
  systemDefaults?: Record<string, string>;
  lang?: 'zh' | 'en';
  isDark?: boolean;
  sidebarCollapsed?: boolean;
  setSidebarCollapsed?: (v: boolean) => void;
}

type ViewState = 'list' | 'edit' | 'profile' | 'chat';

export const CharacterView: React.FC<CharacterViewProps> = ({
  token: _token,
  user,
  models,
  t,
  systemDefaults,
  lang,
  sidebarCollapsed: _sidebarCollapsedProp,
  setSidebarCollapsed: _setSidebarCollapsedProp,
}) => {
  const { characterId } = useParams<{ characterId?: string }>();
  const navigate = useNavigate();
  
  const [viewState, setViewState] = useState<ViewState>('list');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [editingCharacter, setEditingCharacter] = useState<Partial<Character>>({});
  
  const getDisplayName = (character?: Character | Partial<Character> | null): string => {
    const ocData = getOCData();
    if (ocData?.name) return ocData.name;
    if (character?.user_nickname) return character.user_nickname;
    return user.username || (t.user_label || '用户');
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
  const [branchTree, setBranchTree] = useState<BranchTree | null>(null);
  const [forkPoint, setForkPoint] = useState<{ branchId: string; messageId: number } | null>(null);
  const [currentPreset, setCurrentPreset] = useState<GenerationPreset | null>(null);
  
  const [storylineCollapsed, setStorylineCollapsed] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    if (window.innerWidth >= 768) return;
    const nav = document.querySelector('nav[data-dock="true"]');
    if (!nav) return;
    if (!storylineCollapsed) {
      nav.style.transform = 'translateX(calc(-50% + 320px))';
    } else {
      nav.style.transform = '';
    }
  }, [storylineCollapsed]);

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
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showModelReasoning, setShowModelReasoning] = useState(false);
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [characterDisplayMode, setCharacterDisplayMode] = useState<string>('framed');
  const [showWorldBookManager, setShowWorldBookManager] = useState(false);
  const [showWorldBookOverview, setShowWorldBookOverview] = useState(false);
  const [selectedWorldBookId, setSelectedWorldBookId] = useState<string | null>(null);
  
  // World Book hook
  const [showPlotLineManager, setShowPlotLineManager] = useState(false);
  const [selectedPlotLineId, setSelectedPlotLineId] = useState<string | null>(null);

  // World Book hook
  const wb = useWorldBook();
  const pl = usePlotLine();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const routeCharacterSyncRef = useRef<string | null>(null);

  const loadingSessionRef = useRef<string | null>(null);
  const pendingInitialBottomLockRef = useRef(false);
  const initialBottomLockUntilRef = useRef(0);
  const INITIAL_BOTTOM_LOCK_MS = 1500;

  // Forward-declare loadSessions and loadMemoryStats for hooks
  const loadSessions = useCallback(async (characterId: string) => {
    try {
      const data = await api.get(`/api/characters/${characterId}/sessions`);
      setSessions(data);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }, []);

  const autoCompressMemory = async (sessionId: string, branchId?: string) => {
    if (loadingSessionRef.current !== sessionId) return;
    try {
      const branchParam = branchId ? `&branch_id=${branchId}` : ``;
      const data = await api.get(`/api/memory/check-auto-compress?session_id=${sessionId}${branchParam}`);
      if (loadingSessionRef.current === sessionId && data.auto_compressed) {
        console.log('Memory auto-compressed:', data.message);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.error('Auto compress failed:', e);
      }
    }
  };

  const loadMemoryStats = useCallback(async (sessionId: string, branchId?: string) => {
    if (!sessionId) return;
    loadingSessionRef.current = sessionId;
    try {
      const branchParam = branchId ? `&branch_id=${branchId}` : ``;
      const data = await api.get(`/api/memory/stats?session_id=${sessionId}${branchParam}`);
      if (loadingSessionRef.current === sessionId) {
        setMemoryStats(data);
        if (data.compression_needed) {
          await autoCompressMemory(sessionId, branchId);
        }
      }
    } catch (e) {
      console.error('Failed to load memory stats:', e);
    }
  }, []);

  // Chat hook
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
    currentPreset,
    getDisplayName,
    messages,
    setMessages,
    setSelectedSession,
    loadSessions,
    loadMemoryStats,
    forkPoint,
    onForkCreated: () => setForkPoint(null),
    onBranchCreated: (branch) => setSelectedBranch({ id: branch.id, branch_name: branch.branch_name, is_active: branch.is_active, session_id: branch.session_id || selectedSession?.id || '', parent_branch_id: branch.parent_branch_id || null, parent_message_id: branch.parent_message_id || null, created_at: branch.created_at || new Date().toISOString() }),
  });

  // Message selection hook
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
      if (e.detail?.memoryMode !== undefined) {
        setMemoryMode(e.detail.memoryMode);
      }
      if (e.detail?.characterDisplayMode !== undefined) {
        setCharacterDisplayMode(e.detail.characterDisplayMode);
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
      setMemoryMode(settings.memory_mode || 'rule');
      setCharacterDisplayMode(settings.character_display_mode || 'framed');
    } catch (e) {
      console.error('Failed to fetch user settings:', e);
    }
  };

  const loadCharacters = async () => {
    try {
      const data = await api.get('/api/characters');
      setCharacters(data);
      
      // 如果有characterId参数，自动打开对应的角色介绍页面
      // if (characterId) {
      //   const targetCharacter = data.find((c: Character) => c.id === characterId);
      //   if (targetCharacter) {
      //     handleViewProfile(targetCharacter);
      //   }
      // }
      
      const processingChar = data.find((c: any) => c.is_processing);
      if (processingChar) {
        if (!processingCharacter) {
          setProcessingCharacter(processingChar.id);
          pollCharacterStatus(processingChar.id);
        }
      }
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

  const createBranch = async (_branchName?: string) => {
    if (!selectedSession) return;
    try {
      const resp = await api.post(`/api/character-sessions/${selectedSession.id}/branches`, {
        session_id: selectedSession.id,
        same_level: true,
      });
      const branchName = resp?.branch?.branch_name || '新分支';
      toast.success(`分支 "${branchName}" 已创建`);
      await loadBranches(selectedSession.id);
      await fetchBranchTree();

      if (resp?.branch) {
        setSelectedBranch(resp.branch);
      }
      if (resp?.messages?.length > 0) {
        setMessages(resp.messages);
      }
    } catch (e: any) {
      console.error('Failed to create branch:', e);
      toast.error(e?.detail || e?.message || '创建分支失败');
    }
  };

  const switchBranch = async (branch: CharacterChatSessionBranch) => {
    if (!selectedSession) return;
    try {
      const data = await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branch.id}/switch`);
      setSelectedBranch(branch);
      setMessages(data.messages || []);
      setForkPoint(null);
      await loadBranches(selectedSession.id);
      await loadMemoryStats(selectedSession.id, branch.id);
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
        setMessages([]);
        setForkPoint(null);
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
    } catch (e) {
      console.error('Failed to fetch branch tree:', e);
    }
  }, [selectedSession]);

  const handleStorylineNavigate = useCallback(async (branchId: string, messageId: number | null, isLeaf: boolean) => {
    if (!selectedSession) return;
    try {
      const isFork = !isLeaf && messageId !== null;
      const params = isFork ? `?up_to_message_id=${messageId}` : '';
      const data = await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branchId}/switch${params}`);
      setMessages(data.messages || []);
      if (isFork) {
        setForkPoint({ branchId, messageId });
      } else {
        setForkPoint(null);
      }
      await loadBranches(selectedSession.id);
      await loadMemoryStats(selectedSession.id, branchId);
      try {
        const treeData = await api.get(`/api/character-sessions/${selectedSession.id}/branch-tree`);
        setBranchTree(treeData);
      } catch {}
    } catch (e) {
      console.error('Failed to navigate storyline:', e);
    }
  }, [selectedSession, loadBranches, loadMemoryStats]);

  const loadMessages = useCallback(async (sessionId: string) => {
    loadingSessionRef.current = sessionId;
    try {
      setMessages([]);
      setSuggestions([]);
      setMemoryStats(null);
      setBranches([]);
      setSelectedBranch(null);
      
      const data = await api.get(`/api/character-sessions/${sessionId}/messages`);
      if (loadingSessionRef.current !== sessionId) return;
      setMessages(data);
      
      pendingInitialBottomLockRef.current = data.length > 0;
      initialBottomLockUntilRef.current = performance.now() + INITIAL_BOTTOM_LOCK_MS;
      
      await loadMemoryStats(sessionId);
      await loadBranches(sessionId);
      
      // 角色扮演禁用推荐对话功能（节省tokens）
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, [loadMemoryStats, loadBranches]);

  const manualCompressMemory = async () => {
    if (!selectedSession?.id || compressing) return;
    setCompressing(true);
    try {
      const data = await api.post('/api/memory/compress', {
        session_id: selectedSession.id,
        branch_id: selectedBranch?.id,
        compression_ratio: 0.5
      });
      console.info(`记忆压缩完成！\n处理: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
      await loadMemoryStats(selectedSession.id, selectedBranch?.id);
    } catch (e: any) {
      console.error('Manual compress failed:', e);
      console.error((t.compress_failed || '压缩失败') + ': ' + (e.message || ''));
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
      console.error((t.delete_failed || '删除失败') + ': ' + (e.message || ''));
    } finally {
      setShowDeleteCharacterConfirm(false);
      setPendingDeleteCharacter(null);
    }
  };

  const handleImportCharacter = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const result: any = await api.post('/api/characters/import', formData);
      if (result.auto_parsed) {
        toast.info('已自动从图片解析角色信息');
        await loadCharacters();
        if (result.character?.id) {
          setShowImportOptions(result.character.id);
        }
      } else {
        await loadCharacters();
        setShowImportOptions(result.character.id);
      }
    } catch (e: any) {
      console.error('Failed to import character:', e);
      const detail = e?.response?.data?.detail || e?.message || '导入失败';
      if (detail.includes('AI 生成图片') || detail.includes('从图片解析')) {
        const confirmParse = window.confirm(
          detail + '\n\n是否要使用「从图片解析角色」功能，通过 AI 自动分析这张图片并创建角色？'
        );
        if (confirmParse) {
          try {
            const reader = new FileReader();
            reader.onload = async (event) => {
              const base64 = event.target?.result as string;
              try {
                const parseResult: any = await api.post('/api/characters/import-parse-image', { image_url: base64, model: selectedModel });
                if (parseResult.character_id) {
                  toast.success('角色创建成功！正在解析图片...');
                  setProcessingCharacter(parseResult.character_id);
                  pollCharacterStatus(parseResult.character_id, true);
                }
              } catch (parseErr: any) {
                toast.error(parseErr?.response?.data?.detail || parseErr?.message || '图片解析失败');
              }
            };
            reader.readAsDataURL(file);
          } catch (err: any) {
            toast.error('读取文件失败');
          }
        }
      } else {
        toast.error(detail);
      }
    }
  };

  const handleParseAndTranslateCharacter = async (characterId: string) => {
    console.log('[handleParseAndTranslateCharacter] Starting for character:', characterId, 'selectedModel:', selectedModel);
    try {
      setProcessingCharacter(characterId);
      setForceShowOverlay(characterId);
      setShowImportOptions(null);
      
      setShowProcessingMessage({ show: true, message: 'Processing stopped' });
      
      console.log('[handleParseAndTranslateCharacter] Calling parse API...');
      await api.post('/api/characters/parse', { character_id: characterId, model: selectedModel });
      console.log('[handleParseAndTranslateCharacter] Parse API called successfully');
      
      pollCharacterStatus(characterId, true);
    } catch (e: any) {
      console.error('[handleParseAndTranslateCharacter] Failed:', e);
      setShowProcessingMessage({ show: true, message: (t.processing_failed || '处理失败') + ': ' + (e.message || '') });
      setProcessingCharacter(null);
      setForceShowOverlay(null);
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    }
  };

  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    setProcessingCharacter(null);
    setForceShowOverlay(null);
  };

  const handleStopProcessing = async (characterId: string) => {
    try {
      await api.post(`/api/characters/${characterId}/reset-status`);
      stopPolling();
      await loadCharacters();
      setShowProcessingMessage({ show: true, message: 'Processing stopped' });
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    } catch (e) {
      console.error('Failed to stop processing:', e);
    }
  };

  const pollCharacterStatus = async (characterId: string, autoTranslate: boolean = false) => {
    console.log('[pollCharacterStatus] Starting poll for character:', characterId, 'autoTranslate:', autoTranslate);
    
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    
    let translationStarted = false;
    
    const interval = setInterval(async () => {
      try {
        const status = await api.get(`/api/characters/${characterId}/status`);
        console.log('[pollCharacterStatus] Status:', status);
          
        if (!status.is_processing) {
          console.log('[pollCharacterStatus] Not processing anymore, autoTranslate:', autoTranslate, 'translationStarted:', translationStarted);
          
          if (autoTranslate && !translationStarted && !status.processing_status?.includes('失败')) {
            console.log('[pollCharacterStatus] Starting translation...');
            translationStarted = true;
            setShowProcessingMessage({ show: true, message: t.translation_started || '已经开始翻译，请稍候...' });
            
            try {
              await api.post('/api/characters/translate', { character_id: characterId, target_language: 'zh', model: selectedModel });
              console.log('[pollCharacterStatus] Translation API called successfully');
              pollCharacterStatus(characterId, false);
            } catch (translateError: any) {
              console.error('[pollCharacterStatus] Translation failed:', translateError);
              setShowProcessingMessage({ show: true, message: (t.translation_failed || '翻译失败') + ': ' + (translateError.message || '') });
              clearInterval(interval);
              if (pollingIntervalRef.current === interval) {
                pollingIntervalRef.current = null;
              }
              setProcessingCharacter(null);
              setForceShowOverlay(null);
              setTimeout(() => {
                setShowProcessingMessage({ show: false, message: '' });
              }, 3000);
            }
            return;
          }
          
          console.log('[pollCharacterStatus] Clearing interval and finishing');
          clearInterval(interval);
          if (pollingIntervalRef.current === interval) {
            pollingIntervalRef.current = null;
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
            setShowProcessingMessage({ show: true, message: t.character_card_processing_complete || '角色卡处理完成！' });
            setTimeout(() => {
              setShowProcessingMessage({ show: false, message: '' });
            }, 3000);
          } else if (status.processing_status?.includes('失败')) {
            setShowProcessingMessage({ show: true, message: `${t.character_card_processing_failed || '角色卡处理失败'}：${status.processing_status}` });
            setTimeout(() => {
              setShowProcessingMessage({ show: false, message: '' });
            }, 3000);
          }
        }
      } catch (e) {
        console.error('Failed to poll status:', e);
      }
    }, 2000);
    
    pollingIntervalRef.current = interval;
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
        console.error((t.export_failed || '导出失败') + ': ' + error);
      }
    } catch (e) {
      console.error('Failed to export character:', e);
      console.error(t.export_failed || '导出失败');
    }
  };

  const handleStartChat = useCallback(async (character: Character) => {
    routeCharacterSyncRef.current = character.id;
    setSelectedCharacter(character);
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setSuggestions([]);
    setForkPoint(null);
    setBranches([]);
    setSelectedBranch(null);
    setBranchTree(null);
    await loadSessions(character.id);
    setViewState('chat');
    if (characterId !== character.id) {
      navigate(`/characters/${character.id}`);
    }
  }, [loadSessions, navigate, characterId]);

  const handleBackToList = useCallback(() => {
    setViewState('list');
    if (characterId) {
      navigate('/characters', { replace: true });
    }
  }, [navigate, characterId]);

  useEffect(() => {
    if (!characterId) {
      if (routeCharacterSyncRef.current !== null) {
        setViewState('list');
      }
      routeCharacterSyncRef.current = null;
      return;
    }

    if (routeCharacterSyncRef.current === characterId) {
      return;
    }

    const targetCharacter = characters.find((character) => character.id === characterId);
    if (!targetCharacter) {
      return;
    }

    routeCharacterSyncRef.current = characterId;
    void handleStartChat(targetCharacter);
  }, [characterId, characters, handleStartChat]);

  const handleInitiateConversation = async (initialMessage?: string) => {
    if (!selectedCharacter) {
      toast.error('请先选择一个角色');
      return;
    }

    setInitializingChat(true);

    try {
      // 如果已有会话，恢复最后一个会话（单角色单对话）
      if (sessions.length > 0) {
        const lastSession = sessions[0];
        setSelectedSession(lastSession);
        await loadMessages(lastSession.id);

        if (selectedWorldBookId) {
          try {
            await wb.associateSession(lastSession.id, selectedWorldBookId);
            await wb.loadSessionStatus(lastSession.id);
          } catch (err) {
            console.error('Failed to associate world book:', err);
          }
        }
        if (selectedPlotLineId) {
          try {
            await pl.associateSession(lastSession.id, selectedPlotLineId);
            await pl.loadSessionStatus(lastSession.id);
          } catch (err) {
            console.error('Failed to associate plot line:', err);
          }
        }
        return;
      }

      // 没有会话且角色有开场白，创建新会话并发送初始消息
      if (selectedCharacter.first_mes && selectedCharacter.first_mes.trim()) {
        const response = await api.stream('/api/character-chat', {
          character_id: selectedCharacter.id,
          message: '__INIT__',
          model: selectedModel,
          temperature: currentPreset?.temperature ?? 0.7,
          top_p: currentPreset?.top_p ?? 0.9,
          max_tokens: currentPreset?.max_tokens ?? 2048,
          frequency_penalty: currentPreset?.frequency_penalty ?? 0,
          presence_penalty: currentPreset?.presence_penalty ?? 0,
          dialogue_mode: dialogueMode,
          user_nickname: getDisplayName(selectedCharacter)
        });

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('无法读取响应流');
        }

        const decoder = new TextDecoder();
        let sessionId = '';
        let branchId = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const event of events) {
            const lines = event.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const json = JSON.parse(data);
                if (json.session_id) sessionId = json.session_id;
                if (json.branch_id) branchId = json.branch_id;
                if (json.branch_id) {
                  setSelectedBranch({
                    id: json.branch_id,
                    branch_name: 'Main',
                    is_active: true,
                    session_id: sessionId,
                    parent_branch_id: null,
                    parent_message_id: null,
                    created_at: new Date().toISOString(),
                  });
                }
              } catch {}
            }
          }
        }

        if (!sessionId) {
          throw new Error('未能获取会话ID');
        }

        await loadSessions(selectedCharacter.id);
        const newSession = {
          id: sessionId,
          title: selectedCharacter.name,
          character_id: selectedCharacter.id,
          user_id: user.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          dialogue_mode: dialogueMode
        };
        setSelectedSession(newSession);
        await loadMessages(sessionId);

        if (selectedWorldBookId) {
          try {
            await wb.associateSession(sessionId, selectedWorldBookId);
            await wb.loadSessionStatus(sessionId);
          } catch (err) {
            console.error('Failed to associate world book:', err);
          }
        }
        if (selectedPlotLineId) {
          try {
            await pl.associateSession(sessionId, selectedPlotLineId);
            await pl.loadSessionStatus(sessionId);
          } catch (err) {
            console.error('Failed to associate plot line:', err);
          }
        }
      } else if (initialMessage) {
        await handleSendMessage(initialMessage, []);
      } else {
        toast.info('该角色暂无开场白，请直接输入消息开始对话');
      }
    } catch (e: any) {
      console.error('Failed to initialize chat:', e);
      const errorMessage = e?.message || '初始化对话失败，请重试';
      toast.error(errorMessage);
    } finally {
      setInitializingChat(false);
    }
  };

  const handleSelectSession = async (session: CharacterChatSession) => {
    setSelectedSession(session);
    setMemoryStats(null);
    setForkPoint(null);
    await loadMessages(session.id);
    await loadMemoryStats(session.id);
    try {
      await wb.loadSessionStatus(session.id);
    } catch {
    }
    try {
      await pl.loadSessionStatus(session.id);
    } catch {
    }
  };

  const handleNewSession = () => {
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setSuggestions([]);
    setForkPoint(null);
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
    if (!pendingInitialBottomLockRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isGenerating]);

  useEffect(() => {
    if (!selectedSession || messages.length === 0) {
      pendingInitialBottomLockRef.current = false;
      return;
    }

    if (!pendingInitialBottomLockRef.current) {
      return;
    }

    if (performance.now() >= initialBottomLockUntilRef.current) {
      pendingInitialBottomLockRef.current = false;
      return;
    }

    let rafA: number | null = null;
    let rafB: number | null = null;

    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        pendingInitialBottomLockRef.current = false;
      });
    });

    return () => {
      if (rafA !== null) cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [selectedSession, messages.length]);

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
        <CharacterList
          characters={characters}
          processingCharacter={processingCharacter}
          forceShowOverlay={forceShowOverlay}
          showProcessingMessage={showProcessingMessage}
          showImportOptions={showImportOptions}
          showDeleteCharacterConfirm={showDeleteCharacterConfirm}
          t={t}
          onStartChat={handleStartChat}
          onViewProfile={handleStartChat}
          onCreateCharacter={handleCreateCharacter}
          onEditCharacter={handleEditCharacter}
          onDeleteCharacter={handleDeleteCharacter}
          onConfirmDeleteCharacter={confirmDeleteCharacter}
          onSetShowDeleteCharacterConfirm={setShowDeleteCharacterConfirm}
          onImportCharacter={handleImportCharacter}
          onParseAndTranslateCharacter={handleParseAndTranslateCharacter}
          onExportCharacter={handleExportCharacter}
          onStopProcessing={handleStopProcessing}
          onSetShowImportOptions={setShowImportOptions}
        />
      )}

      {viewState === 'edit' && (
        <CharacterEditor
          selectedCharacter={selectedCharacter}
          editingCharacter={editingCharacter}
          onSetEditingCharacter={setEditingCharacter}
          onSave={handleSaveCharacter}
          onCancel={() => { setViewState('list'); setEditingCharacter({}); setSelectedCharacter(null); }}
          onImageUpload={handleImageUpload}
        />
      )}

      {/* {viewState === 'profile' && viewingCharacter && (
        <CharacterProfile
          character={viewingCharacter}
          onBack={() => {
            setViewState('list');
            setViewingCharacter(null);
            // 返回时清除 URL 参数
            navigate('/characters', { replace: true });
          }}
          onStartChat={handleStartChatFromProfile}
          onEdit={handleEditCharacter}
          selectedWorldBookId={selectedWorldBookId}
          setSelectedWorldBookId={setSelectedWorldBookId}
          selectedPlotLineId={selectedPlotLineId}
          setSelectedPlotLineId={setSelectedPlotLineId}
          showWorldBookManager={showWorldBookManager}
          setShowWorldBookManager={setShowWorldBookManager}
          showPlotLineManager={showPlotLineManager}
          setShowPlotLineManager={setShowPlotLineManager}
        />
      )} */}

      {viewState === 'chat' && selectedCharacter && (
        <CharacterChat
          selectedCharacter={selectedCharacter}
          user={user}
          t={t}
          lang={lang}
          models={models}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          sessions={sessions}
          selectedSession={selectedSession}
          setSelectedSession={setSelectedSession}
          handleSelectSession={handleSelectSession}
          handleNewSession={handleNewSession}
          handleDeleteSession={handleDeleteSession}
          isDeleteMode={isDeleteMode}
          setIsDeleteMode={setIsDeleteMode}
          selectedSessions={selectedSessions}
          toggleSessionSelect={toggleSessionSelect}
          handleBatchDelete={handleBatchDelete}
          showDeleteConfirm={showDeleteConfirm}
          setShowDeleteConfirm={setShowDeleteConfirm}
          pendingDelete={pendingDelete}
          confirmDelete={confirmDelete}
          messages={messages}
          setMessages={setMessages}
          loadMessages={loadMessages}
          messagesEndRef={messagesEndRef}
          isGenerating={isGenerating}
          inputValue={inputValue}
          setInputValue={setInputValue}
          attachments={attachments}
          setAttachments={setAttachments}
          uploading={uploading}
          suggestions={suggestions}
          regeneratingMessageIndex={regeneratingMessageIndex}
          currentError={currentError}
          retryMessageContent={retryMessageContent}
          timeoutWarning={timeoutWarning}
          handleSendMessage={handleSendMessage}
          handleSendWithInput={handleSendWithInput}
          handleRegenerate={handleRegenerate}
          handleRetry={handleRetry}
          handleCloseError={handleCloseError}
          handleUpload={handleUpload}
          handleEditMessage={handleEditMessage}
          abortControllerRef={abortControllerRef}
          showModelReasoning={showModelReasoning}
          branches={branches}
          selectedBranch={selectedBranch}
          createBranch={createBranch}
          switchBranch={switchBranch}
          deleteBranch={deleteBranch}
          fetchBranchTree={fetchBranchTree}
          branchTree={branchTree}
          handleStorylineNavigate={handleStorylineNavigate}
          forkPoint={forkPoint}
          clearForkPoint={() => setForkPoint(null)}
          showDeleteBranchConfirm={showDeleteBranchConfirm}
          setShowDeleteBranchConfirm={setShowDeleteBranchConfirm}
          confirmDeleteBranch={confirmDeleteBranch}
          isMixedDeleteMode={isMixedDeleteMode}
          setIsMixedDeleteMode={setIsMixedDeleteMode}
          selectedWholeMessages={selectedWholeMessages}
          selectedMessageParts={selectedMessageParts}
          toggleWholeMessageSelect={toggleWholeMessageSelect}
          toggleMessagePartSelect={toggleMessagePartSelect}
          selectAllPartsInMessage={selectAllPartsInMessage}
          handleMixedDelete={handleMixedDelete}
          showDeleteMixedConfirm={showDeleteMixedConfirm}
          setShowDeleteMixedConfirm={setShowDeleteMixedConfirm}
          confirmDeleteMixed={confirmDeleteMixed}
          clearSelection={clearSelection}
          memoryMode={memoryMode}
          memoryStats={memoryStats}
          compressing={compressing}
          manualCompressMemory={manualCompressMemory}
          dialogueMode={dialogueMode}
          setDialogueMode={setDialogueMode}
          sidebarCollapsed={storylineCollapsed}
          setSidebarCollapsed={setStorylineCollapsed}
          mobileSidebarOpen={mobileSidebarOpen}
          setMobileSidebarOpen={setMobileSidebarOpen}
          initializingChat={initializingChat}
          handleInitiateConversation={handleInitiateConversation}
          wb={wb}
          showWorldBookManager={showWorldBookManager}
          setShowWorldBookManager={setShowWorldBookManager}
          showWorldBookOverview={showWorldBookOverview}
          setShowWorldBookOverview={setShowWorldBookOverview}
          selectedWorldBookId={selectedWorldBookId}
          setSelectedWorldBookId={setSelectedWorldBookId}
          pl={pl}
          showPlotLineManager={showPlotLineManager}
          setShowPlotLineManager={setShowPlotLineManager}
          selectedPlotLineId={selectedPlotLineId}
          setSelectedPlotLineId={setSelectedPlotLineId}
          setViewState={setViewState}
          onBackToList={handleBackToList}
          currentPreset={currentPreset}
          setCurrentPreset={setCurrentPreset}
        />
      )}

    </div>
  );
};


