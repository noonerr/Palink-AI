import { useState, useEffect, useRef, useCallback } from 'react';
import { pluginManager } from '@/lib/plugin-system/manager';
import { saveExtensionSettingsDebounced } from '@/lib/sillytavern/extension-settings-store';
import { Live2DPoolPanel } from './Live2DPoolPanel';

/**
 * ST 插件设置面板容器
 *
 * 用于在 PluginManager 中点击某插件"设置"按钮时，展示该插件的设置面板。
 *
 * 实现策略：
 * - ST 插件通常在加载时通过 jQuery 将设置面板渲染到 #extensions_settings 的子容器
 *   （如 #tts_container、#vectors_container）。这些容器由 StPluginMountPoints 提供。
 * - 本组件作为"聚焦查看"容器：将指定插件的设置面板内容（已渲染到 #xxx_container
 *   的子节点）克隆展示，或通过 renderExtensionTemplateAsync 渲染 settings 模板。
 * - 与 extension_settings 同步：通过 getExtensionSettingsNs/setExtensionSettingsNs 读写。
 *
 * 使用方式：
 * ```tsx
 * <PluginSettingsPanel pluginName="vectors" onClose={() => setShow(false)} />
 * ```
 */

export interface PluginSettingsPanelProps {
  /** 插件名（manifest.name） */
  pluginName: string;
  /** 关闭回调 */
  onClose: () => void;
  /** 初始位置（默认右上） */
  initialPosition?: { x: number; y: number };
}

// 已知的 ST 标准插件 container id 映射（manifest.name → containerId）
const PLUGIN_CONTAINER_MAP: Record<string, string> = {
  'tts': 'tts_container',
  'sd': 'sd_container',
  'expressions': 'expressions_container',
  'caption': 'caption_container',
  'summarize': 'summarize_container',
  'vectors': 'vectors_container',
  'objective': 'objective_container',
  'regex': 'regex_container',
  'quick-reply': 'qr_container',
  'translation': 'translation_container',
  'memory': 'summarize_container',
  'world-info': 'injects_container',
  'audio': 'audio_container',
  'rss': 'rss_container',
  'dice': 'dice_container',
  'randomizer': 'randomizer_container',
  'chromadb': 'chromadb_container',
};

