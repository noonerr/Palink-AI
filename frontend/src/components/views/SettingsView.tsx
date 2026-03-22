import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { 
  User, 
  Sparkles, 
  AlertCircle, 
  Users, 
  Shield, 
  HelpCircle,
  Save,
  Plus,
  Edit3,
  Trash2,
  X,
  Bot,
  Database,
  UploadCloud,
  LogOut,
  Key,
  ChevronDown,
  Sun,
  Moon,
  RefreshCw,
  Zap,
  MessageSquareText
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { OCSettings } from '@/components/ui/custom/OCSettings';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { TokenUsagePanel } from '@/components/ui/custom/TokenUsagePanel';
import { ModelEditor } from './ModelEditor';
import { PRESETS, EMOJIS } from './settings-constants';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import type { Model, Provider, User as UserType } from '@/types';

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
  lang?: string;
  onLangToggle?: () => void;
  switchDevice?: (newDevice: 'desktop' | 'mobile') => void;
  currentDevice?: 'desktop' | 'mobile';
}

type SettingsTab = 'profile' | 'appearance' | 'language' | 'models' | 'memory' | 'oc' | 'admin_users' | 'admin_defaults' | 'admin_starters' | 'about' | 'usage' | 'user_usage';
type ModelSubTab = 'llm' | 'local';

