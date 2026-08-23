/**
 * CharacterChat — 聊天视图（重构版）
 * 从CharacterView提取的子组件
 *
 * 重构说明：
 * - 内联子组件 BranchSelector / DialogueModeSelector 已提取到独立文件
 * - 移动端布局计算提取到 useMobileLayout Hook
 * - 会话切换动画提取到 useSessionSwitchAnimation Hook
 * - 角色兼容性数据管理提取到 useCharacterCompatData Hook
 * - 预设导入提取到 usePresetImport Hook
 * - 正则脚本导入提取到 useRegexScriptImport Hook + RegexScriptService
 * - 侧边栏 UI 提取到 ChatSidebar 组件
 * - 头部操作栏 UI 提取到 ChatHeader + ChatMoreMenu 组件
 * - 空状态 UI 提取到 ChatEmptyState 组件
 * - 输入区域 UI 提取到 ChatInputArea 组件
 * - 确认对话框 UI 提取到 ChatConfirmDialogs 组件
 * - 管理器对话框 UI 提取到 ChatManagerDialogs 组件
 */
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Clock, GitBranch, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, invalidateCache } from '@/services/api';
import { generationEngine } from '@/services/generation-engine';
import { toast } from 'sonner';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import { Message } from '@/components/ui/custom/Message';
import { useRoleplayTheme } from '@/contexts/RoleplayThemeContext';
import type { SmartCardAction } from '@/components/ui/custom/CharacterCardRenderer';
import {
  handleSmartCardCompatDiagnostic,
  handleSmartCardCompatRequest,
  type SmartCardCompatControllerState,
} from '@/components/ui/custom/smart-card-runtime/SmartCardCompatController';
import { ErrorToast } from '@/components/ui/custom/ErrorToast';
import { StageIndicator } from '@/components/ui/custom/StageIndicator';
import { SillyTavernIframe } from '@/components/sillytavern/SillyTavernIframe';
// 重构后提取的子组件
import { ChatSidebar } from '@/components/views/character/chat/ChatSidebar';
import { ChatHeader } from '@/components/views/character/chat/ChatHeader';
import { ChatEmptyState, ChatInitializingState } from '@/components/views/character/chat/ChatEmptyState';
import { ChatInputArea, MOBILE_CHAT_INPUT_ESTIMATED_HEIGHT_PX, MOBILE_CHAT_INPUT_GAP_PX } from '@/components/views/character/chat/ChatInputArea';
import { ChatConfirmDialogs } from '@/components/views/character/chat/ChatConfirmDialogs';
import { ChatManagerDialogs } from '@/components/views/character/chat/ChatManagerDialogs';
// 重构后提取的 Hook
import { useMobileLayout } from '@/hooks/useMobileLayout';
import { useSessionSwitchAnimation } from '@/hooks/useSessionSwitchAnimation';
import { useCharacterCompatData } from '@/hooks/useCharacterCompatData';
import type {
  Character, Model, User as UserType,
  CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch,
  GenerationPreset,
} from '@/types';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import { getCachedGlobalRegexScripts, preloadGlobalRegexScripts, loadEngineConfig } from '@/utils/sillyTavernDisplayPipeline';
import type { RegexScript } from '@/utils/regexEngine';
import { getRegexedStringForMessage } from '@/lib/sillytavern/regex/adapter';
import { regex_placement } from '@/lib/sillytavern/regex/engine';
import { extractReasoningTags } from '@/lib/sillytavern/formatting';
import { SillyTavernPluginRuntime } from '@/utils/sillyTavernPluginRuntime';
import { promptInjection } from '@/services/prompt-injection';
import { PluginManager } from '@/components/roleplay/PluginManager';
import {
  createSillyTavernRuntime,
  destroySillyTavernRuntime,
  getGlobalSillyTavernRuntime,
  type StChatMessage,
} from '@/lib/sillytavern/runtime';
// NativeRoleplayChat 保留在代码库中，但不再在默认 UI 中使用（旧式 UI 已恢复为默认）
// import { NativeRoleplayChat } from '@/components/roleplay/NativeRoleplayChat';

type InitiateConversationResult = {
  session: CharacterChatSession | null;
  branchId?: string | null;
} | null;

type InitiateConversationOptions = {
  forceNew?: boolean;
};

type SmartCardTriggerOptions = {
  sessionOverride?: CharacterChatSession | null;
  branchIdOverride?: string | null;
  awaitResult?: boolean;
  useEmptyContext?: boolean;
};

// Task 21: Options for handleSendMessage — mirrors the subset of
// useCharacterChat.SendMessageOptions needed by the Continue feature.
type HandleSendMessageOptions = {
  suppressUserMessage?: boolean;
  ignorePendingAttachments?: boolean;
};

/* BranchSelector / DialogueModeSelector 已提取到独立文件：
   @/components/ui/custom/BranchSelector.tsx
   @/components/ui/custom/DialogueModeSelector.tsx */

// ST 兼容：给 ST 插件读取的消息文本剥离 Palink 渲染专用的 <style> 块。
// Palink 消息 content 为渲染后 HTML（含 .mes_text 美化样式），原版 ST 的 chat[i].mes
// 是纯文本不含 <style>；若不剥离，Galgame 等插件把 style 当普通文本写入对话框，
// 会以转义 HTML（&lt;style&gt;...）形式显示出来。
const stripStyleBlocks = (html: unknown): string =>
  String(html ?? '').replace(/<style[\s\S]*?<\/style>/gi, '');

/* ────── Props ──────────────────────────────────────────────────────────────────────────────────────── */

export interface CharacterChatProps {
  // identity
  selectedCharacter: Character;
  user: UserType;
  t: Record<string, string>;
  lang?: 'zh' | 'en';
  // models
  models: Model[];
  selectedModel: string;
  setSelectedModel: (m: string) => void;
  // sessions
  sessions: CharacterChatSession[];
  selectedSession: CharacterChatSession | null;
  setSelectedSession: (s: CharacterChatSession | null) => void;
  handleSelectSession: (s: CharacterChatSession) => Promise<void>;
  handleNewSession: () => void;
  handleDeleteSession: (id: string) => void;
  // session delete mode
  isDeleteMode: boolean;
  setIsDeleteMode: (v: boolean) => void;
  selectedSessions: Set<string>;
  toggleSessionSelect: (id: string) => void;
  handleBatchDelete: () => void;
  // session delete confirm
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (v: boolean) => void;
  pendingDelete: { type: 'single'; id: string } | { type: 'batch' } | null;
  confirmDelete: () => Promise<void>;
  // messages
  messages: CharacterChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<CharacterChatMessage[]>>;
  loadMessages: (id: string) => Promise<void>;
  hasMoreMessages: boolean;
  loadOlderMessages: () => Promise<void>;
  isLoadingOlderMessages: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  userPausedAutoScrollRef?: React.MutableRefObject<boolean>;
  // chat hook
  isGenerating: boolean;
  inputValue: string;
  setInputValue: (v: string) => void;
  attachments: any[];
  setAttachments: React.Dispatch<React.SetStateAction<any[]>>;
  uploading: boolean;
  suggestions: string[];
  regeneratingMessageIndex: number | null;
  generatingImageMessageIds: Set<string>;
  currentError: any;
  retryMessageContent: string | null;
  timeoutWarning: boolean;
  handleSendMessage: (msg: string, attachments: any[], options?: HandleSendMessageOptions) => Promise<string | null | void>;
  handleSmartCardTrigger: (content: string, options?: SmartCardTriggerOptions) => Promise<string | null>;
  handleSendWithInput: () => Promise<void>;
  handleRegenerate: (idx: number) => Promise<void>;
  handleContinue: () => Promise<void>;
  handleRetry: () => void;
  handleCloseError: () => void;
  handleUpload: (file: File, type: 'image' | 'file') => Promise<void>;
  handleDeleteMessage: (msgId: string | number, idx: number) => Promise<void>;
  handleEditMessage: (
    msgId: string | number,
    idx: number,
    content: string,
    options?: {
      role?: string;
      name?: string;
      is_user?: boolean;
      is_system?: boolean;
      is_name?: boolean;
      force_avatar?: string;
      original_avatar?: string;
      avatar?: string;
      gen_id?: string;
      group_id?: string;
      group_name?: string;
      selected_group?: unknown;
      groups?: Array<Record<string, unknown>>;
      swipe_id?: number;
      swipeId?: number;
      swipes?: string[];
      swipe_info?: Array<Record<string, unknown>>;
      extra?: Record<string, unknown>;
    },
  ) => Promise<void>;
  handleGenerateImage: (msgId: string | number) => Promise<void>;
  handleStopGeneration: () => void;
  showModelReasoning: boolean;
  // branches
  branches: CharacterChatSessionBranch[];
  selectedBranch: CharacterChatSessionBranch | null;
  createBranch: () => Promise<void>;
  switchBranch: (branch: CharacterChatSessionBranch) => Promise<void>;
  deleteBranch: (branchId: string) => void;
  fetchBranchTree: () => Promise<void>;
  branchTree: BranchTree | null;
  handleStorylineNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => Promise<void>;
  forkPoint: { branchId: string; messageId: number } | null;
  clearForkPoint: () => void;
  showDeleteBranchConfirm: boolean;
  setShowDeleteBranchConfirm: (v: boolean) => void;
  confirmDeleteBranch: () => Promise<void>;
  // mixed delete
  isMixedDeleteMode: boolean;
  setIsMixedDeleteMode: (v: boolean) => void;
  selectedWholeMessages: Set<number>;
  selectedMessageParts: Map<number, Set<string>>;
  toggleWholeMessageSelect: (idx: number) => void;
  toggleMessagePartSelect: (messageIndex: number, partId: string) => void;
  selectAllPartsInMessage: (idx: number) => void;
  handleMixedDelete: () => void;
  showDeleteMixedConfirm: boolean;
  setShowDeleteMixedConfirm: (v: boolean) => void;
  confirmDeleteMixed: () => Promise<void>;
  clearSelection: () => void;
  // memory
  memoryMode: string;
  memoryStats: {
    message_count: number;
    token_count: number;
    oldest_message_hours: number;
    compression_needed: boolean;
    compression_reason: string;
  } | null;
  compressing: boolean;
  manualCompressMemory: () => Promise<void>;
  // dialogue
  dialogueMode: 'first_person' | 'third_person';
  setDialogueMode: (m: 'first_person' | 'third_person') => void;
  autoGenerateChatImages: boolean;
  setAutoGenerateChatImages: (v: boolean) => void;
  responseLength: string;
  setResponseLength: (v: string) => void;
  // sidebar
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (v: boolean) => void;
  // init
  initializingChat: boolean;
  handleInitiateConversation: (msg?: string, options?: InitiateConversationOptions) => Promise<InitiateConversationResult>;
  // world book
  wb: any; // useWorldBook return type
  showWorldBookManager: boolean;
  setShowWorldBookManager: (v: boolean) => void;
  showWorldBookOverview: boolean;
  setShowWorldBookOverview: (v: boolean) => void;
  selectedWorldBookId: string | null;
  setSelectedWorldBookId: (id: string | null) => void;
  // plot line
  pl: any; // usePlotLine return type
  showPlotLineManager: boolean;
  setShowPlotLineManager: (v: boolean) => void;
  selectedPlotLineId: string | null;
  setSelectedPlotLineId: (id: string | null) => void;
  // navigation
  setViewState: (v: 'list' | 'edit' | 'chat') => void;
  onBackToList?: () => void;
  // preset
  currentPreset: GenerationPreset | null;
  setCurrentPreset: (preset: GenerationPreset) => void;
  // system defaults
  systemDefaults?: Record<string, any>;
  // silly tavern mode
  sillyTavernMode?: 'st-native' | 'st-compat' | 'palink-native' | 'classic';
  // character display mode (framed / frameless)
  characterDisplayMode?: string;
}

