import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';

// --- 第三方库处理说明 ---
// 在本地开发环境中，您可以取消以下注释并安装 'react-syntax-highlighter' 以获得更强大的代码高亮
// import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  MessageSquare, Settings, Send, Link as LinkIcon,
  Loader2, Trash2, Plus, X, Image as ImageIcon,
  UploadCloud, FileText, Server, Sparkles,
  Edit3, StopCircle, ChevronDown, ChevronRight,
  Sun, Moon, Copy, Check, Bot, Paperclip, 
  PanelLeftClose, User, Users, CheckSquare, Square, 
  Brain, MessageSquarePlus, HardDrive, 
  Folder, FolderOpen, Move, Search, Command,
  MoreVertical, Grid, List, Bell, Shield, Monitor,
  Music, Video, Home, ArrowUp, FolderPlus,
  CornerDownRight, LogOut, Key, Database, LayoutGrid, ChevronUp,
  Cpu, Zap, Globe, Layers, AlertCircle, RefreshCw, Eye, Lock, Save, ExternalLink,
  MessageCircle, FileCheck, Play, FileDigit, Calendar, Type, File as FileIcon,
  Languages, BrainCircuit, Sidebar, LayoutTemplate, HelpCircle, FileClock,
  Mic, Camera, Palette, Component, Smile, Upload, ArrowUpFromLine
} from 'lucide-react';

/**
 * Palink AI Frontend - LobeChat Style UI Overhaul (Fixed & Enhanced)
 */

const TRANSLATIONS = {
  zh: {
    nav_chat: "对话",
    nav_files: "工作空间",
    nav_config: "设置",
    chat_history: "历史记录",
    new_chat: "开启新对话",
    new_project: "新建项目",
    delete_selected: "删除选中",
    batch_manage: "批量管理",
    drop_files: "拖拽文件上传",
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
    settings_providers: "语言模型",
    settings_admin: "系统管理",
    settings_about: "关于",
    save: "保存更改",
    logout: "退出登录",
    admin_users: "用户管理",
    admin_defaults: "默认配置",
    admin_starters: "推荐话题",
    files_col_name: "名称",
    files_col_date: "日期",
    files_col_size: "大小",
    gen_outline: "智能分析",
    outline_title: "文件洞察",
    btn_generate: "生成摘要",
    outline_placeholder: "点击生成以获取关键洞察...",
    select_model_workspace: "分析模型",
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
    theme_mode: "主题模式",
    theme_light: "亮色",
    theme_dark: "暗色",
    action_delete: "删除",
    
    // Settings Specific
    settings_avatar_url: "头像设置",
    settings_avatar_desc: "自定义您的个人资料图片",
    settings_username: "用户名",
    settings_username_desc: "您在系统中的显示名称",
    settings_danger_zone: "危险区域",
    logout_desc: "注销当前设备的登录状态",
    add_provider: "添加服务商",
    edit: "编辑",
    active_models: "个启用模型",
    select_model: "选择模型",
    enter_question_placeholder: "输入推荐问题，每行一个...",
    role: "角色",
    about_title: "关于 Palink AI",
    about_desc: "企业级 AI 协作空间",
    version: "版本 15.1 (Lobe 风格)",
    privacy_policy: "隐私协议",
    edit_provider: "编辑服务商",
    add_provider_title: "添加服务商",
    provider_name: "显示名称",
    base_url: "API 代理地址 (Base URL)",
    api_key: "API 密钥 (Key)",
    model_list: "模型列表",
    add_model: "添加模型",
    model_id_placeholder: "模型 ID (如 gpt-4)",
    model_alias_placeholder: "显示别名",
    stop_generating: "停止生成",
    ai_disclaimer: "AI 可能会犯错，请核对重要信息。",
    sign_in: "登录",
    sign_up: "注册",
    create_account: "创建新账号",
    back_to_login: "已有账号？去登录",
    welcome_back: "欢迎回来",
    cancel: "取消",
    confirm: "确定",
    ok: "确定",
    add: "添加",
    upload_image: "上传图片",
    use_url: "使用链接",
    choose_emoji: "选择表情"
  },
  en: {
    nav_chat: "Chat",
    nav_files: "Workspace",
    nav_config: "Settings",
    chat_history: "History",
    new_chat: "New Chat",
    new_project: "New Project",
    delete_selected: "Delete",
    batch_manage: "Manage",
    drop_files: "Drop files",
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
    settings_common: "Common",
    settings_profile: "Profile",
    settings_security: "Security",
    settings_providers: "Language Models",
    settings_admin: "System Admin",
    settings_about: "About",
    save: "Save Changes",
    logout: "Log Out",
    admin_users: "Users",
    admin_defaults: "Defaults",
    admin_starters: "Starters",
    files_col_name: "Name",
    files_col_date: "Date",
    files_col_size: "Size",
    gen_outline: "Analyze",
    outline_title: "File Insights",
    btn_generate: "Generate",
    outline_placeholder: "Click generate to analyze...",
    select_model_workspace: "Analysis Model",
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
    theme_mode: "Theme Mode",
    theme_light: "Light",
    theme_dark: "Dark",
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
    select_model: "Select Model",
    enter_question_placeholder: "Enter one question per line...",
    role: "Role",
    about_title: "Palink AI",
    about_desc: "Enterprise Grade AI Workspace",
    version: "Version 15.1 (Lobe Style)",
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
    stop_generating: "Stop Generating",
    ai_disclaimer: "AI can make mistakes. Please verify important information.",
    sign_in: "Sign In",
    sign_up: "Sign Up",
    create_account: "Create an account",
    back_to_login: "Log in",
    welcome_back: "Welcome back",
    cancel: "Cancel",
    confirm: "Confirm",
    ok: "OK",
    add: "Add",
    upload_image: "Upload Image",
    use_url: "Use URL",
    choose_emoji: "Choose Emoji"
  }
};

// --- UI Components (LobeChat Style) ---

const Button = ({ children, onClick, variant="primary", className="", icon: Icon, size="md", disabled, title, ...props }) => {
    const sizeClasses = { 
        sm: "px-3 py-1.5 text-xs h-8", 
        md: "px-4 py-2 text-sm h-10", 
        lg: "px-6 py-3 text-base h-12",
        icon: "p-2 h-10 w-10 justify-center" 
    };
    
    const variants = {
        primary: "bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 shadow-sm border border-transparent",
        secondary: "bg-white dark:bg-[#2c2c2c] text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#3a3a3a] shadow-sm",
        ghost: "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2c2c2c] hover:text-black dark:hover:text-white",
        danger: "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30",
        outline: "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 bg-transparent"
    };

    return (
        <button 
            onClick={onClick} 
            disabled={disabled} 
            title={title} 
            className={`
                flex items-center gap-2 rounded-xl font-medium transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed
                ${sizeClasses[size] || sizeClasses.md} 
                ${variants[variant]} 
                ${className}
            `} 
            {...props}
        >
            {Icon && <Icon size={size === 'sm' ? 14 : 18} />}
            {children}
        </button>
    );
};

