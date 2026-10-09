import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Sun,
  Moon,
  Sparkles,
  Zap,
  Database,
  Image,
  Bot,
} from 'lucide-react';
import { api, invalidateCache } from '@/services/api';
import { getSmartCardAssetMode, setSmartCardAssetMode } from '@/components/ui/custom/smart-card-runtime/asset-mode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { Switch } from '@/components/ui/switch';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { SettingsGroup, SettingsRow, SettingsRowWide, Segmented } from './settings-ui';
import type { Theme, Model } from '@/types';

interface AppearanceTabProps {
  t: Record<string, string>;
  isDark?: boolean;
  themeMode?: Theme;
  onThemeSet?: (mode: Theme) => void;
  lang?: string;
  onLangToggle?: () => void;
  models: Model[];
  bottomPadding: string;
}

export function AppearanceTab({
  t,
  isDark,
  themeMode,
  onThemeSet,
  lang,
  onLangToggle,
  models,
  bottomPadding
}: AppearanceTabProps) {
  const [autoContrast, setAutoContrast] = useState<boolean>(true);
  // AI 消息头像展示开关（通用聊天与角色扮演共用；localStorage 持久化，Message 实时读取）
  const [showCharacterAvatar, setShowCharacterAvatar] = useState<boolean>(true);
  // 智能卡第三方资源加载模式（localStorage 持久化；默认 direct 用户直连，
  // 开启 = proxy 服务器中转；CharacterCardRenderer 监听事件实时重建）
  const [smartCardAssetProxy, setSmartCardAssetProxy] = useState<boolean>(
    () => getSmartCardAssetMode() === 'proxy'
  );
  const [showModelReasoning, setShowModelReasoning] = useState<boolean>(true);
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  // 分层记忆 Phase 1：记忆区注入预算档位（0=紧凑750/1=标准4000/2=加量6000/3=尽量多8000）
  // 〔2026-10-10 订正〕档位表 2026-10-09 由 (750,1500,3000,6000) 重定为 (750,4000,6000,8000)。
  // 档位号语义不变，前端只透传 level，无逻辑改动。
  const [memoryBudgetLevel, setMemoryBudgetLevel] = useState<number>(1);
  const [promptLanguage, setPromptLanguage] = useState<string>('auto');
  // MVU 副 AI 变量更新（2026-08-19）：主模型未输出变量块时用副模型补
  const [mvuSecondaryEnabled, setMvuSecondaryEnabled] = useState<boolean>(false);
  const [mvuSecondaryModel, setMvuSecondaryModel] = useState<string>('');

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
        setMemoryMode(settings.memory_mode || 'vector');
        setMemoryBudgetLevel(typeof settings.memory_budget_level === 'number' ? settings.memory_budget_level : 1);
        setShowModelReasoning(settings.show_model_reasoning !== false);
        setPromptLanguage(settings.prompt_language || 'auto');
        setMvuSecondaryEnabled(settings.mvu_secondary_enabled === true);
        setMvuSecondaryModel(settings.mvu_secondary_model || '');
      } catch (e) {
        console.error('Failed to fetch memory mode:', e);
      }
    };
    fetchSettings();
  }, []);

  useEffect(() => {
    try {
      setAutoContrast(localStorage.getItem('palink-auto-contrast') !== '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      setShowCharacterAvatar(localStorage.getItem('palink-rp-character-avatar') !== '0');
    } catch {
      /* ignore */
    }
  }, []);

  const handleToggleAutoContrast = (checked: boolean) => {
    setAutoContrast(checked);
    try {
      localStorage.setItem('palink-auto-contrast', checked ? '1' : '0');
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent('palink-auto-contrast-changed', { detail: { enabled: checked } }));
  };

  const handleToggleCharacterAvatar = (checked: boolean) => {
    setShowCharacterAvatar(checked);
    try {
      localStorage.setItem('palink-rp-character-avatar', checked ? '1' : '0');
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent('palink-rp-character-avatar-changed', { detail: { enabled: checked } }));
  };

  const handleToggleSmartCardAssetProxy = (checked: boolean) => {
    setSmartCardAssetProxy(checked);
    setSmartCardAssetMode(checked ? 'proxy' : 'direct');
  };

  const handleSaveMemoryMode = async (newMode: string) => {
    try {
      await api.put('/api/users/me/settings', { memory_mode: newMode });
      invalidateCache('/api/users/me/settings');
      setMemoryMode(newMode);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
    } catch (e) {
      console.error('Failed to save memory mode:', e);
      toast.error('保存记忆模式失败');
    }
  };

  // 分层记忆 Phase 1：记忆区注入档位切换（即时保存，模式对齐 handleSaveMemoryMode）
  const handleSaveMemoryBudgetLevel = async (level: number) => {
    try {
      await api.put('/api/users/me/settings', { memory_budget_level: level });
      invalidateCache('/api/users/me/settings');
      setMemoryBudgetLevel(level);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
    } catch (e) {
      console.error('Failed to save memory budget level:', e);
      toast.error('保存记忆注入档位失败');
    }
  };

  // MVU 副 AI 变量更新：开关 + 副模型 ID
  const handleSaveMvuSecondary = async (patch: { mvu_secondary_enabled?: boolean; mvu_secondary_model?: string }) => {
    try {
      await api.put('/api/users/me/settings', patch);
      invalidateCache('/api/users/me/settings');
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
      toast.success('副 AI 变量更新设置已保存');
    } catch (e) {
      console.error('Failed to save MVU secondary settings:', e);
      toast.error('保存副 AI 设置失败');
    }
  };

  const handleSaveModelReasoning = async (enabled: boolean) => {
    try {
      await api.put('/api/users/me/settings', { show_model_reasoning: enabled });
      invalidateCache('/api/users/me/settings');
      setShowModelReasoning(enabled);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { showModelReasoning: enabled } }));
    } catch (e) {
      console.error('Failed to save model reasoning setting:', e);
      toast.error('保存深度思考设置失败');
    }
  };

  const handleSavePromptLanguage = async (newLang: string) => {
    try {
      await api.put('/api/users/me/settings', { prompt_language: newLang });
      invalidateCache('/api/users/me/settings');
      setPromptLanguage(newLang);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { promptLanguage: newLang } }));
    } catch (e) {
      console.error('Failed to save prompt language:', e);
      toast.error('保存提示词语言失败');
    }
  };

  return (
    <div className={`space-y-5 animate-fade-in pr-2 ${bottomPadding}`}>

      <SettingsGroup label="主题">
        <SettingsRow
          icon={isDark ? <Moon size={15} /> : <Sun size={15} />}
          title={t.theme || '主题'}
        >
          <Segmented
            value={themeMode ?? 'auto'}
            onChange={(v) => onThemeSet?.(v)}
            options={[
              { value: 'auto', label: t.theme_auto || '跟随系统' },
              { value: 'light', label: t.theme_light || '亮色' },
              { value: 'dark', label: t.theme_dark || '暗色' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          icon={<Sparkles size={15} />}
          title="亮色模式自动增强卡片对比度"
        >
          <Switch checked={autoContrast} onCheckedChange={handleToggleAutoContrast} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="角色扮演显示">
        <SettingsRow
          icon={<Image size={15} />}
          title="AI 消息头像（通用聊天 / 角色扮演）"
        >
          <Switch checked={showCharacterAvatar} onCheckedChange={handleToggleCharacterAvatar} />
        </SettingsRow>
        <SettingsRow
          icon={<Image size={15} />}
          title="智能卡图片走服务器代理"
        >
          <Switch checked={smartCardAssetProxy} onCheckedChange={handleToggleSmartCardAssetProxy} />
        </SettingsRow>
        <SettingsRow icon={<Zap size={15} />} title="模型深度思考">
          <Switch checked={showModelReasoning} onCheckedChange={handleSaveModelReasoning} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="记忆">
        <SettingsRowWide
          icon={<Database size={15} />}
          title={t.memory_mode || '记忆模式'}
        >
          <Segmented
            value={memoryMode}
            onChange={handleSaveMemoryMode}
            options={[
              { value: 'rule', label: t.memory_mode_rule || '规则记忆' },
              { value: 'vector', label: t.memory_mode_vector || '向量记忆' },
            ]}
          />
        </SettingsRowWide>
        <SettingsRowWide
          icon={<Database size={15} />}
          title={t.memory_budget || '记忆注入量'}
        >
          <Segmented
            value={memoryBudgetLevel}
            onChange={handleSaveMemoryBudgetLevel}
            options={([['紧凑', 0], ['标准', 1], ['加量', 2], ['尽量多', 3]] as [string, number][]).map(([label, lvl]) => ({ value: lvl, label }))}
          />
        </SettingsRowWide>
      </SettingsGroup>

      <SettingsGroup label="副 AI 变量更新">
        <SettingsRow
          icon={<Bot size={15} />}
          title="副 AI 变量更新"
        >
          <Switch
            checked={mvuSecondaryEnabled}
            onCheckedChange={(checked) => {
              setMvuSecondaryEnabled(checked);
              handleSaveMvuSecondary({ mvu_secondary_enabled: checked });
            }}
          />
        </SettingsRow>
        {mvuSecondaryEnabled && (
          <SettingsRow
            icon={<Bot size={15} />}
            title="副 AI 模型"
          >
            <ModelSelector
              models={models}
              currentModel={mvuSecondaryModel}
              onSelect={(modelId: string) => {
                setMvuSecondaryModel(modelId);
                handleSaveMvuSecondary({ mvu_secondary_model: modelId });
              }}
              size="sm"
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup label="语言">
        <SettingsRow
          icon={<span className="text-xs font-semibold">{lang?.toUpperCase()}</span>}
          title={t.language_setting || '语言设置'}
        >
          <Segmented
            value={promptLanguage === 'en' ? 'en' : 'zh'}
            onChange={async (v) => {
              if (v === 'zh') {
                onLangToggle?.();
                await handleSavePromptLanguage('zh');
              } else {
                if (lang !== 'en') onLangToggle?.();
                await handleSavePromptLanguage('en');
              }
            }}
            options={[
              { value: 'zh', label: t.lang_zh || '中文' },
              { value: 'en', label: t.lang_en || 'English' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
