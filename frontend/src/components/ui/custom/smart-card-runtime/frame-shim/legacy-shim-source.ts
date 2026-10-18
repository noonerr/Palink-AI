/**
 * [LEGACY-EXTERNAL 2026-10-18] legacy shim 源码构造器（依赖零外部包）
 *
 * 为什么单独一个文件：本模块会被 `vite-plugins/smart-card-runtime-asset.ts` 在
 * **加载 vite/vitest 配置时**直接 import。那一刻 '@' 别名尚未生效，任何经
 * `@/…` 的依赖都会让 vitest 在「加载配置」阶段就 ERR_MODULE_NOT_FOUND 崩掉
 * （已实踩，见 SillyTavernCompatRuntime.ts:8-10 的同类注释）。
 * 因此这里**只允许**相对路径依赖，且不得引入 remark/@/services 等重量级模块。
 * 两个图片队列常量也搬到这里，由 `shared.ts` 反向 re-export，保持单一真源。
 *
 * 职责：把「IIFE 体」拼出来。内联路径与外部路径只有引导头（headerLines）不同，
 * 其余逐字节相同 —— identity 校验据此断言「外部化只搬位置、不改行为」。
 */
import { LEGACY_ST_SIM_SEGMENT } from './legacy-st-sim';
import { buildFrameMeasureSegment } from './frame-measure';

/** 首屏立即加载的图片数量预算（原 shared.ts，值不变）。 */
export const SMART_CARD_IFRAME_IMAGE_INITIAL_LOAD_COUNT = 3;
/** 队列中后续图片的放行间隔毫秒（原 shared.ts，值不变）。 */
export const SMART_CARD_IFRAME_IMAGE_QUEUE_DELAY_MS = 120;

/**
 * [SEC-2026-09-02 F-1] 帧内密钥（gesture token）——只被本 IIFE 闭包持有。
 * 卡片脚本与本 IIFE 同处一个 realm，任何「写在源码里」或「经 postMessage 传输」的密钥
 * 都能被恶意卡片读到（读 script.textContent / 监听 message 事件）。唯一安全的投递方式：
 * 放在 <head> 里的 <meta> 上，由本段（注入位置在所有卡片内容之前）**读取后立即移除**，
 * 之后的卡片脚本既读不到 meta 也读不到本闭包变量。
 *
 * 注入顺序约束：secretMeta 永远排在 shim 之前
 * （见 CharacterCardRenderer.injectIntoFullDocument / wrapHtmlFragment）。
 * 外部 <script src> 是经典阻塞脚本，仍在 meta 之后执行，顺序不破。
 */
export const LEGACY_FRAME_SECRET_BLOCK = `  const __palinkFrameSecret = (() => {
    try {
      var el = document.querySelector('meta[name="palink-frame-secret"]');
      if (!el) return '';
      var value = String(el.getAttribute('content') || '');
      if (el.parentNode) el.parentNode.removeChild(el);
      return value;
    } catch (e) { return ''; }
  })();`;

/**
 * 拼出 legacy shim 的 IIFE 体：密钥块 → 引导头 → 兼容段 → 度量段。
 * @param headerLines 定义 ctx / frameId 的那几行（内联=字面量，外部=读 boot 对象）
 */
export function buildLegacyShimBody(headerLines: string): string {
  return `(() => {
${LEGACY_FRAME_SECRET_BLOCK}
${headerLines}
${LEGACY_ST_SIM_SEGMENT}
${buildFrameMeasureSegment(SMART_CARD_IFRAME_IMAGE_INITIAL_LOAD_COUNT, SMART_CARD_IFRAME_IMAGE_QUEUE_DELAY_MS)}
})();`;
}

/**
 * 外部 legacy 脚本源码：从 `window.__palinkLegacyBoot__` 读引导数据。
 * 由 Vite 插件产出 `assets/palink-smart-card-legacy-<hash>.js`，跨卡/跨帧复用
 * HTTP 缓存与 V8 code cache。
 */
export function buildSmartCardLegacyExternalScript(): string {
  return buildLegacyShimBody([
    `  const __palinkLegacyBoot__ = (typeof window !== 'undefined' && window.__palinkLegacyBoot__) || {};`,
    `  const ctx = __palinkLegacyBoot__.ctx || {};`,
    `  const frameId = __palinkLegacyBoot__.frameId;`,
  ].join('\n'));
}
