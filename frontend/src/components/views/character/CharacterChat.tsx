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
import { Clock, GitBranch, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, invalidateCache } from '@/services/api';
import { generationEngine } from '@/services/generation-engine';
import { toast } from 'sonner';
import { resolveMvuSecondaryFeedback } from '@/components/views/character/mvuSecondaryFeedback';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import { Message } from '@/components/ui/custom/Message';
import { useRoleplayTheme } from '@/contexts/RoleplayThemeContext';
import type { SmartCardAction } from '@/components/ui/custom/CharacterCardRenderer';
import {
  handleSmartCardCompatDiagnostic,
  handleSmartCardCompatRequest,
  type SmartCardCompatControllerState,
} from '@/components/ui/custom/smart-card-runtime/SmartCardCompatController';
// 插件侧角色身份派生（2026-10-02 P1：名字哈希 → UUID 派生）
import { pluginCharacterIdFromUuid } from '@/lib/sillytavern/plugin-character-id';
// 卡脚本存档的服务端写穿同步（P2）；失败静默降级为纯本地
import { installCardScriptStorageSync } from '@/lib/sillytavern/card-script-storage-sync';
import { ErrorToast, ErrorToastPortalContainer } from '@/components/ui/custom/ErrorToast';
import { StageIndicator } from '@/components/ui/custom/StageIndicator';
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
import { getCachedGlobalRegexScripts, preloadGlobalRegexScripts, loadEngineConfig, normalizeCardFacingMessage } from '@/utils/sillyTavernDisplayPipeline';
// D 批清理: 类型改取自正则引擎正典定义（utils/regexEngine.ts 已删除）
import type { RegexScript } from '@/lib/sillytavern/regex/engine';
import { getRegexedStringForMessage } from '@/lib/sillytavern/regex/adapter';
import { regex_placement } from '@/lib/sillytavern/regex/engine';
import { extractReasoningTags } from '@/lib/sillytavern/formatting';
import { promptInjection, setActivePromptCharacter, getActivePromptCharacter } from '@/services/prompt-injection';
import { PluginManager } from '@/components/roleplay/PluginManager';
import { StPluginSettingsDrawer } from '@/components/st-plugin-ui-host/StPluginSettingsDrawer';
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

// [N-3] 尾部实时条数：最后 K 条（正在流式的 assistant + 触发它的 user）每次重建，
// 其余历史元素引用恒定（ref 快照复用），避免每个 SSE chunk 击穿下游 Message memo 与 pipelineResult。
const SMART_CARD_TAIL_REALTIME_COUNT = 2;

// [N-3] 单条消息 → 智能卡上下文条目的纯映射（模块级函数，便于历史快照按引用复用）
function buildSmartCardChatEntry(
  item: CharacterChatMessage,
  index: number,
  characterName: string,
  userNameFallback: string,
) {
  const { content: cleanMes, reasoning } = extractReasoningTags(item.content || '');
  const baseExtra = (item as any).extra && typeof (item as any).extra === 'object' ? (item as any).extra : {};
  const boundaryExtra = reasoning && !(typeof baseExtra.reasoning === 'string' && baseExtra.reasoning.trim())
    ? { ...baseExtra, reasoning }
    : baseExtra;
  const stripSwipe = (s: string) => extractReasoningTags(s || '').content;
  const rawSwipes: string[] = Array.isArray((item as any).swipes) && (item as any).swipes.length
    ? (item as any).swipes
    : [item.content || ''];
  // [BUBBLE-DISPLAY 2026-09-30] 卡脚本读的是**原始消息内容**（正文美化模板在 init() 里
  // 自己 `getChatMessages(currentId)[0].message`，extractMessageContent 也优先 raw 而非 DOM）
  // ⇒ 渲染层的引号归一/【声音】隐藏到不了卡里。这里在"喂给卡脚本的 chat 条目"上做同一套
  // 归一（引号 → 方括号、去掉 Palink 专有的【声音】提示行），卡片分支才会真正生效。
  const cardFacing = (s: string) => normalizeCardFacingMessage(s);
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
    name: item.name || (item.role === 'user' ? userNameFallback : item.role === 'system' ? 'System' : characterName),
    content: cardFacing(cleanMes),
    mes: cardFacing(cleanMes),
    message: cardFacing(cleanMes),
    text: cardFacing(cleanMes),
    swipes: rawSwipes.map(stripSwipe).map(cardFacing),
    swipe_id: Number.isFinite(Number((item as any).swipe_id)) ? Number((item as any).swipe_id) : 0,
    swipe_info: Array.isArray((item as any).swipe_info) ? (item as any).swipe_info : [],
    extra: boundaryExtra,
    created_at: item.created_at,
  };
}

