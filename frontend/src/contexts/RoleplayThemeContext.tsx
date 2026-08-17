import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { RoleplayThemeConfig, RoleplayThemeColors, RoleplayThemeLayout, RoleplayThemeToggles, RoleplayThemeBackground, RoleplayChatStyle } from '@/types';
import { api } from '@/services/api';

const STORAGE_KEY = 'palink-rp-themes';
const STORAGE_CURRENT_KEY = 'palink-rp-current-theme-id';
const CUSTOMIZED_KEY = 'palink-rp-theme-customized';

const defaultLightColors: RoleplayThemeColors = {
  '--rp-color-main-text': '#1f2937',
  '--rp-color-italics-text': '#4b5563',
  '--rp-color-chat-bg': '#ffffff',
  '--rp-color-ui-bg': '#f3f4f6',
  '--rp-color-ui-border': '#e5e7eb',
  '--rp-color-bot-msg': '#f9fafb',
  '--rp-color-user-msg': '#eff6ff',
  '--rp-color-timestamps': '#9ca3af',
};

const defaultDarkColors: RoleplayThemeColors = {
  '--rp-color-main-text': '#e5e7eb',
  '--rp-color-italics-text': '#9ca3af',
  '--rp-color-chat-bg': '#111827',
  '--rp-color-ui-bg': '#1f2937',
  '--rp-color-ui-border': '#374151',
  '--rp-color-bot-msg': '#1f2937',
  '--rp-color-user-msg': '#1e3a5f',
  '--rp-color-timestamps': '#6b7280',
};

const defaultLayout: RoleplayThemeLayout = {
  chatWidth: 100,
  fontScale: 1,
  blurStrength: 0,
  shadowWidth: 0,
};

const defaultToggles: RoleplayThemeToggles = {
  reducedMotion: false,
  noBlur: false,
  noTextShadow: false,
  chatTimestamps: true,
  messageTokenCount: false,
  useNativeStRendering: false,
};

const defaultBackground: RoleplayThemeBackground = {
  url: undefined,
  overlay: undefined,
};

function createDefaultThemes(): RoleplayThemeConfig[] {
  return [
    {
      id: 'light',
      name: 'Light',
      colors: defaultLightColors,
      layout: { ...defaultLayout },
      toggles: { ...defaultToggles },
      customCSS: '',
      background: { ...defaultBackground },
      chatStyle: 'flat',
    },
    {
      id: 'dark',
      name: 'Dark',
      colors: defaultDarkColors,
      layout: { ...defaultLayout },
      toggles: { ...defaultToggles },
      customCSS: '',
      background: { ...defaultBackground },
      chatStyle: 'flat',
    },
  ];
}

function loadThemesFromStorage(): RoleplayThemeConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RoleplayThemeConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return createDefaultThemes();
}

function loadCurrentThemeIdFromStorage(): string {
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT_KEY);
    if (raw) return raw;
  } catch {
    // ignore
  }
  return 'dark';
}

function saveThemesToStorage(themes: RoleplayThemeConfig[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
  } catch {
    // ignore
  }
}

function saveCurrentThemeIdToStorage(id: string) {
  try {
    localStorage.setItem(STORAGE_CURRENT_KEY, id);
  } catch {
    // ignore
  }
}