export const SettingsView: React.FC<SettingsViewProps> = ({
  token,
  user,
  models,
  systemDefaults,
  onLogout,
  onUpdateDefaults,
  t,
  isDark,
  onThemeToggle,
  lang,
  onLangToggle,
  switchDevice,
  currentDevice
}) => {
  const bottomPadding = useMobileBottomPadding();
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [modelSubTab, setModelSubTab] = useState<ModelSubTab>('llm');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
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

  // Memory mode state
  const [memoryMode, setMemoryMode] = useState<string>('rule');
  const [showModelReasoning, setShowModelReasoning] = useState<boolean>(true);
  const [promptLanguage, setPromptLanguage] = useState<string>('auto');

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
  const [starterQuestions, setStarterQuestions] = useState<string[]>([]);
  const [startersExpanded, setStartersExpanded] = useState(false);
  const [mobileTabSelected, setMobileTabSelected] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);

  // Provider edit state
  const [pName, setPName] = useState('');
  const [pUrl, setPUrl] = useState('');
  const [pKey, setPKey] = useState('');
  const [pModels, setPModels] = useState<Model[]>([]);
  const [configExpanded, setConfigExpanded] = useState(false);

  // Confirm dialog state
  const [modelDeleteConfirm, setModelDeleteConfirm] = useState<{ open: boolean; modelId: string }>({ open: false, modelId: '' });
  const [userDeleteConfirm, setUserDeleteConfirm] = useState<{ open: boolean; userId: string }>({ open: false, userId: '' });
  const [providerDeleteConfirm, setProviderDeleteConfirm] = useState<{ open: boolean; providerId: string }>({ open: false, providerId: '' });
  const [viewingUser, setViewingUser] = useState<UserType | null>(null);

  const isAdmin = user.role === 'admin';

  useEffect(() => {
    const checkIsDesktop = () => {
      setIsDesktop(window.innerWidth >= 768);
    };
    
    checkIsDesktop();
    window.addEventListener('resize', checkIsDesktop);
    
    return () => window.removeEventListener('resize', checkIsDesktop);
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchProviders();
      fetchUsers();
      fetchStarters();
      fetchLocalModels();
    }
    // Load memory settings
    fetchMemoryMode();
  }, [isAdmin]);

  const fetchMemoryMode = async () => {
    try {
      const settings = await api.get('/api/users/me/settings');
      setMemoryMode(settings.memory_mode || 'rule');
      setShowModelReasoning(settings.show_model_reasoning !== false);
      setPromptLanguage(settings.prompt_language || 'auto');
    } catch (e) {
      console.error('Failed to fetch memory mode:', e);
    }
  };

  const handleSaveMemoryMode = async (newMode: string) => {
    try {
      await api.put('/api/users/me/settings', { memory_mode: newMode });
      setMemoryMode(newMode);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
    } catch (e) {
      console.error('Failed to save memory mode:', e);
      toast.error('保存记忆模式失败');
    }
  };

  const handleSaveModelReasoning = async (enabled: boolean) => {
    try {
      await api.put('/api/users/me/settings', { show_model_reasoning: enabled });
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
      setPromptLanguage(newLang);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { promptLanguage: newLang } }));
    } catch (e) {
      console.error('Failed to save prompt language:', e);
      toast.error('保存提示词语言失败');
    }
  };

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
    } catch (e) { 
      console.error(e);
      toast.error('设置模型状态失败');
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

    // 发送请求
    xhr.open('POST', '/api/admin/models/local/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);

    // 重置文件输入
    e.target.value = '';
  };

  const handleModelDelete = (modelId: string) => {
    setModelDeleteConfirm({ open: true, modelId });
  };

  const doModelDelete = async (modelId: string) => {
    try {
      const data = await api.delete(`/api/admin/models/local/${modelId}`);
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
    } catch (e) {}
  };

  const fetchUsers = async () => {
    try {
      const data = await api.get('/api/admin/users');
      setUsersList(data);
    } catch (e) {}
  };

  const fetchStarters = async () => {
    try {
      const data = await api.get('/api/recommendations/starters');
      setStarterQuestions(data);
    } catch (e) {}
  };

  const handleUpdateProfile = async () => {
    try {
      await api.put('/api/users/me', { avatar: avatarUrl, username: newUsername });
      toast.success('Profile updated');
    } catch (e) {}
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
    } catch (e) {}
  };


  const handleDeleteUser = (userId: string) => {
    setUserDeleteConfirm({ open: true, userId });
  };

  const doDeleteUser = async (userId: string) => {
    try {
      await api.delete(`/api/admin/users/${userId}`);
      setUsersList(usersList.filter((u: UserType) => u.id !== userId));
      toast.success(t.user_deleted || '用户已删除');
    } catch (e) {
      toast.error(t.delete_user_error || '删除用户出错');
    }
  };

  const handleSaveStarters = async () => {
    try {
      await api.post('/api/admin/recommendations/starters', starterQuestions);
      toast.success('Starters saved');
    } catch (e) {}
  };

  const handleEditProvider = (provider?: Provider) => {
    if (provider) {
      const normalizedModels = (provider.models || []).map(model => {
        const normalizedModel: any = { ...model };
        
        // 确保 name 和 alias 都正确设置
        if (!normalizedModel.name && normalizedModel.alias) {
          normalizedModel.name = normalizedModel.alias;
        }
        if (!normalizedModel.alias && normalizedModel.name) {
          normalizedModel.alias = normalizedModel.name;
        }
        if (!normalizedModel.name && !normalizedModel.alias) {
          normalizedModel.name = normalizedModel.id || '';
          normalizedModel.alias = normalizedModel.id || '';
        }
        
        return normalizedModel;
      });
      
      setEditingProvider(provider);
      setPName(provider.name);
      setPUrl(provider.base_url);
      setPKey(provider.api_key);
      setPModels(normalizedModels);
    } else {
      setEditingProvider({ id: '', name: '', base_url: '', api_key: '', models: [] });
      setPName('');
      setPUrl('');
      setPKey('');
      setPModels([]);
    }
  };

  const applyPreset = (preset: typeof PRESETS[0]) => {
    setPName(preset.name);
    setPUrl(preset.url);
    setPModels(preset.models.map(m => ({
      id: m,
      name: m,
      provider: preset.name,
      context_length: 4096,
      icon: '🤖'
    })));
  };

  const ensureUrlHasProtocol = (url: string): string => {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return 'http://' + url;
  };

  const handleSaveProvider = async () => {
    const modelsToSave = pModels.map(model => {
      // 确保每个模型同时有 id, name 和 alias 字段
      const saveModel: any = { 
        ...model,
        id: model.id || '',
        name: model.name || model.alias || model.id || '',
        alias: model.alias || model.name || model.id || ''
      };
      return saveModel;
    });
    
    const newProvider: Provider = {
      id: editingProvider?.id || `prov-${Date.now()}`,
      name: pName,
      base_url: ensureUrlHasProtocol(pUrl),
      api_key: pKey,
      models: modelsToSave,
      is_active: true
    };

    const newList = editingProvider?.id
      ? providers.map(p => p.id === editingProvider.id ? newProvider : p)
      : [...providers, newProvider];

    try {
      await api.post('/api/admin/providers', newList);
      setEditingProvider(null);
      fetchProviders();
      window.dispatchEvent(new CustomEvent('modelsUpdated'));
    } catch (e) {
      console.error('保存出错:', e);
    }
  };

  const handleDeleteProvider = (id: string) => {
    setProviderDeleteConfirm({ open: true, providerId: id });
  };

  const doDeleteProvider = async (id: string) => {
    try {
      await api.post('/api/admin/providers', providers.filter(p => p.id !== id));
      fetchProviders();
    } catch (e) {}
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
    { id: 'oc' as SettingsTab, label: '原创角色(OC)', icon: User },
    { id: 'appearance' as SettingsTab, label: t.appearance || '外观', icon: Sun },
    { id: 'language' as SettingsTab, label: t.language || '语言', icon: AlertCircle },
  ];

  if (isAdmin) {
    menuItems.push(
      { id: 'models' as SettingsTab, label: '模型管理', icon: Bot },
      { id: 'admin_users' as SettingsTab, label: t.admin_users, icon: Users },
      { id: 'admin_defaults' as SettingsTab, label: t.admin_defaults, icon: Shield }
    );
  }
  
  menuItems.push(
    { id: 'usage' as SettingsTab, label: '用量统计', icon: Zap },
    { id: 'about' as SettingsTab, label: t.settings_about, icon: AlertCircle }
  );

  return (
    <div className="flex h-full relative">
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
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Mobile Header */}
        <div className="md:hidden border-b border-border/50 bg-background z-10 shrink-0">
          <div className="h-14 flex items-center justify-between px-4 border-b border-border/50 bg-background z-10">
            {mobileTabSelected ? (
              <button
                onClick={() => setMobileTabSelected(false)}
                className="flex items-center gap-1 text-sm font-medium"
              >
                返回
              </button>
            ) : (
              <h2 className="text-lg font-semibold">{t.nav_config}</h2>
            )}
          </div>
          {/* Mobile - Vertical Tabs */}
          {!mobileTabSelected && (
            <div className="px-4 py-3">
              <div className="space-y-2">
                {menuItems.map(item => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileTabSelected(true);
                    }}
                    className="w-full flex items-center justify-between p-3 rounded-xl transition-all bg-secondary hover:bg-secondary/80"
                  >
                    <div className="flex items-center gap-3">
                      <item.icon size={18} className="text-muted-foreground" />
                      <span className="font-medium">{item.label}</span>
                    </div>
                    <ChevronDown size={18} className="text-muted-foreground rotate-90" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        
        {(mobileTabSelected || isDesktop) && (
          <div className="flex-1 p-4 md:p-8 h-full overflow-hidden">
            <div className="max-w-4xl mx-auto h-full">
              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <ScrollArea className="h-full">
                  <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
                  <h3 className="text-2xl font-semibold">{t.settings_profile}</h3>
                
                <GlassCard className="p-6">
                  <div className="flex items-start gap-6">
                    <Avatar className="w-20 h-20">
                      <AvatarImage src={avatarUrl} />
                      <AvatarFallback className="text-2xl bg-primary/10">
                        {user.username?.[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    
                    <div className="flex-1 space-y-4">
                      <div className="flex gap-2">
                        {(['emoji', 'image', 'url'] as const).map(type => (
                          <button
                            key={type}
                            onClick={() => setAvatarType(type)}
                            className={cn(
                              "px-3 py-1.5 text-xs rounded-full border transition-all",
                              avatarType === type
                                ? "bg-primary text-primary-foreground border-primary"
                                : "border-border text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {type === 'emoji' ? t.choose_emoji : type === 'image' ? t.upload_image : t.use_url}
                          </button>
                        ))}
                      </div>

                      {avatarType === 'image' && (
                        <label className="border-2 border-dashed border-border rounded-xl p-6 text-center hover:bg-secondary/50 transition-colors cursor-pointer block">
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleImageUpload}
                          />
                          <UploadCloud className="mx-auto text-muted-foreground mb-2" size={24} />
                          <span className="text-sm text-muted-foreground">{t.click_to_upload}</span>
                        </label>
                      )}

                      {avatarType === 'emoji' && (
                        <div className="grid grid-cols-8 gap-2">
                          {EMOJIS.map(e => (
                            <button
                              key={e}
                              onClick={() => setAvatarUrl(e)}
                              className={cn(
                                "p-2 hover:bg-secondary rounded-lg text-xl transition-all",
                                avatarUrl === e && "bg-primary/10 ring-2 ring-primary"
                              )}
                            >
                              {e}
                            </button>
                          ))}
                        </div>
                      )}

                      {avatarType === 'url' && (
                        <Input
                          value={avatarUrl}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAvatarUrl(e.target.value)}
                          placeholder="https://..."
                        />
                      )}
                    </div>
                  </div>

                <div className="mt-6 pt-6 border-t border-border/50">
                  <label className="text-sm font-medium mb-2 block">{t.settings_username}</label>
                  <Input
                    value={newUsername}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewUsername(e.target.value)}
                    placeholder="Username"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{t.settings_username_desc}</p>
                </div>

                <div className="mt-6 flex justify-end">
                  <Button onClick={handleUpdateProfile}>
                    <Save size={16} className="mr-2" />
                    {t.save}
                  </Button>
                </div>
              </GlassCard>

              {/* 账户安全 - 统一的账户安全管理模块 */}
              <GlassCard className="p-6 border-destructive/50">
                <h4 className="font-semibold text-destructive mb-4 flex items-center gap-2">
                  <Shield size={18} />
                  {t.settings_danger_zone}
                </h4>
                
                {/* 修改密码 - 二级菜单 */}
                <div 
                  className="flex items-center justify-between cursor-pointer py-3 border-b border-border/50"
                  onClick={() => setShowPasswordForm(!showPasswordForm)}
                >
                  <div className="flex items-center gap-2">
                    <Key size={16} className="text-muted-foreground" />
                    <span className="text-sm">{t.change_pwd}</span>
                  </div>
                  <ChevronDown 
                    size={16} 
                    className={`text-muted-foreground transition-transform ${showPasswordForm ? 'rotate-180' : ''}`}
                  />
                </div>
                
                {showPasswordForm && (
                  <div className="mt-4 pt-4 border-t border-border/50 animate-fade-in">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <Input
                        type="password"
                        placeholder={t.old_pwd}
                        value={pwdOld}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPwdOld(e.target.value)}
                      />
                      <Input
                        type="password"
                        placeholder={t.new_pwd}
                        value={pwdNew}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPwdNew(e.target.value)}
                      />
                    </div>
                    <div className="mt-4 flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => {setShowPasswordForm(false); setPwdOld(''); setPwdNew('');}}>
                        {t.cancel || '取消'}
                      </Button>
                      <Button onClick={handleChangePassword}>
                        {t.save || '保存'}
                      </Button>
                    </div>
                  </div>
                )}

                {/* 退出登录 */}
                <div className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    <LogOut size={16} className="text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{t.logout}</p>
                      <p className="text-xs text-muted-foreground">{t.logout_desc}</p>
                    </div>
                  </div>
                  <Button variant="destructive" size="sm" onClick={onLogout}>
                    {t.logout}
                  </Button>
                </div>
              </GlassCard>
                  </div>
                </ScrollArea>
              )}

          {/* Models Tab */}
          {activeTab === 'models' && (
            <div className="flex flex-col h-full animate-fade-in">
              {/* Sub Tabs */}
              <div className="flex items-center gap-2 border-b border-border/50 pb-4 shrink-0">
                <button
                  onClick={() => setModelSubTab('llm')}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    modelSubTab === 'llm'
                      ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  )}
                >
                  <Sparkles size={16} />
                  {t.language_models || '语言模型'}
                </button>
                {isAdmin && (
                  <button
                    onClick={() => setModelSubTab('local')}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                      modelSubTab === 'local'
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    <Database size={16} />
                    {t.local_models || '本地模型'}
                  </button>
                )}
              </div>

              {/* LLM Sub Tab */}
              {modelSubTab === 'llm' && (
                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-6 animate-fade-in pr-2 pt-4">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-2xl font-semibold">{t.provider_config}</h3>
                      <Button onClick={() => handleEditProvider()}>
                        <Plus size={16} className="mr-2" />
                        {t.add_provider}
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {providers.map(provider => {
                      const status = providerStatus[provider.id];
                      return (
                        <GlassCard
                          key={provider.id}
                          className="p-4 sm:p-5 hover:shadow-lg transition-all group"
                          hover
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-2">
                                {/* Status Indicator */}
                                <div 
                                  className={`w-2.5 h-2.5 rounded-full ${
                                    status?.success === true ? 'bg-green-500' :
                                    status?.success === false ? 'bg-red-500' :
                                    'bg-gray-400'
                                  } ${status?.testing ? 'animate-pulse' : ''}`}
                                  title={status?.message || '未测试'}
                                />
                                <h4 className="font-semibold truncate text-sm sm:text-base">{provider.name}</h4>
                                <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                                  {(provider.models || []).length} {t.active_models}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground font-mono truncate mb-2">
                                {(() => {
                                  const url = provider.base_url || '';
                                  const withoutProtocol = url.replace(/^https?:\/\//, '');
                                  const hostPart = withoutProtocol.split('/')[0];
                                  return hostPart || url || '未设置';
                                })()}
                              </p>
                              {/* Status Message */}
                              {status && (
                                <p className={`text-xs mb-2 ${
                                  status.success === true ? 'text-green-600' :
                                  status.success === false ? 'text-red-600' :
                                  'text-muted-foreground'
                                }`}>
                                  {status.message}
                                </p>
                              )}
                              <div className="flex items-center gap-2 flex-wrap">
                                {(provider.models || []).slice(0, 3).map((m: Model, i: number) => (
                                  <span key={i} className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">
                                    {m.name?.length > 15 ? m.name.substring(0, 15) + '...' : (m.name || '未命名')}
                                  </span>
                                ))}
                                {(provider.models || []).length > 3 && (
                                  <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">
                                    +{(provider.models || []).length - 3}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between sm:justify-end gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200 dark:border-gray-700">
                              {/* Test Button */}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => testProviderConnection(provider)}
                                disabled={status?.testing}
                              >
                                {status?.testing ? (
                                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-1" />
                                ) : (
                                  <RefreshCw size={14} className="mr-1" />
                                )}
                                测试
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => handleEditProvider(provider)}
                              >
                                <Edit3 size={14} className="mr-1" />
                                编辑
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteProvider(provider.id)}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          </div>
                        </GlassCard>
                      );
                    })}
                  </div>
                  </div>
                </ScrollArea>
              )}

              {/* Local Models Sub Tab */}
              {modelSubTab === 'local' && isAdmin && (
                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-6 animate-fade-in pr-2 pt-4">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-2xl font-semibold">{t.local_models || '本地模型'}</h3>
                      <div className="flex gap-2">
                        <Button onClick={fetchLocalModels}>
                          <Database size={16} className="mr-2" />
                          {t.refresh_models || '刷新模型列表'}
                        </Button>
                        <Button
                          onClick={() => document.getElementById('model-upload-input')?.click()}
                          disabled={uploadProgress !== null}
                        >
                          <UploadCloud size={16} className="mr-2" />
                          {t.upload_model || '上传模型'}
                        </Button>
                        <input
                          type="file"
                          id="model-upload-input"
                          className="hidden"
                          onChange={handleModelUpload}
                          accept=".gguf,.ggml,.bin,.safetensors"
                        />
                      </div>
                    </div>
                    
                    {/* 上传进度条 */}
                    {uploadProgress !== null && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span>上传进度</span>
                          <span>{uploadProgress}%</span>
                        </div>
                        <div className="w-full bg-secondary rounded-full h-2">
                          <div 
                            className="bg-primary h-2 rounded-full transition-all duration-300 ease-in-out" 
                            style={{ width: `${uploadProgress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {localModels.length > 0 ? (
                      localModels.map(model => (
                        <GlassCard
                          key={model.id}
                          className={`p-4 sm:p-5 hover:shadow-lg transition-all group ${!model.enabled ? 'opacity-60' : ''}`}
                          hover
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-2">
                                <h4 className="font-semibold truncate text-sm sm:text-base">{model.name}</h4>
                                {!model.enabled && (
                                  <span className="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">
                                    已禁用
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground font-mono truncate mb-2">
                                {model.path}
                              </p>
                              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                                <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                                  大小: {model.size}GB
                                </span>
                                <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">
                                  类型: {model.type}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between sm:justify-end gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200 dark:border-gray-700">
                              {/* 启用/禁用开关 */}
                              <label className="flex items-center cursor-pointer flex-shrink-0">
                                <input
                                  type="checkbox"
                                  checked={model.enabled !== false}
                                  onChange={(e) => handleModelEnable(model.id, e.target.checked)}
                                  className="sr-only"
                                />
                                <div className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${model.enabled !== false ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}>
                                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${model.enabled !== false ? 'translate-x-5' : ''}`} />
                                </div>
                                <span className="ml-2 text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                                  {model.enabled !== false ? '已启用' : '已禁用'}
                                </span>
                              </label>
                              
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:bg-destructive/10 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0"
                                onClick={() => handleModelDelete(model.id)}
                                title="删除模型"
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          </div>
                        </GlassCard>
                      ))
                    ) : (
                      <GlassCard className="p-8 text-center">
                        <Database size={48} className="mx-auto text-muted-foreground mb-4" />
                        <h4 className="font-semibold mb-2">{t.no_local_models || '暂无本地模型'}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t.upload_model_hint || '请点击上方的"上传模型"按钮上传本地模型文件'}
                        </p>
                      </GlassCard>
                    )}
                  </div>
                  </div>
                </ScrollArea>
              )}
            </div>
          )}

          {/* Admin Defaults Tab */}
          {activeTab === 'admin_defaults' && isAdmin && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-2xl font-semibold">{t.admin_defaults}</h3>
              
              <GlassCard className="p-6">
                <div className="space-y-4">
                  {[
                    { label: t.def_chat_model, value: defChat, set: setDefChat },
                    { label: t.def_ws_model, value: defWs, set: setDefWs },
                    { label: t.def_outline_model, value: defOutline, set: setDefOutline },
                    { label: '解析/翻译人物卡默认模型', value: defCharacterParse, set: setDefCharacterParse },
                    { label: '人物卡翻译默认模型', value: defCharacterTranslate, set: setDefCharacterTranslate },
                    { label: '角色扮演默认模型', value: defCharacterChat, set: setDefCharacterChat },
                    { label: '每日话题生成模型', value: dailyTopicModel, set: setDailyTopicModel },
                    { label: '摘要生成默认模型', value: defSummarization, set: setDefSummarization }
                  ].map((item, i) => (
                    <div key={i} className="flex items-center justify-between py-3 border-b border-border/50 last:border-0">
                      <div className="flex items-center gap-3">
                        <Bot size={18} className="text-muted-foreground" />
                        <span>{item.label}</span>
                      </div>
                      <ModelSelector
                        models={models}
                        currentModel={item.value}
                        onSelect={(modelId: string) => item.set(modelId)}
                        size="sm"
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-3 border-t border-border/50">
                    <div className="flex items-center gap-3">
                      <Sparkles size={18} className="text-muted-foreground" />
                      <div>
                        <p>允许AI分析用户个人OC卡</p>
                        <p className="text-xs text-muted-foreground">启用后AI可以深度分析用户的原创角色设定</p>
                      </div>
                    </div>
                    <Switch
                      checked={allowOCAnalysis}
                      onCheckedChange={setAllowOCAnalysis}
                    />
                  </div>
                  {allowOCAnalysis && (
                    <div className="flex items-center justify-between py-3 border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <Bot size={18} className="text-muted-foreground" />
                        <span>OC分析默认模型</span>
                      </div>
                      <ModelSelector
                        models={models}
                        currentModel={defOCAnalysis}
                        onSelect={setDefOCAnalysis}
                        size="sm"
                      />
                    </div>
                  )}
                </div>

                <div className="mt-6 flex justify-end">
                  <Button onClick={handleSaveDefaults}>
                    <Save size={16} className="mr-2" />
                    {t.save}
                  </Button>
                </div>
              </GlassCard>

              <div className="space-y-4">
                <button
                  onClick={() => setStartersExpanded(!startersExpanded)}
                  className="w-full flex items-center justify-between p-3 rounded-xl transition-all bg-secondary hover:bg-secondary/80"
                >
                  <div className="flex items-center gap-3">
                    <HelpCircle size={18} className="text-muted-foreground" />
                    <span className="font-medium">{t.admin_starters}</span>
                  </div>
                  <ChevronDown
                    size={18}
                    className={cn(
                      "text-muted-foreground transition-transform duration-300",
                      startersExpanded && "rotate-180"
                    )}
                  />
                </button>

                {startersExpanded && (
                  <div className="animate-in slide-in-from-top-2 fade-in duration-300">
                    <GlassCard className="p-6">
                      <p className="text-sm text-muted-foreground mb-4">
                        如果设置了"每日话题生成模型"，可以自动每日生成。
                      </p>
                      <textarea
                        value={starterQuestions.join('\n')}
                        onChange={e => setStarterQuestions(e.target.value.split('\n'))}
                        className="w-full h-48 p-4 rounded-xl bg-secondary border-none outline-none resize-none font-mono text-sm"
                        placeholder={t.enter_question_placeholder}
                      />
                      <div className="mt-4 flex justify-end">
                        <Button onClick={handleSaveStarters}>
                          <Save size={16} className="mr-2" />
                          {t.save}
                        </Button>
                      </div>
                    </GlassCard>
                  </div>
                )}
              </div>
              </div>
            </ScrollArea>
          )}

          {/* Admin Users Tab */}
          {activeTab === 'admin_users' && isAdmin && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-2xl font-semibold">{t.admin_users}</h3>
              
              <div className="space-y-2">
                {usersList.map(u => (
                  <GlassCard key={u.id} className="p-4">
                    <div className="flex items-center justify-between">
                      <button 
                        onClick={() => { setViewingUser(u); setActiveTab('user_usage'); }}
                        className="flex items-center gap-4 text-left flex-1"
                      >
                        <Avatar>
                          <AvatarImage src={u.avatar} />
                          <AvatarFallback>{u.username?.[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{u.username}</p>
                            <span className="text-xs text-muted-foreground">
                              {t.role}: {u.role}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                            <div className="p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-blue-500 font-medium">输入</p>
                              <p className="text-sm font-bold">{(u.tokens_chat || 0) + (u.tokens_workspace || 0) + (u.tokens_character || 0)}</p>
                            </div>
                            <div className="p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-green-500 font-medium">输出</p>
                              <p className="text-sm font-bold">0</p>
                            </div>
                            <div className="p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-muted-foreground font-medium">请求</p>
                              <p className="text-sm font-bold">{u.chat_count}次</p>
                            </div>
                            <div className="p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-muted-foreground font-medium">存储</p>
                              <p className="text-sm font-bold">{(u.storage_used! / 1024 / 1024).toFixed(1)}MB</p>
                            </div>
                          </div>
                        </div>
                      </button>
                      <div className="flex gap-2 ml-2">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="text-destructive hover:bg-destructive/10"
                          onClick={(e) => { e.stopPropagation(); handleDeleteUser(u.id); }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
              </div>
            </ScrollArea>
          )}

          {/* Appearance Tab */}
          {activeTab === 'appearance' && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-2xl font-semibold">{t.appearance || '外观设置'}</h3>
              
              <GlassCard className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      {isDark ? <Moon size={20} className="text-muted-foreground" /> : <Sun size={20} className="text-muted-foreground" />}
                      <div>
                        <p className="font-medium">{t.theme || '主题'}</p>
                        <p className="text-xs text-muted-foreground">{isDark ? t.dark_mode || '深色模式' : t.light_mode || '浅色模式'}</p>
                      </div>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={onThemeToggle}
                      disabled={!onThemeToggle}
                    >
                      {isDark ? <Sun size={16} className="mr-2" /> : <Moon size={16} className="mr-2" />}
                      {isDark ? t.switch_light || '切换浅色' : t.switch_dark || '切换深色'}
                    </Button>
                  </div>

                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <Zap size={20} className="text-muted-foreground" />
                      <div>
                        <p className="font-medium">模型深度思考</p>
                        <p className="text-xs text-muted-foreground">显示模型的思考过程</p>
                      </div>
                    </div>
                    <Button
                      variant={showModelReasoning ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => handleSaveModelReasoning(!showModelReasoning)}
                    >
                      {showModelReasoning ? '已开启' : '已关闭'}
                    </Button>
                  </div>

                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <Database size={20} className="text-muted-foreground" />
                      <div>
                        <p className="font-medium">{t.memory_mode || '记忆模式'}</p>
                        <p className="text-xs text-muted-foreground">{t.memory_mode_desc || '向量记忆提供更好的语义理解和更大的记忆容量'}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant={memoryMode === 'rule' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveMemoryMode('rule')}
                      >
                        {t.memory_mode_rule || '规则记忆'}
                      </Button>
                      <Button
                        variant={memoryMode === 'vector' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveMemoryMode('vector')}
                      >
                        {t.memory_mode_vector || '向量记忆'}
                      </Button>
                    </div>
                  </div>
                </div>
              </GlassCard>
              </div>
            </ScrollArea>
          )}

          {/* Language Tab */}
          {activeTab === 'language' && (
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-2xl font-semibold">{t.language || '语言设置'}</h3>
              
              <GlassCard className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-semibold w-8 text-center">{lang?.toUpperCase()}</span>
                      <div>
                        <p className="font-medium">{t.current_language || '当前语言'}</p>
                        <p className="text-xs text-muted-foreground">
                          {lang === 'zh' ? '简体中文' : lang === 'en' ? 'English' : lang}
                        </p>
                      </div>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={onLangToggle}
                      disabled={!onLangToggle}
                    >
                      {t.switch_language || '切换语言'}
                    </Button>
                  </div>

                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <MessageSquareText size={20} className="text-muted-foreground" />
                      <div>
                        <p className="font-medium">{t.prompt_language || '提示词语言'}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.prompt_language_desc || '角色扮演时 AI 提示词的语言'}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant={promptLanguage === 'auto' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSavePromptLanguage('auto')}
                      >
                        {t.prompt_lang_auto || '自动'}
                      </Button>
                      <Button
                        variant={promptLanguage === 'zh' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSavePromptLanguage('zh')}
                      >
                        {t.prompt_lang_zh || '中文'}
                      </Button>
                      <Button
                        variant={promptLanguage === 'en' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSavePromptLanguage('en')}
                      >
                        {t.prompt_lang_en || 'English'}
                      </Button>
                    </div>
                  </div>
                </div>
              </GlassCard>
              </div>
            </ScrollArea>
          )}

          {/* OC Settings Tab */}
          {activeTab === 'oc' && (
            <div className="h-full">
              <OCSettings token={token} models={models} />
            </div>
          )}

          {/* Usage Tab */}
          {activeTab === 'usage' && (
            <ScrollArea className="h-full">
              <div className={`p-4 sm:p-6 ${bottomPadding}`}>
                <TokenUsagePanel token={token} />
              </div>
            </ScrollArea>
          )}

          {/* User Usage Tab */}
          {activeTab === 'user_usage' && viewingUser && (
            <ScrollArea className="h-full">
              <div className={`p-4 sm:p-6 ${bottomPadding}`}>
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
            </ScrollArea>
          )}

          {/* About Tab */}
          {activeTab === 'about' && (
            <ScrollArea className="h-full">
              <div className={`text-center py-12 animate-fade-in pr-2 ${bottomPadding}`}>
              <div className="w-24 h-24 bg-gradient-to-br from-primary to-primary/60 rounded-3xl mx-auto flex items-center justify-center mb-6 shadow-xl shadow-primary/20">
                <span className="text-primary-foreground text-4xl font-bold">P</span>
              </div>
              <h2 className="text-2xl font-semibold mb-2">{t.about_title}</h2>
              <p className="text-muted-foreground mb-8">{t.about_desc}</p>
              <div className="flex justify-center gap-4 text-sm text-muted-foreground">
                <span>{t.version}</span>
                <span>•</span>
                <span>{t.privacy_policy}</span>
              </div>
              </div>
            </ScrollArea>
          )}
            </div>
          </div>
        )}
      </div>

      {/* Provider Edit Modal */}
      {editingProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4 sm:p-6 animate-in fade-in duration-200">
          <div className="bg-background/95 backdrop-blur-xl w-full max-w-6xl rounded-3xl shadow-2xl border border-border/50 flex flex-col max-h-[92vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 sm:px-8 py-5 border-b border-border/60 bg-gradient-to-b from-background/80 to-background/40">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg shadow-primary/20">
                  <Key size={20} className="text-primary-foreground" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-foreground">
                    {editingProvider.id ? t.edit_provider : t.add_provider_title}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    配置您的 AI 提供商连接信息
                  </p>
                </div>
              </div>
              <button
                onClick={() => setEditingProvider(null)}
                className="p-2.5 hover:bg-secondary rounded-xl transition-all hover:scale-105 active:scale-95"
              >
                <X size={20} className="text-muted-foreground" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className={`px-6 sm:px-8 py-6 sm:py-8 ${bottomPadding}`}>
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
                  <div className="xl:col-span-4 space-y-5">
                    {!editingProvider.id && (
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          快速预设
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          {PRESETS.map(preset => (
                            <button
                              key={preset.name}
                              onClick={() => applyPreset(preset)}
                              className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-br from-secondary/80 to-secondary hover:from-secondary hover:to-secondary/80 text-sm font-medium transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] border border-border/30"
                            >
                              <span className="text-lg">{preset.icon}</span>
                              <span className="truncate">{preset.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-card/80 to-card overflow-hidden transition-all duration-300">
                      <button
                        onClick={() => setConfigExpanded(!configExpanded)}
                        className="w-full flex items-center justify-between p-5 text-left hover:bg-background/30 transition-all duration-200"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
                            <span className="text-primary text-lg">⚙️</span>
                          </div>
                          <div>
                            <h4 className="font-semibold text-foreground">连接配置</h4>
                            <p className="text-xs text-muted-foreground">
                              {configExpanded ? '点击收起配置选项' : '点击展开配置选项'}
                            </p>
                          </div>
                        </div>
                        <div className={cn(
                          "w-9 h-9 rounded-lg bg-secondary flex items-center justify-center transition-all duration-300",
                          configExpanded && "bg-primary/10"
                        )}>
                          <ChevronDown
                            size={20}
                            className={cn(
                              "text-muted-foreground transition-transform duration-300",
                              configExpanded && "rotate-180 text-primary"
                            )}
                          />
                        </div>
                      </button>

                      <div className={cn(
                        "overflow-hidden transition-all duration-700 ease-in-out",
                        configExpanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
                      )}>
                        <div className="px-5 pb-5 pt-2 space-y-5 border-t border-border/50">
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                显示名称
                              </label>
                              <div className="relative">
                                <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                  value={pName}
                                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPName(e.target.value)}
                                  placeholder="Provider Name"
                                  className="h-11 pl-10 bg-background/60"
                                />
                              </div>
                            </div>

                              <div className="space-y-2">
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                  API 代理地址
                                </label>
                                <div className="flex gap-2">
                                  <div className="flex rounded-lg overflow-hidden border border-input bg-background/60">
                                    <button
                                      onClick={() => {
                                        const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                                        const path = match ? match[2] : pUrl;
                                        setPUrl('http://' + path);
                                      }}
                                      className={cn(
                                        "px-3 py-2 text-sm font-medium transition-all",
                                        (pUrl.startsWith('http://') || (!pUrl.startsWith('http://') && !pUrl.startsWith('https://'))) 
                                          ? "bg-primary text-primary-foreground" 
                                          : "text-muted-foreground hover:bg-secondary"
                                      )}
                                    >
                                      http://
                                    </button>
                                    <button
                                      onClick={() => {
                                        const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                                        const path = match ? match[2] : pUrl;
                                        setPUrl('https://' + path);
                                      }}
                                      className={cn(
                                        "px-3 py-2 text-sm font-medium transition-all border-l border-input",
                                        pUrl.startsWith('https://') 
                                          ? "bg-primary text-primary-foreground" 
                                          : "text-muted-foreground hover:bg-secondary"
                                      )}
                                    >
                                      https://
                                    </button>
                                  </div>
                                  <div className="relative flex-1">
                                    <Input
                                      value={(() => {
                                        const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                                        return match ? match[2] : pUrl;
                                      })()}
                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                        const match = pUrl.match(/^(https?:\/\/)(.*)$/);
                                        const protocol = match ? match[1] : 'http://';
                                        setPUrl(protocol + e.target.value);
                                      }}
                                      placeholder="api.example.com/v1"
                                      className="h-11 font-mono text-sm bg-background/60"
                                    />
                                  </div>
                                </div>
                              </div>

                            <div className="space-y-2">
                              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                API 密钥
                              </label>
                              <div className="relative">
                                <Key size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                  type="password"
                                  value={pKey}
                                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPKey(e.target.value)}
                                  placeholder="sk-..."
                                  className="h-11 pl-10 pr-12 font-mono text-sm bg-background/60"
                                />
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                您的密钥安全存储在本地，不会发送到任何第三方服务器
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="xl:col-span-8">
                    <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-card/50 to-card overflow-hidden">
                      <div className="px-5 py-4 border-b border-border/50 bg-gradient-to-r from-background/50 to-background/30">
                        <div className="flex items-center gap-2">
                          <Bot size={18} className="text-primary" />
                          <span className="font-semibold text-foreground">模型管理</span>
                          <span className="ml-auto text-xs bg-primary/10 text-primary px-2.5 py-1 rounded-full font-medium">
                            {pModels.length} 个模型
                          </span>
                        </div>
                      </div>
                      <div className="p-5">
                        <ModelEditor 
                          models={pModels}
                          onChange={setPModels}
                          providerName={pName}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
              <div className="px-6 sm:px-8 py-5 border-t border-border/60 bg-gradient-to-t from-background/90 to-background/70">
              <Button 
                onClick={handleSaveProvider} 
                className="w-full h-11 text-base font-semibold"
              >
                <Save size={18} className="mr-2" />
                {t.save}
              </Button>
            </div>
          </div>
        </div>
      )}
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
