import type {
  CharacterSmartCardContext,
  SmartCardCompatDiagnostic,
  SmartCardRuntimeMode,
} from '@/types';
import { VARIABLES_COMPAT_SOURCE } from './variables-compat';
// [IDB-NS 甲] IndexedDB 按角色分库：注入 iframe 的纯 JS 源码串。
// ⚠️ 必须用相对路径：本文件会被 vite-plugins/smart-card-runtime-asset 直接 import，
// 而 vite.config / vitest.config 加载插件时 '@' 别名尚未生效 —— 写成 '@/lib/...' 会让
// 整个 vitest 在「加载配置」这一步就 ERR_MODULE_NOT_FOUND 崩掉（已实踩）。
import { IDB_NS_RUNTIME_SOURCE } from '../../../../lib/sillytavern/card-idb-namespace';
import { runtimeBodyPart01 } from './runtime-body/part-01';
import { RUNTIME_BODY_PART_02 } from './runtime-body/part-02';
import { RUNTIME_BODY_PART_03 } from './runtime-body/part-03';
import { RUNTIME_BODY_PART_04 } from './runtime-body/part-04';
import { RUNTIME_BODY_PART_05 } from './runtime-body/part-05';
import { RUNTIME_BODY_PART_06 } from './runtime-body/part-06';
import { RUNTIME_BODY_PART_07 } from './runtime-body/part-07';
import { RUNTIME_BODY_PART_08 } from './runtime-body/part-08';

const RUNTIME_VERSION = '2.0.0';

const KNOWN_TAVERN_GLOBALS = [
  'activateChatWorldbook',
  'callGenericPopup',
  'createOrReplaceCharWorldbook',
  'createOrReplaceWorldbook',
  'createWorldbook',
  'createWorldbookEntries',
  'deleteWorldbookEntries',
  'eventMakeLast',
  'eventOn',
  'getAllVariables',
  'getCharWorldbook',
  'getCharWorldbookNames',
  'getChatMessages',
  'getContext',
  'getCurrentMessageId',
  'getGroupChat',
  'getGroups',
  'getRequestHeaders',
  'getWorldbook',
  'getWorldbookEntries',
  'addOneMessage',
  'Generate',
  'generate',
  'generateRawData',
  'generateQuietPrompt',
  'generateRaw',
  'reloadCurrentChat',
  'rebindChatWorldbook',
  'saveChat',
  'saveChatConditional',
  'saveMetadata',
  'saveSettings',
  'saveSettingsDebounced',
  'sendMessageAsUser',
  'sendUserMessage',
  'setChatMessage',
  'setExtensionPrompt',
  'setWorldbookEntries',
  'select_group_chats',
  'substituteParams',
  'substituteParamsExtended',
  'substituteParamsLegacy',
  'registerMacro',
  'unregisterMacro',
  'updateMessageBlock',
  'waitGlobalInitialized',
  'generateGroupWrapper',
  'regenerateGroup',
];

