import { MessageSquarePlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import type { Model, Attachment } from '@/types';

interface WelcomeContentProps {
  models: Model[];
  currentModel: string;
  setCurrentModel: (modelId: string) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  input: string;
  setInput: (value: string) => void;
  handleSend: (overrideText?: string) => void;
  handleUpload: (file: File, type: 'image' | 'file') => Promise<void>;
  attachments: Attachment[];
  setAttachments: (attachments: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void;
  streaming: boolean;
  uploading: boolean;
  handleStopStreaming: () => void;
  setActiveSessionId: (id: string | null) => void;
  t: Record<string, string>;
}

export function WelcomeContent({
  models,
  currentModel,
  setCurrentModel,
  sidebarCollapsed,
  setSidebarCollapsed,
  input,
  setInput,
  handleSend,
  handleUpload,
  attachments,
  setAttachments,
  streaming,
  uploading,
  handleStopStreaming,
  setActiveSessionId,
  t,
}: WelcomeContentProps) {
  const currentModelObj = models.find(m => m.id === currentModel) || models[0];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="h-[54px] flex items-center justify-between px-3 md:px-6 border-b border-border/50 glass z-10">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="flex h-8 w-8 rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-all shrink-0"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </Button>
          <div className="min-w-0 flex-1">
            <ModelSelector
              models={models}
              currentModel={currentModel}
              onSelect={setCurrentModel}
            />
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            onClick={() => setActiveSessionId(null)}
            className="h-8 px-2 sm:px-3"
          >
            <MessageSquarePlus size={16} className="sm:mr-1.5" />
            <span className="hidden sm:inline">新对话</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-auto overscroll-y-contain">
        <div className="w-full max-w-2xl flex flex-col items-center animate-fade-in-up">
          <div className="mb-10 text-center">
            <div className="w-24 h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
              {(() => {
                const icon = currentModelObj?.icon;
                if (icon && (icon.startsWith('/') || icon.startsWith('http') || icon.startsWith('data:'))) {
                  return <img src={icon} alt="" className="w-full h-full object-cover" />;
                }
                return <span>{icon || '🤖'}</span>;
              })()}
            </div>
            <h1 className="text-3xl font-semibold mb-2">
              {currentModelObj?.alias || currentModelObj?.name}
            </h1>
            <p className="text-muted-foreground">
              {currentModelObj?.description || t.welcome_greeting}
            </p>
          </div>
        </div>
      </div>

      <div className="p-2 border-t border-border/50 pb-4">
        <div className="max-w-3xl mx-auto">
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onUpload={handleUpload}
            attachments={attachments}
            onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
            disabled={streaming}
            uploading={uploading}
            placeholder={t.ask_anything}
            streaming={streaming}
            onStop={handleStopStreaming}
          />
          <p className="text-center mt-2 text-[10px] text-muted-foreground/60">
            {t.ai_disclaimer}
          </p>
        </div>
      </div>
    </div>
  );
}
