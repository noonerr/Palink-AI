import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuroraBackground } from '@/components/ui/custom/AuroraBackground';
import { DesktopSidebar, MobileBottomNav } from '@/components/ui/custom/Sidebar';
import { ErrorBoundary } from '@/components/ui/custom/ErrorBoundary';
import { NetworkStatus } from '@/components/ui/custom/NetworkStatus';
import { cn } from '@/lib/utils';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import { useIsMobile } from '@/hooks/use-mobile';
import { WidescreenPrompt } from '@/components/ui/custom/WidescreenPrompt';
import { StPluginMountPoints } from '@/components/st-plugin-ui-host/StPluginMountPoints';
import { Popup } from '@/lib/popup-system';

import { AuthScreen } from '@/components/views/AuthScreen';
import { api, ApiError, AUTH_FAILURE_EVENT, invalidateCache, isAbortError } from '@/services/api';
import { onEvent } from '@/lib/event-bus';
import { pluginManager } from '@/lib/plugin-system/manager';
import { getGlobalSillyTavernRuntime } from '@/lib/sillytavern/runtime';
import type { User, Model, Language, Theme, Provider } from '@/types';

// Translations
const TRANSLATIONS = {
  zh: {
    nav_chat: "对话",
    nav_files: "工作空间",
    nav_characters: "角色扮演",
    nav_config: "设置",
    chat_history: "历史记录",
    new_chat: "新对话",
    delete_selected: "删除",
    batch_manage: "批量管理",
    files_selected: "已选文件",
    create_project: "进入项目对话",
    empty_selection: "请先选择文件",
    clear: "清空",
    refresh: "刷新",
    upload: "上传文件",
    uploading: "上传中...",
    new_folder: "新建文件夹",
    folder_name_placeholder: "请输入文件夹名称",
    ask_anything: "有什么可以帮你的？",
    thinking: "深度思考",
    copy: "复制",
    settings_common: "通用设置",
    settings_profile: "个人资料",
    settings_security: "账号安全",
    settings_providers: "API模型",
    settings_admin: "系统管理",
    settings_about: "关于",
    save: "保存",
    logout: "退出登录",
    admin_users: "用户管理",
    admin_defaults: "默认配置",
    admin_starters: "每日话题设置",
    files_col_name: "名称",
    files_col_date: "日期",
    files_col_size: "大小",
    gen_outline: "智能分析",
    outline_title: "文件洞察",
    btn_generate: "生成摘要",
    outline_placeholder: "点击生成以获取关键洞察...",
    select_model: "选择模型",
    lang_switch: "English",
    tab_files: "我的文件",
    tab_projects: "项目对话",
    welcome_greeting: "你好，我是你的 AI 助手",
    model_selector: "当前模型",
    random_prompts: "你可以试着问我",
    back_to_home: "返回主页",
    provider_config: "模型服务商",
    provider_config_desc: "配置大语言模型服务商及模型",
    old_pwd: "旧密码",
    new_pwd: "新密码",
    change_pwd: "修改密码",
    def_chat_model: "默认对话模型",
    def_ws_model: "默认工作空间模型",
    def_outline_model: "默认分析模型",
    daily_topic_model: "每日话题生成模型",
    theme_mode: "主题模式",
    theme_light: "亮色",
    theme_dark: "暗色",
    theme_auto: "跟随系统",
    action_delete: "删除",
    settings_avatar_url: "头像设置",
    settings_avatar_desc: "自定义您的个人资料图片",
    settings_username: "用户名",
    settings_username_desc: "您在系统中的显示名称",
    settings_danger_zone: "危险区域",
    logout_desc: "注销当前设备的登录状态",
    add_provider: "添加服务商",
    edit: "编辑",
    active_models: "个启用模型",
    enter_question_placeholder: "输入推荐问题，每行一个...",
    role: "角色",
    about_title: "关于 Palink AI",
    about_desc: "企业级 AI 协作空间",
    version: "版本 0.21.2",
    privacy_policy: "隐私协议",
    edit_provider: "编辑服务商",
    add_provider_title: "添加服务商",
    provider_name: "显示名称",
    base_url: "API 代理地址",
    api_key: "API 密钥",
    model_list: "模型列表",
    add_model: "添加模型",
    model_id_placeholder: "模型 ID (如 gpt-4)",
    model_alias_placeholder: "显示别名",
    model_desc_placeholder: "简介",
    model_ctx_placeholder: "上下文长度",
    stop_generating: "停止生成",
    ai_disclaimer: "AI 可能会犯错，请核对重要信息。",
    sign_in: "登录",
    sign_up: "注册",
    cancel: "取消",
    ok: "确定",
    add: "添加",
    upload_image: "上传图片",
    use_url: "使用链接",
    choose_emoji: "选择表情",
    view_chats: "查看对话",
    context_usage: "上下文使用",
    tokens: "Tokens",
    suggested_topics: "推荐话题",
    click_to_upload: "点击上传头像",
    delete_chat: "删除对话",
    workspace_title: "工作空间",
    no_projects: "暂无项目",
    appearance: "外观",
    language: "语言",
    developer_mode: "开发者模式",
    developer_mode_desc: "开启后普通聊天不会请求真实模型，而是返回示例流式回复",
    language_models: "API模型",
    local_models: "本地模型",
    refresh_models: "刷新模型列表",
    upload_model: "上传模型",
    no_local_models: "暂无本地模型",
    upload_model_hint: '请点击上方的"上传模型"按钮上传本地模型文件',
    old_pwd_required: "请输入旧密码",
    new_pwd_required: "请输入新密码",
    pwd_min_length: "新密码至少需要8个字符",
    pwd_same_as_old: "新密码不能与旧密码相同",
    pwd_changed: "密码修改成功",
    pwd_change_failed: "密码修改失败",
    pwd_change_error: "密码修改出错",
    defaults_saved: "默认配置已保存",
    fetch_user_chats_failed: "获取用户对话失败",
    fetch_user_chats_error: "获取用户对话出错",
    confirm_delete_user: "确定要删除该用户吗？此操作不可恢复。",
    user_deleted: "用户已删除",
    delete_user_failed: "删除用户失败",
    delete_user_error: "删除用户出错",
    start_conversation: "开始对话",
    manage_worldbook: "管理世界书",
    start_roleplay_hint: "开始与这个角色对话吧！",
    loading_conversation: "正在加载对话...",
    chat_records: "聊天记录",
    history_conversation: "历史对话",
    delete_conversation: "删除对话",
    switch_story_mode: "切换故事模式",
    switch_first_person: "切换第一人称",
    previous_stage: "上一阶段",
    next_stage: "下一阶段",
    manage_plotline: "管理剧情线",
    memory_count: "记忆",
    compressing: "压缩中...",
    compress_memory: "压缩记忆",
    delete_selected_items: "删除选中",
    cancel_select_mode: "取消选择模式",
    select_to_delete: "选择删除",
    no_branches: "暂无分支",
    current: "当前",
    first_person: "第一人称",
    story_mode: "故事模式",
    request_taking_long: "请求时间较长",
    ai_processing: "AI模型正在处理...",
    user_label: "用户",
    chat_with_character: "与{name}对话...",
    memory_compressed: "记忆压缩完成！\n处理: {processed} 条\n保留: {remaining} 条\n摘要: {summary}",
    translating: "已经开始翻译，请稍候...",
    character_card_done: "角色卡处理完成！"
  },
  en: {
    nav_chat: "Chat",
    nav_files: "Workspace",
    nav_characters: "Roleplay",
    nav_config: "Settings",
    chat_history: "History",
    new_chat: "New Chat",
    delete_selected: "Delete",
    batch_manage: "Manage",
    files_selected: "Selected",
    create_project: "Start Project",
    empty_selection: "Select files first",
    clear: "Clear",
    refresh: "Refresh",
    upload: "Upload",
    uploading: "Uploading...",
    new_folder: "New Folder",
    folder_name_placeholder: "Enter folder name",
    ask_anything: "How can I help you?",
    thinking: "Thinking",
    copy: "Copy",
    settings_common: "General",
    settings_profile: "Profile",
    settings_security: "Security",
    settings_providers: "Language Models",
    settings_admin: "System Admin",
    settings_about: "About",
    save: "Save",
    logout: "Log Out",
    admin_users: "Users",
    admin_defaults: "Defaults",
    admin_starters: "Daily Topics",
    files_col_name: "Name",
    files_col_date: "Date",
    files_col_size: "Size",
    gen_outline: "Analyze",
    outline_title: "File Insights",
    btn_generate: "Generate",
    outline_placeholder: "Click generate to analyze...",
    select_model: "Select Model",
    lang_switch: "中文",
    tab_files: "Files",
    tab_projects: "Projects",
    welcome_greeting: "Hello, I am your AI assistant",
    model_selector: "Model",
    random_prompts: "Try asking",
    back_to_home: "Back Home",
    provider_config: "Model Providers",
    provider_config_desc: "Configure LLM providers and models",
    old_pwd: "Old Password",
    new_pwd: "New Password",
    change_pwd: "Change Password",
    def_chat_model: "Default Chat Model",
    def_ws_model: "Default Workspace Model",
    def_outline_model: "Default Analysis Model",
    daily_topic_model: "Daily Topic Gen Model",
    theme_mode: "Theme Mode",
    theme_light: "Light",
    theme_dark: "Dark",
    theme_auto: "System",
    action_delete: "Delete",
    settings_avatar_url: "Avatar Settings",
    settings_avatar_desc: "Customize your profile picture",
    settings_username: "Username",
    settings_username_desc: "How you appear to others",
    settings_danger_zone: "Danger Zone",
    logout_desc: "Sign out of your account on this device",
    add_provider: "Add Provider",
    edit: "Edit",
    active_models: "Models Active",
    enter_question_placeholder: "Enter one question per line...",
    role: "Role",
    about_title: "Palink AI",
    about_desc: "Enterprise Grade AI Workspace",
    version: "Version 0.21.2",
    privacy_policy: "Privacy Policy",
    edit_provider: "Edit Provider",
    add_provider_title: "Add Provider",
    provider_name: "Display Name",
    base_url: "Base URL",
    api_key: "API Key",
    model_list: "Model List",
    add_model: "Add Model",
    model_id_placeholder: "Model ID (e.g. gpt-4)",
    model_alias_placeholder: "Alias",
    model_desc_placeholder: "Description",
    model_ctx_placeholder: "Context Limit",
    stop_generating: "Stop Generating",
    ai_disclaimer: "AI can make mistakes. Please verify important information.",
    sign_in: "Sign In",
    sign_up: "Sign Up",
    cancel: "Cancel",
    ok: "OK",
    add: "Add",
    upload_image: "Upload Image",
    use_url: "Use URL",
    choose_emoji: "Choose Emoji",
    view_chats: "View Chats",
    context_usage: "Context Usage",
    tokens: "Tokens",
    suggested_topics: "Suggested Topics",
    click_to_upload: "Click to upload",
    delete_chat: "Delete Chat",
    workspace_title: "Workspace",
    no_projects: "No projects yet",
    appearance: "Appearance",
    language: "Language",
    developer_mode: "Developer Mode",
    developer_mode_desc: "When enabled, normal chat uses local mocked streaming replies instead of real model requests",
    language_models: "Language Models",
    local_models: "Local Models",
    refresh_models: "Refresh Model List",
    upload_model: "Upload Model",
    no_local_models: "No local models",
    upload_model_hint: "Click the \"Upload Model\" button above to upload a local model file",
    old_pwd_required: "Please enter old password",
    new_pwd_required: "Please enter new password",
    pwd_min_length: "New password must be at least 8 characters",
    pwd_same_as_old: "New password cannot be the same as the old one",
    pwd_changed: "Password changed successfully",
    pwd_change_failed: "Failed to change password",
    pwd_change_error: "Error changing password",
    defaults_saved: "Defaults saved",
    fetch_user_chats_failed: "Failed to fetch user chats",
    fetch_user_chats_error: "Error fetching user chats",
    confirm_delete_user: "Are you sure you want to delete this user? This action cannot be undone.",
    user_deleted: "User deleted",
    delete_user_failed: "Failed to delete user",
    delete_user_error: "Error deleting user",
    start_conversation: "Start Chat",
    manage_worldbook: "Manage Worldbook",
    start_roleplay_hint: "Start chatting with this character!",
    loading_conversation: "Loading conversation...",
    chat_records: "Chat Records",
    history_conversation: "History",
    delete_conversation: "Delete Chat",
    switch_story_mode: "Toggle Story Mode",
    switch_first_person: "Toggle First Person",
    previous_stage: "Previous Stage",
    next_stage: "Next Stage",
    manage_plotline: "Manage Plotline",
    memory_count: "Memory",
    compressing: "Compressing...",
    compress_memory: "Compress Memory",
    delete_selected_items: "Delete Selected",
    cancel_select_mode: "Cancel Selection",
    select_to_delete: "Select to Delete",
    no_branches: "No Branches",
    current: "Current",
    first_person: "First Person",
    story_mode: "Story Mode",
    request_taking_long: "Request taking long",
    ai_processing: "AI is processing...",
    user_label: "User",
    chat_with_character: "Chat with {name}...",
    memory_compressed: "Memory compressed!\nProcessed: {processed}\nRetained: {remaining}\nSummary: {summary}",
    translating: "Translation started, please wait...",
    character_card_done: "Character card processed!"
  }
};