/* ────── Component ──────────────────────────────────────────────────────────────────────────────── */

export function CharacterChat(props: CharacterChatProps) {
  // 移动端布局（从 useMobileLayout 提取）
  const { isMobile, composerBottomPx } = useMobileLayout();
  const { keyboardHeight, isKeyboardOpen } = useVirtualKeyboard();
  const { currentTheme } = useRoleplayTheme();
  const [isDark, setIsDark] = useState(document.documentElement.classList.contains('dark'));
  const [showDesktopHint, setShowDesktopHint] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !localStorage.getItem('palink-mobile-desktop-hint-dismissed');
  });
  // 预设/正则管理器 UI 状态
  const [showPresetPanel, setShowPresetPanel] = useState(false);
  const [showPresetManager, setShowPresetManager] = useState(false);
  // 插件管理器对话框
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  // MVU 会话级变量（后端下发的 stat_data，作为消息级 extra.variables 的兜底）
  const [sessionVariables, setSessionVariables] = useState<{ stat_data?: Record<string, unknown> } | undefined>(undefined);

  // 生成流的 final_content 事件会携带后端刚保存的 MVU variables；直接写入页面状态，
  // 不等待生成状态 effect 或再次 GET，确保 iframe context-update 立即收到最新 stat_data。
  useEffect(() => {
    const handleMvuVariablesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; variables?: unknown }>).detail;
      if (!detail?.variables) return;
      if (typeof detail.variables === 'object' && !Array.isArray(detail.variables)) {
        setSessionVariables(detail.variables as { stat_data?: Record<string, unknown> });
      }
    };
    window.addEventListener('palink:mvuVariablesUpdated', handleMvuVariablesUpdated);
    return () => window.removeEventListener('palink:mvuVariablesUpdated', handleMvuVariablesUpdated);
  }, []);
  // SmartCard 兼容性控制器
  const smartCardCompatStateRef = useRef<SmartCardCompatControllerState>({
    worldBook: null,
    diagnosticToastTimes: new Map(),
  });
  const prevMessagesRef = useRef<CharacterChatMessage[]>([]);
  const [globalRegexScripts, setGlobalRegexScripts] = useState<RegexScript[]>(() => getCachedGlobalRegexScripts());
  const userPausedAutoScrollRef = useRef(false);
  const stRuntimeRef = useRef<SillyTavernPluginRuntime | null>(null);
  if (!stRuntimeRef.current) {
    stRuntimeRef.current = new SillyTavernPluginRuntime();
  }

  useEffect(() => {
    const darkObserver = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => darkObserver.disconnect();
  }, []);

  useEffect(() => {
    // [EP-BRIDGE] 注册父页面 window.SillyTavern.getExtensionPrompts，供 generation-engine
    // （插件 generate/generateQuietPrompt 路径）读取 promptInjection 聚合视图（含 sandbox
    // 插件条目与 smart-card iframe 上报条目），输出对齐后端 ExtensionPromptInput 数组形状。
    // 幂等：仅当未注册时设置，避免覆盖其他来源。
    if (typeof window !== 'undefined') {
      const w = window as any;
      if (!w.SillyTavern) w.SillyTavern = {};
      if (typeof w.SillyTavern.getExtensionPrompts !== 'function') {
        w.SillyTavern.getExtensionPrompts = () => {
          const merged = promptInjection.getPromptsForGeneration() || {};
          return Object.entries(merged).map(([identifier, entry]: any) => ({
            identifier,
            content: entry?.content ?? '',
            position: typeof entry?.position === 'number' ? entry.position : -1,
            depth: typeof entry?.depth === 'number' ? entry.depth : 4,
            role: entry?.role ?? 0,
            filter: typeof entry?.filter === 'function' ? null : (entry?.filter ?? {}),
          }));
        };
      }
    }
  }, []);

  const {
    selectedCharacter, user, t, lang,
    models, selectedModel, setSelectedModel,
    sessions, selectedSession, setSelectedSession,
    handleSelectSession, handleNewSession, handleDeleteSession,
    isDeleteMode, setIsDeleteMode, selectedSessions, toggleSessionSelect, handleBatchDelete,
    showDeleteConfirm, setShowDeleteConfirm, pendingDelete, confirmDelete,
    messages, setMessages, loadMessages, hasMoreMessages, loadOlderMessages, isLoadingOlderMessages, messagesEndRef,
    isAtBottomRef,
    isGenerating, inputValue, setInputValue,
    attachments, setAttachments, uploading,
    suggestions, regeneratingMessageIndex, generatingImageMessageIds,
    currentError, retryMessageContent, timeoutWarning,
    handleSendMessage, handleSmartCardTrigger, handleSendWithInput, handleRegenerate, handleContinue: propsHandleContinue,
    handleRetry, handleCloseError, handleUpload, handleDeleteMessage, handleEditMessage, handleGenerateImage,
    handleStopGeneration, showModelReasoning,
    branches, selectedBranch, createBranch, switchBranch, deleteBranch,
    fetchBranchTree, branchTree,
    handleStorylineNavigate, forkPoint, clearForkPoint,
    showDeleteBranchConfirm, setShowDeleteBranchConfirm, confirmDeleteBranch,
    isMixedDeleteMode, setIsMixedDeleteMode,
    selectedWholeMessages, selectedMessageParts,
    toggleWholeMessageSelect, toggleMessagePartSelect, selectAllPartsInMessage,
    handleMixedDelete, showDeleteMixedConfirm, setShowDeleteMixedConfirm, confirmDeleteMixed, clearSelection,
    memoryMode, memoryStats, compressing, manualCompressMemory,
    dialogueMode, setDialogueMode,
    autoGenerateChatImages, setAutoGenerateChatImages,
    responseLength, setResponseLength,
    sidebarCollapsed, setSidebarCollapsed: _setSidebarCollapsed,
    mobileSidebarOpen, setMobileSidebarOpen,
    initializingChat, handleInitiateConversation,
    wb, showWorldBookManager, setShowWorldBookManager,
    showWorldBookOverview, setShowWorldBookOverview,
    selectedWorldBookId, setSelectedWorldBookId,
    pl, showPlotLineManager, setShowPlotLineManager,
    setViewState, onBackToList,
    currentPreset, setCurrentPreset,
    systemDefaults,
    sillyTavernMode = 'classic',
    characterDisplayMode = 'framed',
  } = props;
  const dialogText = lang === 'en'
    ? {
        confirm: t.confirm || 'Confirm',
        cancel: t.cancel || 'Cancel',
        processing: 'Processing...',
        deleteSelectedSessionsTitle: 'Delete selected sessions?',
        deleteSelectedSessionsDescription: (count: number) => `Delete ${count} selected sessions? This cannot be undone.`,
        deleteSessionTitle: 'Delete this session?',
        deleteSessionDescription: 'Delete this session? This cannot be undone.',
        deleteBranchTitle: 'Delete this branch?',
        deleteBranchDescription: 'Delete this branch? This cannot be undone.',
        deleteSelectedContentTitle: 'Delete selected content?',
        deleteSelectedContentDescription: 'Delete selected content? This cannot be undone.',
      }
    : {
        confirm: t.confirm || '确定',
        cancel: t.cancel || '取消',
        processing: '处理中...',
        deleteSelectedSessionsTitle: '删除选中的对话？',
        deleteSelectedSessionsDescription: (count: number) => `确定删除选中的 ${count} 个对话吗？此操作无法撤销。`,
        deleteSessionTitle: '删除这个对话？',
        deleteSessionDescription: '确定删除这个对话吗？此操作无法撤销。',
        deleteBranchTitle: '删除这个分支？',
        deleteBranchDescription: '确定删除这个分支吗？此操作无法撤销。',
        deleteSelectedContentTitle: '删除选中的内容？',
        deleteSelectedContentDescription: '确定删除选中的内容吗？此操作无法撤销。',
      };

  const [isNavigating, setIsNavigating] = useState(false);
  const navGenRef = useRef(0);
  const mobileSidebarOpenRef = useRef(mobileSidebarOpen);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);

  // 角色兼容性数据（从 useCharacterCompatData 提取）
  const {
    extensions: compatCharacterExtensions,
    presetData: compatCharacterPresetData,
  } = useCharacterCompatData(selectedCharacter);

  const activePausedAutoScrollRef = props.userPausedAutoScrollRef || userPausedAutoScrollRef;

  useEffect(() => {
    mobileSidebarOpenRef.current = mobileSidebarOpen;
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [mobileSidebarOpen, sidebarCollapsed]);

  const setSidebarCollapsed = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const newCollapsed = typeof v === 'function' ? v(sidebarCollapsed) : v;

    if (isMobile) {
      const newOpenVal = !newCollapsed;
      if (mobileSidebarOpen === true && newOpenVal === false && isNavigating) {
        return;
      }
      setMobileSidebarOpen(newOpenVal);
      _setSidebarCollapsed(newCollapsed);
      return;
    }

    setMobileSidebarOpen(!newCollapsed);
    _setSidebarCollapsed(newCollapsed);
  }, [_setSidebarCollapsed, setMobileSidebarOpen, isMobile, isNavigating, mobileSidebarOpen, sidebarCollapsed]);

  // 会话切换动画（从 useSessionSwitchAnimation 提取）
  const {
    sessionVisualSnapshot,
    newSessionFadeState,
    setNewSessionFadeState,
    setSessionVisualSnapshot,
    handleSessionSwitchWithFade,
    handleNewSessionWithFade,
    cleanupTimers: cleanupSessionSwitchTimers,
    HISTORY_SLIDE_DURATION_MS,
    NEW_SESSION_FADE_DURATION_MS,
  } = useSessionSwitchAnimation({
    selectedSession,
    messages,
    sidebarCollapsed,
    isMobile,
    setSidebarCollapsed,
    handleSelectSession,
    handleNewSession,
  });

  // 清理会话切换定时器
  useEffect(() => {
    return () => cleanupSessionSwitchTimers();
  }, [cleanupSessionSwitchTimers]);

  const wrappedHandleStorylineNavigate = useCallback(async (branchId: string, messageId: number | null, isLeaf: boolean) => {
    const gen = ++navGenRef.current;
    const shouldKeepMobileSidebarOpen = isMobile && mobileSidebarOpenRef.current;
    const shouldKeepDesktopSidebarOpen = !isMobile && !sidebarCollapsedRef.current;
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    setIsNavigating(true);
    try {
      await handleStorylineNavigate(branchId, messageId, isLeaf);
    } catch (e) {
      if (navGenRef.current === gen) {
        setIsNavigating(false);
      }
      setNewSessionFadeState('idle');
      setSessionVisualSnapshot(null);
      throw e;
    } finally {
      setTimeout(() => {
        if (navGenRef.current === gen) {
          setIsNavigating(false);
          if (shouldKeepMobileSidebarOpen) {
            setMobileSidebarOpen(true);
            _setSidebarCollapsed(false);
          } else if (shouldKeepDesktopSidebarOpen) {
            _setSidebarCollapsed(false);
          }
        }
      }, 500);
    }
  }, [handleStorylineNavigate, isMobile, setMobileSidebarOpen, _setSidebarCollapsed, isAtBottomRef, activePausedAutoScrollRef]);

  const handleRemoveAttachment = useCallback((idx: number) =>
    setAttachments(prev => prev.filter((_, i) => i !== idx)),
  [setAttachments]);

  const handleStop = useCallback(() => handleStopGeneration(), [handleStopGeneration]);

  const handleSelectModel = useCallback((modelId: string) => {
    try {
      sessionStorage.setItem('palink-rp-last-model', modelId);
    } catch {
      // ignore
    }
    setSelectedModel(modelId);
  }, [setSelectedModel]);

  // ──── 头部菜单相关回调（提取到 ChatHeader / ChatMoreMenu）────
  const handleToggleMobileSidebar = useCallback(() => {
    if (isNavigating) return;
    if (mobileSidebarOpen) {
      setSidebarCollapsed(true);
    } else {
      setSidebarCollapsed(false);
      if (selectedSession) fetchBranchTree();
    }
  }, [isNavigating, mobileSidebarOpen, setSidebarCollapsed, selectedSession, fetchBranchTree]);

  const handleToggleDesktopSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const handleToggleStoryline = useCallback(() => {
    if (isNavigating) return;
    if (mobileSidebarOpen) {
      setSidebarCollapsed(true);
    } else {
      setSidebarCollapsed(false);
      fetchBranchTree();
    }
  }, [isNavigating, mobileSidebarOpen, setSidebarCollapsed, fetchBranchTree]);

  const handleToggleDialogueMode = useCallback(() => {
    setDialogueMode(dialogueMode === 'first_person' ? 'third_person' : 'first_person');
  }, [dialogueMode, setDialogueMode]);

  const handleToggleAutoGenerateImages = useCallback(async (value: boolean) => {
    setAutoGenerateChatImages(value);
    try {
      await api.put('/api/users/me/settings', { auto_generate_chat_images: value });
      invalidateCache('/api/users/me/settings');
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { autoGenerateChatImages: value } }));
      toast.success(value ? '自动图片生成已开启' : '自动图片生成已关闭');
    } catch (e) {
      console.error('Failed to update image generation setting:', e);
      setAutoGenerateChatImages(!value);
    }
  }, [setAutoGenerateChatImages]);

  const handleResponseLengthChange = useCallback((value: string) => {
    setResponseLength(value);
  }, [setResponseLength]);

  const handleExitDeleteMode = useCallback(() => {
    setIsMixedDeleteMode(false);
    clearSelection();
  }, [setIsMixedDeleteMode, clearSelection]);

  const handleMixedDeleteWithCheck = useCallback(async () => {
    if (selectedWholeMessages.size > 0 || selectedMessageParts.size > 0) {
      await handleMixedDelete();
    }
  }, [selectedWholeMessages, selectedMessageParts, handleMixedDelete]);

  const handlePrevStage = useCallback(async () => {
    if (!selectedSession) return;
    await pl.prevStage(selectedSession.id);
    await pl.loadSessionStatus(selectedSession.id);
  }, [pl, selectedSession]);

  const handleNextStage = useCallback(async () => {
    if (!selectedSession) return;
    await pl.nextStage(selectedSession.id);
    await pl.loadSessionStatus(selectedSession.id);
  }, [pl, selectedSession]);

  useEffect(() => {
    if (models.length === 0) return;
    const last = sessionStorage.getItem('palink-rp-last-model');
    if (last && models.some((m) => m.id === last)) {
      if (selectedModel !== last) {
        setSelectedModel(last);
      }
      return;
    }
    if (!selectedModel && systemDefaults?.default_character_chat_model) {
      setSelectedModel(systemDefaults.default_character_chat_model);
    }
  }, [models, selectedModel, setSelectedModel, systemDefaults]);

  // 同步当前选中模型到 generationEngine：插件触发的生成（generateRaw / generate /
  // 加强模式二次生成，经 sillyTavernPluginRuntime 桥接）应使用聊天当前模型，
  // 而非后端默认模型；同时使 /model quiet=true 能返回真实模型名供插件快照/恢复。
  useEffect(() => {
    if (!selectedModel) return;
    try {
      generationEngine.setContext({ model: selectedModel });
    } catch (e) {
      console.warn('[CharacterChat] 同步模型到 generationEngine 失败:', e);
    }
  }, [selectedModel]);

  const inactiveWorldBookStatus = useMemo(() => ({ active: false }), []);

  const prevBranchIdRef = useRef<string | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const outerContainerRef = useRef<HTMLDivElement>(null);
  const sidebarWasOpenBeforeNavRef = useRef(false);

  const effectiveMobileSidebarOpen = isMobile
    ? (mobileSidebarOpen || (isNavigating && sidebarWasOpenBeforeNavRef.current))
    : mobileSidebarOpen;

  useEffect(() => {
    if (!isMobile) return;
    const el = contentWrapperRef.current;
    if (!el) return;
        const observer = new MutationObserver(() => {});
    observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    const resizeObs = new ResizeObserver(() => {});
    resizeObs.observe(el);
    return () => { observer.disconnect(); resizeObs.disconnect(); };
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;

    if (isNavigating) {
      if (mobileSidebarOpen) {
        sidebarWasOpenBeforeNavRef.current = true;
      } else if (sidebarWasOpenBeforeNavRef.current) {
        setMobileSidebarOpen(true);
        _setSidebarCollapsed(false);
      }
    } else if (sidebarWasOpenBeforeNavRef.current) {
      sidebarWasOpenBeforeNavRef.current = false;
      setMobileSidebarOpen(true);
      _setSidebarCollapsed(false);
    }
  }, [isMobile, isNavigating, mobileSidebarOpen, setMobileSidebarOpen, _setSidebarCollapsed]);


  useEffect(() => {
    const branchId = selectedBranch?.id || null;
    if (!isMobile && prevBranchIdRef.current !== null && prevBranchIdRef.current !== branchId && branchId !== null) {
      const gen = ++navGenRef.current;
      setIsNavigating(true);
      setTimeout(() => {
        if (navGenRef.current === gen) {
          setIsNavigating(false);
        }
      }, 500);
    }
    prevBranchIdRef.current = branchId;
  }, [isMobile, selectedBranch, selectedSession?.id]);

  // MVU 变量：会话切换时拉取后端下发的 stat_data
  useEffect(() => {
    if (!selectedSession?.id) {
      setSessionVariables(undefined);
      return;
    }
    let cancelled = false;
    void api.get(`/api/character-sessions/${selectedSession.id}/messages?limit=1`)
      .then((res: any) => {
        if (!cancelled && res?.variables) {
          setSessionVariables(res.variables);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedSession?.id]);

  useEffect(() => {
    prevMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    void preloadGlobalRegexScripts((url) => api.get(url, { cacheTtlMs: 90_000 })).then((scripts) => {
      if (!cancelled) setGlobalRegexScripts(scripts);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCharacter.id]);

  useEffect(() => {
    const engineConfig = loadEngineConfig();
    if (engineConfig.globalRegexScripts.length > 0) {
      setGlobalRegexScripts(prev => {
        const existing = new Set(prev.map(s => s.id || s.scriptName || (s as any).script_name));
        const merged = [...prev, ...engineConfig.globalRegexScripts.filter(s => !existing.has(s.id || s.scriptName || (s as any).script_name))];
        return merged;
      });
    }
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom < 50;
    if (distanceFromBottom < 30) {
      activePausedAutoScrollRef.current = false;
    }
  }, [isAtBottomRef, activePausedAutoScrollRef]);

  const wrappedHandleSendWithInput = useCallback(async () => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    const processedInput = getRegexedStringForMessage(inputValue, regex_placement.USER_INPUT, {
      characterName: selectedCharacter.name,
      userName: user.username,
      characterAvatar: selectedCharacter.avatar || '',
      characterExtensions: compatCharacterExtensions,
      characterPresetData: compatCharacterPresetData,
      globalRegexScripts,
    });
    setInputValue('');
    setAttachments([]);
    await handleSendMessage(processedInput, attachments);
    stRuntimeRef.current?.emit('MESSAGE_SENT', {
      message: { name: user.username, mes: processedInput, is_user: true },
    });
    try {
      getGlobalSillyTavernRuntime()?.getEventSource().emit('message_sent', displayedMessages.length - 1, { name: user.username, mes: processedInput, is_user: true });
    } catch {}
  }, [handleSendMessage, isAtBottomRef, activePausedAutoScrollRef, inputValue, user.username, attachments, selectedCharacter.name, selectedCharacter.avatar, compatCharacterExtensions, compatCharacterPresetData, globalRegexScripts, setInputValue, setAttachments]);

  const wrappedHandleSendMessage = useCallback(async (msg: string, attachments: any[]) => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    await handleSendMessage(msg, attachments);
    stRuntimeRef.current?.emit('MESSAGE_SENT', {
      message: { name: user.username, mes: msg, is_user: true },
    });
    try {
      getGlobalSillyTavernRuntime()?.getEventSource().emit('message_sent', displayedMessages.length - 1, { name: user.username, mes: msg, is_user: true });
    } catch {}
  }, [handleSendMessage, isAtBottomRef, activePausedAutoScrollRef, user.username]);

  // Task 20/21: Continue generation — sends "Continue where you left off." as a
  // hidden continuation prompt (suppressUserMessage) so the AI continues from
  // the last AI message without adding a visible user message to the chat.
  const handleContinue = useCallback(async () => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    await propsHandleContinue();
  }, [propsHandleContinue, isAtBottomRef, activePausedAutoScrollRef]);

  const wrappedHandleInitiateConversation = useCallback(async (msg?: string, options?: InitiateConversationOptions) => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    return await handleInitiateConversation(msg, options);
  }, [handleInitiateConversation, isAtBottomRef, activePausedAutoScrollRef]);

  const wrappedHandleSmartCardTrigger = useCallback(async (content: string, options?: SmartCardTriggerOptions) => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    return await handleSmartCardTrigger(content, options);
  }, [handleSmartCardTrigger, isAtBottomRef, activePausedAutoScrollRef]);

  const mergeSmartCardSwipeInfoForDisplay = useCallback((
    fallbackMessage: CharacterChatMessage | undefined,
    content: string,
    swipeId: number | undefined,
    swipes: string[] | undefined,
    explicitSwipeInfo: Array<Record<string, unknown>> | undefined,
    extra: Record<string, unknown> | undefined,
  ) => {
    const sourceSwipes = swipes || (Array.isArray(fallbackMessage?.swipes) ? fallbackMessage.swipes : undefined);
    if (!sourceSwipes || sourceSwipes.length === 0) return explicitSwipeInfo;
    const activeSwipeId = Math.max(
      0,
      Math.min(
        Number.isFinite(Number(swipeId)) ? Number(swipeId) : Number(fallbackMessage?.swipe_id || 0),
        sourceSwipes.length - 1,
      ),
    );
    const baseInfo = explicitSwipeInfo
      ? explicitSwipeInfo.map((entry) => ({ ...(entry || {}) }))
      : Array.isArray(fallbackMessage?.swipe_info)
        ? fallbackMessage.swipe_info.map((entry) => ({ ...(entry || {}) }))
        : [];
    while (baseInfo.length < sourceSwipes.length) {
      baseInfo.push({ send_date: fallbackMessage?.created_at || '', extra: {} });
    }
    const activeInfo = baseInfo[activeSwipeId] || {};
    const activeExtra = activeInfo.extra && typeof activeInfo.extra === 'object'
      ? activeInfo.extra as Record<string, unknown>
      : {};
    baseInfo[activeSwipeId] = {
      ...activeInfo,
      extra: extra ? { ...activeExtra, ...extra } : activeExtra,
    };
    return baseInfo;
  }, []);

  const smartCardUpdateHasExplicitContent = useCallback((content: string, options: Record<string, unknown>) => {
    if (typeof options.__palinkHasExplicitContent === 'boolean') return options.__palinkHasExplicitContent;
    return String(content ?? '').length > 0;
  }, []);

  const smartCardUpdateHasDisplayLayer = useCallback((options: Record<string, unknown>) => {
    const displayLayerKeys = [
      'extra',
      'display_text',
      'displayText',
      'swipe_info',
      'swipes',
      'swipe_id',
      'swipeId',
      'role',
      'name',
      'is_user',
      'is_system',
      'is_name',
      'force_avatar',
      'forceAvatar',
      'original_avatar',
      'originalAvatar',
      'avatar',
      'gen_id',
      'genId',
      'group_id',
      'groupId',
      'group_name',
      'groupName',
      'selected_group',
      'selectedGroup',
      'groups',
    ];
    return displayLayerKeys.some((key) => (
      Object.prototype.hasOwnProperty.call(options, key)
      && options[key] !== undefined
    ));
  }, []);

  const applySmartCardMessageUpdate = useCallback(async ({
    content,
    messageId,
    index,
    options,
  }: {
    content: string;
    messageId?: string | number | null;
    index?: number;
    options?: Record<string, unknown>;
  }) => {
    const fallbackIndex = typeof index === 'number'
      ? index
      : messages.findIndex((message, messageIndex) => (
        String(message.id) === String(messageId)
        || String((message as any).message_id) === String(messageId)
        || String((message as any).mesid) === String(messageId)
        || String(messageIndex) === String(messageId)
      ));
    const fallbackMessage = messages[fallbackIndex];
    const resolvedMessageId = messageId ?? fallbackMessage?.id;
    const nextOptions = options && typeof options === 'object' ? options : {};
    const shouldPersistSmartCardUpdate = !(
      nextOptions.localOnly === true
      || nextOptions.persist === false
      || nextOptions.save === false
    );
    const hasExplicitContent = smartCardUpdateHasExplicitContent(content, nextOptions);
    if (!hasExplicitContent && !fallbackMessage) {
      return;
    }
    const baseContent = fallbackMessage?.content ?? '';
    const persistedContent = hasExplicitContent ? content : baseContent;
    const activeSwipeId = Number.isFinite(Number(nextOptions.swipe_id ?? nextOptions.swipeId))
      ? Number(nextOptions.swipe_id ?? nextOptions.swipeId)
      : Number.isFinite(Number(fallbackMessage?.swipe_id))
        ? Number(fallbackMessage?.swipe_id)
        : undefined;
    const nextSwipeId = Number.isFinite(Number(nextOptions.swipe_id ?? nextOptions.swipeId))
      ? Number(nextOptions.swipe_id ?? nextOptions.swipeId)
      : undefined;
    const explicitSwipes = Array.isArray(nextOptions.swipes)
      ? nextOptions.swipes.map((item) => String(item ?? ''))
      : undefined;
    const nextSwipes = explicitSwipes || (Array.isArray(fallbackMessage?.swipes)
      ? fallbackMessage.swipes.map((swipe, swipeIndex) => (hasExplicitContent && swipeIndex === activeSwipeId ? persistedContent : swipe))
      : undefined);
    const nextExtra = nextOptions.extra && typeof nextOptions.extra === 'object'
      ? nextOptions.extra as Record<string, unknown>
      : undefined;
    const nextSwipeInfo = Array.isArray(nextOptions.swipe_info)
      ? nextOptions.swipe_info as Array<Record<string, unknown>>
      : undefined;
    const mergedSwipeInfo = mergeSmartCardSwipeInfoForDisplay(
      fallbackMessage,
      persistedContent,
      nextSwipeId,
      nextSwipes,
      nextSwipeInfo,
      nextExtra,
    );

    if (resolvedMessageId != null && shouldPersistSmartCardUpdate) {
      await handleEditMessage(resolvedMessageId, fallbackIndex, persistedContent, {
        role: typeof nextOptions.role === 'string' ? nextOptions.role : undefined,
        name: typeof nextOptions.name === 'string' ? nextOptions.name : undefined,
        is_user: typeof nextOptions.is_user === 'boolean' ? nextOptions.is_user : undefined,
        is_system: typeof nextOptions.is_system === 'boolean' ? nextOptions.is_system : undefined,
        is_name: typeof nextOptions.is_name === 'boolean' ? nextOptions.is_name : undefined,
        force_avatar: typeof (nextOptions.force_avatar ?? nextOptions.forceAvatar) === 'string' ? String(nextOptions.force_avatar ?? nextOptions.forceAvatar) : undefined,
        original_avatar: typeof (nextOptions.original_avatar ?? nextOptions.originalAvatar) === 'string' ? String(nextOptions.original_avatar ?? nextOptions.originalAvatar) : undefined,
        avatar: typeof nextOptions.avatar === 'string' ? nextOptions.avatar : undefined,
        gen_id: typeof (nextOptions.gen_id ?? nextOptions.genId) === 'string' ? String(nextOptions.gen_id ?? nextOptions.genId) : undefined,
        group_id: typeof (nextOptions.group_id ?? nextOptions.groupId) === 'string' ? String(nextOptions.group_id ?? nextOptions.groupId) : undefined,
        group_name: typeof (nextOptions.group_name ?? nextOptions.groupName) === 'string' ? String(nextOptions.group_name ?? nextOptions.groupName) : undefined,
        selected_group: nextOptions.selected_group ?? nextOptions.selectedGroup,
        groups: Array.isArray(nextOptions.groups) ? nextOptions.groups as Array<Record<string, unknown>> : undefined,
        swipe_id: nextSwipeId,
        swipes: nextSwipes,
        swipe_info: mergedSwipeInfo,
        extra: nextExtra,
      });
    } else {
      setMessages(prev => {
        if (fallbackIndex < 0 || fallbackIndex >= prev.length) return prev;
        const next = [...prev];
        next[fallbackIndex] = {
          ...next[fallbackIndex],
          role: (typeof nextOptions.role === 'string' && ['user', 'assistant', 'system'].includes(nextOptions.role))
            ? nextOptions.role as any
            : next[fallbackIndex].role,
          name: typeof nextOptions.name === 'string' ? nextOptions.name : next[fallbackIndex].name,
          is_user: typeof nextOptions.is_user === 'boolean' ? nextOptions.is_user : next[fallbackIndex].is_user,
          is_system: typeof nextOptions.is_system === 'boolean' ? nextOptions.is_system : next[fallbackIndex].is_system,
          is_name: typeof nextOptions.is_name === 'boolean' ? nextOptions.is_name : (next[fallbackIndex] as any).is_name,
          force_avatar: typeof (nextOptions.force_avatar ?? nextOptions.forceAvatar) === 'string' ? String(nextOptions.force_avatar ?? nextOptions.forceAvatar) : (next[fallbackIndex] as any).force_avatar,
          original_avatar: typeof (nextOptions.original_avatar ?? nextOptions.originalAvatar) === 'string' ? String(nextOptions.original_avatar ?? nextOptions.originalAvatar) : (next[fallbackIndex] as any).original_avatar,
          avatar: typeof nextOptions.avatar === 'string' ? nextOptions.avatar : (next[fallbackIndex] as any).avatar,
          gen_id: typeof (nextOptions.gen_id ?? nextOptions.genId) === 'string' ? String(nextOptions.gen_id ?? nextOptions.genId) : (next[fallbackIndex] as any).gen_id,
          group_id: typeof (nextOptions.group_id ?? nextOptions.groupId) === 'string' ? String(nextOptions.group_id ?? nextOptions.groupId) : (next[fallbackIndex] as any).group_id,
          group_name: typeof (nextOptions.group_name ?? nextOptions.groupName) === 'string' ? String(nextOptions.group_name ?? nextOptions.groupName) : (next[fallbackIndex] as any).group_name,
          selected_group: nextOptions.selected_group ?? nextOptions.selectedGroup ?? (next[fallbackIndex] as any).selected_group,
          groups: Array.isArray(nextOptions.groups) ? nextOptions.groups as Array<Record<string, unknown>> : (next[fallbackIndex] as any).groups,
          content: persistedContent,
          swipe_id: nextSwipeId ?? next[fallbackIndex].swipe_id,
          swipes: nextSwipes ?? next[fallbackIndex].swipes,
          swipe_info: mergedSwipeInfo ?? (next[fallbackIndex] as any).swipe_info,
          extra: nextExtra
            ? { ...(next[fallbackIndex].extra || {}), ...nextExtra }
            : next[fallbackIndex].extra,
        };
        return next;
      });
    }

    if (
      selectedSession?.id
      && typeof nextOptions.refresh === 'string'
      && /display|render|current|chat/i.test(nextOptions.refresh)
    ) {
      window.setTimeout(() => {
        void loadMessages(selectedSession.id);
      }, 120);
    }
  }, [handleEditMessage, loadMessages, mergeSmartCardSwipeInfoForDisplay, messages, selectedSession?.id, setMessages, smartCardUpdateHasExplicitContent]);

  const scrollSmartCardChatToBottom = useCallback(() => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    window.setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
    }, 0);
  }, [activePausedAutoScrollRef, isAtBottomRef, messagesEndRef]);

  const handleSmartCardRequest = useCallback((action: SmartCardAction & { type: 'request' }) => {
    void handleSmartCardCompatRequest(
      smartCardCompatStateRef.current,
      {
        selectedCharacterName: selectedCharacter.name,
        selectedCharacterId: selectedCharacter.id,
        selectedModel,
        selectedSession,
        sessionId: selectedSession?.id ?? null,
        branchId: selectedBranch?.id ?? null,
        wb,
        setChatMessage: applySmartCardMessageUpdate,
        appendMessage: async (payload) => {
          const cleanContent = String(payload.content || '').trim();
          if (!cleanContent) return { success: false, content: '' };
          let sessionOverride = selectedSession && selectedSession.id !== '__pending__'
            ? selectedSession
            : null;
          if (!sessionOverride) {
            const init = await wrappedHandleInitiateConversation(undefined, { forceNew: true });
            sessionOverride = init?.session ?? null;
          }
          if (!sessionOverride || sessionOverride.id === '__pending__') {
            return { success: false, content: cleanContent };
          }

          const response = await api.post(`/api/character-sessions/${sessionOverride.id}/messages`, {
            content: cleanContent,
            role: payload.role || (payload.is_user ? 'user' : payload.is_system ? 'system' : 'assistant'),
            name: payload.name,
            is_user: payload.is_user,
            is_system: payload.is_system,
            is_name: payload.is_name,
            force_avatar: payload.force_avatar,
            original_avatar: payload.original_avatar,
            avatar: payload.avatar,
            gen_id: payload.gen_id,
            group_id: payload.group_id,
            group_name: payload.group_name,
            selected_group: payload.selected_group,
            groups: payload.groups,
            swipe_id: payload.swipe_id,
            swipes: payload.swipes,
            swipe_info: payload.swipe_info,
            extra: payload.extra,
            model: payload.model || selectedModel,
          });
          const appended = (response as any)?.message;
          if (appended) {
            setMessages(prev => {
              if (prev.some((message) => String(message.id) === String(appended.id))) return prev;
              return [...prev, appended];
            });
          } else if (sessionOverride.id === selectedSession?.id) {
            void loadMessages(sessionOverride.id);
          }
          return { success: true, content: cleanContent, message: appended };
        },
        deleteMessage: async (messageId, index) => {
          const resolvedIndex = typeof index === 'number'
            ? (index < 0 ? messages.length + index : index)
            : messages.findIndex((message, messageIndex) => (
              String(message.id) === String(messageId)
              || String((message as any).message_id) === String(messageId)
              || String((message as any).mesid) === String(messageId)
              || String(messageIndex) === String(messageId)
            ));
          if (resolvedIndex < 0 || resolvedIndex >= messages.length) return;
          const target = messages[resolvedIndex];
          const targetId = target?.id ?? messageId;
          if (selectedSession?.id && targetId != null) {
            await handleDeleteMessage(targetId, resolvedIndex);
          } else {
            setMessages(prev => prev.filter((_, idx) => idx !== resolvedIndex));
          }
        },
        clearChat: async () => {
          const persistedMessages = selectedSession?.id
            ? messages.filter(message => message.id != null)
            : [];
          setMessages([]);
          if (selectedSession?.id && persistedMessages.length > 0) {
            await Promise.allSettled(persistedMessages.map(message => (
              api.delete(`/api/character-sessions/${selectedSession.id}/messages/${message.id}`)
            )));
          }
        },
        stopGeneration: () => {
          handleStopGeneration();
        },
        scrollChatToBottom: scrollSmartCardChatToBottom,
        setInputDraft: (content) => {
          setInputValue(content);
          window.setTimeout(() => {
            document.querySelector<HTMLTextAreaElement>('[data-palink-chat-composer="true"] textarea')?.focus();
          }, 80);
        },
        refresh: () => {
          if (selectedSession?.id) {
            void loadMessages(selectedSession.id);
          }
        },
        sendMessage: async (content, options) => {
          const cleanContent = String(content || '').trim();
          const isGenerationTrigger = options?.source === 'triggerGeneration'
            || options?.source === 'Generate'
            || options?.source === 'generate';
          if (!cleanContent && !isGenerationTrigger) return { success: false, content: '' };
          let sessionOverride = selectedSession && selectedSession.id !== '__pending__'
            ? selectedSession
            : null;
          let branchIdOverride: string | null | undefined;
          if (!sessionOverride) {
            const init = await wrappedHandleInitiateConversation(undefined, { forceNew: true });
            sessionOverride = init?.session ?? null;
            branchIdOverride = init?.branchId ?? null;
          }
          const result = await wrappedHandleSmartCardTrigger(cleanContent, {
            sessionOverride,
            branchIdOverride,
            awaitResult: Boolean(options?.awaitResult),
            useEmptyContext: isGenerationTrigger && !cleanContent,
          });
          return { success: true, content: result || '' };
        },
      },
      action,
    );
  }, [api, applySmartCardMessageUpdate, handleDeleteMessage, handleStopGeneration, loadMessages, messages, scrollSmartCardChatToBottom, selectedCharacter.name, selectedModel, selectedSession, setInputValue, setMessages, wb, wrappedHandleInitiateConversation, wrappedHandleSmartCardTrigger]);

  const handleSmartCardAction = useCallback((action: SmartCardAction) => {
    if (
      action.type === 'setChatMessage'
      && (action.content.trim() || smartCardUpdateHasDisplayLayer(action.options || {}))
    ) {
      void applySmartCardMessageUpdate(action);
      return;
    }
    if (action.type === 'setInputDraft') {
      setInputValue(action.content);
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('[data-palink-chat-composer="true"] textarea')?.focus();
      }, 80);
      return;
    }
    if (action.type === 'request') {
      void handleSmartCardRequest(action);
      return;
    }
    if (action.type === 'diagnostic') {
      handleSmartCardCompatDiagnostic(smartCardCompatStateRef.current, action.diagnostic);
      return;
    }
    if (action.type === 'scrollChatToBottom') {
      scrollSmartCardChatToBottom();
      return;
    }
    if (action.type === 'sendMessage' && action.content.trim()) {
      const content = action.content.trim();
      if (!selectedSession || selectedSession.id === '__pending__') {
        void (async () => {
          const init = await wrappedHandleInitiateConversation(undefined, { forceNew: true });
          if (!init) return;
          await wrappedHandleSmartCardTrigger(content, {
            sessionOverride: init?.session ?? null,
            branchIdOverride: init?.branchId ?? null,
          });
        })();
      } else {
        void wrappedHandleSmartCardTrigger(content);
      }
      return;
    }
    if (action.type === 'triggerGeneration') {
      const content = String(action.content || '').trim();
      if (!selectedSession || selectedSession.id === '__pending__') {
        void (async () => {
          const init = await wrappedHandleInitiateConversation(undefined, { forceNew: true });
          if (!init) return;
          await wrappedHandleSmartCardTrigger(content, {
            sessionOverride: init?.session ?? null,
            branchIdOverride: init?.branchId ?? null,
            awaitResult: Boolean(action.awaitResult),
            useEmptyContext: !content,
          });
        })();
      } else {
        void wrappedHandleSmartCardTrigger(content, {
          awaitResult: Boolean(action.awaitResult),
          useEmptyContext: !content,
        });
      }
      return;
    }
    if (action.type === 'inspectElement') {
      const label = action.target.text || action.target.selector || action.target.tag;
      console.info('Character smart card element selected:', label, action.target);
      return;
    }
    if (action.type === 'error' && action.message) {
      console.warn('Character smart card error:', action.message);
    }
  }, [applySmartCardMessageUpdate, handleSmartCardRequest, scrollSmartCardChatToBottom, selectedSession, setInputValue, smartCardUpdateHasDisplayLayer, wrappedHandleInitiateConversation, wrappedHandleSmartCardTrigger]);

  const wrappedHandleRegenerate = useCallback(async (idx: number) => {
    isAtBottomRef.current = true;
    await handleRegenerate(idx);
  }, [handleRegenerate, isAtBottomRef]);

  useEffect(() => {
    if (newSessionFadeState === 'idle') return;

    const timeoutId = window.setTimeout(() => {
      setNewSessionFadeState('idle');
      setSessionVisualSnapshot(null);
    }, 1000);

    return () => window.clearTimeout(timeoutId);
  }, [newSessionFadeState]);

  const displayedActiveSessionId = sessionVisualSnapshot ? sessionVisualSnapshot.activeSessionId : (selectedSession?.id || null);
  const displayedMessages = sessionVisualSnapshot ? sessionVisualSnapshot.messages : messages;
  const displayedSuggestions = sessionVisualSnapshot ? [] : suggestions;

  // 稳定回调：按消息 id 定位索引，避免每条消息每帧创建新闭包导致 Message memo 失效
  const displayedMessagesRef = useRef(displayedMessages);
  displayedMessagesRef.current = displayedMessages;
  const wrappedHandleRegenerateRef = useRef(wrappedHandleRegenerate);
  wrappedHandleRegenerateRef.current = wrappedHandleRegenerate;
  const handleEditMessageRef = useRef(handleEditMessage);
  handleEditMessageRef.current = handleEditMessage;

  const handleRegenerateAt = useCallback((messageId?: string | number) => {
    if (messageId === undefined || messageId === null) return;
    const idx = displayedMessagesRef.current.findIndex((m) => String(m.id) === String(messageId));
    if (idx >= 0) void wrappedHandleRegenerateRef.current(idx);
  }, []);

  // [MVU-SECONDARY-MANUAL] 手动触发副 AI 变量更新：以指定消息剧情为源，
  // 调用后端 POST /api/character-sessions/{session_id}/mvu-secondary 解析变量。
  // 成功后用返回的 variables 刷新会话级 stat_data（驱动角色面板/状态栏）。
  const [mvuSecondaryRunning, setMvuSecondaryRunning] = useState(false);
  const handleManualMvuSecondary = useCallback(async (messageId?: string | number) => {
    if (!selectedSession || selectedSession.id === '__pending__') {
      toast.error('会话未创建，无法更新变量');
      return;
    }
    if (mvuSecondaryRunning) return;
    setMvuSecondaryRunning(true);
    try {
      const res = await api.post(`/api/character-sessions/${selectedSession.id}/mvu-secondary`, {
        message_id: messageId != null ? Number(messageId) : null,
      });
      if (res?.variables && typeof res.variables === 'object') {
        setSessionVariables(res.variables as { stat_data?: Record<string, unknown> });
        window.dispatchEvent(new CustomEvent('palink:mvuVariablesUpdated', {
          detail: { sessionId: selectedSession.id, variables: res.variables },
        }));
      }
      if (res?.applied) {
        toast.success('变量已更新');
      } else {
        const reason = res?.reason || 'no_patches';
        if (reason === 'secondary_disabled' || reason === 'secondary_model_missing') {
          toast.error('副 AI 未配置，请在设置中开启并填写模型');
        } else if (reason === 'no_schema') {
          toast.error('角色卡无变量系统（无 tavern_helper schema）');
        } else if (reason === 'no_patches') {
          toast.info('副 AI 未解析出变量变化');
        } else {
          toast.info('变量更新完成（无变化）');
        }
      }
    } catch (e: any) {
      console.error('Manual MVU secondary failed:', e);
      toast.error('变量更新失败');
    } finally {
      setMvuSecondaryRunning(false);
    }
  }, [selectedSession, mvuSecondaryRunning]);

  const handleEditAt = useCallback((newContent: string, messageId?: string | number) => {
    if (messageId === undefined || messageId === null) return;
    const idx = displayedMessagesRef.current.findIndex((m) => String(m.id) === String(messageId));
    if (idx >= 0) handleEditMessageRef.current(String(messageId), idx, newContent);
  }, []);
  const mobileComposerClosedBottomPx = composerBottomPx > 0 ? composerBottomPx : 90;
  // iOS WebApp 键盘弹出时视口已自动缩小，输入框定位在 nav 上方（不需要 keyboardHeight）
  const mobileComposerKeyboardBottomPx = mobileComposerClosedBottomPx;
  const mobileMessagesBottomPaddingPx = isKeyboardOpen
    ? Math.max(
        140,
        mobileComposerKeyboardBottomPx + MOBILE_CHAT_INPUT_ESTIMATED_HEIGHT_PX + MOBILE_CHAT_INPUT_GAP_PX,
      )
    : mobileComposerClosedBottomPx + MOBILE_CHAT_INPUT_ESTIMATED_HEIGHT_PX + MOBILE_CHAT_INPUT_GAP_PX;
  // [REASONING-SEPARATE] 插件边界适配：iframe 通道的 mes 预剥离思考块（含存量混合行），
  // 思考走 extra.reasoning 独立字段——源码不可改的随卡插件（BubbleDialogue 等）靠此保兼容
  const smartCardChatMessages = useMemo(() => displayedMessages.map((item, index) => {
    const { content: cleanMes, reasoning } = extractReasoningTags(item.content || '');
    const baseExtra = (item as any).extra && typeof (item as any).extra === 'object' ? (item as any).extra : {};
    const boundaryExtra = reasoning && !(typeof baseExtra.reasoning === 'string' && baseExtra.reasoning.trim())
      ? { ...baseExtra, reasoning }
      : baseExtra;
    const stripSwipe = (s: string) => extractReasoningTags(s || '').content;
    const rawSwipes: string[] = Array.isArray((item as any).swipes) && (item as any).swipes.length
      ? (item as any).swipes
      : [item.content || ''];
    return {
      id: item.id ?? null,
      message_id: item.message_id ?? item.id ?? null,
      mesid: Number.isFinite(Number(item.mesid)) ? Number(item.mesid) : index,
      role: item.role,
      is_user: typeof item.is_user === 'boolean' ? item.is_user : item.role === 'user',
      is_system: typeof item.is_system === 'boolean' ? item.is_system : item.role === 'system',
      is_name: typeof (item as any).is_name === 'boolean'
        ? (item as any).is_name
        : typeof (item as any).extra?.is_name === 'boolean'
          ? (item as any).extra.is_name
          : true,
      force_avatar: (item as any).force_avatar ?? (item as any).extra?.force_avatar,
      original_avatar: (item as any).original_avatar ?? (item as any).extra?.original_avatar,
      avatar: (item as any).avatar ?? (item as any).extra?.avatar,
      gen_id: (item as any).gen_id ?? (item as any).extra?.gen_id,
      group_id: (item as any).group_id ?? (item as any).extra?.group_id,
      group_name: (item as any).group_name ?? (item as any).extra?.group_name,
      selected_group: (item as any).selected_group ?? (item as any).extra?.selected_group,
      groups: (item as any).groups ?? (item as any).extra?.groups,
      name: item.name || (item.role === 'user' ? user.username : item.role === 'system' ? 'System' : selectedCharacter.name),
      content: cleanMes,
      mes: cleanMes,
      message: cleanMes,
      text: cleanMes,
      swipes: rawSwipes.map(stripSwipe),
      swipe_id: Number.isFinite(Number((item as any).swipe_id)) ? Number((item as any).swipe_id) : 0,
      swipe_info: Array.isArray((item as any).swipe_info) ? (item as any).swipe_info : [],
      extra: boundaryExtra,
      created_at: item.created_at,
    };
  }), [displayedMessages, selectedCharacter.name, user.username]);

  const totalMsgCount = displayedMessages.length;

  // Fix 3: 暴露 window.__palinkChatMessages 给 ST 插件 sandbox（getChatMessages / getLastMessageId 数据源）
  // 结构对齐 ST chat 数组：name / is_user / is_system / mes / mesid / send_date / swipes / extra
  useEffect(() => {
    if (sillyTavernMode === 'st-native') return;
    const w = window as any;
    w.__palinkChatMessages = smartCardChatMessages.map((m) => ({
      name: m.name,
      is_user: m.is_user,
      is_system: m.is_system,
      is_name: m.is_name,
      mes: stripStyleBlocks(m.mes),
      mesid: m.mesid,
      send_date: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
      swipes: (Array.isArray(m.swipes) ? m.swipes : [m.mes || '']).map(stripStyleBlocks),
      swipe_id: m.swipe_id,
      swipe_info: m.swipe_info,
      extra: m.extra || {},
    }));
    return () => {
      // 切换会话/组件卸载时清理，避免旧数据被插件读到
      delete (w as any).__palinkChatMessages;
    };
  }, [smartCardChatMessages, selectedSession?.id, sillyTavernMode]);

  // Fix 2: 注册 ST 桥接钩子，供 Galgame 等插件通过隐藏虚拟元素（#send_but /
  // #option_regenerate）或 SillyTavern.Generate 驱动真实聊天发送与重生成。
  // 桥接虚拟元素在 sillyTavernPluginRuntime 的 setup script 中创建，这里只注册回调。
  useEffect(() => {
    if (sillyTavernMode === 'st-native') return;
    const w = window as any;
    w.__palinkSendText = (text: string) => {
      const cleaned = String(text || '').replace(/<\/?user>/gi, '').trim();
      if (!cleaned) return;
      void wrappedHandleSendMessage(cleaned, []);
    };
    w.__palinkRegenerate = () => {
      const idx = displayedMessages.findLastIndex((m) => m.role === 'assistant');
      if (idx >= 0) void wrappedHandleRegenerate(idx);
    };
    return () => {
      delete w.__palinkSendText;
      delete w.__palinkRegenerate;
    };
  }, [sillyTavernMode, wrappedHandleSendMessage, wrappedHandleRegenerate, displayedMessages]);

  useEffect(() => {
    // 方向1隔离：在非 st-native 模式下注入插件 runtime 到容器（保留 ST 逆向接口）
    if (sillyTavernMode === 'st-native') return;
    const runtime = stRuntimeRef.current;
    if (!runtime) return;
    runtime.loadRuntimeConfig().then(() => {
      // 注入到独立容器（body 下，不在 React 树中）：避免插件 <script>/<style>
      // 被附加到 React 管理的 .roleplay-container，导致 React 重新渲染时
      // DOM 不一致触发 NotFoundError: insertBefore/removeChild。
      // 插件脚本通过 jQuery 在整个 document 上查询，不受容器位置影响。
      let pluginHost = document.getElementById('palink-st-plugin-host');
      if (!pluginHost) {
        pluginHost = document.createElement('div');
        pluginHost.id = 'palink-st-plugin-host';
        pluginHost.style.display = 'none';
        document.body.appendChild(pluginHost);
      }
      runtime.injectIntoContainer(pluginHost);
    }).catch((err) => {
      console.error('Failed to load SillyTavern plugin runtime config:', err);
    });
    return () => {
      runtime.unloadAll();
    };
  }, []);

  useEffect(() => {
    const handleSettingsUpdated = () => {
      stRuntimeRef.current?.reload();
    };
    window.addEventListener('userSettingsUpdated', handleSettingsUpdated);
    return () => window.removeEventListener('userSettingsUpdated', handleSettingsUpdated);
  }, []);

  useEffect(() => {
    const stContext = {
      name: user.username || 'User',
      character: {
        name: selectedCharacter.name,
        description: selectedCharacter.description || '',
        personality: selectedCharacter.personality || '',
        scenario: selectedCharacter.scenario || '',
        first_mes: selectedCharacter.first_mes || '',
        mes_example: selectedCharacter.mes_example || '',
        creator_notes: selectedCharacter.creator_notes || '',
        tags: selectedCharacter.tags || [],
        avatar: String(selectedCharacter.avatar || '').split(/[\\/]/).pop() || '',
        // ST 兼容：暴露角色卡 extensions（含 tavern_helper 变量结构），
        // 供 Tavern Helper 插件读取 schema 生成好感度等面板。
        extensions: compatCharacterExtensions || selectedCharacter.extensions || {},
      },
      // ST 兼容：会话级 MVU 变量（stat_data），供 Tavern Helper 插件读取并渲染面板。
      stat_data: (sessionVariables && sessionVariables.stat_data) || {},
      // ST 插件（如 Galgame 界面插件）通过 characterId / name2 / this_chid 识别当前角色，
      // 缺失时回退到 "default" 键，导致 localStorage 中 default=true 时误启用 overlay。
      // 使用角色名 charCode 哈希作为非零数字 ID，确保不同角色有不同键。
      characterId: selectedCharacter.name
        ? Array.from(selectedCharacter.name).reduce((acc, c) => acc + c.charCodeAt(0), 0) || 1
        : 1,
      characterUuid: selectedCharacter.id,
      name2: selectedCharacter.name,
      chat: smartCardChatMessages.map((m) => ({
        name: m.name,
        mes: stripStyleBlocks(m.mes),
        is_user: m.is_user,
        send_date: m.created_at ? new Date(m.created_at).getTime() : undefined,
        extra: m.extra,
        swipes: m.swipes,
        swipe_id: m.swipe_id,
        swipe_info: m.swipe_info,
      })) as StChatMessage[],
      chatId: selectedSession?.id || '',
    };

    stRuntimeRef.current?.setContext(stContext);

    const globalRuntime = getGlobalSillyTavernRuntime();
    if (globalRuntime) {
      globalRuntime.setContext(stContext);
    }
  }, [selectedCharacter.name, selectedCharacter.description, selectedCharacter.personality, selectedCharacter.scenario, selectedCharacter.first_mes, selectedCharacter.mes_example, selectedCharacter.creator_notes, selectedCharacter.tags, selectedCharacter.avatar, selectedCharacter.extensions, compatCharacterExtensions, sessionVariables, smartCardChatMessages, selectedSession?.id, user.username]);

  useEffect(() => {
    // 方向1隔离：在非 st-native 模式下创建全局 ST runtime，避免影响 st-native 的 ST iframe
    if (sillyTavernMode === 'st-native') return;
    const globalRuntime = getGlobalSillyTavernRuntime();
    if (!globalRuntime) {
      createSillyTavernRuntime({
        name: user.username || 'User',
        character: {
          name: selectedCharacter.name,
          description: selectedCharacter.description || '',
          personality: selectedCharacter.personality || '',
          scenario: selectedCharacter.scenario || '',
          first_mes: selectedCharacter.first_mes || '',
          mes_example: selectedCharacter.mes_example || '',
          creator_notes: selectedCharacter.creator_notes || '',
          tags: selectedCharacter.tags || [],
          avatar: selectedCharacter.avatar || '',
        },
        chat: smartCardChatMessages.map((m) => ({
          name: m.name,
          mes: stripStyleBlocks(m.mes),
          is_user: m.is_user,
          send_date: m.created_at ? new Date(m.created_at).getTime() : undefined,
          extra: m.extra,
          swipes: m.swipes,
          swipe_id: m.swipe_id,
          swipe_info: m.swipe_info,
        })) as StChatMessage[],
        chatId: selectedSession?.id || '',
      });
    }
    return () => {
      destroySillyTavernRuntime();
    };
  }, []);

  const prevIsGeneratingRef = useRef(isGenerating);
  useEffect(() => {
    const prev = prevIsGeneratingRef.current;
    prevIsGeneratingRef.current = isGenerating;
    if (prev && !isGenerating) {
      const lastMsg = displayedMessages[displayedMessages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        // MVU 变量刷新：后端在生成完成时已把 <UpdateVariable> JSON Patch 写入会话
        // stat_data，但前端此前只在会话打开时加载一次——新消息后从不重取，
        // 卡片拿到的 stat_data 永远是旧的（"变量进不了卡"的根因）。
        const sid = selectedSession?.id;
        if (sid) {
          void api.get(`/api/character-sessions/${sid}/messages?limit=1`)
            .then((res: any) => {
              const _vk = (res?.variables && typeof res.variables === 'object') ? Object.keys(res.variables) : null;
              const _sk = (res?.variables?.stat_data && typeof res.variables.stat_data === 'object') ? Object.keys(res.variables.stat_data) : null;
              console.warn('[VAR-DBG] session-refetch variables keys=', _vk, 'stat_data keys=', _sk);
              if (res?.variables) setSessionVariables(res.variables);
            })
            .catch(() => {});
        }
        const processed = getRegexedStringForMessage(lastMsg.content || '', regex_placement.AI_OUTPUT, {
          characterName: selectedCharacter.name,
          userName: user.username,
          characterAvatar: selectedCharacter.avatar || '',
          characterExtensions: compatCharacterExtensions,
          characterPresetData: compatCharacterPresetData,
          globalRegexScripts,
        });
        if (processed !== lastMsg.content && lastMsg.id != null) {
          handleEditMessage(lastMsg.id, displayedMessages.length - 1, processed);
        }
        stRuntimeRef.current?.emit('MESSAGE_RECEIVED', {
          message: {
            name: selectedCharacter.name,
            mes: processed || '',
            is_user: false,
          },
        });
        try {
          getGlobalSillyTavernRuntime()?.emitMessageReceived(displayedMessages.length - 1);
        } catch {}
      }
    }
  }, [isGenerating, displayedMessages, selectedCharacter.name, user.username, selectedCharacter.avatar, compatCharacterExtensions, compatCharacterPresetData, globalRegexScripts, handleEditMessage]);

  const prevSessionIdRef = useRef<string | null>(selectedSession?.id || null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    const current = selectedSession?.id || null;
    prevSessionIdRef.current = current;
    if (prev !== current && current) {
      stRuntimeRef.current?.emit('CHAT_CHANGED', { chatId: current });
    }
  }, [selectedSession?.id]);

  // handleSessionSwitchWithFade / handleNewSessionWithFade 已从 useSessionSwitchAnimation 提取

  return (
    <div
      ref={(el) => {
        (outerContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (el && isMobile) {
          if (!(el as any).__resizeObsAttached) {
            (el as any).__resizeObsAttached = true;
            const ro = new ResizeObserver(() => {});
            ro.observe(el);
          }
        }
      }}
      className="relative w-full h-full overflow-hidden"
    >
      {/* ──── Mobile Sidebar ──── */}
      {isMobile && (
        <ChatSidebar
          isMobile={true}
          isDark={isDark}
          isNavigating={isNavigating}
          branchTree={branchTree}
          selectedSessionId={selectedSession?.id}
          selectedBranch={selectedBranch}
          branches={branches}
          mobileSidebarOpen={effectiveMobileSidebarOpen}
          sidebarCollapsed={sidebarCollapsed}
          onNavigate={wrappedHandleStorylineNavigate}
          onCreateBranch={createBranch}
          onDeleteBranch={deleteBranch}
          onClose={() => setSidebarCollapsed(true)}
        />
      )}

      {/* ──── Desktop Sidebar + Main Content (移动端跟随侧边栏右移) ──── */}
      <div
        ref={contentWrapperRef}
        className={cn(
          'flex h-full min-w-0 transition-transform ease-in-out will-change-transform',
          isMobile ? 'absolute inset-0 z-10 w-full overflow-hidden' : 'relative w-full'
        )}
        style={isMobile ? {
          transform: `translate3d(${effectiveMobileSidebarOpen ? 320 : 0}px, 0, 0)`,
          transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms`,
        } : undefined}
        onClick={() => {
          if (isMobile && mobileSidebarOpen && !isNavigating) {
            setSidebarCollapsed(true);
          }
        }}
      >
      {/* ──── Desktop Sidebar ──── */}
      {!isMobile && (
        <ChatSidebar
          isMobile={false}
          isDark={isDark}
          isNavigating={isNavigating}
          branchTree={branchTree}
          selectedSessionId={selectedSession?.id}
          selectedBranch={selectedBranch}
          branches={branches}
          mobileSidebarOpen={effectiveMobileSidebarOpen}
          sidebarCollapsed={sidebarCollapsed}
          onNavigate={wrappedHandleStorylineNavigate}
          onCreateBranch={createBranch}
          onDeleteBranch={deleteBranch}
          onClose={() => setSidebarCollapsed(true)}
        />
      )}

      {/* ──── Main chat area ──── */}
      {sillyTavernMode === 'st-native' ? (
        <SillyTavernIframe
          character={selectedCharacter}
          messages={displayedMessages}
          user={user}
          sessionId={selectedSession?.id}
          branchId={selectedBranch?.id}
          selectedModel={selectedModel}
          onSendMessage={async (content) => { await wrappedHandleSendMessage(content, []); }}
          isGenerating={isGenerating}
          useNative={true}
          onBackToPalink={onBackToList}
        />
      ) : (
      <div
        ref={chatAreaRef}
        className={`flex-1 flex flex-col h-full overflow-hidden relative pb-[env(safe-area-inset-bottom)] bg-slate-50 dark:bg-slate-950 transition-opacity duration-300 ease-in-out`}
      >
        <ChatHeader
          isMobile={isMobile}
          isDark={isDark}
          isNavigating={isNavigating}
          selectedCharacter={selectedCharacter}
          models={models}
          selectedModel={selectedModel}
          onSelectModel={handleSelectModel}
          currentPreset={currentPreset}
          setCurrentPreset={setCurrentPreset}
          showPresetPanel={showPresetPanel}
          setShowPresetPanel={setShowPresetPanel}
          mobileSidebarOpen={mobileSidebarOpen}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={handleToggleDesktopSidebar}
          onToggleMobileSidebar={handleToggleMobileSidebar}
          isMixedDeleteMode={isMixedDeleteMode}
          selectedWholeMessages={selectedWholeMessages}
          selectedMessageParts={selectedMessageParts}
          onMixedDelete={handleMixedDeleteWithCheck}
          onExitDeleteMode={handleExitDeleteMode}
          t={t}
          onBackToList={onBackToList}
          moreMenuProps={{
            selectedSession,
            selectedCharacter,
            t,
            currentPreset,
            isNavigating,
            mobileSidebarOpen,
            dialogueMode,
            autoGenerateChatImages,
            responseLength,
            plotLineSessionStatus: pl.sessionStatus,
            memoryStats,
            compressing,
            onShowPresetPanel: () => setShowPresetPanel(true),
            onShowPresetManager: () => setShowPresetManager(true),
            onShowWorldBookManager: () => setShowWorldBookManager(true),
            onToggleStoryline: handleToggleStoryline,
            onToggleDialogueMode: handleToggleDialogueMode,
            onToggleAutoGenerateImages: handleToggleAutoGenerateImages,
            onResponseLengthChange: handleResponseLengthChange,
            onShowPluginManager: () => setPluginManagerOpen(true),
            onPrevStage: handlePrevStage,
            onNextStage: handleNextStage,
            onShowPlotLineManager: () => setShowPlotLineManager(true),
            onCompressMemory: manualCompressMemory,
            onEnterDeleteMode: () => setIsMixedDeleteMode(true),
          }}
        />

        {/* ──── Content area with fade transition ──── */}
        <div
          className={cn(
            'flex-1 flex flex-col overflow-hidden transition-opacity ease-in-out',
            newSessionFadeState === 'fading-out' ? 'opacity-0' : 'opacity-100'
          )}
          style={{ transitionDuration: `${NEW_SESSION_FADE_DURATION_MS}ms` }}
        >
        {/* ──── Empty state / new chat ──── */}
        {displayedMessages.length === 0 && !displayedActiveSessionId && !initializingChat && (
          <ChatEmptyState
            character={selectedCharacter}
            isMobile={isMobile}
            isDark={isDark}
            isKeyboardOpen={isKeyboardOpen}
            composerBottomPx={composerBottomPx}
            showDesktopHint={showDesktopHint}
            initializingChat={initializingChat}
            t={t}
            onDismissDesktopHint={() => {
              setShowDesktopHint(false);
              localStorage.setItem('palink-mobile-desktop-hint-dismissed', 'true');
            }}
            onShowWorldBookManager={() => setShowWorldBookManager(true)}
            onStartConversation={() => wrappedHandleInitiateConversation(undefined, { forceNew: true })}
          />
        )}

        {/* ──── Initializing spinner ──── */}
        {initializingChat && (
          <ChatInitializingState
            isMobile={isMobile}
            isKeyboardOpen={isKeyboardOpen}
            composerBottomPx={composerBottomPx}
            t={t}
          />
        )}

        {/* ──── Messages area ──── */}
        {(displayedMessages.length > 0 || displayedActiveSessionId) && (
          <div
            id="chat"
            className={cn('rp-chat-area flex-1 flex flex-col overflow-y-auto space-y-4 pt-4 pb-4 w-full', isMobile ? 'px-1' : 'px-2')}
            style={isMobile ? { paddingBottom: `${mobileMessagesBottomPaddingPx}px` } : undefined}
            onScroll={handleScroll}
            onClick={() => { activePausedAutoScrollRef.current = true; }}
          >
            {isMobile && (
              <div style={{ height: 'calc(env(safe-area-inset-top) + 3.5rem)', width: '100%' }} />
            )}
            {wb.sessionStatus?.active && (
              <StageIndicator
                status={wb.sessionStatus}
              />
            )}
            {forkPoint && (
              <div className={cn(
                'flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium',
                isDark
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                  : 'bg-amber-50 text-amber-700 border border-amber-200'
              )}>
                <div className="flex items-center gap-1.5">
                  <GitBranch size={13} />
                  <span>已截断至此节点 · 输入新消息将从这里分叉</span>
                </div>
                <button
                  onClick={clearForkPoint}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors',
                    isDark ? 'bg-amber-500/20 hover:bg-amber-500/30' : 'bg-amber-100 hover:bg-amber-200'
                  )}
                >
                  取消
                </button>
              </div>
            )}
            {hasMoreMessages && (
              <div className="flex justify-center py-2">
                <button
                  onClick={loadOlderMessages}
                  disabled={isLoadingOlderMessages}
                  className={cn(
                    'px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
                    isDark ? 'bg-white/5 hover:bg-white/10 text-muted-foreground' : 'bg-black/5 hover:bg-black/10 text-muted-foreground',
                    isLoadingOlderMessages && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {isLoadingOlderMessages ? '加载中...' : '↑ 加载更早消息'}
                </button>
              </div>
            )}
            {displayedMessages.map((msg, idx) => {
              return (
              <Message
                key={msg.id || idx}
                message={msg}
                userAvatar={user.avatar}
                userName={user.username}
                characterAvatar={selectedCharacter.avatar}
                characterName={selectedCharacter.name}
                characterId={selectedCharacter.id}
                characterFirstMes={selectedCharacter.first_mes}
                characterAlternateGreetings={selectedCharacter.alternate_greetings}
                sessionId={selectedSession?.id}
                sessionVariables={sessionVariables}
                isCharacterChat={true}
                characterExtensions={compatCharacterExtensions || selectedCharacter.extensions}
                characterPresetData={compatCharacterPresetData ?? selectedCharacter.preset_data}
                globalRegexScripts={globalRegexScripts}
                totalMessages={totalMsgCount}
                chatMessages={smartCardChatMessages}
                models={models}
                streaming={(isGenerating && idx === totalMsgCount - 1) || regeneratingMessageIndex === idx}
                isLast={idx === totalMsgCount - 1}
                t={t}
                tokens={msg.tokens}
                memoryMode={memoryMode}
                memoryStats={idx === totalMsgCount - 1 && msg.role === 'assistant' ? memoryStats : null}
                onCompress={idx === totalMsgCount - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                compressing={compressing}
                onRegenerate={msg.role === 'assistant' && !isGenerating ? handleRegenerateAt : undefined}
                canRegenerate={msg.role === 'assistant' && !isGenerating}
                showModelReasoning={showModelReasoning}
                onEdit={msg.id != null ? handleEditAt : undefined}
                canEdit={msg.role === 'assistant' && !isGenerating}
                onGenerateImage={msg.id != null ? handleGenerateImage : undefined}
                isGeneratingImage={msg.id != null ? generatingImageMessageIds.has(String(msg.id)) : false}
                onSmartCardAction={handleSmartCardAction}
                onManualMvuSecondary={msg.role === 'assistant' ? handleManualMvuSecondary : undefined}
                mvuSecondaryRunning={mvuSecondaryRunning}
                isMixedDeleteMode={isMixedDeleteMode}
                messageIndex={idx}
                selectedWholeMessages={selectedWholeMessages}
                selectedMessageParts={selectedMessageParts}
                onToggleWholeMessageSelect={toggleWholeMessageSelect}
                onToggleMessagePartSelect={toggleMessagePartSelect}
                onSelectAllPartsInMessage={selectAllPartsInMessage}
                chatStyle={currentTheme.chatStyle}
                useNativeStRendering={currentTheme.toggles.useNativeStRendering}
                characterDisplayMode={characterDisplayMode}
              />
              );
            })}

            {displayedSuggestions.length > 0 && !isGenerating && (
              <div className="flex flex-wrap gap-2 pl-4 sm:pl-12 animate-fade-in-up">
                {displayedSuggestions.map((s, idx) => (
                  <button
                    key={idx}
                    onClick={() => wrappedHandleSendMessage(s, [])}
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
        )}
        </div>

        {/* ──── Chat input (仅在有会话时显示) ──── */}
        {displayedActiveSessionId && (
          <ChatInputArea
            isMobile={isMobile}
            isDark={isDark}
            isGenerating={isGenerating}
            isKeyboardOpen={isKeyboardOpen}
            composerBottomPx={composerBottomPx}
            keyboardHeight={keyboardHeight}
            inputValue={inputValue}
            setInputValue={setInputValue}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            uploading={uploading}
            onUpload={handleUpload}
            onSend={wrappedHandleSendWithInput}
            onStop={handleStop}
            onNewSession={handleNewSessionWithFade}
            character={selectedCharacter}
            t={t}
          />
        )}
      </div>
      )}
      </div>

      {/* ──── Confirm dialogs ──── */}
      <ChatConfirmDialogs
        showDeleteConfirm={showDeleteConfirm}
        setShowDeleteConfirm={setShowDeleteConfirm}
        pendingDelete={pendingDelete}
        selectedSessionsCount={selectedSessions.size}
        confirmDelete={confirmDelete}
        showDeleteBranchConfirm={showDeleteBranchConfirm}
        setShowDeleteBranchConfirm={setShowDeleteBranchConfirm}
        confirmDeleteBranch={confirmDeleteBranch}
        showDeleteMixedConfirm={showDeleteMixedConfirm}
        setShowDeleteMixedConfirm={setShowDeleteMixedConfirm}
        confirmDeleteMixed={confirmDeleteMixed}
        dialogText={dialogText}
      />

      {/* ──── Error Toast ──── */}
      {currentError && (
        <ErrorToast
          errorInfo={currentError}
          onClose={handleCloseError}
          onRetry={handleRetry}
          showRetry={!!retryMessageContent}
        />
      )}

      {/* ──── Timeout Warning ──── */}
      {timeoutWarning && isGenerating && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm w-full">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <Clock className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-yellow-800 dark:text-yellow-200">{t.request_taking_long || '请求时间较长'}</h4>
                <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                  {t.ai_processing || 'AI模型正在处理您的请求，这可能需要一些时间。请耐心等待，或尝试切换到其他模型。'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ──── Manager Dialogs ──── */}
      <ChatManagerDialogs
        isDark={isDark}
        t={t}
        models={models}
        selectedModel={selectedModel}
        selectedCharacter={selectedCharacter}
        selectedSessionId={selectedSession?.id}
        currentPreset={currentPreset}
        setCurrentPreset={setCurrentPreset}
        showPresetManager={showPresetManager}
        onShowPresetManagerChange={setShowPresetManager}
        showWorldBookManager={showWorldBookManager}
        onShowWorldBookManagerChange={setShowWorldBookManager}
        showWorldBookOverview={showWorldBookOverview}
        onShowWorldBookOverviewChange={setShowWorldBookOverview}
        worldBookStatus={wb.sessionStatus}
        wb={wb}
        showPlotLineManager={showPlotLineManager}
        onShowPlotLineManagerChange={setShowPlotLineManager}
        pl={pl}
      />

      {/* ──── Plugin Manager ──── */}
      <PluginManager
        open={pluginManagerOpen}
        onClose={() => setPluginManagerOpen(false)}
      />
    </div>
  );
};
