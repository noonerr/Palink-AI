/**
 * CharacterChat — 聊天视图
 * 从CharacterView提取的子组件
 */
import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import {
  Bot, Plus, X, Play, Sparkles, Trash2, BookOpen, GitBranch,
  Check, ChevronDown, Clock, MoreVertical, Sliders,
  User as UserIcon,
  Map as MapIcon,
  Table,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { PresetSelector } from '@/components/ui/custom/PresetSelector';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { ErrorToast } from '@/components/ui/custom/ErrorToast';
import StorylineMap from '@/components/ui/custom/StorylineMap';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import { WorldBookSelector } from '@/components/ui/custom/WorldBookSelector';
import { StageIndicator } from '@/components/ui/custom/StageIndicator';
import { StageControls } from '@/components/ui/custom/StageControls';
import { WorldBookOverview } from '@/components/ui/custom/WorldBookOverview';
import { WorldBookManager } from '@/components/ui/custom/WorldBookManager';
import { PlotLineManager } from '@/components/ui/custom/PlotLineManager';
import type {
  Character, Model, User as UserType,
  CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch,
  GenerationPreset,
} from '@/types';

/* ────── Inline sub-components ────────────────────────────────────────────────────── */

interface BranchSelectorProps {
  branches: CharacterChatSessionBranch[];
  selectedBranch: CharacterChatSessionBranch | null;
  onSelect: (branch: CharacterChatSessionBranch) => void;
  onCreate: (name: string) => void;
  onDelete: (branchId: string) => void;
  t: Record<string, string>;
}

function BranchSelector({
  branches, selectedBranch, onSelect, onCreate, onDelete, t,
}: BranchSelectorProps) {
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
        <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-2 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Input
                placeholder={t.new_branch_name || '新分支名称'}
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                className="text-sm h-8"
              />
              <Button size="sm" className="h-8 px-3" onClick={handleCreate} disabled={!newBranchName.trim()}>
                <Plus size={14} />
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {branches.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">{t.no_branches || '暂无分支'}</div>
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
                    onClick={() => { onSelect(branch); setIsOpen(false); }}
                    className="flex items-center gap-2 flex-1 text-left"
                  >
                    <GitBranch size={14} />
                    <div className="flex-1">
                      <div className="font-medium">{branch.branch_name}</div>
                      {branch.is_active && <div className="text-xs opacity-70">{t.current || '当前'}</div>}
                    </div>
                    {selectedBranch?.id === branch.id && <Check size={14} />}
                  </button>
                  {!branch.is_active && branches.length > 1 && (
                    <Button
                      variant="ghost" size="icon"
                      className="h-7 w-7 opacity-50 hover:opacity-100 hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); onDelete(branch.id); }}
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
  t: Record<string, string>;
}

function DialogueModeSelector({
  currentMode, onSelect, lang = 'zh', t,
}: DialogueModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setIsOpen(false));

  const modes = [
    { id: 'first_person', name: t.first_person || '第一人称' },
    { id: 'third_person', name: t.story_mode || '故事模式' },
  ];

  const getIcon = (modeId: string) =>
    modeId === 'first_person' ? <UserIcon size={16} /> : <BookOpen size={16} />;

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
        <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-44 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-1.5">
            {modes.map(mode => (
              <button
                key={mode.id}
                onClick={() => { onSelect(mode.id as 'first_person' | 'third_person'); setIsOpen(false); }}
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
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  // chat hook
  isGenerating: boolean;
  inputValue: string;
  setInputValue: (v: string) => void;
  attachments: any[];
  setAttachments: React.Dispatch<React.SetStateAction<any[]>>;
  uploading: boolean;
  suggestions: string[];
  regeneratingMessageIndex: number | null;
  currentError: any;
  retryMessageContent: string | null;
  timeoutWarning: boolean;
  handleSendMessage: (msg: string, attachments: any[]) => Promise<void>;
  handleSendWithInput: () => Promise<void>;
  handleRegenerate: (idx: number) => Promise<void>;
  handleRetry: () => void;
  handleCloseError: () => void;
  handleUpload: (file: File, type: 'image' | 'file') => Promise<void>;
  handleEditMessage: (msgId: string | number, idx: number, content: string) => Promise<void>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
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
  showCharacterStatus: boolean;
  setShowCharacterStatus: (v: boolean) => void;
  // sidebar
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (v: boolean) => void;
  // init
  initializingChat: boolean;
  handleInitiateConversation: (msg?: string) => Promise<void>;
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
}

/* ────── Component ──────────────────────────────────────────────────────────────────────────────── */

const HISTORY_SLIDE_DURATION_MS = 300;
const NEW_SESSION_FADE_DURATION_MS = 200;

export function CharacterChat(props: CharacterChatProps) {
  const [composerBottomPx, setComposerBottomPx] = useState(0);
  const isMobile = useIsMobile();
  const { isKeyboardOpen } = useVirtualKeyboard();
  const [isDark, setIsDark] = useState(document.documentElement.classList.contains('dark'));
  const [showDesktopHint, setShowDesktopHint] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !localStorage.getItem('palink-mobile-desktop-hint-dismissed');
  });
  const [sessionVisualSnapshot, setSessionVisualSnapshot] = useState<{
    activeSessionId: string | null;
    messages: CharacterChatMessage[];
  } | null>(null);
  const [newSessionFadeState, setNewSessionFadeState] = useState<'idle' | 'fading-out' | 'fading-in'>('idle');
  const [showPresetPanel, setShowPresetPanel] = useState(false);
  const sessionSwitchTimerRef = useRef<number | null>(null);
  const newSessionFadeTimerRef = useRef<number | null>(null);
  const sessionSwitchTokenRef = useRef(0);
  const prevMessagesRef = useRef<CharacterChatMessage[]>([]);

  useEffect(() => {
    const darkObserver = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => darkObserver.disconnect();
  }, []);

  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const measureNav = () => {
      const _isMobile = isMobile;
      if (!_isMobile) {
        setComposerBottomPx(0);
        return;
      }
      const nav = document.querySelector('nav[data-dock="true"]');
      if (nav) {
        const navHeight = nav.getBoundingClientRect().height;
        if (isIOS) {
          const safeAreaBottom = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom')) || 0;
          setComposerBottomPx(Math.max(77, navHeight - safeAreaBottom + 4));
        } else {
          setComposerBottomPx(navHeight + 7);
        }
      } else {
        setComposerBottomPx(isIOS ? 77 : 90);
      }
    };
    measureNav();
    const resizeHandler = () => measureNav();
    window.addEventListener('resize', resizeHandler);
    const navObserver = new MutationObserver(() => {
      setTimeout(measureNav, 100);
      setTimeout(measureNav, 500);
    });
    const navEl = document.querySelector('nav[data-dock="true"]');
    if (navEl) {
      navObserver.observe(navEl, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    return () => {
      window.removeEventListener('resize', resizeHandler);
      navObserver.disconnect();
    };
  }, [isMobile]);

  useEffect(() => {
    return () => {
      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
      }
      if (newSessionFadeTimerRef.current !== null) {
        window.clearTimeout(newSessionFadeTimerRef.current);
      }
    };
  }, []);

  const {
    selectedCharacter, user, t, lang,
    models, selectedModel, setSelectedModel,
    sessions, selectedSession, setSelectedSession,
    handleSelectSession, handleNewSession, handleDeleteSession,
    isDeleteMode, setIsDeleteMode, selectedSessions, toggleSessionSelect, handleBatchDelete,
    showDeleteConfirm, setShowDeleteConfirm, pendingDelete, confirmDelete,
    messages, setMessages, loadMessages, messagesEndRef,
    isAtBottomRef,
    isGenerating, inputValue, setInputValue,
    attachments, setAttachments, uploading,
    suggestions, regeneratingMessageIndex,
    currentError, retryMessageContent, timeoutWarning,
    handleSendMessage, handleSendWithInput, handleRegenerate,
    handleRetry, handleCloseError, handleUpload, handleEditMessage,
    abortControllerRef, showModelReasoning,
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
    showCharacterStatus, setShowCharacterStatus,
    sidebarCollapsed, setSidebarCollapsed: _setSidebarCollapsed,
    mobileSidebarOpen, setMobileSidebarOpen,
    initializingChat, handleInitiateConversation,
    wb, showWorldBookManager, setShowWorldBookManager,
    showWorldBookOverview, setShowWorldBookOverview,
    selectedWorldBookId, setSelectedWorldBookId,
    pl, showPlotLineManager, setShowPlotLineManager,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    selectedPlotLineId: _selectedPlotLineId, setSelectedPlotLineId: _setSelectedPlotLineId,
    setViewState,
    currentPreset, setCurrentPreset,
  } = props;

  const [isNavigating, setIsNavigating] = useState(false);
  const navGenRef = useRef(0);

  const setSidebarCollapsed = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    _setSidebarCollapsed(prev => {
      const newVal = typeof v === 'function' ? v(prev) : v;
      if (prev === false && newVal === true && isNavigating && isMobile) {
        return false;
      }
      return newVal;
    });
  }, [_setSidebarCollapsed, isMobile, isNavigating]);

  const wrappedHandleStorylineNavigate = useCallback(async (branchId: string, messageId: number | null, isLeaf: boolean) => {
    const gen = ++navGenRef.current;
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
        }
      }, 3000);
    }
  }, [handleStorylineNavigate]);

  const prevBranchIdRef = useRef<string | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const outerContainerRef = useRef<HTMLDivElement>(null);
  const sidebarOffsetRef = useRef(0);
  const sidebarWasOpenBeforeNavRef = useRef(false);

  const applySidebarOffset = useCallback((offset: number, animate: boolean) => {
    sidebarOffsetRef.current = offset;
    const el = outerContainerRef.current;
    if (!el) return;
    el.style.transition = animate ? `padding-left ${HISTORY_SLIDE_DURATION_MS}ms ease-in-out` : 'none';
    el.style.paddingLeft = offset === 0 ? '0px' : `${offset}px`;
    const sidebar = el.querySelector('.mobile-storyline-sidebar') as HTMLElement | null;
    if (sidebar) {
      sidebar.style.transition = animate ? `transform ${HISTORY_SLIDE_DURATION_MS}ms ease-in-out` : 'none';
      sidebar.style.transform = `translate3d(${offset > 0 ? 0 : -320}px, 0, 0)`;
    }
    const backdrop = el.querySelector('.fixed.inset-0.z-\\[59\\]') as HTMLElement | null;
    if (backdrop) {
      backdrop.style.transition = animate ? `opacity ${HISTORY_SLIDE_DURATION_MS}ms ease-in-out` : 'none';
      if (offset > 0) {
        backdrop.style.opacity = '1';
        backdrop.style.pointerEvents = 'auto';
      } else {
        backdrop.style.opacity = '0';
        backdrop.style.pointerEvents = 'none';
      }
    }
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const initialOffset = !sidebarCollapsed ? 320 : 0;
    applySidebarOffset(initialOffset, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isMobile) {
      if (sidebarOffsetRef.current !== 0) {
        applySidebarOffset(0, true);
      }
      return;
    }
    if (isNavigating) {
      if (!sidebarCollapsed) {
        sidebarWasOpenBeforeNavRef.current = true;
      }
      return;
    }
    if (sidebarWasOpenBeforeNavRef.current) {
      sidebarWasOpenBeforeNavRef.current = false;
      _setSidebarCollapsed(false);
      applySidebarOffset(320, true);
      return;
    }
    const targetOffset = !sidebarCollapsed ? 320 : 0;
    if (sidebarOffsetRef.current !== targetOffset) {
      applySidebarOffset(targetOffset, true);
    }
  }, [sidebarCollapsed, isMobile, isNavigating, applySidebarOffset]);


  useEffect(() => {
    const branchId = selectedBranch?.id || null;
    if (prevBranchIdRef.current !== null && prevBranchIdRef.current !== branchId && branchId !== null) {
      const gen = ++navGenRef.current;
      setIsNavigating(true);
      setTimeout(() => {
        if (navGenRef.current === gen) {
          setIsNavigating(false);
        }
      }, 3000);
    }
    prevBranchIdRef.current = branchId;
  }, [selectedBranch, selectedSession?.id]);

  useEffect(() => {
    prevMessagesRef.current = messages;
  }, [messages]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom < 120;
  }, [isAtBottomRef]);

  const wrappedHandleSendWithInput = useCallback(async () => {
    isAtBottomRef.current = true;
    await handleSendWithInput();
  }, [handleSendWithInput, isAtBottomRef]);

  const wrappedHandleSendMessage = useCallback(async (msg: string, attachments: any[]) => {
    isAtBottomRef.current = true;
    await handleSendMessage(msg, attachments);
  }, [handleSendMessage, isAtBottomRef]);

  const wrappedHandleInitiateConversation = useCallback(async (msg?: string) => {
    isAtBottomRef.current = true;
    await handleInitiateConversation(msg);
  }, [handleInitiateConversation, isAtBottomRef]);

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

  const handleSessionSwitchWithFade = (session: CharacterChatSession) => {
    const switchToken = sessionSwitchTokenRef.current + 1;
    sessionSwitchTokenRef.current = switchToken;

    setNewSessionFadeState('fading-out');
    setSessionVisualSnapshot({
      activeSessionId: selectedSession?.id || null,
      messages: [...messages],
    });

    if (sessionSwitchTimerRef.current !== null) {
      window.clearTimeout(sessionSwitchTimerRef.current);
      sessionSwitchTimerRef.current = null;
    }
    if (newSessionFadeTimerRef.current !== null) {
      window.clearTimeout(newSessionFadeTimerRef.current);
      newSessionFadeTimerRef.current = null;
    }

    // 只在桌面端自动关闭侧栏，移动端保持用户选择的状态
    if (!isMobile) {
      setSidebarCollapsed(true);
    }

    const applySessionSwitch = async () => {
      if (sessionSwitchTokenRef.current !== switchToken) return;

      await handleSelectSession(session);

      if (sessionSwitchTokenRef.current === switchToken) {
        setSessionVisualSnapshot(null);
        setNewSessionFadeState('fading-in');
        newSessionFadeTimerRef.current = window.setTimeout(() => {
          if (sessionSwitchTokenRef.current !== switchToken) return;
          setNewSessionFadeState('idle');
          newSessionFadeTimerRef.current = null;
        }, NEW_SESSION_FADE_DURATION_MS);
      }
    };

    if (!sidebarCollapsed) {
      sessionSwitchTimerRef.current = window.setTimeout(() => {
        sessionSwitchTimerRef.current = null;
        void applySessionSwitch();
      }, HISTORY_SLIDE_DURATION_MS);
      return;
    }

    sessionSwitchTimerRef.current = window.setTimeout(() => {
      sessionSwitchTimerRef.current = null;
      void applySessionSwitch();
    }, NEW_SESSION_FADE_DURATION_MS);
  };

  const handleNewSessionWithFade = () => {
    const switchToken = sessionSwitchTokenRef.current + 1;
    sessionSwitchTokenRef.current = switchToken;

    setNewSessionFadeState('fading-out');
    setSessionVisualSnapshot({
      activeSessionId: selectedSession?.id || null,
      messages: [...messages],
    });

    if (sessionSwitchTimerRef.current !== null) {
      window.clearTimeout(sessionSwitchTimerRef.current);
      sessionSwitchTimerRef.current = null;
    }
    if (newSessionFadeTimerRef.current !== null) {
      window.clearTimeout(newSessionFadeTimerRef.current);
      newSessionFadeTimerRef.current = null;
    }

    // 只在桌面端自动关闭侧栏，移动端保持用户选择的状态
    if (!isMobile) {
      setSidebarCollapsed(true);
    }

    const resetToNewSession = () => {
      if (sessionSwitchTokenRef.current !== switchToken) return;

      handleNewSession();
      setSessionVisualSnapshot(null);
      setNewSessionFadeState('fading-in');
      newSessionFadeTimerRef.current = window.setTimeout(() => {
        if (sessionSwitchTokenRef.current !== switchToken) return;
        setNewSessionFadeState('idle');
        newSessionFadeTimerRef.current = null;
      }, NEW_SESSION_FADE_DURATION_MS);
    };

    if (!sidebarCollapsed) {
      sessionSwitchTimerRef.current = window.setTimeout(() => {
        sessionSwitchTimerRef.current = null;
        resetToNewSession();
      }, HISTORY_SLIDE_DURATION_MS);
      return;
    }

    sessionSwitchTimerRef.current = window.setTimeout(() => {
      sessionSwitchTimerRef.current = null;
      resetToNewSession();
    }, NEW_SESSION_FADE_DURATION_MS);
  };

  return (
    <div
      ref={outerContainerRef}
      className="flex w-full h-full overflow-hidden"
    >
      {/* ──── Mobile Sidebar (仅移动端渲染，translate3d滑动) ──── */}
      {isMobile && (
      <aside
        className={cn(
          'mobile-storyline-sidebar fixed inset-y-0 left-0 w-[320px] transform-gpu px-0 pb-0 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-transform ease-in-out z-[60]',
          isDark ? 'border-r border-slate-700/70 bg-[#1f2233] backdrop-blur-[24px]' : 'border-r border-[#ddd4c5] bg-[#FFFAFA] backdrop-blur-[20px]'
        )}
        style={{
          transform: `translate3d(${sidebarOffsetRef.current > 0 ? 0 : -320}px, 0, 0)`,
          transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms`,
        }}
      >
        <div className="flex h-full flex-col overflow-hidden relative">
          {branchTree && branchTree.branches.reduce((sum, b) => sum + b.nodes.length, 0) > 0 ? (
            <div className="flex-1 overflow-hidden">
              <StorylineMap
                branchTree={branchTree}
                onNavigate={wrappedHandleStorylineNavigate}
                isDark={isDark}
                sessionId={selectedSession?.id}
                onDeleteBranch={deleteBranch}
              />
            </div>
          ) : (
            <div className={cn(
              'flex-1 flex flex-col items-center justify-center gap-3 px-4 pt-16',
              isDark ? 'bg-gray-900/95' : 'bg-slate-50/95'
            )}>
              <div className={cn('p-5 rounded-2xl shadow-lg', isDark ? 'bg-gray-800' : 'bg-white')}>
                <MapIcon size={40} className="text-indigo-400 mx-auto" />
              </div>
              <p className={cn('text-base font-semibold', isDark ? 'text-gray-300' : 'text-gray-600')}>
                还没有对话记录
              </p>
              <p className={cn('text-sm', isDark ? 'text-gray-500' : 'text-gray-400')}>
                开始第一句对话，故事线将自动生成
              </p>
            </div>
          )}
          <div className={cn('absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-3 pb-10 bg-gradient-to-b pointer-events-none', isDark ? 'from-[#1f2233] via-[#1f2233]/80 to-transparent' : 'from-[#FFFAFA] via-[#FFFAFA]/80 to-transparent')}>
            <div className="flex items-center gap-2 pointer-events-auto">
              <div className={cn('p-1.5 rounded-lg', isDark ? 'bg-indigo-500/20' : 'bg-indigo-50')}>
                <MapIcon size={14} className="text-indigo-400" />
              </div>
              <span className={cn('text-sm font-semibold', isDark ? 'text-white/95' : 'text-slate-800')}>
                故事线
              </span>
            </div>
            <div className="flex items-center gap-1 pointer-events-auto">
              <button
                onClick={() => createBranch()}
                className={cn(
                  'h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-medium transition-colors',
                  isDark
                    ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30'
                    : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                )}
                title="创建新分支"
              >
                <Plus size={11} />
                <span>新分支</span>
              </button>
              {selectedBranch && !selectedBranch.is_active && (
                <button
                  onClick={() => deleteBranch(selectedBranch.id)}
                  className={cn(
                    'h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-medium transition-colors',
                    isDark
                      ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
                      : 'bg-red-50 text-red-600 hover:bg-red-100'
                  )}
                  title="删除当前分支"
                >
                  <Trash2 size={11} />
                  <span>删除</span>
                </button>
              )}
              <button
                onClick={() => { if (!isNavigating) setSidebarCollapsed(true); }}
                className={cn(
                  'inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors',
                  isDark
                    ? 'border-slate-600/80 bg-[#2d3350] text-slate-100'
                    : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700'
                )}
                aria-label="close-storyline"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      </aside>
      )}

      {/* ──── Mobile backdrop (侧边栏打开时显示遮罩，与侧边栏同步淡入淡出) ──── */}
      {isMobile && (
      <div
        className={cn(
          'fixed inset-0 z-[59] bg-black/40 transition-opacity ease-in-out',
          'opacity-100'
        )}
        style={{ transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms` }}
        onClick={() => { if (!isNavigating) setSidebarCollapsed(true); }}
      />
      )}

      {/* ──── Desktop Sidebar + Main Content (移动端跟随侧边栏右移) ──── */}
      <div
        ref={contentWrapperRef}
        className="flex-1 flex h-full min-w-0"
        style={isMobile ? { minWidth: '100vw' } : undefined}
      >
      {/* ──── Desktop Sidebar ──── */}
      {!isMobile && (
      <div className={`transition-all duration-300 ease-in-out ${!sidebarCollapsed ? 'w-[320px] opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
        <div className="w-[320px] h-full flex-shrink-0 border-r border-border/50 glass flex flex-col relative overflow-hidden">
          {branchTree && branchTree.branches.reduce((sum, b) => sum + b.nodes.length, 0) > 0 ? (
            <div className="flex-1 overflow-hidden">
              <StorylineMap branchTree={branchTree} onNavigate={wrappedHandleStorylineNavigate} isDark={isDark} sessionId={selectedSession?.id} onDeleteBranch={deleteBranch} />
            </div>
          ) : (
            <div className={cn('flex-1 flex flex-col items-center justify-center gap-3 px-4 pt-16', isDark ? 'bg-gray-900/95' : 'bg-slate-50/95')}>
              <div className={cn('p-5 rounded-2xl shadow-lg', isDark ? 'bg-gray-800' : 'bg-white')}><MapIcon size={40} className="text-indigo-400 mx-auto" /></div>
              <p className={cn('text-base font-semibold', isDark ? 'text-gray-300' : 'text-gray-600')}>还没有对话记录</p>
              <p className={cn('text-sm', isDark ? 'text-gray-500' : 'text-gray-400')}>开始第一句对话，故事线将自动生成</p>
            </div>
          )}
          <div className={cn('absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-3 pb-10 bg-gradient-to-b pointer-events-none', isDark ? 'from-[#1f2233] via-[#1f2233]/80 to-transparent' : 'from-[#FFFAFA] via-[#FFFAFA]/80 to-transparent')}>
            <div className="flex items-center gap-2 pointer-events-auto">
              <div className={cn('p-1.5 rounded-lg', isDark ? 'bg-indigo-500/20' : 'bg-indigo-50')}>
                <MapIcon size={14} className="text-indigo-400" />
              </div>
              <span className={cn('text-sm font-semibold', isDark ? 'text-white/95' : 'text-slate-800')}>故事线</span>
            </div>
            <div className="flex items-center gap-1 pointer-events-auto">
              <button
                onClick={() => createBranch()}
                className={cn('h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-medium transition-colors', isDark ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100')}
                title="创建新分支"
              >
                <Plus size={11} /><span>新分支</span>
              </button>
              {selectedBranch && !selectedBranch.is_active && (
                <button
                  onClick={() => deleteBranch(selectedBranch.id)}
                  className={cn('h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-medium transition-colors', isDark ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25' : 'bg-red-50 text-red-600 hover:bg-red-100')}
                  title="删除当前分支"
                >
                  <Trash2 size={11} /><span>删除</span>
                </button>
              )}
              <button onClick={() => { if (!isNavigating) setSidebarCollapsed(true); }} className={cn('inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors', isDark ? 'border-slate-600/80 bg-[#2d3350] text-slate-100' : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700')} aria-label="close-storyline"><X size={16} /></button>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* ──── Main chat area ──── */}
      <div
        ref={chatAreaRef}
        className={`flex-1 flex flex-col h-full overflow-hidden relative pb-[env(safe-area-inset-bottom)] bg-slate-50 dark:bg-slate-950`}
      >
        <header className={cn(
          'flex items-center justify-between z-40',
          isMobile
            ? cn(
                'absolute left-0 right-0 top-0 px-5 pb-3 pt-[calc(env(safe-area-inset-top)+12px)]',
                'bg-gradient-to-b pointer-events-auto',
                isDark
                  ? 'from-slate-900/100 via-slate-900/80 to-slate-900/5'
                  : 'from-[#FFFAFA]/100 via-[#FFFAFA]/80 to-[#FFFAFA]/5'
              )
            : cn(
                'h-16 px-4 pt-safe border-b',
                isDark
                  ? 'border-slate-700/70 bg-slate-950/80 backdrop-blur-[20px]'
                  : 'border-[#ddd4c5] bg-[#FFFAFA]/80 backdrop-blur-[20px]'
              )
        )}>
          <div className="flex items-center space-x-3">
            {/* Storyline toggle button - 仅移动端显示 */}
            {isMobile && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-11 w-11 rounded-full transition-all duration-300 ease-in-out',
                sidebarOffsetRef.current > 0 && 'rotate-180'
              )}
              onClick={() => {
                if (isNavigating) return;
                if (sidebarOffsetRef.current > 0) {
                  setSidebarCollapsed(true);
                } else {
                  setSidebarCollapsed(false);
                  if (selectedSession) fetchBranchTree();
                }
              }}
              aria-label="toggle-storyline"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
              </svg>
            </Button>
            )}
            {/* Desktop sidebar toggle - 仅桌面端显示 */}
            {!isMobile && (
            <button
              className="h-12 w-12 rounded-2xl backdrop-blur-[20px] bg-primary/10 hover:bg-primary/20 text-primary transition-all flex flex-shrink-0 items-center justify-center"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {!sidebarCollapsed ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              )}
            </button>
            )}
            {/* Character avatar and name */}
            <div className="w-10 h-10 rounded-2xl overflow-hidden flex-shrink-0">
              {selectedCharacter.avatar ? (
                <img src={selectedCharacter.avatar} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="w-6 h-6 text-gray-400 dark:text-gray-500">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
                  </svg>
                </div>
              )}
            </div>
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-white">{selectedCharacter.name}</h2>
            </div>
          </div>

          {/* Right side actions */}
          <div className="flex items-center gap-1">
            {/* Model selector icon button */}
            <ModelSelector
              models={models}
              currentModel={selectedModel}
              onSelect={setSelectedModel}
              triggerStyle="icon"
              size="sm"
              theme={isDark ? 'dark' : 'light'}
            />

            {/* Hidden PresetSelector - triggered via dropdown */}
            <PresetSelector
              currentPreset={currentPreset}
              onPresetChange={setCurrentPreset}
              theme={isDark ? 'dark' : 'light'}
              hideTrigger
              open={showPresetPanel}
              onClose={() => setShowPresetPanel(false)}
            />

            {/* More options menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="h-12 w-12 rounded-2xl backdrop-blur-[20px] bg-transparent hover:bg-[#FFFAFA]/30 dark:hover:bg-white/[0.05] transition-all inline-flex items-center justify-center">
                  <MoreVertical size={20} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {/* Parameter preset */}
                {selectedSession && (
                  <DropdownMenuItem onClick={() => setShowPresetPanel(true)}>
                    <Sliders size={14} className="mr-2" />
                    {currentPreset?.name || '参数设置'}
                  </DropdownMenuItem>
                )}
                {/* World book */}
                {selectedSession && (
                  <DropdownMenuItem onClick={() => setShowWorldBookManager(true)}>
                    <BookOpen size={14} className="mr-2" />
                    世界书
                  </DropdownMenuItem>
                )}
                {/* Storyline visualization toggle */}
                {selectedSession && (
                  <DropdownMenuItem onClick={() => {
                    if (isNavigating) return;
                    if (sidebarOffsetRef.current > 0) {
                      setSidebarCollapsed(true);
                    } else {
                      setSidebarCollapsed(false);
                      fetchBranchTree();
                    }
                  }}>
                    <GitBranch size={14} className="mr-2" />
                    {sidebarOffsetRef.current > 0 ? '关闭剧情线' : '剧情线可视化'}
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                {/* Dialogue mode */}
                <DropdownMenuItem onClick={() => setDialogueMode(dialogueMode === 'first_person' ? 'third_person' : 'first_person')}>
                  <UserIcon size={14} className="mr-2" />
                  {dialogueMode === 'first_person'
                    ? (t.switch_story_mode || '切换故事模式')
                    : (t.switch_first_person || '切换第一人称')}
                </DropdownMenuItem>

                {/* Character status table toggle */}
                <div
                  className="flex items-center justify-between px-2 py-1.5 text-sm cursor-pointer"
                  onClick={async (e) => {
                    e.preventDefault();
                    const newValue = !showCharacterStatus;
                    setShowCharacterStatus(newValue);
                    try {
                      await api.put('/api/users/me/settings', { show_character_status: newValue });
                      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { showCharacterStatus: newValue } }));
                      toast.success(newValue ? (t.character_status_enabled || '角色状态表格已开启') : (t.character_status_disabled || '角色状态表格已关闭'));
                    } catch (e) {
                      console.error('Failed to update character status setting:', e);
                      setShowCharacterStatus(!newValue);
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Table size={14} />
                    <div className="flex flex-col">
                      <span>{t.show_character_status || '角色状态'}</span>
                      <span className="text-[10px] text-muted-foreground leading-tight">{t.character_status_hint || '下次对话生效'}</span>
                    </div>
                  </div>
                  <div
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                      showCharacterStatus ? "bg-primary" : "bg-input"
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span
                      className={cn(
                        "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                        showCharacterStatus ? "translate-x-[18px]" : "translate-x-[2px]"
                      )}
                    />
                  </div>
                </div>

                {/* Plot line stage navigation */}
                {selectedSession && pl.sessionStatus?.active && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={pl.sessionStatus.current_stage_index <= 0}
                      onClick={async () => { await pl.prevStage(selectedSession.id); await pl.loadSessionStatus(selectedSession.id); }}
                    >
                      {t.previous_stage || '上一阶段'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={pl.sessionStatus.current_stage_index >= (pl.sessionStatus.total_stages ?? 1) - 1}
                      onClick={async () => { await pl.nextStage(selectedSession.id); await pl.loadSessionStatus(selectedSession.id); }}
                    >
                      {t.next_stage || '下一阶段'}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onClick={() => setShowPlotLineManager(true)}>
                  <BookOpen size={14} className="mr-2" />
                  {t.manage_plotline || '管理剧情线'}
                </DropdownMenuItem>

                {/* Memory */}
                {memoryStats && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled className="text-xs text-muted-foreground opacity-100">
                      {t.memory_count || '记忆'}: {memoryStats.message_count} 条/ {memoryStats.token_count} tokens
                    </DropdownMenuItem>
                    {memoryStats.compression_needed && (
                      <DropdownMenuItem onClick={manualCompressMemory} disabled={compressing}>
                        {compressing ? (t.compressing || '压缩中...') : (t.compress_memory || '压缩记忆')}
                      </DropdownMenuItem>
                    )}
                  </>
                )}

                {/* Delete toggle */}
                {selectedSession && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={async () => {
                        if (isMixedDeleteMode && (selectedWholeMessages.size > 0 || selectedMessageParts.size > 0)) {
                          await handleMixedDelete();
                        } else {
                          setIsMixedDeleteMode(!isMixedDeleteMode);
                          if (isMixedDeleteMode) clearSelection();
                        }
                      }}
                    >
                      <Trash2 size={14} className="mr-2" />
                      {(selectedWholeMessages.size > 0 || selectedMessageParts.size > 0) ? t.delete_selected_items || '删除选中' : (isMixedDeleteMode ? t.cancel_select_mode || '取消选择模式' : t.select_to_delete || '选择删除')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

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
          <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
            <div className={`w-full max-w-2xl flex flex-col items-center animate-fade-in-up`} style={isMobile ? { paddingBottom: isKeyboardOpen ? 0 : (composerBottomPx > 0 ? `${composerBottomPx}px` : undefined) } : undefined}>
              {isMobile && <div style={{ height: 'calc(env(safe-area-inset-top) + 3.5rem)', width: '100%' }} />}
              {isMobile && showDesktopHint && (
                <div className={cn(
                  'w-full mb-4 px-4 py-3 rounded-xl border text-sm flex items-start gap-3',
                  isDark
                    ? 'bg-blue-950/30 border-blue-800/50 text-blue-200'
                    : 'bg-blue-50 border-blue-200 text-blue-800'
                )}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                  <div className="flex-1">
                    <p className="font-medium mb-1">移动端窄屏模式</p>
                    <p className="text-xs opacity-80">
                      当前为移动端优化布局。如需更完整的宽屏体验（如侧边栏故事线），建议使用电脑端浏览器访问。
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setShowDesktopHint(false);
                      localStorage.setItem('palink-mobile-desktop-hint-dismissed', 'true');
                    }}
                    className="flex-shrink-0 p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <div className="mb-6 sm:mb-10 text-center">
                <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-4 sm:mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                  {selectedCharacter.avatar ? (
                    <img src={selectedCharacter.avatar} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="w-16 h-16 sm:w-20 sm:h-20 text-gray-400 dark:text-gray-500">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
                    </svg>
                  )}
                </div>
                <h1 className="text-2xl sm:text-3xl font-semibold mb-2">{selectedCharacter.name}</h1>
                <p className="text-muted-foreground text-sm sm:text-base">{t.start_roleplay_hint || '开始与这个角色对话吧！'}</p>
              </div>

              <div className="flex items-center gap-3">
                <button className={cn(
                  'inline-flex items-center gap-1.5 text-sm font-medium rounded-2xl px-3 py-1.5 border backdrop-blur-[20px] transition-all',
                  'border-[#d9cfbf]/50 bg-[#FFFAFA]/40 text-slate-700',
                  'dark:border-white/[0.15] dark:bg-white/[0.07] dark:text-white/80'
                )} onClick={() => setShowWorldBookManager(true)}>
                  <BookOpen size={14} />
                  {t.manage_worldbook || '管理世界书'}
                </button>
              </div>
              <div className="mt-4">
                <button className={cn(
                  'inline-flex items-center justify-center gap-2 text-base font-medium rounded-2xl h-12 px-8 border backdrop-blur-[20px] transition-all',
                  'bg-slate-900/80 dark:bg-white/80 text-white dark:text-slate-900 border-slate-700/30 dark:border-white/20',
                  'hover:bg-slate-800/90 dark:hover:bg-white/90 active:scale-[0.98]'
                )} onClick={() => wrappedHandleInitiateConversation()} disabled={initializingChat}>
                  {initializingChat ? (
                    <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Play size={20} />
                  )}
                  {t.start_conversation || '开始对话'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ──── Initializing spinner ──── */}
        {initializingChat && (
          <div className="flex-1 flex items-center justify-center p-8 w-full overflow-y-auto">
            <div className="w-full flex flex-col items-center animate-fade-in-up" style={isMobile ? { paddingBottom: isKeyboardOpen ? 0 : (composerBottomPx > 0 ? `${composerBottomPx}px` : undefined) } : undefined}>
              {isMobile && <div style={{ height: 'calc(env(safe-area-inset-top) + 3.5rem)', width: '100%' }} />}
              <div className="animate-spin text-primary mb-4"><Bot size={32} /></div>
              <p className="text-muted-foreground">{t.loading_conversation || '正在加载对话...'}</p>
            </div>
          </div>
        )}

        {/* ──── Messages area ──── */}
        {(displayedMessages.length > 0 || displayedActiveSessionId) && (
          <div
            className={cn('flex-1 overflow-y-auto space-y-4 pt-4 pb-4', isMobile ? 'px-1' : 'px-2')}
            style={isMobile ? { paddingBottom: isKeyboardOpen ? 80 : (composerBottomPx > 0 ? `${composerBottomPx + 80}px` : undefined) } : undefined}
            onScroll={handleScroll}
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
            {displayedMessages.map((msg, idx) => (
              <Message
                key={msg.id || idx}
                message={msg}
                userAvatar={user.avatar}
                userName={user.username}
                characterAvatar={selectedCharacter.avatar}
                characterName={selectedCharacter.name}
                isCharacterChat={true}
                models={models}
                streaming={(isGenerating && idx === displayedMessages.length - 1) || regeneratingMessageIndex === idx}
                isLast={idx === displayedMessages.length - 1}
                t={t}
                tokens={msg.tokens}
                memoryMode={memoryMode}
                memoryStats={idx === displayedMessages.length - 1 && msg.role === 'assistant' ? memoryStats : null}
                onCompress={idx === displayedMessages.length - 1 && msg.role === 'assistant' ? manualCompressMemory : undefined}
                compressing={compressing}
                onRegenerate={msg.role === 'assistant' && !isGenerating ? () => wrappedHandleRegenerate(idx) : undefined}
                canRegenerate={msg.role === 'assistant' && !isGenerating && idx > 0 && displayedMessages[idx - 1]?.role === 'user'}
                showModelReasoning={showModelReasoning}
                onEdit={msg.id ? (newContent: string) => handleEditMessage(msg.id, idx, newContent) : undefined}
                canEdit={msg.role === 'assistant' && !isGenerating}
                isMixedDeleteMode={isMixedDeleteMode}
                messageIndex={idx}
                selectedWholeMessages={selectedWholeMessages}
                selectedMessageParts={selectedMessageParts}
                onToggleWholeMessageSelect={toggleWholeMessageSelect}
                onToggleMessagePartSelect={toggleMessagePartSelect}
                onSelectAllPartsInMessage={selectAllPartsInMessage}
              />
            ))}

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
        {displayedActiveSessionId && isMobile && (
        <div
          className={cn(
            'fixed left-0 right-0 z-[20] px-3 pt-2 animate-chat-input-appear',
            'bg-gradient-to-t from-transparent via-transparent to-transparent'
          )}
          style={{
            bottom: isKeyboardOpen ? 0 : `${composerBottomPx > 0 ? composerBottomPx : 90}px`,
          }}
        >
          <div className="mx-auto max-w-3xl">
            <ChatInput
              value={inputValue}
              onChange={setInputValue}
              onSend={wrappedHandleSendWithInput}
              onUpload={handleUpload}
              attachments={attachments}
              onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
              disabled={isGenerating}
              uploading={uploading}
              placeholder={t.chat_with_character ? t.chat_with_character.replace('{name}', selectedCharacter.name) : `与${selectedCharacter.name}对话...`}
              streaming={isGenerating}
              onStop={() => abortControllerRef.current?.abort()}
              variant="mobile-demo"
              theme={isDark ? 'dark' : 'light'}
              leadingAction={
                <button
                  type="button"
                  className="shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  title={t.new_conversation || '新对话'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14"/><path d="M5 12h14"/>
                  </svg>
                </button>
              }
            />
          </div>
        </div>
        )}
        {/* [TAG:DESKTOP-DO-NOT-TOUCH] 整个桌面端暂不重构，等用户说"重构桌面端"后再改 */}
        {!isMobile && displayedActiveSessionId && (
        <div
          className="px-4 pt-[7px] backdrop-blur-[20px]"
        >
          <div className="flex gap-2 overflow-visible items-center min-h-[58px] rounded-[28px] px-3 py-2.5 backdrop-blur-2xl border border-[#ddd4c5] bg-[#FFFAFA] shadow-[0_10px_28px_rgba(120,106,79,0.14)] dark:border-slate-700/80 dark:bg-[#23283c] dark:shadow-[0_12px_30px_rgba(2,6,23,0.45)]">
            <button
              type="button"
              className="shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={t.new_conversation || '新对话'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14"/><path d="M5 12h14"/>
              </svg>
            </button>
            <div className="flex-1">
              <ChatInput
                value={inputValue}
                onChange={setInputValue}
                onSend={wrappedHandleSendWithInput}
                onUpload={handleUpload}
                attachments={attachments}
                onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                disabled={isGenerating}
                uploading={uploading}
                placeholder={t.chat_with_character ? t.chat_with_character.replace('{name}', selectedCharacter.name) : `与${selectedCharacter.name}对话...`}
                streaming={isGenerating}
                onStop={() => abortControllerRef.current?.abort()}
                variant="mobile-demo"
                noContainerStyle
                theme={isDark ? 'dark' : 'light'}
              />
            </div>
          </div>
        </div>
        )}
      </div>
      </div>

      {/* ──── Confirm dialogs ──── */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={pendingDelete?.type === 'batch' ? 'Delete selected sessions?' : 'Delete this session?'}
        description={pendingDelete?.type === 'batch'
          ? `Delete ${selectedSessions.size} selected sessions? This cannot be undone.`
          : 'Delete this session? This cannot be undone.'}
        onConfirm={confirmDelete}
        confirmText={t.confirm || '确定'}
        cancelText={t.cancel || '取消'}
      />
      <ConfirmDialog
        open={showDeleteBranchConfirm}
        onOpenChange={setShowDeleteBranchConfirm}
        title="Delete this branch?"
        description="Delete this branch? This cannot be undone."
        onConfirm={confirmDeleteBranch}
        confirmText="Confirm"
        cancelText="Cancel"
      />
      <ConfirmDialog
        open={showDeleteMixedConfirm}
        onOpenChange={setShowDeleteMixedConfirm}
        title="Delete selected content?"
        description="Delete selected content? This cannot be undone."
        onConfirm={confirmDeleteMixed}
        confirmText="Confirm"
        cancelText="Cancel"
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

      {/* ──── World Book Overview Panel ──── */}
      <WorldBookOverview
        status={wb.sessionStatus || { active: false }}
        isOpen={showWorldBookOverview}
        onClose={() => setShowWorldBookOverview(false)}
      />

      {/* ──── Plot Line Manager Dialog ──── */}
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

      {/* ──── World Book Manager Dialog ──── */}
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
            />
          </div>
        </div>
      )}
    </div>
  );
};