const ChatViewDesktop = lazy(() =>
  import('@/components/views/ChatViewDesktop').then((module) => ({ default: module.ChatViewDesktop }))
);
const ChatViewMobile = lazy(() =>
  import('@/components/views/ChatViewMobile').then((module) => ({ default: module.ChatViewMobile }))
);
const WorkspaceView = lazy(() =>
  import('@/components/views/WorkspaceView').then((module) => ({ default: module.WorkspaceView }))
);
const SettingsView = lazy(() =>
  import('@/components/views/SettingsView').then((module) => ({ default: module.SettingsView }))
);
const CharacterView = lazy(() =>
  import('@/components/views/CharacterView').then((module) => ({ default: module.CharacterView }))
);
const ProviderEditPage = lazy(() =>
  import('@/components/views/ProviderEditPage').then((module) => ({ default: module.ProviderEditPage }))
);

const USER_FETCH_TIMEOUT_MS = 5000;
// N8-c 终态：不再缓存用户快照（旧凭据 localStorage palink_user_snapshot 兜底已随
// localStorage 鉴权一并退役）。启动一律静默探测 /api/users/me，缓存读取副作用已无。
const LEGACY_USER_CACHE_KEY = 'palink_user_snapshot';

// 迁移：清除双轨期残留的用户快照缓存（含按 token 派生的旧键）。仅保留该 key，
// 一旦清理完成即可整体退役。
function clearCachedUserSnapshot(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && (key === LEGACY_USER_CACHE_KEY || key.startsWith(`${LEGACY_USER_CACHE_KEY}:`))) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorage 不可用时静默跳过
  }
}

