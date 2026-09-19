import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import {
  User,
  AlertCircle,
  Users,
  Shield,
  Bot,
  Sun,
  Zap,
  MessageSquareText,
  Key,
  Puzzle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { OCSettings } from '@/components/ui/custom/OCSettings';
import { PromptSettings } from './settings-tabs/PromptSettings';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { TokenUsagePanel } from '@/components/ui/custom/TokenUsagePanel';
import { ModelManagementTab } from './settings-tabs/ModelManagementTab';
import { AboutTab } from './settings-tabs/AboutTab';
import { ProfileTab } from './settings-tabs/ProfileTab';
import { AuthSettingsTab } from './settings-tabs/AuthSettingsTab';
import { AdminPluginsTab } from './settings-tabs/AdminPluginsTab';
import { AppearanceTab } from './settings-tabs/AppearanceTab';
import { RoleplayEngineTab } from './settings-tabs/RoleplayEngineTab';
import { AdminDefaultsTab } from './settings-tabs/AdminDefaultsTab';
import { AdminUsersTab } from './settings-tabs/AdminUsersTab';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Model, Provider, User as UserType, Theme } from '@/types';

interface SettingsViewProps {
  token: string;
  user: UserType;
  models: Model[];
  systemDefaults: any;
  onLogout: () => void;
  onUpdateDefaults: () => void;
  t: Record<string, string>;
  isDark?: boolean;
  onThemeToggle?: () => void;
  themeMode?: Theme;
  onThemeSet?: (mode: Theme) => void;
  lang?: string;
  onLangToggle?: () => void;
}

type SettingsTab = 'profile' | 'roleplay_engine' | 'appearance' | 'models' | 'oc' | 'prompts' | 'admin_users' | 'admin_auth' | 'admin_defaults' | 'admin_plugins' | 'about' | 'usage' | 'user_usage';

