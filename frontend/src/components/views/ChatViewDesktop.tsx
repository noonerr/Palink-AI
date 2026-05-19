import React from 'react';
import { Sparkles } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSidebar } from './chat/ChatSidebar';
import { WelcomeContent } from './chat/WelcomeContent';
import { ChatHeader } from './chat/ChatHeader';
import { useChatView } from '@/hooks/useChatView';
import type { Model } from '@/types';

interface ChatViewProps {
  token: string;
  user: { avatar?: string; username: string };
  models: Model[];
  currentModel: string;
  setCurrentModel: (modelId: string) => void;
  t: Record<string, string>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  isDark?: boolean;
  showModelReasoning?: boolean;
}

export function ChatViewDesktop({
  user,
  models,
  currentModel,
  setCurrentModel,
  t,
  sidebarCollapsed,
  setSidebarCollapsed,
  showModelReasoning = true,
}: ChatViewProps) {
  const chat = useChatView({ currentModel, t });

  const handleSend = async (overrideText?: string) => {
    await chat.handleSend(overrideText);
  };

  if (chat.messages.length === 0 && !chat.activeSessionId) {
    return (
      <div className="flex h-full overflow-hidden">
        <ChatSidebar
          sessions={chat.sessions}
          activeSessionId={chat.activeSessionId}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          isDeleteMode={chat.isDeleteMode}
          setIsDeleteMode={chat.setIsDeleteMode}
          selectedSessions={chat.selectedSessions}
          toggleSessionSelect={chat.toggleSessionSelect}
          handleBatchDelete={chat.handleBatchDelete}
          handleSelectSession={chat.handleSelectSession}
          handleDeleteSession={chat.handleDeleteSession}
          setActiveSessionId={chat.setActiveSessionId}
          t={t}
        />
        <WelcomeContent
          models={models}
          currentModel={currentModel}
          setCurrentModel={setCurrentModel}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          input={chat.input}
          setInput={chat.setInput}
          handleSend={handleSend}
          handleUpload={chat.handleUpload}
          attachments={chat.attachments}
          setAttachments={chat.setAttachments}
          streaming={chat.streaming}
          uploading={chat.uploading}
          handleStopStreaming={chat.handleStopStreaming}
          setActiveSessionId={chat.setActiveSessionId}
          t={t}
        />
        <ConfirmDialog
          open={chat.showDeleteConfirm}
          onOpenChange={chat.setShowDeleteConfirm}
          title={chat.pendingDelete?.type === 'batch' ? t.delete_selected + '?' : chat.pendingDelete?.type === 'message' ? '删除消息?' : t.delete_chat + '?'}
          description={chat.pendingDelete?.type === 'batch'
            ? `确定要删除选中的 ${chat.selectedSessions.size} 个对话吗？此操作无法撤销。`
            : chat.pendingDelete?.type === 'message'
              ? "确定要删除这条消息吗？删除后该内容将从上下文中移除，AI将不再保留此记忆。此操作无法撤销。"
              : "确定要删除这个对话吗？此操作无法撤销。"}
          onConfirm={chat.confirmDelete}
          confirmText={t.ok}
          cancelText={t.cancel}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <ChatSidebar
        sessions={chat.sessions}
        activeSessionId={chat.activeSessionId}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        isDeleteMode={chat.isDeleteMode}
        setIsDeleteMode={chat.setIsDeleteMode}
        selectedSessions={chat.selectedSessions}
        toggleSessionSelect={chat.toggleSessionSelect}
        handleBatchDelete={chat.handleBatchDelete}
        handleSelectSession={chat.handleSelectSession}
        handleDeleteSession={chat.handleDeleteSession}
        setActiveSessionId={chat.setActiveSessionId}
        t={t}
      />

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <ChatHeader
          models={models}
          currentModel={currentModel}
          setCurrentModel={setCurrentModel}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          activeSessionId={chat.activeSessionId}
          setActiveSessionId={chat.setActiveSessionId}
          messages={chat.messages}
          streaming={chat.streaming}
          showMessageSelect={chat.showMessageSelect}
          setShowMessageSelect={chat.setShowMessageSelect}
          selectedMessages={chat.selectedMessages}
          handleDeleteSelectedMessages={chat.handleDeleteSelectedMessages}
        />

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full px-3 sm:px-6 py-4 sm:py-6" onScroll={chat.handleScroll}>
            <div className={`max-w-3xl mx-auto space-y-6`}>
              {chat.messages.map((msg, idx) => (
                <div key={msg.id || idx} className="flex items-start gap-2">
                  <div className="flex-1">
                    <Message
                      message={msg}
                      userAvatar={user.avatar}
                      userName={user.username}
                      models={models}
                      streaming={(chat.streaming && idx === chat.messages.length - 1) || chat.regeneratingMessageIndex === idx}
                      isLast={idx === chat.messages.length - 1}
                      t={t}
                      tokens={msg.tokens}
                      memoryStats={chat.memoryMode === 'rule' && idx === chat.messages.length - 1 && msg.role === 'assistant' ? chat.memoryStats : null}
                      onCompress={chat.memoryMode === 'rule' && idx === chat.messages.length - 1 && msg.role === 'assistant' ? chat.manualCompressMemory : undefined}
                      compressing={chat.compressing}
                      onRegenerate={msg.role === 'assistant' && !chat.streaming ? () => chat.handleRegenerate(idx) : undefined}
                      canRegenerate={msg.role === 'assistant' && !chat.streaming && idx > 0 && chat.messages[idx - 1]?.role === 'user'}
                      onDelete={msg.id != null ? () => chat.handleDeleteMessage(msg.id as string | number, idx) : undefined}
                      onEdit={msg.id != null ? (newContent: string) => chat.handleEditMessage(msg.id as string | number, idx, newContent) : undefined}
                      canEdit={msg.role === 'assistant' && !chat.streaming}
                      isSelected={msg.id !== undefined ? chat.selectedMessages.has(String(msg.id)) : false}
                      onToggleSelect={msg.id !== undefined ? () => chat.toggleMessageSelect(String(msg.id)) : undefined}
                      showSelect={chat.showMessageSelect}
                      isCharacterChat={false}
                      memoryMode={chat.memoryMode}
                      showModelReasoning={showModelReasoning}
                    />
                  </div>
                </div>
              ))}

              {chat.streamStatus === 'queued' && chat.queueInfo && (
                <div className="flex items-center gap-3 pl-12 animate-fade-in-up">
                  <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 text-amber-700 dark:text-amber-300 text-sm">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>排队中 · 第 {chat.queueInfo.position + 1} 位</span>
                    {chat.queueInfo.estimatedWait > 0 && (
                      <span className="text-amber-500 dark:text-amber-400">· 预计 {Math.ceil(chat.queueInfo.estimatedWait)}s</span>
                    )}
                  </div>
                </div>
              )}

              {chat.suggestions.length > 0 && !chat.streaming && (
                <div className="flex flex-wrap gap-2 pl-12 animate-fade-in-up">
                  {chat.suggestions.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSend(s)}
                      className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-full text-xs font-medium transition-colors"
                    >
                      <Sparkles size={10} className="inline mr-1" />
                      {s}
                    </button>
                  ))}
                </div>
              )}

              <div ref={chat.messagesEndRef} />
            </div>
          </ScrollArea>
        </div>

        <div className="p-2 border-t border-border/50 pb-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput
              value={chat.input}
              onChange={chat.setInput}
              onSend={handleSend}
              onUpload={chat.handleUpload}
              attachments={chat.attachments}
              onRemoveAttachment={(idx) => chat.setAttachments(prev => prev.filter((_, i) => i !== idx))}
              disabled={chat.streaming}
              uploading={chat.uploading}
              placeholder={t.ask_anything}
              streaming={chat.streaming}
              onStop={chat.handleStopStreaming}
            />
            <p className="text-center mt-2 text-[10px] text-muted-foreground/60">
              {t.ai_disclaimer}
            </p>
          </div>
        </div>
        <ConfirmDialog
          open={chat.showDeleteConfirm}
          onOpenChange={chat.setShowDeleteConfirm}
          title={chat.pendingDelete?.type === 'batch' ? t.delete_selected + '?' : chat.pendingDelete?.type === 'message' ? '删除消息?' : t.delete_chat + '?'}
          description={chat.pendingDelete?.type === 'batch'
            ? `确定要删除选中的 ${chat.selectedSessions.size} 个对话吗？此操作无法撤销。`
            : chat.pendingDelete?.type === 'message'
              ? "确定要删除这条消息吗？删除后该内容将从上下文中移除，AI将不再保留此记忆。此操作无法撤销。"
              : "确定要删除这个对话吗？此操作无法撤销。"}
          onConfirm={chat.confirmDelete}
          confirmText={t.ok}
          cancelText={t.cancel}
        />

      </div>
    </div>
  );
};
