import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Save, Loader2, CheckCircle2, XCircle, Plus, Trash2, ChevronDown, Shield, LogIn, UserPlus, Plug } from 'lucide-react';

import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Switch } from '@/components/ui/switch';
import type { AdminAuthConfig, OAuthProviderConfig } from '@/types';

interface AuthSettingsTabProps {
  t: Record<string, string>;
  token: string;
}

const PROVIDER_TEMPLATES: Array<{ name: string; display_name: string; authorize_url: string; token_url: string; userinfo_url: string; scopes: string }> = [
  {
    name: 'github',
    display_name: 'GitHub',
    authorize_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    userinfo_url: 'https://api.github.com/user',
    scopes: 'read:user user:email',
  },
  {
    name: 'google',
    display_name: 'Google',
    authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    userinfo_url: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: 'openid profile email',
  },
  {
    name: 'discord',
    display_name: 'Discord',
    authorize_url: 'https://discord.com/api/oauth2/authorize',
    token_url: 'https://discord.com/api/oauth2/token',
    userinfo_url: 'https://discord.com/api/users/@me',
    scopes: 'identify email',
  },
];

const emptyProvider: OAuthProviderConfig = {
  name: '',
  display_name: '',
  client_id: '',
  client_secret: '',
  authorize_url: '',
  token_url: '',
  userinfo_url: '',
  scopes: '',
  enabled: true,
};