function shouldIgnoreConfigError(e: unknown): boolean {
  return isAbortError(e) || (e instanceof ApiError && e.status === 401);
}

const RouteFallback = () => (
  <div className="h-full min-h-[240px] flex items-center justify-center">
    <Loader2 className="animate-spin text-primary" size={24} />
  </div>
);

function App() {
  const isMobile = useIsMobile();
  // N8-c 终态：哨兵值驱动既有渲染门控（/api/users/me 探测判定登录态）。
  // 值为常量 _ 即可满足类型断言，不影响被下发子组件（其默认已不消费凭据）。
  const [token] = useState<string | null>('_');
  const [user, setUser] = useState<User | null>(null);
  const [themeMode, setThemeMode] = useState<Theme>((localStorage.getItem('theme') as Theme) || 'auto');
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const isDark: Theme = themeMode === 'auto' ? (systemPrefersDark ? 'dark' : 'light') : themeMode;
  const [lang, setLang] = useState<Language>(localStorage.getItem('lang') as Language || 'zh');
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [systemDefaults, setSystemDefaults] = useState<any>({});
  const [privateConfigReady, setPrivateConfigReady] = useState(false);
  // N8-c 终态：初始 loading=true —— 首屏挂载即进入探测 loading 态，直到 /api/users/me
  // 判定（auth:ready → false；auth:unauthorized → false 停留登录页），防闪烁。
  const [loading, setLoading] = useState(true);
  // N8-c 终态：登录后触发的重新探测计数（handleLogin 自增，驱动 /api/users/me 探测 effect 重跑）
  const [authProbeKey, setAuthProbeKey] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [dockOffset, setDockOffset] = useState(0);
  const { isKeyboardOpen } = useVirtualKeyboard();
  const [currentModel, setCurrentModel] = useState<string>('');
  const [stNativeActive, setStNativeActive] = useState(false);
  // galgame 插件全屏（原生 fullscreen 或 #gal-global-overlay.fullscreen）激活时隐藏底部 Dock
  const [pluginFullscreen, setPluginFullscreen] = useState(false);

  const t = TRANSLATIONS[lang];

  useEffect(() => {
    const handleStNativeActiveChange = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setStNativeActive(Boolean(detail?.active));
    };
    window.addEventListener('palink:stNativeActiveChanged', handleStNativeActiveChange);

    return () => window.removeEventListener('palink:stNativeActiveChanged', handleStNativeActiveChange);
  }, []);

  // 监听浏览器原生全屏 + galgame 插件 overlay 的 fullscreen class，任一激活即视为全屏，
  // 隐藏底部 Dock，避免 Dock 悬浮在 galgame 界面上遮挡按钮。
  useEffect(() => {
    const overlayHasFullscreenClass = (): boolean => {
      const overlay = document.getElementById('gal-global-overlay');
      return Boolean(overlay?.classList.contains('fullscreen'));
    };
    const isNativeFullscreen = (): boolean => {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
        mozFullScreenElement?: Element | null;
        msFullscreenElement?: Element | null;
      };
      return Boolean(
        document.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement,
      );
    };
    const update = () => {
      setPluginFullscreen(isNativeFullscreen() || overlayHasFullscreenClass());
    };

    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);

    // overlay 由 galgame 插件运行时动态挂载到 #chat 或 body，并切换 fullscreen class
    let overlayObserver: MutationObserver | null = null;
    const attachOverlayObserver = (overlay: Element) => {
      overlayObserver?.disconnect();
      overlayObserver = new MutationObserver(update);
      overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    };
    const rootObserver = new MutationObserver(() => {
      const overlay = document.getElementById('gal-global-overlay');
      if (overlay) attachOverlayObserver(overlay);
      update();
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });

    const overlay = document.getElementById('gal-global-overlay');
    if (overlay) attachOverlayObserver(overlay);
    update();

    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
      rootObserver.disconnect();
      overlayObserver?.disconnect();
    };
  }, []);

  // 初始化插件系统：仅在已登录时调用，避免未登录状态触发 401 console error
  useEffect(() => {
    if (!token) return;
    pluginManager.init().then(() => {
      // P-2: 插件全部加载完成后触发 ST app_ready 事件
      // （quick-reply finalizeInit、memory 定时总结等插件依赖此事件完成初始化）
      getGlobalSillyTavernRuntime()?.emitAppReady();
    }).catch(err => {
      console.error('[App] 插件系统初始化失败:', err);
    });
  }, [token]);

  // 空闲时预取常用路由 chunk：登录就绪、首屏关键请求已发出后，把首次导航
  // 要用的懒加载模块拉进浏览器模块缓存。与上方 lazy() 使用相同模块说明符，
  // 真实导航时直接命中缓存；不挂载任何组件，对现有渲染零影响。
  const routePrefetchDoneRef = useRef(false);
  useEffect(() => {
    if (!token || !privateConfigReady) return;
    if (routePrefetchDoneRef.current) return;
    const prefetchRoutes = () => {
      if (routePrefetchDoneRef.current) return;
      routePrefetchDoneRef.current = true;
      void import('@/components/views/ChatViewDesktop');
      void import('@/components/views/ChatViewMobile');
      void import('@/components/views/CharacterView');
      void import('@/components/views/SettingsView');
      void import('@/components/views/WorkspaceView');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetchRoutes, { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(prefetchRoutes, 1500);
    return () => window.clearTimeout(timer);
  }, [token, privateConfigReady]);

  const loadModels = useCallback(async () => {
    if (!token || !user || !privateConfigReady) return;
    try {
      const data = await api.get('/api/models', { cacheTtlMs: 5 * 60 * 1000 });
      setModels(data);
    } catch (e) {
      if (shouldIgnoreConfigError(e)) return;
      console.error('Failed to load models:', e);
    }
  }, [privateConfigReady, token, user]);

  const loadSystemDefaults = useCallback(async () => {
    if (!token || !user || !privateConfigReady) return;
    try {
      const data = await api.get('/api/admin/system/defaults', { cacheTtlMs: 5 * 60 * 1000 });
      setSystemDefaults(data);
    } catch (e) {
      if (shouldIgnoreConfigError(e)) return;
      console.error('Failed to load system defaults:', e);
    }
  }, [privateConfigReady, token, user]);

  const fetchProviders = useCallback(async () => {
    if (!token || !user || user.role !== 'admin' || !privateConfigReady) return;
    try {
      const data = await api.get('/api/admin/providers', { cacheTtlMs: 5 * 60 * 1000 });
      setProviders(data);
    } catch (e) {
      if (shouldIgnoreConfigError(e)) return;
      console.error('Failed to fetch providers:', e);
    }
  }, [privateConfigReady, token, user]);

  const loadConfig = useCallback(() => {
    loadModels();
    loadSystemDefaults();
  }, [loadModels, loadSystemDefaults]);

  const loadSettingsConfig = useCallback(() => {
    loadModels();
    loadSystemDefaults();
    fetchProviders();
  }, [fetchProviders, loadModels, loadSystemDefaults]);

  // 监听系统亮/暗模式变化，auto 模式下自动跟随
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (isDark === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', themeMode);
    document.documentElement.setAttribute('data-theme', isDark);
  }, [isDark, themeMode]);

  useEffect(() => {
    const root = document.getElementById('root');
    const nodes = [document.documentElement, document.body, root].filter(Boolean) as HTMLElement[];
    const themeMeta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;

    const clearMobileShellClasses = () => {
      nodes.forEach((node) => {
        node.classList.remove('ios-mobile-app', 'ios-mobile-app-light', 'ios-mobile-app-dark');
      });
    };

    clearMobileShellClasses();

    if (!isMobile) {
      if (themeMeta) {
        themeMeta.setAttribute('content', isDark === 'dark' ? '#1f2236' : '#ffffff');
        themeMeta.removeAttribute('media');
      }
      return clearMobileShellClasses;
    }

    const themeClass = isDark === 'dark' ? 'ios-mobile-app-dark' : 'ios-mobile-app-light';
    nodes.forEach((node) => {
      node.classList.add('ios-mobile-app', themeClass);
    });

    if (themeMeta) {
      // iOS WebApp：theme-color 与应用顶部背景完全一致，
      // 配合 default/black 状态栏样式，让纯色状态栏与应用融为一体
      themeMeta.setAttribute('content', isDark === 'dark' ? '#000000' : '#f5f5f5');
      themeMeta.removeAttribute('media');
    }

    return clearMobileShellClasses;
  }, [isDark, isMobile]);

  useEffect(() => {
    localStorage.setItem('lang', lang);
    localStorage.setItem('palink-lang', lang);
    document.documentElement.setAttribute('lang', lang);
  }, [lang]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), USER_FETCH_TIMEOUT_MS);

    // N8-c 终态：启动无 token，一律携带 palink_session Cookie 静默探测 /api/users/me。
    // 200 → 有登录态，无感进入主界面；401 → 无登录态，清应用状态后停留登录页。
    setPrivateConfigReady(false);
    setUser(null);
    setLoading(true);

    api.get<User>('/api/users/me', { signal: controller.signal })
      .then(u => {
        if (!isMounted) return;
        setUser(u);
        setPrivateConfigReady(true);
        setLoading(false);
      })
      .catch(e => {
        if (!isMounted) return;
        // 探测失败统一视为未登录：清理应用级状态并停留登录页。
        // 401 由 api.ts 派发 'auth:failure' 兜底清理；此处对 abort/网络错误同样降级登出态。
        setPrivateConfigReady(false);
        setUser(null);
        clearCachedUserSnapshot();
        localStorage.removeItem('palink-silly-tavern-mode');
        localStorage.removeItem('palink-silly-tavern-theme');
        setModels([]);
        setProviders([]);
        setSystemDefaults({});
        setCurrentModel('');
        setLoading(false);
        if (!isAbortError(e)) {
          console.warn(
            '[App] /api/users/me 探测失败，按未登录处理:',
            e instanceof ApiError ? e.status : e,
          );
        }
      })
      .finally(() => {
        if (!isMounted) return;
        clearTimeout(timeoutId);
      });

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      controller.abort();
    };
    // authProbeKey：挂载时执行一次（初始 0），登录成功后 handleLogin 自增触发重跑——
    // 重新静默探测 /api/users/me，使登录态的 user 状态更新、进入主界面。
  }, [authProbeKey]);

  useEffect(() => {
    const onAuthFailure = () => {
      // 认证失效（401）：清应用级状态回到未登录。Cookie 由服务端登出/过期负责清理。
      setPrivateConfigReady(false);
      localStorage.removeItem('palink-silly-tavern-mode');
      localStorage.removeItem('palink-silly-tavern-theme');
      clearCachedUserSnapshot();
      setUser(null);
      setModels([]);
      setProviders([]);
      setSystemDefaults({});
      setCurrentModel('');
    };
    const onUserSettingsUpdated = () => {
      loadModels();
    };
    const onModelsUpdated = () => {
      invalidateCache('/api/models');
      invalidateCache('/api/admin/providers');
      loadModels();
      fetchProviders();
    };
    
    // 使用统一事件总线监听认证失败事件
    const unsubscribeAuth = onEvent('auth:failure', onAuthFailure);
    // 保留原有的DOM事件监听（向后兼容）
    window.addEventListener('userSettingsUpdated', onUserSettingsUpdated);
    window.addEventListener('modelsUpdated', onModelsUpdated);
    
    return () => {
      unsubscribeAuth();
      window.removeEventListener('userSettingsUpdated', onUserSettingsUpdated);
      window.removeEventListener('modelsUpdated', onModelsUpdated);
    };
  }, [fetchProviders, loadModels]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (models.length === 0) return;
    const isValid = models.some(m => m.id === currentModel);
    if (!isValid) {
      setCurrentModel(systemDefaults.default_chat_model || models[0].id);
    }
  }, [models, systemDefaults.default_chat_model, currentModel]);

  // N8-c 终态：登录态由服务端 Set-Cookie 建立。前端不再落盘凭据，handleLogin
  // 仅负责从登录页跳回已进入的探测流程：清应用级状态 + 触发全新 /api/users/me 探测。
  // 签名保留 access_token 入参以兼容 AuthScreen 既有 onLogin(data) 调用，忽略其值。
  const handleLogin = useCallback((_data?: { access_token?: string }) => {
    setPrivateConfigReady(false);
    setUser(null);
    setModels([]);
    setProviders([]);
    setSystemDefaults({});
    setCurrentModel('');
    setLoading(true);
    setAuthProbeKey((k) => k + 1);
  }, []);

  const handleLogout = useCallback(() => {
    // N8-b 验收补充：best-effort 服务端登出——清 palink_session/palink_csrf Cookie
    // 双件套 + jti 拉黑（api.post 自动携带 credentials 与 X-CSRF-Token）。失败不阻塞
    // 本地清理，Cookie 由 Max-Age 兜底过期。
    void api.post('/api/auth/logout').catch(() => {});
    setPrivateConfigReady(false);
    localStorage.removeItem('palink-silly-tavern-mode');
    localStorage.removeItem('palink-silly-tavern-theme');
    clearCachedUserSnapshot();
    setUser(null);
    setModels([]);
    setProviders([]);
    setSystemDefaults({});
    setCurrentModel('');
    setLoading(false);
  }, [clearCachedUserSnapshot]);

  const toggleTheme = useCallback(() => {
    // 侧栏快速切换：在亮色/暗色之间切换（跳出 auto 模式）
    setThemeMode(prev => {
      const current = prev === 'auto' ? (systemPrefersDark ? 'dark' : 'light') : prev;
      return current === 'dark' ? 'light' : 'dark';
    });
  }, [systemPrefersDark]);

  const setTheme = useCallback((mode: Theme) => {
    setThemeMode(mode);
  }, []);

  const toggleLang = useCallback(() => {
    setLang(prev => prev === 'zh' ? 'en' : 'zh');
    localStorage.setItem('lang', lang === 'zh' ? 'en' : 'zh');
  }, [lang]);

  const isAuthenticated = !!token && !!user;
  const isAdmin = user?.role === 'admin';

  const sidebarProps = useMemo(() => ({
    user,
    isDark: isDark === 'dark',
    onThemeToggle: toggleTheme,
    lang,
    onLangToggle: toggleLang,
    onLogout: handleLogout,
    t,
    models,
    currentModel,
    onModelChange: setCurrentModel,
    sidebarCollapsed,
    dockOffset,
  }), [user, isDark, lang, t, models, currentModel, sidebarCollapsed, dockOffset, toggleTheme, toggleLang, handleLogout, setCurrentModel]);

  if (loading) {
    return (
      <BrowserRouter>
        <div className="h-screen flex items-center justify-center">
          <Loader2 className="animate-spin text-primary" size={32} />
        </div>
      </BrowserRouter>
    );
  }

  const protectedRoutes = (
    <Routes>
      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="/chat" element={
        <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          {isMobile ? (
            <ChatViewMobile
              token={token!}
              user={user!}
              models={models}
              currentModel={currentModel}
              setCurrentModel={setCurrentModel}
              t={t}
              sidebarCollapsed={sidebarCollapsed}
              setSidebarCollapsed={setSidebarCollapsed}
              isDark={isDark === 'dark'}
              isKeyboardOpen={isKeyboardOpen}
            />
          ) : (
            <ChatViewDesktop
              token={token!}
              user={user!}
              models={models}
              currentModel={currentModel}
              setCurrentModel={setCurrentModel}
              t={t}
              sidebarCollapsed={sidebarCollapsed}
              setSidebarCollapsed={setSidebarCollapsed}
              isDark={isDark === 'dark'}
            />
          )}
        </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/workspace" element={
        <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <WorkspaceView
            token={token!}
            user={user!}
            models={models}
            systemDefaults={systemDefaults}
            onUpdateDefaults={loadSystemDefaults}
            t={t}
            isDark={isDark === 'dark'}
          />
        </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/settings" element={
        <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <SettingsView
            token={token!}
            user={user!}
            models={models}
            systemDefaults={systemDefaults}
            onLogout={handleLogout}
            onUpdateDefaults={loadSettingsConfig}
            t={t}
            isDark={isDark === 'dark'}
            onThemeToggle={toggleTheme}
            themeMode={themeMode}
            onThemeSet={setTheme}
            lang={lang}
            onLangToggle={toggleLang}
          />
        </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/settings/providers/:providerId" element={
        isAdmin ? (
          <ErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <ProviderEditPage
              token={token!}
              providers={providers}
              onProvidersUpdate={fetchProviders}
              t={t}
            />
          </Suspense>
          </ErrorBoundary>
        ) : (
          <Navigate to="/settings" replace />
        )
      } />
      <Route path="/characters" element={
        <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <CharacterView
            token={token!}
            user={user!}
            models={models}
            t={t}
            systemDefaults={systemDefaults}
            onUpdateDefaults={loadSystemDefaults}
            isDark={isDark === 'dark'}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            setDockOffset={setDockOffset}
          />
        </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/characters/:characterId" element={
        <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <CharacterView
            token={token!}
            user={user!}
            models={models}
            t={t}
            systemDefaults={systemDefaults}
            onUpdateDefaults={loadSystemDefaults}
            isDark={isDark === 'dark'}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            setDockOffset={setDockOffset}
          />
        </Suspense>
        </ErrorBoundary>
      } />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );

  return (
    <ErrorBoundary>
    <NetworkStatus />
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={
          isAuthenticated ? (
            <Navigate to="/chat" replace />
          ) : (
            <ErrorBoundary>
            <div className={cn('min-h-screen relative', isMobile ? 'mobile-theme-bg' : 'bg-background')}>
              {!isMobile && <AuroraBackground />}
              <div className="relative z-10">
                <AuthScreen onLogin={handleLogin} />
              </div>
            </div>
            </ErrorBoundary>
          )
        } />
        <Route path="*" element={
          isAuthenticated ? (
            <div className={cn('palink-app-shell w-full flex flex-col relative overflow-hidden', isMobile ? 'mobile-theme-bg' : 'bg-background')}>
              {!isMobile && <AuroraBackground />}
              <div className="flex flex-1 overflow-hidden">
                {!isMobile && <DesktopSidebar {...sidebarProps} />}
                <main className="flex-1 overflow-hidden">
                  {protectedRoutes}
                </main>
              </div>
              {/* ST 插件挂载点常驻：提供 #extensions_settings 等隐藏容器并派发
                  palink:st_mount_points_ready，使 sillytavern_extension 插件（含 ESM 样例）
                  在任意视图（默认 CharacterChat / NativeRoleplayChat）都能注入设置面板。 */}
              <StPluginMountPoints />
              {isMobile && !stNativeActive && !pluginFullscreen && <MobileBottomNav {...sidebarProps} />}
              <WidescreenPrompt />
            </div>
          ) : (
            <Navigate to="/login" replace />
          )
        } />
      </Routes>
      <Toaster richColors position="top-right" />
      <Popup />
    </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
