import React from 'react';
import {
  MessageSquare,
  FolderOpen,
  Settings,
  Sun,
  Moon,
  LogOut,
  Bot
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { mobilePager } from '@/lib/mobilePagerBridge';
import type { User } from '@/types';
import { useIsMobile } from '@/hooks/use-mobile';

interface SidebarProps {
  user?: User | null;
  isDark?: boolean;
  onThemeToggle?: () => void;
  lang?: string;
  onLangToggle?: () => void;
  onLogout?: () => void;
  t: Record<string, string>;
  sidebarCollapsed?: boolean;
  dockOffset?: number | string;
}

interface NavItemProps {
  icon: React.ElementType;
  to: string;
  tooltip: string;
  label?: string;
  isMobile?: boolean;
}

function NavItem({ icon: Icon, to, tooltip, label, isMobile }: NavItemProps) {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      className={cn(
        'sidebar-item rounded-xl flex items-center justify-center transition-all duration-200',
        'hover:bg-sidebar-accent',
        isMobile
          ? 'flex-col gap-1 py-2 px-3 flex-1 min-w-0'
          : 'w-12 h-12',
        isActive
          ? 'active bg-sidebar-primary text-sidebar-primary-foreground shadow-lg shadow-sidebar-primary/25'
          : 'text-sidebar-foreground hover:text-sidebar-foreground'
      )}
      title={tooltip}
    >
      <Icon size={isMobile ? 20 : 22} strokeWidth={isActive ? 2.5 : 2} />
      {isMobile && label && (
        <span className="text-[12px] font-medium truncate max-w-full">{label}</span>
      )}
    </Link>
  );
};

// Desktop Sidebar Component
export function DesktopSidebar({
  user,
  isDark,
  onThemeToggle,
  lang,
  onLangToggle,
  onLogout,
  t,
}: SidebarProps) {
  return (
    <aside className="w-[64px] h-full flex flex-col items-center pt-[max(1rem,env(safe-area-inset-top))] pb-5 bg-sidebar text-sidebar-foreground border-r border-sidebar-border/40">
      {/* Logo */}
      <div className="mb-8">
        <div className="w-10 h-10 bg-sidebar-primary rounded-xl flex items-center justify-center shadow-md shadow-sidebar-primary/20">
          <span className="text-sidebar-primary-foreground font-bold text-lg">P</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-2 w-full px-2 items-center">
        <NavItem
          icon={MessageSquare}
          to="/chat"
          tooltip={t.nav_chat || 'Chat'}
        />
        <NavItem
          icon={FolderOpen}
          to="/workspace"
          tooltip={t.nav_files || 'Workspace'}
        />
        <NavItem
          icon={Bot}
          to="/characters"
          tooltip={t.nav_characters || 'Roleplay'}
        />
      </nav>

      {/* Bottom Actions */}
      <div className="flex flex-col gap-3 items-center">
        <NavItem
          icon={Settings}
          to="/settings"
          tooltip={t.nav_config || 'Settings'}
        />

        <div className="w-8 h-px bg-sidebar-border my-1" />

        <button
          onClick={onThemeToggle}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-sidebar-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-all"
          title={isDark ? 'Light Mode' : 'Dark Mode'}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <button
          onClick={onLangToggle}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold text-sidebar-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-all"
          title={t.lang_switch || 'Switch Language'}
        >
          {(lang || 'zh').toUpperCase()}
        </button>

        <button
          onClick={onLogout}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-sidebar-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
          title={t.logout || 'Logout'}
        >
          <LogOut size={18} />
        </button>

        <div className="mt-2">
          <Avatar className="w-9 h-9 ring-2 ring-transparent hover:ring-primary/50 transition-all cursor-pointer">
            <AvatarImage src={user?.avatar} />
            <AvatarFallback className="bg-secondary text-sm font-medium">
              {user?.username?.[0]?.toUpperCase() || 'U'}
            </AvatarFallback>
          </Avatar>
        </div>
      </div>
    </aside>
  );
};

// Mobile Bottom Navigation Component

interface DockRects {
  dockLeft: number;
  items: { relLeft: number; width: number; center: number }[];
}

