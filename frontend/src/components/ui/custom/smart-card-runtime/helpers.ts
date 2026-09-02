// AUTO-GENERATED (P1-b 拆分后: 仅保留 buildShim + 重新导出各子模块)
// 源: src/components/ui/custom/CharacterCardRenderer.tsx
import type { CharacterSmartCardContext } from '@/types';
import { getCurrentInterfaceLanguage, safeJson } from './primitives';
import { SMART_CARD_CSP_NONCE, SMART_CARD_IFRAME_IMAGE_INITIAL_LOAD_COUNT, SMART_CARD_IFRAME_IMAGE_QUEUE_DELAY_MS } from './shared';
import { LEGACY_ST_SIM_SEGMENT } from './frame-shim/legacy-st-sim';
import { buildFrameMeasureSegment } from './frame-shim/frame-measure';


export * from './primitives';
export * from './hashing';
export * from './storage';
export * from './html-detect';
export * from './viewport-theme';
export * from './script-norm';
export * from './html-extract';
export * from './resource';
export * from './adapter-css';

export function buildShim(context: CharacterSmartCardContext, frameId: string): string {
  const contextJson = safeJson({
    characterId: context.characterId || '',
    characterName: context.characterName || '',
    name2: context.characterName || '',
    userName: context.userName || 'User',
    name1: context.userName || 'User',
    language: context.language || getCurrentInterfaceLanguage(),
    messageId: context.messageId ?? null,
    messageContent: context.messageContent || '',
    chatMessages: Array.isArray(context.chatMessages) ? context.chatMessages : [],
    persistedStorage: context.persistedStorage && typeof context.persistedStorage === 'object'
      ? context.persistedStorage
      : { localStorage: {}, sessionStorage: {} },
    firstMes: context.firstMes || '',
    alternateGreetings: Array.isArray(context.alternateGreetings) ? context.alternateGreetings : [],
    sessionId: context.sessionId || '',
    variables: (context.variables && typeof context.variables === 'object')
      ? context.variables : { stat_data: {} },
    // R-7 修复: 首帧上下文竞态——srcDoc 刻意排除 bootContextSignature（避免晚到的
    // characterExtensions 触发整页重建），导致加载期脚本读 characterExtensions/
    // globalRegexScripts/stPluginRuntimeConfig 拿到空值。这里把当前快照嵌入
    // contextJson，卡片脚本首帧即可用；晚到的更新仍经 context-update postMessage
    // 热更新（Object.assign(ctx, nextContext) 覆盖，行为不变，不重建文档）。
    characterExtensions: (context.characterExtensions && typeof context.characterExtensions === 'object')
      ? context.characterExtensions : {},
    globalRegexScripts: Array.isArray(context.globalRegexScripts) ? context.globalRegexScripts : [],
    stPluginRuntimeConfig: (context.stPluginRuntimeConfig && typeof context.stPluginRuntimeConfig === 'object')
      ? context.stPluginRuntimeConfig : null,
    depth: context.depth ?? 0,
    isInit: Boolean(context.isInit),
    trustedNative: Boolean(context.trustedNative),
    sourceFingerprint: context.sourceFingerprint || '',
    presentationMode: context.presentationMode || 'inline',
    viewport: context.viewport || null,
  });
  const frameIdJson = safeJson(frameId);

  return `
<script nonce="${SMART_CARD_CSP_NONCE}">
(() => {
  // [SEC-2026-09-02 F-1] 帧内密钥（gesture token）——只被本 IIFE 闭包持有。
  // 卡片脚本与本 IIFE 同处一个 realm，任何「写在源码里」或「经 postMessage 传输」的密钥
  // 都能被恶意卡片读到（读 script.textContent / 监听 message 事件）。唯一安全的投递方式：
  // 放在 <head> 里的 <meta> 上，由本段（注入位置在所有卡片内容之前）**读取后立即移除**，
  // 之后的卡片脚本既读不到 meta 也读不到本闭包变量。
  const __palinkFrameSecret = (() => {
    try {
      var el = document.querySelector('meta[name="palink-frame-secret"]');
      if (!el) return '';
      var value = String(el.getAttribute('content') || '');
      if (el.parentNode) el.parentNode.removeChild(el);
      return value;
    } catch (e) { return ''; }
  })();
  const ctx = ${contextJson};
  const frameId = ${frameIdJson};
${LEGACY_ST_SIM_SEGMENT}
${buildFrameMeasureSegment(SMART_CARD_IFRAME_IMAGE_INITIAL_LOAD_COUNT, SMART_CARD_IFRAME_IMAGE_QUEUE_DELAY_MS)}
})();
</script>`;
}


