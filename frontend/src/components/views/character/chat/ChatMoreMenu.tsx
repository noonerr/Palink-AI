/**
 * ChatMoreMenu — 聊天更多操作菜单
 * 从 CharacterChat 提取的下拉菜单组件，包含预设管理、世界书、正则导入等操作
 */
import React from 'react';
import {
  BookOpen, Clock, GitBranch, Image,
  Puzzle, Sliders, Table, Trash2, User as UserIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Character, GenerationPreset } from '@/types';

export interface ChatMoreMenuProps {
  // 基础数据
  selectedSession: { id?: string } | null;
  selectedCharacter: Character;
  t: Record<string, string>;
  // 预设
  currentPreset: GenerationPreset | null;
  // 状态
  isNavigating: boolean;
  mobileSidebarOpen: boolean;
  dialogueMode: 'first_person' | 'third_person';
  showCharacterStatus: boolean;
  autoGenerateChatImages: boolean;
  responseLength: string;
  // 世界书
  worldBookStatus?: { active?: boolean } | null;
  // 剧情线
  plotLineSessionStatus?: { active?: boolean; current_stage_index?: number; total_stages?: number } | null;
  // 记忆
  memoryStats?: {
    message_count: number;
    token_count: number;
    compression_needed: boolean;
  } | null;
  compressing: boolean;
  // 回调
  onShowPresetPanel: () => void;
  onShowPresetManager: () => void;
  onShowWorldBookManager: () => void;
  onToggleStoryline: () => void;
  onToggleDialogueMode: () => void;
  onToggleCharacterStatus: (value: boolean) => Promise<void>;
  onToggleAutoGenerateImages: (value: boolean) => Promise<void>;
  onResponseLengthChange: (value: string) => void;
  onShowPluginManager: () => void;
  onPrevStage: () => Promise<void>;
  onNextStage: () => Promise<void>;
  onShowPlotLineManager: () => void;
  onCompressMemory: () => void;
  onEnterDeleteMode: () => void;
  mobileButtonClassName?: string;
}

