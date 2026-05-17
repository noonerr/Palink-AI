import { X, Edit3, Trash2, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import type { Session } from '@/types';

interface ChatSidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  isDeleteMode: boolean;
  setIsDeleteMode: (value: boolean) => void;
  selectedSessions: Set<string>;
  toggleSessionSelect: (id: string) => void;
  handleBatchDelete: () => void;
  handleSelectSession: (session: any) => void;
  handleDeleteSession: (id: string) => void;
  setActiveSessionId: (id: string | null) => void;
  t: Record<string, string>;
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  sidebarCollapsed,
  setSidebarCollapsed,
  isDeleteMode,
  setIsDeleteMode,
  selectedSessions,
  toggleSessionSelect,
  handleBatchDelete,
  handleSelectSession,
  handleDeleteSession,
  setActiveSessionId,
  t,
}: ChatSidebarProps) {
  return (
    <div className={`transition-all duration-300 ease-in-out overflow-hidden relative ${!sidebarCollapsed ? 'w-64 opacity-100' : 'w-0 opacity-0'}`}>
      <div className="w-64 h-full flex-shrink-0 glass flex flex-col overflow-hidden pt-[env(safe-area-inset-top)]">
        <div className="h-[54px] flex items-center justify-between px-4 shrink-0 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full hover:bg-accent hover:text-accent-foreground"
              onClick={() => setSidebarCollapsed(true)}
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="text-sm font-semibold text-foreground">
              {isDeleteMode ? t.batch_manage : t.chat_history}
            </span>
          </div>
          <div className="flex gap-1">
            <Button
              variant={isDeleteMode && selectedSessions.size > 0 ? "destructive" : "ghost"}
              size="icon"
              className={cn(
                "h-8 w-8",
                isDeleteMode && selectedSessions.size === 0 && "text-destructive hover:bg-destructive/10"
              )}
              onClick={() => {
                if (isDeleteMode) {
                  if (selectedSessions.size > 0) {
                    handleBatchDelete();
                  } else {
                    setIsDeleteMode(false);
                  }
                } else {
                  setIsDeleteMode(true);
                }
              }}
            >
              {isDeleteMode ? (
                selectedSessions.size > 0 ? (
                  <Trash2 size={14} />
                ) : (
                  <X size={14} />
                )
              ) : (
                <Edit3 size={14} />
              )}
            </Button>
          </div>
        </div>
        <ChatSessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSessionSelect={handleSelectSession}
          isDeleteMode={isDeleteMode}
          setIsDeleteMode={setIsDeleteMode}
          selectedSessions={selectedSessions}
          toggleSessionSelect={toggleSessionSelect}
          onBatchDelete={handleBatchDelete}
          onNewSession={() => setActiveSessionId(null)}
          onDeleteSession={handleDeleteSession}
          showNewButton={true}
          showDeleteButton={false}
          showHeaderActions={false}
          t={t}
        />
      </div>
    </div>
  );
}
