import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useCharacterChat } from '@/hooks/useCharacterChat';
import { useMessageSelection } from '@/hooks/useMessageSelection';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorldBook } from '@/hooks/useWorldBook';
import { usePlotLine } from '@/hooks/usePlotLine';
import { api } from '@/services/api';
import { getOCData } from '@/components/ui/custom/OCSettings';
import { CharacterList } from './character/CharacterList';
import { CharacterEditor } from './character/CharacterEditor';
import { CharacterChat } from './character/CharacterChat';
// import { CharacterProfile } from './character/CharacterProfile';
import { WorldBookManager } from '@/components/ui/custom/WorldBookManager';
import { PlotLineManager } from '@/components/ui/custom/PlotLineManager';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import type { Character, Model, User as UserType, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch } from '@/types';

interface CharacterViewProps {
  token: string;
  user: UserType;
  models: Model[];
  t: Record<string, string>;
  systemDefaults?: Record<string, string>;
  lang?: 'zh' | 'en';
  isDark?: boolean;
}

type ViewState = 'list' | 'edit' | 'profile' | 'chat';

export const CharacterView: React.FC<CharacterViewProps> = ({
  token: _token,
  user,
  models,
  t,
  systemDefaults,
  lang,
  isDark = false
}) => {
  const { characterId } = useParams<{ characterId?: string }>();
  const navigate = useNavigate();
  
  const [viewState, setViewState] = useState<ViewState>('list');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [viewingCharacter, setViewingCharacter] = useState<Character | null>(null);
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
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [showWorldBookManager, setShowWorldBookManager] = useState(false);
  const [showWorldBookOverview, setShowWorldBookOverview] = useState(false);
  const [selectedWorldBookId, setSelectedWorldBookId] = useState<string | null>(null);
  
  // World Book hook
  const [showPlotLineManager, setShowPlotLineManager] = useState(false);
  const [selectedPlotLineId, setSelectedPlotLineId] = useState<string | null>(null);

  // World Book hook
  const wb = useWorldBook();
  // PlotLine hook
  const pl = usePlotLine();
  
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

  // 鈹€鈹€ Chat hook 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
    uiLanguage: lang,
  });

  // 鈹€鈹€ Message selection hook 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
    } catch (e) {
      console.error('Failed to fetch user settings:', e);
    }
  };

  const loadCharacters = async () => {
    try {
      const data = await api.get('/api/characters');
      setCharacters(data);
      
      // 如果有 characterId 参数，自动打开对应的角色介绍页面
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
      // POST response already contains the full branch history
      const data = await api.post(`/api/character-sessions/${selectedSession.id}/branches/${branchId}/switch`);
      setMessages(data.messages || []);
      await loadBranches(selectedSession.id); // also sets selectedBranch to active
      await loadMemoryStats(selectedSession.id, branchId);
      // Refresh branch tree so storyline map shows updated active node
      try {
        const treeData = await api.get(`/api/character-sessions/${selectedSession.id}/branch-tree`);
        setBranchTree(treeData);
      } catch {}
    } catch (e) {
      console.error('Failed to navigate storyline:', e);
    }
  }, [selectedSession, loadBranches, loadMemoryStats]);

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const data = await api.get(`/api/character-sessions/${sessionId}/messages`);
      setMessages(data);
      setSuggestions([]);
      
      await loadMemoryStats(sessionId);
      await loadBranches(sessionId);
      
      // 角色扮演禁用推荐对话功能（节省tokens）
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
        branch_id: selectedBranch?.id,
        compression_ratio: 0.5
      });
      alert(`记忆压缩完成！\n删除: ${data.compressed_count} 条\n保留: ${data.remaining_count} 条\n摘要: ${data.summary}`);
      await loadMemoryStats(selectedSession.id, selectedBranch?.id);
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

  const handleParseAndTranslateCharacter = async (characterId: string) => {
    console.log('[handleParseAndTranslateCharacter] Starting for character:', characterId, 'selectedModel:', selectedModel);
    try {
      setProcessingCharacter(characterId);
      setForceShowOverlay(characterId);
      setShowImportOptions(null);
      
      setShowProcessingMessage({ show: true, message: '已经开始解析，请稍候...' });
      
      console.log('[handleParseAndTranslateCharacter] Calling parse API...');
      await api.post('/api/characters/parse', { character_id: characterId, model: selectedModel });
      console.log('[handleParseAndTranslateCharacter] Parse API called successfully');
      
      pollCharacterStatus(characterId, true);
    } catch (e: any) {
      console.error('[handleParseAndTranslateCharacter] Failed:', e);
      setShowProcessingMessage({ show: true, message: '处理失败: ' + (e.message || '') });
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

  const pollCharacterStatus = async (characterId: string, autoTranslate: boolean = false) => {
    console.log('[pollCharacterStatus] Starting poll for character:', characterId, 'autoTranslate:', autoTranslate);
    
    if (pollingInterval) {
      clearInterval(pollingInterval);
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
            setShowProcessingMessage({ show: true, message: '已经开始翻译，请稍候...' });
            
            try {
              await api.post('/api/characters/translate', { character_id: characterId, target_language: 'zh', model: selectedModel });
              console.log('[pollCharacterStatus] Translation API called successfully');
              pollCharacterStatus(characterId, false);
            } catch (translateError: any) {
              console.error('[pollCharacterStatus] Translation failed:', translateError);
              setShowProcessingMessage({ show: true, message: '翻译失败: ' + (translateError.message || '') });
              clearInterval(interval);
              if (pollingInterval === interval) {
                setPollingInterval(null);
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
          if (pollingInterval === interval) {
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

  const handleViewProfile = (character: Character) => {
    handleStartChat(character);
  };

  const handleStartChatFromProfile = async () => {
    if (!viewingCharacter) return;
    
    setSelectedCharacter(viewingCharacter);
    setSelectedSession(null);
    setMessages([]);
    setMemoryStats(null);
    setSuggestions([]);
    await loadSessions(viewingCharacter.id);
    
    setViewState('chat');
  };

  const handleInitiateConversation = async (initialMessage?: string) => {
    if (!selectedCharacter) return;
    
    setInitializingChat(true);
    
    try {
      // 濡傛灉娌℃湁鐜版湁浼氳瘽锛屽苟涓旇鑹叉湁绗竴鏉℃秷鎭紝鍒涘缓涓€涓柊浼氳瘽鏉ュ垵濮嬪寲
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
          // Associate plot line if selected
          if (selectedPlotLineId) {
            try {
              await pl.associateSession(data.session_id, selectedPlotLineId);
              await pl.loadSessionStatus(data.session_id);
            } catch (err) {
              console.error('Failed to associate plot line:', err);
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
    // Load plot line status for this session
    try {
      await pl.loadSessionStatus(session.id);
    } catch {
      // Session may not have a plot line associated
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

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const mobilePageBgClass = isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]';
  const rootBgClass = isMobile ? mobilePageBgClass : 'bg-background';

  if (loading) {
    return (
      <div className={cn('relative flex h-full overflow-hidden items-center justify-center', rootBgClass, isDark && 'dark')}>
        <div className="animate-spin text-primary">
          <Bot size={32} />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative flex h-full overflow-hidden', rootBgClass, isDark && 'dark')}>
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
          onViewProfile={handleViewProfile}
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
          showStoryline={showStoryline}
          setShowStoryline={setShowStoryline}
          handleStorylineNavigate={handleStorylineNavigate}
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
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
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
        />
      )}

      {/* ── World Book Manager Dialog ── */}
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
              t={t}
              onLoad={wb.loadWorldBooks}
              onCreate={wb.createWorldBook}
              onUpdate={wb.updateWorldBook}
              onDelete={wb.deleteWorldBook}
              onImport={wb.importWorldBook}
              onSelect={(id) => wb.loadWorldBookDetail(id)}
              onClose={() => setShowWorldBookManager(false)}
              selectedForProfileId={selectedWorldBookId}
              onSelectForProfile={setSelectedWorldBookId}
            />
          </div>
        </div>
      )}

      {/* ── Plot Line Manager Dialog ── */}
      {showPlotLineManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowPlotLineManager(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-lg h-[80vh] glass-strong rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <PlotLineManager
              plotLines={pl.plotLines}
              selectedPlotLine={pl.selectedPlotLine}
              loading={pl.loading}
              parsing={pl.parsing}
              models={models}
              selectedModel={selectedModel}
              t={t}
              onLoad={pl.loadPlotLines}
              onCreate={pl.createPlotLine}
              onUpdate={pl.updatePlotLine}
              onDelete={pl.deletePlotLine}
              onParse={pl.parsePlotLine}
              onSelect={(id: string) => pl.loadPlotLineDetail(id)}
              onClose={() => setShowPlotLineManager(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
