/**
 * CharacterChat 鈥?鑱婂ぉ瑙嗗浘
 * 浠?CharacterView 鎻愬彇鐨勫瓙缁勪欢
 */
import React, { useState, useRef } from 'react';
import {
  Bot, Plus, X, Play, Sparkles, Trash2, BookOpen, GitBranch,
  Check, ChevronDown, Clock, MoreVertical,
  User as UserIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
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
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
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
import { PlotLineManager } from '@/components/ui/custom/PlotLineManager';
import type {
  Character, Model, User as UserType,
  CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch,
} from '@/types';

/* 鈹€鈹€鈹€ Inline sub-components 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

interface BranchSelectorProps {
  branches: CharacterChatSessionBranch[];
  selectedBranch: CharacterChatSessionBranch | null;
  onSelect: (branch: CharacterChatSessionBranch) => void;
  onCreate: (name: string) => void;
  onDelete: (branchId: string) => void;
}

const BranchSelector: React.FC<BranchSelectorProps> = ({
  branches, selectedBranch, onSelect, onCreate, onDelete,
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
        <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-2 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Input
                placeholder="新分支名称"
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
              <div className="p-4 text-center text-sm text-muted-foreground">鏆傛棤鍒嗘敮</div>
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
                      {branch.is_active && <div className="text-xs opacity-70">褰撳墠</div>}
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
}

const DialogueModeSelector: React.FC<DialogueModeSelectorProps> = ({
  currentMode, onSelect, lang = 'zh',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setIsOpen(false));

  const modes = [
    { id: 'first_person', name: lang === 'zh' ? '绗竴浜虹О' : '1st Person' },
    { id: 'third_person', name: lang === 'zh' ? '鏁呬簨妯″紡' : 'Story' },
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

/* 鈹€鈹€鈹€ Props 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

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
  handleEditMessage: (msgId: number, idx: number, content: string) => Promise<void>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  showModelReasoning: boolean;
  // branches
  branches: CharacterChatSessionBranch[];
  selectedBranch: CharacterChatSessionBranch | null;
  createBranch: (name: string) => Promise<void>;
  switchBranch: (branch: CharacterChatSessionBranch) => Promise<void>;
  deleteBranch: (branchId: string) => void;
  fetchBranchTree: () => Promise<void>;
  branchTree: BranchTree | null;
  showStoryline: boolean;
  setShowStoryline: (v: boolean) => void;
  handleStorylineNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => Promise<void>;
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
}

/* 鈹€鈹€鈹€ Component 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

export const CharacterChat: React.FC<CharacterChatProps> = (props) => {
  const bottomPadding = useMobileBottomPadding();
  const {
    selectedCharacter, user, t, lang,
    models, selectedModel, setSelectedModel,
    sessions, selectedSession, setSelectedSession,
    handleSelectSession, handleNewSession, handleDeleteSession,
    isDeleteMode, setIsDeleteMode, selectedSessions, toggleSessionSelect, handleBatchDelete,
    showDeleteConfirm, setShowDeleteConfirm, pendingDelete, confirmDelete,
    messages, setMessages, loadMessages, messagesEndRef,
    isGenerating, inputValue, setInputValue,
    attachments, setAttachments, uploading,
    suggestions, regeneratingMessageIndex,
    currentError, retryMessageContent, timeoutWarning,
    handleSendMessage, handleSendWithInput, handleRegenerate,
    handleRetry, handleCloseError, handleUpload, handleEditMessage,
    abortControllerRef, showModelReasoning,
    branches, selectedBranch, createBranch, switchBranch, deleteBranch,
    fetchBranchTree, branchTree, showStoryline, setShowStoryline,
    handleStorylineNavigate, showDeleteBranchConfirm, setShowDeleteBranchConfirm, confirmDeleteBranch,
    isMixedDeleteMode, setIsMixedDeleteMode,
    selectedWholeMessages, selectedMessageParts,
    toggleWholeMessageSelect, toggleMessagePartSelect, selectAllPartsInMessage,
    handleMixedDelete, showDeleteMixedConfirm, setShowDeleteMixedConfirm, confirmDeleteMixed, clearSelection,
    memoryMode, memoryStats, compressing, manualCompressMemory,
    dialogueMode, setDialogueMode,
    sidebarCollapsed, setSidebarCollapsed,
    mobileSidebarOpen, setMobileSidebarOpen,
    initializingChat, handleInitiateConversation,
    wb, showWorldBookManager, setShowWorldBookManager,
    showWorldBookOverview, setShowWorldBookOverview,
    selectedWorldBookId, setSelectedWorldBookId,
    pl, showPlotLineManager, setShowPlotLineManager,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    selectedPlotLineId: _selectedPlotLineId, setSelectedPlotLineId: _setSelectedPlotLineId,
    setViewState,
  } = props;

  return (
    <div className="flex w-full h-full overflow-hidden">
      {/* 鈹€鈹€ Mobile Sidebar Overlay 鈹€鈹€ */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-[59] md:hidden animate-fade-in"
          onClick={() => setMobileSidebarOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute inset-y-0 left-0 w-64 bg-background shadow-2xl animate-slide-in-left flex flex-col z-[60] pt-[env(safe-area-inset-top)]"
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
                <span className="text-sm font-semibold">{t.chat_history || '鑱婂ぉ璁板綍'}</span>
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
              headerTitle="鍘嗗彶瀵硅瘽"
            />
          </div>
        </div>
      )}

      {/* 鈹€鈹€ Desktop Sidebar 鈹€鈹€ */}
      <div className={`transition-all duration-300 ease-in-out hidden md:flex ${!sidebarCollapsed ? 'w-64 opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
        <div className="w-64 h-full flex-shrink-0 border-r border-border/50 glass flex flex-col">
          <div className="h-[64px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center text-lg shadow-lg shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                {selectedCharacter.avatar ? (
                  <img src={selectedCharacter.avatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="w-full h-full text-gray-400 dark:text-gray-500">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
                  </svg>
                )}
              </div>
              <span className="text-base font-semibold text-foreground truncate">
                {selectedCharacter.name}
              </span>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => {
                if (selectedSessions.size > 0) {
                  handleBatchDelete();
                } else if (selectedSession) {
                  handleDeleteSession(selectedSession.id);
                }
              }} title="鍒犻櫎瀵硅瘽">
                <Trash2 size={16} />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewState('list')}>
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
            headerTitle="鍘嗗彶瀵硅瘽"
          />
        </div>
      </div>

      {/* 鈹€鈹€ Main chat area 鈹€鈹€ */}
      <div className="flex-1 flex flex-col h-full overflow-hidden pb-[env(safe-area-inset-bottom)] md:pb-0 bg-slate-50 dark:bg-slate-950">
        {/* 鈹€鈹€ Header toolbar 鈹€鈹€ */}
        <header className="h-16 px-4 flex items-center justify-between z-40 pt-safe">
          <div className="flex items-center space-x-3">
            {/* Mobile hamburger / Back button */}
            <Button
              variant="ghost" size="icon"
              className="h-12 w-12 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all flex-shrink-0"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </Button>
            {/* Desktop sidebar toggle */}
            <Button
              variant="ghost" size="icon"
              className="h-12 w-12 rounded-2xl bg-primary/10 hover:bg-primary/20 text-primary transition-all hidden md:flex flex-shrink-0"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {!sidebarCollapsed ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              )}
            </Button>
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
            {/* World book button */}
            {selectedSession && (
              <Button
                variant="ghost" size="icon"
                className="h-12 w-12 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                onClick={() => setShowWorldBookManager(true)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
                </svg>
              </Button>
            )}
            
            {/* Storyline button */}
            {selectedSession && (
              <Button
                variant="ghost" size="icon"
                className="h-12 w-12 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                onClick={fetchBranchTree}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="3" x2="6" y2="15"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                </svg>
              </Button>
            )}

            {/* More options menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-12 w-12 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
                  </svg>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {/* Dialogue mode */}
                <DropdownMenuItem onClick={() => setDialogueMode(dialogueMode === 'first_person' ? 'third_person' : 'first_person')}>
                  <UserIcon size={14} className="mr-2" />
                  {dialogueMode === 'first_person'
                    ? (lang === 'zh' ? '鍒囨崲鏁呬簨妯″紡' : 'Switch to Story')
                    : (lang === 'zh' ? '鍒囨崲绗竴浜虹О' : 'Switch to 1st Person')}
                </DropdownMenuItem>
                
                {/* Model selector */}
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5">
                  <ModelSelector
                    models={models}
                    currentModel={selectedModel}
                    onSelect={setSelectedModel}
                  />
                </div>

                {/* Plot line manager */}
                {selectedSession && pl.sessionStatus?.active && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={pl.sessionStatus.current_stage_index <= 0}
                      onClick={async () => { await pl.prevStage(selectedSession.id); await pl.loadSessionStatus(selectedSession.id); }}
                    >
                      涓婁竴闃舵
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={pl.sessionStatus.current_stage_index >= (pl.sessionStatus.total_stages ?? 1) - 1}
                      onClick={async () => { await pl.nextStage(selectedSession.id); await pl.loadSessionStatus(selectedSession.id); }}
                    >
                      涓嬩竴闃舵
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onClick={() => setShowPlotLineManager(true)}>
                  <BookOpen size={14} className="mr-2" />
                  绠＄悊鍓ф儏绾?
                </DropdownMenuItem>

                {/* Memory */}
                {memoryStats && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled className="text-xs text-muted-foreground opacity-100">
                      璁板繂: {memoryStats.message_count} 鏉?/ {memoryStats.token_count} tokens
                    </DropdownMenuItem>
                    {memoryStats.compression_needed && (
                      <DropdownMenuItem onClick={manualCompressMemory} disabled={compressing}>
                        {compressing ? '鍘嬬缉涓?..' : '鍘嬬缉璁板繂'}
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
                      {(selectedWholeMessages.size > 0 || selectedMessageParts.size > 0) ? "鍒犻櫎閫変腑" : (isMixedDeleteMode ? "鍙栨秷閫夋嫨妯″紡" : "閫夋嫨鍒犻櫎")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* 鈹€鈹€ Empty state / new chat 鈹€鈹€ */}
        {messages.length === 0 && !selectedSession && !initializingChat && (
          <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
            <div className={`w-full max-w-2xl flex flex-col items-center animate-fade-in-up ${bottomPadding}`}>
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
                <p className="text-muted-foreground text-sm sm:text-base">寮€濮嬩笌杩欎釜瑙掕壊瀵硅瘽鍚э紒</p>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowWorldBookManager(true)}>
                  <BookOpen size={14} />
                  绠＄悊涓栫晫涔?
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
                  寮€濮嬪璇?
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 鈹€鈹€ Initializing spinner 鈹€鈹€ */}
        {initializingChat && (
          <div className="flex-1 flex items-center justify-center p-8 w-full overflow-y-auto">
            <div className={`w-full flex flex-col items-center animate-fade-in-up ${bottomPadding}`}>
              <div className="animate-spin text-primary mb-4"><Bot size={32} /></div>
              <p className="text-muted-foreground">姝ｅ湪鍔犺浇瀵硅瘽...</p>
            </div>
          </div>
        )}

        {/* 鈹€鈹€ Messages area 鈹€鈹€ */}
        {(messages.length > 0 || selectedSession) && (
          <div className="flex-1 overflow-y-auto px-4 space-y-4 pt-4 pb-4">
            {wb.sessionStatus?.active && (
              <StageIndicator
                status={wb.sessionStatus}
              />
            )}
            {messages.map((msg, idx) => (
              <Message
                key={msg.id || idx}
                message={msg}
                userAvatar={user.avatar}
                userName={user.username}
                characterAvatar={selectedCharacter.avatar}
                characterName={selectedCharacter.name}
                isCharacterChat={true}
                models={models}
                streaming={(isGenerating && idx === messages.length - 1) || regeneratingMessageIndex === idx}
                isLast={idx === messages.length - 1}
                t={t}
                tokens={msg.tokens}
                memoryMode={memoryMode}
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
            ))}

            {suggestions.length > 0 && !isGenerating && (
              <div className="flex flex-wrap gap-2 pl-4 sm:pl-12 animate-fade-in-up">
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
        )}

        {/* 鈹€鈹€ Chat input 鈹€鈹€ */}
        <div className="px-4 pt-0 pb-0 bg-gradient-to-t from-slate-50 dark:from-slate-950 via-slate-50/95 dark:via-slate-950/95 to-transparent">
          <div className="bg-slate-100 dark:bg-slate-800/50 rounded-3xl p-0 flex items-end">
            <Button
              variant="ghost" size="icon"
              className="h-11 w-11 rounded-2xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14"/><path d="M5 12h14"/>
              </svg>
            </Button>
            <div className="flex-1">
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
                placeholder={`涓?${selectedCharacter.name} 瀵硅瘽...`}
                streaming={isGenerating}
                onStop={() => abortControllerRef.current?.abort()}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 鈹€鈹€ Confirm dialogs 鈹€鈹€ */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={pendingDelete?.type === 'batch' ? 'Delete selected sessions?' : 'Delete this session?'}
        description={pendingDelete?.type === 'batch'
          ? `Delete ${selectedSessions.size} selected sessions? This cannot be undone.`
          : 'Delete this session? This cannot be undone.'}
        onConfirm={confirmDelete}
        confirmText="确定"
        cancelText="取消"
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

      {/* 鈹€鈹€ Error Toast 鈹€鈹€ */}
      {currentError && (
        <ErrorToast
          errorInfo={currentError}
          onClose={handleCloseError}
          onRetry={handleRetry}
          showRetry={!!retryMessageContent}
        />
      )}

      {/* 鈹€鈹€ Timeout Warning 鈹€鈹€ */}
      {timeoutWarning && isGenerating && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm w-full">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <Clock className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-yellow-800 dark:text-yellow-200">璇锋眰鏃堕棿杈冮暱</h4>
                <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                  AI妯″瀷姝ｅ湪澶勭悊鎮ㄧ殑璇锋眰锛岃繖鍙兘闇€瑕佷竴浜涙椂闂淬€傝鑰愬績绛夊緟锛屾垨灏濊瘯鍒囨崲鍒板叾浠栨ā鍨嬨€?
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 鈹€鈹€ Storyline Panel 鈹€鈹€ */}
      {showStoryline && branchTree && (
        <StorylinePanel
          branchTree={branchTree}
          activeBranchName={selectedBranch?.branch_name || 'Main'}
          characterName={selectedCharacter.name}
          onClose={() => setShowStoryline(false)}
          onNavigate={handleStorylineNavigate}
          isDark={document.documentElement.classList.contains('dark')}
        />
      )}

      {/* 鈹€鈹€ World Book Overview Panel 鈹€鈹€ */}
      <WorldBookOverview
        status={wb.sessionStatus || { active: false }}
        isOpen={showWorldBookOverview}
        onClose={() => setShowWorldBookOverview(false)}
      />

      {/* 鈹€鈹€ Plot Line Manager Dialog 鈹€鈹€ */}
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

      {/* 鈹€鈹€ World Book Manager Dialog 鈹€鈹€ */}
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


