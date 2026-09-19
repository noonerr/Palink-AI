import React, { useState } from 'react';
import { toast } from 'sonner';
import { Trash2, Settings2 } from 'lucide-react';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SettingsGroup } from './settings-ui';
import type { User as UserType } from '@/types';

interface AdminUsersTabProps {
  t: Record<string, string>;
  usersList: UserType[];
  onRefreshUsers: () => void;
  onDeleteUser: (userId: string | number) => void;
  onViewUsage: (u: UserType) => void;
  bottomPadding: string;
}

export function AdminUsersTab({
  t,
  usersList,
  onRefreshUsers,
  onDeleteUser,
  onViewUsage,
  bottomPadding
}: AdminUsersTabProps) {
  // 用户 token 额度编辑（管理员）
  const [quotaEditUser, setQuotaEditUser] = useState<UserType | null>(null);
  const [quotaInput, setQuotaInput] = useState('');
  const [quotaResetUsed, setQuotaResetUsed] = useState(false);
  const [quotaMonthlyReset, setQuotaMonthlyReset] = useState(false);
  const [quotaSaving, setQuotaSaving] = useState(false);

  const openQuotaEditor = (u: UserType) => {
    setQuotaEditUser(u);
    setQuotaInput(u.quota_tokens != null ? String(u.quota_tokens) : '');
    setQuotaResetUsed(false);
    setQuotaMonthlyReset(u.quota_monthly_reset ?? false);
  };

  const saveUserQuota = async () => {
    if (!quotaEditUser) return;
    const raw = quotaInput.trim().replace(/,/g, '');
    const parsed = raw === '' ? null : parseInt(raw, 10);
    if (raw !== '' && (isNaN(parsed!) || parsed! < 0)) {
      toast.error('额度需为非负整数（token 数），留空表示不限');
      return;
    }
    setQuotaSaving(true);
    try {
      await api.put(`/api/admin/users/${quotaEditUser.id}/quota`, {
        quota_tokens: parsed,
        reset_used: quotaResetUsed,
        monthly_reset: quotaMonthlyReset,
      });
      toast.success('额度已更新');
      setQuotaEditUser(null);
      onRefreshUsers();
    } catch (e: any) {
      toast.error(e?.detail || e?.message || '保存失败');
    } finally {
      setQuotaSaving(false);
    }
  };

  const formatQuotaStatus = (u: UserType): { text: string; cls: string } => {
    if (u.quota_tokens == null) return { text: '额度不限', cls: 'bg-muted/60 text-muted-foreground' };
    const remaining = Math.max(u.quota_tokens - (u.quota_used_tokens ?? 0), 0);
    if (remaining <= 0) return { text: '已超限', cls: 'bg-red-500/15 text-red-500' };
    const fmt = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : String(n);
    return { text: `剩 ${fmt(remaining)}`, cls: 'bg-primary/10 text-primary' };
  };

  return (
    <div className={`space-y-4 md:space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>

      <SettingsGroup label={t.users || '用户'}>
        {usersList.map(u => (
          <div key={u.id} className="px-4 py-4">
            <div className="flex items-center justify-between">
              <button
                onClick={() => onViewUsage(u)}
                className="flex items-center gap-3 md:gap-4 text-left flex-1 min-w-0"
              >
                <Avatar className="shrink-0">
                  <AvatarImage src={u.avatar} />
                  <AvatarFallback>{u.username?.[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-medium leading-snug truncate">{u.username}</p>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {t.role}: {u.role}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5 md:gap-2 mt-2">
                    <div className="p-1.5 md:p-2 rounded-xl bg-secondary/40 border border-border/40">
                      <p className="text-xs text-blue-500 font-medium">输入</p>
                      <p className="text-xs md:text-sm font-bold">{(u.tokens_chat || 0) + (u.tokens_workspace || 0) + (u.tokens_character || 0)}</p>
                    </div>
                    <div className="p-1.5 md:p-2 rounded-xl bg-secondary/40 border border-border/40">
                      <p className="text-xs text-green-500 font-medium">输出</p>
                      <p className="text-xs md:text-sm font-bold">0</p>
                    </div>
                    <div className="p-1.5 md:p-2 rounded-xl bg-secondary/40 border border-border/40">
                      <p className="text-xs text-muted-foreground font-medium">请求</p>
                      <p className="text-xs md:text-sm font-bold">{u.chat_count}次</p>
                    </div>
                    <div className="p-1.5 md:p-2 rounded-xl bg-secondary/40 border border-border/40">
                      <p className="text-xs text-muted-foreground font-medium">存储</p>
                      <p className="text-xs md:text-sm font-bold">{((u.storage_used ?? 0) / 1024 / 1024).toFixed(1)}MB</p>
                    </div>
                    <div className={`p-1.5 md:p-2 rounded-xl border border-border/40 ${formatQuotaStatus(u).cls}`}>
                      <p className="text-xs font-medium">Token 额度</p>
                      <p className="text-xs md:text-sm font-bold">{formatQuotaStatus(u).text}</p>
                    </div>
                  </div>
                </div>
              </button>
              <div className="flex gap-2 ml-2 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:bg-secondary min-h-[44px] min-w-[44px]"
                  aria-label="编辑额度"
                  onClick={(e) => { e.stopPropagation(); openQuotaEditor(u); }}
                >
                  <Settings2 size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:bg-destructive/10 min-h-[44px] min-w-[44px]"
                  onClick={(e) => { e.stopPropagation(); onDeleteUser(u.id); }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </SettingsGroup>

      {/* 额度编辑弹窗 */}
      <Dialog open={quotaEditUser !== null} onOpenChange={(open) => { if (!open) setQuotaEditUser(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>设置 Token 额度 — {quotaEditUser?.username}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                总额度（tokens），留空表示不限
              </label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="如 5000000（500 万 tokens）"
                value={quotaInput}
                onChange={(e) => setQuotaInput(e.target.value)}
              />
              {quotaEditUser && quotaEditUser.quota_used_tokens != null && quotaEditUser.quota_used_tokens > 0 && (
                <p className="text-[11px] text-muted-foreground mt-1.5">当前已用：{quotaEditUser.quota_used_tokens.toLocaleString()} tokens</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={quotaResetUsed} onCheckedChange={setQuotaResetUsed} />
              <span className="text-sm">同时清零已用量</span>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={quotaMonthlyReset} onCheckedChange={setQuotaMonthlyReset} />
              <span className="text-sm">每月自动重置</span>
              <span className="text-[11px] text-muted-foreground">（按自然月清零已用量）</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              计入口径：对话生成的 prompt + 补全 + 思考 tokens 总和。额度耗尽后该用户发起聊天会被拦截。
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setQuotaEditUser(null)}>取消</Button>
            <Button onClick={saveUserQuota} disabled={quotaSaving}>{quotaSaving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
