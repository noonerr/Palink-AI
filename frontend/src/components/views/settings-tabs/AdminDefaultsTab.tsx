import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  Sparkles,
  Save,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsRow } from './settings-ui';
import type { Model } from '@/types';

interface AdminDefaultsTabProps {
  t: Record<string, string>;
  systemDefaults: any;
  models: Model[];
  onUpdateDefaults: () => void;
  bottomPadding: string;
}

export function AdminDefaultsTab({
  t,
  systemDefaults,
  models,
  onUpdateDefaults,
  bottomPadding
}: AdminDefaultsTabProps) {
  // Admin defaults state
  const [defChat, setDefChat] = useState(systemDefaults.default_chat_model || '');
  const [defWs, setDefWs] = useState(systemDefaults.default_workspace_model || '');
  const [defOutline, setDefOutline] = useState(systemDefaults.default_outline_model || '');
  const [dailyTopicModel, setDailyTopicModel] = useState(systemDefaults.daily_topic_model || '');
  const [defCharacterParse, setDefCharacterParse] = useState(systemDefaults.default_character_parse_model || '');
  const [defCharacterTranslate, setDefCharacterTranslate] = useState(systemDefaults.default_character_translate_model || '');
  const [defCharacterChat, setDefCharacterChat] = useState(systemDefaults.default_character_chat_model || '');
  const [defSummarization, setDefSummarization] = useState(systemDefaults.default_summarization_model || '');
  const [defOCAnalysis, setDefOCAnalysis] = useState(systemDefaults.default_oc_analysis_model || '');
  const [allowOCAnalysis, setAllowOCAnalysis] = useState(systemDefaults.allow_oc_analysis !== false);
  const [imageCleanupEnabled, setImageCleanupEnabled] = useState(true);
  const [imageCleanupMaxAge, setImageCleanupMaxAge] = useState(30);
  const [imageCleanupExpanded, setImageCleanupExpanded] = useState(false);

  useEffect(() => {
    fetchImageCleanupConfig();
  }, []);

  const handleSaveDefaults = async () => {
    try {
      await api.post('/api/admin/system/defaults', {
        default_chat_model: defChat,
        default_workspace_model: defWs,
        default_outline_model: defOutline,
        daily_topic_model: dailyTopicModel,
        default_character_parse_model: defCharacterParse,
        default_character_translate_model: defCharacterTranslate,
        default_character_chat_model: defCharacterChat,
        default_summarization_model: defSummarization,
        default_oc_analysis_model: defOCAnalysis,
        allow_oc_analysis: allowOCAnalysis
      });
      onUpdateDefaults();
      toast.success(t.defaults_saved || '默认配置已保存');
    } catch (e) {
      console.error('Failed to save defaults:', e);
      toast.error('保存默认配置失败');
    }
  };

  const fetchImageCleanupConfig = async () => {
    try {
      const config = await api.get('/api/admin/image-cleanup');
      setImageCleanupEnabled(config.enabled !== false);
      setImageCleanupMaxAge(config.max_age_days || 30);
    } catch (e) {
      console.error('Failed to fetch image cleanup config:', e);
    }
  };

  const handleSaveImageCleanup = async () => {
    try {
      await api.put('/api/admin/image-cleanup', {
        enabled: imageCleanupEnabled,
        max_age_days: imageCleanupMaxAge,
      });
      toast.success('图片清理配置已保存');
    } catch (e) {
      toast.error('保存图片清理配置失败');
    }
  };

  const handleRunImageCleanup = async () => {
    try {
      const result = await api.post('/api/admin/image-cleanup/run', {});
      toast.success(`清理完成：删除 ${result.deleted_count} 个文件，释放 ${result.freed_mb} MB`);
    } catch (e) {
      toast.error('执行图片清理失败');
    }
  };

  return (
    <div className={`space-y-5 animate-fade-in pr-2 ${bottomPadding}`}>

      <SettingsGroup label="默认模型">
        {[
          { label: t.def_chat_model, value: defChat, set: setDefChat },
          { label: t.def_ws_model, value: defWs, set: setDefWs },
          { label: t.def_outline_model, value: defOutline, set: setDefOutline },
          { label: '解析/翻译人物卡默认模型', value: defCharacterParse, set: setDefCharacterParse },
          { label: '人物卡翻译默认模型', value: defCharacterTranslate, set: setDefCharacterTranslate },
          { label: '角色扮演默认模型', value: defCharacterChat, set: setDefCharacterChat },
          { label: '摘要生成默认模型', value: defSummarization, set: setDefSummarization }
        ].map((item, i) => (
          <SettingsRow key={i} icon={<Bot size={15} />} title={item.label}>
            <ModelSelector
              models={models}
              currentModel={item.value}
              onSelect={(modelId: string) => item.set(modelId)}
              size="sm"
            />
          </SettingsRow>
        ))}
        <SettingsRow icon={<Sparkles size={15} />} title="允许AI分析用户个人OC卡">
          <Switch
            checked={allowOCAnalysis}
            onCheckedChange={setAllowOCAnalysis}
          />
        </SettingsRow>
        {allowOCAnalysis && (
          <SettingsRow icon={<Bot size={15} />} title="OC分析默认模型">
            <ModelSelector
              models={models}
              currentModel={defOCAnalysis}
              onSelect={setDefOCAnalysis}
              size="sm"
            />
          </SettingsRow>
        )}
        <div className="flex justify-end px-4 py-3">
          <Button onClick={handleSaveDefaults} className="h-8 md:h-9 rounded-md px-3 text-xs">
            <Save size={14} className="mr-1.5" />
            {t.save}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="维护">
        <SettingsRow
          icon={<Trash2 size={15} />}
          title="图片过期清理"
          onClick={() => setImageCleanupExpanded(!imageCleanupExpanded)}
        >
          <ChevronDown
            size={16}
            className={cn(
              "text-muted-foreground/60 transition-transform duration-300 shrink-0",
              imageCleanupExpanded && "rotate-180"
            )}
          />
        </SettingsRow>

        {imageCleanupExpanded && (
          <div className="px-4 py-3 space-y-1 border-t border-border/40 bg-secondary/20 animate-in slide-in-from-top-2 fade-in duration-300">
            <SettingsRow title="启用自动清理">
              <Switch
                checked={imageCleanupEnabled}
                onCheckedChange={setImageCleanupEnabled}
              />
            </SettingsRow>
            <SettingsRow title="过期天数">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={imageCleanupMaxAge}
                  onChange={e => setImageCleanupMaxAge(Math.max(1, Math.min(365, parseInt(e.target.value) || 30)))}
                  className="w-20 px-3 py-1.5 rounded-lg bg-secondary border-none outline-none text-center text-sm touch-input"
                />
                <span className="text-sm text-muted-foreground">天</span>
              </div>
            </SettingsRow>
            <SettingsRow title="立即执行清理">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRunImageCleanup}
                className="h-8 md:h-9 rounded-md px-3 text-xs"
              >
                <Trash2 size={14} className="mr-1.5" />
                执行清理
              </Button>
            </SettingsRow>
            <div className="flex justify-end pt-2">
              <Button onClick={handleSaveImageCleanup} className="h-8 md:h-9 rounded-md px-3 text-xs">
                <Save size={14} className="mr-1.5" />
                {t.save}
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
