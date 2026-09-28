/**
 * 图片生成设置（SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28）。
 *
 * 这是 `api.imageGeneration.updateConfig` 的首个消费方（此前登记为零调用方死配置，
 * 见 TODOS.md 前端图片生成设置页条目）。核心新能力：ComfyUI「执行位置」可选
 * 浏览器桥接——服务端只组装工作流，出图请求由本页访客的浏览器发往本机
 * ComfyUI（适合 Palink 部署在远端服务器、ComfyUI 在用户自己电脑上的拓扑）。
 *
 * 安全口径：连接向导给出**精确 origin** 的 CORS 启动参数，明确不建议 `*`
 * （本机服务普遍无鉴权，`*` 等于任何网站都能打）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Image as ImageIcon, RefreshCw, Save, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsRow, SettingsRowWide, Segmented } from './settings-ui';
import { api } from '@/services/api';
import { invalidateImageGenerationConfig } from '@/hooks/useImageGenerationAvailability';
import { probeComfyUI, type ComfyUIProbeResult } from '@/lib/image-gen/comfyui-client';
import type {
  ImageGenerationConfig,
  ImageGenerationExecutionMode,
  ImageGenerationProvider,
} from '@/types/imageGeneration';

const PROVIDER_LABELS: Record<string, string> = {
  openai_compatible: 'OpenAI 兼容云端',
  sd_webui: 'SD WebUI（A1111/Forge）',
  comfyui: 'ComfyUI',
};

/** 渲染期 pending 骨架 120s 收敛（message_media_service.PENDING_TIMEOUT_SECONDS），
 *  浏览器出图超过它骨架会先显示失败——向导据此建议 ≤110s。 */
const SKELETON_TIMEOUT_SECONDS = 110;

function asExecution(value: unknown): ImageGenerationExecutionMode {
  return value === 'browser' ? 'browser' : 'server';
}

