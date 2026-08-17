/**
 * ChatConfirmDialogs — 聊天确认对话框集合
 * 从 CharacterChat 提取的确认对话框组件
 */
import React from 'react';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';

export interface ChatConfirmDialogsProps {
  // 会话删除
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (v: boolean) => void;
  pendingDelete: { type: 'single'; id: string } | { type: 'batch' } | null;
  selectedSessionsCount: number;
  confirmDelete: () => Promise<void>;
  // 分支删除
  showDeleteBranchConfirm: boolean;
  setShowDeleteBranchConfirm: (v: boolean) => void;
  confirmDeleteBranch: () => Promise<void>;
  // 混合删除
  showDeleteMixedConfirm: boolean;
  setShowDeleteMixedConfirm: (v: boolean) => void;
  confirmDeleteMixed: () => Promise<void>;
  // 文本
  dialogText: {
    confirm: string;
    cancel: string;
    processing: string;
    deleteSelectedSessionsTitle: string;
    deleteSelectedSessionsDescription: (count: number) => string;
    deleteSessionTitle: string;
    deleteSessionDescription: string;
    deleteBranchTitle: string;
    deleteBranchDescription: string;
    deleteSelectedContentTitle: string;
    deleteSelectedContentDescription: string;
  };
}

export function ChatConfirmDialogs({
  showDeleteConfirm,
  setShowDeleteConfirm,
  pendingDelete,
  selectedSessionsCount,
  confirmDelete,
  showDeleteBranchConfirm,
  setShowDeleteBranchConfirm,
  confirmDeleteBranch,
  showDeleteMixedConfirm,
  setShowDeleteMixedConfirm,
  confirmDeleteMixed,
  dialogText,
}: ChatConfirmDialogsProps) {
  return (
    <>
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={pendingDelete?.type === 'batch' ? dialogText.deleteSelectedSessionsTitle : dialogText.deleteSessionTitle}
        description={pendingDelete?.type === 'batch'
          ? dialogText.deleteSelectedSessionsDescription(selectedSessionsCount)
          : dialogText.deleteSessionDescription}
        onConfirm={confirmDelete}
        confirmText={dialogText.confirm}
        cancelText={dialogText.cancel}
        loadingText={dialogText.processing}
      />
      <ConfirmDialog
        open={showDeleteBranchConfirm}
        onOpenChange={setShowDeleteBranchConfirm}
        title={dialogText.deleteBranchTitle}
        description={dialogText.deleteBranchDescription}
        onConfirm={confirmDeleteBranch}
        confirmText={dialogText.confirm}
        cancelText={dialogText.cancel}
        loadingText={dialogText.processing}
      />
      <ConfirmDialog
        open={showDeleteMixedConfirm}
        onOpenChange={setShowDeleteMixedConfirm}
        title={dialogText.deleteSelectedContentTitle}
        description={dialogText.deleteSelectedContentDescription}
        onConfirm={confirmDeleteMixed}
        confirmText={dialogText.confirm}
        cancelText={dialogText.cancel}
        loadingText={dialogText.processing}
      />
    </>
  );
}

export default ChatConfirmDialogs;
