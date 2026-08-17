import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { appendUploadToken } from '@/lib/uploadUrls';
import { api } from '@/services/api';
import type { ImageGenerationConfig, ImageGenerationProvider } from '@/types/imageGeneration';

interface ImageGenerationManagementTabProps {
  isAdmin: boolean;
}

const DEFAULT_PROMPT_TEMPLATE = `Create an illustration for the following roleplay/chat moment.
Focus on visible scene, characters, actions, mood, clothing, environment, lighting, and composition.
Do not include text bubbles, UI elements, captions, or watermarks.

Dialogue context:
{{context}}

Target moment:
{{message}}`;

function createDefaultConfig(): ImageGenerationConfig {
  return {
    enabled: false,
    active_provider_id: 'openai_compatible',
    can_admin: false,
    providers: [
      {
        id: 'openai_compatible',
        name: 'OpenAI Compatible',
        type: 'openai_compatible',
        enabled: true,
        base_url: '',
        api_key: '',
        model: '',
        size: '1024x1024',
        quality: '',
        style: '',
        response_format: 'auto',
        timeout_seconds: 120,
      },
    ],
    defaults: {
      prompt_template: DEFAULT_PROMPT_TEMPLATE,
      include_recent_context_count: 4,
    },
  };
}

function updateProvider(provider: ImageGenerationProvider, patch: Partial<ImageGenerationProvider>): ImageGenerationProvider {
  return { ...provider, ...patch };
}

