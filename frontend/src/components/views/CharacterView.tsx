import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useCharacterChat } from '@/hooks/useCharacterChat';
import { useMessageSelection } from '@/hooks/useMessageSelection';
import { Bot, ExternalLink, Settings2 } from 'lucide-react';
import { useWorldBook } from '@/hooks/useWorldBook';
import { usePlotLine } from '@/hooks/usePlotLine';
import { useIsMobile } from '@/hooks/use-mobile';
import { api, invalidateCache } from '@/services/api';
import { toast } from 'sonner';
import { getOCData } from '@/components/ui/custom/OCSettings';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { CharacterList } from './character/CharacterList';
import type { CharacterListItem } from './character/CharacterList';
import { CharacterEditor } from './character/CharacterEditor';
import { CharacterChat } from './character/CharacterChat';
import { WorldBookManager } from '@/components/ui/custom/WorldBookManager';
import { PlotLineManager } from '@/components/ui/custom/PlotLineManager';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import type { Character, Model, User as UserType, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch, GenerationPreset } from '@/types';
import { RoleplayThemeProvider } from '@/contexts/RoleplayThemeContext';
import { getGlobalSillyTavernRuntime } from '@/lib/sillytavern/runtime';

interface CharacterViewProps {
  token: string;
  user: UserType;
  models: Model[];
  t: Record<string, string>;
  systemDefaults?: Record<string, string>;
  onUpdateDefaults?: () => void;
  lang?: 'zh' | 'en';
  isDark?: boolean;
  sidebarCollapsed?: boolean;
  setSidebarCollapsed?: (v: boolean) => void;
  setDockOffset?: (offset: number) => void;
}

type ViewState = 'list' | 'edit' | 'profile' | 'chat';

type InitiateConversationOptions = {
  forceNew?: boolean;
};

const getSessionSortTime = (session: CharacterChatSession): number => {
  const updatedAt = Date.parse(session.updated_at || '');
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(session.created_at || '');
  return Number.isFinite(createdAt) ? createdAt : 0;
};

const sortSessionsByRecentActivity = (items: CharacterChatSession[]): CharacterChatSession[] => (
  [...items].sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a))
);

function uploadCharacterCardWithProgress(
  file: File,
  onProgress: (progress: number) => void,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('file', file);

    xhr.open('POST', '/api/characters/import');
    const token = localStorage.getItem('palink_token');
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        onProgress(35);
        return;
      }
      onProgress(Math.min(90, Math.round((event.loaded / event.total) * 90)));
    };

    xhr.onload = () => {
      let body: any = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = xhr.responseText;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }

      const detail = typeof body === 'object' && body
        ? body.detail || body.message || JSON.stringify(body)
        : body || xhr.statusText || '导入失败';
      reject(new Error(detail));
    };

    xhr.onerror = () => reject(new Error('上传失败，请检查网络或稍后重试'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(formData);
  });
}

