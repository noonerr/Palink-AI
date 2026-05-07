import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Paperclip, X, Square, Loader2, AlertCircle, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Model } from '@/types';

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
  thumbnail?: string;
  size?: number;
}

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
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export const ChatInput: React.FC<ChatInputProps> = ({
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
  leadingAction
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const isDarkTheme = theme === 'dark';

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
      if (disabled || uploading || streaming) {
        return;
      }
      onSend();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const MAX_TEXTAREA_HEIGHT = 72;

  const autoResize = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    }
  };

  return (
    <div
      className="w-full"
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
                onClick={() => onRemoveAttachment(idx)}
                type="button"
                className="absolute top-0.5 right-0.5 w-6 h-6 sm:w-5 sm:h-5 bg-muted rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm"
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
            'min-h-[58px] rounded-[28px] px-3 py-2.5 backdrop-blur-2xl',
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
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="上传图片或文件"
        >
          <Paperclip size={18} />
        </button>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || uploading}
          rows={1}
          className={cn(
            'flex-1 bg-transparent border-none focus:ring-0 resize-none outline-none disabled:opacity-50 overflow-y-auto',
            variant === 'mobile-demo'
              ? cn(
                  'px-1 py-1.5 text-sm max-h-[72px]',
                  isDarkTheme
                    ? 'text-slate-100 placeholder:text-slate-400'
                    : 'text-slate-700 placeholder:text-slate-400'
                )
              : 'px-2 py-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 max-h-[72px]'
          )}
        />

        {streaming ? (
          <button
            type="button"
            onClick={onStop}
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
            onClick={() => onSend()}
            disabled={disabled || uploading || (!value.trim() && attachments.length === 0)}
            className={cn(
              'flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100',
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

      {showWebSearch && (
        <div
          className={cn(
            "flex items-center justify-between mt-2 px-3 py-1.5 rounded-full cursor-pointer select-none transition-all duration-200",
            webSearchEnabled
              ? cn(
                  isDarkTheme
                    ? "bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30"
                    : "bg-emerald-50 hover:bg-emerald-100 border border-emerald-200"
                )
              : cn(
                  isDarkTheme
                    ? "bg-slate-700/30 hover:bg-slate-700/50 border border-slate-600/30"
                    : "bg-gray-100/80 hover:bg-gray-200/80 border border-gray-200/50"
                )
          )}
          onClick={() => onToggleWebSearch?.()}
        >
          <div className="flex items-center gap-1.5">
            <Globe size={12} className={cn("transition-colors duration-200", webSearchEnabled ? "text-emerald-500" : "text-muted-foreground")} />
            <span className={cn("text-[11px] font-medium transition-colors duration-200", webSearchEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
              {webSearchEnabled ? '已开启搜索' : '网络搜索'}
            </span>
          </div>
          <div className={cn(
            "relative w-7 h-4 rounded-full transition-all duration-200",
            webSearchEnabled
              ? "bg-emerald-500"
              : isDarkTheme ? "bg-slate-600" : "bg-gray-300"
          )}>
            <div className={cn(
              "absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-all duration-200 shadow-sm",
              webSearchEnabled && "translate-x-3"
            )} />
          </div>
        </div>
      )}

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
