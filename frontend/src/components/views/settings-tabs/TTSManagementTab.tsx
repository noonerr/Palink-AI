import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Download, Edit3, Loader2, Plus, Save, Trash2, UploadCloud, Volume2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { api } from '@/services/api';
import { ttsService } from '@/services/tts';
import { cn } from '@/lib/utils';
import type {
  TTSBindingPayload,
  TTSBindingState,
  TTSCloneSample,
  TTSManagementState,
  TTSProvider,
  TTSRole,
  TTSVoiceBinding,
  TTSVoiceOption,
} from '@/types/tts';

interface TTSManagementTabProps {
  isAdmin: boolean;
}

interface EditingProvider extends TTSProvider {
  config?: Record<string, string>;
  config_fields?: Array<Record<string, unknown>>;
}

const ROLE_LABELS: Record<TTSRole, string> = {
  character: '角色对白',
  narrator: '旁白',
};

const INHERIT_SENTINEL = '__inherit__';
const CLONE_PREFIX = 'clone:';

function getVoiceKey(binding?: TTSVoiceBinding | TTSBindingState | null): string {
  const target = binding && 'resolved' in binding ? binding.explicit : binding;
  if (!target) return INHERIT_SENTINEL;
  if (target.clone_sample_id) return `${CLONE_PREFIX}${target.clone_sample_id}`;
  return target.voice_id || INHERIT_SENTINEL;
}

function getResolvedText(state?: TTSBindingState | null): string {
  if (!state?.resolved) return '未解析';
  const clone = state.resolved.clone_sample_id ? ' · 克隆音色' : '';
  return `${state.resolved.provider_id || '默认'} / ${state.resolved.voice_id || '自动'}${clone}`;
}

function providerSupportsClone(provider?: TTSProvider): boolean {
  return provider?.engine_type === 'xiaomi_mimo';
}

function findMimoProvider(providers: TTSProvider[]): TTSProvider | undefined {
  return providers.find(provider => provider.id === 'xiaomi_mimo') || providers.find(provider => provider.engine_type === 'xiaomi_mimo');
}