export function SettingsView({
  token,
  user,
  models,
  systemDefaults,
  onLogout,
  onUpdateDefaults,
  t,
  isDark,
  onThemeToggle,
  themeMode,
  onThemeSet,
  lang,
  onLangToggle
}: SettingsViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const bottomPadding = useMobileBottomPadding();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const state = location.state as { activeTab?: string } | null;
    if (state?.activeTab && ['profile', 'roleplay_engine', 'appearance', 'models', 'oc', 'prompts', 'admin_users', 'admin_auth', 'admin_defaults', 'admin_plugins', 'about', 'usage', 'user_usage'].includes(state.activeTab)) {
      return state.activeTab as SettingsTab;
    }
    return 'profile';
  });
  const [mobileTabSelected, setMobileTabSelected] = useState(() => {
    const state = location.state as { activeTab?: string } | null;
    return !!state?.activeTab;
  });

  useEffect(() => {
    if (location.state) {
      window.history.replaceState({}, '');
    }
  }, []);

  // 返回键已按用户拍板（2026-09-06 实验）移除：dock 再点「设置」= 回到设置菜单
  // （iOS「点活跃 tab 回根」语义，事件由 Sidebar MobileBottomNav 派发）。
  // 注意：四槽常驻下本组件的 useLocation 被钉在 /settings，不能用 pathname 判断离开。
  useEffect(() => {
    const handler = () => setMobileTabSelected(false);
    window.addEventListener('palink:settings-root', handler);
    return () => window.removeEventListener('palink:settings-root', handler);
  }, []);

  useEffect(() => {
    const handleIconSync = (e: Event) => {
      const { modelId, icon } = (e as CustomEvent).detail;
      if (!modelId || !icon) return;
      setProviders(prev => {
        let changed = false;
        const updated = prev.map(p => {
          const modelIndex = p.models.findIndex(m => m.id === modelId || m.name === modelId);
          if (modelIndex !== -1 && p.models[modelIndex].icon !== icon) {
            changed = true;
            const newModels = [...p.models];
            newModels[modelIndex] = { ...newModels[modelIndex], icon };
            return { ...p, models: newModels };
          }
          return p;
        });
        return changed ? updated : prev;
      });
    };
    window.addEventListener('modelIconChanged', handleIconSync);
    return () => window.removeEventListener('modelIconChanged', handleIconSync);
  }, []);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usersList, setUsersList] = useState<UserType[]>([]);
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  
  // Provider connection status
  const [providerStatus, setProviderStatus] = useState<Record<string, { 
    success: boolean | null; 
    message: string; 
    testing: boolean 
  }>>({});
  
  
  // Profile state
  const [avatarUrl, setAvatarUrl] = useState(user.avatar || '');
  const [avatarType, setAvatarType] = useState<'emoji' | 'image' | 'url'>('emoji');
  const [newUsername, setNewUsername] = useState(user.username || '');
  const [pwdOld, setPwdOld] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  const isMobile = useIsMobile();
  const isDesktop = !isMobile;

  // Confirm dialog state
  const [modelDeleteConfirm, setModelDeleteConfirm] = useState<{ open: boolean; modelId: string }>({ open: false, modelId: '' });
  const [userDeleteConfirm, setUserDeleteConfirm] = useState<{ open: boolean; userId: string | number }>({ open: false, userId: '' });
  const [providerDeleteConfirm, setProviderDeleteConfirm] = useState<{ open: boolean; providerId: string }>({ open: false, providerId: '' });
  const [viewingUser, setViewingUser] = useState<UserType | null>(null);

  const isAdmin = user.role === 'admin';

  useEffect(() => {
    if (isAdmin) {
      fetchProviders();
      fetchUsers();
      fetchLocalModels();
    }
  }, [isAdmin]);





  const fetchLocalModels = async () => {
    try {
      const data = await api.get('/api/models/local?all=true');
      setLocalModels(data);
    } catch (e) { console.error(e); }
  };
  
  // 启用/禁用模型
  const handleModelEnable = async (modelId: string, enabled: boolean) => {
    try {
      const modelName = modelId.replace('local:', '');
      await api.put(`/api/admin/models/local/${modelName}/enable?enabled=${enabled}`);
      setLocalModels(prev => prev.map(m => 
        m.id === modelId ? { ...m, enabled } : m
      ));
      window.dispatchEvent(new CustomEvent('modelsUpdated'));
      toast.success(enabled ? '模型已启用' : '模型已禁用');
    } catch (e: any) { 
      console.error(e);
      const detail = e?.detail || e?.message || (typeof e === 'string' ? e : '');
      toast.error(detail ? `设置失败: ${detail}` : '设置模型状态失败');
    }
  };


  const handleMmprojToggle = async (modelId: string, enabled: boolean) => {
    try {
      const modelName = modelId.replace('local:', '');
      await api.put(`/api/admin/models/local/${modelName}/mmproj?mmproj_enabled=${enabled}`);
      await fetchLocalModels();
      toast.success(enabled ? '视觉编码器已启用' : '视觉编码器已禁用');
    } catch (e: any) {
      console.error('Failed to toggle mmproj:', e);
      const detail = e?.detail || e?.message || (typeof e === 'string' ? e : '');
      toast.error(detail ? `操作失败: ${detail}` : '设置视觉编码器状态失败');
    }
  };




  const handleModelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 重置进度条
    setUploadProgress(0);

    // 检查文件大小，给出提示
    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB
    if (file.size > maxSize) {
      toast.error('文件大小超过限制（最大10GB）');
      setUploadProgress(null);
      e.target.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();

    // 设置更长的超时时间（1小时）
    xhr.timeout = 3600000;

    // 监听上传进度
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const progress = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(progress);
      }
    });

    // 监听上传完成
    xhr.addEventListener('load', () => {
      setUploadProgress(null);
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          toast.success(data.message);
          fetchLocalModels();
        } catch (e) {
          toast.warning('上传成功，但解析响应失败');
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          toast.error(`上传失败: ${error.detail || '未知错误'}`);
        } catch (e) {
          toast.error(`上传失败: ${xhr.statusText || '未知错误'}`);
        }
      }
    });

    // 监听上传错误
    xhr.addEventListener('error', () => {
      setUploadProgress(null);
      toast.error('上传失败: 网络错误，请检查网络连接并重试');
    });

    // 监听上传超时
    xhr.addEventListener('timeout', () => {
      setUploadProgress(null);
      toast.error('上传超时，请检查网络连接并重试');
    });

    // 发送请求（同源 XHR 自动携带 palink_session Cookie 鉴权）
    xhr.open('POST', '/api/admin/models/local/upload');
    xhr.send(formData);

    // 重置文件输入
    e.target.value = '';
  };

  const handleModelDelete = (modelId: string) => {
    setModelDeleteConfirm({ open: true, modelId });
  };

  const doModelDelete = async (modelId: string) => {
    try {
      const modelName = modelId.replace('local:', '');
      const data = await api.delete(`/api/admin/models/local/${modelName}`);
      toast.success(data.message);
      fetchLocalModels();
    } catch (e: any) {
      toast.error(`删除失败: ${e.message || '网络错误'}`);
    }
  };

  const fetchProviders = async () => {
    try {
      const data = await api.get('/api/admin/providers');
      setProviders(data);
    } catch (e) {
      console.error('Failed to fetch providers:', e);
      toast.error('加载服务商列表失败');
    }
  };

  const fetchUsers = async () => {
    try {
      const data = await api.get('/api/admin/users');
      setUsersList(data);
    } catch (e) {
      console.error('Failed to fetch users:', e);
      toast.error('加载用户列表失败');
    }
  };




  const handleUpdateProfile = async () => {
    try {
      await api.put('/api/users/me', { avatar: avatarUrl, username: newUsername });
      toast.success('Profile updated');
    } catch (e) {
      console.error('Failed to update profile:', e);
      toast.error('更新个人资料失败');
    }
  };

  const handleChangePassword = async () => {
    // 验证输入
    if (!pwdOld.trim()) {
      toast.error(t.old_pwd_required || '请输入旧密码');
      return;
    }
    if (!pwdNew.trim()) {
      toast.error(t.new_pwd_required || '请输入新密码');
      return;
    }
    if (pwdNew.length < 6) {
      toast.error(t.pwd_min_length || '新密码至少需要6个字符');
      return;
    }
    if (pwdOld === pwdNew) {
      toast.error(t.pwd_same_as_old || '新密码不能与旧密码相同');
      return;
    }
    
    try {
      await api.post('/api/users/me/password', { old_password: pwdOld, new_password: pwdNew });
      toast.success(t.pwd_changed || '密码修改成功');
      setPwdOld('');
      setPwdNew('');
      setShowPasswordForm(false);
    } catch (e: any) {
      toast.error(e.message || t.pwd_change_error || '密码修改出错');
    }
  };


  const handleDeleteUser = (userId: string | number) => {
    setUserDeleteConfirm({ open: true, userId });
  };

  const doDeleteUser = async (userId: string | number) => {
    try {
      await api.delete(`/api/admin/users/${userId}`);
      setUsersList(usersList.filter((u: UserType) => u.id !== userId));
      toast.success(t.user_deleted || '用户已删除');
    } catch (e) {
      toast.error(t.delete_user_error || '删除用户出错');
    }
  };



  const handleEditProvider = (provider?: Provider) => {
    if (provider) {
      navigate(`/settings/providers/${provider.id}`);
    } else {
      navigate('/settings/providers/new');
    }
  };

  const ensureUrlHasProtocol = (url: string): string => {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return 'https://' + url;
  };

  const handleDeleteProvider = (id: string) => {
    setProviderDeleteConfirm({ open: true, providerId: id });
  };

  const doDeleteProvider = async (id: string) => {
    try {
      await api.delete('/api/admin/providers/' + id);
      fetchProviders();
    } catch (e) {
      console.error('Failed to delete provider:', e);
    }
  };


  const testProviderConnection = async (provider: Provider) => {
    setProviderStatus(prev => ({
      ...prev,
      [provider.id]: { success: null, message: '测试中...', testing: true }
    }));
    
    try {
      const data = await api.post('/api/admin/test-provider', {
        base_url: ensureUrlHasProtocol(provider.base_url),
        api_key: provider.api_key,
        provider_id: provider.id,
        provider_name: provider.name
      });
      setProviderStatus(prev => ({
        ...prev,
        [provider.id]: { 
          success: data.success, 
          message: data.message, 
          testing: false 
        }
      }));
    } catch (e) {
      setProviderStatus(prev => ({
        ...prev,
        [provider.id]: { 
          success: false, 
          message: '网络错误', 
          testing: false 
        }
      }));
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => setAvatarUrl(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const menuItems = [
    { id: 'profile' as SettingsTab, label: t.settings_profile, icon: User },
    { id: 'oc' as SettingsTab, label: '用户人设', icon: User },
    { id: 'roleplay_engine' as SettingsTab, label: '角色扮演引擎', icon: Bot },
    { id: 'appearance' as SettingsTab, label: t.appearance || '外观与语言', icon: Sun },
    { id: 'prompts' as SettingsTab, label: '提示词', icon: MessageSquareText },
  ];

  if (isAdmin) {
    menuItems.push(
      { id: 'models' as SettingsTab, label: '模型管理', icon: Bot },
      { id: 'admin_users' as SettingsTab, label: t.admin_users, icon: Users },
      { id: 'admin_auth' as SettingsTab, label: '认证设置', icon: Key },
      { id: 'admin_defaults' as SettingsTab, label: t.admin_defaults, icon: Shield },
      { id: 'admin_plugins' as SettingsTab, label: '插件管理', icon: Puzzle }
    );
  }
  
  menuItems.push(
    { id: 'usage' as SettingsTab, label: '用量统计', icon: Zap },
    { id: 'about' as SettingsTab, label: t.settings_about, icon: AlertCircle }
  );

  // 移动端菜单分组（仅 md:hidden 分支消费）：iOS 风格分组列表，桌面侧栏仍是平铺 menuItems
  const mobileMenuGroups: { title: string; ids: SettingsTab[] }[] = [
    { title: '账号', ids: ['profile', 'oc'] },
    { title: '角色扮演', ids: ['roleplay_engine', 'prompts'] },
    { title: '通用', ids: ['appearance', 'usage', 'about'] },
  ];
  if (isAdmin) {
    mobileMenuGroups.push({ title: '管理', ids: ['models', 'admin_users', 'admin_auth', 'admin_defaults', 'admin_plugins'] });
  }

  return (
    <div className={cn('relative flex h-full overflow-hidden', isMobile ? '' : 'bg-background' /* 移动端透明：轨道容器层垫屏幕锚定的单一渐变 */)}>
      {/* Desktop Sidebar - Vertical Navigation */}
      <div className="hidden md:flex w-64 flex-shrink-0 border-r border-border/50 bg-background flex-col">
        {/* Sidebar Header */}
        <div className="h-14 flex items-center justify-between px-4 sm:px-6 border-b border-border/50 bg-background z-10">
          <span className="text-base sm:text-sm font-semibold text-foreground truncate">{t.nav_config}</span>
        </div>
        
        {/* Sidebar Navigation */}
        <ScrollArea className="flex-1 px-2 py-2">
          <div className="space-y-1">
            {menuItems.map(item => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left",
                  activeTab === item.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <item.icon size={18} className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      
      {/* Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* 顶栏已按用户拍板（2026-09-06 实验）整体删除：无毛玻璃条、无「设置」标题，
            内容沉浸式直达顶部；安全区仅以 spacer 让出状态栏高度。 */}
        {/* 二级页悬浮返回键（用户拍板 2026-09-06）：样式对齐角色聊天页 ChatHeader 同款圆钮 */}
        {isMobile && mobileTabSelected && (
          <button
            onClick={() => setMobileTabSelected(false)}
            aria-label="返回设置菜单"
            className="absolute z-30 flex !h-10 !w-10 items-center justify-center rounded-full border border-[#ddd4c5]/40 bg-transparent backdrop-blur-[20px] transition-all duration-300 ease-in-out active:scale-95 hover:!bg-[#FFFAFA]/30 dark:hover:!bg-white/[0.05]"
            style={{ top: 'calc(max(env(safe-area-inset-top), 8px) + 4px)', left: '1.25rem' }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        )}
        {/* Mobile - Vertical Tabs (scrollable with bottom safe area) */}
        {!mobileTabSelected && isMobile && (
          <div
            className={`flex-1 md:hidden overflow-y-auto overflow-x-hidden px-4 py-3 ${bottomPadding}`}
            // 移除固定的 paddingTop，由下方 spacer 精确提供 = header 完整高度
          >
            {/* 顶部安全空间：高度与 header 完全一致(safe+3rem+8px)，确保"个人资料"等第一个按钮不被 header 挡住 */}
            <div aria-hidden style={{ height: 'max(env(safe-area-inset-top), 8px)', width: '100%' }} />
            <div className="space-y-5">
              {mobileMenuGroups.map(group => {
                const items = menuItems.filter(mi => group.ids.includes(mi.id));
                if (items.length === 0) return null;
                return (
                  <div key={group.title}>
                    <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground/80">{group.title}</p>
                    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/40">
                      {items.map(item => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setActiveTab(item.id);
                            setMobileTabSelected(true);
                          }}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-secondary/70 min-h-[52px]"
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
                            <item.icon size={15} className="text-muted-foreground" />
                          </span>
                          <span className="flex-1 truncate text-[15px] font-medium">{item.label}</span>
                          <ChevronRight size={16} className="shrink-0 text-muted-foreground/50" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        
        {(mobileTabSelected || isDesktop) && (
          <div
            className="flex-1 min-w-0 w-full p-4 md:p-8 h-full overflow-y-auto overflow-x-hidden"
            // 移动端移除固定 paddingTop，由滚动流首部的安全区 spacer 精确提供
          >
            <div className="max-w-4xl mx-auto h-full overflow-y-auto overflow-x-hidden">
              {/* 安全区必须位于滚动容器内部：初始让出「状态栏 + 返回键高度」，
                  按钮下方首屏无元素被遮挡；spacer 自身透明且随内容一起滚动，
                  下滚时内容可自然从返回键后方穿过显示（沉浸穿透） */}
              <div
                aria-hidden
                style={{
                  height: isMobile && mobileTabSelected
                    ? 'calc(max(env(safe-area-inset-top), 8px) + 40px)'
                    : 'max(env(safe-area-inset-top), 8px)',
                  width: '100%',
                }}
              />
              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <ProfileTab
                  t={t}
                  user={user}
                  avatarUrl={avatarUrl}
                  setAvatarUrl={setAvatarUrl}
                  avatarType={avatarType}
                  setAvatarType={setAvatarType}
                  newUsername={newUsername}
                  setNewUsername={setNewUsername}
                  showPasswordForm={showPasswordForm}
                  setShowPasswordForm={setShowPasswordForm}
                  pwdOld={pwdOld}
                  setPwdOld={setPwdOld}
                  pwdNew={pwdNew}
                  setPwdNew={setPwdNew}
                  handleImageUpload={handleImageUpload}
                  handleUpdateProfile={handleUpdateProfile}
                  handleChangePassword={handleChangePassword}
                  onLogout={onLogout}
                />
              )}

          {/* Models Tab - Unified Model Management */}
          {activeTab === 'models' && (
            <ModelManagementTab
              t={t}
              isAdmin={isAdmin}
              providers={providers}
              providerStatus={providerStatus}
              handleEditProvider={handleEditProvider}
              testProviderConnection={testProviderConnection}
              handleDeleteProvider={handleDeleteProvider}
              localModels={localModels}
              fetchLocalModels={fetchLocalModels}
              uploadProgress={uploadProgress}
              handleModelUpload={handleModelUpload}
              handleModelEnable={handleModelEnable}
              handleModelDelete={handleModelDelete}
              handleMmprojToggle={handleMmprojToggle}
            />
          )}

          {/* Admin Defaults Tab */}
          {activeTab === 'admin_defaults' && isAdmin && (
            <AdminDefaultsTab
              t={t}
              systemDefaults={systemDefaults}
              models={models}
              onUpdateDefaults={onUpdateDefaults}
              bottomPadding={bottomPadding}
            />
          )}

          {/* Admin Plugins Tab */}
          {activeTab === 'admin_plugins' && isAdmin && (
            <div className={`space-y-4 md:space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <AdminPluginsTab />
            </div>
          )}

          {/* Admin Auth Tab */}
          {activeTab === 'admin_auth' && isAdmin && (
            <AuthSettingsTab t={t} token={token} />
          )}

          {/* Admin Users Tab */}
          {activeTab === 'admin_users' && isAdmin && (
            <AdminUsersTab
              t={t}
              usersList={usersList}
              onRefreshUsers={fetchUsers}
              onDeleteUser={handleDeleteUser}
              onViewUsage={(u) => { setViewingUser(u); setActiveTab('user_usage'); }}
              bottomPadding={bottomPadding}
            />
          )}

          {/* Roleplay Engine Tab */}
          {activeTab === 'roleplay_engine' && (
            <RoleplayEngineTab
              bottomPadding={bottomPadding}
              onOpenAdminPlugins={() => setActiveTab('admin_plugins')}
            />
          )}

          {/* Appearance Tab */}
          {activeTab === 'appearance' && (
            <AppearanceTab
              t={t}
              isDark={isDark}
              themeMode={themeMode}
              onThemeSet={onThemeSet}
              lang={lang}
              onLangToggle={onLangToggle}
              models={models}
              bottomPadding={bottomPadding}
            />
          )}

          {/* Prompts Tab */}
          {activeTab === 'prompts' && (
            <div className={`animate-fade-in pr-2 ${bottomPadding}`}>
              <PromptSettings token={token} />
            </div>
          )}

          {/* OC Settings Tab */}
          {activeTab === 'oc' && (
            <div className="h-full">
              <OCSettings token={token} models={models} />
            </div>
          )}

          {/* Usage Tab */}
          {activeTab === 'usage' && (
            <div className={`animate-fade-in ${bottomPadding}`}>
              <TokenUsagePanel token={token} />
            </div>
          )}

          {/* User Usage Tab */}
          {activeTab === 'user_usage' && viewingUser && (
            <div className={`animate-fade-in ${bottomPadding}`}>
              <div className="mb-4">
                <Button
                  variant="ghost"
                  onClick={() => { setActiveTab('admin_users'); setViewingUser(null); }}
                  className="mb-4"
                >
                  <ChevronDown size={18} className="mr-2 -rotate-90" />
                  返回用户管理
                </Button>
              </div>
              <TokenUsagePanel 
                token={token} 
                userId={viewingUser.id}
                userName={viewingUser.username}
                hideCharacterUsage={true}
              />
            </div>
          )}

          {/* About Tab */}
          {activeTab === 'about' && (
          <AboutTab t={t} />
          )}
            </div>
          </div>
        )}
      </div>


      <ConfirmDialog
        open={modelDeleteConfirm.open}
        onOpenChange={(open) => setModelDeleteConfirm(prev => ({ ...prev, open }))}
        title="删除本地模型"
        description="确定要删除这个模型吗？此操作不可恢复。"
        confirmText="删除"
        onConfirm={() => doModelDelete(modelDeleteConfirm.modelId)}
      />
      <ConfirmDialog
        open={userDeleteConfirm.open}
        onOpenChange={(open) => setUserDeleteConfirm(prev => ({ ...prev, open }))}
        title={t.confirm_delete_user?.split('？')[0] || '删除用户'}
        description={t.confirm_delete_user || '确定要删除该用户吗？此操作不可恢复。'}
        confirmText="删除"
        onConfirm={() => doDeleteUser(userDeleteConfirm.userId)}
      />
      <ConfirmDialog
        open={providerDeleteConfirm.open}
        onOpenChange={(open) => setProviderDeleteConfirm(prev => ({ ...prev, open }))}
        title="删除服务商"
        description="确定要删除此服务商并清除其模型配置吗？此操作不可恢复。"
        confirmText="删除"
        onConfirm={() => doDeleteProvider(providerDeleteConfirm.providerId)}
      />
    </div>
  );
};
