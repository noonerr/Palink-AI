import { useRef } from 'react';
import { ArrowUp, Image, Paperclip, X, Loader2, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ModelSelector } from './ModelSelector';
import type { Model } from '@/types';

interface Attachment {
  type: 'image' | 'file';
  name: string;
  url: string;
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onUpload: (file: File, type: 'image' | 'file') => Promise<void>;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  models: Model[];
  currentModel: string;
  onModelChange: (modelId: string) => void;
  disabled?: boolean;
  uploading?: boolean;
  placeholder?: string;
  streaming?: boolean;
  onStop?: () => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onUpload,
  attachments,
  onRemoveAttachment,
  models,
  currentModel,
  onModelChange,
  disabled = false,
  uploading = false,
  placeholder = 'Ask anything...',
  streaming = false,
  onStop
}) => {
  const imgInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent accidental sends while users are composing text with IME.
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'file') => {
    const file = e.target.files?.[0];
    if (file) {
      await onUpload(file, type);
    }
    if (e.target.value) e.target.value = '';
  };

  const autoResize = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  return (
    <div className="w-full">
      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scroll-mobile">
          {attachments.map((att, idx) => (
            <div 
              key={idx} 
              className="relative group flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-lg border border-border shrink-0"
            >
              <span className="text-base sm:text-sm">{att.type === 'image' ? '🖼️' : '📄'}</span>
              <span className="text-xs truncate max-w-[100px] sm:max-w-[120px]">{att.name}</span>
              <button
                onClick={() => onRemoveAttachment(idx)}
                className="absolute -top-1.5 -right-1.5 w-6 h-6 sm:w-5 sm:h-5 bg-muted rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm touch-target"
              >
                <X size={14} className="sm:w-3 sm:h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input Container - With rounded border matching navigation style */}
      <div className="bg-white/70 dark:bg-slate-900/60 backdrop-blur-2xl rounded-[35px] border border-white/50 dark:border-slate-700/40 shadow-xl p-2">
        <div className="flex items-end gap-2">
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
              "flex-1 bg-transparent border-none focus:ring-0 px-2 py-2 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 max-h-28 resize-none outline-none",
              "disabled:opacity-50"
            )}
          />
          
          {streaming ? (
            <button
              onClick={onStop}
              className={cn(
                "h-10 w-10 rounded-2xl flex items-center justify-center transition-all",
                "bg-destructive text-destructive-foreground hover:opacity-90 active:scale-[0.96]",
                "ml-1"
              )}
            >
              <Square size={20} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => onSend()}
              disabled={disabled || uploading || (!value.trim() && attachments.length === 0)}
              className={cn(
                "h-10 w-10 rounded-2xl flex items-center justify-center transition-all ml-1",
                "bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 active:scale-[0.96]",
                "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              )}
            >
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      <input
        type="file"
        ref={imgInputRef}
        className="hidden"
        accept="image/*"
        onChange={(e) => handleFileChange(e, 'image')}
      />
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={(e) => handleFileChange(e, 'file')}
      />
    </div>
  );
};