export function ImageGenerationTab() {
  const [config, setConfig] = useState<ImageGenerationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [probe, setProbe] = useState<ComfyUIProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.imageGeneration.getConfig();
      setConfig(data);
      setIsAdmin(Boolean(data?.can_admin));
    } catch (error) {
      console.error('[image-gen-settings] 读取出图配置失败:', error);
      toast.error('读取出图配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const providers = useMemo(() => config?.providers ?? [], [config]);
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === config?.active_provider_id) ?? providers[0],
    [providers, config?.active_provider_id],
  );

  const patchProvider = (patch: Partial<ImageGenerationProvider>) => {
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        providers: prev.providers.map((p) => (p.id === prev.active_provider_id ? { ...p, ...patch } : p)),
      };
    });
    setProbe(null);
  };

  const handleSave = async () => {
    if (!config || !isAdmin) return;
    setSaving(true);
    try {
      const saved = await api.imageGeneration.updateConfig(config);
      setConfig(saved);
      invalidateImageGenerationConfig();
      toast.success('图片生成配置已保存');
    } catch (error) {
      console.error('[image-gen-settings] 保存失败:', error);
      toast.error(`保存失败：${(error as Error)?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleProbe = async () => {
    if (!activeProvider?.base_url) {
      setProbe({ status: 'unreachable', message: '请先填写 ComfyUI 地址' });
      return;
    }
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await probeComfyUI(activeProvider.base_url));
    } finally {
      setProbing(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">读取图片生成配置中…</div>;
  }
  if (!config) {
    return <div className="p-6 text-sm text-muted-foreground">图片生成配置不可用。</div>;
  }

  const browserMode = asExecution(activeProvider?.execution) === 'browser';
  const siteOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const corsCommand = `python main.py --enable-cors-header '${siteOrigin}'`;

  return (
    <div className="space-y-4 md:space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <ImageIcon size={18} /> 图片生成
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            支持云端 OpenAI 兼容端点、自建 SD WebUI / ComfyUI；托管部署下可让出图走用户本机算力。
          </p>
        </div>
        {isAdmin && (
          <Button onClick={handleSave} disabled={saving} size="sm">
            <Save size={14} className="mr-1" /> {saving ? '保存中…' : '保存'}
          </Button>
        )}
      </div>

      <SettingsGroup label="全局">
        <SettingsRowWide icon={<ImageIcon size={16} />} title="启用图片生成" desc="关闭后配图按钮与自动出图整体停用">
          <Switch
            checked={config.enabled}
            disabled={!isAdmin}
            onCheckedChange={(checked) => setConfig((prev) => (prev ? { ...prev, enabled: checked } : prev))}
          />
        </SettingsRowWide>
        <SettingsRowWide
          icon={<ShieldCheck size={16} />}
          title="当前服务商"
          desc="出图统一走它；各服务商的执行位置在下方分别设置"
        >
          <select
            className="text-sm rounded-md border bg-transparent px-2 py-1"
            value={config.active_provider_id}
            disabled={!isAdmin}
            onChange={(e) => setConfig((prev) => (prev ? { ...prev, active_provider_id: e.target.value } : prev))}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {PROVIDER_LABELS[p.type] ?? p.name}
              </option>
            ))}
          </select>
        </SettingsRowWide>
      </SettingsGroup>

      {activeProvider && (
        <SettingsGroup label={`服务商：${PROVIDER_LABELS[activeProvider.type] ?? activeProvider.name}`}>
          <SettingsRowWide
            icon={<ShieldCheck size={16} />}
            title="启用该服务商"
            desc="关闭后即使设为当前服务商也无法出图"
          >
            <Switch
              checked={activeProvider.enabled}
              disabled={!isAdmin}
              onCheckedChange={(checked) => patchProvider({ enabled: checked })}
            />
          </SettingsRowWide>

          {(activeProvider.type === 'comfyui' || activeProvider.type === 'sd_webui') && (
            <SettingsRowWide
              icon={<ShieldCheck size={16} />}
              title="执行位置"
              desc={
                browserMode
                  ? '浏览器桥接：Palink 服务器只下发任务，出图请求由本浏览页发往你本机的服务（适合托管部署）'
                  : '服务器直连：Palink 后端直接访问该地址（仅自托管同机部署可用）'
              }
            >
              <Segmented
                options={[
                  { value: 'server', label: '服务器' },
                  { value: 'browser', label: '用户浏览器' },
                ]}
                value={asExecution(activeProvider.execution)}
                onChange={(value) => patchProvider({ execution: value as ImageGenerationExecutionMode })}
              />
            </SettingsRowWide>
          )}

          <SettingsRow
            icon={<ShieldCheck size={16} />}
            title={browserMode ? '本机服务地址（浏览器视角）' : '服务地址'}
            desc={browserMode ? '通常保持 http://127.0.0.1:8188' : 'Palink 服务器可达的地址'}
          >
            <Input
              className="w-56"
              value={activeProvider.base_url}
              disabled={!isAdmin}
              placeholder="http://127.0.0.1:8188"
              onChange={(e) => patchProvider({ base_url: e.target.value })}
            />
          </SettingsRow>

          {activeProvider.type === 'openai_compatible' && (
            <>
              <SettingsRow icon={<ShieldCheck size={16} />} title="API Key" desc="云端端点必填">
                <Input
                  className="w-56"
                  type="password"
                  value={activeProvider.api_key}
                  disabled={!isAdmin}
                  onChange={(e) => patchProvider({ api_key: e.target.value })}
                />
              </SettingsRow>
              <SettingsRow icon={<ShieldCheck size={16} />} title="模型名" desc="如 gpt-image-1">
                <Input
                  className="w-56"
                  value={activeProvider.model}
                  disabled={!isAdmin}
                  onChange={(e) => patchProvider({ model: e.target.value })}
                />
              </SettingsRow>
            </>
          )}

          <SettingsRow icon={<ShieldCheck size={16} />} title="尺寸" desc="宽x高，如 1024x1024">
            <Input
              className="w-32"
              value={activeProvider.size}
              disabled={!isAdmin}
              onChange={(e) => patchProvider({ size: e.target.value })}
            />
          </SettingsRow>
          <SettingsRow
            icon={<ShieldCheck size={16} />}
            title="超时（秒）"
            desc={browserMode ? `浏览器桥接建议 ≤${SKELETON_TIMEOUT_SECONDS}，超时前消息骨架会先显示失败` : '最长 600'}
          >
            <Input
              className="w-24"
              type="number"
              min={5}
              max={600}
              value={activeProvider.timeout_seconds}
              disabled={!isAdmin}
              onChange={(e) => patchProvider({ timeout_seconds: Number(e.target.value) || 120 })}
            />
          </SettingsRow>
          {(activeProvider.type === 'sd_webui' || activeProvider.type === 'comfyui') && (
            <>
              <SettingsRow icon={<ShieldCheck size={16} />} title="负面提示词" desc="不希望出现的元素">
                <Input
                  className="w-56"
                  value={activeProvider.negative_prompt ?? ''}
                  disabled={!isAdmin}
                  onChange={(e) => patchProvider({ negative_prompt: e.target.value })}
                />
              </SettingsRow>
              <SettingsRow icon={<ShieldCheck size={16} />} title="步数 / CFG" desc="步数 1-150，CFG 0-30">
                <div className="flex gap-2">
                  <Input
                    className="w-20"
                    type="number"
                    min={1}
                    max={150}
                    value={activeProvider.steps ?? 20}
                    disabled={!isAdmin}
                    onChange={(e) => patchProvider({ steps: Number(e.target.value) || 20 })}
                  />
                  <Input
                    className="w-20"
                    type="number"
                    min={0}
                    max={30}
                    step={0.5}
                    value={activeProvider.cfg_scale ?? 7}
                    disabled={!isAdmin}
                    onChange={(e) => patchProvider({ cfg_scale: Number(e.target.value) || 7 })}
                  />
                </div>
              </SettingsRow>
              <SettingsRow icon={<ShieldCheck size={16} />} title="Seed" desc="-1 = 随机">
                <Input
                  className="w-24"
                  type="number"
                  value={activeProvider.seed ?? -1}
                  disabled={!isAdmin}
                  onChange={(e) => patchProvider({ seed: Number(e.target.value) })}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      )}

      {browserMode && activeProvider?.type === 'comfyui' && (
        <SettingsGroup label="本机算力连接向导">
          <div className="px-4 py-3 space-y-3 text-sm">
            <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
              <li>
                给 ComfyUI 加 CORS 启动参数（把命令里的站点地址换成当前页面地址，**不要用 `*`**——
                那等于允许任何网站访问你本机的 ComfyUI）：
                <pre className="mt-1 rounded bg-muted px-3 py-2 text-xs overflow-x-auto select-all">{corsCommand}</pre>
                <span className="text-xs">便携包/启动器用户：把 <code>--enable-cors-header {siteOrigin}</code> 追加到启动参数后重启。</span>
              </li>
              <li>
                首次出图时浏览器会弹出「本地网络访问」权限（Chrome 142+ / Firefox 149+），请选择允许；
                Safari 不支持本特性。
              </li>
              <li>点下方按钮检测，然后在本页保存配置。</li>
            </ol>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={handleProbe} disabled={probing}>
                <RefreshCw size={14} className={`mr-1 ${probing ? 'animate-spin' : ''}`} />
                {probing ? '检测中…' : '检测本机 ComfyUI'}
              </Button>
              {probe && (
                <span
                  className={`inline-flex items-center gap-1 text-xs ${
                    probe.status === 'ok'
                      ? 'text-emerald-600'
                      : probe.status === 'cors_blocked'
                        ? 'text-amber-600'
                        : 'text-red-500'
                  }`}
                >
                  {probe.status === 'cors_blocked' && <TriangleAlert size={13} />}
                  {probe.message}
                </span>
              )}
            </div>
          </div>
        </SettingsGroup>
      )}

      {!isAdmin && (
        <p className="px-4 text-xs text-muted-foreground">
          图片生成配置仅管理员可修改；你当前看到的是只读视图。
        </p>
      )}
    </div>
  );
}
