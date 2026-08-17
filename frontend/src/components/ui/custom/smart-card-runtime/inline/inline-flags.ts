/**
 * 智能卡「完全内联渲染」特性开关。
 *
 * PoC 阶段默认关闭：关闭时 Message.tsx 走原 CharacterCardRenderer(iframe) 路径，
 * 开启时走 InlineCardRenderer(内联) 路径。旧代码一行未删，可随时切回。
 *
 * 切换方式（浏览器控制台，无需重新构建）：
 *   localStorage.setItem('palink_inline_card_rendering', '1'); location.reload();  // 开
 *   localStorage.removeItem('palink_inline_card_rendering');   location.reload();  // 关
 *
 * 注意：production 构建会剥离 console.log（vite.config.ts pure_funcs），调试一律用 console.warn。
 */

export const INLINE_CARD_FLAG_KEY = 'palink_inline_card_rendering';
/**
 * 强制开关：绕过移动端安全护栏。仅用于**桌面端**开发者在 DevTools 设备模拟下验证
 * 内联渲染（模拟器 UA 会被 isInlineCardSafeEnv 误判为移动端而强制走 iframe）。
 * 真实手机用户不该设这个；设了且真在移动 WebView 里，最坏情况由 InlineCardErrorBoundary
 * 兜底（单卡崩不拖整页），不会像当初未加边界时那样整页黑屏。
 */
export const INLINE_CARD_FORCE_KEY = 'palink_inline_card_force';

/** 模块级快照：避免每条消息渲染都读一次 localStorage，且保证同一次会话内行为一致。 */
let cachedFlag: boolean | null = null;

export function isInlineCardRenderingEnabled(): boolean {
  if (cachedFlag !== null) return cachedFlag;
  if (typeof window === 'undefined') return false;
  let enabled = false;
  try {
    enabled = window.localStorage.getItem(INLINE_CARD_FLAG_KEY) === '1';
  } catch {
    enabled = false;
  }
  cachedFlag = enabled;
  if (enabled) {
    console.warn('[inline-card] 完全内联渲染已启用（PoC）。关闭：localStorage.removeItem("' + INLINE_CARD_FLAG_KEY + '")');
  }
  return enabled;
}

/**
 * 内联渲染的「安全环境」判定。
 *
 * 为什么需要它：移动端 WebView（及任意 navigator.userAgent 含 mobile/Android/iPhone
 * 的环境）与桌面 Chromium 行为存在差异——部分 ST 全局 / DOM API 在 WebView 里抛错，
 * 而内联渲染让卡片脚本直接跑在主页面全局中，单卡脚本异常会冒泡到 React 根导致**整页
 * 黑屏**（PoC 踩过的坑）。内联渲染目前只在桌面端验证过，故移动端一律强制走 iframe。
 *
 * flag 开启 + 安全环境 = 走内联；其余一律 iframe。这样即使用户在手机上误开 flag，
 * 也不会黑屏，只是静默退回原路径。
 */
let cachedSafeEnv: boolean | null = null;

export function isInlineCardSafeEnv(): boolean {
  if (cachedSafeEnv !== null) return cachedSafeEnv;
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    cachedSafeEnv = false;
    return false;
  }
  const ua = String(navigator.userAgent || '').toLowerCase();
  const isMobileUA = /android|iphone|ipad|ipod|mobile|webos|blackberry|windows phone/i.test(ua);
  // iPadOS 13+ 伪装成桌面 Safari，需结合 touchPoints 判定
  const isTouchPad = /ipad/i.test(ua) || (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1 && /macintosh/i.test(ua));
  const safe = !isMobileUA && !isTouchPad;
  cachedSafeEnv = safe;
  return safe;
}

/**
 * 内联渲染的环境判定——只回答「当前环境是否适合内联」，何时用内联由调用方分流。
 *
 * [双路径] Message.tsx 以「最新消息内联、历史消息 iframe」分流：桌面端安全环境下
 * 最新消息走 InlineCardRenderer，历史消息走 CharacterCardRenderer(iframe)。全内联会让
 * 多张卡共享主文档、脚本 querySelector 只命中第一张卡（多卡冲突）；双路径下每张历史卡
 * 是独立 iframe 文档，冲突天然消失。移动端 WebView 行为差异大，这里恒 false，调用方
 * 一律走 iframe 防黑屏。
 *
 * [R-4 修复] 恢复 flag 门控（此前仅按环境判定，导致桌面端默认双路径）：
 * 默认（未显式开启 flag）恒 false → 桌面端开场白/最新消息/历史消息统一走
 * CharacterCardRenderer(iframe)，消除"开场白内联、历史 iframe"的脚本全局不共享
 * 漂移；显式开启 flag 时才走内联（PoC 路径，保持可用）。
 */
export function shouldUseInlineCardRendering(): boolean {
  return isInlineCardRenderingEnabled() && isInlineCardSafeEnv();
}

/** 仅供测试/调试重置缓存。 */
export function resetInlineCardFlagCache(): void {
  cachedFlag = null;
}