interface DockPointerState {
  id: number;
  x0: number;
  moved: boolean;
  lastX: number;
  lastT: number;
  vx: number; // px/ms，指数平滑
  dwellTab: number | null;
  lastMoveAt: number;
  lastMoveX: number;
}

// 弹簧参数：近似临界阻尼（2√(k·m)≈35.8）。滑块与页面共用同一条 p 弹簧，
// 欠阻尼的过冲在滑块上只有几像素看不出来、在整屏宽的页面上却是几十像素的大甩动
// ——所以取接近临界的 35.5：页面落位干净不回弹，滑块依然利落带吸入感。
// 【K21g 2026-10-01】吸附动画：framer-motion JS 弹簧（rAF 驱动，WebApp 内 rAF
// 实测 60Hz）→ CSS transition（合成器，跟随面板 120Hz）。滑块/页面必须同曲线
// 同时长（K 系列不变量：否则先后脚）。出手速度不再注入动画（贝塞尔无初速度
// 参数），仅保留速度决定目标 tab 的落点偏置。
const PILL_SNAP_TRANSITION = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1), width 300ms cubic-bezier(0.4, 0, 0.2, 1)';
const DRAG_START_PX = 6; // 超过该位移才算拖动，否则视为轻点
const DWELL_MS = 180; // 按住停留在某 tab 上方多久后吸附过去

