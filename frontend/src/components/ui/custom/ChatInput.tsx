import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Paperclip, X, Square, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Model, Attachment } from '@/types';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onUpload: (file: File, type: 'image' | 'file') => Promise<void>;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  disabled?: boolean;
  uploading?: boolean;
  placeholder?: string;
  streaming?: boolean;
  onStop?: () => void;
  variant?: 'default' | 'mobile-demo';
  theme?: 'dark' | 'light';
  models?: Model[];
  currentModel?: string;
  onModelChange?: (model: string) => void;
  showModelSelector?: boolean;
  modelSelectorTriggerStyle?: string;
  webSearchEnabled?: boolean;
  onToggleWebSearch?: () => void;
  showWebSearch?: boolean;
  noContainerStyle?: boolean;
  hideAttachmentButton?: boolean;
  leadingAction?: ReactNode;
  visualOnly?: boolean;
  dimDisabled?: boolean;
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export function ChatInput({
  value,
  onChange,
  onSend,
  onUpload,
  attachments,
  onRemoveAttachment,
  disabled = false,
  uploading = false,
  placeholder = 'Ask anything...',
  streaming = false,
  onStop,
  variant = 'default',
  theme = 'dark',
  webSearchEnabled = false,
  onToggleWebSearch,
  showWebSearch = false,
  noContainerStyle = false,
  hideAttachmentButton = false,
  leadingAction,
  visualOnly = false,
  dimDisabled = true
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const isDarkTheme = theme === 'dark';
  const controlsDisabled = disabled || uploading;
  const interactiveControlsDisabled = visualOnly ? false : controlsDisabled;

  // ── 输入状态下移（2026-10 卡顿修复）──────────────────────────────────────
  // 草稿文本由本组件内部持有，打字只重渲染 ChatInput 自身；外部 `value` 降级为
  // 「外部写入通道」（智能卡 setInputDraft / 发送后清空 / 外部会话恢复）。
  //
  // 为什么不是简单的 useState('')：外部仍持有权威副本（useChatView.handleSend 读
  // chatMessages.input 拼 display_content；useCharacterChat.handleSendMessage 的
  // `content || inputValue` 兜底），所以这里必须做「内部快写 + 外部同步」，而不是
  // 彻底断开外部。
  //
  // 为什么不会读到空值：`draftRef` 与 `onChange` 的实参是同一个同步赋值，发送回调
  // 里读 `draftRef.current`（或上层 ref）一定拿得到用户刚敲的最后一个字符；
  // 外部 `value` 的异步回灌若与本地输入撞上，lastLocalEditRef 的「同值判定」会把
  // 「外部只是在追平我刚敲的内容」识别出来并跳过，不会把刚敲的字覆盖掉。
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  // 本地最后一次编辑的值，用于识别「外部回灌的其实是用户自己刚敲的内容」并跳过
  // 一次无意义的 setState（外部父组件往往在同一批 state 更新里把同一串字回传）。
  const lastLocalEditRef = useRef<string | null>(null);

  useEffect(() => {
    // 外部写入（setInputDraft / 发送后清空）：以内部为准地同步下来。
    if (value === draftRef.current) return;
    if (lastLocalEditRef.current !== null && value === lastLocalEditRef.current) {
      // 这串值是本地刚编辑出去的同一批，外部只是把它追平了 —— 忽略，避免抖动。
      lastLocalEditRef.current = null;
      return;
    }
    lastLocalEditRef.current = null;
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  const handleValueChange = useCallback((next: string) => {
    draftRef.current = next;
    lastLocalEditRef.current = next;
    setDraft(next);
    onChange(next);
  }, [onChange]);

  // 发送时以内部草稿为准（draftRef 永远是最新的），再交回上层。
  //
  // 【关键】发送后**主动清空本地草稿**。不能指望上层把 value 置空来触发上面的
  // effect 同步：修复后打字不再走 setState，上层的 value 从头到尾都是 ''，
  // 「发送后清空」对它来说不是一次状态变化，effect 根本不会触发 ——
  // 结果就是已发送的文字留在框里（用户会接着误发第二遍）。
  const submit = useCallback(() => {
    // ① 先把草稿同步给上层（上层的 ref / state 由此拿到完整内容），**再**清本地。
    //    顺序不能反：反了上层读到的就是空串，即用户报的「发空消息」。
    onChange(draftRef.current);
    draftRef.current = '';
    lastLocalEditRef.current = null;
    setDraft('');
    onSend();
  }, [onChange, onSend]);

  const validateFile = (file: File): string | null => {
    const isImage = file.type.startsWith('image/');
    if (isImage) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        return `不支持的图片格式: ${file.type.split('/')[1] || 'unknown'}，仅支持 JPG、PNG、WEBP、GIF`;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        return `图片大小不能超过 10MB，当前: ${(file.size / (1024 * 1024)).toFixed(1)}MB`;
      }
    } else {
      if (file.size > MAX_FILE_SIZE) {
        return `文件大小不能超过 20MB，当前: ${(file.size / (1024 * 1024)).toFixed(1)}MB`;
      }
    }
    return null;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) {
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (visualOnly || disabled || uploading || streaming) {
        return;
      }
      submit();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (visualOnly) return;

    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploadError(null);
    for (const file of Array.from(files)) {
      const error = validateFile(file);
      if (error) {
        setUploadError(error);
        continue;
      }
      const type = file.type.startsWith('image/') ? 'image' : 'file';
      try {
        await onUpload(file, type);
      } catch (err) {
        setUploadError(`上传失败: ${file.name}`);
      }
    }
    if (e.target.value) e.target.value = '';
  };

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);

    setUploadError(null);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const error = validateFile(file);
      if (error) {
        setUploadError(error);
        continue;
      }
      const type = file.type.startsWith('image/') ? 'image' : 'file';
      try {
        await onUpload(file, type);
      } catch (err) {
        setUploadError(`上传失败: ${file.name}`);
      }
    }
  }, [onUpload]);

  const MAX_TEXTAREA_HEIGHT = 120;

  // 【2026-10 卡顿修复】原 autoResize 每次按键都做「两次强制同步布局」：
  //   textarea.style.height = 'auto'    // 写样式
  //   读 textarea.scrollHeight           // 同步读回布局
  //   textarea.style.height = `${...}px` // 再写样式
  // 这两个读写把本可推迟到帧末的重算钉死在每个按键的微任务里；消息多时再叠上整棵
  // 聊天树重渲染，就是「一个字符等几秒」。
  //
  // 改法要点：
  // 1) 只在高度**真的**需要变时才碰 style.height。
  // 2) 收缩（删字）路径必须先 height='auto' 才能量到真实内容高度 —— 这是原写法
  //    存在的唯一理由，不能省。但它很贵，所以用「内容变短了才走」来兜住：
  //    变长时 scrollHeight 单调不减，直接量即可，不必重置；只有变短时才重置。
  // 3) 用 requestAnimationFrame 把一帧内的多次调用合并成一次量高。
  const lastMeasuredTextRef = useRef<string>(draft);

  const autoResize = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const isShrinking = text.length < lastMeasuredTextRef.current.length;
    // 未变短且当前高度已顶到上限：内容还在继续溢出，高度钉死即可，不必量。
    if (!isShrinking
      && textarea.clientHeight >= MAX_TEXTAREA_HEIGHT
      && textarea.scrollHeight >= MAX_TEXTAREA_HEIGHT) {
      lastMeasuredTextRef.current = text;
      return;
    }
    // 只在变短时重置（变长时 scrollHeight 已能反映新内容，重置纯属多一次布局）。
    if (isShrinking) {
      textarea.style.height = 'auto';
    }
    const next = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    if (textarea.clientHeight !== next) {
      textarea.style.height = `${next}px`;
    }
    lastMeasuredTextRef.current = text;
  };

  // 把同一帧内的多次 autoResize 合并成一次（连打一串字符时只量一次高度）。
  const resizeRafRef = useRef<number | null>(null);
  const scheduleAutoResize = useCallback((text: string) => {
    if (resizeRafRef.current !== null) return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      autoResize(text);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    // 外部写入 / 发送清空：走同步版，把高度立刻摆正（不能等下一帧，否则会跳一下）。
    autoResize(draft);
  }, [draft]);

  return (
    <div
      className="w-full"
      aria-hidden={visualOnly ? true : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {uploadError && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-xs">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">{uploadError}</span>
          <button onClick={() => setUploadError(null)} className="shrink-0 hover:opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3 overflow-x-auto overflow-y-visible pb-1 scroll-mobile">
          {attachments.map((att, idx) => (
            <div
              key={idx}
              className="relative group flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-lg border border-border shrink-0 max-w-full"
            >
              <div className="w-11 h-11 rounded-md overflow-hidden bg-background/70 flex items-center justify-center shrink-0">
                {att.type === 'image' ? (
                  <img
                    src={att.thumbnail || att.url}
                    alt={att.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-base sm:text-sm">📄</span>
                )}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium truncate max-w-[140px] sm:max-w-[180px]">{att.name}</div>
                {att.size ? (
                  <div className="text-[10px] text-muted-foreground">
                    {att.size < 1024 * 1024
                      ? `${(att.size / 1024).toFixed(1)} KB`
                      : `${(att.size / (1024 * 1024)).toFixed(1)} MB`}
                  </div>
                ) : null}
              </div>
              <button
                onClick={() => {
                  if (!visualOnly) onRemoveAttachment(idx);
                }}
                type="button"
                tabIndex={visualOnly ? -1 : undefined}
                className="palink-press absolute top-0.5 right-0.5 w-6 h-6 sm:w-5 sm:h-5 bg-muted rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm after:absolute after:-inset-2.5 after:content-['']"
              >
                <X size={14} className="sm:w-3 sm:h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs">
          <Loader2 size={14} className="animate-spin shrink-0" />
          <span>正在上传...</span>
        </div>
      )}

      <div
        className={cn(
          'flex gap-2 overflow-visible',
          variant === 'mobile-demo' ? 'items-center' : 'items-end',
          variant === 'mobile-demo' && !noContainerStyle && cn(
            'min-h-[52px] rounded-[26px] px-3 py-1.5 backdrop-blur-2xl',
            isDarkTheme
              ? 'border border-slate-700/80 bg-[#23283c] shadow-[0_12px_30px_rgba(2,6,23,0.45)]'
              : 'border border-[#ddd4c5] bg-[#FFFAFA] shadow-[0_10px_28px_rgba(120,106,79,0.14)]'
          ),
          isDragging && 'border-primary bg-primary/5'
        )}
      >
        {leadingAction}

        {!hideAttachmentButton && (
        <button
          type="button"
          onClick={() => {
            if (!visualOnly) fileInputRef.current?.click();
          }}
          disabled={interactiveControlsDisabled}
          tabIndex={visualOnly ? -1 : undefined}
                className="palink-press shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="上传图片或文件"
        >
          <Paperclip size={18} />
        </button>
        )}

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            handleValueChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={interactiveControlsDisabled}
          readOnly={visualOnly}
          tabIndex={visualOnly ? -1 : undefined}
          rows={1}
          className={cn(
            'flex-1 bg-transparent border-none focus:ring-0 resize-none outline-none overflow-y-auto transition-opacity',
            dimDisabled && 'disabled:opacity-50',
            variant === 'mobile-demo'
              ? cn(
                  'px-1 py-1.5 text-base max-h-[120px]',
                  isDarkTheme
                    ? 'text-slate-100 placeholder:text-slate-400'
                    : 'text-slate-700 placeholder:text-slate-400'
                )
              : 'px-2 py-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 max-h-[120px]'
          )}
        />

        {streaming ? (
          <button
            type="button"
            onClick={visualOnly ? undefined : onStop}
            tabIndex={visualOnly ? -1 : undefined}
            className={cn(
              'flex items-center justify-center transition-all',
              variant === 'mobile-demo'
                ? 'h-10 w-10 rounded-full bg-red-500 text-white hover:opacity-90 active:scale-[0.96]'
                : 'h-11 w-11 rounded-2xl bg-destructive text-destructive-foreground hover:opacity-90 active:scale-[0.96] ml-1'
            )}
          >
            <Square size={18} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!visualOnly) submit();
            }}
            disabled={!visualOnly && (disabled || uploading || (!draft.trim() && attachments.length === 0))}
            tabIndex={visualOnly ? -1 : undefined}
            className={cn(
              'flex items-center justify-center transition-all',
              dimDisabled && 'disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100',
              variant === 'mobile-demo'
                ? cn(
                    'h-10 w-10 rounded-full hover:opacity-90 active:scale-[0.96]',
                    isDarkTheme ? 'bg-[#3a415e] text-slate-100' : 'bg-slate-900 text-white'
                  )
                : 'h-11 w-11 rounded-2xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 active:scale-[0.96] ml-1'
            )}
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
          </button>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/jpeg,image/png,image/webp,image/gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar,.7z,.tar,.gz,.csv,.json,.md,.html,.css,.js,.ts,.jsx,.tsx,.py,.java,.cpp,.c,.h,.go,.rs,.rb,.php,.swift,.kt,.xml,.yaml,.yml,.toml,.ini,.cfg"
        multiple
        onChange={handleFileChange}
      />

      {isDragging && (
        <div className="mt-2 rounded-2xl border border-dashed border-primary/60 bg-primary/5 px-4 py-3 text-center text-xs text-muted-foreground">
          松开以上传图片（JPG/PNG/WEBP，≤10MB）、PDF、Office 文档或代码文件
        </div>
      )}
    </div>
  );
};
