import { MessageSquarePlus, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import type { Model } from '@/types';

interface ChatHeaderProps {
  models: Model[];
  currentModel: string;
  setCurrentModel: (modelId: string) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  messages: any[];
  streaming: boolean;
  showMessageSelect: boolean;
  setShowMessageSelect: (value: boolean) => void;
  selectedMessages: Set<string>;
  handleDeleteSelectedMessages: () => void;
}

export function ChatHeader({
  models,
  currentModel,
  setCurrentModel,
  sidebarCollapsed,
  setSidebarCollapsed,
  activeSessionId,
  setActiveSessionId,
  messages,
  streaming,
  showMessageSelect,
  setShowMessageSelect,
  selectedMessages,
  handleDeleteSelectedMessages,
}: ChatHeaderProps) {
  return (
    <div className="h-14 flex items-center justify-between px-3 md:px-6 border-b border-border/50 glass z-10">
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
        {activeSessionId && messages.length > 0 && (
          <>
            <Button
              variant={showMessageSelect ? "default" : "ghost"}
              size="icon"
              className="h-9 w-9 rounded-lg transition-all"
              onClick={() => {
                setShowMessageSelect(!showMessageSelect);
                if (showMessageSelect) {
                  // clearSelection will be handled by parent
                }
              }}
              title={showMessageSelect ? "退出选择模式" : "选择消息"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="m9 12 2 2 4-4"/></svg>
            </Button>
            {showMessageSelect && selectedMessages.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                className="h-8 px-2 sm:px-3"
                onClick={handleDeleteSelectedMessages}
              >
                <Trash2 size={14} className="sm:mr-1.5" />
                <span className="hidden sm:inline">删除 </span>{selectedMessages.size} 条
              </Button>
            )}
          </>
        )}
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
  );
}
