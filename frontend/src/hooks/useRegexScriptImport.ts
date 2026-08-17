/**
 * useRegexScriptImport — 正则脚本导入 Hook
 * 从 CharacterChat 提取的正则脚本导入逻辑
 */
import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { RegexScriptService } from '@/services/regexScriptService';
import type { Character } from '@/types';

export interface UseRegexScriptImportOptions {
  character: Character;
  onRefreshCompatData: () => Promise<void>;
}

export function useRegexScriptImport({
  character,
  onRefreshCompatData,
}: UseRegexScriptImportOptions) {
  const [isImporting, setIsImporting] = useState<'scoped' | 'preset' | null>(null);

  const importToTarget = useCallback(async (file: File, target: 'scoped' | 'preset') => {
    if (!character?.id) return;
    setIsImporting(target);
    try {
      const scripts = await RegexScriptService.extractFromFile(file);
      const result = await RegexScriptService.importToTarget(
        scripts,
        target,
        character.id,
        character.name,
      );
      await onRefreshCompatData();
      const label = RegexScriptService.getTargetLabel(target);
      toast.success(`已导入 ${result.count} 条正则脚本到${label}`);
    } catch (e: any) {
      toast.error(e?.message || '正则脚本导入失败');
    } finally {
      setIsImporting(null);
    }
  }, [character?.id, character?.name, onRefreshCompatData]);

  return {
    isImporting,
    importToTarget,
  };
}

export default useRegexScriptImport;
