import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { MessageSquare, Trash2, CheckSquare, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LoadingDots } from './LoadingDots';

interface Session {
  id: string;
  title?: string;
  updated_at: string;
}

interface ChatSessionListProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSessionSelect: (session: any) => void;
  isDeleteMode: boolean;
  setIsDeleteMode: (v: boolean) => void;
  selectedSessions: Set<string>;
  toggleSessionSelect: (id: string) => void;
  onBatchDelete?: () => void;
  onNewSession?: () => void;
  onDeleteSession?: (id: string) => void;
  showNewButton?: boolean;
  showDeleteButton?: boolean;
  showHeaderActions?: boolean;
  headerTitle?: string;
  t?: Record<string, string>;
  loadingSessionIds?: Set<string>;
}

const morandiColors = [
  'bg-[#E6A4B4]',
  'bg-[#D4B5A0]',
  'bg-[#A8B5C4]',
  'bg-[#B5C4A8]',
  'bg-[#D4A8C4]',
  'bg-[#B8A8C4]',
  'bg-[#A8C4B5]',
  'bg-[#C4A8A8]',
  'bg-[#A8C4C4]',
  'bg-[#C4C4A8]',
  'bg-[#C4A8B8]',
  'bg-[#B8C4A8]'
];

const getMorandiColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return morandiColors[Math.abs(hash) % morandiColors.length];
};

const clampTitleToTenChars = (title: string) => {
  const chars = Array.from((title || '').trim());
  if (chars.length <= 10) {
    return title;
  }
  return chars.slice(0, 10).join('');
};

const mayContainMath = (title: string) => {
  return title.includes('$') || title.includes('\\(') || title.includes('\\[');
};

const normalizeMathDelimiters = (title: string) => {
  return title
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, expr: string) => `\\(${expr.trim()}\\)`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr: string) => `$${expr.trim()}$`);
};

const formatSessionTitle = (title: string) => {
  const normalized = (title || '').trim();
  if (!normalized) {
    return '';
  }
  if (mayContainMath(normalized)) {
    return normalizeMathDelimiters(normalized);
  }
  return clampTitleToTenChars(normalized);
};

const SessionTitleText: React.FC<{ title: string }> = ({ title }) => {
  if (!mayContainMath(title)) {
    return <>{title}</>;
  }

  return (
    <span className="session-title-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ node: _node, children }) => <span>{children}</span>,
        }}
      >
        {title}
      </ReactMarkdown>
    </span>
  );
};

/** 单个会话项 —— 自定义比较函数仅检查数据 props，跳过回调引用 */
const ChatSessionItem = React.memo<{
  session: Session;
  isActive: boolean;
  isDeleteMode: boolean;
  isSelected: boolean;
  onSessionSelect: (session: Session) => void;
  toggleSessionSelect: (id: string) => void;
  onDeleteSession?: (id: string) => void;
  showDeleteButton: boolean;
  label: string;
  isLoading?: boolean;
}>(({
  session,
  isActive,
  isDeleteMode,
  isSelected,
  onSessionSelect,
  toggleSessionSelect,
  onDeleteSession,
  showDeleteButton,
  label,
  isLoading,
}) => {
  return (
    <div
      title={(session.title || '').trim() || label}
      onClick={() => {
        if (isDeleteMode) {
          toggleSessionSelect(session.id);
        } else {
          onSessionSelect(session);
        }
      }}
      className={cn(
        "flex items-center px-4 py-3 cursor-pointer transition-all overflow-hidden w-full min-w-0 border-b border-border/30",
        isActive && !isDeleteMode
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {isDeleteMode ? (
        <div className="shrink-0 mr-3">
          {isSelected ? (
            <CheckSquare size={18} className="text-primary" />
          ) : (
            <Square size={18} />
          )}
        </div>
      ) : (
        <div className={`shrink-0 mr-3 w-6 h-6 rounded-md flex items-center justify-center ${getMorandiColor(session.id)}`}>
          <MessageSquare size={12} className="text-white" />
        </div>
      )}
      
      <div className="flex-1 min-w-0">
        {isLoading ? (
          <div className="flex items-center gap-2">
            <LoadingDots color="text-slate-400" size={5} />
            <div className="text-base truncate text-slate-400">
              <SessionTitleText title={label} />
            </div>
          </div>
        ) : (
          <div className="text-base truncate">
            <SessionTitleText title={label} />
          </div>
        )}
      </div>
      
      {!isDeleteMode && showDeleteButton && onDeleteSession && (
        <button
          type="button"
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 ml-2"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteSession(session.id);
          }}
        >
          <Trash2 size={16} className="text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </div>
  );
});

export const ChatSessionList = React.memo<ChatSessionListProps>(({
  sessions,
  activeSessionId,
  onSessionSelect,
  isDeleteMode,
  selectedSessions,
  toggleSessionSelect,
  onDeleteSession,
  showDeleteButton = true,
  t,
  loadingSessionIds,
}) => {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <ScrollArea className="flex-1 px-0 min-h-0" style={{ scrollbarGutter: 'stable both-edges' }}>
        <style>{`
          [data-radix-scroll-area-viewport] > div {
            display: block !important;
            min-width: 0 !important;
            width: 100% !important;
          }
          @media (max-width: 768px) {
            .mobile-padding {
              padding-bottom: calc(80px + env(safe-area-inset-bottom));
            }
          }
        `}</style>
        <div className="space-y-0 w-full min-w-0 mobile-padding">
          {sessions.map((session) => (
            <ChatSessionItem
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              isDeleteMode={isDeleteMode}
              isSelected={selectedSessions.has(session.id)}
              onSessionSelect={onSessionSelect}
              toggleSessionSelect={toggleSessionSelect}
              onDeleteSession={onDeleteSession}
              showDeleteButton={showDeleteButton}
              label={formatSessionTitle(session.title || t?.new_chat || '新对话')}
              isLoading={loadingSessionIds?.has(session.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}, (_prevProps, _nextProps) => {
  if (_prevProps.sessions !== _nextProps.sessions) return false;
  if (_prevProps.activeSessionId !== _nextProps.activeSessionId) return false;
  if (_prevProps.isDeleteMode !== _nextProps.isDeleteMode) return false;
  if (_prevProps.showDeleteButton !== _nextProps.showDeleteButton) return false;
  if (_prevProps.selectedSessions !== _nextProps.selectedSessions) return false;
  if (_prevProps.loadingSessionIds !== _nextProps.loadingSessionIds) return false;
  if (_prevProps.t !== _nextProps.t) return false;
  return true;
});
