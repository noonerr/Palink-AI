import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import {
  ArrowUpCircle, ArrowDownCircle, MessageSquare,
  Sparkles, ChevronLeft, BarChart2, Brain,
} from 'lucide-react';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/* ───────────── types ───────────── */
interface DailyEntry { date: string; input: number; output: number; reasoning: number; }
interface ModelEntry { model: string; input: number; output: number; reasoning: number; requests: number; }
interface CharacterEntry { character_name: string; input: number; output: number; reasoning: number; requests: number; }
interface Summary { requests: number; input: number; output: number; reasoning: number; total: number; }

interface ChatStats {
  summary: Summary;
  by_model: ModelEntry[];
  daily: DailyEntry[];
}
interface CharacterChatStats extends ChatStats {
  by_character: CharacterEntry[];
}

interface UsageData {
  character_chat: CharacterChatStats;
  regular_chat: ChatStats;
}

type Period = 'day' | 'week' | 'month' | 'all';
type Detail = 'character' | 'regular' | null;

/* ───────────── helpers ───────────── */
const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
};

const PERIOD_LABELS: Record<Period, string> = {
  day: '24h',
  week: '7天',
  month: '30天',
  all: '全部',
};

/* ───────────── sub-components ───────────── */

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-xl bg-muted/40 border border-border/40">
      <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
        <Icon size={13} />
        {label}
      </div>
      <span className="text-lg font-bold text-foreground">{value}</span>
    </div>
  );
}