export function AuthSettingsTab({ t, token }: AuthSettingsTabProps) {
  const [config, setConfig] = useState<AdminAuthConfig>({
    local_login_enabled: true,
    local_register_enabled: true,
    oauth_providers: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newProvider, setNewProvider] = useState<OAuthProviderConfig>({ ...emptyProvider });

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const data = await api.get<AdminAuthConfig>('/api/admin/auth/config');
      setConfig(data);
    } catch (e) {
      console.error('Failed to fetch auth config:', e);
      toast.error('加载认证配置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/api/admin/auth/config', config);
      toast.success('认证配置已保存');
    } catch (e) {
      console.error('Failed to save auth config:', e);
      toast.error('保存认证配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTestProvider = async (providerName: string) => {
    setTesting(providerName);
    try {
      const result = await api.post<{ success: boolean; message: string }>(`/api/admin/oauth/providers/${providerName}/test`);
      setTestResults(prev => ({ ...prev, [providerName]: result }));
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (e: any) {
      const msg = e?.message || '测试连接失败';
      setTestResults(prev => ({ ...prev, [providerName]: { success: false, message: msg } }));
      toast.error(msg);
    } finally {
      setTesting(null);
    }
  };

  const handleDeleteProvider = async (providerName: string) => {
    try {
      await api.delete(`/api/admin/oauth/providers/${providerName}`);
      setConfig(prev => ({
        ...prev,
        oauth_providers: prev.oauth_providers.filter(p => p.name !== providerName),
      }));
      toast.success('已删除提供商');
    } catch (e) {
      console.error('Failed to delete provider:', e);
      toast.error('删除提供商失败');
    }
  };

  const handleSaveProvider = async (provider: OAuthProviderConfig) => {
    try {
      await api.post('/api/admin/oauth/providers', provider);
      setConfig(prev => {
        const existing = prev.oauth_providers.findIndex(p => p.name === provider.name);
        if (existing >= 0) {
          const updated = [...prev.oauth_providers];
          updated[existing] = provider;
          return { ...prev, oauth_providers: updated };
        }
        return { ...prev, oauth_providers: [...prev.oauth_providers, provider] };
      });
      toast.success('提供商配置已保存');
      setAddingNew(false);
      setNewProvider({ ...emptyProvider });
    } catch (e) {
      console.error('Failed to save provider:', e);
      toast.error('保存提供商配置失败');
    }
  };

  const updateConfig = (key: keyof AdminAuthConfig, value: boolean | string) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateProvider = (name: string, field: keyof OAuthProviderConfig, value: string | boolean) => {
    setConfig(prev => ({
      ...prev,
      oauth_providers: prev.oauth_providers.map(p =>
        p.name === name ? { ...p, [field]: value } : p
      ),
    }));
  };

  const applyTemplate = (template: typeof PROVIDER_TEMPLATES[number]) => {
    setNewProvider(prev => ({
      ...prev,
      name: template.name,
      display_name: template.display_name,
      authorize_url: template.authorize_url,
      token_url: template.token_url,
      userinfo_url: template.userinfo_url,
      scopes: template.scopes,
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in pb-28">
        <h3 className="text-xl md:text-2xl font-semibold hidden md:block">认证设置</h3>

        <GlassCard className="p-4 md:p-6">
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
              <div className="flex items-center gap-3">
                <LogIn size={18} className="text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium text-sm">本地密码登录</p>
                  <p className="text-xs text-muted-foreground">允许使用本地账号密码登录</p>
                </div>
              </div>
              <Switch
                checked={config.local_login_enabled}
                onCheckedChange={(v) => updateConfig('local_login_enabled', v)}
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-t border-border/50">
              <div className="flex items-center gap-3">
                <UserPlus size={18} className="text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium text-sm">本地注册</p>
                  <p className="text-xs text-muted-foreground">
                    允许新用户通过本地注册创建账号
                  </p>
                </div>
              </div>
              <Switch
                checked={config.local_register_enabled}
                onCheckedChange={(v) => updateConfig('local_register_enabled', v)}
              />
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button onClick={handleSave} disabled={saving} className="min-h-[44px]">
              {saving ? (
                <Loader2 size={16} className="mr-2 animate-spin" />
              ) : (
                <Save size={16} className="mr-2" />
              )}
              {t.save || '保存'}
            </Button>
          </div>
        </GlassCard>

        <GlassCard className="p-4 md:p-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Shield size={18} className="text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium text-sm">OAuth 登录提供商</p>
                  <p className="text-xs text-muted-foreground">配置第三方 OAuth 登录</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setAddingNew(true); setNewProvider({ ...emptyProvider }); }}
                className="min-h-[36px]"
              >
                <Plus size={14} className="mr-1.5" />
                添加
              </Button>
            </div>

            {addingNew && (
              <div className="space-y-4 p-4 rounded-xl bg-secondary/50 animate-in slide-in-from-top-2 fade-in duration-300">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">快速模板:</span>
                  {PROVIDER_TEMPLATES.map(template => (
                    <button
                      key={template.name}
                      onClick={() => applyTemplate(template)}
                      className="px-2 py-1 text-xs rounded-md bg-background border border-border hover:bg-accent transition-colors"
                    >
                      {template.display_name}
                    </button>
                  ))}
                  <button
                    onClick={() => setNewProvider({ ...emptyProvider })}
                    className="px-2 py-1 text-xs rounded-md bg-background border border-border hover:bg-accent transition-colors"
                  >
                    自定义
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">名称 (唯一标识)</label>
                    <Input
                      value={newProvider.name}
                      onChange={e => setNewProvider(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="github"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">显示名称</label>
                    <Input
                      value={newProvider.display_name}
                      onChange={e => setNewProvider(prev => ({ ...prev, display_name: e.target.value }))}
                      placeholder="GitHub"
                      className="h-10"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Client ID</label>
                    <Input
                      value={newProvider.client_id}
                      onChange={e => setNewProvider(prev => ({ ...prev, client_id: e.target.value }))}
                      placeholder="Client ID"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Client Secret</label>
                    <Input
                      type="password"
                      value={newProvider.client_secret}
                      onChange={e => setNewProvider(prev => ({ ...prev, client_secret: e.target.value }))}
                      placeholder="Client Secret"
                      className="h-10"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Authorize URL</label>
                  <Input
                    value={newProvider.authorize_url}
                    onChange={e => setNewProvider(prev => ({ ...prev, authorize_url: e.target.value }))}
                    placeholder="https://provider.com/oauth/authorize"
                    className="h-10"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Token URL</label>
                  <Input
                    value={newProvider.token_url}
                    onChange={e => setNewProvider(prev => ({ ...prev, token_url: e.target.value }))}
                    placeholder="https://provider.com/oauth/token"
                    className="h-10"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">UserInfo URL</label>
                  <Input
                    value={newProvider.userinfo_url}
                    onChange={e => setNewProvider(prev => ({ ...prev, userinfo_url: e.target.value }))}
                    placeholder="https://provider.com/api/userinfo"
                    className="h-10"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Scopes</label>
                  <Input
                    value={newProvider.scopes}
                    onChange={e => setNewProvider(prev => ({ ...prev, scopes: e.target.value }))}
                    placeholder="openid profile email"
                    className="h-10"
                  />
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button
                    size="sm"
                    onClick={() => handleSaveProvider(newProvider)}
                    disabled={!newProvider.name || !newProvider.client_id}
                    className="min-h-[36px]"
                  >
                    <Save size={14} className="mr-1.5" />
                    保存提供商
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setAddingNew(false); setNewProvider({ ...emptyProvider }); }}
                    className="min-h-[36px]"
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}

            {config.oauth_providers.length === 0 && !addingNew && (
              <div className="py-8 text-center">
                <Plug size={32} className="mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">暂未配置 OAuth 提供商</p>
                <p className="text-xs text-muted-foreground/60 mt-1">点击上方"添加"按钮配置第三方登录</p>
              </div>
            )}

            {config.oauth_providers.map((provider) => (
              <div key={provider.name} className="border border-border/50 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedProvider(expandedProvider === provider.name ? null : provider.name)}
                  className="w-full flex items-center justify-between p-3 hover:bg-secondary/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      provider.enabled ? "bg-green-500" : "bg-muted-foreground/30"
                    )} />
                    <span className="font-medium text-sm">{provider.display_name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{provider.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults[provider.name] && (
                      testResults[provider.name].success
                        ? <CheckCircle2 size={14} className="text-green-500" />
                        : <XCircle size={14} className="text-destructive" />
                    )}
                    <ChevronDown
                      size={18}
                      className={cn(
                        'text-muted-foreground transition-transform duration-300',
                        expandedProvider === provider.name && 'rotate-180'
                      )}
                    />
                  </div>
                </button>

                {expandedProvider === provider.name && (
                  <div className="space-y-3 p-4 border-t border-border/50 bg-secondary/30 animate-in slide-in-from-top-2 fade-in duration-300">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">启用</span>
                      <Switch
                        checked={provider.enabled}
                        onCheckedChange={(v) => updateProvider(provider.name, 'enabled', v)}
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">显示名称</label>
                        <Input
                          value={provider.display_name}
                          onChange={e => updateProvider(provider.name, 'display_name', e.target.value)}
                          className="h-10"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Client ID</label>
                        <Input
                          value={provider.client_id}
                          onChange={e => updateProvider(provider.name, 'client_id', e.target.value)}
                          className="h-10"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Client Secret</label>
                      <Input
                        type="password"
                        value={provider.client_secret}
                        onChange={e => updateProvider(provider.name, 'client_secret', e.target.value)}
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Authorize URL</label>
                      <Input
                        value={provider.authorize_url}
                        onChange={e => updateProvider(provider.name, 'authorize_url', e.target.value)}
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Token URL</label>
                      <Input
                        value={provider.token_url}
                        onChange={e => updateProvider(provider.name, 'token_url', e.target.value)}
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">UserInfo URL</label>
                      <Input
                        value={provider.userinfo_url}
                        onChange={e => updateProvider(provider.name, 'userinfo_url', e.target.value)}
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Scopes</label>
                      <Input
                        value={provider.scopes}
                        onChange={e => updateProvider(provider.name, 'scopes', e.target.value)}
                        className="h-10"
                      />
                    </div>

                    <div className="flex items-center gap-3 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSaveProvider(provider)}
                        className="min-h-[36px]"
                      >
                        <Save size={14} className="mr-1.5" />
                        保存
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTestProvider(provider.name)}
                        disabled={testing === provider.name}
                        className="min-h-[36px]"
                      >
                        {testing === provider.name ? (
                          <Loader2 size={14} className="mr-1.5 animate-spin" />
                        ) : (
                          <Plug size={14} className="mr-1.5" />
                        )}
                        测试连接
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteProvider(provider.name)}
                        className="min-h-[36px] text-destructive hover:text-destructive"
                      >
                        <Trash2 size={14} className="mr-1.5" />
                        删除
                      </Button>
                      {testResults[provider.name] && (
                        <span className={cn(
                          'text-xs',
                          testResults[provider.name].success ? 'text-green-500' : 'text-destructive'
                        )}>
                          {testResults[provider.name].message}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </GlassCard>
    </div>
  );
}
