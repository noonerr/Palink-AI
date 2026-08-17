import { memo, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * ST 插件 UI 挂载点系统
 *
 * ST 插件通过 jQuery 选择器将设置面板、扩展菜单、浮动 UI 渲染到特定 DOM 节点。
 * Palink 需提供这些标准挂载点，使 ST 插件能正确注入 UI。
 *
 * 挂载点策略：
 * - `#extensions_settings` / `#extensions_settings2`：插件设置面板容器，含子容器
 *   （tts_container、vectors_container 等），ST 插件通过 `$('#xxx_container').append(html)` 注入
 * - `#extensions_menu`：扩展下拉菜单容器（ST 动态创建，这里提供占位）
 * - `#movingDivs`：可移动浮动面板容器（gallery、author note 等）
 * - `#top-settings-holder`：顶部设置栏（AI 配置等，ST 插件部分设置项会注入此处）
 *
 * 实现要点（P-7 修复）：
 * - 挂载点初始隐藏（display:none），MutationObserver 检测**内容非空**时自动显示，
 *   内容清空时恢复隐藏 —— 空容器不参与布局，避免插件面板"出不来"（此前全部
 *   display:none 且无任何 .show() 路径，插件注入的 UI 永远不可见）。
 * - React 不管理挂载点子内容，ST 插件通过 jQuery 直接操作 DOM。
 *
 * 参考：SillyTavern 1.18.0 public/index.html
 */

// ST 1.18.0 #extensions_settings 标准子容器列表（第一列）
const EXTENSIONS_SETTINGS_CONTAINERS_1 = [
  'assets_container',
  'typing_indicator_container',
  'expressions_container',
  'sd_container',
  'tts_container',
  'rvc_container',
  'stt_container',
  'audio_container',
  'silence_container',
  'objective_container',
  'blip_container',
  'live2d_container',
  'vrm_container',
  'timelines_container',
  'webllm_container',
  'rss_container',
] as const;

// ST 1.18.0 #extensions_settings2 标准子容器列表（第二列）
const EXTENSIONS_SETTINGS_CONTAINERS_2 = [
  'websearch_container',
  'emulatorjs_container',
  'qr_container',
  'translation_container',
  'caption_container',
  'idle_container',
  'summarize_container',
  'hypebot_container',
  'regex_container',
  'vectors_container',
  'randomizer_container',
  'chromadb_container',
  'message_limit_container',
  'injects_container',
  'accuweather_container',
  'dice_container',
] as const;

// K-11 修复: ST 1.18.0 wand 菜单（templates/wandMenu.html）标准容器列表。
// 这些容器位于聊天区输入框旁的 #extensionsMenu 内，token-counter 等插件通过
// `$('#token_counter_wand_container').append(...)` 注入按钮；此前 Palink 未提供
// #extensionsMenu，插件加载成功但按钮静默不可见。现提供完整 wand 容器组，
// 与 #extensions_settings* 一样 AutoRevealMountPoint 有内容才显示。
const WAND_CONTAINERS = [
  'data_bank_wand_container',
  'attach_file_wand_container',
  'sd_wand_container',
  'caption_wand_container',
  'gallery_wand_container',
  'tts_wand_container',
  'screen_share_wand_container',
  'prompt_inspector_wand_container',
  'emulatorjs_wand_container',
  'notebook_wand_container',
  'chess_wand_container',
  'token_counter_wand_container',
  'dice_wand_container',
  'objective_wand_container',
  'translate_wand_container',
] as const;

/**
 * 单个挂载点容器：初始隐藏，内容非空时自动显示。
 *
 * 判定规则：递归扫描子元素，只要存在"有可见文本或含后代元素"的节点即视为有内容。
 * 空占位（如 16 个空的 extension_container）不触发显示。
 */
function AutoRevealMountPoint({
  id,
  className,
  children,
  forceHidden = false,
}: {
  id: string;
  className?: string;
  children?: ReactNode;
  forceHidden?: boolean;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const hasRealContent = (node: Element): boolean => {
      for (const child of node.children) {
        if (!(child instanceof HTMLElement)) continue;
        // 文本节点内容（含插件注入的纯文本/HTML 文本）
        if (child.textContent?.trim()) return true;
        // 无文本但有结构（如图片/iframe/带空格的复杂结构）
        if (child.children.length > 0 && hasRealContent(child)) return true;
      }
      return false;
    };

    const check = () => {
      setHasContent(hasRealContent(el));
    };
    check();

    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);

  return (
    <div
      id={id}
      ref={innerRef}
      className={className}
      style={forceHidden || !hasContent ? { display: 'none' } : undefined}
      aria-hidden={forceHidden || !hasContent ? true : undefined}
    >
      {children}
    </div>
  );
}

/**
 * ST 插件 UI 挂载点系统
 *
 * 在 NativeRoleplayChat 中渲染一次，提供所有 ST 标准挂载点。
 * 挂载点按内容自动显示/隐藏（见 AutoRevealMountPoint），不影响主布局。
 */
export const StPluginMountPoints = memo(function StPluginMountPoints() {
  // 设置 id 并派发就绪事件，通知 ST 兼容运行时挂载点已就绪
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('palink:st_mount_points_ready', {
        detail: {
          extensions_settings: document.getElementById('extensions_settings'),
          extensions_settings2: document.getElementById('extensions_settings2'),
          extensions_menu: document.getElementById('extensions_menu'),
          movingDivs: document.getElementById('movingDivs'),
          'top-settings-holder': document.getElementById('top-settings-holder'),
        },
      })
    );
  }, []);

  return (
    <>
      {/* 顶部设置栏挂载点（ST AI 配置等，有内容时自动显示） */}
      <AutoRevealMountPoint
        id="top-settings-holder"
        className="palink-st-mount-point palink-st-top-settings"
      />

      {/* 扩展菜单挂载点（ST 扩展下拉菜单，有内容时自动显示） */}
      <AutoRevealMountPoint
        id="extensions_menu"
        className="palink-st-mount-point palink-st-extensions-menu"
      />

      {/* 插件设置面板容器（第一列，含 16 个标准子容器） */}
      <AutoRevealMountPoint
        id="extensions_settings"
        className="palink-st-mount-point palink-st-extensions-settings"
      >
        {EXTENSIONS_SETTINGS_CONTAINERS_1.map((containerId) => (
          <div
            key={containerId}
            id={containerId}
            className="extension_container"
          />
        ))}
      </AutoRevealMountPoint>

      {/* 插件设置面板容器（第二列，含 16 个标准子容器） */}
      <AutoRevealMountPoint
        id="extensions_settings2"
        className="palink-st-mount-point palink-st-extensions-settings2"
      >
        {EXTENSIONS_SETTINGS_CONTAINERS_2.map((containerId) => (
          <div
            key={containerId}
            id={containerId}
            className="extension_container"
          />
        ))}
      </AutoRevealMountPoint>

      {/* 可移动浮动面板容器（gallery、author note 等，有内容时自动显示） */}
      <AutoRevealMountPoint
        id="movingDivs"
        className="palink-st-mount-point palink-st-moving-divs"
      />

      {/* K-11: wand 菜单容器组（token-counter 等插件在此注入按钮，有内容时自动显示）。
          该挂载点内容（插件内设置入口按钮）统一收纳进 PluginManager 的「插件内设置」
          二级菜单访问，不在页面左下角直接展示，故始终隐藏（DOM 保留供扫描）。 */}
      <AutoRevealMountPoint
        id="extensionsMenu"
        className="palink-st-mount-point palink-st-extensions-menu-wand"
        forceHidden
      >
        {WAND_CONTAINERS.map((containerId) => (
          <div
            key={containerId}
            id={containerId}
            className="extension_container"
          />
        ))}
      </AutoRevealMountPoint>
    </>
  );
});

export default StPluginMountPoints;
