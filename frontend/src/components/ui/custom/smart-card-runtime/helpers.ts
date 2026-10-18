// AUTO-GENERATED (P1-b 拆分后: 仅保留 buildShim + 重新导出各子模块)
// 源: src/components/ui/custom/CharacterCardRenderer.tsx
import type { CharacterSmartCardContext } from '@/types';
import { getCurrentInterfaceLanguage, safeJson } from './primitives';
import { SMART_CARD_CSP_NONCE } from './shared';
import { buildLegacyShimBody } from './frame-shim/legacy-shim-source';

export * from './primitives';
export * from './hashing';
export * from './storage';
export * from './html-detect';
export * from './viewport-theme';
export * from './script-norm';
export * from './html-extract';
export * from './resource';
export * from './adapter-css';
// [LEGACY-EXTERNAL 2026-10-18] 外部 legacy 脚本构造器对外暴露（Vite 插件与 identity 校验共用）。
export { buildSmartCardLegacyExternalScript } from './frame-shim/legacy-shim-source';

/** [LEGACY-EXTERNAL 2026-10-18] 外部化选项。 */
export interface BuildShimOptions {
  /**
   * legacy shim 的外部脚本 URL。给了就只输出「引导数据 + <script src>」，
   * 没给就回退全内联（独立测试环境 / 插件未加载时没有外部资产，必须保留这条路）。
   */
  externalLegacyUrl?: string;
}

function escapeScriptAttribute(value: string): string {
  return String(value || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function buildShim(
  context: CharacterSmartCardContext,
  frameId: string,
  options: BuildShimOptions = {},
): string {
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
    //
    // [P0-SRCDOC-SLIM 2026-10-18] characterExtensions 已**移出** srcdoc：
    // 实测它占单帧 355,892 字节（本 shim 一份 + compat v2 boot 一份 = 711,784，
    // 占单帧 893,342 的 79.6%），而对同一角色的所有卡片完全相同 ⇒ 纯冗余。
    // 数据仍经 context-update 全量到达（父侧 postLiveContext → Object.assign(ctx, …)），
    // 帧内唯一同步读取点 getContext().characters[0].data.extensions（part-b.ts:215）
    // 在函数体内惰性求值，首帧之后调用即拿到真值。
    globalRegexScripts: Array.isArray(context.globalRegexScripts) ? context.globalRegexScripts : [],
    stPluginRuntimeConfig: (context.stPluginRuntimeConfig && typeof context.stPluginRuntimeConfig === 'object')
      ? context.stPluginRuntimeConfig : null,
    depth: context.depth ?? 0,
    isInit: Boolean(context.isInit),
    trustedNative: Boolean(context.trustedNative),
    sourceFingerprint: context.sourceFingerprint || '',
    presentationMode: context.presentationMode || 'inline',
    viewport: context.viewport || null,
    // [S1-G7 2026-10-13] 会话绑定世界书名内联：帧内同步 API 首次调用即可取到真值。
    worldbookName: context.worldbookName || '',
  });
  const frameIdJson = safeJson(frameId);

  if (options.externalLegacyUrl) {
    // [LEGACY-EXTERNAL 2026-10-18] 外部化路径：内联引导数据（KB 级）+ 外部脚本。
    // ⚠️ 两个 <script> 必须保持文档顺序且都不加 async/defer：
    // 引导数据脚本先执行定义 window.__palinkLegacyBoot__，外部脚本随后读取它。
    return `
<script nonce="${SMART_CARD_CSP_NONCE}">
window.__palinkLegacyBoot__ = {
  ctx: ${contextJson},
  frameId: ${frameIdJson},
};
</script>
<script nonce="${SMART_CARD_CSP_NONCE}" src="${escapeScriptAttribute(options.externalLegacyUrl)}"></script>`;
  }

  // 回退路径：全内联（旧行为，供无外部资产环境使用）。
  return `
<script nonce="${SMART_CARD_CSP_NONCE}">
${buildLegacyShimBody([
    `  const ctx = ${contextJson};`,
    `  const frameId = ${frameIdJson};`,
  ].join('\n'))}
</script>`;
}