function TrendChart({ daily }: { daily: DailyEntry[] }) {
  if (!daily || daily.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">暂无数据</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={daily} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={formatTokens} />
        <Tooltip formatter={(v: number) => formatTokens(v)} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="input" name="输入" stroke="#3b82f6" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="output" name="输出" stroke="#22c55e" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="reasoning" name="思考" stroke="#a855f7" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ModelBadgeList({ models }: { models: ModelEntry[] }) {
  if (!models || models.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {models.map((m) => (
        <span
          key={m.model}
          className="px-2.5 py-1 rounded-full text-xs bg-secondary/60 border border-border/40 text-foreground"
        >
          {m.model} ↑{formatTokens(m.input)} ↓{formatTokens(m.output)} 💭{formatTokens(m.reasoning)} {m.requests}次
        </span>
      ))}
    </div>
  );
}

function CharacterTable({ rows }: { rows: CharacterEntry[] }) {
  if (!rows || rows.length === 0) return <p className="text-sm text-muted-foreground">暂无角色数据</p>;
  return (
    <div className="overflow-auto rounded-xl border border-border/40 mt-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40 text-muted-foreground text-xs">
            <th className="text-left px-3 py-2">角色</th>
            <th className="text-right px-3 py-2">请求</th>
            <th className="text-right px-3 py-2">输入</th>
            <th className="text-right px-3 py-2">输出</th>
            <th className="text-right px-3 py-2">思考</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.character_name} className="border-t border-border/30 hover:bg-muted/20 transition-colors">
              <td className="px-3 py-2 font-medium">{r.character_name}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">{r.requests}</td>
              <td className="px-3 py-2 text-right text-blue-500">{formatTokens(r.input)}</td>
              <td className="px-3 py-2 text-right text-green-500">{formatTokens(r.output)}</td>
              <td className="px-3 py-2 text-right text-purple-500">{formatTokens(r.reasoning)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────── main component ───────────── */

export function TokenUsagePanel({ 
  token: _token, 
  userId,
  userName,
  hideCharacterUsage = false
}: { 
  token: string;
  userId?: string | number;
  userName?: string;
  hideCharacterUsage?: boolean;
}) {
  const [period, setPeriod] = useState<Period>('month');
  const [data, setData] = useState<UsageData | null>(null);
  const [detail, setDetail] = useState<Detail>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const url = userId 
      ? `/api/stats/admin/usage/${userId}?period=${period}`
      : `/api/stats/usage?period=${period}`;
    api.get(url)
      .then((res: any) => setData(res))
      .finally(() => setLoading(false));
  }, [period, userId]);

  const periods: Period[] = ['day', 'week', 'month', 'all'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {detail && (
            <button
              onClick={() => setDetail(null)}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors mr-1"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <BarChart2 size={20} className="text-primary" />
          <h2 className="text-lg font-semibold">
            {userName ? `${userName}的用量统计` : detail === 'character' ? '角色聊天详情' : detail === 'regular' ? '普通聊天详情' : '用量统计'}
          </h2>
        </div>
        {/* Period selector */}
        <div className="flex gap-1 bg-muted/40 rounded-xl p-1">
          {periods.map((p) => (
            <Button
              key={p}
              variant={period === p ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABELS[p]}
            </Button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      )}

      {/* Overview (detail === null) */}
      {!loading && data && !detail && (
        <div className={`grid gap-4 ${hideCharacterUsage ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
          {/* Regular chat card */}
          <button
            className="text-left p-4 rounded-2xl border border-border/50 bg-card/60 hover:bg-card/90 transition-all duration-200 hover:shadow-md space-y-3"
            onClick={() => setDetail('regular')}
          >
            <div className="flex items-center gap-2 font-medium">
              <MessageSquare size={16} className="text-primary" />
              普通聊天
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard label="输入" value={formatTokens(data.regular_chat.summary.input)} icon={ArrowUpCircle} color="text-blue-500" />
              <StatCard label="输出" value={formatTokens(data.regular_chat.summary.output)} icon={ArrowDownCircle} color="text-green-500" />
              <StatCard label="思考" value={formatTokens(data.regular_chat.summary.reasoning)} icon={Brain} color="text-purple-500" />
              <StatCard label="请求" value={`${data.regular_chat.summary.requests}次`} icon={MessageSquare} color="text-muted-foreground" />
            </div>
          </button>

          {/* Character chat card - only show if not hiding */}
          {!hideCharacterUsage && (
            <button
              className="text-left p-4 rounded-2xl border border-border/50 bg-card/60 hover:bg-card/90 transition-all duration-200 hover:shadow-md space-y-3"
              onClick={() => setDetail('character')}
            >
              <div className="flex items-center gap-2 font-medium">
                <Sparkles size={16} className="text-purple-500" />
                角色聊天
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCard label="输入" value={formatTokens(data.character_chat.summary.input)} icon={ArrowUpCircle} color="text-blue-500" />
                <StatCard label="输出" value={formatTokens(data.character_chat.summary.output)} icon={ArrowDownCircle} color="text-green-500" />
                <StatCard label="思考" value={formatTokens(data.character_chat.summary.reasoning)} icon={Brain} color="text-purple-500" />
                <StatCard label="请求" value={`${data.character_chat.summary.requests}次`} icon={Sparkles} color="text-purple-500" />
              </div>
            </button>
          )}
        </div>
      )}

      {/* Detail view */}
      {!loading && data && detail && (
        <div className="space-y-5">
          {/* Summary cards */}
          {(() => {
            const stats = detail === 'character' ? data.character_chat : data.regular_chat;
            return (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard label="输入 Token" value={formatTokens(stats.summary.input)} icon={ArrowUpCircle} color="text-blue-500" />
                  <StatCard label="输出 Token" value={formatTokens(stats.summary.output)} icon={ArrowDownCircle} color="text-green-500" />
                  <StatCard label="思考 Token" value={formatTokens(stats.summary.reasoning)} icon={Brain} color="text-purple-500" />
                  <StatCard label="请求次数" value={`${stats.summary.requests}次`} icon={detail === 'character' ? Sparkles : MessageSquare} color={detail === 'character' ? 'text-purple-500' : 'text-muted-foreground'} />
                </div>

                {/* Trend chart */}
                <div className="rounded-xl border border-border/40 p-4 bg-muted/20">
                  <p className="text-xs text-muted-foreground mb-3 font-medium">每日趋势</p>
                  <TrendChart daily={stats.daily} />
                </div>

                {/* By model */}
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium">按模型</p>
                  <ModelBadgeList models={stats.by_model} />
                </div>

                {/* By character (only for character chat and not hiding) */}
                {detail === 'character' && !hideCharacterUsage && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-2 font-medium">按角色</p>
                    <CharacterTable rows={(data.character_chat as CharacterChatStats).by_character} />
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