const JS_KEYWORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'return',
  'switch',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeScriptAttribute(value: string): string {
  return String(value || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function collectDeclaredIdentifiers(source: string): Set<string> {
  const declared = new Set<string>();
  String(source || '').replace(
    /\b(?:function|class)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    (_match, fnName, varName) => {
      declared.add(fnName || varName);
      return '';
    },
  );
  return declared;
}

export function detectSillyTavernRuntimeRequirements(source: string): string[] {
  const text = String(source || '');
  const declared = collectDeclaredIdentifiers(text);
  const found = new Set<string>();

  KNOWN_TAVERN_GLOBALS.forEach((name) => {
    const pattern = new RegExp(`(?:^|[^.\\w$])${name}\\s*(?:\\(|[;=,\\n])`, 'm');
    if (pattern.test(text)) found.add(name);
  });

  text.replace(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g, (_match, name: string) => {
    if (!name || JS_KEYWORDS.has(name) || declared.has(name)) return '';
    if (/^[A-Z]/.test(name) || KNOWN_TAVERN_GLOBALS.includes(name)) found.add(name);
    return '';
  });

  ['SillyTavern', 'TavernHelper', 'Mvu', 'AutoCardUpdaterAPI', 'eventSource', 'toastr'].forEach((name) => {
    if (new RegExp(`\\b${name}\\b`).test(text)) found.add(name);
  });

  return Array.from(found).sort();
}

export interface SmartCardRuntimeV2Options {
  context: CharacterSmartCardContext;
  frameId: string;
  sourceHtml: string;
  mode: SmartCardRuntimeMode;
  nonce?: string;
  origin?: string;
  // [P1-SHIM-EXTERNAL] 提供外部运行时脚本 URL 时，shim 拆分为「内联引导脚本
  // （window.__palinkBoot__ 启动数据）+ <script src> 外部运行时」；缺省时回退为
  // 全内联（旧行为）。外部化让 ~400KB 运行时成为可缓存的静态资源，跨卡复用 V8 code cache。
  externalRuntimeUrl?: string;
}

function buildSmartCardCompatRuntimeBootPayload(options: SmartCardRuntimeV2Options): {
  contextJson: string;
  frameIdJson: string;
  modeJson: string;
  requiredApisJson: string;
  nonce: string;
  nonceAttr: string;
  origin: string;
} {
  const { context, frameId, sourceHtml, mode, nonce, origin } = options;
  const contextJson = safeJson({
    characterId: context.characterId || '',
    characterName: context.characterName || '',
    userName: context.userName || 'User',
    language: context.language || 'zh',
    // [S1-G7 2026-10-13] 会话绑定世界书名内联：帧内同步 API 首次调用即可取到真值。
    worldbookName: context.worldbookName || '',
    // [S1-G6 2026-10-13] IDB 分库止血开关：父侧读主框架 localStorage 后下发。
    // 帧内不能自己读 window.parent.localStorage —— 未信任卡帧里那是 legacy 安全代理。
    idbNamespaceDisabled: Boolean(context.idbNamespaceDisabled),
    messageId: context.messageId ?? null,
    messageIndex: context.messageIndex ?? null,
    messageContent: context.messageContent || '',
    chatMessages: Array.isArray(context.chatMessages) ? context.chatMessages : [],
    firstMes: context.firstMes || '',
    alternateGreetings: Array.isArray(context.alternateGreetings) ? context.alternateGreetings : [],
    characterExtensions: context.characterExtensions || {},
    presetData: context.presetData || null,
    globalRegexScripts: Array.isArray(context.globalRegexScripts) ? context.globalRegexScripts : [],
    stPluginRuntimeConfig: context.stPluginRuntimeConfig && typeof context.stPluginRuntimeConfig === 'object'
      ? context.stPluginRuntimeConfig
      : { plugins: [], extension_settings: {} },
    persistedStorage: context.persistedStorage && typeof context.persistedStorage === 'object'
      ? context.persistedStorage
      : { localStorage: {}, sessionStorage: {} },
    sessionId: context.sessionId || '',
    depth: context.depth ?? 0,
    isInit: Boolean(context.isInit),
    trustedNative: Boolean(context.trustedNative),
    sourceFingerprint: context.sourceFingerprint || '',
    presentationMode: context.presentationMode || 'inline',
    viewport: context.viewport || null,
    variables: (context.variables && typeof context.variables === 'object') ? context.variables : { stat_data: {} },
  });
  return {
    contextJson,
    frameIdJson: safeJson(frameId),
    modeJson: safeJson(mode),
    requiredApisJson: safeJson(detectSillyTavernRuntimeRequirements(sourceHtml)),
    nonce: nonce || '',
    nonceAttr: nonce ? ` nonce="${escapeScriptAttribute(nonce)}"` : '',
    origin: origin || (typeof window !== 'undefined' && window.location && window.location.origin) || 'http://localhost:3000',
  };
}

export function buildSillyTavernCompatRuntimeV2Shim(options: SmartCardRuntimeV2Options): string {
  const {
    contextJson,
    frameIdJson,
    modeJson,
    requiredApisJson,
    nonce,
    nonceAttr,
    origin,
  } = buildSmartCardCompatRuntimeBootPayload(options);
  // [IDB-NS 甲] 说明：分库后缀不在构建期注入，而是在 iframe 里由 ctx.characterId 现算
  // （见 buildSillyTavernCompatRuntimeBodyScript）—— 因为内联与外部脚本两条路径那边的
  // 作用域里都没有 context，只有 ctx 是两边都有的。
  const bootScript = `<script${nonceAttr}>
window.__palinkBoot__ = {
  runtimeVersion: ${safeJson(RUNTIME_VERSION)},
  origin: ${safeJson(origin)},
  ctx: ${contextJson},
  frameId: ${frameIdJson},
  runtimeMode: ${modeJson},
  requiredApis: ${requiredApisJson},
  nonce: ${safeJson(nonce)},
};
</script>`;
  if (options.externalRuntimeUrl) {
    // [P1-SHIM-EXTERNAL] 外部化路径：内联引导脚本（仅启动数据，KB 级）+ 外部运行时。
    return bootScript + `<script${nonceAttr} src="${escapeScriptAttribute(options.externalRuntimeUrl)}"></script>`;
  }
  // 回退路径：运行时整体内联（旧行为，供无外部资产环境使用）。
  const inlineHeader = [
    `  const runtimeVersion = ${safeJson(RUNTIME_VERSION)};`,
    `  const SMART_CARD_ORIGIN = ${safeJson(origin)};`,
    `  const ctx = ${contextJson};`,
    `  const frameId = ${frameIdJson};`,
    `  const runtimeMode = ${modeJson};`,
    `  const requiredApis = ${requiredApisJson};`,
    `  const runtimeScriptNonce = ${safeJson(nonce)};`,
  ].join('\n');
  return `<script${nonceAttr}>
${buildSillyTavernCompatRuntimeBodyScript(inlineHeader)}
</script>`;
}

/** [P1-SHIM-EXTERNAL] 外部运行时脚本源码：从 window.__palinkBoot__ 读取启动数据。 */
export function buildSmartCardCompatRuntimeExternalScript(): string {
  return buildSillyTavernCompatRuntimeBodyScript([
    `  const __palinkBoot__ = (typeof window !== 'undefined' && window.__palinkBoot__) || {};`,
    `  const runtimeVersion = __palinkBoot__.runtimeVersion;`,
    `  const SMART_CARD_ORIGIN = __palinkBoot__.origin || (typeof window !== 'undefined' && window.location && window.location.origin) || 'http://localhost:3000';`,
    `  const ctx = __palinkBoot__.ctx || {};`,
    `  const frameId = __palinkBoot__.frameId;`,
    `  const runtimeMode = __palinkBoot__.runtimeMode;`,
    `  const requiredApis = __palinkBoot__.requiredApis || [];`,
    `  const runtimeScriptNonce = __palinkBoot__.nonce || '';`,
  ].join('\n'));
}

function buildSillyTavernCompatRuntimeBodyScript(bootHeader: string): string {
  // [S4 2026-10-15] 运行时体按行机械拆成 runtime-body/part-01..08.ts，此处按行号升序拼接，
  // 拼接结果与原单一模板字符串逐字节一致（校验见 docs/_active/report/REPORT_s4-split_2026-10-15.md）。
  return (
    runtimeBodyPart01(bootHeader)
    + RUNTIME_BODY_PART_02
    + RUNTIME_BODY_PART_03
    + RUNTIME_BODY_PART_04
    + RUNTIME_BODY_PART_05
    + RUNTIME_BODY_PART_06
    + RUNTIME_BODY_PART_07
    + RUNTIME_BODY_PART_08
  );
}

export type { SmartCardCompatDiagnostic };
