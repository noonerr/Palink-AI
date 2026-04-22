import { useCallback, useRef, useState } from 'react';
import { ArrowUp, Paperclip, X, Square } from 'lucide-react';
import { cn } from '@/lib/utils';

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
}

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
  theme = 'dark'
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const isDarkTheme = theme === 'dark';

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

    for (const file of Array.from(files)) {
      const type = file.type.startsWith('image/') ? 'image' : 'file';
      await onUpload(file, type);
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

    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const type = file.type.startsWith('image/') ? 'image' : 'file';
      await onUpload(file, type);
    }
  }, [onUpload]);

  const autoResize = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
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

      <div
        className={cn(
          'flex items-end gap-2 overflow-visible',
          variant === 'mobile-demo' &&
            cn(
              'min-h-[58px] items-center rounded-[28px] px-3 py-2.5 backdrop-blur-2xl',
              isDarkTheme
                ? 'border border-slate-700/80 bg-[#23283c] shadow-[0_12px_30px_rgba(2,6,23,0.45)]'
                : 'border border-[#ddd4c5] bg-[#FFFAFA] shadow-[0_10px_28px_rgba(120,106,79,0.14)]'
            ),
          isDragging && 'border-primary bg-primary/5'
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="上传图片或文件"
        >
          <Paperclip size={18} />
        </button>

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
            'flex-1 bg-transparent border-none focus:ring-0 resize-none outline-none disabled:opacity-50',
            variant === 'mobile-demo'
              ? cn(
                  'px-1 py-1.5 text-sm max-h-28',
                  isDarkTheme
                    ? 'text-slate-100 placeholder:text-slate-400'
                    : 'text-slate-700 placeholder:text-slate-400'
                )
              : 'px-2 py-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 max-h-28'
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
            <ArrowUp size={18} />
          </button>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar,.7z,.tar,.gz,.csv,.json,.md,.html,.css,.js,.ts,.jsx,.tsx,.py,.java,.cpp,.c,.h,.go,.rs,.rb,.php,.swift,.kt,.xml,.yaml,.yml,.toml,.ini,.cfg"
        multiple
        onChange={handleFileChange}
      />

      {isDragging && (
        <div className="mt-2 rounded-2xl border border-dashed border-primary/60 bg-primary/5 px-4 py-3 text-center text-xs text-muted-foreground">
          松开以上传图片、PDF、Office 文档、压缩包或代码文件
        </div>
      )}
    </div>
  );
};
