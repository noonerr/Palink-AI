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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
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

      {/* Input Container */}
      <div className="glass-strong rounded-2xl p-1 sm:p-2 shadow-xl shadow-primary/10 border border-border/30 w-full">
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
            "w-full bg-transparent border-none outline-none resize-none",
            "min-h-[40px] sm:min-h-[36px] max-h-[200px] py-2 sm:py-1.5 px-2 sm:px-1",
            "text-base sm:text-foreground placeholder:text-muted-foreground",
            "disabled:opacity-50"
          )}
        />

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
          <div className="flex items-center gap-1">
            <ModelSelector
              models={models}
              currentModel={currentModel}
              onSelect={onModelChange}
              size="sm"
            />
            
            <div className="w-px h-4 bg-border mx-1 sm:mx-2" />
            
            <button
              onClick={() => imgInputRef.current?.click()}
              disabled={uploading}
              className="p-2.5 sm:p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50 touch-target"
              title="Upload Image"
            >
              {uploading ? <Loader2 size={20} className="animate-spin sm:w-[18px] sm:h-[18px]" /> : <Image size={20} className="sm:w-[18px] sm:h-[18px]" />}
            </button>
            
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="p-2.5 sm:p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50 touch-target"
              title="Upload File"
            >
              <Paperclip size={20} className="sm:w-[18px] sm:h-[18px]" />
            </button>
          </div>

          {streaming ? (
            <button
              onClick={onStop}
              className={cn(
                "w-11 h-11 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center transition-all touch-target",
                "bg-destructive text-destructive-foreground hover:opacity-90 active:scale-95",
                "shadow-lg shadow-destructive/25"
              )}
            >
              <Square size={16} className="sm:w-[14px] sm:h-[14px]" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => onSend()}
              disabled={disabled || uploading || (!value.trim() && attachments.length === 0)}
              className={cn(
                "w-11 h-11 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center transition-all touch-target",
                "bg-primary text-primary-foreground hover:opacity-90 active:scale-95",
                "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
                "shadow-lg shadow-primary/25"
              )}
            >
              <ArrowUp size={20} className="sm:w-[18px] sm:h-[18px]" strokeWidth={2.5} />
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
