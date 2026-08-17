import { useEffect, useRef } from 'react';

/**
 * ST Quick Reply 扩展挂载点（#qr_bar）。
 *
 * ST 的 Quick Reply 等扩展通过 jQuery 选择器把快捷回复按钮渲染到 #qr_bar。
 * Palink 此前完全缺失该 DOM 节点，导致插件按钮栏"看似加载成功实则不可见"。
 * 这里在聊天输入框上方提供一个可见的 #qr_bar 容器，供 ST 插件挂载按钮。
 */
export function QrBar() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.id = 'qr_bar';
    el.className = 'palink-st-qr-bar';
    // 通知 ST 兼容运行时：#qr_bar 已就绪（部分插件初始化时会检测此节点）
    window.dispatchEvent(new CustomEvent('palink:qr_bar_ready', { detail: { element: el } }));
  }, []);

  return (
    <div
      ref={ref}
      className="palink-st-qr-bar"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        padding: '4px 8px',
        minHeight: '32px',
        borderBottom: '1px solid var(--border-color, #e0e0e0)',
      }}
    />
  );
}

export default QrBar;