export function ImageGenerationManagementTab({ isAdmin }: ImageGenerationManagementTabProps) {
  const [config, setConfig] = useState<ImageGenerationConfig>(() => createDefaultConfig());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testPrompt, setTestPrompt] = useState('一位角色站在雨夜霓虹街道上，神情坚定，电影感构图');
  const [testing, setTesting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');

  const activeProvider = useMemo(() => {
    return config.providers.find(provider => provider.id === config.active_provider_id) || config.providers[0];
  }, [config.active_provider_id, config.providers]);

  const canEdit = isAdmin && config.can_admin !== false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.imageGeneration.getConfig();
      setConfig({ ...createDefaultConfig(), ...data });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '加载图像生成设置失败';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const setActiveProvider = (patch: Partial<ImageGenerationProvider>) => {
    if (!activeProvider) return;
    setConfig(prev => ({
      ...prev,
      providers: prev.providers.map(provider => (
        provider.id === activeProvider.id ? updateProvider(provider, patch) : provider
      )),
    }));
  };

  const saveConfig = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const saved = await api.imageGeneration.updateConfig(config);
      setConfig({ ...createDefaultConfig(), ...saved });
      toast.success('图像生成设置已保存');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '保存图像生成设置失败';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!testPrompt.trim()) {
      toast.error('请输入测试提示词');
      return;
    }
    setTesting(true);
    try {
      const result = await api.imageGeneration.test(testPrompt.trim());
      setPreviewUrl(result.image.image_url);
      toast.success('测试图片已生成');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '测试生成失败';
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">正在加载图像生成设置...</div>;
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="space-y-6 p-4 sm:p-6 animate-fade-in">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2 hidden md:flex">
            <Image size={24} />
            图像生成
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            配置角色扮演和聊天中的文字生成图片服务，支持 OpenAI-compatible /v1/images/generations 接口。
          </p>
        </div>

        {!canEdit && (
          <GlassCard className="p-4 text-sm text-muted-foreground">
            只有管理员可以修改图像生成服务配置。普通用户可以在聊天中使用已启用的服务。
          </GlassCard>
        )}

        <GlassCard className="p-5 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold">启用图像生成</h3>
              <p className="text-xs text-muted-foreground">关闭后，手动生成和自动生成都会不可用。</p>
            </div>
            <Switch
              checked={config.enabled}
              disabled={!canEdit}
              onCheckedChange={(checked) => setConfig(prev => ({ ...prev, enabled: checked }))}
            />
          </div>

          {activeProvider && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Base URL</span>
                <Input
                  value={activeProvider.base_url}
                  disabled={!canEdit}
                  placeholder="https://api.example.com"
                  onChange={(event) => setActiveProvider({ base_url: event.target.value })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">API Key</span>
                <Input
                  type="password"
                  value={activeProvider.api_key}
                  disabled={!canEdit}
                  placeholder="保存后会自动掩码"
                  onChange={(event) => setActiveProvider({ api_key: event.target.value })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">模型</span>
                <Input
                  value={activeProvider.model}
                  disabled={!canEdit}
                  placeholder="gpt-image-1 / dall-e-3 / provider-model"
                  onChange={(event) => setActiveProvider({ model: event.target.value })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">尺寸</span>
                <Input
                  value={activeProvider.size}
                  disabled={!canEdit}
                  placeholder="1024x1024"
                  onChange={(event) => setActiveProvider({ size: event.target.value })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Quality（可选）</span>
                <Input
                  value={activeProvider.quality || ''}
                  disabled={!canEdit}
                  placeholder="standard / hd / auto"
                  onChange={(event) => setActiveProvider({ quality: event.target.value })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">响应格式</span>
                <select
                  value={activeProvider.response_format || 'auto'}
                  disabled={!canEdit}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  onChange={(event) => setActiveProvider({ response_format: event.target.value as ImageGenerationProvider['response_format'] })}
                >
                  <option value="auto">Auto</option>
                  <option value="b64_json">Base64 JSON</option>
                  <option value="url">URL</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">超时秒数</span>
                <Input
                  type="number"
                  min={5}
                  max={600}
                  value={activeProvider.timeout_seconds}
                  disabled={!canEdit}
                  onChange={(event) => setActiveProvider({ timeout_seconds: Number(event.target.value) || 120 })}
                />
              </label>
            </div>
          )}

          <label className="space-y-1.5 block">
            <span className="text-sm font-medium">图片提示词模板</span>
            <textarea
              className="w-full min-h-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={config.defaults.prompt_template}
              disabled={!canEdit}
              onChange={(event) => setConfig(prev => ({
                ...prev,
                defaults: { ...prev.defaults, prompt_template: event.target.value },
              }))}
            />
            <span className="text-xs text-muted-foreground">可使用 {'{{context}}'} 和 {'{{message}}'} 占位符。</span>
          </label>

          <label className="space-y-1.5 block max-w-xs">
            <span className="text-sm font-medium">上下文消息条数</span>
            <Input
              type="number"
              min={0}
              max={20}
              value={config.defaults.include_recent_context_count}
              disabled={!canEdit}
              onChange={(event) => setConfig(prev => ({
                ...prev,
                defaults: { ...prev.defaults, include_recent_context_count: Number(event.target.value) || 0 },
              }))}
            />
          </label>

          {canEdit && (
            <Button onClick={saveConfig} disabled={saving} className="gap-2">
              <Save size={16} />
              {saving ? '保存中...' : '保存设置'}
            </Button>
          )}
        </GlassCard>

        <GlassCard className="p-5 space-y-4">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles size={18} />
              测试生成
            </h3>
            <p className="text-xs text-muted-foreground">用当前配置生成一张预览图，图片会保存到你的上传目录。</p>
          </div>
          <textarea
            className="w-full min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={testPrompt}
            onChange={(event) => setTestPrompt(event.target.value)}
          />
          <Button onClick={runTest} disabled={testing || !config.enabled} className="gap-2">
            <Sparkles size={16} />
            {testing ? '生成中...' : '生成测试图片'}
          </Button>
          {previewUrl && (
            <img src={appendUploadToken(previewUrl)} alt="图像生成预览" className="max-w-full max-h-96 rounded-xl border object-contain" />
          )}
        </GlassCard>
      </div>
    </div>
  );
}
