/**
 * useCharacterCompatData — 角色兼容性数据 Hook
 * 从 CharacterChat 提取的角色扩展和预设数据管理逻辑
 */
import { useState, useCallback, useEffect } from 'react';
import { api } from '@/services/api';
import type { Character } from '@/types';

export function useCharacterCompatData(character: Character) {
  const [extensions, setExtensions] = useState<Record<string, any> | undefined>(
    character.extensions,
  );
  const [presetData, setPresetData] = useState<Record<string, any> | null | undefined>(
    character.preset_data,
  );

  useEffect(() => {
    setExtensions(character.extensions);
    setPresetData(character.preset_data);
  }, [character.id, character.extensions, character.preset_data]);

  const refresh = useCallback(async () => {
    if (!character?.id) return;
    try {
      const charResult: any = await api.get(`/api/characters/${character.id}`, { cacheTtlMs: 30_000 });
      character.extensions = charResult.extensions || character.extensions;
      character.preset_data = charResult.preset_data || character.preset_data || null;
      setExtensions(charResult.extensions || character.extensions);
      setPresetData(charResult.preset_data || character.preset_data || null);
    } catch (error) {
      console.warn('Failed to refresh character compatibility data:', error);
    }
  }, [character]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    extensions,
    presetData,
    refresh,
  };
}

export default useCharacterCompatData;