export function PluginSettingsPanel({
  pluginName,
  onClose,
  initialPosition,
}: PluginSettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(
    initialPosition || { x: window.innerWidth - 480, y: 80 }
  );
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState(pluginName);

  // 拖拽逻辑
  const dragStart = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest('button')) return;
    setDragging(true);
    dragStart.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
    };
    e.preventDefault();
  }, [position]);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: MouseEvent) => {
      if (!dragStart.current) return;
      const dx = e.clientX - dragStart.current.startX;
      const dy = e.clientY - dragStart.current.startY;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 200, dragStart.current.originX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragStart.current.originY + dy)),
      });
    };
    const handleUp = () => {
      setDragging(false);
      dragStart.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging]);

  // 加载插件设置面板内容
  useEffect(() => {
    const plugin = pluginManager.getPlugin(pluginName);
    if (plugin) {
      setTitle(plugin.manifest.displayName || plugin.manifest.name);
    }

    if (!contentRef.current) return;

    // 优先从已渲染的 ST 标准 container 克隆内容
    const knownContainerId = PLUGIN_CONTAINER_MAP[pluginName];
    // 通用回退：许多 ST 扩展（含 Palink 样例插件）把设置面板注入到
    // #extensions_settings / #extensions_settings2 下、id 为 `${pluginName}_container` 的容器。
    // 例如 palink-sample-extension 注入 palink-sample-extension_container。
    const candidateIds = [knownContainerId, `${pluginName}_container`].filter(
      Boolean,
    ) as string[];
    let sourceContainer: HTMLElement | null = null;
    for (const cid of candidateIds) {
      const el = document.getElementById(cid);
      if (el && el.children.length > 0) {
        sourceContainer = el;
        break;
      }
    }
    // 再兜底：在 #extensions_settings* 内查找 id 以 pluginName 开头的容器
    if (!sourceContainer) {
      for (const rootId of ['extensions_settings', 'extensions_settings2']) {
        const root = document.getElementById(rootId);
        if (root) {
          const found = root.querySelector(
            `[id^="${pluginName}"]`,
          ) as HTMLElement | null;
          if (found && found.children.length > 0) {
            sourceContainer = found;
            break;
          }
        }
      }
    }
    if (sourceContainer) {
      contentRef.current.innerHTML = '';
      // 克隆已渲染内容（保留事件需重新绑定，但 ST 插件通常使用 jQuery 委托）
      const clone = sourceContainer.cloneNode(true) as HTMLElement;
      clone.id = `${sourceContainer.id}_mirror`;
      clone.style.display = 'block';
      contentRef.current.appendChild(clone);
      return;
    }

    // 兜底：扫描 ST 挂载点中插件运行时注入的设置入口 UI（如酒馆助手注入的
    // #galgame-ui-plugin-btn / #bubble-avatar-wand-btn）。克隆后点击转发到原
    // DOM 元素，因为 cloneNode 不会复制插件绑定的 jQuery 事件。
    const mountPointIds = [
      'extensionsMenu',
      'extensions_menu',
      'extensions_settings',
      'extensions_settings2',
      'movingDivs',
      'top-settings-holder',
    ];
    const injectedNodes: HTMLElement[] = [];
    for (const mid of mountPointIds) {
      const root = document.getElementById(mid);
      if (!root) continue;
      for (const child of Array.from(root.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const isEmptyContainer =
          child.classList.contains('extension_container') &&
          child.children.length === 0 &&
          !(child.textContent || '').trim();
        if (isEmptyContainer) continue;
        if ((child.textContent || '').trim() || child.children.length > 0) {
          injectedNodes.push(child);
        }
      }
    }
    if (injectedNodes.length > 0) {
      contentRef.current.innerHTML = '';
      for (const node of injectedNodes) {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.id = `${node.id || 'plugin-ui'}_mirror`;
        clone.style.display = 'block';
        clone.style.marginBottom = '8px';
        clone.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          node.click();
        });
        contentRef.current.appendChild(clone);
      }
      return;
    }

    // 回退：通过 renderExtensionTemplateAsync 渲染 settings 模板
    const renderAsync = async () => {
      try {
        const stRuntime = (window as any).SillyTavern;
        if (stRuntime?.getContext) {
          const ctx = stRuntime.getContext();
          if (typeof ctx.renderExtensionTemplateAsync === 'function') {
            const html = await ctx.renderExtensionTemplateAsync(pluginName, 'settings', {});
            if (html && contentRef.current) {
              contentRef.current.innerHTML = html;
            }
          }
        }
      } catch (e) {
        console.warn('[PluginSettingsPanel] 渲染设置面板失败:', e);
      }
    };
    renderAsync();
  }, [pluginName]);

  // 关闭按钮
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // 保存设置
  const handleSave = useCallback(() => {
    try {
      // 触发 extension_settings 持久化
      saveExtensionSettingsDebounced();
      onClose();
    } catch (e) {
      console.warn('[PluginSettingsPanel] 保存设置失败:', e);
    }
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="fixed z-[60] bg-background border border-border rounded-lg shadow-xl flex flex-col"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: '440px',
        maxHeight: '70vh',
      }}
    >
      {/* 标题栏（可拖拽） */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-border cursor-move select-none bg-muted/40 rounded-t-lg"
        onMouseDown={handleDragStart}
      >
        <div className="text-sm font-semibold flex items-center gap-2">
          <span>⚙</span>
          <span>{title}</span>
          <span className="text-xs text-muted-foreground">设置</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            title="保存并关闭"
          >
            保存
          </button>
          <button
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground w-6 h-6 flex items-center justify-center rounded"
            title="关闭"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div
        className="flex-1 overflow-y-auto p-3 text-sm"
        style={{ minHeight: '120px' }}
      >
        <div
          ref={contentRef}
          className="text-xs text-muted-foreground italic"
          style={{ minHeight: '40px' }}
        >
          该插件未提供设置面板，或设置面板已直接渲染到 #extensions_settings 中。
        </div>

        {/* Live2D 模型池：服务器托管模型，无需用户上传即可绑定到角色 */}
        <div className="mt-3 pt-3 border-t border-border">
          <Live2DPoolPanel />
        </div>
      </div>
    </div>
  );
}

export default PluginSettingsPanel;