export function MobileBottomNav({
  t,
  isDark = false,
  dockOffset = 0,
  sidebarCollapsed = true,
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  // 历史侧栏打开时 dock 右移让位：侧栏宽已改视口 80%（w-[80%]），dock 同步让
  // 80vw——CSS 单位随窗口宽度自适应，无需 JS 测量
  const historyOffset = (!sidebarCollapsed && location.pathname === '/chat') ? '80vw' : '0px';
  // dockOffset 只属于角色扮演页：MobilePager 四槽常驻，离开 /characters 时
  // CharacterView 不卸载、其复位 effect 不会跑，这里按路由裁掉陈旧偏移，
  // 避免 dock 在其他 tab 上仍带着角色页侧栏的位移（还会与 historyOffset 叠加）。
  // number=px（桌面端 320px 固定宽侧栏）、string=CSS 长度（移动端 w-[80%] 侧栏按视口自适应）
  const characterOffset: number | string = location.pathname.startsWith('/characters') ? dockOffset : 0;
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const pillRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Record<string, HTMLAnchorElement | null>>({});
  const [pillReady, setPillReady] = React.useState(false);
  // 乐观文字高亮：目标 tab 确定瞬间切色不等路由渲染；路由 pathname 追上后清除
  const [pendingTab, setPendingTab] = React.useState<string | null>(null);
  const tabs = React.useMemo(() => [
    { id: '/chat', icon: MessageSquare, label: t.nav_chat || 'Chat' },
    { id: '/workspace', icon: FolderOpen, label: t.nav_files || 'Workspace' },
    { id: '/characters', icon: Bot, label: t.nav_characters || 'Roleplay' },
    { id: '/settings', icon: Settings, label: t.nav_config || 'Settings' }
  ], [t.nav_chat, t.nav_files, t.nav_characters, t.nav_config]);

  const getActiveId = React.useCallback(() => {
    const exact = tabs.find((tab) => location.pathname === tab.id);
    if (exact) return exact.id;
    const nested = tabs.find((tab) => location.pathname.startsWith(`${tab.id}/`));
    return nested?.id || '/chat';
  }, [location.pathname, tabs]);

  const routeActiveId = getActiveId();
  const activeId = pendingTab ?? routeActiveId;
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);

  // ── 滑块 ↔ 页面轨道 连续位置控制 ──
  // p ∈ [0,3] 是唯一事实源：滑块 transform 与 MobilePager 槽位 transform 都由它
  // 推导。拖动逐帧直写 DOM（绕过 React）；吸附/点击/路由变化走 framer 弹簧。
  const rectsRef = React.useRef<DockRects | null>(null);
  const pRef = React.useRef(0);
  const initedRef = React.useRef(false);
  const springTargetRef = React.useRef<number | null>(null);
  const activeIndexRef = React.useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const routeActiveIdRef = React.useRef(routeActiveId);
  routeActiveIdRef.current = routeActiveId;
  const pointerRef = React.useRef<DockPointerState | null>(null);
  // 指针路径已完成导航时屏蔽派生 click。setPointerCapture 后 click 会落在 dock
  // 容器上不进 Link，此标志只在捕获失败、click 仍落到 Link 的浏览器里兜底防双跳。
  const suppressClickRef = React.useRef(false);

  const measureDock = React.useCallback((): DockRects | null => {
    const dock = dockRef.current;
    if (!dock) return null;
    const dockRect = dock.getBoundingClientRect();
    const items = tabs.map((tab) => {
      const r = itemRefs.current[tab.id]?.getBoundingClientRect();
      return r
        ? { relLeft: r.left - dockRect.left, width: r.width, center: r.left - dockRect.left + r.width / 2 }
        : null;
    });
    if (items.some((item) => !item)) return null;
    return { dockLeft: dockRect.left, items: items as DockRects['items'] };
  }, [tabs]);

  const applyFrame = React.useCallback((p: number, animate = false) => {
    pRef.current = p;
    const rects = rectsRef.current;
    const pill = pillRef.current;
    if (rects && pill) {
      // K21g：animate=true 时挂 CSS transition（吸附，合成器 120Hz）；拖动/初始
      // 直写一律禁过渡（1:1 跟手）
      pill.style.transition = animate ? PILL_SNAP_TRANSITION : 'none';
      const cp = Math.min(3, Math.max(0, p));
      const i = Math.min(2, Math.floor(cp));
      const f = cp - i;
      const a = rects.items[i];
      const b = rects.items[Math.min(3, i + 1)];
      const left = a.relLeft + (b.relLeft - a.relLeft) * f;
      pill.style.transform = `translate3d(${left}px, -50%, 0)`;
      pill.style.width = `${rects.items[Math.round(cp)].width}px`;
    }
    // 【拖动解耦】不再写 mobilePager：拖动 dock 时只移动滑块，页面停在当前
    // tab；松手/路由切换时由 setPageP(true) 的 CSS 过渡把页面滑到目标页。
  }, []);

  // 页面轨道位置（0..3），与滑块拖动位置 pRef 分离。只有松手判定/路由变化时
  // 才切页（K 不变量：拖动时主页不跟着滑，松手后再动画到目标页）。
  const pagePRef = React.useRef(0);

  const setPageP = React.useCallback((p: number, animate = false) => {
    pagePRef.current = p;
    mobilePager.p = p;
    // K21g：animate=true 时 MobilePager 槽位挂 CSS transition（合成器 120Hz）
    mobilePager.emit(animate);
  }, []);

  const springTo = React.useCallback((target: number) => {
    const clamped = Math.min(3, Math.max(0, target));
    springTargetRef.current = clamped;
    // 滑块与页面：同曲线同时长的 CSS 过渡，从各自当前视觉位置滑向目标
    // （CSS transition 天然支持中途重定位 retarget）
    applyFrame(clamped, true);
    setPageP(clamped, true);
  }, [applyFrame, setPageP]);

  // 拖动中的"停留吸附"只收滑块：仍按住、目标只作视觉提示，页面继续等松手判定。
  const snapPillTo = React.useCallback((target: number) => {
    applyFrame(Math.min(3, Math.max(0, target)), true);
  }, [applyFrame]);

  const pFromX = React.useCallback((clientX: number): number => {
    const rects = rectsRef.current;
    if (!rects) return pRef.current;
    const spacing = (rects.items[3].center - rects.items[0].center) / 3;
    if (spacing <= 0) return pRef.current;
    return Math.min(3, Math.max(0, (clientX - rects.dockLeft - rects.items[0].center) / spacing));
  }, []);

  const navigateToTab = React.useCallback((idx: number) => {
    const tab = tabs[idx];
    if (!tab || tab.id === routeActiveIdRef.current) return;
    suppressClickRef.current = true;
    setPendingTab(tab.id);
    // 兜底：路由因故未跳转时，乐观态 800ms 后自动回落
    window.setTimeout(() => setPendingTab(null), 800);
    navigate(tab.id, { replace: true });
  }, [tabs, navigate]);

  const handlePointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const dock = dockRef.current;
    if (!dock) return;
    rectsRef.current = measureDock();
    if (!rectsRef.current) return;
    // 按下不立即接管：轻点保持原有弹簧动画，位移超过阈值才进入拖动跟手
    pointerRef.current = {
      id: e.pointerId,
      x0: e.clientX,
      moved: false,
      lastX: e.clientX,
      lastT: performance.now(),
      vx: 0,
      dwellTab: null,
      lastMoveAt: performance.now(),
      lastMoveX: e.clientX,
    };
    suppressClickRef.current = false;
    try {
      dock.setPointerCapture(e.pointerId);
    } catch {
      // 捕获失败时 click 仍会落到 Link，由 onClick 兜底导航
    }
  }, [measureDock]);

  const handlePointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = pointerRef.current;
    if (!st || e.pointerId !== st.id) return;
    const now = performance.now();

    if (!st.moved) {
      if (Math.abs(e.clientX - st.x0) < DRAG_START_PX) return;
      // 进入拖动：滑块转 1:1 跟手（applyFrame 直写会关掉在途 CSS 过渡；
      // K 不变量：拖动时页面保持不动，在途的页面过渡让它自己走完）
      st.moved = true;
      springTargetRef.current = null;
    }

    // 停留吸附后再次移动 → 立即恢复跟手
    springTargetRef.current = null;
    st.dwellTab = null;

    const dt = Math.max(1, now - st.lastT);
    st.vx = 0.8 * st.vx + 0.2 * ((e.clientX - st.lastX) / dt);
    st.lastX = e.clientX;
    st.lastT = now;
    applyFrame(pFromX(e.clientX));

    // 按住停留：滑块先吸附到该 tab 作视觉提示（仍按住，页面等松手再判定）
    if (Math.abs(e.clientX - st.lastMoveX) > 4) {
      st.lastMoveX = e.clientX;
      st.lastMoveAt = now;
    } else if (st.dwellTab === null && now - st.lastMoveAt > DWELL_MS) {
      const idx = Math.min(3, Math.max(0, Math.round(pRef.current)));
      st.dwellTab = idx;
      navigateToTab(idx);
      snapPillTo(idx);
    }
  }, [applyFrame, pFromX, navigateToTab, snapPillTo]);

  const handlePointerEnd = React.useCallback((e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const st = pointerRef.current;
    if (!st || e.pointerId !== st.id) return;
    pointerRef.current = null;

    if (cancelled) {
      springTo(Math.round(pRef.current));
      return;
    }

    if (!st.moved) {
      // 轻点：滑块带弹簧动画滑向目标（保留原点击动效），页面同步滑入
      const idx = Math.min(3, Math.max(0, Math.round(pFromX(e.clientX))));
      navigateToTab(idx);
      springTo(idx);
      return;
    }

    // 拖动松手：停留吸附优先，否则按最近 tab（加出手速惯性偏置）收尾；
    // K21g：速度只决定落点偏置——吸附动画本身是匀速贝塞尔（无初速度参数）
    const rects = rectsRef.current;
    const spacing = rects ? (rects.items[3].center - rects.items[0].center) / 3 : 1;
    const vP = Math.max(-6, Math.min(6, (st.vx / Math.max(1, spacing)) * 1000)); // p/s
    const bias = Math.max(-0.45, Math.min(0.45, vP * 0.12));
    const target = st.dwellTab !== null
      ? st.dwellTab
      : Math.min(3, Math.max(0, Math.round(pRef.current + bias)));
    navigateToTab(target);
    springTo(target);
  }, [pFromX, navigateToTab, springTo]);

  // 初始对齐：无动画地把滑块/页面放到当前路由对应位置
  React.useLayoutEffect(() => {
    rectsRef.current = measureDock();
    if (rectsRef.current && !initedRef.current) {
      initedRef.current = true;
      applyFrame(activeIndexRef.current);
      setPageP(activeIndexRef.current);
      setPillReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 路由驱动的切换（轻点兜底/浏览器返回/页内跳转）：弹簧滑到新 tab
  React.useEffect(() => {
    if (!initedRef.current) return;
    if (pointerRef.current) return;
    if (springTargetRef.current === activeIndex) return;
    springTo(activeIndex);
  }, [activeIndex, springTo]);

  React.useEffect(() => {
    const onResize = () => {
      rectsRef.current = measureDock();
      if (rectsRef.current && !pointerRef.current) applyFrame(pRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureDock, applyFrame]);

  // 路由追上目标后清除乐观高亮态
  React.useEffect(() => {
    setPendingTab(null);
  }, [location.pathname]);

  // 将 dock 栏总高度写入 CSS 变量，供输入框精确定位
  React.useEffect(() => {
    const measureDockHeight = () => {
      const nav = document.querySelector('nav[data-dock="true"]') as HTMLElement | null;
      if (nav) {
        const height = nav.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--palink-dock-height', `${Math.ceil(height)}px`);
      }
    };
    measureDockHeight();
    const ro = new ResizeObserver(measureDockHeight);
    if (dockRef.current) ro.observe(dockRef.current);
    const nav = document.querySelector('nav[data-dock="true"]') as HTMLElement | null;
    if (nav) ro.observe(nav);
    window.addEventListener('resize', measureDockHeight);
    window.addEventListener('orientationchange', measureDockHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measureDockHeight);
      window.removeEventListener('orientationchange', measureDockHeight);
    };
  }, []);

  // 【K21d 2026-10-01】iOS 27.x PWA 屏底系统预留带探测：布局视口=screen−envTop 且
  // 顶部锚定（WebKit Bug 301994 的 27.2 变体 + Bug 316008，见 TODOS.md K21 系列），
  // Home Indicator 实际落在网页不可达的预留带内——dock 的 34pt env 规避变成纯悬空。
  // strip=screen−clientHeight 实测预留带高度，仅 standalone+iOS 生效（Safari 浏览器
  // 模式与 Android 的 screen 语义不同，不适用）；Apple 日后修复（clientHeight 回满屏）
  // 时 strip→0，自动回到原公式。
  const [phantomStrip, setPhantomStrip] = React.useState(0);
  React.useEffect(() => {
    const measure = () => {
      const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
        || window.matchMedia('(display-mode: standalone)').matches;
      const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent);
      const strip = window.screen.height - document.documentElement.clientHeight;
      setPhantomStrip(standalone && isIOS && strip > 2 ? strip : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  // number 偏移补 px 后缀，string（如 '80vw'）直接拼接——与侧栏宽度同源，随视口自适应
  const dockTransform = `translate3d(calc(${typeof characterOffset === 'number' ? `${characterOffset}px` : characterOffset} + ${historyOffset}), 0, 0)`;

  return (
    <nav className={cn(
      // absolute（原为 fixed）：dock 挂在 .palink-app-shell 内，shell 高度 = 实测
      // 可视高度，因此 absolute bottom:0 即贴在键盘上沿，与输入框共用同一套坐标系。
      // fixed 在 iOS 上锚定哪个视口随版本/上下文变化，不可依赖。
      'absolute bottom-0 inset-x-0 z-50 flex flex-col items-center pointer-events-auto w-[92%] max-w-[560px] mx-auto'
    )} style={{
      transform: dockTransform,
      // 侧栏滑入/正文右移用的是 Tailwind ease-in-out（cubic-bezier(0.4,0,0.2,1)）。
      // 此处必须用同一条曲线——CSS 关键字 ease-in-out 是 (0.42,0,0.58,1)，形状不同，
      // 会让 dock 与侧栏/正文在 300ms 内出现肉眼可见的先后脚（dock 右移不同步）。
      // translate3d + willChange 与侧栏/正文同走 GPU 合成层，帧调度一致。
      transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
      willChange: 'transform',
      // 【尾部 dock 修复】shell 已含 env(safe-area-inset-bottom)（见 index.css
      // coarse 块），dock absolute bottom:0 直接锚到屏幕底。Home Indicator 由
      // env(safe-area-inset-bottom) 表达，dock paddingBottom 仅作视觉呼吸，
      // 顺手让 dock pill 在浏览器模式（inset=0）下也别死贴屏底：
      //   - inset=0（浏览器）  → max(0,8) = 8px
      //   - inset=34（PWA）    → max(34,8) = 34px，pill 正好在 Home Indicator 上沿
      // 原值 `max(0px, calc(env(...) - 22px))` 是 shell 不含 inset 时代的兼容写法，
      // 后续 shell 改造后公式不再成立，改为更直白的 max 形式。
      // 【K19 2026-09-03】iOS 27 PWA 把 env(safe-area-inset-bottom) 报成 ~83pt
      // （真机截图取证：dock pill 底边 ≈769-774pt / 屏高 852pt——34pt Home
      // Indicator + ~49pt 系统底栏区被合并上报；svh 同步变小，shell=svh+env
      // 恰好仍满屏）。max(env,8) 因此把 dock 整个抬高 83pt = 用户报的
      // 「dock 与屏底之间大空白」。加 34pt 上限，inset 正常的设备行为不变：
      //   - inset=0（浏览器）       → 8px
      //   - inset=34（旧 iOS PWA）  → 34px
      //   - inset≈83（iOS 27 PWA）  → 34px（封顶，回到设计位）
      // 【K21d 2026-10-01】iOS 27.x PWA（屏底 59pt 系统预留带，见上方 phantomStrip）：
      // Home Indicator 已在预留带内、不在页面区域内，34pt env 规避=纯悬空，
      // 改 8px 让 pill 贴预留带上沿（视觉间隙 93→67pt）。其余环境（浏览器模式/
      // 正常 iOS/Apple 修复后 strip→0）仍走原公式，行为不变。
      paddingBottom: phantomStrip > 0 ? '8px' : 'min(max(env(safe-area-inset-bottom, 0px), 8px), 34px)',
    }} data-dock="true">
      <div
        ref={dockRef}
        className={cn(
          'relative flex h-[70px] w-[92%] max-w-[560px] select-none items-center justify-around rounded-[35px] border backdrop-blur-[30px] shadow-[0_10px_28px_rgba(120,106,79,0.14)]',
          isDark
            ? 'border-slate-600/80 bg-[#2d3350]/70'
            : 'border-[#ddd4c5]/80 bg-white/60'
        )}
        style={{ touchAction: 'none' }}
        data-dock="true"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => handlePointerEnd(e, false)}
        onPointerCancel={(e) => handlePointerEnd(e, true)}
      >
        <div
          ref={pillRef}
          className={cn(
            'absolute top-1/2 left-0 z-[1] h-[52px] rounded-[26px]',
            isDark ? 'bg-white/[0.15]' : 'bg-[#ece2d3]/50'
          )}
          style={{
            opacity: pillReady ? 1 : 0,
            transition: 'opacity 200ms ease',
          }}
        />
        {tabs.map((item) => {
          const IconComponent = item.icon;
          const isActive = activeId === item.id;
          return (
            <Link
              key={item.id}
              to={item.id}
              replace
              ref={(el) => {
                itemRefs.current[item.id] = el;
              }}
              className={cn(
                'relative z-[2] flex h-full w-[22%] flex-col items-center justify-center gap-1 text-center transition-all duration-300 active:scale-[0.98]',
                isDark
                  ? (isActive ? 'text-white' : 'text-white/65')
                  : (isActive ? 'text-slate-900' : 'text-slate-700/85')
              )}
              data-dock="true"
              onClick={(e) => {
                if (suppressClickRef.current) {
                  e.preventDefault();
                  suppressClickRef.current = false;
                  return;
                }
                if (item.id === routeActiveId) {
                  // 再点已激活 tab = 回到该页根部（iOS 同款语义）：设置页返回键移除后，
                  // 这是回设置菜单的唯一手势（SettingsView 监听 palink:settings-root）
                  if (item.id === '/settings') {
                    window.dispatchEvent(new CustomEvent('palink:settings-root'));
                  }
                  return;
                }
                // 键盘激活（Enter）等无指针事件的兜底路径：路由变化触发弹簧滑块
                setPendingTab(item.id);
                window.setTimeout(() => setPendingTab(null), 800);
              }}
            >
              <span className="flex">
                <IconComponent size={22} strokeWidth={isActive ? 2.5 : 2} />
              </span>
              <span className={cn('text-[10px] leading-none', isActive ? 'font-semibold' : 'font-medium')}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
      <p className={cn(
        'text-center text-[10px] leading-none pb-0',
        isDark ? 'text-white/40' : 'text-slate-400/60'
      )}>
        {t.ai_disclaimer}
      </p>
    </nav>
  );
};

// Main Sidebar Component (exports both)
export function Sidebar(props: SidebarProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileBottomNav {...props} />;
  }

  return <DesktopSidebar {...props} />;
};
