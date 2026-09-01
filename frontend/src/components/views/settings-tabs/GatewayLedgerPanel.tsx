import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ExternalLink, KeyRound, Network, RefreshCw, Server } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { api } from '@/services/api';
import type { Provider } from '@/types';

export interface GatewayDetectResult {
  is_gateway: boolean;
  flavor?: string;
  version?: string;
  system_name?: string;
  admin_url?: string;
}

interface ModelRow {
  model: string;
  prompt: number;
  completion: number;
  total: number;
  quota?: number;
  count: number;
}

interface LedgerResponse {
  provider_id: string;
  is_gateway: boolean;
  configured?: boolean;
  hours: number;
  flavor?: string;
  version?: string;
  system_name?: string;
  admin_url?: string;
  auth_error?: string;
  gateway?: {
    request_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_quota: number;
    truncated?: boolean;
    by_model: ModelRow[];
    recent: Record<string, unknown>[];
  };
  palink?: {
    request_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    by_model: ModelRow[];
  };
  drift?: { tokens: number; percent: number | null };
}

const HOURS_OPTIONS = [
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
  { hours: 720, label: '30 天' },
];

const formatTokens = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const formatTs = (value: unknown): string => {
  const ts = Number(value || 0);
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

interface GatewayLedgerPanelProps {
  t: Record<string, string>;
  providers: Provider[];
  gatewayInfo: Record<string, GatewayDetectResult>;
}

/** 管理员「网关对账」面板（P2-3）：网关账本 vs Palink 记账。 */
export function GatewayLedgerPanel({ t, providers, gatewayInfo }: GatewayLedgerPanelProps) {
  const gatewayProviders = useMemo(
    () => providers.filter(p => gatewayInfo[p.id]?.is_gateway),
    [providers, gatewayInfo]
  );
  const [selectedId, setSelectedId] = useState<string>('');
  const [hours, setHours] = useState(168);
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId && gatewayProviders.length > 0) {
      setSelectedId(gatewayProviders[0].id);
    }
    if (selectedId && !gatewayProviders.some(p => p.id === selectedId)) {
      setSelectedId(gatewayProviders[0]?.id || '');
    }
  }, [gatewayProviders, selectedId]);

  const fetchLedger = async (providerId: string, windowHours: number) => {
    if (!providerId) return;
    setLoading(true);
    try {
      const query = new URLSearchParams({ provider_id: providerId, hours: String(windowHours) });
      const result = await api.get<LedgerResponse>(`/api/admin/gateway/ledger?${query.toString()}`);
      setData(result);
    } catch (e: any) {
      toast.error(e?.detail || e?.message || '对账数据拉取失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLedger(selectedId, hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, hours]);

  if (gatewayProviders.length === 0) {
    return (
      <div className="space-y-4 animate-fade-in pb-28 w-full max-w-full">
        <div className="flex items-center gap-3">
          <Network size={20} className="text-primary" />
          <h3 className="text-2xl font-semibold">网关对账</h3>
        </div>
        <GlassCard className="p-8 text-center">
          <Server size={32} className="mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            当前没有检测到 New API / One API 网关。服务商会自动探测网关指纹（/api/status），检测到后即可在此对比网关账本与 Palink 记账。
          </p>
        </GlassCard>
      </div>
    );
  }

  const selected = gatewayProviders.find(p => p.id === selectedId);
  const gw = data?.gateway;
  const pl = data?.palink;
  const drift = data?.drift;
  const driftGood = drift ? Math.abs(drift.percent ?? 0) <= 2 : false;

  return (
    <div className="space-y-4 animate-fade-in pb-28 w-full max-w-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Network size={20} className="text-primary" />
          <h3 className="text-2xl font-semibold">网关对账</h3>
          {selected && gatewayInfo[selected.id]?.version && (
            <span className="text-[10px] bg-amber-500/15 text-amber-500 px-2 py-0.5 rounded-full">
              {gatewayInfo[selected.id]?.flavor === 'new-api' ? 'New API' : 'One API'} {gatewayInfo[selected.id]?.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            className="h-9 rounded-lg border border-input bg-background/60 px-3 text-sm"
          >
            {gatewayProviders.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="flex bg-muted/50 rounded-lg p-0.5">
            {HOURS_OPTIONS.map(opt => (
              <button
                key={opt.hours}
                onClick={() => setHours(opt.hours)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  hours === opt.hours ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="h-9" onClick={() => fetchLedger(selectedId, hours)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {data && data.is_gateway && data.configured === false && (
        <GlassCard className="p-6">
          <div className="flex items-start gap-3">
            <KeyRound size={18} className="text-amber-500 mt-0.5 shrink-0" />
            <div className="space-y-2 text-sm">
              <p className="font-medium">未配置网关管理凭据，仅实时记账可用</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                在「服务提供商 → 编辑 → 网关管理（可选）」中填写该网关的管理员用户名与密码（推荐
                <code className="font-mono bg-secondary px-1 rounded mx-1">env:NEWAPI_ADMIN_PASSWORD</code>
                环境变量引用），即可在此查看网关账本与 Palink 记账的对比。
              </p>
            </div>
          </div>
        </GlassCard>
      )}

      {data?.auth_error && (
        <GlassCard className="p-5 border-destructive/30">
          <p className="text-sm text-destructive">网关登录失败：{data.auth_error}</p>
        </GlassCard>
      )}

      {gw && pl && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <GlassCard className="p-4">
              <p className="text-xs text-muted-foreground mb-1">网关消耗（Token）</p>
              <p className="text-2xl font-semibold">{formatTokens(gw.total_tokens)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{gw.request_count} 次请求</p>
            </GlassCard>
            <GlassCard className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Palink 记账（Token）</p>
              <p className="text-2xl font-semibold">{formatTokens(pl.total_tokens)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{pl.request_count} 次请求</p>
            </GlassCard>
            <GlassCard className="p-4">
              <p className="text-xs text-muted-foreground mb-1">差额（Palink − 网关）</p>
              <p className={`text-2xl font-semibold ${driftGood ? 'text-green-600' : 'text-amber-600'}`}>
                {drift && drift.tokens >= 0 ? '+' : ''}{formatTokens(drift?.tokens ?? 0)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {drift?.percent === null || drift?.percent === undefined ? '—' : `${drift.percent > 0 ? '+' : ''}${drift.percent}%`}
              </p>
            </GlassCard>
            <GlassCard className="p-4">
              <p className="text-xs text-muted-foreground mb-1">网关计费配额</p>
              <p className="text-2xl font-semibold">{formatTokens(gw.total_quota)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">网关内部计费单位，仅供参考</p>
            </GlassCard>
          </div>

          {gw.truncated && (
            <p className="text-xs text-amber-600">
              时间窗内请求数超过单次统计上限（2000 条），以下为前 2000 条的统计，数字可能偏小。
            </p>
          )}

          <GlassCard className="p-4 overflow-x-auto">
            <h4 className="text-sm font-semibold mb-3">按模型对照</h4>
            <table className="w-full text-xs min-w-[520px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/50 text-left">
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="py-2 px-3 font-medium text-right">网关 输入/输出</th>
                  <th className="py-2 px-3 font-medium text-right">Palink 输入/输出</th>
                  <th className="py-2 px-3 font-medium text-right">网关请求</th>
                </tr>
              </thead>
              <tbody>
                {gw.by_model.map(row => {
                  const counterpart = pl.by_model.find(m => m.model === row.model);
                  return (
                    <tr key={row.model} className="border-b border-border/30 last:border-0">
                      <td className="py-2 pr-3 font-mono truncate max-w-[180px]" title={row.model}>{row.model}</td>
                      <td className="py-2 px-3 text-right font-mono">
                        {formatTokens(row.prompt)} / {formatTokens(row.completion)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                        {counterpart
                          ? `${formatTokens(counterpart.prompt)} / ${formatTokens(counterpart.completion)}`
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-right">{row.count}</td>
                    </tr>
                  );
                })}
                {pl.by_model
                  .filter(m => !gw.by_model.some(row => row.model === m.model))
                  .map(m => (
                    <tr key={`pl-${m.model}`} className="border-b border-border/30 last:border-0">
                      <td className="py-2 pr-3 font-mono truncate max-w-[180px]" title={m.model}>{m.model}</td>
                      <td className="py-2 px-3 text-right font-mono text-muted-foreground">—</td>
                      <td className="py-2 px-3 text-right font-mono">
                        {formatTokens(m.prompt)} / {formatTokens(m.completion)}
                      </td>
                      <td className="py-2 px-3 text-right text-muted-foreground">—</td>
                    </tr>
                  ))}
                {gw.by_model.length === 0 && pl.by_model.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">该时间窗内没有请求记录</td></tr>
                )}
              </tbody>
            </table>
          </GlassCard>

          <GlassCard className="p-4 overflow-x-auto">
            <h4 className="text-sm font-semibold mb-3">网关最近请求</h4>
            <table className="w-full text-xs min-w-[560px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/50 text-left">
                  <th className="py-2 pr-3 font-medium">时间</th>
                  <th className="py-2 px-3 font-medium">令牌</th>
                  <th className="py-2 px-3 font-medium">模型</th>
                  <th className="py-2 px-3 font-medium text-right">输入</th>
                  <th className="py-2 px-3 font-medium text-right">输出</th>
                </tr>
              </thead>
              <tbody>
                {gw.recent.map((item, idx) => (
                  <tr key={idx} className="border-b border-border/30 last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatTs(item.created_at)}</td>
                    <td className="py-2 px-3 font-mono truncate max-w-[140px]" title={String(item.token_name || '')}>{String(item.token_name || '-')}</td>
                    <td className="py-2 px-3 font-mono truncate max-w-[180px]" title={String(item.model_name || '')}>{String(item.model_name || '-')}</td>
                    <td className="py-2 px-3 text-right font-mono">{Number(item.prompt_tokens || 0)}</td>
                    <td className="py-2 px-3 text-right font-mono">{Number(item.completion_tokens || 0)}</td>
                  </tr>
                ))}
                {gw.recent.length === 0 && (
                  <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">该时间窗内没有网关日志</td></tr>
                )}
              </tbody>
            </table>
          </GlassCard>
        </>
      )}

      {data && data.is_gateway && data.admin_url && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          网关后台：
          <a href={data.admin_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
            {data.admin_url} <ExternalLink size={11} />
          </a>
        </p>
      )}

      <div className="text-[11px] text-muted-foreground space-y-1">
        <p className="flex items-center gap-1">
          <ArrowDownRight size={11} /> 输入 = prompt_tokens；<ArrowUpRight size={11} /> 输出 = completion_tokens（含推理）。
        </p>
        <p>差额常见来源：辅助功能（标题压缩/摘要等）与群聊在网关侧有账但 Palink 不扣费；差额持续为负说明有请求绕过了 Palink 记账。</p>
      </div>
    </div>
  );
}
