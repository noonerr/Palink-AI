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
  const ctx = ${contextJson};
  const frameId = ${frameIdJson};
${LEGACY_ST_SIM_SEGMENT}
${buildFrameMeasureSegment(SMART_CARD_IFRAME_IMAGE_INITIAL_LOAD_COUNT, SMART_CARD_IFRAME_IMAGE_QUEUE_DELAY_MS)}
})();
</script>`;
}