function detectVoiceLanguage(voice: TTSVoiceOption | undefined): 'en' | 'zh' {
  if (!voice) return 'zh';
  const text = `${voice.voice_id} ${voice.description || ''}`.toLowerCase();
  const enIndicators = ['en', 'english', 'mia', 'chloe', 'milo', 'dean', 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const isEnglish = enIndicators.some(ind => text.includes(ind)) || /[a-zA-Z]{3,}/.test(voice.voice_id);
  return isEnglish ? 'en' : 'zh';
}

function getPreviewText(voice: TTSVoiceOption | undefined): string {
  const lang = detectVoiceLanguage(voice);
  if (lang === 'en') {
    return 'Hello, this is a voice preview test.';
  }
  return '你好，这是语音试听测试。';
}

export function TTSManagementTab({ isAdmin }: TTSManagementTabProps) {
  const [management, setManagement] = useState<TTSManagementState | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingProvider, setEditingProvider] = useState<EditingProvider | null>(null);
  const [builtinConfigEdits, setBuiltinConfigEdits] = useState<Record<string, Record<string, string>>>({});
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState<Array<{ id: string; name: string }>>([]);
  const [characterBindings, setCharacterBindings] = useState<Record<TTSRole, TTSBindingState> | null>(null);
  const [prefetchingVoices, setPrefetchingVoices] = useState<Set<string>>(new Set());
  const [cachedVoiceAudios, setCachedVoiceAudios] = useState<Record<string, string>>({});
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const cloneSamplesSectionRef = useRef<HTMLDivElement | null>(null);

  const toggleSection = (id: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeProvider = useMemo(
    () => management?.providers.find(provider => provider.id === management.active_provider_id),
    [management],
  );

  const mimoProvider = useMemo(
    () => findMimoProvider(management?.providers || []),
    [management],
  );

  const cloneProvider = providerSupportsClone(activeProvider) ? activeProvider : mimoProvider;
  const isMimoActive = providerSupportsClone(activeProvider);

  const scrollToCloneSamples = useCallback(() => {
    cloneSamplesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const fetchTtsData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.tts.getManagement();
      setManagement(data);
      ttsService.segmentedPlayback = data.segmented_playback;
      loadCachedVoices(data.providers);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '加载语音设置失败';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCachedVoices = (providers: TTSProvider[]) => {
    const cached: Record<string, string> = {};
    providers.forEach(p => {
      const storageKey = `tts_cached_${p.id}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.audio_b64) {
            cached[p.id] = storageKey;
          }
        } catch {
          // Ignore stale or malformed preview cache entries.
        }
      }
    });
    setCachedVoiceAudios(cached);
  };

  const fetchVoices = async (providerId: string): Promise<void> => {
    try {
      const result = await api.tts.fetchProviderVoices(providerId);
      if (result.success && result.voices.length > 0) {
        await api.tts.updateProviderVoices(providerId, result.voices);
        await fetchTtsData();
        toast.success(result.message);
      } else {
        toast.warning(result.message || '未获取到音色');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '获取音色列表失败';
      toast.error(message);
    }
  };

  const prefetchVoices = async (providerId: string, providerName: string, voice?: TTSVoiceOption): Promise<void> => {
    setPrefetchingVoices(prev => new Set(prev).add(providerId));
    try {
      const previewText = getPreviewText(voice);
      const result = await api.tts.prefetchProviderVoices(providerId, previewText);
      if (result.success) {
        if (result.cached.length > 0) {
          const firstVoice = result.cached[0];
          const storageKey = `tts_cached_${providerId}`;
          localStorage.setItem(storageKey, JSON.stringify(firstVoice));
          setCachedVoiceAudios(prev => ({ ...prev, [providerId]: storageKey }));
        }
        toast.success(result.message);
        if (result.errors.length > 0) {
          console.warn('预下载失败:', result.errors);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '预下载失败';
      toast.error(message);
    } finally {
      setPrefetchingVoices(prev => {
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
    }
  };

  const playCachedVoice = (providerId: string): void => {
    const storageKey = cachedVoiceAudios[providerId];
    if (!storageKey) return;
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored);
      if (parsed.audio_b64) {
        fetch(`data:audio/wav;base64,${parsed.audio_b64}`)
          .then(r => r.blob())
          .then(blob => {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            const cleanup = () => URL.revokeObjectURL(url);
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.play().catch(cleanup);
          });
      }
    } catch {
      // Ignore stale or malformed preview cache entries.
    }
  };

  const fetchCharacters = useCallback(async () => {
    try {
      const data = await api.get<Array<{ id: string; name: string }>>('/api/characters');
      setCharacters(data.map(character => ({ id: character.id, name: character.name })));
    } catch {
      setCharacters([]);
    }
  }, []);

  const fetchCharacterBindings = useCallback(async (characterId: string) => {
    if (!characterId) {
      setCharacterBindings(null);
      return;
    }
    try {
      const data = await api.tts.getCharacterVoiceBindings(characterId) as unknown as { bindings: Record<TTSRole, TTSBindingState> };
      setCharacterBindings(data.bindings);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '加载角色语音绑定失败';
      toast.error(message);
    }
  }, []);

  useEffect(() => {
    fetchTtsData();
    fetchCharacters();
  }, [fetchCharacters, fetchTtsData]);

  useEffect(() => {
    fetchCharacterBindings(selectedCharacterId);
  }, [fetchCharacterBindings, selectedCharacterId]);

  const saveProviderConfig = async (providerId: string, fieldKey: string, value: string): Promise<void> => {
    if (!value) return;
    try {
      await api.tts.saveConfig({ provider_configs: { [providerId]: { [fieldKey]: value } } });
      setBuiltinConfigEdits(prev => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      await fetchTtsData();
      toast.success('配置已保存');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '保存失败';
      toast.error(message);
    }
  };

  const switchProvider = async (providerId: string): Promise<void> => {
    try {
      await api.tts.saveConfig({ active_provider_id: providerId });
      await fetchTtsData();
      toast.success('已切换服务商');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '切换失败';
      toast.error(message);
    }
  };

  const saveRoleBinding = async (
    scope: 'global' | 'user' | 'character',
    role: TTSRole,
    voiceKey: string,
  ): Promise<void> => {
    if (!management) return;
    const payload = buildBindingPayload(role, voiceKey, management.active_provider_id, activeProvider, management.clone_samples, scope !== 'global');
    try {
      if (scope === 'global') {
        await api.tts.saveAdminDefaultBindings([payload]);
      } else if (scope === 'user') {
        await api.tts.saveMyBindings([payload]);
      } else if (selectedCharacterId) {
        await api.tts.saveCharacterVoiceBindings(selectedCharacterId, [payload]);
        await fetchCharacterBindings(selectedCharacterId);
      }
      await fetchTtsData();
      toast.success('语音绑定已保存');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '保存失败';
      toast.error(message);
    }
  };

  const previewRole = async (role: TTSRole, voiceKey: string, characterId?: string): Promise<void> => {
    if (!management) return;
    const override = buildBindingPayload(role, voiceKey, management.active_provider_id, activeProvider, management.clone_samples, true);
    try {
      await ttsService.preview({
        role,
        character_id: characterId,
        text: role === 'narrator' ? '夜色渐深，窗外的风轻轻掠过树梢。' : '你好，这是我的角色语音试听。',
        binding_override: override,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '试听失败';
      toast.error(message);
    }
  };

  const uploadCloneSample = async (): Promise<void> => {
    if (!uploadFile) {
      toast.warning('请选择声音样本');
      return;
    }
    if (!cloneProvider) {
      toast.error('请先添加或启用小米 MIMO 服务商');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('name', uploadName || uploadFile.name.replace(/\.[^.]+$/, ''));
      formData.append('provider_id', cloneProvider.id);
      await api.tts.uploadCloneSample(formData);
      setUploadFile(null);
      setUploadName('');
      await fetchTtsData();
      toast.success('声音样本已上传');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '上传失败';
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const deleteCloneSample = async (sampleId: string): Promise<void> => {
    try {
      await api.tts.deleteCloneSample(sampleId);
      await fetchTtsData();
      toast.success('声音样本已删除');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '删除失败';
      toast.error(message);
    }
  };

  if (!management) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {loading ? '正在加载语音设置...' : '暂无语音设置'}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6 animate-fade-in pb-28 w-full max-w-full">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Volume2 size={24} className="text-primary shrink-0" />
            <div>
              <h3 className="text-2xl font-semibold hidden md:block">语音管理中心</h3>
              <p className="text-sm text-muted-foreground">统一管理 TTS 服务商、管理员默认、我的角色音色、声音克隆和试听。</p>
            </div>
          </div>
        </div>

        <GlassCard className="p-4 sm:p-5">
          <div
            className="flex items-center justify-between cursor-pointer select-none"
            onClick={() => toggleSection('segmented_playback')}
          >
            <div>
              <h4 className="text-lg font-semibold">分段语音播放</h4>
              <p className="text-xs text-muted-foreground">
                开启后，消息中的对白（引号内容）使用角色音色，旁白使用旁白音色，分段依次播放。
              </p>
            </div>
            <ChevronDown
              size={20}
              className={cn(
                "text-muted-foreground transition-transform duration-200 shrink-0",
                collapsedSections.has('segmented_playback') && "-rotate-90"
              )}
            />
          </div>
          <div
            className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
            style={{
              maxHeight: collapsedSections.has('segmented_playback') ? '0px' : '2000px',
              opacity: collapsedSections.has('segmented_playback') ? 0 : 1,
              transform: collapsedSections.has('segmented_playback') ? 'translateY(-4px)' : 'translateY(0)',
              transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
              transitionDuration: '350ms',
            }}
          >
            <div className="mt-4">
              <div className="flex items-center justify-end">
                <label className="relative inline-flex items-center cursor-pointer" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={management.segmented_playback}
                    onChange={async (e) => {
                      try {
                        await api.tts.saveConfig({ segmented_playback: e.target.checked });
                        ttsService.segmentedPlayback = e.target.checked;
                        await fetchTtsData();
                        toast.success(e.target.checked ? '已开启分段语音播放' : '已关闭分段语音播放');
                      } catch (error: unknown) {
                        const message = error instanceof Error ? error.message : '保存失败';
                        toast.error(message);
                      }
                    }}
                  />
                  <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                </label>
              </div>
            </div>
          </div>
        </GlassCard>

        <GlassCard className="p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => toggleSection('providers')}
            >
              <h4 className="text-lg font-semibold">TTS 服务商</h4>
              <ChevronDown
                size={20}
                className={cn(
                  "text-muted-foreground transition-transform duration-200",
                  collapsedSections.has('providers') && "-rotate-90"
                )}
              />
            </div>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setEditingProvider(createNewProvider())}>
                <Plus size={14} className="mr-1" /> 添加服务商
              </Button>
            )}
          </div>
          <div
            className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
            style={{
              maxHeight: collapsedSections.has('providers') ? '0px' : '2000px',
              opacity: collapsedSections.has('providers') ? 0 : 1,
              transform: collapsedSections.has('providers') ? 'translateY(-4px)' : 'translateY(0)',
              transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
              transitionDuration: '350ms',
            }}
          >
            <div className="mt-4 space-y-3">
              {management.providers.map(provider => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  isActive={management.active_provider_id === provider.id}
                  isAdmin={isAdmin}
                  builtinConfigEdits={builtinConfigEdits}
                  onEditConfig={(providerId, key, value) => setBuiltinConfigEdits(prev => ({
                    ...prev,
                    [providerId]: { ...(prev[providerId] || {}), [key]: value },
                  }))}
                  onSaveConfig={saveProviderConfig}
                  onSwitch={switchProvider}
                  onManageCloneSamples={scrollToCloneSamples}
                  onEditProvider={setEditingProvider}
                  onDeleteProvider={async providerId => {
                    await api.tts.deleteProvider(providerId);
                    await fetchTtsData();
                    toast.success('已删除');
                  }}
                  onFetchVoices={fetchVoices}
                  onPrefetchVoices={prefetchVoices}
                  prefetchingVoices={prefetchingVoices.has(provider.id)}
                  cachedVoiceAudios={cachedVoiceAudios}
                  onPlayCached={playCachedVoice}
                />
              ))}
            </div>
          </div>
        </GlassCard>

        {isAdmin && (
          <GlassCard className="p-4 sm:p-5">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => toggleSection('admin_bindings')}
            >
              <h4 className="text-lg font-semibold">管理员默认绑定</h4>
              <ChevronDown
                size={20}
                className={cn(
                  "text-muted-foreground transition-transform duration-200",
                  collapsedSections.has('admin_bindings') && "-rotate-90"
                )}
              />
            </div>
            <div
              className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
              style={{
                maxHeight: collapsedSections.has('admin_bindings') ? '0px' : '2000px',
                opacity: collapsedSections.has('admin_bindings') ? 0 : 1,
                transform: collapsedSections.has('admin_bindings') ? 'translateY(-4px)' : 'translateY(0)',
                transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
                transitionDuration: '350ms',
              }}
            >
              <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
                {(['character', 'narrator'] as TTSRole[]).map(role => (
                  <VoiceBindingCard
                    key={role}
                    title={`默认${ROLE_LABELS[role]}`}
                    description="所有未自定义的用户会继承这个默认声音。"
                    role={role}
                    currentKey={getVoiceKey(management.global_bindings[role])}
                    voices={management.voices}
                    cloneSamples={[]}
                    allowInherit={false}
                    allowClone={false}
                    onSave={voiceKey => saveRoleBinding('global', role, voiceKey)}
                    onPreview={voiceKey => previewRole(role, voiceKey)}
                  />
                ))}
              </div>
            </div>
          </GlassCard>
        )}

        <GlassCard className="p-4 sm:p-5">
          <div
            className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => toggleSection('my_bindings')}
          >
            <h4 className="text-lg font-semibold">我的语音绑定</h4>
            <ChevronDown
              size={20}
              className={cn(
                "text-muted-foreground transition-transform duration-200",
                collapsedSections.has('my_bindings') && "-rotate-90"
              )}
            />
          </div>
          <div
            className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
            style={{
              maxHeight: collapsedSections.has('my_bindings') ? '0px' : '2000px',
              opacity: collapsedSections.has('my_bindings') ? 0 : 1,
              transform: collapsedSections.has('my_bindings') ? 'translateY(-4px)' : 'translateY(0)',
              transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
              transitionDuration: '350ms',
            }}
          >
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
              {(['character', 'narrator'] as TTSRole[]).map(role => (
                <VoiceBindingCard
                  key={role}
                  title={`我的默认${ROLE_LABELS[role]}`}
                  description={`当前解析：${getResolvedText(management.my_bindings[role])}`}
                  role={role}
                  currentKey={getVoiceKey(management.my_bindings[role])}
                  voices={management.voices}
                  cloneSamples={management.clone_samples}
                  allowInherit
                  allowClone={providerSupportsClone(activeProvider)}
                  onSave={voiceKey => saveRoleBinding('user', role, voiceKey)}
                  onPreview={voiceKey => previewRole(role, voiceKey)}
                />
              ))}
            </div>
          </div>
        </GlassCard>

        <GlassCard className="p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => toggleSection('character_bindings')}
            >
              <div>
                <h4 className="text-lg font-semibold">角色语音绑定</h4>
                <p className="text-xs text-muted-foreground">为你自己的具体角色覆盖默认对白声音。</p>
              </div>
              <ChevronDown
                size={20}
                className={cn(
                  "text-muted-foreground transition-transform duration-200 shrink-0",
                  collapsedSections.has('character_bindings') && "-rotate-90"
                )}
              />
            </div>
            <select
              value={selectedCharacterId}
              onChange={event => setSelectedCharacterId(event.target.value)}
              className="px-3 py-2 rounded-md border border-border bg-background text-sm"
              onClick={e => e.stopPropagation()}
            >
              <option value="">选择角色</option>
              {characters.map(character => (
                <option key={character.id} value={character.id}>{character.name}</option>
              ))}
            </select>
          </div>
          <div
            className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
            style={{
              maxHeight: collapsedSections.has('character_bindings') ? '0px' : '2000px',
              opacity: collapsedSections.has('character_bindings') ? 0 : 1,
              transform: collapsedSections.has('character_bindings') ? 'translateY(-4px)' : 'translateY(0)',
              transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
              transitionDuration: '350ms',
            }}
          >
            <div className="mt-4">
              {selectedCharacterId && characterBindings ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {(['character', 'narrator'] as TTSRole[]).map(role => (
                    <VoiceBindingCard
                      key={role}
                      title={`该角色${ROLE_LABELS[role]}`}
                      description={`当前解析：${getResolvedText(characterBindings[role])}`}
                      role={role}
                      currentKey={getVoiceKey(characterBindings[role])}
                      voices={management.voices}
                      cloneSamples={management.clone_samples}
                      allowInherit
                      allowClone={providerSupportsClone(activeProvider)}
                      onSave={voiceKey => saveRoleBinding('character', role, voiceKey)}
                      onPreview={voiceKey => previewRole(role, voiceKey, selectedCharacterId)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground py-4">请选择一个角色来设置专属语音。</div>
              )}
            </div>
          </div>
        </GlassCard>

        <div ref={cloneSamplesSectionRef} className="scroll-mt-24">
          <GlassCard className="p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => toggleSection('clone_samples')}
            >
              <div>
                <h4 className="text-lg font-semibold">MIMO 声音克隆样本</h4>
                <p className="text-xs text-muted-foreground">
                  {isMimoActive ? '当前小米 MIMO 已启用，可上传样本并绑定为克隆音色。' : '音色克隆当前仅支持小米 MIMO，请先启用小米 MIMO 服务商。'}
                </p>
              </div>
              <ChevronDown
                size={20}
                className={cn(
                  "text-muted-foreground transition-transform duration-200 shrink-0",
                  collapsedSections.has('clone_samples') && "-rotate-90"
                )}
              />
            </div>
            {mimoProvider && !isMimoActive && isAdmin && (
              <Button size="sm" variant="outline" onClick={() => switchProvider(mimoProvider.id)}>
                启用小米 MIMO
              </Button>
            )}
          </div>
          <div
            className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
            style={{
              maxHeight: collapsedSections.has('clone_samples') ? '0px' : '2000px',
              opacity: collapsedSections.has('clone_samples') ? 0 : 1,
              transform: collapsedSections.has('clone_samples') ? 'translateY(-4px)' : 'translateY(0)',
              transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
              transitionDuration: '350ms',
            }}
          >
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-4">
              <div className="space-y-3 p-3 rounded-lg border border-border/50">
                <Input value={uploadName} onChange={event => setUploadName(event.target.value)} placeholder="样本名称，例如：林月声音" />
                <Input type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg" onChange={event => setUploadFile(event.target.files?.[0] || null)} />
                <Button onClick={uploadCloneSample} disabled={uploading || !uploadFile} className="w-full">
                  <UploadCloud size={14} className="mr-1" /> {uploading ? '上传中...' : '上传 MIMO 克隆样本'}
                </Button>
                <p className="text-xs text-muted-foreground">用户上传的样本只属于自己。绑定克隆音色后，后端会在每次小米 MIMO voiceclone 合成时自动附带样本。</p>
                {!isMimoActive && <p className="text-xs text-amber-600 dark:text-amber-400">上传后仍需启用小米 MIMO，才能在绑定中选择克隆音色并试听。</p>}
              </div>
              <div className="space-y-2">
                {management.clone_samples.length > 0 ? management.clone_samples.map(sample => (
                  <div key={sample.id} className="p-3 rounded-lg border border-border/50 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{sample.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {sample.filename} · {(sample.file_size / 1024 / 1024).toFixed(2)} MB · 使用 {sample.usage_count || 0} 处
                      </div>
                      <div className="text-[10px] text-muted-foreground/80">
                        服务商：{sample.provider_id || 'xiaomi_mimo'}{sample.source_voice_id ? ` · 来源音色：${sample.source_voice_id}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="outline" onClick={() => previewRole('character', `${CLONE_PREFIX}${sample.id}`)}>
                        <Volume2 size={14} className="mr-1" /> 试听
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => deleteCloneSample(sample.id)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground py-6 text-center">还没有上传声音样本。</div>
                )}
              </div>
            </div>
          </div>
          </GlassCard>
        </div>

        <GlassCard className="p-4 sm:p-5">
          <div
            className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => toggleSection('voice_catalog')}
          >
            <h4 className="text-lg font-semibold">音色目录与试听</h4>
            <ChevronDown
              size={20}
              className={cn(
                "text-muted-foreground transition-transform duration-200",
                collapsedSections.has('voice_catalog') && "-rotate-90"
              )}
            />
          </div>
          <div
            className="overflow-hidden will-change-[max-height,opacity] transition-[max-height,opacity,transform]"
            style={{
              maxHeight: collapsedSections.has('voice_catalog') ? '0px' : '2000px',
              opacity: collapsedSections.has('voice_catalog') ? 0 : 1,
              transform: collapsedSections.has('voice_catalog') ? 'translateY(-4px)' : 'translateY(0)',
              transitionTimingFunction: 'cubic-bezier(0.22, 0.85, 0.24, 1)',
              transitionDuration: '350ms',
            }}
          >
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              {management.voices.map(voice => (
                <VoiceCatalogCard
                  key={voice.voice_id}
                  voice={voice}
                  onPreview={() => previewRole('character', voice.voice_id)}
                />
              ))}
            </div>
          </div>
        </GlassCard>
      </div>

      {editingProvider && createPortal(
        <ProviderEditor
          provider={editingProvider}
          existingProviders={management.providers}
          onChange={setEditingProvider}
          onClose={() => setEditingProvider(null)}
          onSaved={async provider => {
            const isEdit = management.providers.some(item => item.id === provider.id);
            const providerPayload = provider as unknown as Record<string, unknown>;
            if (isEdit) {
              await api.tts.updateProvider(provider.id, providerPayload);
            } else {
              await api.tts.addProvider(providerPayload);
            }
            setEditingProvider(null);
            await fetchTtsData();
            const isThirdParty = provider.engine_type === 'custom_api' || provider.engine_type === 'xiaomi_mimo';
            if (isThirdParty) {
              await fetchVoices(provider.id);
            }
            toast.success(isEdit ? '已更新' : '已添加');
          }}
          onFetchVoices={fetchVoices}
        />,
        document.body,
      )}
    </>
  );
}

function buildBindingPayload(
  role: TTSRole,
  voiceKey: string,
  providerId: string,
  provider: TTSProvider | undefined,
  cloneSamples: TTSCloneSample[],
  allowClone: boolean,
): TTSBindingPayload {
  if (voiceKey === INHERIT_SENTINEL) {
    return { role, inherit: true };
  }
  if (voiceKey.startsWith(CLONE_PREFIX) && allowClone) {
    const cloneSampleId = voiceKey.slice(CLONE_PREFIX.length);
    const sample = cloneSamples.find(item => item.id === cloneSampleId);
    return {
      role,
      provider_id: sample?.provider_id || providerId,
      clone_sample_id: cloneSampleId,
      gender: 'female',
      enabled: true,
    };
  }
  const voice = provider?.voices?.find(item => item.voice_id === voiceKey);
  return {
    role,
    provider_id: providerId,
    voice_id: voiceKey,
    gender: voice?.gender || 'female',
    enabled: true,
  };
}

function createNewProvider(): EditingProvider {
  return {
    id: '',
    name: '',
    description: '',
    engine_type: 'custom_api',
    config: {},
    voices: [
      { voice_id: 'default_female', gender: 'female', description: '默认女声' },
      { voice_id: 'default_male', gender: 'male', description: '默认男声' },
    ],
  };
}

function ProviderCard({
  provider,
  isActive,
  isAdmin,
  builtinConfigEdits,
  onEditConfig,
  onSaveConfig,
  onSwitch,
  onManageCloneSamples,
  onEditProvider,
  onDeleteProvider,
  onFetchVoices,
  onPrefetchVoices,
  prefetchingVoices,
  cachedVoiceAudios,
  onPlayCached,
}: {
  provider: TTSProvider;
  isActive: boolean;
  isAdmin: boolean;
  builtinConfigEdits: Record<string, Record<string, string>>;
  onEditConfig: (providerId: string, fieldKey: string, value: string) => void;
  onSaveConfig: (providerId: string, fieldKey: string, value: string) => Promise<void>;
  onSwitch: (providerId: string) => Promise<void>;
  onManageCloneSamples: () => void;
  onEditProvider: (provider: EditingProvider) => void;
  onDeleteProvider: (providerId: string) => Promise<void>;
  onFetchVoices?: (providerId: string) => Promise<void>;
  onPrefetchVoices?: (providerId: string, providerName: string, voice?: TTSVoiceOption) => Promise<void>;
  prefetchingVoices?: boolean;
  cachedVoiceAudios?: Record<string, string>;
  onPlayCached?: (providerId: string) => void;
}) {
  const supportsClone = providerSupportsClone(provider);
  const isPrefetching = prefetchingVoices || false;
  const hasCached = cachedVoiceAudios?.[provider.id] || false;
  const isThirdParty = provider.engine_type !== 'browser' && !provider.is_builtin;

  return (
    <div className={cn('p-4 rounded-lg border-2 transition-all', isActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h5 className="font-medium">{provider.name}</h5>
            {provider.is_builtin && <span className="text-[10px] bg-blue-500/15 text-blue-500 px-1.5 py-0.5 rounded-full">内置</span>}
            {!provider.is_builtin && <span className="text-[10px] bg-amber-500/15 text-amber-500 px-1.5 py-0.5 rounded-full">自定义</span>}
            {supportsClone && <span className="text-[10px] bg-purple-500/15 text-purple-500 px-1.5 py-0.5 rounded-full">支持声音克隆</span>}
            {isActive && <span className="text-[10px] bg-green-500/15 text-green-500 px-1.5 py-0.5 rounded-full">当前使用</span>}
            {hasCached && <span className="text-[10px] bg-cyan-500/15 text-cyan-500 px-1.5 py-0.5 rounded-full">已预下载</span>}
          </div>
          <p className="text-xs text-muted-foreground">{provider.description}</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1">引擎: {provider.engine_type} · 音色: {provider.voices?.length || 0} 个</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            {!isActive && <Button size="sm" variant="outline" onClick={() => onSwitch(provider.id)}>启用</Button>}
            {!provider.is_builtin && (
              <>
                <Button size="sm" variant="ghost" onClick={() => onEditProvider(provider as EditingProvider)}><Edit3 size={14} /></Button>
                <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => onDeleteProvider(provider.id)}><Trash2 size={14} /></Button>
              </>
            )}
          </div>
        )}
      </div>
      {isAdmin && provider.is_builtin && (provider.config_fields || []).length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
          {provider.config_fields?.map(field => {
            const key = String(field.key || '');
            const type = String(field.type || 'text');
            const placeholder = String(field.placeholder || '');
            const value = builtinConfigEdits[provider.id]?.[key] ?? (type === 'password' ? '' : provider.config?.[key] || '');
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="w-20 text-muted-foreground">{String(field.label || key)}</span>
                <Input
                  type={type === 'password' ? 'password' : 'text'}
                  value={value}
                  onChange={event => onEditConfig(provider.id, key, event.target.value)}
                  placeholder={provider.config?.[key] && type === 'password' ? '已配置（留空则保持不变）' : placeholder}
                  className="h-7 text-xs flex-1"
                />
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onSaveConfig(provider.id, key, builtinConfigEdits[provider.id]?.[key] || '')}>保存</Button>
              </div>
            );
          })}
        </div>
      )}
      {isAdmin && isThirdParty && (
        <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">第三方 TTS 管理</div>
              <p className="text-xs text-muted-foreground">
                {provider.voices?.length === 0 ? '当前无音色，请点击"获取音色列表"自动拉取' : '已获取音色数量'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onFetchVoices?.(provider.id)}
                disabled={!provider.config?.api_key && !provider.config?.base_url}
                title={provider.config?.api_key || provider.config?.base_url ? '从API获取音色列表' : '请先配置API Key或地址'}
              >
                <Download size={14} className="mr-1" /> 获取音色列表
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPrefetchVoices?.(provider.id, provider.name, provider.voices?.[0])}
                disabled={isPrefetching || provider.voices?.length === 0}
                title={provider.voices && provider.voices.length > 0 ? '预下载第一个音色用于快速试听' : '请先获取音色列表'}
              >
                {isPrefetching ? <Loader2 size={14} className="animate-spin mr-1" /> : <Download size={14} className="mr-1" />}
                {isPrefetching ? '预下载中...' : '预下载试听'}
              </Button>
              {hasCached && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onPlayCached?.(provider.id)}
                  title="播放已缓存的音色"
                >
                  <Volume2 size={14} className="mr-1" /> 播放缓存
                </Button>
              )}
            </div>
          </div>
          {provider.voices && provider.voices.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {provider.voices.slice(0, 8).map(voice => (
                <span key={voice.voice_id} className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                  {voice.description || voice.voice_id}
                </span>
              ))}
              {provider.voices.length > 8 && (
                <span className="text-[10px] text-muted-foreground">+{provider.voices.length - 8} 更多</span>
              )}
            </div>
          )}
        </div>
      )}
      {supportsClone && (
        <div className="mt-3 pt-3 border-t border-border/50 rounded-lg bg-purple-500/5 p-3 space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">MIMO 声音克隆</div>
              <p className="text-xs text-muted-foreground">配置克隆模型后，上传样本即可在我的语音绑定或角色语音绑定中选择克隆音色。</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isActive && isAdmin && <Button size="sm" variant="outline" onClick={() => onSwitch(provider.id)}>启用 MIMO</Button>}
              <Button size="sm" variant="outline" onClick={onManageCloneSamples}>管理克隆样本</Button>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">默认克隆模型：mimo-v2.5-tts-voiceclone。可在上方“克隆模型”字段中覆盖。</p>
        </div>
      )}
    </div>
  );
}