const SettingItem = ({ icon: Icon, label, desc, children, className="", danger=false }) => (
    <div className={`flex items-center justify-between p-4 min-h-[72px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors first:rounded-t-2xl last:rounded-b-2xl ${className}`}>
        <div className="flex items-center gap-4 overflow-hidden">
            {Icon && <div className={`p-2.5 rounded-xl ${danger ? 'bg-red-50 text-red-500' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}><Icon size={20}/></div>}
            <div className="flex-1 min-w-0">
                <div className={`font-medium text-sm truncate ${danger ? 'text-red-600' : 'text-gray-900 dark:text-gray-100'}`}>{label}</div>
                {desc && <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{desc}</div>}
            </div>
        </div>
        <div className="flex-shrink-0 ml-6 flex items-center gap-2">
            {children}
        </div>
    </div>
);

const SettingGroup = ({ title, children, className="" }) => (
    <div className={`mb-8 ${className}`}>
        {title && <div className="px-3 mb-2 text-xs font-bold text-gray-400 uppercase tracking-wider">{title}</div>}
        <div className="bg-white dark:bg-[#1c1c1c] border border-gray-100 dark:border-gray-800 rounded-2xl divide-y divide-gray-50 dark:divide-gray-800 shadow-sm transition-all hover:shadow-md">
            {children}
        </div>
    </div>
);

const ThinkingProcess = ({ content, streaming, t }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    useEffect(() => { if (streaming && content) setIsExpanded(true); }, [streaming]);
    if (!content) return null;
    return (
        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#2c2c2c] overflow-hidden transition-all">
            <button onClick={() => setIsExpanded(!isExpanded)} className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#333] transition-colors">
                <Brain size={14} className={streaming ? "animate-pulse text-purple-500" : "text-gray-400"}/>
                <span>{t.thinking}</span>
                <span className="ml-auto"></span>
                {isExpanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
            </button>
            {isExpanded && (
                <div className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300 font-mono border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-[#222]">
                    <ReactMarkdown components={{code:CodeBlock}}>{content}</ReactMarkdown>
                </div>
            )}
        </div>
    );
};

const CodeBlock = memo(({ inline, className, children, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const [copied, setCopied] = useState(false);
  if (inline || !match) {
      return <code className="bg-gray-100 dark:bg-gray-800 text-pink-600 dark:text-pink-400 px-1.5 py-0.5 rounded text-[0.9em] font-mono border border-gray-200 dark:border-gray-700 mx-0.5 align-middle break-all" {...props}>{children}</code>;
  }
  return (
    <div className="relative my-4 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-[#1e1e1e] shadow-sm group">
      <div className="flex justify-between px-3 py-1.5 bg-[#2d2d2d] text-xs text-gray-400 items-center select-none">
        <span className="font-mono font-bold text-gray-300">{match?.[1] || 'text'}</span>
        <button onClick={()=>{navigator.clipboard.writeText(String(children));setCopied(true);setTimeout(()=>setCopied(false),2000)}} className="hover:text-white flex items-center gap-1 transition-colors">
          {copied ? <Check size={12}/> : <Copy size={12}/>}
        </button>
      </div>
      <pre className="p-4 text-sm font-mono leading-relaxed overflow-x-auto" style={{margin:0, fontSize:'0.85em', lineHeight:'1.5'}}>
        <code className="language-{match?.[1] || 'text'}" {...props}>
          {String(children).replace(/\n$/, '')}
        </code>
      </pre>
    </div>
  );
});

const Avatar = memo(({ url, username, size="md", className="" }) => {
  const sizeClass = { sm: 'w-8 h-8 text-xs', md: 'w-10 h-10 text-sm', lg: 'w-16 h-16 text-xl', xl: 'w-24 h-24 text-2xl' }[size] || 'w-10 h-10 text-sm';
  if (url && url.startsWith('http')) return <img src={url} className={`${sizeClass} rounded-full object-cover border border-gray-100 dark:border-gray-700 shadow-sm bg-white dark:bg-gray-800 ${className}`} alt="Avatar" />;
  if (url && url.startsWith('data:image')) return <img src={url} className={`${sizeClass} rounded-full object-cover border border-gray-100 dark:border-gray-700 shadow-sm bg-white dark:bg-gray-800 ${className}`} alt="Avatar" />;
  if (url && !url.startsWith('http')) return <div className={`${sizeClass} rounded-full bg-blue-50 dark:bg-[#333] flex items-center justify-center border border-blue-100 dark:border-gray-700 ${className} text-xl`}>{url}</div>;
  return <div className={`${sizeClass} rounded-full bg-gradient-to-tr from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 text-gray-700 dark:text-gray-300 flex items-center justify-center font-bold uppercase shadow-sm ${className}`}>{username ? username[0] : 'U'}</div>;
});

// --- 1. Home Screen (Dynamic LobeChat Style) ---

const DoubaoHomeScreen = ({ t, models, onSelectModel, onSelectStarter, starterQuestions, currentModelId, onSendMessage }) => {
    const [input, setInput] = useState('');
    const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
    
    // 3. Dynamic Model Info
    const currentModel = models.find(m => m.id === currentModelId) || models[0] || { name: 'AI Assistant', icon: '🤖', description: t.welcome_greeting };

    const handleSend = () => {
        if(!input.trim()) return;
        onSendMessage(input);
    };

    return (
        <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#121212] p-4 relative overflow-hidden">
            <div className="w-full max-w-2xl flex flex-col items-center z-10 -mt-16 animate-in fade-in slide-in-from-bottom-8 duration-700">
                
                {/* Dynamic Logo Area */}
                <div className="mb-10 text-center flex flex-col items-center gap-6">
                    <div className="w-28 h-28 bg-gradient-to-br from-white to-gray-50 dark:from-[#222] dark:to-[#1a1a1a] rounded-[32px] mx-auto flex items-center justify-center text-6xl shadow-2xl shadow-gray-200 dark:shadow-black/40 border border-gray-100 dark:border-gray-800 overflow-hidden transform hover:scale-105 transition-transform duration-500">
                         {currentModel?.icon?.startsWith('http') ? <img src={currentModel.icon} className="w-full h-full object-cover"/> : (currentModel?.icon || '🤖')}
                    </div>
                    <div>
                        <h1 className="text-3xl font-extrabold dark:text-white mb-3 tracking-tight">{currentModel.name}</h1>
                        <p className="text-gray-400 dark:text-gray-500 text-base max-w-md mx-auto leading-relaxed">{currentModel.description || t.welcome_greeting}</p>
                    </div>
                </div>

                {/* Input Area (Floating Pill) */}
                <div className="w-full relative group">
                    <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-[28px] blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-700"/>
                    <div className="relative w-full bg-white dark:bg-[#1c1c1c] rounded-[24px] shadow-2xl shadow-gray-200/50 dark:shadow-black/20 border border-gray-100 dark:border-gray-800 p-2 transition-all focus-within:ring-2 focus-within:ring-black/5 dark:focus-within:ring-white/10 hover:shadow-xl dark:hover:shadow-black/30">
                        
                        <textarea 
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                            placeholder={t.ask_anything}
                            className="w-full bg-transparent border-none outline-none resize-none px-5 py-4 text-lg dark:text-white placeholder-gray-400/80 min-h-[64px] max-h-[200px]"
                            rows={1}
                        />

                        {/* Model & Actions Bar */}
                        <div className="flex justify-between items-center px-3 pb-1">
                            {/* 4. Model Selector (Click Interaction) */}
                             <div className="relative">
                                 <button 
                                    onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-[#2c2c2c] text-xs font-bold text-gray-500 dark:text-gray-400 transition-all active:scale-95"
                                 >
                                     <span className="opacity-70 text-base">{currentModel?.icon}</span>
                                     {currentModel?.name}
                                     <ChevronDown size={14} className={`opacity-50 transition-transform duration-300 ${isModelMenuOpen ? 'rotate-180' : ''}`}/>
                                 </button>
                                 
                                 {isModelMenuOpen && (
                                     <>
                                        <div className="fixed inset-0 z-40" onClick={()=>setIsModelMenuOpen(false)}/>
                                        <div className="absolute top-full left-0 mt-2 w-64 bg-white dark:bg-[#1c1c1c] rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 p-2 z-50 animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-200 origin-top-left">
                                            <div className="max-h-64 overflow-y-auto p-1 space-y-1">
                                                {models.map(m => (
                                                    <button key={m.id} onClick={()=>{onSelectModel(m.id); setIsModelMenuOpen(false);}} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${currentModelId===m.id ? 'bg-black/5 dark:bg-white/10 font-bold dark:text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-[#2c2c2c]'}`}>
                                                        <span className="text-lg">{m.icon}</span>
                                                        <div className="flex flex-col items-start overflow-hidden">
                                                            <span className="truncate w-full">{m.name}</span>
                                                            <span className="text-[10px] opacity-50 truncate w-full">{m.provider}</span>
                                                        </div>
                                                        {currentModelId===m.id && <Check size={14} className="ml-auto opacity-50"/>}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                     </>
                                 )}
                             </div>

                            <div className="flex items-center gap-2">
                                <button className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-[#333]"><ImageIcon size={20}/></button>
                                <button 
                                    onClick={handleSend}
                                    disabled={!input.trim()}
                                    className="bg-black dark:bg-white text-white dark:text-black rounded-xl p-2.5 disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80 transition-all active:scale-90"
                                >
                                    {/* 1. Fixed Send Button Logo */}
                                    <ArrowUp size={22} strokeWidth={3} />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Suggestions */}
                {starterQuestions && starterQuestions.length > 0 && (
                    <div className="mt-8 flex flex-wrap justify-center gap-3 opacity-0 animate-in fade-in slide-in-from-bottom-4 fill-mode-forwards delay-300" style={{animationDelay: '0.3s'}}>
                        {starterQuestions.map((q, idx) => (
                            <button key={idx} onClick={() => onSendMessage(q)} className="px-4 py-2 bg-white dark:bg-[#1c1c1c] border border-gray-100 dark:border-gray-800 rounded-full text-xs font-medium text-gray-500 dark:text-gray-400 hover:scale-105 hover:text-black dark:hover:text-white hover:border-gray-300 dark:hover:border-gray-600 transition-all shadow-sm">
                                {q}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

// ... (WorkspaceView remains largely the same, ensuring transitions) ...
const WorkspaceView = ({ token, user, filesToUpload, onClearUploads, t, models, isDark, toggleTheme, systemDefaults }) => {
    // ... [Original Logic] ...
    const [path, setPath] = useState([]); 
    const [items, setItems] = useState({ folders: [], files: [], usage: 0, limit: 0 });
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [viewMode, setViewMode] = useState('list');
    const [isCreateFolder, setIsCreateFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [selectedFiles, setSelectedFiles] = useState(new Set()); 
    const [sidebarTab, setSidebarTab] = useState('files');
    const [workspaceMode, setWorkspaceMode] = useState('browser');
    const [workspaceSessions, setWorkspaceSessions] = useState([]);
    const [activeWsSid, setActiveWsSid] = useState(null); 
    const [workspaceModel, setWorkspaceModel] = useState('');
    const [outlineModel, setOutlineModel] = useState('');
    const [analyzingFile, setAnalyzingFile] = useState(null);
    const [analyzing, setAnalyzing] = useState(false);
    const fileInputRef = useRef(null);
    const currentFolderId = path.length > 0 ? path[path.length - 1].id : "";

    useEffect(() => { 
        if(models.length) {
            setWorkspaceModel(systemDefaults.default_workspace_model || models[0].id);
            setOutlineModel(systemDefaults.default_outline_model || models[0].id);
        }
    }, [models, systemDefaults]);

    const fetchItems = useCallback(async () => {
        setLoading(true);
        try {
            const url = `/api/workspace?parent_id=${currentFolderId || ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw new Error("Failed");
            setItems(await res.json());
        } catch(e) {} finally { setLoading(false); }
    }, [currentFolderId, token]);

    const fetchWorkspaceSessions = useCallback(async () => {
        try {
            const res = await fetch('/api/sessions?type=workspace', { headers: { Authorization: `Bearer ${token}` } });
            if(res.ok) setWorkspaceSessions(await res.json());
        } catch(e) {}
    }, [token]);

    useEffect(() => { fetchItems(); fetchWorkspaceSessions(); }, [fetchItems, fetchWorkspaceSessions]);
    useEffect(() => { if (filesToUpload?.length) { handleBatchUpload(filesToUpload); onClearUploads(); } }, [filesToUpload, handleBatchUpload, onClearUploads]);

    const handleCreateFolder = async () => {
        if(!newFolderName.trim()) return setIsCreateFolder(false);
        try { await fetch('/api/workspace/folder', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newFolderName, parent_id: currentFolderId || "" }) }); setNewFolderName(""); setIsCreateFolder(false); fetchItems(); } catch(e) {}
    };

    const handleBatchUpload = async (eOrFiles) => {
        const files = eOrFiles.target ? Array.from(eOrFiles.target.files) : eOrFiles;
        if (!files || files.length === 0) return;
        setUploading(true);
        for (const file of files) {
            const fd = new FormData(); fd.append('file', file); fd.append('folder_id', currentFolderId || ""); 
            try { await fetch('/api/workspace/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }); } catch(e) { console.error(e); }
        }
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = ''; 
        fetchItems();
    };
    
    const handleDeleteItem = async (id, type) => {
        if(!confirm(t.delete_selected + "?")) return;
        const body = type === 'file' ? { file_ids: [id] } : { folder_ids: [id] };
        await fetch('/api/workspace/delete', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        fetchItems();
        if (type === 'file') { const newSet = new Set(Array.from(selectedFiles).filter(f => f.id !== id)); setSelectedFiles(newSet); }
    };

    const handleGenerateOutline = async () => {
        if (!analyzingFile || !outlineModel) return;
        setAnalyzing(true);
        try {
            const res = await fetch('/api/workspace/analyze', {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: analyzingFile.id, model: outlineModel, lang: t.lang_switch === "English" ? "zh" : "en" })
            });
            const data = await res.json();
            setAnalyzingFile(prev => ({ ...prev, summary: data.summary }));
            setItems(prev => ({ ...prev, files: prev.files.map(f => f.id === analyzingFile.id ? { ...f, summary: data.summary } : f) }));
        } catch(e) { alert("Error: " + e.message); }
        setAnalyzing(false);
    };

    const toggleSelection = (file) => {
        const newSet = new Set(selectedFiles);
        const exists = Array.from(newSet).find(f => f.id === file.id);
        if (exists) newSet.delete(exists); else newSet.add(file);
        setSelectedFiles(newSet);
        if (!exists && newSet.size === 1) setAnalyzingFile(file);
        else if (newSet.size !== 1) setAnalyzingFile(null);
    };

    const handleStartProject = () => { 
        if (selectedFiles.size === 0) return; 
        setWorkspaceMode('chat'); 
        setActiveWsSid(null); 
    };

    const handleReturnToFiles = () => {
        setWorkspaceMode('browser');
        setActiveWsSid(null);
        refreshSessions();
    };

    const refreshSessions = () => fetchWorkspaceSessions();
    const isSelected = (id) => Array.from(selectedFiles).some(f => f.id === id);
    const fmtSize = (s) => s < 1024 ? s+'B' : s < 1024*1024 ? (s/1024).toFixed(1)+'KB' : (s/1024/1024).toFixed(1)+'MB';

    if (workspaceMode === 'chat') {
        return (
            <div className="flex h-full w-full">
                <div className="w-64 bg-gray-50/50 dark:bg-[#151515] border-r border-gray-200 dark:border-gray-800 flex flex-col shrink-0">
                    <div className="p-4 flex items-center justify-between">
                         <span className="text-sm font-bold dark:text-white">{t.tab_projects}</span>
                         <Button variant="ghost" size="sm" icon={FolderOpen} onClick={handleReturnToFiles} title={t.back_to_home} />
                    </div>
                    <div className="flex-1 overflow-y-auto px-2 space-y-1">
                        <div onClick={() => setActiveWsSid(null)} className={`p-3 rounded-lg text-sm cursor-pointer flex items-center gap-2 ${!activeWsSid ? 'bg-white dark:bg-[#222] shadow-sm font-medium' : 'text-gray-500 hover:bg-gray-200/50'}`}>
                            <Plus size={14}/> {t.new_project}
                        </div>
                        {workspaceSessions.map(s => (
                            <div key={s.id} onClick={() => setActiveWsSid(s.id)} className={`p-3 rounded-lg text-sm cursor-pointer truncate ${activeWsSid===s.id ? 'bg-white dark:bg-[#222] shadow-sm font-medium' : 'text-gray-500 hover:bg-gray-200/50'}`}>
                                {s.title || 'Untitled Project'}
                            </div>
                        ))}
                    </div>
                </div>
                <div className="flex-1 bg-white dark:bg-[#121212] relative">
                     <ChatInterface 
                        token={token} user={user} sessionId={activeWsSid} 
                        initialAttachments={!activeWsSid ? Array.from(selectedFiles).map(f => ({ type: f.type.includes('image') ? 'image' : 'file', url: f.url, name: f.filename })) : []}
                        onSessionChange={refreshSessions} t={t} models={models} defaultModel={workspaceModel} sessionType="workspace" starterQuestions={[]} 
                     />
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full w-full bg-white dark:bg-[#121212]">
            <div className="w-80 border-r border-gray-100 dark:border-gray-800 flex flex-col bg-gray-50/30 dark:bg-[#151515] shrink-0">
                <div className="p-4">
                    <div className="bg-gray-100 dark:bg-[#222] p-1 rounded-lg flex text-xs font-medium mb-4">
                         <button onClick={()=>setSidebarTab('files')} className={`flex-1 py-1.5 rounded-md transition-all ${sidebarTab==='files'?'bg-white dark:bg-[#333] shadow-sm text-black dark:text-white':'text-gray-500'}`}>{t.tab_files}</button>
                         <button onClick={()=>setSidebarTab('projects')} className={`flex-1 py-1.5 rounded-md transition-all ${sidebarTab==='projects'?'bg-white dark:bg-[#333] shadow-sm text-black dark:text-white':'text-gray-500'}`}>{t.tab_projects}</button>
                    </div>
                    {sidebarTab === 'files' ? (
                        <>
                            <div className="flex justify-between items-center mb-2">
                                <h3 className="font-bold text-sm text-gray-900 dark:text-white">{t.files_selected} ({selectedFiles.size})</h3>
                                {selectedFiles.size > 0 && <button onClick={()=>setSelectedFiles(new Set())} className="text-xs text-gray-400 hover:text-red-500">{t.clear}</button>}
                            </div>
                            <div className="space-y-2 mb-4">
                                {selectedFiles.size === 0 && <div className="text-center py-8 text-gray-400 text-xs border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-xl">{t.empty_selection}</div>}
                                {Array.from(selectedFiles).map(f => (
                                    <div key={f.id} className="flex items-center gap-2 p-2 bg-white dark:bg-[#1c1c1c] rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm text-sm">
                                        <div className="text-lg">{f.type.includes('image') ? '🖼️' : '📄'}</div>
                                        <div className="flex-1 truncate dark:text-gray-300">{f.filename}</div>
                                        <button onClick={()=>toggleSelection(f)}><X size={14} className="text-gray-400 hover:text-red-500"/></button>
                                    </div>
                                ))}
                            </div>
                            
                            {analyzingFile && (
                                <div className="bg-white dark:bg-[#1c1c1c] rounded-xl border border-gray-100 dark:border-gray-800 p-4 shadow-sm animate-in slide-in-from-bottom-5">
                                    <div className="flex items-center gap-2 mb-3 text-sm font-bold dark:text-white">
                                        <BrainCircuit size={16} className="text-purple-500"/> {t.outline_title}
                                    </div>
                                    <div className="flex gap-2 mb-3">
                                        <select value={outlineModel} onChange={e=>setOutlineModel(e.target.value)} className="flex-1 text-xs p-1.5 rounded-lg bg-gray-50 dark:bg-[#2c2c2c] border-transparent outline-none dark:text-white">
                                            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                                        </select>
                                        <Button size="sm" onClick={handleGenerateOutline} disabled={analyzing} icon={analyzing ? Loader2 : Sparkles}>{t.btn_generate}</Button>
                                    </div>
                                    <div className="max-h-[200px] overflow-y-auto text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-[#2c2c2c] rounded-lg p-2 leading-relaxed">
                                        {analyzingFile.summary ? <ReactMarkdown>{analyzingFile.summary}</ReactMarkdown> : <div className="text-center opacity-50 italic py-4">{t.outline_placeholder}</div>}
                                    </div>
                                </div>
                            )}

                            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                                <Button onClick={handleStartProject} disabled={selectedFiles.size === 0} className="w-full justify-center" icon={MessageSquarePlus}>{t.create_project}</Button>
                            </div>
                        </>
                    ) : (
                         <div className="space-y-2">
                             {workspaceSessions.map(s => (
                                 <div key={s.id} onClick={() => { setWorkspaceMode('chat'); setActiveWsSid(s.id); }} className="p-3 bg-white dark:bg-[#1c1c1c] border border-gray-100 dark:border-gray-800 rounded-lg cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-all">
                                     <div className="font-bold text-sm dark:text-gray-200 mb-1">{s.title || 'Untitled'}</div>
                                     <div className="text-[10px] text-gray-400">{new Date(s.updated_at).toLocaleDateString()}</div>
                                 </div>
                             ))}
                         </div>
                    )}
                </div>
            </div>
            <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-[#121212]">
                <div className="h-16 px-6 flex items-center justify-between border-b border-gray-50 dark:border-gray-800">
                     <div className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
                         <Button variant="ghost" size="sm" icon={Home} onClick={()=>setPath([])} className="text-gray-400"/>
                         {path.map((p, idx) => (
                             <React.Fragment key={p.id}>
                                 <ChevronRight size={14} className="text-gray-300"/>
                                 <button onClick={()=>setPath(path.slice(0, idx+1))} className="hover:bg-gray-100 dark:hover:bg-[#2c2c2c] px-2 py-1 rounded-md transition-colors">{p.name}</button>
                             </React.Fragment>
                         ))}
                     </div>
                     <div className="flex items-center gap-2">
                        <Button variant="ghost" size="icon" onClick={fetchItems} icon={RefreshCw}/>
                        <div className="h-4 w-px bg-gray-200 dark:bg-gray-800 mx-1"/>
                        <Button variant="secondary" size="sm" onClick={() => fileInputRef.current.click()} icon={uploading ? Loader2 : UploadCloud} disabled={uploading}>{t.upload}</Button>
                        <Button variant="primary" size="sm" onClick={() => setIsCreateFolder(true)} icon={FolderPlus}>{t.new_folder}</Button>
                        <input type="file" className="hidden" ref={fileInputRef} onChange={handleBatchUpload} multiple/>
                        <div className="h-4 w-px bg-gray-200 dark:bg-gray-800 mx-1"/>
                        <div className="flex bg-gray-100 dark:bg-[#2c2c2c] p-1 rounded-lg">
                            <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md ${viewMode==='list'?'bg-white dark:bg-[#333] shadow-sm':'text-gray-400'}`}><List size={16}/></button>
                            <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md ${viewMode==='grid'?'bg-white dark:bg-[#333] shadow-sm':'text-gray-400'}`}><Grid size={16}/></button>
                        </div>
                     </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                    {isCreateFolder && (
                        <div className="mb-4 flex items-center gap-2 animate-in slide-in-from-top-2">
                           <Folder className="text-yellow-400" size={24}/>
                           <input autoFocus value={newFolderName} onChange={e=>setNewFolderName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleCreateFolder()} className="bg-transparent text-lg font-bold border-b-2 border-blue-500 outline-none dark:text-white w-64 pb-1" placeholder={t.folder_name_placeholder}/>
                           <Button size="sm" variant="primary" onClick={handleCreateFolder}>{t.ok}</Button>
                           <Button size="sm" variant="ghost" onClick={()=>setIsCreateFolder(false)}>{t.cancel}</Button>
                        </div>
                    )}
                    {viewMode === 'list' && (
                        <div className="space-y-1">
                            {items.folders.map(item => (
                                <div key={item.id} onClick={() => setPath([...path, {id:item.id, name:item.name}])} className="group flex items-center p-3 rounded-xl hover:bg-gray-50 dark:hover:bg-[#1c1c1c] cursor-pointer transition-colors">
                                    <Folder className="text-yellow-400 fill-yellow-400/20 mr-4" size={24}/>
                                    <div className="flex-1 font-medium dark:text-gray-200">{item.name}</div>
                                    <div className="text-xs text-gray-400 mr-4">{new Date(item.created_at).toLocaleDateString()}</div>
                                    <div className="opacity-0 group-hover:opacity-100">
                                        <Button size="sm" variant="ghost" icon={Trash2} onClick={(e)=>{e.stopPropagation(); handleDeleteItem(item.id, 'folder')}} className="text-red-500 hover:text-red-600"/>
                                    </div>
                                </div>
                            ))}
                            {items.files.map(item => (
                                <div key={item.id} onClick={() => toggleSelection(item)} className={`group flex items-center p-3 rounded-xl cursor-pointer transition-colors ${isSelected(item.id) ? 'bg-blue-50 dark:bg-blue-900/10' : 'hover:bg-gray-50 dark:hover:bg-[#1c1c1c]'}`}>
                                    <div className="mr-4 text-xl">{item.type.includes('image') ? '🖼️' : '📄'}</div>
                                    <div className="flex-1 font-medium dark:text-gray-200 truncate pr-4">{item.filename}</div>
                                    <div className="text-xs text-gray-400 mr-4 w-20 text-right">{fmtSize(item.size)}</div>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button size="sm" variant="ghost" icon={BrainCircuit} onClick={(e)=>{e.stopPropagation(); setAnalyzingFile(item); setSidebarTab('files')}} className="text-purple-500"/>
                                        <Button size="sm" variant="ghost" icon={Trash2} onClick={(e)=>{e.stopPropagation(); handleDeleteItem(item.id, 'file')}} className="text-red-500"/>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {viewMode === 'grid' && (
                         <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4">
                            {items.folders.map(f => ( <div key={f.id} onClick={()=>setPath([...path, {id:f.id, name:f.name}])} className="flex flex-col items-center p-6 rounded-2xl bg-gray-50 dark:bg-[#1c1c1c] hover:bg-gray-100 dark:hover:bg-[#252525] cursor-pointer transition-all"><Folder className="text-yellow-400 fill-yellow-400/20 mb-3" size={48}/><span className="text-sm font-medium text-center truncate w-full dark:text-gray-200">{f.name}</span></div>))}
                            {items.files.map(f => ( <div key={f.id} onClick={()=>toggleSelection(f)} className={`relative flex flex-col items-center p-6 rounded-2xl cursor-pointer transition-all border-2 ${isSelected(f.id)?'bg-blue-50 dark:bg-blue-900/10 border-blue-500':'bg-white dark:bg-[#1c1c1c] border-transparent hover:shadow-lg'}`}>{isSelected(f.id) && <div className="absolute top-2 right-2 text-blue-500"><Check size={16}/></div>}<div className="mb-3 text-4xl">{f.type.includes('image')?'🖼️':'📄'}</div><span className="text-sm font-medium text-center truncate w-full dark:text-gray-200">{f.filename}</span><span className="text-xs text-gray-400 mt-1">{fmtSize(f.size)}</span></div>))}
                         </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const ChatInterface = ({ token, user, sessionId, initialAttachments, onSessionChange, t, models, defaultModel, sessionType='chat', starterQuestions }) => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [streaming, setStreaming] = useState(false);
    const [curModel, setCurModel] = useState(defaultModel || (models[0]?.id));
    const [attachments, setAttachments] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const bottomRef = useRef(null);
    const abortCtrl = useRef(null);
    const imgInputRef = useRef(null);
    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);

    // 4. Optimized Chat Typography & Spacing
    useEffect(() => {
        if(sessionId) { fetch(`/api/sessions/${sessionId}/messages`, { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(d => { setMessages(d); setSuggestions([]); }); } 
        else { setMessages([]); if (initialAttachments?.length) setAttachments(initialAttachments); setSuggestions([]); }
    }, [sessionId, token, initialAttachments]);

    useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming, suggestions]);

    const handleUpload = async (e, type) => {
      const file = e.target.files?.[0]; if (!file) return; setUploading(true);
      const reader = new FileReader(); reader.onload = async (event) => { try { const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ filename: file.name, data: event.target.result }) }); if(res.ok) { const data = await res.json(); setAttachments(prev => [...prev, { type, url: data.url, name: file.name }]); } } catch(e) {} setUploading(false); }; reader.readAsDataURL(file); if(e.target.value) e.target.value = '';
    };

    const sendMessage = async (overrideText) => {
        const txt = overrideText || input;
        if((!txt.trim() && attachments.length === 0) || streaming || uploading) return;
        setInput(''); setAttachments([]); setStreaming(true); setSuggestions([]);
        
        let displayContent = txt;
        if (attachments.length > 0) { displayContent += "\n\n"; attachments.forEach(att => { displayContent += att.type === 'image' ? `![${att.name}](${att.url})\n` : `[📎 ${att.name}](${att.url})\n`; }); }
        
        setMessages(prev => [...prev, {role:'user', content:displayContent}, {role:'assistant', content:'', model: curModel}]);
        abortCtrl.current = new AbortController();
        let fullContent = ''; let fullReasoning = '';

        try {
            const res = await fetch('/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, session_type: sessionType, message: txt, model: curModel, images: attachments.filter(a => a.type === 'image').map(a => a.url), files: attachments.filter(a => a.type === 'file').map(a => a.url) }), signal: abortCtrl.current.signal });
            if (!sessionId) { setTimeout(onSessionChange, 1000); }
            const reader = res.body.getReader(); const dec = new TextDecoder();
            while(true) {
                const {done, value} = await reader.read(); if(done) break;
                const lines = dec.decode(value, {stream:true}).split('\n');
                for(const line of lines) {
                    if(line.startsWith('data: ')) {
                        const d = line.slice(6); if(d === '[DONE]') continue;
                        try { const j = JSON.parse(d); if (j.reasoning) fullReasoning += j.reasoning; if (j.content) fullContent += j.content; setMessages(prev => { const n = [...prev]; const last = n[n.length-1]; last.content = fullReasoning ? `<think>${fullReasoning}</think>${fullContent}` : fullContent; return n; }); } catch(e){}
                    }
                }
            }
            if (fullContent.length > 20) { fetch('/api/chat/suggestions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: fullContent, model: curModel }) }).then(r=>r.json()).then(setSuggestions).catch(()=>{}); }
        } catch(e) { if(e.name !== 'AbortError') setMessages(prev => { const n=[...prev]; n[n.length-1].content += `\n[Error: ${e.message}]`; return n; }); } finally { setStreaming(false); abortCtrl.current = null; }
    };

    return (
        <div className="flex flex-col h-full bg-white dark:bg-[#121212]">
            {/* Header */}
            {(messages.length > 0 || sessionId) && (
                <div className="h-14 flex items-center justify-between px-6 border-b border-gray-50 dark:border-gray-800 bg-white/80 dark:bg-[#121212]/80 backdrop-blur-md sticky top-0 z-20">
                     <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-gray-100 dark:bg-[#222] rounded-lg text-xs font-bold dark:text-gray-300 flex items-center gap-2">
                             <Bot size={14}/> {models.find(m=>m.id===curModel)?.name || curModel}
                        </div>
                     </div>
                     <select value={curModel} onChange={e=>setCurModel(e.target.value)} className="text-xs bg-transparent dark:text-gray-400 outline-none cursor-pointer hover:text-black dark:hover:text-white transition-colors">
                        {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                     </select>
                </div>
            )}
            
            {messages.length === 0 && !sessionId && sessionType === 'chat' ? (
                <DoubaoHomeScreen t={t} models={models} currentModelId={curModel} onSelectModel={setCurModel} onSendMessage={sendMessage} starterQuestions={starterQuestions} />
            ) : (
                <>
                <div className="flex-1 overflow-y-auto p-4 md:p-8 scrollbar-thin">
                    <div className="max-w-4xl mx-auto space-y-8">
                        {messages.map((m,i) => (
                        <div key={i} className={`flex gap-4 ${m.role==='user'?'flex-row-reverse':''} items-start group animate-in slide-in-from-bottom-2 duration-300`}>
                                <Avatar url={m.role==='user'?user.avatar:''} username={m.role==='user'?user.username:'AI'} size="md" className="mt-1 shadow-sm shrink-0"/>
                                <div className={`flex flex-col max-w-[85%] ${m.role==='user'?'items-end':''}`}>
                                    <div className={`px-6 py-4 rounded-2xl text-[15px] leading-7 shadow-sm transition-all ${
                                        m.role==='user'
                                        ? 'bg-blue-600 text-white rounded-tr-sm'
                                        : 'bg-white dark:bg-[#1c1c1c] border border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-100 rounded-tl-sm'
                                    }`}>
                                        {m.role === 'assistant' && m.content.includes('<think>') && <ThinkingProcess content={m.content.match(/<think>([\s\S]*?)<\/think>/)?.[1]} streaming={streaming&&i===messages.length-1&&!m.content.split('</think>')[1]} t={t} />}
                                        <ReactMarkdown components={{code: CodeBlock}}>{m.role==='assistant' ? m.content.replace(/<think>[\s\S]*?<\/think>/, '') : m.content}</ReactMarkdown>
                                    </div>
                                    <div className="mt-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                                        <button className="text-gray-400 hover:text-gray-600" onClick={()=>navigator.clipboard.writeText(m.content)}><Copy size={12}/></button>
                                    </div>
                                </div>
                        </div>
                        ))}
                    </div>
                    {suggestions.length > 0 && !streaming && (
                        <div className="flex flex-wrap gap-2 mt-4 max-w-4xl mx-auto justify-end animate-in fade-in slide-in-from-bottom-2">
                            {suggestions.map((s,i) => (<button key={i} onClick={()=>sendMessage(s)} className="px-3 py-1.5 bg-gray-50 dark:bg-[#1c1c1c] hover:bg-white dark:hover:bg-[#252525] border border-gray-200 dark:border-gray-800 rounded-lg text-xs text-gray-500 hover:text-black dark:hover:text-white transition-all shadow-sm">{s}</button>))}
                        </div>
                    )}
                    <div ref={bottomRef} className="h-4"/>
                </div>

                <div className="p-4 md:p-6 bg-gradient-to-t from-white via-white to-transparent dark:from-[#121212] dark:via-[#121212] shrink-0 z-10">
                    <div className="max-w-4xl mx-auto relative w-full">
                        {streaming && <button onClick={()=>abortCtrl.current?.abort()} className="absolute -top-14 left-1/2 -translate-x-1/2 bg-white dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-700 shadow-md px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 hover:bg-gray-50 transition-colors"><StopCircle size={14} className="text-red-500"/> {t.stop_generating}</button>}
                        
                        <div className="w-full bg-white dark:bg-[#1c1c1c] p-2 rounded-[24px] border border-gray-200 dark:border-gray-700 shadow-xl shadow-gray-200/50 dark:shadow-black/20 focus-within:ring-2 focus-within:ring-black/5 dark:focus-within:ring-white/10 transition-all">
                           {attachments.length > 0 && <div className="flex gap-2 px-3 pt-2 pb-1 overflow-x-auto scrollbar-thin">{attachments.map((att, idx) => (<div key={idx} className="relative group bg-gray-50 dark:bg-[#2a2a2a] rounded-lg p-1.5 flex items-center gap-2 border dark:border-gray-600 shrink-0"><span className="text-sm">{att.type==='image'?'🖼️':'📄'}</span><span className="text-xs truncate max-w-[100px] dark:text-gray-300">{att.name}</span><button onClick={() => setAttachments(prev=>prev.filter((_,i)=>i!==idx))} className="absolute -top-1.5 -right-1.5 bg-gray-200 dark:bg-gray-600 rounded-full p-0.5 text-gray-500 opacity-0 group-hover:opacity-100"><X size={10}/></button></div>))}</div>}
                           
                           <div className="flex items-end gap-2">
                               <button className="p-3 text-gray-400 hover:text-black dark:hover:text-white transition-colors" onClick={()=>setCurModel(models[(models.findIndex(m=>m.id===curModel)+1)%models.length]?.id)}><Sparkles size={20}/></button>
                               <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}} placeholder={t.ask_anything} className="w-full bg-transparent border-none outline-none resize-none max-h-40 min-h-[56px] py-4 dark:text-white placeholder-gray-400 text-base" rows={1} />
                               <Button onClick={()=>sendMessage()} disabled={(!input.trim() && attachments.length === 0) || uploading} className="!p-3 !rounded-xl !mb-1.5 bg-black dark:bg-white text-white dark:text-black hover:opacity-80 active:scale-95"><ArrowUp size={22} strokeWidth={3} /></Button>
                           </div>

                           <div className="flex items-center gap-1 px-2 pb-1">
                                <button onClick={()=>imgInputRef.current?.click()} className="p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2c2c2c] rounded-lg transition-colors"><ImageIcon size={18}/></button>
                                <button onClick={()=>fileInputRef.current?.click()} className="p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2c2c2c] rounded-lg transition-colors"><Paperclip size={18}/></button>
                           </div>
                           <input type="file" ref={imgInputRef} className="hidden" accept="image/*" onChange={(e)=>handleUpload(e, 'image')} />
                           <input type="file" ref={fileInputRef} className="hidden" accept="*" onChange={(e)=>handleUpload(e, 'file')} />
                        </div>
                        <div className="text-center mt-2 text-[10px] text-gray-300 dark:text-gray-600 font-mono">{t.ai_disclaimer}</div>
                    </div>
                </div>
                </>
            )}
        </div>
    );
};

const ChatView = ({ token, user, models, t, systemDefaults }) => {
    const [sessions, setSessions] = useState([]);
    const [activeSid, setActiveSid] = useState(null);
    const [isDeleteMode, setIsDeleteMode] = useState(false);
    const [selectedSessions, setSelectedSessions] = useState(new Set());
    const [defaultChatModel, setDefaultChatModel] = useState('');
    const [starterQuestions, setStarterQuestions] = useState([]);

    useEffect(() => { 
        fetch('/api/sessions?type=chat', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setSessions);
        fetch('/api/recommendations/starters', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setStarterQuestions);
        if(models.length) setDefaultChatModel(systemDefaults.default_chat_model || models[0].id); 
    }, [token, systemDefaults, models]);
    
    const refreshSessions = () => fetch('/api/sessions?type=chat', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setSessions);
    const toggleSessionSelect = (sid) => { const newSet = new Set(selectedSessions); if (newSet.has(sid)) newSet.delete(sid); else newSet.add(sid); setSelectedSessions(newSet); };
    const handleBatchDelete = async () => { if(!confirm(t.delete_selected+"?")) return; await fetch('/api/sessions/batch', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_ids: Array.from(selectedSessions) }) }); setSelectedSessions(new Set()); setIsDeleteMode(false); refreshSessions(); if (selectedSessions.has(activeSid)) setActiveSid(null); };

    return (
        <div className="flex h-full w-full bg-white dark:bg-[#121212]">
            <div className="w-72 bg-gray-50/50 dark:bg-[#151515] border-r border-gray-200 dark:border-gray-800 flex flex-col shrink-0">
                <div className="p-4 flex items-center justify-between">
                    <span className="text-sm font-bold dark:text-white px-2">{isDeleteMode ? t.batch_manage : t.chat_history}</span>
                    <div className="flex gap-1">
                        {isDeleteMode ? (
                            <><button onClick={handleBatchDelete} className="p-1.5 bg-red-50 text-red-600 rounded-lg"><Trash2 size={14}/></button><button onClick={()=>{setIsDeleteMode(false); setSelectedSessions(new Set())}} className="p-1.5 hover:bg-gray-200 dark:hover:bg-[#252525] rounded-lg"><X size={14}/></button></>
                        ) : (
                            <><button onClick={()=>setIsDeleteMode(true)} className="p-1.5 text-gray-400 hover:text-black dark:hover:text-white transition-colors"><Edit3 size={14}/></button><button onClick={()=>setActiveSid(null)} className="p-1.5 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 transition-opacity"><MessageSquarePlus size={16}/></button></>
                        )}
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-3 space-y-1 pb-4">
                    {sessions.map(s => (
                        <div key={s.id} onClick={()=>!isDeleteMode && setActiveSid(s.id)} className={`group relative p-3 rounded-xl text-sm cursor-pointer flex items-center gap-3 transition-all ${activeSid===s.id && !isDeleteMode ? 'bg-white dark:bg-[#222] shadow-sm font-medium text-black dark:text-white' : 'text-gray-500 hover:bg-gray-200/50 dark:hover:bg-[#1e1e1e] hover:text-black dark:hover:text-white'}`}>
                            {isDeleteMode ? (
                                <div onClick={(e)=>{e.stopPropagation();toggleSessionSelect(s.id)}} className="mr-1">{selectedSessions.has(s.id)?<CheckSquare size={16} className="text-blue-600"/>:<Square size={16}/>}</div>
                            ) : (
                                <MessageSquare size={16} className={`shrink-0 transition-colors ${activeSid===s.id?'text-black dark:text-white':'text-gray-300 group-hover:text-gray-400'}`}/>
                            )}
                            <div className="truncate flex-1">{s.title || t.new_chat}</div>
                            <div className="text-[10px] opacity-0 group-hover:opacity-50 transition-opacity">{new Date(s.updated_at).toLocaleDateString(undefined, {month:'numeric', day:'numeric'})}</div>
                        </div>
                    ))}
                </div>
            </div>
            <div className="flex-1 relative bg-white dark:bg-[#121212]">
                <ChatInterface token={token} user={user} sessionId={activeSid} onSessionChange={refreshSessions} t={t} models={models} defaultModel={defaultChatModel} sessionType="chat" starterQuestions={starterQuestions} />
            </div>
        </div>
    );
};

const SettingsView = ({ token, user, onLogout, t, models, systemDefaults, onUpdateDefaults }) => {
    const [activeTab, setActiveTab] = useState('common');
    const [providers, setProviders] = useState([]);
    const [editingProvider, setEditingProvider] = useState(null);
    const [usersList, setUsersList] = useState([]);
    
    // User Profile State
    const [avatarUrl, setAvatarUrl] = useState(user.avatar || '');
    const [avatarType, setAvatarType] = useState('url'); // 'url', 'image', 'emoji'
    const [newUsername, setNewUsername] = useState(user.username || '');
    const [pwdOld, setPwdOld] = useState('');
    const [pwdNew, setPwdNew] = useState('');

    // System Defaults
    const [defChat, setDefChat] = useState(systemDefaults.default_chat_model || '');
    const [defWs, setDefWs] = useState(systemDefaults.default_workspace_model || '');
    const [defOutline, setDefOutline] = useState(systemDefaults.default_outline_model || '');
    const [starterQuestions, setStarterQuestions] = useState([]);
    
    const PRESETS = [{ name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', icon: '🌐', models: ['openai/gpt-3.5-turbo'] }, { name: 'DeepSeek', url: 'https://api.deepseek.com', icon: '🐋', models: ['deepseek-chat'] }, { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', icon: '🌊', models: ['Qwen/Qwen2-72B-Instruct'] }];
    const EMOJIS = ["🤖", "👨‍💻", "👩‍💻", "🧠", "⚡", "🚀", "🎨", "👾", "🦊", "🐱", "🐶", "🐼", "🐸", "🐵", "🦄", "🐲"];

    // 5. New Provider Edit State & Logic
    const [pName, setPName] = useState(''); const [pUrl, setPUrl] = useState(''); const [pKey, setPKey] = useState(''); const [pModels, setPModels] = useState([]);
    
    useEffect(() => { if(user.role === 'admin') { fetchProviders(); fetchUsers(); fetchStarters(); } }, [user, activeTab]);
    
    const fetchProviders = () => fetch('/api/admin/providers', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setProviders);
    const fetchUsers = () => fetch('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setUsersList);
    const fetchStarters = () => fetch('/api/recommendations/starters', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setStarterQuestions);
    
    const handleUpdateProfile = async () => { await fetch('/api/users/me', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: avatarUrl, username: newUsername }) }); alert("Updated"); };
    
    const handleImageUpload = (e) => {
        const file = e.target.files?.[0];
        if(file) {
            const reader = new FileReader();
            reader.onload = (e) => setAvatarUrl(e.target.result);
            reader.readAsDataURL(file);
        }
    };

    const handleSaveDefaults = async () => { await fetch('/api/admin/system/defaults', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ default_chat_model: defChat, default_workspace_model: defWs, default_outline_model: defOutline }) }); onUpdateDefaults(); alert("Defaults Saved"); };
    const handleSaveStarters = async () => { await fetch('/api/admin/recommendations/starters', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(starterQuestions) }); alert("Starters Saved"); };
    const handleEditProvider = (p) => { setEditingProvider(p || {}); if (p) { setPName(p.name); setPUrl(p.base_url); setPKey(p.api_key); setPModels((p.models || []).map(m => typeof m === 'string' ? {id:m, alias:m, context_length: 4096, icon: '🤖'} : { ...m, context_length: m.context_length || 4096, icon: m.icon || '🤖' })); } else { setPName(''); setPUrl(''); setPKey(''); setPModels([]); } };
    const applyPreset = (preset) => { setPName(preset.name); setPUrl(preset.url); setPModels(preset.models.map(m => ({ id: m, alias: m, context_length: 4096, icon: '🤖' }))); };
    const handleSaveProvider = async () => { const newP = { id: editingProvider.id || `prov-${Date.now()}`, name: pName, base_url: pUrl, api_key: pKey, models: pModels, is_active: true }; const newList = editingProvider.id ? providers.map(p => p.id === editingProvider.id ? newP : p) : [...providers, newP]; await fetch('/api/admin/providers', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(newList) }); setEditingProvider(null); fetchProviders(); };
    const handleChangePassword = async () => { try { const res = await fetch('/api/users/me/password', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ old_password: pwdOld, new_password: pwdNew }) }); if(!res.ok) throw new Error(); alert("Success"); setPwdOld(''); setPwdNew(''); } catch(e) { alert("Error"); } };

    const MenuItem = ({ id, label, icon: Icon }) => (
        <button onClick={()=>setActiveTab(id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab===id ? 'bg-black text-white dark:bg-white dark:text-black shadow-md' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#222]'}`}>
            <Icon size={16} /> {label}
        </button>
    );

    const Modal = ({ title, onClose, children }) => (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-[#1c1c1c] w-full max-w-2xl rounded-3xl shadow-2xl border border-gray-100 dark:border-gray-800 flex flex-col max-h-[90vh]">
                <div className="flex justify-between items-center p-6 border-b border-gray-100 dark:border-gray-800">
                    <h3 className="text-xl font-bold dark:text-white">{title}</h3>
                    <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-[#2c2c2c] rounded-full"><X size={20}/></button>
                </div>
                <div className="flex-1 overflow-y-auto p-6">{children}</div>
            </div>
        </div>
    );

    return (
        <div className="h-full flex bg-gray-50/50 dark:bg-[#000]">
            {/* Settings Sidebar */}
            <div className="w-64 p-4 border-r border-gray-100 dark:border-gray-800 flex flex-col bg-gray-50/30 dark:bg-[#0a0a0a]">
                <div className="mb-6 px-2">
                    <h2 className="text-xl font-bold dark:text-white">{t.nav_config}</h2>
                </div>
                <div className="space-y-1">
                    <div className="text-xs font-bold text-gray-400 px-3 mb-2 uppercase tracking-wider">{t.settings_common}</div>
                    <MenuItem id="common" label={t.settings_profile} icon={User} />
                    <MenuItem id="llm" label={t.settings_providers} icon={Sparkles} />
                    <MenuItem id="about" label={t.settings_about} icon={AlertCircle} />
                    
                    {user.role === 'admin' && (
                        <>
                            <div className="text-xs font-bold text-gray-400 px-3 mt-6 mb-2 uppercase tracking-wider">{t.settings_admin}</div>
                            <MenuItem id="admin_users" label={t.admin_users} icon={Users} />
                            <MenuItem id="admin_defaults" label={t.admin_defaults} icon={Shield} />
                            <MenuItem id="admin_starters" label={t.admin_starters} icon={HelpCircle} />
                        </>
                    )}
                </div>
            </div>

            {/* Settings Content Area */}
            <div className="flex-1 overflow-y-auto p-8 md:p-12">
                <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    
                    {activeTab === 'common' && (
                        <>
                            <SettingGroup title={t.settings_profile}>
                                <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-start gap-6">
                                    <Avatar url={avatarUrl} size="xl" className="shrink-0 shadow-lg"/>
                                    <div className="flex-1">
                                        <div className="flex gap-2 mb-4">
                                            <button onClick={()=>setAvatarType('image')} className={`px-3 py-1 text-xs rounded-full border ${avatarType==='image'?'bg-black text-white dark:bg-white dark:text-black':'border-gray-200 text-gray-500'}`}>{t.upload_image}</button>
                                            <button onClick={()=>setAvatarType('emoji')} className={`px-3 py-1 text-xs rounded-full border ${avatarType==='emoji'?'bg-black text-white dark:bg-white dark:text-black':'border-gray-200 text-gray-500'}`}>{t.choose_emoji}</button>
                                            <button onClick={()=>setAvatarType('url')} className={`px-3 py-1 text-xs rounded-full border ${avatarType==='url'?'bg-black text-white dark:bg-white dark:text-black':'border-gray-200 text-gray-500'}`}>{t.use_url}</button>
                                        </div>
                                        
                                        {/* 5. Enhanced Avatar Input */}
                                        {avatarType === 'image' && (
                                            <div className="border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center hover:bg-gray-50 dark:hover:bg-[#2c2c2c] transition-colors relative cursor-pointer">
                                                <input type="file" onChange={handleImageUpload} accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer"/>
                                                <UploadCloud className="mx-auto text-gray-400 mb-2"/>
                                                <span className="text-xs text-gray-500">Click to upload</span>
                                            </div>
                                        )}
                                        {avatarType === 'emoji' && (
                                            <div className="grid grid-cols-8 gap-2">
                                                {EMOJIS.map(e => <button key={e} onClick={()=>setAvatarUrl(e)} className="p-2 hover:bg-gray-100 rounded text-xl">{e}</button>)}
                                            </div>
                                        )}
                                        {avatarType === 'url' && (
                                            <input className="w-full bg-gray-50 dark:bg-[#222] p-2 rounded-lg text-sm outline-none dark:text-white" value={avatarUrl} onChange={e=>setAvatarUrl(e.target.value)} placeholder="https://..."/>
                                        )}
                                    </div>
                                </div>
                                
                                <SettingItem icon={Type} label={t.settings_username} desc={t.settings_username_desc}>
                                    <input className="bg-transparent border-b border-gray-200 dark:border-gray-700 outline-none text-sm w-48 text-right focus:border-blue-500 transition-all font-bold dark:text-white" value={newUsername} onChange={e=>setNewUsername(e.target.value)} />
                                </SettingItem>
                                <div className="p-3 bg-gray-50 dark:bg-[#222] flex justify-end">
                                    <Button onClick={handleUpdateProfile} icon={Save}>{t.save}</Button>
                                </div>
                            </SettingGroup>

                            <SettingGroup title={t.settings_security}>
                                <SettingItem icon={Key} label={t.old_pwd}>
                                    <input type="password" value={pwdOld} onChange={e=>setPwdOld(e.target.value)} className="bg-gray-100 dark:bg-[#2c2c2c] rounded-lg px-3 py-1.5 text-sm outline-none dark:text-white border-transparent focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10 transition-all"/>
                                </SettingItem>
                                <SettingItem icon={Lock} label={t.new_pwd}>
                                    <input type="password" value={pwdNew} onChange={e=>setPwdNew(e.target.value)} className="bg-gray-100 dark:bg-[#2c2c2c] rounded-lg px-3 py-1.5 text-sm outline-none dark:text-white border-transparent focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10 transition-all"/>
                                </SettingItem>
                                <div className="p-3 bg-gray-50 dark:bg-[#222] flex justify-end">
                                    <Button onClick={handleChangePassword} variant="secondary">{t.change_pwd}</Button>
                                </div>
                            </SettingGroup>

                             <SettingGroup title={t.settings_danger_zone}>
                                <SettingItem icon={LogOut} label={t.logout} desc={t.logout_desc} danger>
                                    <Button onClick={onLogout} variant="danger" size="sm">{t.logout}</Button>
                                </SettingItem>
                            </SettingGroup>
                        </>
                    )}

                    {activeTab === 'llm' && (
                        <>
                            <div className="flex justify-between items-center mb-4">
                                <div>
                                    <h3 className="text-2xl font-bold dark:text-white">{t.provider_config}</h3>
                                    <p className="text-gray-500 text-sm">{t.provider_config_desc}</p>
                                </div>
                                <Button onClick={()=>handleEditProvider(null)} icon={Plus}>{t.add_provider}</Button>
                            </div>

                            <div className="grid grid-cols-1 gap-4">
                                {providers.map(p => (
                                    <div key={p.id} className="bg-white dark:bg-[#1c1c1c] p-5 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm flex items-center justify-between hover:border-black/10 dark:hover:border-white/10 hover:shadow-md transition-all group cursor-default">
                                        <div className="flex items-center gap-4">
                                            <div className="w-12 h-12 bg-gray-50 dark:bg-[#2c2c2c] rounded-xl flex items-center justify-center text-2xl">
                                                {PRESETS.find(pre => pre.name === p.name)?.icon || '🔮'}
                                            </div>
                                            <div>
                                                <div className="font-bold dark:text-white text-lg">{p.name}</div>
                                                <div className="text-xs text-gray-500 flex items-center gap-2 mt-1">
                                                    <span className="w-2 h-2 rounded-full bg-green-500"></span> {p.models.length} {t.active_models}
                                                </div>
                                            </div>
                                        </div>
                                        <Button size="sm" variant="secondary" onClick={()=>handleEditProvider(p)} icon={Edit3}>{t.edit}</Button>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    {/* Admin Tabs */}
                    {activeTab === 'admin_defaults' && (
                         <SettingGroup title={t.admin_defaults}>
                             {[
                                { label: t.def_chat_model, val: defChat, set: setDefChat },
                                { label: t.def_ws_model, val: defWs, set: setDefWs },
                                { label: t.def_outline_model, val: defOutline, set: setDefOutline }
                             ].map((item, i) => (
                                 <SettingItem key={i} icon={Bot} label={item.label}>
                                     <select value={item.val} onChange={e=>item.set(e.target.value)} className="bg-gray-100 dark:bg-[#2c2c2c] text-sm rounded-lg px-2 py-1.5 outline-none dark:text-white border-transparent focus:ring-2 focus:ring-blue-500/20 cursor-pointer">
                                         <option value="">{t.select_model}</option>
                                         {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                                     </select>
                                 </SettingItem>
                             ))}
                             <div className="p-3 bg-gray-50 dark:bg-[#222] flex justify-end"><Button onClick={handleSaveDefaults} icon={Save}>{t.save}</Button></div>
                         </SettingGroup>
                    )}

                    {activeTab === 'admin_starters' && (
                        <SettingGroup title={t.admin_starters}>
                            <div className="p-4">
                                <textarea value={starterQuestions.join('\n')} onChange={e=>setStarterQuestions(e.target.value.split('\n'))} className="w-full h-48 p-4 rounded-xl bg-gray-50 dark:bg-[#2c2c2c] border-none outline-none dark:text-white text-sm font-mono leading-relaxed resize-none focus:ring-2 focus:ring-black/5 dark:focus:ring-white/5 transition-all" placeholder={t.enter_question_placeholder} />
                            </div>
                            <div className="p-3 bg-gray-50 dark:bg-[#222] flex justify-end"><Button onClick={handleSaveStarters} icon={Save}>{t.save}</Button></div>
                        </SettingGroup>
                    )}

                    {activeTab === 'admin_users' && (
                        <SettingGroup title={t.admin_users}>
                            {usersList.map(u => (
                                <SettingItem key={u.id} icon={User} label={u.username} desc={`${t.role}: ${u.role}`}>
                                    <Button size="sm" variant="danger" icon={Trash2} className="!p-1.5 h-8 w-8 justify-center"/>
                                </SettingItem>
                            ))}
                        </SettingGroup>
                    )}

                    {/* About Tab */}
                    {activeTab === 'about' && (
                        <div className="text-center py-12">
                             <div className="w-24 h-24 bg-gradient-to-br from-black to-gray-800 dark:from-white dark:to-gray-200 text-white dark:text-black rounded-[32px] mx-auto flex items-center justify-center mb-6 shadow-2xl">
                                 <LinkIcon size={40}/>
                             </div>
                             <h2 className="text-2xl font-bold dark:text-white mb-2">{t.about_title}</h2>
                             <p className="text-gray-500 mb-8">{t.about_desc}</p>
                             <div className="flex justify-center gap-4 text-sm text-gray-400">
                                 <span>{t.version}</span>
                                 <span>•</span>
                                 <span>{t.privacy_policy}</span>
                             </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Provider Edit Modal */}
            {editingProvider && (
                <Modal title={editingProvider.id ? t.edit_provider : t.add_provider_title} onClose={()=>setEditingProvider(null)}>
                     {!editingProvider.id && (
                        <div className="flex gap-3 mb-6 overflow-x-auto pb-2">
                            {PRESETS.map(pre => (
                                <button key={pre.name} onClick={()=>applyPreset(pre)} className="flex items-center gap-2 px-4 py-3 rounded-xl bg-gray-50 dark:bg-[#252525] border border-gray-200 dark:border-gray-700 hover:border-black dark:hover:border-white hover:ring-1 hover:ring-black dark:hover:ring-white text-sm font-bold transition-all shrink-0">
                                    <span className="text-xl">{pre.icon}</span> {pre.name}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="space-y-5">
                        <div><label className="text-xs font-bold text-gray-500 mb-1.5 block uppercase tracking-wide">{t.provider_name}</label><input className="w-full p-3 bg-gray-50 dark:bg-[#252525] rounded-xl outline-none border border-gray-200 dark:border-gray-700 focus:border-black dark:focus:border-white dark:text-white transition-all" value={pName} onChange={e=>setPName(e.target.value)}/></div>
                        <div><label className="text-xs font-bold text-gray-500 mb-1.5 block uppercase tracking-wide">{t.base_url}</label><input className="w-full p-3 bg-gray-50 dark:bg-[#252525] rounded-xl outline-none border border-gray-200 dark:border-gray-700 focus:border-black dark:focus:border-white font-mono text-xs dark:text-white transition-all" value={pUrl} onChange={e=>setPUrl(e.target.value)}/></div>
                        <div><label className="text-xs font-bold text-gray-500 mb-1.5 block uppercase tracking-wide">{t.api_key}</label><input type="password" className="w-full p-3 bg-gray-50 dark:bg-[#252525] rounded-xl outline-none border border-gray-200 dark:border-gray-700 focus:border-black dark:focus:border-white font-mono text-xs dark:text-white transition-all" value={pKey} onChange={e=>setPKey(e.target.value)}/></div>
                        
                        <div className="border-t border-gray-100 dark:border-gray-700 pt-6">
                            <div className="flex justify-between items-center mb-3">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">{t.model_list}</label>
                                <Button size="sm" variant="secondary" onClick={()=>setPModels([...pModels, {id:'', alias:''}])} icon={Plus}>{t.add}</Button>
                            </div>
                            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                {pModels.map((m,i) => (
                                    <div key={i} className="flex gap-2">
                                        <input placeholder={t.model_id_placeholder} className="flex-[2] p-2 bg-gray-50 dark:bg-[#252525] rounded-lg text-xs font-mono outline-none dark:text-white border border-transparent focus:border-gray-300 dark:focus:border-gray-600 transition-all" value={m.id} onChange={e=>{const n=[...pModels];n[i].id=e.target.value;setPModels(n)}}/>
                                        <input placeholder={t.model_alias_placeholder} className="flex-1 p-2 bg-gray-50 dark:bg-[#252525] rounded-lg text-xs font-bold outline-none dark:text-white border border-transparent focus:border-gray-300 dark:focus:border-gray-600 transition-all" value={m.alias} onChange={e=>{const n=[...pModels];n[i].alias=e.target.value;setPModels(n)}}/>
                                        <button onClick={()=>setPModels(pModels.filter((_,idx)=>idx!==i))} className="text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors"><Trash2 size={14}/></button>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <Button className="w-full mt-4 py-3 shadow-lg" onClick={handleSaveProvider}>{t.save}</Button>
                    </div>
                </Modal>
            )}
        </div>
    );
};

// --- Auth & Main ---

const AuthScreen = ({ onLogin }) => {
    const [isLogin, setIsLogin] = useState(true);
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => { e.preventDefault(); setLoading(true); const fd = new FormData(e.target); const endpoint = isLogin ? '/api/token' : '/api/register'; const body = isLogin ? new URLSearchParams({ username: fd.get('username'), password: fd.get('password') }) : JSON.stringify(Object.fromEntries(fd)); try { const res = await fetch(endpoint, { method: 'POST', headers: isLogin ? {'Content-Type': 'application/x-www-form-urlencoded'} : {'Content-Type': 'application/json'}, body }); if (!res.ok) throw new Error(await res.text()); if (isLogin) { const data = await res.json(); onLogin(data); } else { alert('Success'); setIsLogin(true); } } catch (err) { alert(err.message); } finally { setLoading(false); } };
    
    return (<div className="min-h-screen flex items-center justify-center bg-white dark:bg-[#000] p-4 font-sans"><div className="w-full max-w-sm p-8 bg-white dark:bg-[#121212] rounded-[32px] shadow-2xl border border-gray-100 dark:border-gray-800 animate-in zoom-in-95 duration-500"><div className="text-center mb-8"><div className="w-16 h-16 bg-black dark:bg-white rounded-2xl mx-auto flex items-center justify-center text-white dark:text-black mb-6 shadow-lg"><LinkIcon size={32}/></div><h1 className="text-2xl font-bold dark:text-white tracking-tight">Palink AI</h1><p className="text-gray-400 mt-2 text-sm">欢迎使用企业级 AI 协作空间</p></div><form onSubmit={handleSubmit} className="space-y-4"><input name="username" placeholder="用户名" className="w-full px-4 py-3.5 rounded-2xl bg-gray-50 dark:bg-[#1e1e1e] border-none outline-none dark:text-white font-medium text-sm transition-all focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10" required /><input name="password" type="password" placeholder="密码" className="w-full px-4 py-3.5 rounded-2xl bg-gray-50 dark:bg-[#1e1e1e] border-none outline-none dark:text-white font-medium text-sm transition-all focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10" required /><button disabled={loading} className="w-full py-3.5 bg-black dark:bg-white text-white dark:text-black rounded-2xl font-bold hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg">{loading ? <Loader2 className="animate-spin mx-auto"/> : (isLogin ? '登录' : '注册')}</button></form><button onClick={() => setIsLogin(!isLogin)} className="w-full mt-6 text-xs text-gray-400 hover:text-black dark:hover:text-white font-bold transition-colors">{isLogin ? '创建新账号' : '已有账号？去登录'}</button></div></div>);
};

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('palink_token'));
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('chat');
  const [isDark, setIsDark] = useState(localStorage.getItem('theme')==='dark');
  const [lang, setLang] = useState('zh');
  const [models, setModels] = useState([]);
  const [systemDefaults, setSystemDefaults] = useState({});

  useEffect(() => { if(isDark) document.documentElement.classList.add('dark'); else document.documentElement.classList.remove('dark'); localStorage.setItem('theme', isDark?'dark':'light'); }, [isDark]);
  useEffect(() => { if(token) { try { const payload = JSON.parse(atob(token.split('.')[1])); fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : Promise.reject()).then(u => setUser({ ...u, role: payload.role || u.role })).catch(() => { setToken(null); localStorage.removeItem('palink_token'); }); } catch(e) { setToken(null); } } }, [token]);
  const loadConfig = () => { if(token) { fetch('/api/models').then(r=>r.json()).then(setModels); fetch('/api/admin/system/defaults', { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(setSystemDefaults); } };
  useEffect(() => { loadConfig(); }, [token]);

  const t = TRANSLATIONS[lang];

  if(!token) return <AuthScreen onLogin={(d) => { setToken(d.access_token); localStorage.setItem('palink_token', d.access_token); }} />;
  if(!user) return <div className="h-screen flex items-center justify-center dark:bg-black"><Loader2 className="animate-spin text-black dark:text-white"/></div>;

  return (
    <div className={`flex h-screen w-full overflow-hidden transition-colors duration-300 font-sans ${isDark ? 'bg-[#000] text-gray-100' : 'bg-white text-gray-900'}`}>
       {/* Main App Sidebar */}
       <aside className={`w-[72px] flex-shrink-0 flex flex-col items-center py-6 border-r ${isDark ? 'border-gray-800 bg-[#050505]' : 'border-gray-100 bg-gray-50/80'} z-50`}>
         <div className="w-11 h-11 bg-black dark:bg-white rounded-xl flex items-center justify-center mb-8 shadow-md text-white dark:text-black"><LinkIcon size={22}/></div>
         <nav className="flex-1 flex flex-col gap-4 w-full px-2 items-center">
            <Button variant="ghost" className={`!p-3 h-12 w-12 rounded-2xl justify-center ${activeTab==='chat'?'bg-black text-white dark:bg-white dark:text-black shadow-md':'text-gray-400'}`} onClick={() => setActiveTab('chat')} icon={MessageSquare} title={t.nav_chat}/>
            <Button variant="ghost" className={`!p-3 h-12 w-12 rounded-2xl justify-center ${activeTab==='workspace'?'bg-black text-white dark:bg-white dark:text-black shadow-md':'text-gray-400'}`} onClick={() => setActiveTab('workspace')} icon={FolderOpen} title={t.nav_files}/>
            <div className="flex-1"/>
            <Button variant="ghost" className={`!p-3 h-12 w-12 rounded-2xl justify-center ${activeTab==='settings'?'bg-black text-white dark:bg-white dark:text-black shadow-md':'text-gray-400'}`} onClick={() => setActiveTab('settings')} icon={Settings} title={t.nav_config}/>
         </nav>
         <div className="mt-4 mb-2 flex flex-col gap-5 items-center">
             <button onClick={()=>setIsDark(!isDark)} className="p-2 text-gray-400 hover:text-black dark:hover:text-white transition-colors">{isDark ? <Sun size={20}/> : <Moon size={20}/>}</button>
             <button onClick={()=>setLang(lang==='en'?'zh':'en')} className="text-xs font-bold text-gray-400 hover:text-black dark:hover:text-white transition-colors" title={t.lang_switch}>{lang.toUpperCase()}</button>
            <Avatar url={user.avatar} size="sm" className="ring-2 ring-transparent hover:ring-black dark:hover:ring-white transition-all cursor-pointer"/>
         </div>
       </aside>

       <main className="flex-1 relative flex flex-col h-full overflow-hidden bg-white dark:bg-[#121212]">
          {activeTab === 'chat' && <ChatView token={token} user={user} t={t} models={models} systemDefaults={systemDefaults} />}
          {activeTab === 'workspace' && <WorkspaceView token={token} user={user} t={t} models={models} isDark={isDark} systemDefaults={systemDefaults} />}
          {activeTab === 'settings' && <SettingsView token={token} user={user} onLogout={()=>{setToken(null);localStorage.removeItem('palink_token');}} t={t} models={models} systemDefaults={systemDefaults} onUpdateDefaults={loadConfig} />}
       </main>
    </div>
  );
}