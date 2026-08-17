/**
 * 智能卡第三方资源加载模式设置
 *
 * direct（默认）：图片/样式/字体全部由用户浏览器直连第三方加载（对齐
 *   SillyTavern 行为），后端零媒体流量、只做文字的保存与同步。
 * proxy：资源经 /api/smart-card-assets 服务端中转（服务器磁盘缓存 +
 *   webp 转压 + 用户 IP 不暴露给图床）。
 *
 * 直连字体的边界：@font-face 跨源要求 CORS，ACAO:* 源（Google Fonts/
 * jsdelivr 等）正常；不发 CORS 头的字体源会失效（ST 下同样失效），
 * 需要时切 proxy 模式。
 *
 * 存储遵循设置页既有模式：localStorage + CustomEvent（参考 palink-auto-contrast）。
 */

export const SMART_CARD_ASSET_MODE_STORAGE_KEY = 'palink-smart-card-asset-mode';
export const SMART_CARD_ASSET_MODE_CHANGED_EVENT = 'palink-smart-card-asset-mode-changed';

export type SmartCardAssetMode = 'direct' | 'proxy';

export function getSmartCardAssetMode(): SmartCardAssetMode {
  try {
    const raw = localStorage.getItem(SMART_CARD_ASSET_MODE_STORAGE_KEY);
    // 缺省/非法值均为 direct（默认用户直连）
    return raw === 'proxy' ? 'proxy' : 'direct';
  } catch {
    return 'direct';
  }
}

export function setSmartCardAssetMode(mode: SmartCardAssetMode): void {
  try {
    localStorage.setItem(SMART_CARD_ASSET_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent(SMART_CARD_ASSET_MODE_CHANGED_EVENT, { detail: { mode } }),
  );
}
