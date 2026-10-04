/**
 * StPluginSettingsDrawer — ST 插件设置面板抽屉（插件专属设置空间）
 *
 * [插件设置空间收纳 2026-10-04]
 *
 * 背景：ST 插件把设置面板注入到 #extensions_settings / #extensions_settings2
 * 标准挂载点。ST 原生里这两个容器住在顶栏扩展抽屉里，天然收纳；Palink 此前把
 * 挂载点渲染进页面流（有内容自动显示），第三方面板（如 MVU 变量框架）会直接
 * 怼在聊天/角色页上，且 inline-drawer 折叠交互 Palink 侧未实现 → 面板收不起来、
 * 挡住整个画面。
 *
 * 本组件提供「三个点菜单 → 插件设置」的统一收纳空间：
 * - 打开时把有内容的挂载点**整个根节点 move**（appendChild）进抽屉内容区，关闭时
 *   按原位 move 回去。移动真实节点而非 cloneNode（对比 PluginSettingsPanel 的克隆
 *   方案）：插件持有的 DOM 引用与 Vue/jQuery 事件绑定全部保留，面板在抽屉里是活的
 *   （MVU 的设置面板是 Vue 应用挂载，克隆出来是死快照）。
 * - 抽屉打开期间插件新注入的面板自动可见（注入进被 move 的根节点）；
 *   打开瞬间还没注入的（如卡脚本晚几秒加载 MVU），由 MutationObserver 兜底搬入。
 * - 打开期间挂载点根节点的 inline style 被覆盖为正常布局；parked 样式来自
 *   StPluginMountPoints.ParkedMountPoint 的静态 style（该组件无状态永不重渲染，
 *   不会把抽屉里的面板再次藏掉——改 ParkedMountPoint 前先核对本文件 move 逻辑）。
 *
 * inline-drawer 折叠：在内容区容器上做事件委托（点击 header 切换
 * palink-idrawer-collapsed），折叠样式见 st-plugin-settings-drawer.css。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Puzzle, X } from 'lucide-react';
import './st-plugin-settings-drawer.css';

/** 插件设置面板挂载点根节点（与 StPluginMountPoints 的 ParkedMountPoint id 对齐） */
const MOUNT_ROOT_IDS = ['extensions_settings', 'extensions_settings2'] as const;

interface ParkedRootRecord {
  el: HTMLElement;
  parent: Node;
  nextSibling: Node | null;
  /** move 入抽屉前的 inline style，move 回时原样还原（parked 离屏样式） */
  cssText: string;
}

/**
 * 判断挂载点根节点是否含有真实插件内容。
 * 16 个标准 extension_container 空占位不算；插件注入的节点（如 MVU 的
 * inline-drawer 直接 append 在根下）才算。
 */
function mountRootHasContent(root: HTMLElement): boolean {
  for (const child of Array.from(root.children)) {
    if ((child.textContent || '').trim()) return true;
    if (child.children.length > 0) return true;
  }
  return false;
}

export function StPluginSettingsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const parkedRef = useRef<ParkedRootRecord[]>([]);
  const [hasContent, setHasContent] = useState(false);

  /** 把已搬入抽屉的挂载点根节点按原位 move 回去（关闭/重开前调用） */
  const moveBackAll = useCallback(() => {
    for (const rec of parkedRef.current) {
      try {
        rec.el.style.cssText = rec.cssText;
        if (rec.nextSibling && rec.nextSibling.parentNode === rec.parent) {
          rec.parent.insertBefore(rec.el, rec.nextSibling);
        } else {
          rec.parent.appendChild(rec.el);
        }
      } catch {
        // 挂载点父节点理论上与应用同生命周期（App 外壳层），不因单面板搬移失败阻断其余回搬
      }
    }
    parkedRef.current = [];
  }, []);

  /** 把有内容且尚未搬入的挂载点根节点 move 进抽屉；返回是否有面板在抽屉里 */
  const ensureMoved = useCallback((): boolean => {
    const host = hostRef.current;
    if (!host) return false;
    let any = false;
    for (const rootId of MOUNT_ROOT_IDS) {
      const el = document.getElementById(rootId);
      if (!(el instanceof HTMLElement)) continue;
      if (parkedRef.current.some((rec) => rec.el === el)) continue;
      if (!mountRootHasContent(el)) continue;
      const parent = el.parentNode;
      if (!parent) continue;
      parkedRef.current.push({
        el,
        parent,
        nextSibling: el.nextSibling,
        cssText: el.style.cssText,
      });
      host.appendChild(el);
      el.style.cssText = '';
      any = true;
    }
    return any;
  }, []);

  useEffect(() => {
    if (!open) return;
    setHasContent(ensureMoved());
    return () => {
      moveBackAll();
      setHasContent(false);
    };
  }, [open, ensureMoved, moveBackAll]);

  // 打开期间监听挂载点变化：插件晚注入（如 MVU 卡脚本异步加载）时自动搬入
  useEffect(() => {
    if (!open) return;
    const mo = new MutationObserver(() => {
      if (ensureMoved()) setHasContent(true);
    });
    for (const rootId of MOUNT_ROOT_IDS) {
      const el = document.getElementById(rootId);
      if (el) mo.observe(el, { childList: true, subtree: true });
    }
    return () => mo.disconnect();
  }, [open, ensureMoved]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /**
   * inline-drawer 折叠委托：点击面板的 header 切换折叠态。
   * header 识别：标准 .inline-drawer-header；插件未按 ST 约定写类名时回退
   * 「第一个子元素且不是 content」。只在整个抽屉内容区生效，点击 content 内的
   * 控件（如 MVU 设置项）不会触发折叠。
   *
   * ⚠️ 必须用原生 addEventListener 而非 React onClick：挂载点根节点被 move 进
   * 抽屉后，React 合成事件仍沿 **fiber 树**（App 外壳 → StPluginMountPoints）
   * 传播，不会经过本抽屉的 fiber 子树 —— 真机实测点击 header 无反应；
   * 原生冒泡走真实 DOM 树（host 是被 move 节点的现父节点），才能收到。
   */
  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const drawer = target.closest('.inline-drawer');
      if (!drawer || !host.contains(drawer)) return;
      const content = drawer.querySelector(':scope > .inline-drawer-content');
      if (!content) return;
      const header =
        drawer.querySelector(':scope > .inline-drawer-header') ??
        (drawer.firstElementChild !== content ? drawer.firstElementChild : null);
      if (!header || !header.contains(target)) return;
      drawer.classList.toggle('palink-idrawer-collapsed');
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="插件设置">
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* 右侧抽屉（移动端占满全宽） */}
      <aside className="absolute inset-y-0 right-0 w-full max-w-md bg-background border-l border-border shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <Puzzle size={16} className="text-muted-foreground flex-shrink-0" />
            <h2 className="text-sm font-semibold">插件设置</h2>
            <span className="text-xs text-muted-foreground truncate">
              ST 插件注入的设置面板
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground w-7 h-7 flex items-center justify-center rounded hover:bg-accent flex-shrink-0"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {!hasContent && (
            <div className="text-xs text-muted-foreground py-8 text-center leading-relaxed">
              当前没有插件注入设置面板。
              <br />
              插件面板在进入聊天页并由卡脚本加载后出现；刚进入时若为空，请稍后重新打开。
            </div>
          )}
          {/* 插件挂载点根节点被 move 进此容器（React 不管理其子内容；
              折叠委托等交互挂在本容器的原生监听上，见上方说明） */}
          <div ref={hostRef} className="palink-st-plugin-drawer-host" />
        </div>
      </aside>
    </div>
  );
}

export default StPluginSettingsDrawer;
