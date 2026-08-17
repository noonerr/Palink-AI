/**
 * usePresetImport — 预设导入 Hook
 * 从 CharacterChat 提取的预设导入逻辑
 */
import { useState, useCallback } from 'react';
import { api } from '@/services/api';
import { toast } from 'sonner';
import type { Character } from '@/types';

export interface UsePresetImportOptions {
  character: Character;
}

export function usePresetImport({ character }: UsePresetImportOptions) {
  const [isImporting, setIsImporting] = useState(false);

  const handleImportPreset = useCallback(async (file: File) => {
    if (!character?.id) return;
    setIsImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result: any = await api.post(`/api/characters/${character.id}/import-preset`, formData);
      toast.success(`预设导入成功：${result.preset_name || '未知预设'}`);
      // 更新角色数据中的 preset_data
      character.preset_data = await (async () => {
        try {
          const charResult: any = await api.get(`/api/characters/${character.id}`);
          return charResult.preset_data || null;
        } catch {
          return null;
        }
      })();
    } catch (e: any) {
      const detail = e?.message || '预设导入失败';
      toast.error(detail);
    } finally {
      setIsImporting(false);
    }
  }, [character]);

  const handleRemovePreset = useCallback(async () => {
    if (!character?.id) return;
    try {
      await api.delete(`/api/characters/${character.id}/preset`);
      character.preset_data = null;
      toast.success('预设已移除');
    } catch (e: any) {
      toast.error(e?.message || '移除预设失败');
    }
  }, [character]);

  return {
    isImporting,
    handleImportPreset,
    handleRemovePreset,
  };
}

export default usePresetImport;