export function ChatMoreMenu(props: ChatMoreMenuProps) {
  const {
    selectedSession,
    selectedCharacter,
    t,
    currentPreset,
    isNavigating,
    mobileSidebarOpen,
    dialogueMode,
    showCharacterStatus,
    autoGenerateChatImages,
    responseLength,
    worldBookStatus,
    plotLineSessionStatus,
    memoryStats,
    compressing,
    onShowPresetPanel,
    onShowPresetManager,
    onShowWorldBookManager,
    onToggleStoryline,
    onToggleDialogueMode,
    onToggleCharacterStatus,
    onToggleAutoGenerateImages,
    onResponseLengthChange,
    onShowPluginManager,
    onPrevStage,
    onNextStage,
    onShowPlotLineManager,
    onCompressMemory,
    onEnterDeleteMode,
    mobileButtonClassName,
  } = props;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={cn("h-12 w-12 rounded-2xl backdrop-blur-[20px] bg-transparent hover:bg-[#FFFAFA]/30 dark:hover:bg-white/[0.05] transition-all inline-flex items-center justify-center", mobileButtonClassName)}>
          <MoreVerticalIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {/* Parameter preset */}
        {selectedSession && (
          <DropdownMenuItem onClick={onShowPresetPanel}>
            <Sliders size={14} className="mr-2" />
            {currentPreset?.name || '参数设置'}
          </DropdownMenuItem>
        )}
        {/* Preset manager */}
        {selectedSession && (
          <DropdownMenuItem onClick={onShowPresetManager}>
            <Sliders size={14} className="mr-2" />
            预设管理
          </DropdownMenuItem>
        )}
        {/* World book */}
        {selectedSession && (
          <DropdownMenuItem onClick={onShowWorldBookManager}>
            <BookOpen size={14} className="mr-2" />
            世界书
          </DropdownMenuItem>
        )}
        {/* Storyline visualization toggle */}
        {selectedSession && (
          <DropdownMenuItem onClick={onToggleStoryline} disabled={isNavigating}>
            <GitBranch size={14} className="mr-2" />
            {mobileSidebarOpen ? '关闭剧情线' : '剧情线可视化'}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Dialogue mode */}
        <DropdownMenuItem onClick={onToggleDialogueMode}>
          <UserIcon size={14} className="mr-2" />
          {dialogueMode === 'first_person'
            ? (t.switch_story_mode || '切换故事模式')
            : (t.switch_first_person || '切换第一人称')}
        </DropdownMenuItem>

        {/* Character status table toggle */}
        <ToggleMenuItem
          icon={<Table size={14} />}
          label={t.show_character_status || '角色状态'}
          hint={t.character_status_hint || '下次对话生效'}
          checked={showCharacterStatus}
          onToggle={() => onToggleCharacterStatus(!showCharacterStatus)}
        />

        {/* Auto image generation toggle */}
        <ToggleMenuItem
          icon={<Image size={14} />}
          label="下次对话生成图片"
          hint="下次对话生效"
          checked={autoGenerateChatImages}
          onToggle={() => onToggleAutoGenerateImages(!autoGenerateChatImages)}
        />

        {/* AI Response Length Selector */}
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2 mb-1.5">
            <Clock size={14} />
            <span className="text-sm">{t.response_length || '回复长度'}</span>
          </div>
          <div className="flex gap-1">
            {([
              { key: 'short', label: t.length_short || '简短', desc: '300-500' },
              { key: 'medium', label: t.length_medium || '中等', desc: '600-1000' },
              { key: 'long', label: t.length_long || '详细', desc: '1000+' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                className={cn(
                  "flex-1 px-1 py-1 text-[10px] rounded-md transition-colors border",
                  responseLength === opt.key
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-foreground border-border hover:bg-accent"
                )}
                onClick={() => onResponseLengthChange(opt.key)}
              >
                <div className="font-medium">{opt.label}</div>
                <div className="opacity-60">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 插件管理 */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onShowPluginManager}>
          <Puzzle size={14} className="mr-2" />
          插件管理
        </DropdownMenuItem>

        {/* Plot line stage navigation */}
        {selectedSession && plotLineSessionStatus?.active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={(plotLineSessionStatus.current_stage_index ?? 0) <= 0}
              onClick={() => void onPrevStage()}
            >
              {t.previous_stage || '上一阶段'}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={(plotLineSessionStatus.current_stage_index ?? 0) >= ((plotLineSessionStatus.total_stages ?? 1) - 1)}
              onClick={() => void onNextStage()}
            >
              {t.next_stage || '下一阶段'}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onClick={onShowPlotLineManager}>
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
              <DropdownMenuItem onClick={onCompressMemory} disabled={compressing}>
                {compressing ? (t.compressing || '压缩中...') : (t.compress_memory || '压缩记忆')}
              </DropdownMenuItem>
            )}
          </>
        )}

        {/* Delete toggle */}
        {selectedSession && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onEnterDeleteMode}>
              <Trash2 size={14} className="mr-2" />
              {t.select_to_delete || '选择删除'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 开关菜单项 */
function ToggleMenuItem({
  icon,
  label,
  hint,
  checked,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between px-2 py-1.5 text-sm cursor-pointer"
      onClick={async (e) => {
        e.preventDefault();
        onToggle();
      }}
    >
      <div className="flex items-center gap-2">
        {icon}
        <div className="flex flex-col">
          <span>{label}</span>
          {hint && <span className="text-[10px] text-muted-foreground leading-tight">{hint}</span>}
        </div>
      </div>
      <div
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
          checked ? "bg-primary" : "bg-input"
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-[2px]"
          )}
        />
      </div>
    </div>
  );
}

function MoreVerticalIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
    </svg>
  );
}

export default ChatMoreMenu;