export function CharacterView({
  user,
  models,
  t,
  systemDefaults,
  onUpdateDefaults,
  lang,
  setDockOffset,
}: CharacterViewProps) {
  const roleplayContainerRef = useRef<HTMLDivElement>(null);
  const { characterId } = useParams<{ characterId?: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  
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
  const [developerMode, setDeveloperMode] = useState(false);
  const prevModelBeforeDeveloperRef = useRef<string | null>(null);
  const [dialogueMode, setDialogueMode] = useState<'first_person' | 'third_person'>('first_person');
  const [autoGenerateChatImages, setAutoGenerateChatImages] = useState(false);
  const [responseLength, setResponseLength] = useState<string>('medium');
  const [sillyTavernMode, setSillyTavernMode] = useState<'st-native' | 'st-compat' | 'palink-native' | 'classic'>('classic');
  const [loading, setLoading] = useState(true);
  const [listLoadError, setListLoadError] = useState(false);
  
  // models 加载后同步/校验 selectedModel（处理 models 为空、selectedModel 为空、或 selectedModel 指向已删除模型的情况）
  useEffect(() => {
    if (models.length === 0) return;
    if (developerMode) {
      return;
    }
    const isValid = models.some(m => m.id === selectedModel);
    if (!isValid) {
      setSelectedModel(systemDefaults?.default_character_chat_model || models[0].id);
    }
  }, [models, systemDefaults?.default_character_chat_model, selectedModel, developerMode]);
  
  // 对话分支相关状态
  const [branches, setBranches] = useState<CharacterChatSessionBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<CharacterChatSessionBranch | null>(null);
  const [branchTree, setBranchTree] = useState<BranchTree | null>(null);
  const [forkPoint, setForkPoint] = useState<{ branchId: string; messageId: number } | null>(null);
  const [currentPreset, setCurrentPreset] = useState<GenerationPreset | null>(null);

  const [storylineCollapsed, setStorylineCollapsed] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpenRaw] = useState(false);

  // Task 6: 预设切换时触发 ST preset_changed 事件，通知 ST 插件（如预设管理器）
  const handlePresetChange = useCallback((preset: GenerationPreset | null) => {
    setCurrentPreset(preset);
    getGlobalSillyTavernRuntime()?.emitPresetChanged(preset);
  }, []);

  useEffect(() => {
    if (!systemDefaults?.default_character_chat_model) {
      onUpdateDefaults?.();
    }
  }, [onUpdateDefaults, systemDefaults?.default_character_chat_model]);

  const setMobileSidebarOpen = useCallback((open: boolean) => {
    setMobileSidebarOpenRaw(open);
    if (isMobile) {
      setDockOffset?.(open ? 320 : 0);
    }
  }, [isMobile, setDockOffset]);

  useLayoutEffect(() => {
    if (!isMobile) {
      setDockOffset?.(storylineCollapsed ? 0 : 320);
    }
  }, [isMobile, storylineCollapsed, setDockOffset]);

  useEffect(() => {
    return () => {
      setDockOffset?.(0);
    };
  }, [setDockOffset]);

  const [memoryStats, setMemoryStats] = useState<{
    message_count: number;
    token_count: number;
    oldest_message_hours: number;
    compression_needed: boolean;
    compression_reason: string;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  
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
  const [importingCharacters, setImportingCharacters] = useState<CharacterListItem[]>([]);
  const importingCharactersRef = useRef<CharacterListItem[]>([]);
  const importObjectUrlsRef = useRef<Set<string>>(new Set());
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
  const isAtBottomRef = useRef(true);
  const userPausedAutoScrollRef = useRef(false);
  const INITIAL_BOTTOM_LOCK_MS = 1500;

  // Forward-declare loadSessions and loadMemoryStats for hooks
  const loadSessions = useCallback(async (characterId: string) => {
    try {
      const data = await api.get(`/api/characters/${characterId}/sessions`, { cacheTtlMs: 30_000 });
      const sortedSessions = Array.isArray(data) ? sortSessionsByRecentActivity(data) : [];
      setSessions(sortedSessions);
      return sortedSessions;
    } catch (e) {
      console.error('Failed to load sessions:', e);
      return [];
    }
  }, []);

  const autoCompressMemory = useCallback(async (sessionId: string, branchId?: string) => {
    if (loadingSessionRef.current !== sessionId) return;
    try {
      const branchParam = branchId ? `&branch_id=${branchId}` : ``;
      const data = await api.get(`/api/memory/check-auto-compress?session_id=${sessionId}${branchParam}`);
      if (loadingSessionRef.current === sessionId && data.auto_compressed) {
        // Auto-compression completed; memory stats remain valid for this load.
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.error('Auto compress failed:', e);
      }
    }
  }, []);

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
  }, [autoCompressMemory]);

  const handleClearForkPoint = useCallback(() => setForkPoint(null), []);

  const handleBranchCreated = useCallback((branch: { id: string; branch_name: string; is_active: boolean; session_id?: string; parent_branch_id?: string | null; parent_message_id?: number | null; created_at?: string }) => {
    setSelectedBranch({
      id: branch.id,
      branch_name: branch.branch_name,
      is_active: branch.is_active,
      session_id: branch.session_id || selectedSession?.id || '',
      parent_branch_id: branch.parent_branch_id || null,
      parent_message_id: branch.parent_message_id || null,
      created_at: branch.created_at || new Date().toISOString(),
    });
  }, [selectedSession?.id]);

  // PlotLine 阶段自动推进事件处理：刷新会话状态以更新当前阶段显示
  const handlePlotLineAdvanced = useCallback((data: { new_stage: { stage_index: number; title: string; summary: string }; session_id?: string }) => {
    const sessionId = data.session_id || selectedSession?.id;
    if (sessionId) {
      pl.loadSessionStatus(sessionId).catch(e => {
        console.warn('[CharacterView] 刷新 PlotLine 会话状态失败:', e);
      });
    }
  }, [pl, selectedSession?.id]);

  const handleEditorCancel = useCallback(() => {
    setViewState('list');
    setEditingCharacter({});
    setSelectedCharacter(null);
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
    generatingImageMessageIds,
    currentError,
    retryMessageContent,
    timeoutWarning,
    handleSendMessage,
    handleSmartCardTrigger,
    handleSendWithInput,
    handleRegenerate,
    handleContinue,
    handleRetry,
    handleCloseError,
    handleUpload,
    handleDeleteMessage,
    handleEditMessage,
    handleGenerateImage,
    handleStopGeneration,
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
    onForkCreated: handleClearForkPoint,
    onBranchCreated: handleBranchCreated,
    responseLength,
    onPlotLineAdvanced: handlePlotLineAdvanced,
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
    if (developerMode) {
      if (prevModelBeforeDeveloperRef.current === null) {
        prevModelBeforeDeveloperRef.current = selectedModel;
      }
      setSelectedModel((current) => (current === 'local:test-model' ? current : 'local:test-model'));
      return;
    }

    const newDefaultModel = systemDefaults?.default_character_chat_model || models[0]?.id || '';
    if (prevModelBeforeDeveloperRef.current !== null) {
      const restored = prevModelBeforeDeveloperRef.current;
      prevModelBeforeDeveloperRef.current = null;
      setSelectedModel((current) => (current === restored ? current : restored));
      return;
    }
    setSelectedModel(newDefaultModel);
  }, [systemDefaults, models, developerMode]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => cleanupTimeout();
  }, [cleanupTimeout]);

  const fetchUserSettings = useCallback(async () => {
    try {
      const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
      setDeveloperMode(settings.developer_mode === true);
      setShowModelReasoning(settings.show_model_reasoning || false);
      setMemoryMode(settings.memory_mode || 'rule');
      setCharacterDisplayMode(settings.character_display_mode || 'framed');
      setAutoGenerateChatImages(settings.auto_generate_chat_images || false);
      setSillyTavernMode(settings.silly_tavern_mode || 'classic');
    } catch (e) {
      console.error('Failed to fetch user settings:', e);
    }
  }, []);

  const pollCharacterStatusRef = useRef<((characterId: string, autoTranslate?: boolean) => Promise<void>) | null>(null);

  async function loadCharacters() {
    try {
      // fields=basic: 列表裁剪大字段（first_mes/mes_example/creator_notes 等），
      // 进入聊天/详情时 handleStartChat 会自动 GET /api/characters/{id} 拉取完整卡
      const data = await api.get('/api/characters?fields=basic', { cacheTtlMs: 30_000 });
      setCharacters(data);
      setListLoadError(false);

      // 如果有characterId参数，自动打开对应的角色介绍页面
      // if (characterId) {
      //   const targetCharacter = data.find((c: Character) => c.id === characterId);
      //   if (targetCharacter) {
      //     handleViewProfile(targetCharacter);
      //   }
      // }

      const processingChar = data.find((c: any) => c.is_processing);
      if (processingChar) {
        setProcessingCharacter((currentProcessingCharacter) => {
          if (!currentProcessingCharacter) {
            pollCharacterStatusRef.current?.(processingChar.id);
            return processingChar.id;
          }
          return currentProcessingCharacter;
        });
      }
    } catch (e) {
      console.error('Failed to load characters:', e);
      setListLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  // 重试加载角色列表：先强制清掉可能缓存住的空结果，再重新拉取
  const retryLoadCharacters = useCallback(() => {
    invalidateCache('/api/characters');
    setListLoadError(false);
    setLoading(true);
    return loadCharacters();
    // loadCharacters 是组件内普通函数，仅首次挂载使用；这里刻意不依赖其引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (e.detail?.autoGenerateChatImages !== undefined) {
        setAutoGenerateChatImages(e.detail.autoGenerateChatImages);
      }
      if (e.detail?.sillyTavernMode !== undefined) {
        setSillyTavernMode(e.detail.sillyTavernMode);
      }
    };
    window.addEventListener('userSettingsUpdated', handleSettingsUpdate);
    return () => window.removeEventListener('userSettingsUpdated', handleSettingsUpdate);
    // Run once on mount; including wb/loadCharacters creates a request loop because the hook return object is not memoized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadBranches = useCallback(async (sessionId: string) => {
    try {
      const data = await api.get(`/api/character-sessions/${sessionId}/branches`);
      setBranches(data);
      
      // 优先选择 is_active 的分支
      const active = data.find((b: CharacterChatSessionBranch) => b.is_active);
      if (active) {
        setSelectedBranch(active);
      } else if (data.length > 0) {
        // 如果没有 is_active 的分支，选择最新的分支（按 created_at 或 last_message_at 排序）
        const sortedBranches = [...data].sort((a, b) => {
          const timeA = a.last_message_at || a.created_at || '';
          const timeB = b.last_message_at || b.created_at || '';
          return new Date(timeB).getTime() - new Date(timeA).getTime();
        });
        setSelectedBranch(sortedBranches[0]);
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    }
  }, []);

  const createBranch = async (_branchName?: string) => {
    if (!selectedSession) return;
    try {
      // 如果有 forkPoint，从指定节点创建分支；否则创建同级分支
      const payload: any = {
        session_id: selectedSession.id,
      };

      if (forkPoint) {
        // 从指定节点分叉
        payload.parent_branch_id = forkPoint.branchId;
        payload.parent_message_id = forkPoint.messageId;
        payload.same_level = false;
      } else {
        // 创建同级分支
      payload.same_level = true;
      }

      const resp = await api.post(`/api/character-sessions/${selectedSession.id}/branches`, payload);
      const branchName = resp?.branch?.branch_name || '新分支';

      if (forkPoint) {
        toast.success(`从节点创建分支 "${branchName}"`);
        setForkPoint(null); // 清除 forkPoint
      } else {
        toast.success(`分支 "${branchName}" 已创建`);
      }

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
      const data = await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branch.id}/switch?limit=10`);
      setSelectedBranch(branch);
      setMessages(data.messages || []);
      setHasMoreMessages(data.has_more || false);
      setForkPoint(null);
      await Promise.all([
        loadBranches(selectedSession.id),
        loadMemoryStats(selectedSession.id, branch.id),
      ]);
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
        setHasMoreMessages(false);
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
      const isFork = messageId !== null && !isLeaf;
      const limit = messageId !== null ? 20 : 10;
      const params = messageId !== null ? `?up_to_message_id=${messageId}&limit=${limit}` : `?limit=${limit}`;
      const data = await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branchId}/switch${params}`);
      setMessages(data.messages || []);
      setHasMoreMessages(data.has_more || false);
      isAtBottomRef.current = true;
      userPausedAutoScrollRef.current = false;

      if (messageId !== null && !isLeaf) {
        setForkPoint({ branchId, messageId });
      } else {
        setForkPoint(null);
      }

      const branchesData = await api.get(`/api/character-sessions/${selectedSession.id}/branches`);
      setBranches(branchesData);
      const activeBranch = branchesData.find((b: CharacterChatSessionBranch) => b.is_active);
      if (activeBranch) {
        setSelectedBranch(activeBranch);
      }

      await Promise.all([
        loadMemoryStats(selectedSession.id, branchId),
        (async () => {
          try {
            const treeData = await api.get(`/api/character-sessions/${selectedSession.id}/branch-tree`, { cacheTtlMs: 15_000 });
            setBranchTree(treeData);
          } catch {
            // Branch tree refresh is best-effort alongside message loading.
          }
        })(),
      ]);
    } catch (e) {
      console.error('Failed to navigate storyline:', e);
    }
  }, [selectedSession, loadMemoryStats]);

  const loadMessages = useCallback(async (sessionId: string) => {
    loadingSessionRef.current = sessionId;
    try {
      setSuggestions([]);
      setMemoryStats(null);
      setBranches([]);
      setSelectedBranch(null);
      setBranchTree(null);
      setForkPoint(null);
      setHasMoreMessages(false);

      const data = await api.get(`/api/character-sessions/${sessionId}/messages?limit=10`, { cacheTtlMs: 10_000 });
      if (loadingSessionRef.current !== sessionId) return;
      setMessages(data.messages);
      setHasMoreMessages(data.has_more || false);

      isAtBottomRef.current = true;
      pendingInitialBottomLockRef.current = (data.messages || []).length > 0;
      initialBottomLockUntilRef.current = performance.now() + INITIAL_BOTTOM_LOCK_MS;
      
      await Promise.all([
        loadMemoryStats(sessionId),
        loadBranches(sessionId),
        (async () => {
          try {
            const treeData = await api.get(`/api/character-sessions/${sessionId}/branch-tree`, { cacheTtlMs: 15_000 });
            if (loadingSessionRef.current === sessionId) {
              setBranchTree(treeData);
            }
          } catch (e) {
            console.error('Failed to load branch tree:', e);
          }
        })(),
      ]);
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, [loadMemoryStats, loadBranches, setSuggestions]);

  const loadOlderMessages = useCallback(async () => {
    if (!selectedSession || !hasMoreMessages || isLoadingOlderMessages || messages.length === 0) return;
    setIsLoadingOlderMessages(true);
    try {
      const oldestId = messages[0]?.id;
      if (!oldestId) return;
      const data = await api.get(`/api/character-sessions/${selectedSession.id}/messages?limit=10&before_id=${oldestId}`);
      if (data.messages && data.messages.length > 0) {
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const newMsgs = data.messages.filter((m: CharacterChatMessage) => !existingIds.has(m.id));
          return [...newMsgs, ...prev];
        });
      }
      setHasMoreMessages(data.has_more || false);
    } catch (e) {
      console.error('Failed to load older messages:', e);
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }, [selectedSession, hasMoreMessages, isLoadingOlderMessages, messages]);

  const manualCompressMemory = async () => {
    if (!selectedSession?.id || compressing) return;
    setCompressing(true);
    try {
      const data = await api.post('/api/memory/compress', {
        session_id: selectedSession.id,
        branch_id: selectedBranch?.id,
        compression_ratio: 0.5
      });
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
      user_nickname: '',
      alternate_greetings: [],
      creator_notes: '',
      post_history_instructions: ''
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
        // Task 6: 触发 character_edited 事件，通知 ST 插件角色卡已更新
        getGlobalSillyTavernRuntime()?.emitCharacterEdited(String(selectedCharacter.id));
      } else {
        await api.post(url, editingCharacter);
      }
      
      invalidateCache('/api/characters');
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
      invalidateCache('/api/characters');
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
    const taskId = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const placeholderId = `__importing_${taskId}`;
    const avatarUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
    if (avatarUrl) {
      importObjectUrlsRef.current.add(avatarUrl);
    }

    const updateImporting = (patch: Partial<CharacterListItem>) => {
      setImportingCharacters((prev) => prev.map((c) => (
        c.id === placeholderId ? { ...c, ...patch } : c
      )));
    };

    const removeImporting = () => {
      setImportingCharacters((prev) => prev.filter((c) => c.id !== placeholderId));
      if (avatarUrl) {
        URL.revokeObjectURL(avatarUrl);
        importObjectUrlsRef.current.delete(avatarUrl);
      }
    };

    const openImportedCharacter = async (characterId: string | undefined) => {
      if (!characterId) return;
      try {
        invalidateCache('/api/characters');
        const freshCharacter = await api.get<Character>(`/api/characters/${characterId}`);
        setCharacters((prev) => {
          const exists = prev.some((character) => character.id === freshCharacter.id);
          return exists
            ? prev.map((character) => character.id === freshCharacter.id ? freshCharacter : character)
            : [freshCharacter, ...prev];
        });
        await handleStartChat(freshCharacter);
      } catch (error) {
        console.warn('Failed to open imported character:', error);
        routeCharacterSyncRef.current = null;
        navigate(`/characters/${characterId}`);
      }
    };

    // 创建占位角色并添加到列表顶部
    const now = new Date().toISOString();
    setImportingCharacters((prev) => [
      {
        id: placeholderId,
        name: file.name,
        description: '',
        avatar: '',
        created_at: now,
        updated_at: now,
        _importing: true,
        _progress: 0,
        _status: 'uploading',
        _message: '正在上传角色卡...',
        _fileName: file.name,
        _avatarUrl: avatarUrl,
      } as CharacterListItem,
      ...prev,
    ]);

    try {
      const result: any = await uploadCharacterCardWithProgress(file, (progress) => {
        updateImporting({
          _progress: progress,
          _status: 'uploading',
          _message: `正在上传角色卡... ${progress}%`,
        });
      });
      updateImporting({
        _progress: 95,
        _status: 'processing',
        _message: '上传完成，正在解析角色卡...',
      });

      invalidateCache('/api/characters');
      if (result.auto_parsed) {
        toast.info('已自动从图片解析角色信息');
        await loadCharacters();
        if (result.character?.id) {
          setShowImportOptions(result.character.id);
          await openImportedCharacter(result.character.id);
        }
      } else {
        await loadCharacters();
        if (result.character?.has_character_book && result.character?.worldbook_entry_count > 0) {
          toast.success(`角色导入成功！已同时导入世界书（${result.character.worldbook_entry_count} 个条目）`);
          wb.loadWorldBooks(result.character.id);
        }
        if (result.character?.id) {
          setShowImportOptions(result.character.id);
          await openImportedCharacter(result.character.id);
        }
      }

      // 标记成功并立即移除占位角色（不依赖 setTimeout，避免 iOS 卡住）
      updateImporting({
        _progress: 100,
        _status: 'success',
        _message: '导入完成，角色卡已创建。',
      });
      removeImporting();
    } catch (e: any) {
      console.error('Failed to import character:', e);
      const detail = e?.message || '导入失败';
      updateImporting({
        _progress: 100,
        _status: 'error',
        _message: detail,
      });
      if (detail.includes('AI 生成图片') || detail.includes('从图片解析')) {
        const confirmParse = window.confirm(
          detail + '\n\n是否要使用「从图片解析角色」功能，通过 AI 自动分析这张图片并创建角色？'
        );
        if (confirmParse) {
          try {
            updateImporting({
              _progress: 100,
              _status: 'processing',
              _message: '正在从图片解析角色...',
            });
            const reader = new FileReader();
            reader.onload = async (event) => {
              const base64 = event.target?.result as string;
              try {
                const parseResult: any = await api.post('/api/characters/import-parse-image', { image_url: base64, model: selectedModel });
                if (parseResult.character_id) {
                  toast.success('角色创建成功！正在解析图片...');
                  updateImporting({
                    _progress: 100,
                    _status: 'success',
                    _message: '已创建临时角色，正在解析图片内容...',
                  });
                  removeImporting();
                  setProcessingCharacter(parseResult.character_id);
                  pollCharacterStatus(parseResult.character_id, true);
                }
              } catch (parseErr: any) {
                const parseDetail = parseErr?.message || '图片解析失败';
                updateImporting({
                  _progress: 100,
                  _status: 'error',
                  _message: parseDetail,
                });
                toast.error(parseDetail);
              }
            };
            reader.readAsDataURL(file);
          } catch (err: any) {
            updateImporting({
              _progress: 100,
              _status: 'error',
              _message: '读取文件失败',
            });
            toast.error('读取文件失败');
          }
        }
      } else {
        toast.error(detail);
      }
    }
  };

  // 关闭导入失败占位卡（用户手动关闭）
  const handleCloseImporting = useCallback((id: string) => {
    setImportingCharacters((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target?._avatarUrl) {
        URL.revokeObjectURL(target._avatarUrl);
        importObjectUrlsRef.current.delete(target._avatarUrl);
      }
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  const handleParseAndTranslateCharacter = async (characterId: string) => {
    try {
      setProcessingCharacter(characterId);
      setForceShowOverlay(characterId);
      setShowImportOptions(null);
      
      setShowProcessingMessage({ show: true, message: '正在解析角色...' });
      
      await api.post('/api/characters/parse', { character_id: characterId, model: selectedModel });
      
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
      invalidateCache('/api/characters');
      await loadCharacters();
      setShowProcessingMessage({ show: true, message: 'Processing stopped' });
      setTimeout(() => {
        setShowProcessingMessage({ show: false, message: '' });
      }, 3000);
    } catch (e) {
      console.error('Failed to stop processing:', e);
    }
  };

  const pollCharacterStatus = useCallback(async (characterId: string, autoTranslate: boolean = false) => {
    
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    
    let translationStarted = false;
    
    const interval = setInterval(async () => {
      try {
        const status = await api.get(`/api/characters/${characterId}/status`);
          
        if (!status.is_processing) {
          
          if (autoTranslate && !translationStarted && !status.processing_status?.includes('失败')) {
            translationStarted = true;
            setShowProcessingMessage({ show: true, message: t.translation_started || '已经开始翻译，请稍候...' });
            
            try {
              await api.post('/api/characters/translate', { character_id: characterId, target_language: 'zh', model: selectedModel });
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
          
          clearInterval(interval);
          if (pollingIntervalRef.current === interval) {
            pollingIntervalRef.current = null;
          }
          
          setProcessingCharacter(null);
          setForceShowOverlay(null);
          invalidateCache('/api/characters');
          await loadCharacters();
          if (selectedCharacter?.id === characterId) {
            try {
              const charData = await api.get(`/api/characters/${characterId}`, { cacheTtlMs: 30_000 });
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
  }, [selectedCharacter?.id, selectedModel, t]);

  pollCharacterStatusRef.current = pollCharacterStatus;

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

  const wbRef = useRef(wb);
  wbRef.current = wb;

  const handleStartChat = useCallback(async (character: Character) => {
    routeCharacterSyncRef.current = character.id;
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setSuggestions([]);
    setForkPoint(null);
    setBranches([]);
    setSelectedBranch(null);
    setBranchTree(null);
    setHasMoreMessages(false);

    // 角色详情与会话列表并行拉取（弱网下显著缩短进入聊天的时间）
    const [detail, loadedSessions] = await Promise.all([
      api.get(`/api/characters/${character.id}`, { cacheTtlMs: 30_000 }).catch((error) => {
        console.warn('Failed to preload full character details before chat:', error);
        return null;
      }),
      loadSessions(character.id),
    ]);

    const fullCharacter = detail && typeof detail === 'object'
      ? { ...character, ...detail }
      : character;
    setSelectedCharacter(fullCharacter);
    wbRef.current.loadWorldBooks(fullCharacter.id);
    setViewState('chat');
    const latestSession = loadedSessions[0];
    if (latestSession?.id) {
      setSelectedSession(latestSession);
      await loadMessages(latestSession.id);
    }
    if (characterId !== fullCharacter.id) {
      navigate(`/characters/${fullCharacter.id}`);
    }
  }, [loadSessions, loadMessages, navigate, characterId, setSuggestions]);

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

  const handleInitiateConversation = async (initialMessage?: string, options: InitiateConversationOptions = {}): Promise<{
    session: CharacterChatSession | null;
    branchId?: string | null;
  } | null> => {
    if (!selectedCharacter) {
      toast.error('请先选择一个角色');
      return null;
    }

    const initialUserMessage = initialMessage?.trim() || '';
    setInitializingChat(true);

    try {
      if (!options.forceNew && sessions.length > 0) {
        const lastSession = sortSessionsByRecentActivity(sessions)[0];
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
        if (initialUserMessage) {
          setInitializingChat(false);
          await handleSendMessage(initialUserMessage, [], {
            sessionOverride: lastSession,
            ignorePendingAttachments: true,
          });
        }
        return { session: lastSession, branchId: selectedBranch?.id ?? null };
      }

      if (selectedCharacter.first_mes && selectedCharacter.first_mes.trim()) {
        const controller = new AbortController();
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
        }, { signal: controller.signal });

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('无法读取响应流');
        }

        const decoder = new TextDecoder();
        let sessionId = '';
        let branchId = '';
        let buffer = '';

        try {
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
                } catch {
                  // Ignore malformed initialization events and continue reading.
                }
              }
            }
          }
        } catch (readError: any) {
          if (readError?.name === 'AbortError') {
            return null;
          }
          throw readError;
        }

        if (!sessionId) {
          throw new Error('未能获取会话ID');
        }

        await loadSessions(selectedCharacter.id);
        const newSession = {
          id: sessionId,
          title: selectedCharacter.name,
          character_id: selectedCharacter.id,
          user_id: typeof user.id === 'number' ? user.id : Number(user.id),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          dialogue_mode: dialogueMode
        };
        setSelectedSession(newSession);
        // K-6 修复: 对齐 ST script.js:7672 —— 新聊天创建成功后触发 chat_created（无参），
        // quick-reply 的"新聊天自动执行"依赖该事件。
        try {
          getGlobalSillyTavernRuntime()?.getEventSource().emit('chat_created');
        } catch { /* 运行时未初始化时静默跳过 */ }
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
        if (initialUserMessage) {
          setInitializingChat(false);
          await handleSendMessage(initialUserMessage, [], {
            sessionOverride: newSession,
            branchIdOverride: branchId || null,
            ignorePendingAttachments: true,
          });
        }
        return { session: newSession, branchId: branchId || null };
      } else if (initialUserMessage) {
        setInitializingChat(false);
        await handleSendMessage(initialUserMessage, [], { ignorePendingAttachments: true });
        return { session: selectedSession, branchId: selectedBranch?.id ?? null };
      } else {
        const pendingSession: CharacterChatSession = {
          id: '__pending__',
          character_id: selectedCharacter.id,
          dialogue_mode: dialogueMode,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setSelectedSession(pendingSession);
        setMessages([]);
        return { session: pendingSession, branchId: null };
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return null;
      }
      console.error('Failed to initialize chat:', e);
      const errorMessage = e?.message || '初始化对话失败，请重试';
      toast.error(errorMessage);
      return null;
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
      // World book status is optional for opening a session.
    }
    try {
      await pl.loadSessionStatus(session.id);
    } catch {
      // Plot line status is optional for opening a session.
    }
  };

  // Galgame 插件桥接事件：openCharacterChat（palink:switchChat）、分支切换
  // （palink:switchBranch）、COT swipe 写回（palink:chatMessagesUpdated）。
  const handleSelectSessionRef = useRef(handleSelectSession);
  useEffect(() => {
    handleSelectSessionRef.current = handleSelectSession;
  });

  useEffect(() => {
    const onSwitchChat = async (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string }>).detail;
      if (!detail?.chatId) return;
      const session = sessions.find((s) => s.id === detail.chatId);
      if (session) await handleSelectSessionRef.current(session);
    };
    const onSwitchBranch = async (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; branchId?: string }>).detail;
      if (!detail?.sessionId || !selectedSession || detail.sessionId !== selectedSession.id) return;
      // 后端已完成分支切换（checkpoint-go/branch-create），前端刷新消息与分支树即可
      await loadMessages(selectedSession.id).catch(() => undefined);
      loadBranches(selectedSession.id).catch(() => undefined);
    };
    const onChatMessagesUpdated = () => {
      if (selectedSession) {
        loadMessages(selectedSession.id).catch(() => undefined);
      }
    };
    window.addEventListener('palink:switchChat', onSwitchChat);
    window.addEventListener('palink:switchBranch', onSwitchBranch);
    window.addEventListener('palink:chatMessagesUpdated', onChatMessagesUpdated);
    return () => {
      window.removeEventListener('palink:switchChat', onSwitchChat);
      window.removeEventListener('palink:switchBranch', onSwitchBranch);
      window.removeEventListener('palink:chatMessagesUpdated', onChatMessagesUpdated);
    };
  }, [sessions, selectedSession, loadBranches, loadMessages]);

  const handleNewSession = () => {
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setHasMoreMessages(false);
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
        invalidateCache(`/api/characters/${selectedCharacter!.id}/sessions`);
        await loadSessions(selectedCharacter!.id);
        
        if (selectedSession && selectedSessions.has(selectedSession.id)) {
          setSelectedSession(null);
          setMessages([]);
          setHasMoreMessages(false);
          setMemoryStats(null);
        }
      } else if (pendingDelete.type === 'single') {
        await api.delete(`/api/character-sessions/${pendingDelete.id}`);
        invalidateCache(`/api/characters/${selectedCharacter!.id}/sessions`);
        await loadSessions(selectedCharacter!.id);
        if (selectedSession?.id === pendingDelete.id) {
          setSelectedSession(null);
          setMessages([]);
          setHasMoreMessages(false);
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
    if (!pendingInitialBottomLockRef.current && isAtBottomRef.current && !userPausedAutoScrollRef.current) {
      const el = messagesEndRef.current;
      if (el) {
        const scroller = el.parentElement;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }
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
        const el = messagesEndRef.current;
        if (el) {
          const scroller = el.parentElement;
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }
        pendingInitialBottomLockRef.current = false;
      });
    });

    return () => {
      if (rafA !== null) cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [selectedSession, messages.length]);

  useEffect(() => {
    if (!initializingChat && messages.length > 0 && selectedSession) {
      requestAnimationFrame(() => {
        const el = messagesEndRef.current;
        if (el) {
          const scroller = el.parentElement;
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }
      });
    }
  }, [initializingChat, messages.length, selectedSession]);

  useEffect(() => {
    return () => {
      stopPolling();
      importObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      importObjectUrlsRef.current.clear();
    };
  }, []);

  // iOS 安全网：页面恢复可见时，检查是否有已完成但未替换的占位角色，
  // 重新加载角色列表并清理这些占位角色。避免因页面不可见时 await 被暂停导致卡住。
  useEffect(() => {
    importingCharactersRef.current = importingCharacters;
  }, [importingCharacters]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const current = importingCharactersRef.current;
      const completed = current.filter((c) => c._importing && c._status === 'success');
      if (completed.length === 0) return;

      // 有已完成的占位卡未清理，重新加载角色列表并移除它们
      invalidateCache('/api/characters');
      loadCharacters();

      // 清理对应的 object URLs
      completed.forEach((c) => {
        if (c._avatarUrl) {
          URL.revokeObjectURL(c._avatarUrl);
          importObjectUrlsRef.current.delete(c._avatarUrl);
        }
      });
      setImportingCharacters((prev) => prev.filter(
        (c) => !(c._importing && c._status === 'success')
      ));
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    const active = viewState === 'chat' && !!selectedCharacter && sillyTavernMode === 'st-native';
    window.dispatchEvent(new CustomEvent('palink:stNativeActiveChanged', { detail: { active } }));
    return () => {
      window.dispatchEvent(new CustomEvent('palink:stNativeActiveChanged', { detail: { active: false } }));
    };
  }, [selectedCharacter, sillyTavernMode, viewState]);

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
    <RoleplayThemeProvider containerRef={roleplayContainerRef}>
      <div ref={roleplayContainerRef} className="roleplay-container flex w-full h-full">
        {viewState === 'list' && (
        <CharacterList
          characters={[...importingCharacters, ...characters] as CharacterListItem[]}
          loadFailed={listLoadError}
          onRetry={retryLoadCharacters}
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
          onCloseImporting={handleCloseImporting}
        />
      )}

      {viewState === 'edit' && (
        <CharacterEditor
          selectedCharacter={selectedCharacter}
          editingCharacter={editingCharacter}
          onSetEditingCharacter={setEditingCharacter}
          onSave={handleSaveCharacter}
          onCancel={handleEditorCancel}
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
          systemDefaults={systemDefaults}
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
          hasMoreMessages={hasMoreMessages}
          loadOlderMessages={loadOlderMessages}
          isLoadingOlderMessages={isLoadingOlderMessages}
          messagesEndRef={messagesEndRef}
          isAtBottomRef={isAtBottomRef}
          userPausedAutoScrollRef={userPausedAutoScrollRef}
          isGenerating={isGenerating}
          inputValue={inputValue}
          setInputValue={setInputValue}
          attachments={attachments}
          setAttachments={setAttachments}
          uploading={uploading}
          suggestions={suggestions}
          regeneratingMessageIndex={regeneratingMessageIndex}
          generatingImageMessageIds={generatingImageMessageIds}
          currentError={currentError}
          retryMessageContent={retryMessageContent}
          timeoutWarning={timeoutWarning}
          handleSendMessage={handleSendMessage}
          handleSmartCardTrigger={handleSmartCardTrigger}
          handleSendWithInput={handleSendWithInput}
          handleRegenerate={handleRegenerate}
          handleContinue={handleContinue}
          handleRetry={handleRetry}
          handleCloseError={handleCloseError}
          handleUpload={handleUpload}
          handleDeleteMessage={handleDeleteMessage}
          handleEditMessage={handleEditMessage}
          handleGenerateImage={handleGenerateImage}
          handleStopGeneration={handleStopGeneration}
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
          clearForkPoint={handleClearForkPoint}
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
          autoGenerateChatImages={autoGenerateChatImages}
          setAutoGenerateChatImages={setAutoGenerateChatImages}
          responseLength={responseLength}
          setResponseLength={setResponseLength}
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
          setCurrentPreset={handlePresetChange}
          sillyTavernMode={sillyTavernMode}
          characterDisplayMode={characterDisplayMode}
        />
      )}

      </div>
    </RoleplayThemeProvider>
  );
};


