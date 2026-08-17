/**
 * 附件管理Hook
 * 从useChatView中提取的附件上传和管理逻辑
 */

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import type { Attachment } from '@/types';

export interface UseAttachmentsParams {
  t: Record<string, string>;
}

export function useAttachments({ t }: UseAttachmentsParams) {
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // 回收附件预览URL
  const revokeAttachmentPreviews = useCallback((items: Attachment[]) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.thumbnail?.startsWith('blob:') && !seen.has(item.thumbnail)) {
        seen.add(item.thumbnail);
        URL.revokeObjectURL(item.thumbnail);
      }
    }
  }, []);

  // 设置附件
  const setAttachments = useCallback((nextAttachments: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    setAttachmentsState(prev => {
      const next = typeof nextAttachments === 'function' 
        ? nextAttachments(prev) 
        : nextAttachments;
      
      // 回收不再使用的预览URL
      const nextPreviewUrls = new Set(
        next
          .map(item => item.thumbnail)
          .filter((thumbnail): thumbnail is string => Boolean(thumbnail))
      );
      
      const toRevoke = prev.filter(item => 
        item.thumbnail?.startsWith('blob:') && !nextPreviewUrls.has(item.thumbnail)
      );
      
      if (toRevoke.length > 0) {
        revokeAttachmentPreviews(toRevoke);
      }
      
      return next;
    });
  }, [revokeAttachmentPreviews]);

  // 上传文件
  const handleUpload = useCallback(async (file: File, type: 'image' | 'file') => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await api.post('/api/upload', formData);
      
      if (!data.url) {
        throw new Error('上传返回数据异常');
      }

      setAttachments(prev => [...prev, {
        type,
        name: file.name,
        url: data.url,
        thumbnail: type === 'image' ? URL.createObjectURL(file) : undefined,
        size: file.size,
      }]);
    } catch (error) {
      console.error('Upload failed:', error);
      toast.error(t.upload_failed || '文件上传失败');
    } finally {
      setUploading(false);
    }
  }, [setAttachments, t]);

  // 移除附件
  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => {
      const next = [...prev];
      const removed = next.splice(index, 1);
      revokeAttachmentPreviews(removed);
      return next;
    });
  }, [setAttachments, revokeAttachmentPreviews]);

  // 清空附件
  const clearAttachments = useCallback(() => {
    revokeAttachmentPreviews(attachmentsRef.current);
    setAttachmentsState([]);
  }, [revokeAttachmentPreviews]);

  return {
    attachments,
    setAttachments,
    uploading,
    handleUpload,
    removeAttachment,
    clearAttachments,
  };
}