type SmartCardChatEntry = ReturnType<typeof buildSmartCardChatEntry>;

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
  /** 草稿权威副本（ref）。发送路径必须读它而不是 inputValue 快照 ——
   *  快照在打字时不变，会让 useCallback 依赖失效并重建整条下游回调链。 */
  inputValueRef: React.MutableRefObject<string>;
  setInputValue: (v: string) => void;
  /** 【2026-10 卡顿修复】打字热路径专用：只写 ref、不触发渲染。
   *  可选 —— 未传时 ChatInputArea 退回 setInputValue（行为退化但仍正确）。 */
  setInputValueSilent?: (v: string) => void;
  attachments: any[];
  setAttachments: React.Dispatch<React.SetStateAction<any[]>>;
  uploading: boolean;
  regeneratingMessageIndex: number | null;
  generatingImageMessageIds: Set<string>;
  currentError: any;
  retryMessageContent: string | null;
  timeoutWarning: boolean;
  /** 【报错提示 1.4】关闭超时提醒用。可选：CharacterView 等旧调用方未传时，
   *  超时条仍照常展示，只是关闭按钮退化为隐藏（点击等同 no-op）。 */
  setTimeoutWarning?: React.Dispatch<React.SetStateAction<boolean>>;
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
  /** 候选切换（swipe）/ 其他组件内写操作完成后，通知父级刷新故事线（失效 branch-tree 缓存并重拉） */
  onStorylineChanged?: () => void;
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
  /**
   * [PERF-2026-10-07 问题3] 会话级变量，由 CharacterView 从 messages 响应里承接后下发。
   * 取代本组件内部那个额外的 `?limit=1` 请求（无缓存，每次切会话多一个往返）。
   */
  sessionVariables?: { stat_data?: Record<string, unknown> } | undefined;
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
  // 插件设置抽屉（ST 插件注入面板的收纳空间）
  const [pluginSettingsOpen, setPluginSettingsOpen] = useState(false);
  // MVU 会话级变量（后端下发的 stat_data，作为消息级 extra.variables 的兜底）
  const [sessionVariables, setSessionVariables] = useState<{ stat_data?: Record<string, unknown> } | undefined>(undefined);
  // [PERF-2026-10-07 问题3] 主来源改为父级 props（CharacterView 从 messages 响应里承接，
  // 零额外请求）；生成流结束后的 mvuVariablesUpdated 事件仍是覆盖源。见下方同步 effect。

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
    // [XCHAR-PROMPT-BLEED 2026-10-03] 改按**当前角色**取（generation-engine 侧拿不到
    // selectedCharacter，这里通过 promptInjection 的活动角色闭包取值）。
    if (typeof window !== 'undefined') {
      const w = window as any;
      if (!w.SillyTavern) w.SillyTavern = {};
      if (typeof w.SillyTavern.getExtensionPrompts !== 'function') {
        w.SillyTavern.getExtensionPrompts = () => {
          const merged =
            promptInjection.getPromptsForGeneration(getActivePromptCharacter()) || {};
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
    isGenerating, inputValue, inputValueRef, setInputValue, setInputValueSilent,
    attachments, setAttachments, uploading,
    regeneratingMessageIndex, generatingImageMessageIds,
    currentError, retryMessageContent, timeoutWarning, setTimeoutWarning,
    handleSendMessage, handleSmartCardTrigger, handleSendWithInput, handleRegenerate, handleContinue: propsHandleContinue,
    handleRetry, handleCloseError, handleUpload, handleDeleteMessage, handleEditMessage, handleGenerateImage,
    handleStopGeneration, showModelReasoning,
    branches, selectedBranch, createBranch, switchBranch, deleteBranch,
    fetchBranchTree, branchTree,
    handleStorylineNavigate, forkPoint, clearForkPoint,
    onStorylineChanged,
    showDeleteBranchConfirm, setShowDeleteBranchConfirm, confirmDeleteBranch,
    isMixedDeleteMode, setIsMixedDeleteMode,
    selectedWholeMessages, selectedMessageParts,
    toggleWholeMessageSelect, toggleMessagePartSelect, selectAllPartsInMessage,
    handleMixedDelete, showDeleteMixedConfirm, setShowDeleteMixedConfirm, confirmDeleteMixed, clearSelection,
    memoryMode, memoryStats, compressing, manualCompressMemory,
    autoGenerateChatImages, setAutoGenerateChatImages,
    responseLength, setResponseLength,
    sidebarCollapsed, setSidebarCollapsed: _setSidebarCollapsed,
    mobileSidebarOpen, setMobileSidebarOpen,
    initializingChat, handleInitiateConversation,
    sessionVariables: sessionVariablesProp,
    wb, showWorldBookManager, setShowWorldBookManager,
    showWorldBookOverview, setShowWorldBookOverview,
    selectedWorldBookId, setSelectedWorldBookId,
    pl, showPlotLineManager, setShowPlotLineManager,
    setViewState, onBackToList,
    currentPreset, setCurrentPreset,
    systemDefaults,
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
  // [N-21] 裸 setTimeout 收编进 ref，卸载时统一清理（对齐 CodeBlock copyResetTimerRef 模式）；
  // 仅收编卸载后会 setState 的定时器（纯 DOM focus/scrollIntoView 与已有清理的不动）
  const navSettleTimerRef = useRef<number | null>(null);
  const branchNavSettleTimerRef = useRef<number | null>(null);
  const smartCardRefreshTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      for (const timerRef of [navSettleTimerRef, branchNavSettleTimerRef, smartCardRefreshTimerRef]) {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }
    };
  }, []);

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
      navSettleTimerRef.current = window.setTimeout(() => {
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
      branchNavSettleTimerRef.current = window.setTimeout(() => {
        if (navGenRef.current === gen) {
          setIsNavigating(false);
        }
      }, 500);
    }
    prevBranchIdRef.current = branchId;
  }, [isMobile, selectedBranch, selectedSession?.id]);

  // [PERF-2026-10-07 问题3] 会话级变量：由父级 props 承接（后端已在 messages 响应里返回
  // variables），取代原先那个额外的 `?limit=1` 请求 —— 它无 cacheTtlMs、与 `?limit=10`
  // 无法复用缓存，是每次进入会话的纯额外往返。
  // 依赖里带上 selectedSession?.id：切会话时即使 props 尚未更新也先清空，
  // 避免把上一段对话的变量串到新会话。
  useEffect(() => {
    setSessionVariables(sessionVariablesProp ?? undefined);
  }, [sessionVariablesProp, selectedSession?.id]);

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
    // 【2026-10 卡顿修复】读 inputValueRef 而不是 inputValue。
    // inputValue 现在是 ref 的快照（打字时不变），直接读它会让本回调的依赖数组
    // 在每次按键后失效 → 每键重建该回调 → 所有消费它的子组件跟着重建（吞字主因）。
    // ref 的值永远是最新的，不存在过期闭包，也不需要把 inputValue 放进依赖。
    const rawInput = inputValueRef.current;
    const processedInput = getRegexedStringForMessage(rawInput, regex_placement.USER_INPUT, {
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
    try {
      getGlobalSillyTavernRuntime()?.getEventSource().emit('message_sent', displayedMessages.length - 1, { name: user.username, mes: processedInput, is_user: true });
    } catch {}
  }, [handleSendMessage, isAtBottomRef, activePausedAutoScrollRef, user.username, attachments, selectedCharacter.name, selectedCharacter.avatar, compatCharacterExtensions, compatCharacterPresetData, globalRegexScripts, setInputValue, setAttachments]);

  const wrappedHandleSendMessage = useCallback(async (msg: string, attachments: any[]) => {
    isAtBottomRef.current = true;
    activePausedAutoScrollRef.current = false;
    await handleSendMessage(msg, attachments);
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
      smartCardRefreshTimerRef.current = window.setTimeout(() => {
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

  // 稳定回调：按消息 id 定位索引，避免每条消息每帧创建新闭包导致 Message memo 失效
  const displayedMessagesRef = useRef(displayedMessages);
  displayedMessagesRef.current = displayedMessages;
  // [MEM-MIRROR 2026-10-05] 候选切换 in-flight 去重：同一消息的 swipe PATCH 未回来前
  // 忽略再次点击。服务端已用 CAS 兜底（正文被改写则放弃旧写入），此处是纵深防御，
  // 同时避免用户连点造成无谓请求 + 短暂显示中间态。
  const swipeInFlightRef = useRef<Set<string>>(new Set());
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
      // [MVU-SECONDARY-FEEDBACK 2026-10-05] reason → 提示文案的映射抽到
      // mvuSecondaryFeedback.ts（纯函数，有单测钉住）。原实现内联的 if/else 链
      // 漏了 `call_failed`，会把"副模型调用失败"显示成"变量更新完成（无变化）"
      // —— 用户被误导以为成功。抽出来后可穷举后端 reason 全集做回归。
      const feedback = resolveMvuSecondaryFeedback(res?.applied, res?.reason);
      if (feedback.level === 'success') {
        toast.success(feedback.message);
      } else if (feedback.level === 'error') {
        toast.error(feedback.message);
      } else {
        toast.info(feedback.message);
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

  // [批次B] swipe 候选切换（无分框模式）：循环计算目标索引（对齐分框模式
  // messageManager.swipe 与 getContext swipe.to 的循环语义），调用后端
  // PATCH /api/character-sessions/{sid}/messages/{mid}/swipe 落库（该端点会将
  // 消息内容同步到选中的 swipe，见 character_ext.py switch_message_swipe），
  // 成功后本地同步 swipe_id 与 content 驱动 memo 重渲染。
  const handleSwipeAt = useCallback((messageId: string | number, direction: 'prev' | 'next') => {
    if (!selectedSession || selectedSession.id === '__pending__') return;
    const list = displayedMessagesRef.current;
    const idx = list.findIndex((m) => String(m.id) === String(messageId));
    if (idx < 0) return;
    const msg = list[idx];
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : [];
    if (swipes.length <= 1) return;
    const current = msg.swipe_id ?? 0;
    const next = direction === 'next'
      ? (current >= swipes.length - 1 ? 0 : current + 1)
      : (current <= 0 ? swipes.length - 1 : current - 1);
    const persistedMessageId = Number(messageId);
    // [MEM-MIRROR 2026-10-05] 同一条消息的切换未完成前不重复发（防连点竞态）
    const flightKey = String(messageId);
    if (swipeInFlightRef.current.has(flightKey)) return;
    swipeInFlightRef.current.add(flightKey);
    void (async () => {
      try {
        if (Number.isInteger(persistedMessageId) && persistedMessageId > 0) {
          await api.patch(`/api/character-sessions/${selectedSession.id}/messages/${persistedMessageId}/swipe`, { swipe_id: next });
        }
        setMessages(prev => prev.map(m => (
          String(m.id) === String(messageId)
            ? { ...m, swipe_id: next, content: swipes[next] ?? m.content }
            : m
        )));
        // 候选切换也是写操作：通知父级刷新故事线缓存，使节点「当前候选下标/摘要」与聊天内保持一致
        onStorylineChanged?.();
      } catch (e) {
        console.error('Swipe message failed:', e);
        toast.error('切换候选回复失败');
      } finally {
        swipeInFlightRef.current.delete(flightKey);
      }
    })();
  }, [selectedSession, setMessages]);

  // [批次B] 隐藏/取消隐藏（无分框模式）：PATCH 消息可见性端点（is_hidden 为顶层字段，
  // 见 character_ext.py update_message_visibility），成功后本地同步顶层 is_hidden，
  // 并兜底写入 extra.is_hidden 兼容任何读取该位置的下游逻辑；隐藏消息在装配层已被过滤。
  const handleHideAt = useCallback(async (messageId: string | number, hidden: boolean) => {
    if (!selectedSession || selectedSession.id === '__pending__') return;
    const persistedMessageId = Number(messageId);
    try {
      if (Number.isInteger(persistedMessageId) && persistedMessageId > 0) {
        await api.patch(`/api/character-sessions/${selectedSession.id}/messages/${persistedMessageId}`, { is_hidden: hidden });
      }
      setMessages(prev => prev.map(m => (
        String(m.id) === String(messageId)
          ? { ...m, is_hidden: hidden, extra: { ...(m.extra || {}), is_hidden: hidden } }
          : m
      )));
    } catch (e) {
      console.error('Hide message failed:', e);
      toast.error(hidden ? '隐藏消息失败' : '取消隐藏失败');
    }
  }, [selectedSession, setMessages]);
  const mobileComposerClosedBottomPx = composerBottomPx > 0 ? composerBottomPx : 90;
  // 【K13 原始基线】无键盘检测布局：留白恒按关闭态（dock 上方）计算
  const mobileMessagesBottomPaddingPx =
    mobileComposerClosedBottomPx + MOBILE_CHAT_INPUT_ESTIMATED_HEIGHT_PX + MOBILE_CHAT_INPUT_GAP_PX;
  // [N-3] 稳定切片：历史部分（index < len-K，K=SMART_CARD_TAIL_REALTIME_COUNT）冻结于 ref 快照，
  // 仅在 会话切换 / 消息数量变化 / 正则脚本集变化 / 生成相位翻转（isGenerating 起止，作为流的
  // 提交点：发起时尾条清空、结束时写入终稿）时重建；尾部 K 条实时更新。对外输出完整数组，
  // 但历史元素引用恒定——流式打字机阶段本 memo 依赖（均为原始值）不变 → 直接返回缓存数组引用，
  // 下游 Message memo 比较器通过、pipelineResult/parseContentSegments/sanitize 零重算。
  // displayedMessages 经 displayedMessagesRef 读取最新值，禁止整体放入依赖。
  const smartCardHistoryCacheRef = useRef<{
    sessionId: string | null;
    regexScripts: RegexScript[];
    characterName: string;
    userName: string;
    sources: CharacterChatMessage[];
    mapped: SmartCardChatEntry[];
  } | null>(null);
  const smartCardChatMessages = useMemo(() => {
    const source = displayedMessagesRef.current;
    const sessionId = selectedSession?.id ?? null;
    const historyLen = Math.max(0, source.length - SMART_CARD_TAIL_REALTIME_COUNT);
    const cache = smartCardHistoryCacheRef.current;
    let historyMapped: SmartCardChatEntry[] | null = null;
    if (
      cache
      && cache.sessionId === sessionId
      && cache.regexScripts === globalRegexScripts
      && cache.characterName === selectedCharacter.name
      && cache.userName === user.username
      && cache.sources.length === historyLen
    ) {
      // 源元素逐位引用比对：捕获同长度的内容编辑（编辑/swipe/图片回写），命中则整体复用快照
      let refsUnchanged = true;
      for (let i = 0; i < historyLen; i += 1) {
        if (cache.sources[i] !== source[i]) {
          refsUnchanged = false;
          break;
        }
      }
      if (refsUnchanged) historyMapped = cache.mapped;
    }
    if (!historyMapped) {
      const historySources = source.slice(0, historyLen);
      historyMapped = historySources.map((item, index) => buildSmartCardChatEntry(item, index, selectedCharacter.name, user.username));
      smartCardHistoryCacheRef.current = {
        sessionId,
        regexScripts: globalRegexScripts,
        characterName: selectedCharacter.name,
        userName: user.username,
        sources: historySources,
        mapped: historyMapped,
      };
    }
    const tail: SmartCardChatEntry[] = [];
    for (let i = historyLen; i < source.length; i += 1) {
      tail.push(buildSmartCardChatEntry(source[i], i, selectedCharacter.name, user.username));
    }
    return [...historyMapped, ...tail];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedMessages.length, selectedSession?.id, isGenerating, globalRegexScripts, selectedCharacter.name, user.username, sessionVisualSnapshot]);

  const totalMsgCount = displayedMessages.length;

  // [CANDIDATE-ONLY-ON-LATEST] 当前显示范围内「有效最新 assistant 消息 ID」：
  // 按 displayedMessages 正序扫，取最后一条 role=assistant 的 ID。
  // 这使得：
  //   1) 正常聊天，最后一条 assistant 即为「最新」，候选导航 + 重绘 + 按钮仅在其上显示；
  //   2) 故事线选择某节点跳转后（后端 switch up_to_message_id 把 displayedMessages
  //      截断至目标点），目标位置之后的消息不再显示，目标位置的 assistant 自动成为
  //      新的「最新」，候选 UI 只会出现在它上面，符合「跳转到 2 则 2 为最新」的规则。
  // 消息未持久化（id 为本地临时串）时按 undefined 兜底（Message 组件比较会为 false，
  // 不展示候选 UI，待持久化 final_content 后下一次重渲染生效）。
  const currentLatestAssistantId = useMemo(() => {
    let found: string | number | undefined = undefined;
    for (const m of displayedMessages) {
      if (m.role === 'assistant' && m.id != null) found = m.id;
    }
    return found == null ? null : String(found);
  }, [displayedMessages]);

  // Fix 3: 暴露 window.__palinkChatMessages 给 ST 插件 sandbox（getChatMessages / getLastMessageId 数据源）
  // 结构对齐 ST chat 数组：name / is_user / is_system / mes / mesid / send_date / swipes / extra
  useEffect(() => {
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
  }, [smartCardChatMessages, selectedSession?.id]);

  // Fix 2: 注册 ST 桥接钩子，供 Galgame 等插件通过隐藏虚拟元素（#send_but /
  // #option_regenerate）或 SillyTavern.Generate 驱动真实聊天发送与重生成。
  // 桥接虚拟元素在 sillyTavernPluginRuntime 的 setup script 中创建，这里只注册回调。
  useEffect(() => {
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
  }, [wrappedHandleSendMessage, wrappedHandleRegenerate, displayedMessages]);

  // [XCHAR-PROMPT-BLEED 2026-10-03] 切卡清理 + 活动角色切换（串味修复的前端一半）。
  //
  // 为什么挂在这里而不是别处：
  //  - messageManager.setCurrentCharacterId 全仓零调用方，getCurrentCharacterId()
  //    恒返回 ''，挂在它上面永远不会触发（已核实）；
  //  - CharacterUIProvider.setActiveCharacter 零调用方，那个 Provider 没挂到应用树；
  //  - CharacterView.tsx 本轮冻结，且它的 5 个 setSelectedCharacter 只是「发事件」的一侧。
  // 这里是唯一同时满足「有真的 selectedCharacter」「先于插件注册执行」「本轮已解冻」的位置。
  //
  // 为什么必须声明在下面那两个 effect **之前**：切卡那一帧 React 先跑本 effect 的
  // body（切活动角色 + 清掉旧角色分区），再跑插件注入 / 卡脚本的 body。新角色的
  // 插件注册因此写进新分区，不会被旧分区的残留顶掉（merged[identifier] 后写覆盖先写）。
  const prevPromptCharacterIdRef = useRef<string | null>(null);
  useEffect(() => {
    const characterId = selectedCharacter?.id;
    const nextId = characterId == null ? '' : String(characterId);
    const prevId = prevPromptCharacterIdRef.current;
    if (prevId && prevId !== nextId) {
      // 旧角色的沙箱分区切卡后永不再用，直接删（frame 分区另由 iframe 卸载清理）
      // ⚠️ 走 detach 而非 clear：共用插件的注册项要留给随后的插件注入 effect 搬运
      //    （注入是异步的，等它跑时旧分区已消失，实时读必然读不到）。
      promptInjection.detachSandbox(prevId);
    }
    setActivePromptCharacter(nextId || null);
    prevPromptCharacterIdRef.current = nextId;
  }, [selectedCharacter?.id]);

  // [PLUGIN-STORAGE] 挂上服务端写穿同步 + 进入角色页时拉一次（P2）。
  // 必须在卡脚本执行之前装载：先 hydrate 再让脚本读写，脚本才不会用空气 positions
  // 跑完一轮、随后又被服务端的值覆盖掉（覆盖发生在卡脚本挂载 UI 之后 = 图鉴位置跳变）。
  useEffect(() => {
    const characterId = selectedCharacter?.id;
    if (!characterId) return;
    return installCardScriptStorageSync(characterId);
  }, [selectedCharacter?.id]);

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
      // 2026-10-02 P1：改用 **角色 UUID 派生** 的非零数字 ID。
      // 此前用角色名 charCode 求和 → 同名必然同键，库里 4 张「露缇雅1.2」共用一份插件状态，
      // 删卡重导后仍能看见上一张卡的解锁立绘（SPEC §2.5/§2.6）。
      // 唯一实现收敛在 lib/sillytavern/plugin-character-id.ts，此处只做调用。
      characterId: pluginCharacterIdFromUuid(selectedCharacter.id),
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

    const globalRuntime = getGlobalSillyTavernRuntime();
    if (globalRuntime) {
      globalRuntime.setContext(stContext);
    }
  }, [selectedCharacter.id, selectedCharacter.name, selectedCharacter.description, selectedCharacter.personality, selectedCharacter.scenario, selectedCharacter.first_mes, selectedCharacter.mes_example, selectedCharacter.creator_notes, selectedCharacter.tags, selectedCharacter.avatar, selectedCharacter.extensions, compatCharacterExtensions, sessionVariables, smartCardChatMessages, selectedSession?.id, user.username]);

  useEffect(() => {
    // 创建全局 ST runtime（st-native iframe 线已删除）
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
              if (res?.variables) setSessionVariables(res.variables);
            })
            .catch(() => {});
        }
        // C-1 对齐（2026-08-23）: 此处是插件事件载荷的"显示语义"计算
        // （isMarkdown: true → 只应用 markdownOnly 脚本，ST regex-engine.js:348-355）。
        // 不再把正则结果写回 DB：普通脚本已由后端 persist 单点应用
        // （websocket.py:627），旧回写导致同一非幂等脚本最多三重叠加
        // （后端 persist + 前端完成态渲染 + 此处回写）；markdownOnly 属显示层
        // 虚拟变换，按后端 ephemeral 门语义（character_ext.py:926-927 persist
        // 拒绝 only 脚本）不得落库。
        const processed = getRegexedStringForMessage(lastMsg.content || '', regex_placement.AI_OUTPUT, {
          characterName: selectedCharacter.name,
          userName: user.username,
          characterAvatar: selectedCharacter.avatar || '',
          characterExtensions: compatCharacterExtensions,
          characterPresetData: compatCharacterPresetData,
          globalRegexScripts,
          isMarkdown: true,
        });
        try {
          getGlobalSillyTavernRuntime()?.emitMessageReceived(displayedMessages.length - 1);
        } catch {}
      }
    }
  }, [isGenerating, displayedMessages, selectedCharacter.name, user.username, selectedCharacter.avatar, compatCharacterExtensions, compatCharacterPresetData, globalRegexScripts]);

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
          // 正文右移量 = 侧栏宽（自身宽 80%，与故事线侧栏 w-[80%] 同步）
          transform: `translate3d(${effectiveMobileSidebarOpen ? 80 : 0}%, 0, 0)`,
          transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms`,
          // 与底部 dock / 侧栏滑入共用同一条曲线，三者逐帧同步
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
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
            autoGenerateChatImages,
            responseLength,
            plotLineSessionStatus: pl.sessionStatus,
            memoryStats,
            compressing,
            onShowPresetPanel: () => setShowPresetPanel(true),
            onShowPresetManager: () => setShowPresetManager(true),
            onShowWorldBookManager: () => setShowWorldBookManager(true),
            onToggleStoryline: handleToggleStoryline,
            onToggleAutoGenerateImages: handleToggleAutoGenerateImages,
            onResponseLengthChange: handleResponseLengthChange,
            onShowPluginManager: () => setPluginManagerOpen(true),
            onShowPluginSettings: () => setPluginSettingsOpen(true),
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
            className={cn('rp-chat-area flex-1 flex flex-col overflow-y-auto space-y-4 w-full', isMobile ? 'px-[1%]' : 'px-2 pt-4 pb-4')}
            style={
              {
                // [PERF-2026-10-07 问题2] 关闭浏览器原生 scroll anchoring。
                // 容器内卡片高度由 iframe 经 postMessage 异步上报，布局在加载后仍在变化，
                // 原生锚点会被替换/抖动；锚定改由 loadOlderMessages 的 delta 补偿统一接管，
                // 两套机制同时生效反而互相打架。
                overflowAnchor: 'none',
                ...(isMobile
                  ? { paddingTop: 'calc(env(safe-area-inset-top) + 3.5rem)', paddingBottom: `${mobileMessagesBottomPaddingPx}px` }
                  : null),
              } as React.CSSProperties
            }
            onScroll={handleScroll}
            onClick={() => { activePausedAutoScrollRef.current = true; }}
          >
            {/* 顶部强制留空：桌面端 header 为流式布局（不遮挡内容），保留占位作为视觉留空；
                移动端 header 为悬浮覆盖层，改用滚动容器自身 paddingTop（不会随滚动消失，
                内容始终无法滚入 header 之下），因此这里不再重复加占位。 */}
            {!isMobile && (
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
              const msgId = msg.id != null ? String(msg.id) : null;
              // 当前消息是否为「有效最新 assistant」：
              //   - 非 assistant → false
              //   - assistant 但 id 未持久化 → false（避免生成中/本地临时 id 展示候选 UI）
              //   - 否则与 currentLatestAssistantId 比较（故事线截断目标点即成为最新，
              //     对应 displayedMessages 最后一条 assistant）。
              const isCurrentLatestAssistant = Boolean(
                msg.role === 'assistant'
                  && msgId != null
                  && currentLatestAssistantId != null
                  && msgId === currentLatestAssistantId,
              );
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
                // [S1-G7 2026-10-13] 角色自带世界书名（character_book），内联进智能卡 iframe，
                // 让帧内**同步**世界书 API 首次调用就有值。
                // 数据源订正：原先用 wb.sessionStatus?.world_book_name，真机实测该会话
                // session_world_books 为 0 行 ⇒ 恒 undefined、内联白做。权威源是角色
                // character_book（与主页面桥 sillyTavernPluginRuntime.ts:819-843 同源）。
                characterWorldbookName={
                  Array.isArray(wb.worldBooks)
                    ? (wb.worldBooks as Array<{ type?: string; name?: string; character_id?: string }>)
                      .find((book) => book?.type === 'character_book'
                        && (!book?.character_id || String(book.character_id) === String(selectedCharacter.id)))
                      ?.name
                    : undefined
                }
                models={models}
                // [包G G-1 #2 2026-10-18] 智能卡帧内 getChatCompletionModel() 需要当前模型名。
                selectedModel={selectedModel}
                streaming={(isGenerating && idx === totalMsgCount - 1) || regeneratingMessageIndex === idx}
                isLast={idx === totalMsgCount - 1}
                isCurrentLatestAssistant={isCurrentLatestAssistant}
                t={t}
                tokens={msg.tokens}
                memoryMode={memoryMode}
                memoryStats={idx === totalMsgCount - 1 && msg.role === 'assistant' ? memoryStats : null}
                onCompress={idx === totalMsgCount - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                compressing={compressing}
                onRegenerate={isCurrentLatestAssistant && !isGenerating ? handleRegenerateAt : undefined}
                canRegenerate={isCurrentLatestAssistant && !isGenerating}
                showModelReasoning={showModelReasoning}
                onEdit={msg.id != null ? handleEditAt : undefined}
                // [批次B] user 消息同样开放编辑入口（后端 PUT /messages/{mid} 对 user 消息同样支持）
                canEdit={msg.id != null && !isGenerating}
                // [批次B] swipe 候选切换 + 隐藏/取消隐藏接线（无分框模式交互补齐）
                onSwipe={handleSwipeAt}
                swipes={msg.swipes}
                swipeId={msg.swipe_id}
                onHide={msg.id != null ? handleHideAt : undefined}
                isHidden={Boolean(msg.is_hidden ?? (msg.extra as Record<string, unknown> | undefined)?.is_hidden)}
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
            setInputValueSilent={setInputValueSilent}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            uploading={uploading}
            onUpload={handleUpload}
            onSend={wrappedHandleSendWithInput}
            onStop={handleStop}
            onNewSession={handleNewSessionWithFade}
            character={selectedCharacter}
            t={t}
            mobileSidebarOpen={isMobile ? effectiveMobileSidebarOpen : false}
          />
        )}
      </div>
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

      {/* ──── Error / Timeout：统一 Portal 容器【报错提示 1.3 + 1.4】────
          旧实现是两个互不相干的浮层：ErrorToast 锚 bottom-24/sm:bottom-4，
          超时条锚 bottom-4 right-4 z-50 —— 在 sm 断点以上像素级重叠、同 z，
          且超时条完全没有关闭按钮。现在合并进同一个 data-palink-error-overlay
          容器（Portal 已在 ErrorToast 内部做，键盘抬升规则在 index.css），
          二者互斥渲染，坐标冲突消失，超时条补上关闭能力。
          ⚠「按钮被 dock 压住」是已被实测推翻的旧结论（只咬 7.7px），
          真凶是键盘，已由 index.css 的 palink-kb-open 规则处理。 */}
      {(currentError || (timeoutWarning && isGenerating)) && (
        <ErrorToastPortalContainer>
          {currentError ? (
            <ErrorToast
              errorInfo={currentError}
              onClose={handleCloseError}
              onRetry={handleRetry}
              showRetry={!!retryMessageContent}
              inline
            />
          ) : (
            <div className="w-full max-w-md rounded-lg border border-yellow-300/60 dark:border-yellow-800/60 bg-card p-3 shadow-lg">
              <div className="flex items-start gap-3">
                <Clock className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-foreground">{t.request_taking_long || '请求时间较长'}</h4>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t.ai_processing || 'AI模型正在处理您的请求，这可能需要一些时间。请耐心等待，或尝试切换到其他模型。'}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭超时提醒"
                  onClick={() => setTimeoutWarning?.(false)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </ErrorToastPortalContainer>
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

      {/* ──── 插件设置抽屉：ST 插件注入面板（MVU 等）的收纳空间，真实节点 move 进出 ──── */}
      <StPluginSettingsDrawer
        open={pluginSettingsOpen}
        onClose={() => setPluginSettingsOpen(false)}
      />
    </div>
  );
};