function VoiceBindingCard({
  title,
  description,
  role,
  currentKey,
  voices,
  cloneSamples,
  allowInherit,
  allowClone,
  onSave,
  onPreview,
}: {
  title: string;
  description: string;
  role: TTSRole;
  currentKey: string;
  voices: TTSVoiceOption[];
  cloneSamples: TTSCloneSample[];
  allowInherit: boolean;
  allowClone: boolean;
  onSave: (voiceKey: string) => Promise<void>;
  onPreview: (voiceKey: string) => Promise<void>;
}) {
  const [voiceKey, setVoiceKey] = useState(currentKey);

  useEffect(() => {
    setVoiceKey(currentKey);
  }, [currentKey]);

  return (
    <div className="p-4 rounded-lg border border-border/60 space-y-3">
      <div>
        <div className="font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <select value={voiceKey} onChange={event => setVoiceKey(event.target.value)} className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm">
        {allowInherit && <option value={INHERIT_SENTINEL}>继承默认</option>}
        {voices.map(voice => (
          <option key={voice.voice_id} value={voice.voice_id}>{voice.description || voice.voice_id} ({voice.gender || 'unknown'})</option>
        ))}
        {allowClone && cloneSamples.map(sample => (
          <option key={sample.id} value={`${CLONE_PREFIX}${sample.id}`}>克隆：{sample.name}</option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => onPreview(voiceKey)}>
          <Volume2 size={14} className="mr-1" /> 试听
        </Button>
        <Button size="sm" onClick={() => onSave(voiceKey)}>
          <Save size={14} className="mr-1" /> 保存
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">类型：{ROLE_LABELS[role]}</p>
    </div>
  );
}

function VoiceCatalogCard({ voice, onPreview }: { voice: TTSVoiceOption; onPreview: () => Promise<void> }) {
  return (
    <div className="p-3 rounded-lg border border-border/60 flex items-center justify-between gap-3">
      <div>
        <div className="font-medium">{voice.description || voice.voice_id}</div>
        <div className="text-xs text-muted-foreground">{voice.voice_id} · {voice.gender || 'unknown'}</div>
      </div>
      <Button size="sm" variant="outline" onClick={onPreview}>
        <Volume2 size={14} className="mr-1" /> 试听
      </Button>
    </div>
  );
}

function ProviderEditor({
  provider,
  existingProviders,
  onChange,
  onClose,
  onSaved,
  onFetchVoices,
}: {
  provider: EditingProvider;
  existingProviders: TTSProvider[];
  onChange: (provider: EditingProvider) => void;
  onClose: () => void;
  onSaved: (provider: EditingProvider) => Promise<void>;
  onFetchVoices?: (providerId: string) => Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-background rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto" onClick={event => event.stopPropagation()}>
        <div className="p-5 border-b border-border/50">
          <h3 className="text-lg font-semibold">{provider.id ? '编辑' : '添加'} TTS 服务商</h3>
        </div>
        <div className="p-5 space-y-4">
          <LabeledInput label="服务商 ID" value={provider.id} disabled={!!provider.id && existingProviders.some(item => item.id === provider.id)} onChange={value => onChange({ ...provider, id: value.replace(/[^a-zA-Z0-9_]/g, '') })} placeholder="my_tts_provider" />
          <LabeledInput label="名称" value={provider.name} onChange={value => onChange({ ...provider, name: value })} placeholder="我的 TTS 服务" />
          <LabeledInput label="描述" value={provider.description || ''} onChange={value => onChange({ ...provider, description: value })} placeholder="自定义 TTS 服务" />
          <div>
            <label className="text-sm font-medium block mb-1">引擎类型</label>
            <select value={provider.engine_type} onChange={event => onChange({ ...provider, engine_type: event.target.value })} className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm">
              <option value="custom_api">自定义 API (OpenAI 兼容)</option>
              <option value="xiaomi_mimo">小米 MIMO</option>
              <option value="browser">浏览器内置</option>
            </select>
          </div>
          {(provider.engine_type === 'custom_api' || provider.engine_type === 'xiaomi_mimo') && (
            <div className="space-y-3 p-3 rounded-lg bg-muted/30">
              {provider.engine_type === 'custom_api' && (
                <LabeledInput label="API 地址 *" value={provider.config?.base_url || ''} onChange={value => onChange({ ...provider, config: { ...provider.config, base_url: value } })} placeholder="https://api.example.com/v1/audio/speech" />
              )}
              <LabeledInput label="API Key" type="password" value={provider.config?.api_key || ''} onChange={value => onChange({ ...provider, config: { ...provider.config, api_key: value } })} placeholder="可选" />
              <LabeledInput label="模型名称" value={provider.config?.model || ''} onChange={value => onChange({ ...provider, config: { ...provider.config, model: value } })} placeholder={provider.engine_type === 'xiaomi_mimo' ? 'mimo-v2.5-tts' : 'tts-1'} />
              {provider.engine_type === 'xiaomi_mimo' && (
                <LabeledInput label="克隆模型" value={provider.config?.voiceclone_model || ''} onChange={value => onChange({ ...provider, config: { ...provider.config, voiceclone_model: value } })} placeholder="mimo-v2.5-tts-voiceclone" />
              )}
            </div>
          )}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">语音列表</label>
              <Button size="sm" variant="outline" onClick={() => onChange({ ...provider, voices: [...(provider.voices || []), { voice_id: `voice_${(provider.voices || []).length + 1}`, gender: 'female', description: '新语音' }] })}>
                <Plus size={12} className="mr-1" /> 添加语音
              </Button>
            </div>
            {(provider.voices || []).map((voice, index) => (
              <div key={`${voice.voice_id}-${index}`} className="grid grid-cols-[1fr_90px_1fr_auto] gap-2">
                <Input value={voice.voice_id} onChange={event => updateVoice(provider, index, { voice_id: event.target.value }, onChange)} className="h-8 text-xs" />
                <select value={voice.gender || 'female'} onChange={event => updateVoice(provider, index, { gender: event.target.value }, onChange)} className="h-8 px-2 rounded border border-border bg-background text-xs">
                  <option value="female">女声</option>
                  <option value="male">男声</option>
                </select>
                <Input value={voice.description || ''} onChange={event => updateVoice(provider, index, { description: event.target.value }, onChange)} className="h-8 text-xs" />
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => onChange({ ...provider, voices: (provider.voices || []).filter((_, itemIndex) => itemIndex !== index) })}>
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <div className="p-5 border-t border-border/50 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={async () => {
            await onSaved(provider);
            const isThirdParty = provider.engine_type === 'custom_api' || provider.engine_type === 'xiaomi_mimo';
            if (isThirdParty && onFetchVoices) {
              await onFetchVoices(provider.id);
            }
          }}>
            <Save size={14} className="mr-1" /> 保存
          </Button>
        </div>
      </div>
    </div>
  );
}

function updateVoice(provider: EditingProvider, index: number, patch: Partial<TTSVoiceOption>, onChange: (provider: EditingProvider) => void): void {
  const voices = [...(provider.voices || [])];
  voices[index] = { ...voices[index], ...patch };
  onChange({ ...provider, voices });
}

function LabeledInput({ label, value, onChange, placeholder, type = 'text', disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="text-sm font-medium block mb-1">{label}</label>
      <Input type={type} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />
    </div>
  );
}
