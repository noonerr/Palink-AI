import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
  Bot,
  Database,
  UploadCloud,
  LogOut,
  ChevronDown,
  Sun,
  Moon,
  RefreshCw,
  Zap,
  MessageSquareText,
  Eye,
  Key,
  Globe,
  Settings2
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
import { ModelManagementTab } from './settings-tabs/ModelManagementTab';
import { EMOJIS } from './settings-constants';
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
type ModelSubTab = 'llm' | 'local' | 'vision';

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
  const navigate = useNavigate();
  const location = useLocation();
  const bottomPadding = useMobileBottomPadding();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const state = location.state as { activeTab?: string } | null;
    if (state?.activeTab && ['profile', 'appearance', 'language', 'models', 'memory', 'oc', 'admin_users', 'admin_defaults', 'admin_starters', 'about', 'usage', 'user_usage'].includes(state.activeTab)) {
      return state.activeTab as SettingsTab;
    }
    return 'profile';
  });
  const [mobileTabSelected, setMobileTabSelected] = useState(() => {
    const state = location.state as { activeTab?: string } | null;
    return !!state?.activeTab;
  });
  const [modelSubTab, setModelSubTab] = useState<ModelSubTab>('llm');

  useEffect(() => {
    if (location.state) {
      window.history.replaceState({}, '');
    }
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
  
  // Ollama model running status
  const [ollamaModelStatus, setOllamaModelStatus] = useState<Record<string, boolean>>({});
  
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
  const [characterDisplayMode, setCharacterDisplayMode] = useState<string>('framed');

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
  const [imageCleanupEnabled, setImageCleanupEnabled] = useState(true);
  const [imageCleanupMaxAge, setImageCleanupMaxAge] = useState(30);
  const [imageCleanupExpanded, setImageCleanupExpanded] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);

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
      fetchImageCleanupConfig();
    }
    // Load memory settings
    fetchMemoryMode();
  }, [isAdmin]);

  const isLocalProvider = (provider: any): boolean => {
    const localKeywords = ['ollama', 'localhost', '127.0.0.1'];
    const providerName = (provider.name || '').toLowerCase();
    const baseUrl = (provider.base_url || '').toLowerCase();
    return localKeywords.some(keyword => 
      providerName.includes(keyword) || baseUrl.includes(keyword)
    ) || baseUrl.startsWith('ollama:');
  };

  const fetchMemoryMode = async () => {
    try {
      const settings = await api.get('/api/users/me/settings');
      setMemoryMode(settings.memory_mode || 'rule');
      setShowModelReasoning(settings.show_model_reasoning !== false);
      setPromptLanguage(settings.prompt_language || 'auto');
      setCharacterDisplayMode(settings.character_display_mode || 'framed');
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

  const handleSaveCharacterDisplayMode = async (mode: string) => {
    try {
      await api.put('/api/users/me/settings', { character_display_mode: mode });
      setCharacterDisplayMode(mode);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated', { detail: { characterDisplayMode: mode } }));
    } catch (e) {
      console.error('Failed to save character display mode:', e);
      toast.error('保存角色扮演显示模式失败');
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
      toast.success(enabled ? '模型已启用' : '模型已禁用');
    } catch (e: any) { 
      console.error(e);
      const detail = e?.detail || e?.message || (typeof e === 'string' ? e : '');
      toast.error(detail ? `设置失败: ${detail}` : '设置模型状态失败');
    }
  };

  const [mmprojFiles, setMmprojFiles] = useState<Array<{filename: string; path: string; size_bytes: number}>>([]);
  const [mmprojSelectorFor, setMmprojSelectorFor] = useState<string | null>(null);

  const fetchMmprojFiles = async () => {
    try {
      const files = await api.get('/api/admin/models/local/mmproj-files');
      setMmprojFiles(files);
    } catch (e) {
      console.error('Failed to fetch mmproj files:', e);
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

  const handleMaxConcurrentChange = async (modelId: string, maxConcurrent: number) => {
    try {
      const modelName = modelId.replace('local:', '');
      await api.put(`/api/admin/models/local/${modelName}/max-concurrent`, {
        max_concurrent: maxConcurrent,
      });
      setLocalModels(prev => prev.map(m =>
        m.id === modelId ? { ...m, max_concurrent: maxConcurrent } : m
      ));
      toast.success(`并发数已设置为 ${maxConcurrent}`);
    } catch (e) {
      console.error(e);
      toast.error('设置并发数失败');
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
    }
  };

  const fetchUsers = async () => {
    try {
      const data = await api.get('/api/admin/users');
      setUsersList(data);
    } catch (e) {
      console.error('Failed to fetch users:', e);
    }
  };

  const fetchStarters = async () => {
    try {
      const data = await api.get('/api/recommendations/starters');
      setStarterQuestions(data);
    } catch (e) {
      console.error('Failed to fetch starters:', e);
    }
  };

  const handleUpdateProfile = async () => {
    try {
      await api.put('/api/users/me', { avatar: avatarUrl, username: newUsername });
      toast.success('Profile updated');
    } catch (e) {
      console.error('Failed to update profile:', e);
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
    }
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
    } catch (e) {
      console.error('Failed to save starters:', e);
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

  // Toggle Ollama model running status
  const toggleOllamaModel = async (provider: Provider, modelId: string, modelName: string, enable: boolean) => {
    const key = `${provider.id}-${modelId}`;
    try {
      if (enable) {
        // Start/pull the model in Ollama
        toast.info(`正在加载 ${modelName}...`);
        // We'll check status after a short delay
        setTimeout(() => {
          setOllamaModelStatus(prev => ({ ...prev, [key]: true }));
          toast.success(`${modelName} 已准备就绪`);
        }, 1000);
      } else {
        // We don't actually stop models in Ollama (it manages memory automatically)
        setOllamaModelStatus(prev => ({ ...prev, [key]: false }));
        toast.info(`${modelName} 已禁用`);
      }
    } catch (error) {
      toast.error('操作失败');
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

  const isMobile = !isDesktop;

  return (
    <div className={cn('relative flex h-full overflow-hidden', isMobile ? (isDark ? 'bg-[radial-gradient(circle_at_50%_50%,#2d2d44_0%,#1a1a2e_100%)]' : 'bg-[radial-gradient(circle_at_50%_50%,#f5f5f5_0%,#e0e0e0_100%)]') : 'bg-background')}>
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
        <div className="md:hidden border-b border-border/50 shrink-0">
          <div className="h-[48px] flex items-center justify-between px-4 border-b border-border/50 z-10" style={{ paddingTop: 'max(env(safe-area-inset-top), 8px)' }}>
            {mobileTabSelected ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMobileTabSelected(false)}
                className="flex items-center gap-1"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                返回
              </Button>
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
                    className="w-full flex items-center justify-between px-4 py-3 rounded-2xl transition-all duration-200 bg-gradient-to-r from-secondary/90 to-secondary hover:from-secondary hover:to-secondary/90 hover:shadow-md active:scale-[0.98] min-h-[56px] box-border"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <item.icon size={18} className="text-muted-foreground shrink-0" />
                      <span className="font-medium truncate">{item.label}</span>
                    </div>
                    <ChevronDown size={18} className="text-muted-foreground rotate-90 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        
        {(mobileTabSelected || isDesktop) && (
          <div className="flex-1 min-w-0 w-full p-4 md:p-8 h-full overflow-hidden">
            <div className="max-w-4xl mx-auto h-full overflow-hidden">
              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <ScrollArea className="h-full">
                  <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
                  <h3 className="text-xl md:text-2xl font-semibold">{t.settings_profile}</h3>
                
                <GlassCard className="p-4 md:p-6">
                  <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-6">
                    <Avatar className="w-20 h-20 shrink-0">
                      <AvatarImage src={avatarUrl} />
                      <AvatarFallback className="text-2xl bg-primary/10">
                        {user.username?.[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    
                    <div className="flex-1 space-y-4 w-full">
                      <div className="flex gap-2 flex-wrap">
                        {(['emoji', 'image', 'url'] as const).map(type => (
                          <button
                            key={type}
                            onClick={() => setAvatarType(type)}
                            className={cn(
                              "px-3 py-1.5 text-xs rounded-full border transition-all active:scale-95",
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
                        <label className="border-2 border-dashed border-border rounded-xl p-6 text-center hover:bg-secondary/50 active:bg-secondary/60 transition-colors cursor-pointer block">
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
                        <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                          {EMOJIS.map(e => (
                            <button
                              key={e}
                              onClick={() => setAvatarUrl(e)}
                              className={cn(
                                "p-2 hover:bg-secondary active:bg-secondary/80 rounded-lg text-xl transition-all min-h-[44px] flex items-center justify-center",
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
                    className="touch-input"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{t.settings_username_desc}</p>
                </div>

                <div className="mt-6 flex justify-end">
                  <Button onClick={handleUpdateProfile} className="min-h-[44px]">
                    <Save size={16} className="mr-2" />
                    {t.save}
                  </Button>
                </div>
              </GlassCard>

              {/* 账户安全 - 统一的账户安全管理模块 */}
              <GlassCard className="p-4 md:p-6 border-destructive/50">
                <h4 className="font-semibold text-destructive mb-4 flex items-center gap-2">
                  <Shield size={18} />
                  {t.settings_danger_zone}
                </h4>
                
                <div 
                  className="flex items-center justify-between cursor-pointer py-3 border-b border-border/50 min-h-[44px]"
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                      <Input
                        type="password"
                        placeholder={t.old_pwd}
                        value={pwdOld}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPwdOld(e.target.value)}
                        className="touch-input"
                      />
                      <Input
                        type="password"
                        placeholder={t.new_pwd}
                        value={pwdNew}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPwdNew(e.target.value)}
                        className="touch-input"
                      />
                    </div>
                    <div className="mt-4 flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => {setShowPasswordForm(false); setPwdOld(''); setPwdNew('');}} className="min-h-[44px]">
                        {t.cancel || '取消'}
                      </Button>
                      <Button onClick={handleChangePassword} className="min-h-[44px]">
                        {t.save || '保存'}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-2">
                    <LogOut size={16} className="text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{t.logout}</p>
                      <p className="text-xs text-muted-foreground">{t.logout_desc}</p>
                    </div>
                  </div>
                  <Button variant="destructive" size="sm" onClick={onLogout} className="min-h-[44px] w-full sm:w-auto">
                    {t.logout}
                  </Button>
                </div>
              </GlassCard>
                  </div>
                </ScrollArea>
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
            <ScrollArea className="h-full">
              <div className={`space-y-6 animate-fade-in pr-2 ${bottomPadding}`}>
              <h3 className="text-xl md:text-2xl font-semibold">{t.admin_defaults}</h3>
              
              <GlassCard className="p-4 md:p-6">
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
                    <div key={i} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 border-b border-border/50 last:border-0">
                      <div className="flex items-center gap-3">
                        <Bot size={18} className="text-muted-foreground shrink-0" />
                        <span className="text-sm">{item.label}</span>
                      </div>
                      <ModelSelector
                        models={models}
                        currentModel={item.value}
                        onSelect={(modelId: string) => item.set(modelId)}
                        size="sm"
                      />
                    </div>
                  ))}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-t border-border/50">
                    <div className="flex items-center gap-3">
                      <Sparkles size={18} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-sm font-medium">允许AI分析用户个人OC卡</p>
                        <p className="text-xs text-muted-foreground">启用后AI可以深度分析用户的原创角色设定</p>
                      </div>
                    </div>
                    <Switch
                      checked={allowOCAnalysis}
                      onCheckedChange={setAllowOCAnalysis}
                    />
                  </div>
                  {allowOCAnalysis && (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <Bot size={18} className="text-muted-foreground shrink-0" />
                        <span className="text-sm">OC分析默认模型</span>
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
                  <Button onClick={handleSaveDefaults} className="min-h-[44px]">
                    <Save size={16} className="mr-2" />
                    {t.save}
                  </Button>
                </div>
              </GlassCard>

              <div className="space-y-4">
                <button
                  onClick={() => setStartersExpanded(!startersExpanded)}
                  className="w-full flex items-center justify-between p-3 rounded-xl transition-all bg-secondary hover:bg-secondary/80 active:bg-secondary/60 min-h-[48px]"
                >
                  <div className="flex items-center gap-3">
                    <HelpCircle size={18} className="text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm">{t.admin_starters}</span>
                  </div>
                  <ChevronDown
                    size={18}
                    className={cn(
                      "text-muted-foreground transition-transform duration-300 shrink-0",
                      startersExpanded && "rotate-180"
                    )}
                  />
                </button>

                {startersExpanded && (
                  <div className="animate-in slide-in-from-top-2 fade-in duration-300">
                    <GlassCard className="p-4 md:p-6">
                      <p className="text-sm text-muted-foreground mb-4">
                        如果设置了"每日话题生成模型"，可以自动每日生成。
                      </p>
                      <textarea
                        value={starterQuestions.join('\n')}
                        onChange={e => setStarterQuestions(e.target.value.split('\n'))}
                        className="w-full h-48 p-4 rounded-xl bg-secondary border-none outline-none resize-none font-mono text-sm touch-input"
                        placeholder={t.enter_question_placeholder}
                      />
                      <div className="mt-4 flex justify-end">
                        <Button onClick={handleSaveStarters} className="min-h-[44px]">
                          <Save size={16} className="mr-2" />
                          {t.save}
                        </Button>
                      </div>
                    </GlassCard>
                  </div>
                )}
              </div>

              <div className="space-y-4 mt-4">
                <button
                  onClick={() => setImageCleanupExpanded(!imageCleanupExpanded)}
                  className="w-full flex items-center justify-between p-3 rounded-xl transition-all bg-secondary hover:bg-secondary/80 active:bg-secondary/60 min-h-[48px]"
                >
                  <div className="flex items-center gap-3">
                    <Trash2 size={18} className="text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm">图片过期清理</span>
                  </div>
                  <ChevronDown
                    size={18}
                    className={cn(
                      "text-muted-foreground transition-transform duration-300 shrink-0",
                      imageCleanupExpanded && "rotate-180"
                    )}
                  />
                </button>

                {imageCleanupExpanded && (
                  <div className="animate-in slide-in-from-top-2 fade-in duration-300">
                    <GlassCard className="p-4 md:p-6">
                      <p className="text-sm text-muted-foreground mb-4">
                        配置上传图片的自动清理策略，超过指定天数的图片将被自动删除。
                      </p>
                      <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2">
                          <div>
                            <p className="font-medium text-sm">启用自动清理</p>
                            <p className="text-xs text-muted-foreground">开启后系统将按设定时间自动清理过期图片</p>
                          </div>
                          <Switch
                            checked={imageCleanupEnabled}
                            onCheckedChange={setImageCleanupEnabled}
                          />
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2 border-t border-border/50">
                          <div>
                            <p className="font-medium text-sm">过期天数</p>
                            <p className="text-xs text-muted-foreground">超过此天数的图片将被自动清理</p>
                          </div>
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
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2 border-t border-border/50">
                          <div>
                            <p className="font-medium text-sm">立即执行清理</p>
                            <p className="text-xs text-muted-foreground">手动触发一次过期图片清理</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRunImageCleanup}
                            className="min-h-[44px] w-full sm:w-auto"
                          >
                            <Trash2 size={14} className="mr-1.5" />
                            执行清理
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 flex justify-end">
                        <Button onClick={handleSaveImageCleanup} className="min-h-[44px]">
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
              <h3 className="text-xl md:text-2xl font-semibold">{t.admin_users}</h3>
              
              <div className="space-y-2">
                {usersList.map(u => (
                  <GlassCard key={u.id} className="p-3 md:p-4">
                    <div className="flex items-center justify-between">
                      <button 
                        onClick={() => { setViewingUser(u); setActiveTab('user_usage'); }}
                        className="flex items-center gap-3 md:gap-4 text-left flex-1 min-w-0"
                      >
                        <Avatar className="shrink-0">
                          <AvatarImage src={u.avatar} />
                          <AvatarFallback>{u.username?.[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm truncate">{u.username}</p>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {t.role}: {u.role}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2 mt-2">
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-blue-500 font-medium">输入</p>
                              <p className="text-xs md:text-sm font-bold">{(u.tokens_chat || 0) + (u.tokens_workspace || 0) + (u.tokens_character || 0)}</p>
                            </div>
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-green-500 font-medium">输出</p>
                              <p className="text-xs md:text-sm font-bold">0</p>
                            </div>
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-muted-foreground font-medium">请求</p>
                              <p className="text-xs md:text-sm font-bold">{u.chat_count}次</p>
                            </div>
                            <div className="p-1.5 md:p-2 rounded-lg bg-muted/40 border border-border/40">
                              <p className="text-xs text-muted-foreground font-medium">存储</p>
                              <p className="text-xs md:text-sm font-bold">{((u.storage_used ?? 0) / 1024 / 1024).toFixed(1)}MB</p>
                            </div>
                          </div>
                        </div>
                      </button>
                      <div className="flex gap-2 ml-2 shrink-0">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="text-destructive hover:bg-destructive/10 min-h-[44px] min-w-[44px]"
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
              <h3 className="text-xl md:text-2xl font-semibold">{t.appearance || '外观设置'}</h3>
              
              <GlassCard className="p-4 md:p-6">
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      {isDark ? <Moon size={20} className="text-muted-foreground shrink-0" /> : <Sun size={20} className="text-muted-foreground shrink-0" />}
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
                      className="min-h-[44px] w-full sm:w-auto"
                    >
                      {isDark ? <Sun size={16} className="mr-2" /> : <Moon size={16} className="mr-2" />}
                      {isDark ? t.switch_light || '切换浅色' : t.switch_dark || '切换深色'}
                    </Button>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <MessageSquareText size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">界面模式</p>
                        <p className="text-xs text-muted-foreground">当前: {currentDevice === 'desktop' ? '桌面端' : '移动端'}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button
                        variant={currentDevice === 'desktop' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => switchDevice?.('desktop')}
                        disabled={!switchDevice}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        桌面端
                      </Button>
                      <Button
                        variant={currentDevice === 'mobile' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => switchDevice?.('mobile')}
                        disabled={!switchDevice}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        移动端
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Zap size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">模型深度思考</p>
                        <p className="text-xs text-muted-foreground">显示模型的思考过程</p>
                      </div>
                    </div>
                    <Button
                      variant={showModelReasoning ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => handleSaveModelReasoning(!showModelReasoning)}
                      className="min-h-[44px] w-full sm:w-auto"
                    >
                      {showModelReasoning ? '已开启' : '已关闭'}
                    </Button>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <Bot size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">角色扮演显示模式</p>
                        <p className="text-xs text-muted-foreground">选择角色扮演对话的显示方式</p>
                      </div>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button
                        variant={characterDisplayMode === 'framed' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveCharacterDisplayMode('framed')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        分框模式
                      </Button>
                      <Button
                        variant={characterDisplayMode === 'frameless' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveCharacterDisplayMode('frameless')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        无分框模式
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3">
                      <Database size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">{t.memory_mode || '记忆模式'}</p>
                        <p className="text-xs text-muted-foreground">{t.memory_mode_desc || '向量记忆提供更好的语义理解和更大的记忆容量'}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button
                        variant={memoryMode === 'rule' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveMemoryMode('rule')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.memory_mode_rule || '规则记忆'}
                      </Button>
                      <Button
                        variant={memoryMode === 'vector' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveMemoryMode('vector')}
                        className="flex-1 sm:flex-none min-h-[44px]"
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
              <h3 className="text-xl md:text-2xl font-semibold">{t.language || '语言设置'}</h3>
              
              <GlassCard className="p-4 md:p-6">
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-semibold w-8 text-center shrink-0">{lang?.toUpperCase()}</span>
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
                      className="min-h-[44px] w-full sm:w-auto"
                    >
                      {t.switch_language || '切换语言'}
                    </Button>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3">
                      <MessageSquareText size={20} className="text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">{t.prompt_language || '提示词语言'}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.prompt_language_desc || '角色扮演时 AI 提示词的语言'}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button
                        variant={promptLanguage === 'auto' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSavePromptLanguage('auto')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.prompt_lang_auto || '自动'}
                      </Button>
                      <Button
                        variant={promptLanguage === 'zh' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSavePromptLanguage('zh')}
                        className="flex-1 sm:flex-none min-h-[44px]"
                      >
                        {t.prompt_lang_zh || '中文'}
                      </Button>
                      <Button
                        variant={promptLanguage === 'en' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSavePromptLanguage('en')}
                        className="flex-1 sm:flex-none min-h-[44px]"
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