function generateId(): string {
  return `rp-theme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampLayout(layout: RoleplayThemeLayout): RoleplayThemeLayout {
  return {
    chatWidth: Math.min(100, Math.max(25, layout.chatWidth)),
    fontScale: Math.min(1.5, Math.max(0.5, layout.fontScale)),
    blurStrength: Math.min(30, Math.max(0, layout.blurStrength)),
    shadowWidth: Math.min(5, Math.max(0, layout.shadowWidth)),
  };
}

/** 后端 /api/themes 返回的主题摘要（用于激活同步） */
interface BackendThemeSummary {
  id: number;
  name: string;
  is_active: boolean;
}

interface RoleplayThemeContextValue {
  themes: RoleplayThemeConfig[];
  currentTheme: RoleplayThemeConfig;
  currentThemeId: string;
  setCurrentThemeId: (id: string) => void;
  createTheme: (base?: Partial<RoleplayThemeConfig>) => RoleplayThemeConfig;
  deleteTheme: (id: string) => void;
  updateTheme: (id: string, patch: Partial<RoleplayThemeConfig>) => void;
  exportTheme: (id: string) => string;
  exportAllThemes: () => string;
  importTheme: (json: string) => RoleplayThemeConfig | null;
  importThemes: (json: string) => RoleplayThemeConfig[];
}

const RoleplayThemeContext = createContext<RoleplayThemeContextValue | null>(null);

export function useRoleplayTheme() {
  const ctx = useContext(RoleplayThemeContext);
  if (!ctx) {
    throw new Error('useRoleplayTheme must be used within RoleplayThemeProvider');
  }
  return ctx;
}

interface RoleplayThemeProviderProps {
  children: React.ReactNode;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function RoleplayThemeProvider({ children, containerRef }: RoleplayThemeProviderProps) {
  const [themes, setThemes] = useState<RoleplayThemeConfig[]>(loadThemesFromStorage);
  const [currentThemeId, setCurrentThemeIdState] = useState<string>(loadCurrentThemeIdFromStorage);
  const customStyleRef = useRef<HTMLStyleElement | null>(null);
  const currentThemeIdRef = useRef(currentThemeId);
  // 后端主题列表（按 name 匹配前端主题以同步激活状态）
  const backendThemesRef = useRef<BackendThemeSummary[]>([]);
  // 前端 themes 镜像，供 setCurrentThemeId 内按 id 查找 name，避免闭包过期
  const themesRef = useRef(themes);

  useEffect(() => {
    currentThemeIdRef.current = currentThemeId;
  }, [currentThemeId]);

  useEffect(() => {
    themesRef.current = themes;
  }, [themes]);

  // 启动时加载后端主题列表（容错：后端不可用时静默降级）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<BackendThemeSummary[]>('/api/themes');
        if (!cancelled && Array.isArray(data)) {
          backendThemesRef.current = data;
        }
      } catch {
        // 容错：后端不可用时静默降级，不影响前端主流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 同步主题激活状态到后端（按 name 匹配后端主题 id）
  const syncThemeActivationToBackend = useCallback(async (themeName: string) => {
    try {
      const backendTheme = backendThemesRef.current.find((t) => t.name === themeName);
      if (backendTheme) {
        await api.post(`/api/themes/${backendTheme.id}/activate`);
      }
    } catch {
      // 容错：后端不可用时静默降级，不影响前端主流程
    }
  }, []);

  const currentTheme = themes.find((t) => t.id === currentThemeId) || themes[0] || createDefaultThemes()[0];

  const setCurrentThemeId = useCallback((id: string) => {
    setCurrentThemeIdState(id);
    saveCurrentThemeIdToStorage(id);
    // 同步激活状态到后端（按 name 匹配），失败时静默降级
    const theme = themesRef.current.find((t) => t.id === id);
    if (theme) {
      void syncThemeActivationToBackend(theme.name);
    }
  }, [syncThemeActivationToBackend]);

  const createTheme = useCallback((base?: Partial<RoleplayThemeConfig>): RoleplayThemeConfig => {
    const newTheme: RoleplayThemeConfig = {
      id: generateId(),
      name: base?.name || 'New Theme',
      colors: { ...(base?.colors || defaultDarkColors) },
      layout: clampLayout({ ...(base?.layout || defaultLayout) }),
      toggles: { ...(base?.toggles || defaultToggles) },
      customCSS: base?.customCSS || '',
      background: { ...(base?.background || defaultBackground) },
      chatStyle: (base?.chatStyle as RoleplayChatStyle) || 'flat',
    };
    setThemes((prev) => {
      const next = [...prev, newTheme];
      saveThemesToStorage(next);
      return next;
    });
    return newTheme;
  }, []);

  const deleteTheme = useCallback((id: string) => {
    setThemes((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      saveThemesToStorage(next);
      if (currentThemeId === id) {
        const first = next[0];
        if (first) {
          setCurrentThemeIdState(first.id);
          saveCurrentThemeIdToStorage(first.id);
        }
      }
      return next;
    });
  }, [currentThemeId]);

  const updateTheme = useCallback((id: string, patch: Partial<RoleplayThemeConfig>) => {
    if (patch.colors) {
      try {
        localStorage.setItem(CUSTOMIZED_KEY, 'true');
      } catch {
        // ignore
      }
    }
    setThemes((prev) => {
      const next = prev.map((t) => {
        if (t.id !== id) return t;
        const updated: RoleplayThemeConfig = {
          ...t,
          ...patch,
          colors: { ...t.colors, ...patch.colors },
          layout: patch.layout ? clampLayout({ ...t.layout, ...patch.layout }) : t.layout,
          toggles: patch.toggles ? { ...t.toggles, ...patch.toggles } : t.toggles,
          background: patch.background ? { ...t.background, ...patch.background } : t.background,
        };
        return updated;
      });
      saveThemesToStorage(next);
      return next;
    });
  }, []);

  const exportTheme = useCallback((id: string): string => {
    const theme = themes.find((t) => t.id === id);
    if (!theme) return '';
    const payload = {
      name: theme.name,
      colors: theme.colors,
      layout: theme.layout,
      toggles: theme.toggles,
      customCSS: theme.customCSS,
      background: theme.background,
      chatStyle: theme.chatStyle,
    };
    return JSON.stringify(payload, null, 2);
  }, [themes]);

  const exportAllThemes = useCallback((): string => {
    return JSON.stringify(themes, null, 2);
  }, [themes]);

  const importTheme = useCallback((json: string): RoleplayThemeConfig | null => {
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object') return null;
      const imported: RoleplayThemeConfig = {
        id: generateId(),
        name: typeof parsed.name === 'string' ? parsed.name : 'Imported Theme',
        colors: { ...(parsed.colors || defaultDarkColors) },
        layout: clampLayout({ ...(parsed.layout || defaultLayout) }),
        toggles: { ...(parsed.toggles || defaultToggles) },
        customCSS: typeof parsed.customCSS === 'string' ? parsed.customCSS : '',
        background: { ...(parsed.background || defaultBackground) },
        chatStyle: ['flat', 'bubbles', 'document'].includes(parsed.chatStyle) ? parsed.chatStyle : 'flat',
      };
      setThemes((prev) => {
        const next = [...prev, imported];
        saveThemesToStorage(next);
        return next;
      });
      return imported;
    } catch {
      return null;
    }
  }, []);

  const importThemes = useCallback((json: string): RoleplayThemeConfig[] => {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) {
        const single = importTheme(json);
        return single ? [single] : [];
      }
      const imported: RoleplayThemeConfig[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const theme: RoleplayThemeConfig = {
          id: generateId(),
          name: typeof item.name === 'string' ? item.name : 'Imported Theme',
          colors: { ...(item.colors || defaultDarkColors) },
          layout: clampLayout({ ...(item.layout || defaultLayout) }),
          toggles: { ...(item.toggles || defaultToggles) },
          customCSS: typeof item.customCSS === 'string' ? item.customCSS : '',
          background: { ...(item.background || defaultBackground) },
          chatStyle: ['flat', 'bubbles', 'document'].includes(item.chatStyle) ? item.chatStyle : 'flat',
        };
        imported.push(theme);
      }
      if (imported.length > 0) {
        setThemes((prev) => {
          const next = [...prev, ...imported];
          saveThemesToStorage(next);
          return next;
        });
      }
      return imported;
    } catch {
      return [];
    }
  }, [importTheme]);

  useEffect(() => {
    const syncTheme = (isDarkMode: boolean) => {
      if (localStorage.getItem(CUSTOMIZED_KEY) === 'true') return;
      const targetId = currentThemeIdRef.current;
      setThemes((prev) => {
        const next = prev.map((t) => {
          if (t.id !== targetId) return t;
          // 同步所有颜色变量，确保文字颜色与背景色匹配
          // 之前只同步 chat-bg 和 ui-bg，导致亮色模式下文字仍然是浅色（几乎看不见）
          const sourceColors = isDarkMode ? defaultDarkColors : defaultLightColors;
          return {
            ...t,
            colors: {
              ...t.colors,
              ...sourceColors,
            },
          };
        });
        saveThemesToStorage(next);
        return next;
      });
    };
    syncTheme(document.documentElement.classList.contains('dark'));
    const observer = new MutationObserver(() => {
      syncTheme(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const target = containerRef?.current;
    if (!target) return;

    const colors = currentTheme.colors;
    const layout = currentTheme.layout;
    const toggles = currentTheme.toggles;
    const bg = currentTheme.background;

    for (const [key, value] of Object.entries(colors)) {
      if (value !== undefined) {
        target.style.setProperty(key, value);
      }
    }

    target.style.setProperty('--rp-layout-chat-width', `${layout.chatWidth}%`);
    target.style.setProperty('--rp-layout-font-scale', `${layout.fontScale}`);
    target.style.setProperty('--rp-layout-blur-strength', `${toggles.noBlur ? 0 : layout.blurStrength}px`);
    target.style.setProperty('--rp-layout-shadow-width', `${toggles.noTextShadow ? 0 : layout.shadowWidth}px`);

    target.style.setProperty('--rp-toggle-reduced-motion', toggles.reducedMotion ? 'reduce' : 'no-preference');
    target.style.setProperty('--rp-toggle-chat-timestamps', toggles.chatTimestamps ? 'block' : 'none');
    target.style.setProperty('--rp-toggle-message-token-count', toggles.messageTokenCount ? 'inline' : 'none');

    if (bg.url) {
      target.style.setProperty('--rp-background-url', `url(${bg.url})`);
    } else {
      target.style.removeProperty('--rp-background-url');
    }
    if (bg.overlay) {
      target.style.setProperty('--rp-background-overlay', bg.overlay);
    } else {
      target.style.removeProperty('--rp-background-overlay');
    }

    target.style.setProperty('--rp-chat-style', currentTheme.chatStyle);
    target.setAttribute('data-rp-chat-style', currentTheme.chatStyle);

    if (currentTheme.customCSS) {
      if (!customStyleRef.current) {
        const style = document.createElement('style');
        style.dataset.rpCustom = currentTheme.id;
        document.head.appendChild(style);
        customStyleRef.current = style;
      }
      const styleEl = customStyleRef.current;
      styleEl.dataset.rpCustom = currentTheme.id;
      styleEl.textContent = `.roleplay-container[data-rp-theme="${currentTheme.id}"] { ${currentTheme.customCSS} }`;
    } else {
      if (customStyleRef.current) {
        customStyleRef.current.textContent = '';
      }
    }

    target.setAttribute('data-rp-theme', currentTheme.id);

    return () => {
      // cleanup handled on next effect run
    };
  }, [currentTheme, containerRef]);

  useEffect(() => {
    return () => {
      if (customStyleRef.current) {
        customStyleRef.current.remove();
        customStyleRef.current = null;
      }
    };
  }, []);

  const value: RoleplayThemeContextValue = {
    themes,
    currentTheme,
    currentThemeId,
    setCurrentThemeId,
    createTheme,
    deleteTheme,
    updateTheme,
    exportTheme,
    exportAllThemes,
    importTheme,
    importThemes,
  };

  return (
    <RoleplayThemeContext.Provider value={value}>
      {children}
    </RoleplayThemeContext.Provider>
  );
}
