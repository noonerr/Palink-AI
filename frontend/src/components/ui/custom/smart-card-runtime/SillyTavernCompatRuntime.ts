import type {
  CharacterSmartCardContext,
  SmartCardCompatDiagnostic,
  SmartCardRuntimeMode,
} from '@/types';
import { VARIABLES_COMPAT_SOURCE } from './variables-compat';

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
  return `(() => {
${bootHeader}
  const uiText = ctx.language === 'en'
    ? {
        requestTimeout: 'Palink smart card request timed out',
        requestFailed: 'Palink smart card request failed',
        compatTimeout: 'SillyTavern compatibility request timed out.',
        missingApi: 'The card called a Tavern API that Palink does not fully implement yet.',
        missingApiDetail: 'A safe fallback response was returned.',
        stubbedApi: 'A detected Tavern API was stubbed before the card used it.',
        unknownError: 'Unknown smart card error',
        unhandledRejection: 'Unhandled smart card promise rejection',
        pluginSettingsTitle: 'Third-party extension settings',
        pluginSettingsEmpty: 'No enabled SillyTavern extension settings were found.',
        pluginScriptsDisabled: 'Third-party extension scripts are disabled. Enable runtime.execute_scripts in plugin settings to run them in the sandbox.',
        nativeSettingsTitle: 'Extension UI',
        jsonSettingsTitle: 'Raw settings',
        ok: 'OK',
        cancel: 'Cancel',
        close: 'Close',
      }
    : {
        requestTimeout: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6',
        requestFailed: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u5931\u8d25',
        compatTimeout: 'SillyTavern \u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6\u3002',
        missingApi: '\u8fd9\u5f20\u89d2\u8272\u5361\u8c03\u7528\u4e86 Palink \u6682\u672a\u5b8c\u6574\u5b9e\u73b0\u7684 Tavern API\u3002',
        missingApiDetail: '\u5df2\u8fd4\u56de\u5b89\u5168\u7684\u517c\u5bb9\u7ed3\u679c\u3002',
        stubbedApi: '\u5df2\u5728\u89d2\u8272\u5361\u8c03\u7528\u524d\u4e3a\u68c0\u6d4b\u5230\u7684 Tavern API \u6ce8\u5165\u517c\u5bb9\u6869\u3002',
        unknownError: '\u672a\u77e5\u89d2\u8272\u5361\u9519\u8bef',
        unhandledRejection: '\u672a\u5904\u7406\u7684\u89d2\u8272\u5361 Promise \u5f02\u5e38',
        pluginSettingsTitle: '\u7b2c\u4e09\u65b9\u6269\u5c55\u8bbe\u7f6e',
        pluginSettingsEmpty: '\u672a\u627e\u5230\u5df2\u542f\u7528\u7684 SillyTavern \u6269\u5c55\u8bbe\u7f6e\u3002',
        pluginScriptsDisabled: '\u7b2c\u4e09\u65b9\u6269\u5c55\u811a\u672c\u672a\u542f\u7528\u3002\u5982\u9700\u5728\u6c99\u7bb1\u4e2d\u8fd0\u884c\uff0c\u8bf7\u5728\u63d2\u4ef6\u8bbe\u7f6e\u91cc\u5f00\u542f runtime.execute_scripts\u3002',
        nativeSettingsTitle: '\u6269\u5c55\u81ea\u5e26\u754c\u9762',
        jsonSettingsTitle: '\u539f\u59cb\u8bbe\u7f6e',
        ok: '\u786e\u5b9a',
        cancel: '\u53d6\u6d88',
        close: '\u5173\u95ed',
      };
  if (ctx.language !== 'en') {
    Object.assign(uiText, {
      requestTimeout: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6',
      requestFailed: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u5931\u8d25',
      compatTimeout: 'SillyTavern \u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6\u3002',
      missingApi: '\u8fd9\u5f20\u89d2\u8272\u5361\u8c03\u7528\u4e86 Palink \u6682\u672a\u5b8c\u6574\u5b9e\u73b0\u7684 Tavern API\u3002',
      missingApiDetail: '\u5df2\u8fd4\u56de\u5b89\u5168\u7684\u517c\u5bb9\u7ed3\u679c\u3002',
      stubbedApi: '\u5df2\u5728\u89d2\u8272\u5361\u8c03\u7528\u524d\u4e3a\u68c0\u6d4b\u5230\u7684 Tavern API \u6ce8\u5165\u517c\u5bb9\u6869\u3002',
      unknownError: '\u672a\u77e5\u89d2\u8272\u5361\u9519\u8bef',
      unhandledRejection: '\u672a\u5904\u7406\u7684\u89d2\u8272\u5361 Promise \u5f02\u5e38',
      pluginSettingsTitle: '\u7b2c\u4e09\u65b9\u6269\u5c55\u8bbe\u7f6e',
      pluginSettingsEmpty: '\u672a\u627e\u5230\u5df2\u542f\u7528\u7684 SillyTavern \u6269\u5c55\u8bbe\u7f6e\u3002',
      pluginScriptsDisabled: '\u7b2c\u4e09\u65b9\u6269\u5c55\u811a\u672c\u672a\u542f\u7528\u3002\u5982\u9700\u5728\u6c99\u7bb1\u4e2d\u8fd0\u884c\uff0c\u8bf7\u5728\u63d2\u4ef6\u8bbe\u7f6e\u91cc\u5f00\u542f runtime.execute_scripts\u3002',
      nativeSettingsTitle: '\u6269\u5c55\u81ea\u5e26\u754c\u9762',
      jsonSettingsTitle: '\u539f\u59cb\u8bbe\u7f6e',
      ok: '\u786e\u5b9a',
      cancel: '\u53d6\u6d88',
      close: '\u5173\u95ed',
    });
  }
  const diagnostics = [];
  const diagnosticKeys = new Set();
  let requestSeq = 0;
  const pendingRequests = new Map();
  const regexBackslashCompat = String.fromCharCode(92);
  const newlineCompat = String.fromCharCode(10);
  const userGestureWindowMs = 15000;
  let lastUserGestureAt = 0;

  const post = (payload) => {
    try {
      window.parent.postMessage({
        source: 'palink-smart-card',
        runtime: 'st-compat-v2',
        frameId,
        ...payload,
      }, '*');
    } catch {}
  };
  const markUserGesture = () => {
    lastUserGestureAt = Date.now();
  };
  const hasRecentUserGesture = () => Date.now() - lastUserGestureAt <= userGestureWindowMs;
  try {
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'].forEach((eventName) => {
      window.addEventListener(eventName, markUserGesture, { capture: true, passive: true });
      document.addEventListener(eventName, markUserGesture, { capture: true, passive: true });
    });
  } catch {}

  const summarizeArg = (value) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return value.length > 180 ? value.slice(0, 180) + '...' : value;
    if (type === 'number' || type === 'boolean') return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (type === 'function') return { type: 'function', name: value.name || '' };
    if (type === 'object') {
      try { return { type: 'object', keys: Object.keys(value).slice(0, 12) }; } catch {}
    }
    return { type };
  };
  const sanitizeUnknownApiArg = (value, depth = 0, seen = new WeakSet()) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return value.length > 12000 ? value.slice(0, 12000) : value;
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'function') return undefined;
    if (type !== 'object') return undefined;
    if (value?.nodeType || value === window || value === document) return undefined;
    if (seen.has(value)) return undefined;
    if (depth >= 4) return summarizeArg(value);
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 40).map((item) => sanitizeUnknownApiArg(item, depth + 1, seen));
    }
    const result = {};
    try {
      Object.keys(value).slice(0, 80).forEach((key) => {
        const next = sanitizeUnknownApiArg(value[key], depth + 1, seen);
        if (next !== undefined) result[key] = next;
      });
    } catch {
      return summarizeArg(value);
    }
    return result;
  };

  const reportDiagnostic = (diagnostic) => {
    const normalized = {
      severity: diagnostic.severity || 'warning',
      code: diagnostic.code || 'compat_notice',
      apiName: diagnostic.apiName || '',
      message: diagnostic.message || '',
      detail: diagnostic.detail || '',
      args: diagnostic.args || [],
      stack: diagnostic.stack || '',
      runtimeVersion,
      runtimeMode,
      timestamp: Date.now(),
    };
    const key = [normalized.code, normalized.apiName, normalized.message].join('|');
    if (diagnosticKeys.has(key)) return normalized;
    diagnosticKeys.add(key);
    diagnostics.push(normalized);
    post({ type: 'st:diagnostic', diagnostic: normalized });
    return normalized;
  };
  window.__palinkReportCompatDiagnostic = reportDiagnostic;
  const executeCompatInlineScriptCompat = (source, label = '') => {
    const script = document.createElement('script');
    if (runtimeScriptNonce) script.setAttribute('nonce', runtimeScriptNonce);
    if (label) script.setAttribute('data-palink-st-script', label);
    const sourceText = String(source || '');
    script.textContent = sourceText;
    try {
      (document.head || document.documentElement || document.body).appendChild(script);
    } catch (error) {
      reportDiagnostic({
        severity: 'error',
        code: 'inline_script_injection_failed',
        apiName: String(label || ''),
        message: String(error?.message || error || uiText.unknownError),
        detail: String(label || ''),
        stack: String(error?.stack || ''),
      });
      throw error;
    } finally {
      script.remove();
    }
    return true;
  };

  const requestParent = (action, payload = {}, options = {}) => new Promise((resolve) => {
    const requestId = frameId + ':v2:' + (++requestSeq);
    // 用户交互弹窗（callGenericPopup/callPopup）使用更长超时（60秒），其他请求默认 8 秒
    const timeoutMs = typeof options.timeout === 'number'
      ? options.timeout
      : (action === 'callGenericPopup' || action === 'callPopup' ? 60000 : 8000);
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reportDiagnostic({
        severity: 'warning',
        code: 'parent_request_timeout',
        apiName: action,
        message: uiText.compatTimeout,
      });
      resolve({ success: false, ok: false, error: uiText.requestTimeout });
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, timeout });
    post({
      type: 'request',
      requestId,
      action,
      payload: {
        ...(payload && typeof payload === 'object' ? payload : {}),
        __palinkUserGesture: hasRecentUserGesture(),
        __palinkRuntimeMode: runtimeMode,
        __palinkContext: {
          characterId: ctx.characterId,
          messageId: ctx.messageId,
          sessionId: ctx.sessionId,
        },
      },
    });
  });

  const clone = (value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  };
  const makeCompatStorage = (storageType, initialValues = {}) => {
    const values = new Map(Object.entries(initialValues || {}).map(([key, value]) => [String(key), String(value)]));
    const persist = (op, key, value) => {
      post({
        type: 'storage',
        storageType,
        op,
        key: key == null ? undefined : String(key),
        value: value == null ? undefined : String(value),
      });
    };
    return {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
      getItem(key) {
        key = String(key);
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        key = String(key);
        value = String(value);
        values.set(key, value);
        persist('set', key, value);
      },
      removeItem(key) {
        key = String(key);
        values.delete(key);
        persist('remove', key);
      },
      clear() {
        values.clear();
        persist('clear');
      },
    };
  };
  if (!ctx.trustedNative) {
    try {
      Object.defineProperty(window, 'localStorage', { value: makeCompatStorage('localStorage', ctx.persistedStorage?.localStorage), configurable: true });
      Object.defineProperty(window, 'sessionStorage', { value: makeCompatStorage('sessionStorage', ctx.persistedStorage?.sessionStorage), configurable: true });
    } catch {}
  }
  const persistedLocalStore = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_local_variables || '{}'); } catch { return {}; }
  })();
  const persistedGlobalStore = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_global_variables || '{}'); } catch { return {}; }
  })();
  const persistedChatStore = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_chat_variables || '{}'); } catch { return {}; }
  })();
  const persistedMetadata = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_chat_metadata || '{}'); } catch { return {}; }
  })();
  const persistedExtensionPrompts = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_extension_prompts || '{}'); } catch { return {}; }
  })();
  const persistedExtensionFields = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_extension_fields || '{}'); } catch { return {}; }
  })();
  const persistedExtensionSettings = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_extension_settings || '{}'); } catch { return {}; }
  })();
  const localVariableStore = persistedLocalStore && typeof persistedLocalStore === 'object' ? persistedLocalStore : {};
  const globalVariableStore = persistedGlobalStore && typeof persistedGlobalStore === 'object' ? persistedGlobalStore : {};
  // [SINGLE-SOURCE] chat 变量 store 的深度合并工具：初始化与 context-update 热更新共用，
  // 保证后端下发的 variables（含 stat_data）始终 merge 进唯一真源 chatVariableStore。
  const deepMergeVariablesCompat = (target, source) => {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = deepMergeVariablesCompat(typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  };
  // 合并后端下发的会话级 variables（含 stat_data）进 chat store，
  // 使 iframe 内 getAllVariables() 能返回真实数据，驱动状态栏/角色卡动态内容（照片/服饰/内心想法）填充。
  const ctxVariables = (typeof ctx.variables === 'object' && ctx.variables && Object.keys(ctx.variables).length > 0) ? ctx.variables : null;
  const chatVariableStore = (() => {
    const base = (persistedChatStore && typeof persistedChatStore === 'object') ? JSON.parse(JSON.stringify(persistedChatStore)) : {};
    if (!ctxVariables) return base;
    return deepMergeVariablesCompat(base, ctxVariables);
  })();
  // [VAR-DBG] 启动注入变量调试（排查"插件角色面板不能显示变量"）
  try { console.warn('[VAR-DBG] boot ctx.variables keys=' + JSON.stringify(ctxVariables ? Object.keys(ctxVariables) : [])); } catch (_vdbgA) {}
  try { var _sdBoot = chatVariableStore && chatVariableStore.stat_data; console.warn('[VAR-DBG] boot chatVariableStore.stat_data keys=' + JSON.stringify(_sdBoot && typeof _sdBoot === 'object' ? Object.keys(_sdBoot) : [])); } catch (_vdbgB) {}
  // [PANEL-DBG] 延迟检查面板 DOM 是否真在卡 iframe 文档里（排查"面板脚本与面板 HTML 错位"）
  try {
    setTimeout(function () {
      try {
        var _ids = ['charAvatar', 'charListContainer', 'worldDate', 'navPrev', 'affectionBar'];
        var _res = [];
        for (var _i = 0; _i < _ids.length; _i++) {
          _res.push(_ids[_i] + '=' + (document.getElementById(_ids[_i]) ? 'yes' : 'NO'));
        }
        console.warn('[PANEL-DBG] panel DOM check: ' + _res.join(' '));
      } catch (_pd) {}
    }, 1500);
  } catch (_pd2) {}
  // [SINGLE-SOURCE] extension prompts/fields 与 V4 变量同构：不再维护独立副本，
  // 统一存于 chatVariableStore.__extension_prompts / __extension_fields（随会话变量
  // 由 persistVariableStores 持久化到父页面 __palink_chat_variables）。旧独立持久化
  // key（__palink_extension_prompts / __palink_extension_fields）仅做一次性迁移合并，
  // 之后不再读写；读取一律走下方 helper，保证 set/get/context 读到同一份数据。
  if (persistedExtensionPrompts && typeof persistedExtensionPrompts === 'object') {
    const legacyPrompts = chatVariableStore.__extension_prompts;
    chatVariableStore.__extension_prompts = Object.assign(
      legacyPrompts && typeof legacyPrompts === 'object' ? legacyPrompts : {},
      persistedExtensionPrompts,
    );
  }
  if (persistedExtensionFields && typeof persistedExtensionFields === 'object') {
    const legacyFields = chatVariableStore.__extension_fields;
    chatVariableStore.__extension_fields = Object.assign(
      legacyFields && typeof legacyFields === 'object' ? legacyFields : {},
      persistedExtensionFields,
    );
  }
  const getExtensionPromptStoreCompat = () => {
    const store = chatVariableStore.__extension_prompts;
    return store && typeof store === 'object' ? store : {};
  };
  const getExtensionFieldStoreCompat = () => {
    const store = chatVariableStore.__extension_fields;
    return store && typeof store === 'object' ? store : {};
  };
  const extensionSettingsStore = persistedExtensionSettings && typeof persistedExtensionSettings === 'object' ? persistedExtensionSettings : {};
  const stPluginRuntimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
    ? ctx.stPluginRuntimeConfig
    : { plugins: [], extension_settings: {} };
  const stPluginExtensionSettings = stPluginRuntimeConfig.extension_settings && typeof stPluginRuntimeConfig.extension_settings === 'object'
    ? stPluginRuntimeConfig.extension_settings
    : {};
  const mergePlainObjectCompat = (target, source) => {
    if (!source || typeof source !== 'object') return target;
    Object.entries(source).forEach(([key, value]) => {
      if (!key) return;
      if (
        value && typeof value === 'object' && !Array.isArray(value)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      ) {
        target[key] = { ...target[key], ...value };
      } else {
        target[key] = clone(value);
      }
    });
    return target;
  };
  const getStPluginExtensionSettingsCompat = () => {
    const runtimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
      ? ctx.stPluginRuntimeConfig
      : {};
    return runtimeConfig.extension_settings && typeof runtimeConfig.extension_settings === 'object'
      ? runtimeConfig.extension_settings
      : {};
  };
  const applyStPluginRuntimeConfigCompat = () => {
    if (!window.extension_settings || typeof window.extension_settings !== 'object') window.extension_settings = {};
    mergePlainObjectCompat(window.extension_settings, getStPluginExtensionSettingsCompat());
    const runtimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
      ? ctx.stPluginRuntimeConfig
      : {};
    window.extension_settings.palink_plugin_runtime = {
      plugins: Array.isArray(runtimeConfig.plugins) ? clone(runtimeConfig.plugins) : [],
      generated_at: runtimeConfig.generated_at || '',
    };
  };
  const getStPluginRuntimePluginsCompat = () => {
    const runtimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
      ? ctx.stPluginRuntimeConfig
      : {};
    const configuredPlugins = Array.isArray(runtimeConfig.plugins) ? runtimeConfig.plugins : [];
    const livePlugins = Array.isArray(window.extension_settings?.palink_plugin_runtime?.plugins)
      ? window.extension_settings.palink_plugin_runtime.plugins
      : [];
    if (!livePlugins.length) return configuredPlugins;
    const merged = new Map();
    [...configuredPlugins, ...livePlugins].forEach((plugin) => {
      if (!plugin || typeof plugin !== 'object') return;
      const key = String(plugin.id || plugin.name || JSON.stringify(plugin)).toLowerCase();
      if (!merged.has(key)) merged.set(key, plugin);
    });
    return Array.from(merged.values());
  };
  const getStPluginRuntimeNamespaceCompat = (plugin) => {
    const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
    return String(
      plugin?.runtime?.namespace
      || plugin?.namespace
      || plugin?.extension_name
      || manifest.id
      || manifest.name
      || plugin?.name
      || plugin?.id
      || ''
    ).trim();
  };
  const getStPluginRuntimeAliasesCompat = (plugin) => {
    const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
    return [
      plugin?.id,
      plugin?.name,
      plugin?.namespace,
      plugin?.extension_name,
      plugin?.runtime?.namespace,
      manifest.id,
      manifest.name,
      manifest.display_name,
    ].filter(Boolean).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  };
  const findStPluginRuntimeByNamespaceCompat = (namespace = '') => {
    const needle = String(namespace || '').trim().toLowerCase();
    if (!needle) return null;
    return getStPluginRuntimePluginsCompat().find((plugin) => (
      getStPluginRuntimeAliasesCompat(plugin).includes(needle)
      || String(getStPluginRuntimeNamespaceCompat(plugin)).trim().toLowerCase() === needle
    )) || null;
  };
  const sortStPluginRuntimePluginsCompat = (plugins) => [...plugins].sort((left, right) => {
    const leftManifest = left?.manifest && typeof left.manifest === 'object' ? left.manifest : {};
    const rightManifest = right?.manifest && typeof right.manifest === 'object' ? right.manifest : {};
    const leftOrder = Number(leftManifest.loading_order ?? left?.runtime?.loading_order ?? 100);
    const rightOrder = Number(rightManifest.loading_order ?? right?.runtime?.loading_order ?? 100);
    return (Number.isFinite(leftOrder) ? leftOrder : 100) - (Number.isFinite(rightOrder) ? rightOrder : 100);
  });
  const stPluginAssetUrlCompat = (pluginId, assetPath) => {
    const parts = String(assetPath || '').split('/').filter(Boolean).map((part) => encodeURIComponent(part));
    return '/api/plugins/' + encodeURIComponent(String(pluginId || '')) + '/asset/' + parts.join('/');
  };
  const normalizeStPluginPathCompat = (value) => {
    const input = String(value || '').replace(/\\\\/g, '/').split('?')[0].split('#')[0];
    const parts = [];
    input.split('/').forEach((part) => {
      if (!part || part === '.') return;
      if (part === '..') parts.pop();
      else parts.push(part);
    });
    return parts.join('/');
  };
  // [P0-SRCDOC-SLIM] 插件脚本包：js/modules 源码由父页面经 plugin-scripts-push 单次推送，
  // 不再随 srcDoc / context-update 内联 ~4.4MB 源码反复传输与解析（滑动卡顿主因）。
  // context 内插件仍保留元信息（path/execute/missing 等），content 统一从本包查询。
  const stPluginScriptsBundleCompat = { generated_at: '', scripts: [] };
  const stPluginScriptIndexCompat = new Map();
  const indexStPluginScriptsCompat = () => {
    stPluginScriptIndexCompat.clear();
    (Array.isArray(stPluginScriptsBundleCompat.scripts) ? stPluginScriptsBundleCompat.scripts : []).forEach((script) => {
      if (!script || typeof script !== 'object') return;
      const pluginId = String(script.pluginId || '');
      const path = normalizeStPluginPathCompat(script.zip_path || script.path || '');
      if (!pluginId || !path) return;
      stPluginScriptIndexCompat.set(pluginId + '::' + path, script);
    });
  };
  const getStPluginScriptContentCompat = (plugin, resource) => {
    if (resource && typeof resource.content === 'string') return resource.content;
    if (!plugin || !resource) return null;
    const pluginId = String(plugin.id || plugin.name || '');
    const path = normalizeStPluginPathCompat(resource.zip_path || resource.path || '');
    if (!pluginId || !path) return null;
    const script = stPluginScriptIndexCompat.get(pluginId + '::' + path);
    return script && typeof script.content === 'string' ? script.content : null;
  };
  // [P1-SRCDOC-SLIM] 清单化内容拉取：postMessage 推送的 bundle 只含元数据 + source URL，
  // 这里按需向父页面批量请求缺失源码（父侧走内存/HTTP 缓存），填入 bundle 条目后执行。
  // 幂等：已含 content 的条目跳过；in-flight 守卫避免并发重复请求。
  let stPluginScriptsHydratingCompat = false;
  const hydrateStPluginScriptsCompat = async () => {
    const scripts = Array.isArray(stPluginScriptsBundleCompat.scripts) ? stPluginScriptsBundleCompat.scripts : [];
    const missing = scripts.filter((script) => script && typeof script.content !== 'string');
    if (missing.length === 0) return;
    if (stPluginScriptsHydratingCompat) return;
    stPluginScriptsHydratingCompat = true;
    const hydrationVersion = String(stPluginScriptsBundleCompat.generated_at || '');
    try {
      const wanted = missing.map((script) => ({
        pluginId: String(script.pluginId || ''),
        path: normalizeStPluginPathCompat(script.zip_path || script.path || ''),
      })).filter((item) => item.pluginId && item.path);
      if (wanted.length === 0) return;
      const response = await requestParent('getPluginScriptContents', { scripts: wanted }, { timeout: 30000 });
      // 父页面应答经 pending.resolve 展平：{ ok: true, ...result }，内容键位于顶层。
      const contents = (response && typeof response === 'object' && response.ok !== false) ? response : {};
      missing.forEach((script) => {
        if (!script) return;
        const key = String(script.pluginId || '') + '::' + normalizeStPluginPathCompat(script.zip_path || script.path || '');
        const value = contents[key];
        if (typeof value === 'string') script.content = value;
      });
    } catch {
      // 父页面未响应/异常：内容保持缺失，插件脚本在后续 push/context 更新时重试。
    } finally {
      stPluginScriptsHydratingCompat = false;
    }
    // 内容就绪后补执行（按 scriptKey 幂等）。
    try {
      if (getStPluginRuntimePluginsCompat().length > 0) executeStPluginScriptsCompat();
    } catch {}
    try { injectStPluginCssCompat(); } catch {}
    // 自愈：拉取期间若 bundle 版本被更新（新清单），in-flight 守卫曾跳过其拉取，
    // 此处重新触发，确保新清单的内容也被填充。
    if (hydrationVersion !== String(stPluginScriptsBundleCompat.generated_at || '')) {
      void hydrateStPluginScriptsCompat();
    }
  };
  const dirnameStPluginPathCompat = (value) => {
    const path = normalizeStPluginPathCompat(value);
    const index = path.lastIndexOf('/');
    return index >= 0 ? path.slice(0, index) : '';
  };
  const stPluginAssetPathCandidatesCompat = (assetPath, basePath = '') => {
    const raw = String(assetPath || '').trim();
    if (!raw || /^(?:data:|blob:|https?:|\\/|#)/i.test(raw)) return [];
    const candidates = [];
    if (basePath) {
      const base = dirnameStPluginPathCompat(basePath);
      candidates.push(normalizeStPluginPathCompat((base ? base + '/' : '') + raw));
    }
    candidates.push(normalizeStPluginPathCompat(raw));
    return Array.from(new Set(candidates.filter(Boolean)));
  };
  const resolveStPluginAssetPathCompat = (plugin, assetPath, basePath = '') => {
    const candidates = stPluginAssetPathCandidatesCompat(assetPath, basePath);
    if (!candidates.length) return normalizeStPluginPathCompat(assetPath);
    const assets = Array.isArray(plugin?.resources?.assets)
      ? plugin.resources.assets
      : Object.keys(plugin?.resources?.assets || {}).map((path) => ({ path }));
    const assetPaths = new Set(assets.map((asset) => normalizeStPluginPathCompat(asset?.path || asset)).filter(Boolean));
    return candidates.find((candidate) => assetPaths.has(candidate)) || candidates[0];
  };
  const resolveStPluginModulePathCompat = (modulePath, basePath = '') => {
    const raw = String(modulePath || '').trim();
    if (!raw) return '';
    if (/^(?:https?:|data:|blob:|\\/)/i.test(raw)) return normalizeStPluginPathCompat(raw);
    if (raw.startsWith('.')) {
      const base = dirnameStPluginPathCompat(basePath);
      return normalizeStPluginPathCompat((base ? base + '/' : '') + raw);
    }
    return normalizeStPluginPathCompat(raw);
  };
  const stPluginResourcePathCandidatesCompat = (resource) => {
    const base = [resource?.zip_path, resource?.path]
      .filter(Boolean)
      .map((item) => normalizeStPluginPathCompat(item));
    return Array.from(new Set(base));
  };
  const stPluginModulePathCandidatesCompat = (modulePath, basePath = '') => {
    const resolved = resolveStPluginModulePathCompat(modulePath, basePath);
    if (!resolved) return [];
    const candidates = [resolved];
    if (!/\\.(?:mjs|js)$/i.test(resolved)) {
      candidates.push(resolved + '.js', resolved + '.mjs', resolved + '/index.js', resolved + '/index.mjs');
    }
    return Array.from(new Set(candidates.map((item) => normalizeStPluginPathCompat(item))));
  };
  const findStPluginRuntimePluginCompat = (pluginId) => {
    const plugins = getStPluginRuntimePluginsCompat();
    const needle = String(pluginId || '').toLowerCase();
    return plugins.find((plugin) => {
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      return [plugin?.id, plugin?.name, manifest.id, manifest.name, manifest.display_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === needle);
    }) || null;
  };
  const findStPluginModuleResourceCompat = (pluginId, modulePath, basePath = '') => {
    const plugin = findStPluginRuntimePluginCompat(pluginId);
    if (!plugin) return null;
    const wanted = stPluginModulePathCandidatesCompat(modulePath, basePath);
    if (!wanted.length) return null;
    const resources = [
      ...(Array.isArray(plugin?.resources?.js) ? plugin.resources.js : []),
      ...(Array.isArray(plugin?.resources?.modules) ? plugin.resources.modules : []),
    ];
    const found = resources.find((resource) => {
      if (!resource || resource.missing || getStPluginScriptContentCompat(plugin, resource) == null) return false;
      return stPluginResourcePathCandidatesCompat(resource).some((candidate) => wanted.includes(candidate));
    });
    return found ? { plugin, resource: found } : null;
  };
  const stLocalModuleCacheCompat = new Map();
  const rewriteStPluginCssUrlsCompat = (css, plugin, basePath = '') => String(css || '').replace(/url\\(\\s*(['"]?)([^)'"]+)\\1\\s*\\)/gi, (match, quote, url) => {
    const value = String(url || '').trim();
    if (!value || /^(?:data:|blob:|https?:|\\/|#)/i.test(value)) return match;
    return 'url("' + stPluginAssetUrlCompat(plugin?.id, resolveStPluginAssetPathCompat(plugin, value, basePath)) + '")';
  });
  const escapeHtmlCompat = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
  const getByPathCompat = (source, path, fallback = '') => {
    const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
    let value = source;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return fallback;
      value = value[part];
    }
    return value == null ? fallback : value;
  };
  const compileSimpleTemplateCompat = (template, data = {}) => {
    const payload = data && typeof data === 'object' ? data : {};
    return String(template || '')
      .replace(/\\{\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}\\}/g, (_match, key) => String(getByPathCompat(payload, key, '')))
      .replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (_match, key) => escapeHtmlCompat(getByPathCompat(payload, key, '')));
  };
  const normalizeTemplateNameCompat = (value) => String(value || '')
    .replace(/\\\\/g, '/')
    .replace(/\\.(?:html|hbs|handlebars|mustache)$/i, '')
    .split('/')
    .filter(Boolean)
    .join('/')
    .toLowerCase();
  const findStPluginTemplateCompat = (extensionName = '', templateName = '') => {
    const wantedExtension = String(extensionName || '').trim().toLowerCase();
    const wantedTemplate = normalizeTemplateNameCompat(templateName || extensionName || 'template');
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat());
    for (const plugin of plugins) {
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const aliases = [plugin?.id, plugin?.name, manifest.id, manifest.name, manifest.display_name]
        .filter(Boolean)
        .map((item) => String(item).toLowerCase());
      if (wantedExtension && !aliases.includes(wantedExtension)) continue;
      const templates = Array.isArray(plugin?.resources?.templates) ? plugin.resources.templates : [];
      const found = templates.find((resource) => {
        if (!resource || resource.missing || typeof resource.content !== 'string') return false;
        const normalizedPath = normalizeTemplateNameCompat(resource.path || '');
        return normalizedPath === wantedTemplate
          || normalizedPath.endsWith('/' + wantedTemplate)
          || normalizedPath.endsWith('/templates/' + wantedTemplate)
          || normalizedPath.endsWith('/template/' + wantedTemplate);
      });
      if (found) return { plugin, resource: found };
    }
    return null;
  };
  const injectStPluginCssCompat = () => {
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat());
    plugins.forEach((plugin) => {
      const cssResources = Array.isArray(plugin?.resources?.css) ? plugin.resources.css : [];
      cssResources.forEach((resource, index) => {
        if (!resource || resource.missing || typeof resource.content !== 'string' || !resource.content.trim()) return;
        const styleId = 'palink-st-plugin-css-' + String(plugin.id || plugin.name || index).replace(/[^a-z0-9_-]/gi, '-') + '-' + index;
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.setAttribute('data-palink-st-plugin', String(plugin.name || plugin.id || ''));
        style.textContent = rewriteStPluginCssUrlsCompat(resource.content, plugin, resource.zip_path || resource.path || '');
        (document.head || document.documentElement).appendChild(style);
      });
    });
  };
  const delayCompat = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
  const debounceCompat = (fn, wait = 0) => {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn?.(...args), Number(wait) || 0);
    };
  };
  const throttleCompat = (fn, wait = 0) => {
    let last = 0;
    let timer = 0;
    return (...args) => {
      const now = Date.now();
      const remaining = Number(wait || 0) - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = 0;
        last = now;
        fn?.(...args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = 0;
          fn?.(...args);
        }, remaining);
      }
    };
  };
  const waitUntilConditionCompat = async (condition, timeout = 5000, interval = 50) => {
    const started = Date.now();
    while (Date.now() - started < Number(timeout || 0)) {
      if (await condition?.()) return true;
      await delayCompat(interval);
    }
    return false;
  };
  const regexSpecialCharsCompat = '.*+?^' + '$' + '{}()|[]' + regexBackslashCompat;
  const escapeRegexCompat = (value) => String(value ?? '').replace(/./g, (char) => (
    regexSpecialCharsCompat.includes(char) ? regexBackslashCompat + char : char
  ));
  const getFileTextCompat = async (file) => {
    if (typeof file === 'string') return file;
    if (file?.text && typeof file.text === 'function') return file.text();
    return String(file ?? '');
  };
  const parseJsonFileCompat = async (file) => JSON.parse(await getFileTextCompat(file));
  const downloadCompat = (content, fileName = 'download.txt', mimeType = 'text/plain') => {
    const blob = content instanceof Blob ? content : new Blob([String(content ?? '')], { type: String(mimeType || 'text/plain') });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(fileName || 'download.txt');
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      anchor.remove();
    }, 0);
    return true;
  };
  const saveJsonToFileCompat = (data, fileName = 'data.json') => (
    downloadCompat(JSON.stringify(data ?? {}, null, 2), fileName, 'application/json')
  );
  const humanizedDateTimeCompat = (value = Date.now()) => {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  };
  const timestampToMomentCompat = (value = Date.now()) => {
    const date = new Date(value || Date.now());
    return {
      value,
      date,
      format: () => (Number.isNaN(date.getTime()) ? '' : date.toLocaleString()),
      isValid: () => !Number.isNaN(date.getTime()),
      toDate: () => date,
      valueOf: () => date.getTime(),
      toString: () => (Number.isNaN(date.getTime()) ? '' : date.toString()),
    };
  };
  const lodashCompat = window._ && typeof window._ === 'object' ? window._ : {
    get: getByPathCompat,
    set: (object, path, value) => setByPath(object || {}, Array.isArray(path) ? path.join('.') : path, value),
    has: (object, path) => getByPathCompat(object || {}, Array.isArray(path) ? path.join('.') : path, undefined) !== undefined,
    cloneDeep: clone,
    debounce: debounceCompat,
    throttle: throttleCompat,
    range: (start, end, step = 1) => {
      const from = end === undefined ? 0 : Number(start || 0);
      const to = end === undefined ? Number(start || 0) : Number(end || 0);
      const delta = Number(step || 1);
      const result = [];
      if (!delta) return result;
      for (let value = from; delta > 0 ? value < to : value > to; value += delta) result.push(value);
      return result;
    },
    isEqual: (left, right) => {
      try { return JSON.stringify(left) === JSON.stringify(right); } catch { return left === right; }
    },
    isObject: (value) => Boolean(value && typeof value === 'object'),
    isString: (value) => typeof value === 'string',
    isNumber: (value) => typeof value === 'number' && Number.isFinite(value),
    isArray: Array.isArray,
    merge: (target = {}, ...sources) => {
      sources.forEach((source) => mergePlainObjectCompat(target, source));
      return target;
    },
    uniq: (array = []) => Array.from(new Set(Array.isArray(array) ? array : [])),
    escape: escapeHtmlCompat,
  };
  window._ = lodashCompat;
  const domPurifyCompat = window.DOMPurify || { sanitize: (value) => String(value ?? '') };
  window.DOMPurify = domPurifyCompat;
  const handlebarsCompat = window.Handlebars || {
    compile: (template) => (data = {}) => compileSimpleTemplateCompat(template, data),
    registerHelper: () => true,
    registerPartial: () => true,
    SafeString: function SafeStringCompat(value) { this.string = String(value ?? ''); this.toString = () => this.string; },
    escapeExpression: escapeHtmlCompat,
  };
  window.Handlebars = handlebarsCompat;
  const momentCompat = window.moment || window.dayjs || ((value) => timestampToMomentCompat(value || Date.now()));
  window.moment = window.moment || momentCompat;
  window.dayjs = window.dayjs || momentCompat;
  const accountStorageCompat = {
    getState: () => {
      const state = {};
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key) state[key] = window.localStorage.getItem(key);
      }
      return state;
    },
    init: (values = {}) => {
      if (values && typeof values === 'object') {
        Object.entries(values).forEach(([key, value]) => window.localStorage.setItem(key, value));
      }
      return true;
    },
    getItem: (...args) => window.localStorage.getItem(...args),
    setItem: (...args) => window.localStorage.setItem(...args),
    removeItem: (...args) => window.localStorage.removeItem(...args),
    clear: (...args) => window.localStorage.clear(...args),
    key: (...args) => window.localStorage.key(...args),
    get length() { return window.localStorage.length; },
  };
  const localforageCompat = {
    getItem: async (key) => window.localStorage.getItem(key),
    setItem: async (key, value) => {
      window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      return value;
    },
    removeItem: async (key) => window.localStorage.removeItem(key),
    clear: async () => window.localStorage.clear(),
    keys: async () => Array.from({ length: window.localStorage.length }, (_item, index) => window.localStorage.key(index)).filter(Boolean),
    createInstance: () => localforageCompat,
    config: () => true,
    ready: async () => localforageCompat,
  };
  window.accountStorage = window.accountStorage || accountStorageCompat;
  window.localforage = window.localforage || localforageCompat;
  const stUtilsCompat = {
    delay: delayCompat,
    sleep: delayCompat,
    debounce: debounceCompat,
    throttle: throttleCompat,
    waitUntilCondition: waitUntilConditionCompat,
    uuidv4: () => window.uuidv4?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      const value = char === 'x' ? random : (random & 0x3 | 0x8);
      return value.toString(16);
    }),
    escapeRegex: escapeRegexCompat,
    escapeRegExp: escapeRegexCompat,
    humanizedDateTime: humanizedDateTimeCompat,
    timestampToMoment: timestampToMomentCompat,
    download: downloadCompat,
    saveJsonToFile: saveJsonToFileCompat,
    parseJsonFile: parseJsonFileCompat,
    getFileText: getFileTextCompat,
    isObject: (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    isValidUrl: (value) => {
      try { new URL(String(value)); return true; } catch { return false; }
    },
    splitRecursive: (value, separator = '\\n') => String(value ?? '').split(separator),
    sortByCssOrder: (nodes) => Array.from(nodes || []),
    resetScrollHeight: (element) => {
      if (element?.style) element.style.height = 'auto';
      return element;
    },
  };
  const evaluateStLocalPluginModuleCompat = (plugin, resource) => {
    const resourceContent = getStPluginScriptContentCompat(plugin, resource);
    if (!plugin || !resource || resourceContent == null) return null;
    const modulePath = normalizeStPluginPathCompat(resource.zip_path || resource.path || '');
    const cacheKey = String(plugin.id || plugin.name || 'plugin') + ':' + modulePath;
    if (stLocalModuleCacheCompat.has(cacheKey)) return stLocalModuleCacheCompat.get(cacheKey);
    const exportsObject = {};
    const moduleObject = { exports: exportsObject };
    stLocalModuleCacheCompat.set(cacheKey, exportsObject);
    try {
      const source = normalizeStPluginScriptSourceCompat(resourceContent, {
        pluginId: plugin.id || plugin.name || '',
        resourcePath: modulePath,
        moduleMode: true,
      });
      const holderKey = '__palinkStModuleHolder_' + String(cacheKey).replace(/[^a-z0-9_$]/gi, '_') + '_' + Date.now();
      window[holderKey] = { exports: exportsObject, module: moduleObject, ok: false, error: '' };
      const holderJson = JSON.stringify(holderKey);
      const wrappedSource = ''
        + 'try {' + newlineCompat
        + '(function(window,document,SillyTavern,getContext,extension_settings,TavernHelper,eventSource,exports,module){' + newlineCompat
        + source
        + newlineCompat + '})(window,document,window.SillyTavern,window.getContext,window.extension_settings,window.TavernHelper,window.eventSource,window[' + holderJson + '].exports,window[' + holderJson + '].module);' + newlineCompat
        + 'window[' + holderJson + '].ok = true;' + newlineCompat
        + '} catch (error) { window[' + holderJson + '].error = String(error && error.message || error); }'
        + newlineCompat + '//# sourceURL=palink-st-module-' + String(plugin.id || plugin.name || 'plugin').replace(/[^a-z0-9_-]/gi, '-') + '-' + modulePath.replace(/[^a-z0-9_-]/gi, '-') + '.js';
      executeCompatInlineScriptCompat(wrappedSource, 'module:' + cacheKey);
      const holder = window[holderKey] || {};
      try { delete window[holderKey]; } catch {}
      if (holder.error) throw new Error(holder.error);
      if (!holder.ok) throw new Error('Module script did not execute');
      const finalExports = moduleObject.exports && typeof moduleObject.exports === 'object' ? moduleObject.exports : exportsObject;
      stLocalModuleCacheCompat.set(cacheKey, finalExports);
      return finalExports;
    } catch (error) {
      reportDiagnostic({
        severity: 'warning',
        code: 'st_plugin_module_failed',
        apiName: String(plugin.name || plugin.id || ''),
        message: String(error?.message || error || uiText.unknownError),
        detail: modulePath,
        stack: String(error?.stack || ''),
      });
      stLocalModuleCacheCompat.set(cacheKey, exportsObject);
      return exportsObject;
    }
  };
  const resolveStLocalPluginModuleCompat = (modulePath, importedName = '', pluginId = '', basePath = '') => {
    const found = findStPluginModuleResourceCompat(pluginId, modulePath, basePath);
    if (!found) return undefined;
    const exportsObject = evaluateStLocalPluginModuleCompat(found.plugin, found.resource) || {};
    const name = String(importedName || '').trim();
    if (!name || name === '*') return exportsObject;
    if (Object.prototype.hasOwnProperty.call(exportsObject, name)) return exportsObject[name];
    if (name === 'default' && Object.prototype.hasOwnProperty.call(exportsObject, 'default')) return exportsObject.default;
    return undefined;
  };
  const stModuleValueCompat = (modulePath, importedName, pluginId = '', basePath = '') => {
    const localModuleValue = resolveStLocalPluginModuleCompat(modulePath, importedName, pluginId, basePath);
    if (localModuleValue !== undefined) return localModuleValue;
    const path = String(modulePath || '').toLowerCase();
    const name = String(importedName || '').trim();
    const ctxNow = () => (typeof window.getContext === 'function' ? window.getContext() : {});
    const settingsModuleCompat = {
      extension_settings: () => window.extension_settings,
      getContext: () => window.getContext,
      saveSettingsDebounced: () => window.saveSettingsDebounced,
      saveSettings: () => window.saveSettings,
      renderExtensionTemplate: () => window.renderExtensionTemplate,
      renderExtensionTemplateAsync: () => window.renderExtensionTemplateAsync,
      loadExtensionSettings: () => window.loadExtensionSettings,
      openThirdPartyExtensionMenu: () => openThirdPartyExtensionMenuCompat,
    };
    const eventsModuleCompat = {
      eventSource: () => window.eventSource,
      event_types: () => window.event_types,
      eventTypes: () => window.event_types,
      default: () => ({ eventSource: window.eventSource, event_types: window.event_types }),
    };
    const formatterModuleCompat = {
      MessageFormatter: () => window.MessageFormatter || window.messageFormatter,
      messageFormatter: () => window.messageFormatter,
      messageFormatting: () => window.messageFormatting,
      formatting_stage: () => formattingStage,
      formattingStage: () => formattingStage,
      hook_order: () => hookOrder,
      hookOrder: () => hookOrder,
      default: () => window.MessageFormatter || window.messageFormatter,
    };
    const libModuleCompat = {
      $: () => window.$,
      jQuery: () => window.jQuery || window.$,
      jquery: () => window.jQuery || window.$,
      lodash: () => lodashCompat,
      _: () => lodashCompat,
      DOMPurify: () => domPurifyCompat,
      dompurify: () => domPurifyCompat,
      Handlebars: () => handlebarsCompat,
      handlebars: () => handlebarsCompat,
      moment: () => momentCompat,
      dayjs: () => window.dayjs || momentCompat,
      localforage: () => localforageCompat,
      toastr: () => window.toastr,
      default: () => ({
        $: window.$,
        jQuery: window.jQuery || window.$,
        lodash: lodashCompat,
        _: lodashCompat,
        DOMPurify: domPurifyCompat,
        Handlebars: handlebarsCompat,
        moment: momentCompat,
        dayjs: window.dayjs || momentCompat,
        localforage: localforageCompat,
        toastr: window.toastr,
      }),
    };
    const accountStorageModuleCompat = {
      accountStorage: () => accountStorageCompat,
      default: () => accountStorageCompat,
    };
    const tokenizersModuleCompat = {
      tokenizers: () => window.tokenizers || {},
      getTextTokens: () => window.getTextTokens,
      getTokenCount: () => window.getTokenCount,
      getTokenCountAsync: () => window.getTokenCountAsync,
      getTokenizerModel: () => window.getTokenizerModel,
      getFriendlyTokenizerName: () => (() => 'Palink'),
      initTokenizers: () => (async () => true),
      saveTokenCache: () => (() => true),
      default: () => ({
        tokenizers: window.tokenizers || {},
        getTextTokens: window.getTextTokens,
        getTokenCount: window.getTokenCount,
        getTokenCountAsync: window.getTokenCountAsync,
        getTokenizerModel: window.getTokenizerModel,
      }),
    };
    const toolManagerModuleCompat = {
      ToolManager: () => window.ToolManager,
      default: () => window.ToolManager,
    };
    const scraperModuleCompat = {
      ScraperManager: () => window.ScraperManager,
      default: () => window.ScraperManager,
    };
    const sharedExtensionModuleCompat = {
      ConnectionManagerRequestService: () => window.ConnectionManagerRequestService,
      ModuleWorkerWrapper: () => window.ModuleWorkerWrapper,
      default: () => ({
        ConnectionManagerRequestService: window.ConnectionManagerRequestService,
        ModuleWorkerWrapper: window.ModuleWorkerWrapper,
      }),
    };
    const constantsModuleCompat = {
      IGNORE_SYMBOL: () => window.IGNORE_SYMBOL,
      inject_ids: () => (window.inject_ids || {}),
      debounce_timeout: () => 200,
      GENERATION_TYPE_TRIGGERS: () => ({}),
      MEDIA_DISPLAY: () => ({ INLINE: 'inline', BLOCK: 'block' }),
      MEDIA_SOURCE: () => ({ USER: 'user', CHARACTER: 'character', SYSTEM: 'system' }),
      MEDIA_TYPE: () => ({ IMAGE: 'image', AUDIO: 'audio', VIDEO: 'video', FILE: 'file' }),
      OVERSWIPE_BEHAVIOR: () => ({}),
      SCROLL_BEHAVIOR: () => ({ AUTO: 'auto', SMOOTH: 'smooth' }),
      SWIPE_DIRECTION: () => ({ LEFT: 'left', RIGHT: 'right' }),
      SWIPE_SOURCE: () => ({ USER: 'user', SCRIPT: 'script' }),
      SWIPE_STATE: () => window.swipeState || {},
      default: () => ({
        IGNORE_SYMBOL: window.IGNORE_SYMBOL,
        inject_ids: window.inject_ids || {},
      }),
    };
    const macrosModuleCompat = {
      macros: () => window.macros,
      MacrosParser: () => window.MacrosParser,
      evaluateMacros: () => ((text) => window.substituteParams?.(text) ?? String(text ?? '')),
      getLastMessageId: () => (() => Math.max(0, compatChat.length - 1)),
      initMacros: () => (() => true),
      MacroEnvBuilder: () => window.MacroEnvBuilder,
      MacroEngine: () => window.MacroEngine,
      onboardingExperimentalMacroEngine: () => false,
      default: () => window.macros,
    };
    const scriptModuleCompat = {
      eventSource: () => window.eventSource,
      event_types: () => window.event_types,
      eventTypes: () => window.event_types,
      saveSettingsDebounced: () => window.saveSettingsDebounced,
      saveSettings: () => window.saveSettings,
      getRequestHeaders: () => window.getRequestHeaders,
      substituteParams: () => window.substituteParams,
      substituteParamsExtended: () => window.substituteParamsExtended,
      callPopup: () => window.callPopup,
      callGenericPopup: () => window.callGenericPopup,
      Popup: () => window.Popup,
      POPUP_TYPE: () => window.POPUP_TYPE,
      POPUP_RESULT: () => window.POPUP_RESULT,
      getCurrentChatId: () => ctxNow().getCurrentChatId || (() => ctx.sessionId),
      chat: () => window.chat,
      characters: () => window.characters,
      this_chid: () => window.this_chid,
      name1: () => window.name1,
      name2: () => window.name2,
      selected_group: () => window.selected_group,
      groups: () => window.groups,
      power_user: () => window.power_user,
      chat_metadata: () => window.chat_metadata,
      online_status: () => 'connected',
      CLIENT_VERSION: () => 'Palink:SillyTavernCompat',
      systemUserName: () => 'SillyTavern System',
      neutralCharacterName: () => 'Assistant',
      default_avatar: () => 'img/ai4.png',
      system_avatar: () => 'img/five.png',
      comment_avatar: () => 'img/quill.png',
      default_user_avatar: () => 'img/user-default.png',
      extension_prompt_types: () => window.extension_prompt_types,
      extension_prompt_roles: () => window.extension_prompt_roles,
      extension_prompts: () => window.extension_prompts,
      getCurrentChatId: () => window.getCurrentChatId,
      Generate: () => window.Generate,
      generate: () => window.generate,
      generateRaw: () => window.generateRaw,
      generateQuietPrompt: () => window.generateQuietPrompt,
      addOneMessage: () => window.addOneMessage,
      deleteMessage: () => window.deleteMessage,
      deleteLastMessage: () => window.deleteLastMessage,
      printMessages: () => window.printMessages,
      clearChat: () => window.clearChat,
      scrollChatToBottom: () => window.scrollChatToBottom,
      stopGeneration: () => window.stopGeneration,
      updateMessageBlock: () => window.updateMessageBlock,
      setChatMessage: () => window.setChatMessage,
      reloadCurrentChat: () => window.reloadCurrentChat,
      saveChat: () => window.saveChat,
      saveChatConditional: () => window.saveChatConditional,
      saveMetadata: () => window.saveMetadata,
      saveMetadataDebounced: () => window.saveMetadataDebounced,
      setExtensionPrompt: () => window.setExtensionPrompt,
    };
    const maps = [
      {
        match: ['extensions.js', 'extensions/index.js'],
        values: settingsModuleCompat,
      },
      {
        match: ['events.js', 'events/index.js'],
        values: eventsModuleCompat,
      },
      {
        match: ['message-formatter.js', 'message_formatter.js', 'message-formatter/index.js'],
        values: formatterModuleCompat,
      },
      {
        match: ['RossAscends-mods.js', 'RossAscends-mods/index.js', 'rossascends-mods.js'],
        values: {
          registerSlashCommand: () => window.registerSlashCommand,
          executeSlashCommands: () => window.executeSlashCommands,
          callPopup: () => window.callPopup,
          substituteParams: () => window.substituteParams,
          getContext: () => window.getContext,
          eventSource: () => window.eventSource,
          event_types: () => window.event_types,
          saveSettingsDebounced: () => window.saveSettingsDebounced,
          default: () => ({
            registerSlashCommand: window.registerSlashCommand,
            executeSlashCommands: window.executeSlashCommands,
            callPopup: window.callPopup,
            substituteParams: window.substituteParams,
            getContext: window.getContext,
          }),
        },
      },
      {
        match: ['st-context.js', 'st-context.ts'],
        values: {
          getContext: () => window.getContext,
          default: () => ({ getContext: window.getContext }),
        },
      },
      {
        match: ['script.js'],
        values: scriptModuleCompat,
      },
      {
        match: ['power-user.js', 'power-user/index.js'],
        values: {
          power_user: () => window.power_user,
          default: () => window.power_user,
          saveSettingsDebounced: () => window.saveSettingsDebounced,
          registerDebugFunction: () => (() => true),
          unregisterDebugFunction: () => (() => true),
        },
      },
      {
        match: ['characters.js', 'characters/index.js'],
        values: {
          characters: () => window.characters,
          this_chid: () => window.this_chid,
          name1: () => window.name1,
          name2: () => window.name2,
          getCharacters: () => window.getCharacters,
          getOneCharacter: () => window.getOneCharacter,
          getThumbnailUrl: () => window.getThumbnailUrl,
          selectCharacterById: () => window.selectCharacterById,
          getCharacterCardFields: () => ctxNow().getCharacterCardFields,
          createCharacterData: () => (ctxNow().createCharacterData || {}),
        },
      },
      {
        match: ['group-chats.js', 'group-chats/index.js'],
        values: {
          groups: () => window.groups,
          selected_group: () => window.selected_group,
          getGroups: () => window.getGroups,
          getGroupChat: () => window.getGroupChat,
          select_group_chats: () => window.select_group_chats,
          generateGroupWrapper: () => window.generateGroupWrapper,
          regenerateGroup: () => window.regenerateGroup,
        },
      },
      {
        match: ['world-info.js', 'worldinfo.js', 'world-info/index.js'],
        values: {
          getWorldbook: () => window.getWorldbook,
          getWorldbookEntries: () => window.getWorldbookEntries,
          setWorldbookEntries: () => window.setWorldbookEntries,
          createWorldbook: () => window.createWorldbook,
          createWorldbookEntries: () => window.createWorldbookEntries,
          createOrReplaceWorldbook: () => window.createOrReplaceWorldbook,
          createOrReplaceCharWorldbook: () => window.createOrReplaceCharWorldbook,
          deleteWorldbookEntries: () => window.deleteWorldbookEntries,
          activateChatWorldbook: () => window.activateChatWorldbook,
          rebindChatWorldbook: () => window.rebindChatWorldbook,
          world_info: () => (window.world_info || {}),
          world_names: () => (window.world_names || []),
        },
      },
      {
        match: ['secrets.js', 'secrets/index.js'],
        values: {
          SECRET_KEYS: () => ({}),
          secret_state: () => ({}),
          getSecretState: () => (async () => ({})),
          writeSecret: () => (async () => false),
          readSecret: () => (async () => ''),
          findSecret: () => (async () => ''),
        },
      },
      {
        match: ['textgen-settings.js', 'textgen-settings/index.js', 'openai.js'],
        values: {
          textgenerationwebui_settings: () => (window.textgenerationwebui_settings || {}),
          textgen_types: () => (window.textgen_types || {}),
          oai_settings: () => (window.oai_settings || {}),
          chat_completion_sources: () => (window.chat_completion_sources || {}),
          getTextGenGenerationData: () => ((finalPrompt) => ({ prompt: finalPrompt })),
          getOpenAIGenerationData: () => ((finalPrompt) => ({ messages: [{ role: 'user', content: String(finalPrompt ?? '') }] })),
        },
      },
      {
        match: ['slash-commands.js', 'slash-commands/index.js'],
        values: {
          SlashCommandParser: () => window.SlashCommandParser,
          SlashCommand: () => window.SlashCommand,
          SlashCommandArgument: () => window.SlashCommandArgument,
          SlashCommandNamedArgument: () => window.SlashCommandNamedArgument,
          SlashCommandEnumValue: () => window.SlashCommandEnumValue,
          ARGUMENT_TYPE: () => window.ARGUMENT_TYPE,
          registerSlashCommand: () => window.registerSlashCommand,
          executeSlashCommands: () => window.executeSlashCommands,
          executeSlashCommandsWithOptions: () => window.executeSlashCommandsWithOptions,
        },
      },
      {
        match: [
          'slash-commands/slashcommand.js',
          'slash-commands/slashcommandargument.js',
          'slash-commands/slashcommandenumvalue.js',
          'slash-commands/slashcommandparser.js',
        ],
        values: {
          SlashCommandParser: () => window.SlashCommandParser,
          SlashCommand: () => window.SlashCommand,
          SlashCommandArgument: () => window.SlashCommandArgument,
          SlashCommandNamedArgument: () => window.SlashCommandNamedArgument,
          SlashCommandEnumValue: () => window.SlashCommandEnumValue,
          ARGUMENT_TYPE: () => window.ARGUMENT_TYPE,
          default: () => window.SlashCommand,
        },
      },
      {
        match: ['tokenizers.js', 'tokenizers/index.js'],
        values: tokenizersModuleCompat,
      },
      {
        match: ['constants.js', 'constants/index.js'],
        values: constantsModuleCompat,
      },
      {
        match: ['tool-calling.js', 'tools.js', 'tool-calling/index.js'],
        values: toolManagerModuleCompat,
      },
      {
        match: ['scrapers.js', 'scrapers/index.js'],
        values: scraperModuleCompat,
      },
      {
        match: ['extensions/shared.js', 'shared.js', 'extensions/shared/index.js'],
        values: sharedExtensionModuleCompat,
      },
      {
        match: [
          'macros.js',
          'macros/index.js',
          'macros/macro-system.js',
          'macros/engine/macroenvbuilder.js',
          'macros/engine/macroengine.js',
          'macros/engine/macrodiagnostics.js',
        ],
        values: macrosModuleCompat,
      },
      {
        match: ['templates.js'],
        values: {
          renderTemplate: () => window.renderTemplate,
          renderTemplateAsync: () => window.renderTemplateAsync,
          renderExtensionTemplate: () => window.renderExtensionTemplate,
          renderExtensionTemplateAsync: () => window.renderExtensionTemplateAsync,
        },
      },
      {
        match: ['popup.js'],
        values: {
          Popup: () => window.Popup,
          POPUP_TYPE: () => window.POPUP_TYPE,
          POPUP_RESULT: () => window.POPUP_RESULT,
          callPopup: () => window.callPopup,
          callGenericPopup: () => window.callGenericPopup,
        },
      },
      {
        match: ['lib.js', 'lib/index.js', 'scripts/lib.js', 'vendor/lib.js'],
        values: libModuleCompat,
      },
      {
        match: [
          'jquery',
          'jquery.js',
          'jquery/index.js',
          'lodash',
          'lodash.js',
          'lodash/index.js',
          'underscore',
          'underscore.js',
          'dompurify',
          'dompurify.js',
          'handlebars',
          'handlebars.js',
          'moment',
          'moment.js',
          'dayjs',
          'dayjs.js',
          'localforage',
          'localforage.js',
        ],
        values: libModuleCompat,
      },
      {
        match: ['util/accountstorage.js', 'accountstorage.js', 'account-storage.js'],
        values: accountStorageModuleCompat,
      },
      {
        match: ['utils.js', 'utils/index.js'],
        values: new Proxy({}, {
          get(_target, prop) {
            if (prop === 'default') return () => stUtilsCompat;
            return () => stUtilsCompat[prop];
          },
        }),
      },
    ];
    const map = maps.find((item) => item.match.some((needle) => path.endsWith(needle) || path.includes('/' + needle)));
    if (map?.values?.[name]) return map.values[name]();
    return undefined;
  };
  window.__palinkStModuleImport = stModuleValueCompat;
  const parseStImportClauseCompat = (clause) => {
    const text = String(clause || '').trim();
    const names = [];
    const namespaceMatch = text.match(/^\\*\\s+as\\s+([A-Za-z_$][\\w$]*)$/);
    if (namespaceMatch) return [{ imported: '*', local: namespaceMatch[1], namespace: true }];
    const namedMatch = text.match(/\\{([\\s\\S]*)\\}/);
    if (namedMatch) {
      namedMatch[1].split(',').map((item) => item.trim()).filter(Boolean).forEach((item) => {
        const parts = item.split(/\\s+as\\s+/i).map((part) => part.trim()).filter(Boolean);
        names.push({ imported: parts[0], local: parts[1] || parts[0] });
      });
    }
    const defaultPart = text.replace(/\\{[\\s\\S]*\\}/, '').split(',').map((part) => part.trim()).filter(Boolean)[0];
    if (defaultPart && !defaultPart.startsWith('*')) names.unshift({ imported: 'default', local: defaultPart });
    return names.filter((item) => /^[A-Za-z_$][\\w$]*$/.test(item.local));
  };
  const normalizeStExportListCompat = (body) => String(body || '').split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(/\\s+as\\s+/i).map((part) => part.trim()).filter(Boolean);
      const local = parts[0] || '';
      const exported = parts[1] || local;
      if (!/^[A-Za-z_$][\\w$]*$/.test(local) || !/^[A-Za-z_$][\\w$]*$/.test(exported)) return '';
      return 'exports[' + JSON.stringify(exported) + '] = ' + local + ';';
    })
    .filter(Boolean)
    .join('\\n');
  const normalizeStReExportListCompat = (body, namespaceName) => String(body || '').split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(/\\s+as\\s+/i).map((part) => part.trim()).filter(Boolean);
      const imported = parts[0] || '';
      const exported = parts[1] || imported;
      if (!/^[A-Za-z_$][\\w$]*$/.test(imported) || !/^[A-Za-z_$][\\w$]*$/.test(exported)) return '';
      return 'exports[' + JSON.stringify(exported) + '] = ' + namespaceName + '[' + JSON.stringify(imported) + '];';
    })
    .filter(Boolean)
    .join('\\n');
  const normalizeStPluginExportsCompat = (source, moduleMode = false) => {
    let transformed = String(source || '');
    if (moduleMode) {
      transformed = transformed
        .replace(/^\\s*export\\s+\\{([\\s\\S]*?)\\};?\\s*$/gm, (_match, body) => normalizeStExportListCompat(body))
        .replace(/\\bexport\\s+default\\s+/g, 'exports.default = ')
        .replace(/\\bexport\\s+async\\s+function\\s+([A-Za-z_$][\\w$]*)\\s*\\(/g, 'exports.$1 = async function $1(')
        .replace(/\\bexport\\s+function\\s+([A-Za-z_$][\\w$]*)\\s*\\(/g, 'exports.$1 = function $1(')
        .replace(/\\bexport\\s+class\\s+([A-Za-z_$][\\w$]*)/g, 'exports.$1 = class $1')
        .replace(/\\bexport\\s+(const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=/g, '$1 $2 = exports.$2 =');
      return transformed;
    }
    return transformed
      .replace(/^\\s*export\\s+\\{[\\s\\S]*?\\};?\\s*$/gm, '')
      .replace(/\\bexport\\s+default\\s+/g, '')
      .replace(/\\bexport\\s+(?=(?:async\\s+)?(?:function|class|const|let|var)\\b)/g, '');
  };
  const normalizeEscapedScriptNewlinesCompat = (source) => {
    let text = String(source || '');
    const escapedLineBreakPattern = new RegExp(
      regexBackslashCompat + regexBackslashCompat + '(?:r' + regexBackslashCompat + regexBackslashCompat + 'n|n|r)\\s*(?:import|export|const|let|var|async|function|class)\\b',
    );
    if (!escapedLineBreakPattern.test(text)) return text;
    text = text
      .split(regexBackslashCompat + 'r' + regexBackslashCompat + 'n').join(newlineCompat)
      .split(regexBackslashCompat + 'n').join(newlineCompat)
      .split(regexBackslashCompat + 'r').join(newlineCompat);
    return text;
  };
  const normalizeStPluginScriptSourceCompat = (source, options = {}) => {
    const imports = [];
    const sideEffectImports = [];
    let reExportSeq = 0;
    const pluginId = String(options.pluginId || '');
    const resourcePath = String(options.resourcePath || '');
    let transformed = normalizeEscapedScriptNewlinesCompat(source)
      .replace(/^\\s*import\\s+type\\s+[^;]+;?\\s*$/gm, '')
      .replace(/^\\s*import\\s+['"]([^'"]+)['"];?\\s*$/gm, (_match, modulePath) => {
        sideEffectImports.push(modulePath);
        return '';
      })
      .replace(/^\\s*import\\s+([\\s\\S]*?)\\s+from\\s+['"]([^'"]+)['"];?\\s*$/gm, (_match, clause, modulePath) => {
        parseStImportClauseCompat(clause).forEach((item) => imports.push({ ...item, modulePath }));
        return '';
      });
    if (options.moduleMode) {
      transformed = transformed
        .replace(/^\\s*export\\s+\\*\\s+from\\s+['"]([^'"]+)['"];?\\s*$/gm, (_match, modulePath) => {
          return 'Object.assign(exports, window.__palinkStModuleNamespace?.(' + JSON.stringify(modulePath) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ') || {});';
        })
        .replace(/^\\s*export\\s+\\{([\\s\\S]*?)\\}\\s+from\\s+['"]([^'"]+)['"];?\\s*$/gm, (_match, body, modulePath) => {
          const namespaceName = '__palinkReExport' + (++reExportSeq);
          const declarations = 'const ' + namespaceName + ' = window.__palinkStModuleNamespace?.(' + JSON.stringify(modulePath) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ') || {};';
          const assignments = normalizeStReExportListCompat(body, namespaceName);
          return declarations + (assignments ? '\\n' + assignments : '');
        });
    }
    transformed = normalizeStPluginExportsCompat(transformed, Boolean(options.moduleMode));
    if (sideEffectImports.length) {
      const sideEffects = sideEffectImports.map((modulePath) => (
        'window.__palinkStModuleNamespace?.(' + JSON.stringify(modulePath) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ');'
      )).join('\\n');
      transformed = sideEffects + '\\n' + transformed;
    }
    if (imports.length) {
      const declarations = imports.map((item) => {
        if (item.namespace) {
          return 'const ' + item.local + ' = window.__palinkStModuleNamespace?.(' + JSON.stringify(item.modulePath) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ') || {};';
        }
        return 'const ' + item.local + ' = window.__palinkStModuleImport(' + JSON.stringify(item.modulePath) + ', ' + JSON.stringify(item.imported) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ');';
      }).join('\\n');
      transformed = declarations + '\\n' + transformed;
    }
    return transformed;
  };
  const executeStPluginScriptsCompat = () => {
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat());
    let sawDisabledScript = false;
    plugins.forEach((plugin) => {
      const jsResources = Array.isArray(plugin?.resources?.js) ? plugin.resources.js : [];
      const shouldExecute = plugin?.runtime?.execute_scripts === true;
      jsResources.forEach((resource, index) => {
        if (!resource || resource.missing) return;
        // [P0-SRCDOC-SLIM] 脚本源码经 plugin-scripts-push 单次推送后从包读取，
        // 不再依赖 context 内联的 content（瘦身 config 已剥离 js content）。
        const scriptContent = getStPluginScriptContentCompat(plugin, resource);
        if (!shouldExecute || resource.execute !== true) {
          sawDisabledScript = true;
          return;
        }
        // [P0-SRCDOC-SLIM] 脚本包未到达/内容缺失：非禁用（脚本会在包到达后重试执行），
        // 此处静默跳过，避免在包到达前误报「脚本未启用」诊断。
        if (typeof scriptContent !== 'string' || !scriptContent.trim()) return;
        const scriptKey = String(plugin.id || plugin.name || 'plugin') + ':' + String(resource.path || index);
        window.__palinkExecutedStPlugins = window.__palinkExecutedStPlugins || {};
        if (window.__palinkExecutedStPlugins[scriptKey]) return;
        window.__palinkExecutedStPlugins[scriptKey] = true;
        try {
          const source = normalizeStPluginScriptSourceCompat(scriptContent, {
            pluginId: plugin.id || plugin.name || '',
            resourcePath: resource.zip_path || resource.path || '',
            moduleMode: false,
          });
          const holderKey = '__palinkStPluginHolder_' + scriptKey.replace(/[^a-z0-9_$]/gi, '_') + '_' + Date.now();
          window[holderKey] = { ok: false, error: '' };
          const holderJson = JSON.stringify(holderKey);
          const pluginNameJson = JSON.stringify(String(plugin.name || plugin.id || ''));
          const wrappedSource = ''
            + '(async () => {' + newlineCompat
            + 'try {' + newlineCompat
            + 'await (async function(window,document,SillyTavern,getContext,extension_settings,TavernHelper,eventSource){' + newlineCompat
            + source
            + newlineCompat + '})(window,document,window.SillyTavern,window.getContext,window.extension_settings,window.TavernHelper,window.eventSource);' + newlineCompat
            + 'window[' + holderJson + '].ok = true;' + newlineCompat
            + '} catch (error) {' + newlineCompat
            + 'window[' + holderJson + '].error = String(error && error.message || error);' + newlineCompat
            + 'window.__palinkReportCompatDiagnostic?.({ severity: "warning", code: "st_plugin_script_failed_async", apiName: ' + pluginNameJson + ', message: String(error && error.message || error), stack: String(error && error.stack || "") });' + newlineCompat
            + '}' + newlineCompat
            + '})();'
            + newlineCompat + '//# sourceURL=palink-st-extension-' + String(plugin.id || plugin.name || index).replace(/[^a-z0-9_-]/gi, '-') + '.js';
          executeCompatInlineScriptCompat(wrappedSource, 'plugin:' + scriptKey);
          reportDiagnostic({
            severity: 'info',
            code: 'st_plugin_script_executed',
            apiName: String(plugin.name || plugin.id || ''),
            message: 'SillyTavern extension script executed in iframe sandbox.',
          });
        } catch (error) {
          reportDiagnostic({
            severity: 'warning',
            code: 'st_plugin_script_failed',
            apiName: String(plugin.name || plugin.id || ''),
            message: String(error?.message || error || uiText.unknownError),
            stack: String(error?.stack || ''),
          });
        }
      });
    });
    if (sawDisabledScript) {
      reportDiagnostic({
        severity: 'info',
        code: 'st_plugin_scripts_disabled',
        message: uiText.pluginScriptsDisabled,
      });
    }
  };
  // [P0-SRCDOC-SLIM] 接收父页面推送的插件脚本包：索引源码并按需执行插件脚本。
  // [P1-SRCDOC-SLIM] 推送内容为「清单」（仅元数据 + source URL，无 content）：
  // 这里先索引，再异步经 hydrateStPluginScriptsCompat 向父页面批量拉取缺失源码，
  // 内容就绪后补执行插件（executeStPluginScriptsCompat 按 scriptKey 幂等）。
  // 幂等：generated_at 相同则跳过（iframe 重建/重复推送场景）。执行时机从
  // 「shim 尾部同步执行」改为「脚本包内容就绪后执行」，与瘦身 srcDoc 解耦。
  const applyPluginScriptsPushCompat = (bundle) => {
    if (!bundle || typeof bundle !== 'object') return;
    const nextGeneratedAt = String(bundle.generated_at || '');
    if (nextGeneratedAt && nextGeneratedAt === stPluginScriptsBundleCompat.generated_at) return;
    stPluginScriptsBundleCompat.generated_at = nextGeneratedAt;
    stPluginScriptsBundleCompat.scripts = Array.isArray(bundle.scripts) ? bundle.scripts : [];
    indexStPluginScriptsCompat();
    try { injectStPluginCssCompat(); } catch {}
    // [P1-SRCDOC-SLIM] 异步拉取缺失源码（清单化内容通道），完成后执行插件脚本。
    void hydrateStPluginScriptsCompat();
  };
  const ensureStExtensionSettingsHostCompat = () => {
    let host = document.getElementById('extensions_settings2');
    if (!host) {
      const container = document.createElement('div');
      container.id = 'extensions_settings_container';
      // 不用 display:none：部分 ST 插件会用 offsetWidth/offsetHeight 判断可见性。
      // 改为离屏定位 + visibility:hidden，节点仍可被测量、插件设置面板可正常渲染。
      container.style.cssText = 'position:fixed; top:-9999px; left:-9999px; visibility:hidden;';
      const legacy = document.createElement('div');
      legacy.id = 'extensions_settings';
      legacy.setAttribute('data-palink-st-settings-host', 'legacy');
      host = document.createElement('div');
      host.id = 'extensions_settings2';
      host.setAttribute('data-palink-st-settings-host', 'primary');
      container.append(legacy, host);
      (document.body || document.documentElement).appendChild(container);
    }
    return host;
  };
  const ensureStExtensionSettingsSelectorCompat = (selector) => {
    const value = String(selector || '');
    if (/(?:^|[\\s,])#(?:extensions_settings2|extensions_settings|extensions_settings_container)\\b/.test(value)) {
      ensureStExtensionSettingsHostCompat();
    }
  };
  const openThirdPartyExtensionMenuCompat = async (extensionName = '') => {
    const existing = document.getElementById('palink-st-extension-settings');
    if (existing) existing.remove();
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat()).filter((plugin) => {
      if (!extensionName) return true;
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const needle = String(extensionName).toLowerCase();
      return [plugin?.id, plugin?.name, manifest.id, manifest.name, manifest.display_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === needle);
    });
    const overlay = document.createElement('div');
    overlay.id = 'palink-st-extension-settings';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(680px,100%);max-height:min(760px,88vh);overflow:auto;border-radius:10px;background:rgba(18,18,22,.96);color:#f8fafc;box-shadow:0 22px 70px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);';
    const close = () => {
      try { overlay.dispatchEvent(new Event('close')); } catch {}
      overlay.remove();
    };
    const header = document.createElement('div');
    header.style.cssText = 'position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:rgba(18,18,22,.98);border-bottom:1px solid rgba(255,255,255,.1);';
    const title = document.createElement('strong');
    title.textContent = uiText.pluginSettingsTitle;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = uiText.close;
    closeButton.style.cssText = 'border:1px solid rgba(255,255,255,.18);border-radius:7px;background:rgba(255,255,255,.08);color:inherit;padding:7px 10px;font-size:13px;';
    closeButton.addEventListener('click', close);
    header.append(title, closeButton);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px;display:grid;gap:12px;';
    const nativeHost = ensureStExtensionSettingsHostCompat();
    if (nativeHost && nativeHost.childElementCount > 0) {
      const nativeSection = document.createElement('section');
      nativeSection.style.cssText = 'border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:12px;background:rgba(255,255,255,.045);';
      const nativeTitle = document.createElement('div');
      nativeTitle.style.cssText = 'font-weight:650;margin-bottom:10px;';
      nativeTitle.textContent = uiText.nativeSettingsTitle;
      const nativeMount = document.createElement('div');
      nativeMount.id = 'palink-st-extension-native-settings-mount';
      nativeMount.style.cssText = 'display:grid;gap:10px;';
      while (nativeHost.firstChild) nativeMount.appendChild(nativeHost.firstChild);
      nativeSection.append(nativeTitle, nativeMount);
      body.appendChild(nativeSection);
      overlay.addEventListener('close', () => {
        while (nativeMount.firstChild) nativeHost.appendChild(nativeMount.firstChild);
      }, { once: true });
    }
    if (!plugins.length) {
      const empty = document.createElement('p');
      empty.textContent = uiText.pluginSettingsEmpty;
      empty.style.cssText = 'margin:0;color:rgba(255,255,255,.72);font-size:14px;';
      body.appendChild(empty);
    }
    plugins.forEach((plugin) => {
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const namespace = getStPluginRuntimeNamespaceCompat(plugin);
      const card = document.createElement('section');
      card.style.cssText = 'border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:12px;background:rgba(255,255,255,.045);';
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:650;margin-bottom:8px;';
      name.textContent = String(manifest.display_name || manifest.name || plugin.name || plugin.id || 'SillyTavern Extension');
      const jsonTitle = document.createElement('div');
      jsonTitle.style.cssText = 'margin:-2px 0 8px;color:rgba(255,255,255,.7);font-size:12px;';
      jsonTitle.textContent = uiText.jsonSettingsTitle;
      const meta = document.createElement('div');
      meta.style.cssText = 'margin-bottom:10px;color:rgba(255,255,255,.62);font-size:12px;';
      meta.textContent = namespace ? 'extension_settings.' + namespace : String(plugin.id || '');
      const textarea = document.createElement('textarea');
      textarea.spellcheck = false;
      textarea.value = JSON.stringify(namespace ? (window.extension_settings?.[namespace] ?? plugin.settings ?? {}) : (plugin.settings ?? {}), null, 2);
      textarea.style.cssText = 'box-sizing:border-box;width:100%;min-height:120px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.24);color:inherit;padding:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;';
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = ctx.language === 'en' ? 'Save to this card' : '\u4fdd\u5b58\u5230\u5f53\u524d\u5361\u7247';
      save.style.cssText = 'margin-top:9px;border:0;border-radius:7px;background:#f8fafc;color:#111827;padding:8px 12px;font-size:13px;font-weight:600;';
      save.addEventListener('click', () => {
        try {
          const parsed = JSON.parse(textarea.value || '{}');
          if (!window.extension_settings || typeof window.extension_settings !== 'object') window.extension_settings = {};
          if (namespace) window.extension_settings[namespace] = parsed;
          persistStorageValue('__palink_extension_settings', window.extension_settings || {});
          emitCompatEvent(window.event_types?.SETTINGS_UPDATED || 'settings_updated', window.extension_settings || {});
          void requestParent('saveExtensionSettings', {
            pluginId: plugin?.id,
            namespace,
            settings: parsed,
            extensionName: manifest.id || manifest.name || manifest.display_name || plugin.name || plugin.id,
          });
          close();
        } catch (error) {
          textarea.style.borderColor = 'rgba(248,113,113,.9)';
        }
      });
      card.append(name, jsonTitle, meta, textarea, save);
      body.appendChild(card);
    });
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
    return true;
  };
  const persistStorageValue = (key, value) => {
    post({ type: 'storage', storageType: 'localStorage', op: 'set', key, value: JSON.stringify(value ?? {}) });
  };
  const persistVariableStores = () => {
    persistStorageValue('__palink_local_variables', localVariableStore);
    persistStorageValue('__palink_global_variables', globalVariableStore);
    persistStorageValue('__palink_chat_variables', chatVariableStore);
  };
  let activeWorldbookName = '';
  const rememberWorldbookNameCompat = (requestedName, result) => {
    const resultName = result && typeof result === 'object'
      ? (result.name || result.worldbookName || result.world_book_name || result.title)
      : '';
    const nextName = String(resultName || requestedName || activeWorldbookName || '').trim();
    if (nextName) activeWorldbookName = nextName;
    return result;
  };
  // [F8/F9] 变量兼容 helper 源码内联进 shim（模板字符串内代码无法引用外部模块，
  // 故经 \${VARIABLES_COMPAT_SOURCE} 插值注入；模块函数供 __tests__ 单测，改动须同步）。
  ${VARIABLES_COMPAT_SOURCE}
  const setByPath = (source, path, value) => {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return value;
    let target = source;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      target = target[key];
    }
    target[parts[parts.length - 1]] = value;
    return value;
  };
  const deleteByPath = (source, path) => {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return false;
    let target = source;
    for (let index = 0; index < parts.length - 1; index += 1) {
      target = target?.[parts[index]];
      if (!target || typeof target !== 'object') return false;
    }
    const key = parts[parts.length - 1];
    if (!Object.prototype.hasOwnProperty.call(target, key)) return false;
    delete target[key];
    return true;
  };
  const mutateNumberByPath = (source, path, delta = 1) => {
    const current = Number(getByPath(source, path, 0));
    const next = (Number.isFinite(current) ? current : 0) + Number(delta || 0);
    setByPath(source, path, next);
    return next;
  };
  const macroRegistryCompat = new Map();
  const normalizeMacroNameCompat = (name) => String(name || '').replace(/^{{|}}$/g, '').trim();
  const getMacroValueCompat = (value, macroName, rawMatch) => {
    if (typeof value === 'function') {
      try {
        return value(macroName, rawMatch, ctx);
      } catch (error) {
        post({ type: 'error', message: String(error?.message || error) });
        return '';
      }
    }
    if (value && typeof value === 'object') {
      const handler = value.handler || value.callback || value.value;
      if (typeof handler === 'function') return getMacroValueCompat(handler, macroName, rawMatch);
      if (handler !== undefined) return handler;
    }
    return value;
  };
  const readDynamicMacroCompat = (dynamicMacros, macroName, rawMatch) => {
    if (!dynamicMacros || typeof dynamicMacros !== 'object') return undefined;
    const direct = Object.prototype.hasOwnProperty.call(dynamicMacros, macroName)
      ? dynamicMacros[macroName]
      : Object.prototype.hasOwnProperty.call(dynamicMacros, rawMatch)
        ? dynamicMacros[rawMatch]
        : undefined;
    if (direct === undefined) return undefined;
    return getMacroValueCompat(direct, macroName, rawMatch);
  };
  const getMessageMacroValueCompat = (macroName) => {
    const lower = String(macroName || '').toLowerCase();
    const currentIndex = resolveMessageIndex(ctx.messageId, {});
    const currentMessage = compatChat[currentIndex] || {};
    const lastMessage = compatChat[compatChat.length - 1] || currentMessage;
    if (lower === 'mes' || lower === 'message') return ctx.messageContent || currentMessage.mes || currentMessage.content || '';
    if (lower === 'lastmessage' || lower === 'last_message') return lastMessage.mes || lastMessage.content || '';
    if (lower === 'lastmessagename' || lower === 'last_message_name') return lastMessage.name || '';
    if (lower === 'currentmessageid' || lower === 'current_message_id') return ctx.messageId ?? currentMessage.message_id ?? currentMessage.id ?? currentIndex;
    if (lower === 'lastmessageid' || lower === 'last_message_id') return lastMessage.message_id ?? lastMessage.id ?? Math.max(0, compatChat.length - 1);
    return undefined;
  };
  const substituteParamsCompat = (content, options = {}, legacyName2 = undefined, legacyOriginal = undefined, legacyGroup = undefined, legacyReplaceCharacterCard = true, legacyAdditionalMacro = {}, legacyPostProcessFn = null) => {
    let resolvedOptions = options && typeof options === 'object' && !Array.isArray(options)
      ? { ...options }
      : {};
    if (typeof options === 'string' || legacyName2 !== undefined || legacyOriginal !== undefined || legacyGroup !== undefined) {
      resolvedOptions = {
        name1Override: typeof options === 'string' ? options : undefined,
        name2Override: legacyName2,
        original: legacyOriginal,
        group: legacyGroup,
        replaceCharacterCard: legacyReplaceCharacterCard,
        dynamicMacros: legacyAdditionalMacro,
        postProcessFn: legacyPostProcessFn,
      };
    }
    const dynamicMacros = resolvedOptions.dynamicMacros || resolvedOptions.additionalMacro || {};
    const name1 = resolvedOptions.name1Override ?? resolvedOptions.name1 ?? ctx.userName ?? 'User';
    const name2 = resolvedOptions.name2Override ?? resolvedOptions.name2 ?? ctx.characterName ?? 'Character';
    const original = resolvedOptions.original ?? legacyOriginal ?? '';
    const group = resolvedOptions.group ?? legacyGroup ?? window.selected_group ?? '';
    const builtIns = {
      user: name1,
      char: name2,
      character: name2,
      name1,
      name2,
      original,
      group,
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      datetime: new Date().toLocaleString(),
      model: ctx.model || '',
      chat: ctx.sessionId || '',
    };
    let result = String(content ?? '').replace(/{{\\s*([^{}]+?)\\s*}}/g, (rawMatch, rawName) => {
      const macroName = normalizeMacroNameCompat(rawName);
      const lower = macroName.toLowerCase();
      const dynamicValue = readDynamicMacroCompat(dynamicMacros, macroName, rawMatch);
      if (dynamicValue !== undefined) return String(dynamicValue ?? '');
      if (macroRegistryCompat.has(macroName)) return String(getMacroValueCompat(macroRegistryCompat.get(macroName), macroName, rawMatch) ?? '');
      if (macroRegistryCompat.has(lower)) return String(getMacroValueCompat(macroRegistryCompat.get(lower), macroName, rawMatch) ?? '');
      if (Object.prototype.hasOwnProperty.call(builtIns, lower)) return String(builtIns[lower] ?? '');
      const messageValue = getMessageMacroValueCompat(lower);
      if (messageValue !== undefined) return String(messageValue ?? '');
      const variableValue = getByPath(chatVariableStore, macroName, undefined);
      if (variableValue !== undefined) return String(variableValue ?? '');
      const globalValue = getByPath(globalVariableStore, macroName, undefined);
      if (globalValue !== undefined) return String(globalValue ?? '');
      return rawMatch;
    });
    const postProcessFn = resolvedOptions.postProcessFn;
    if (typeof postProcessFn === 'function') {
      try { result = postProcessFn(result); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
    }
    return String(result ?? '');
  };
  const parseMaybeJsonObject = (value, fallback = {}) => {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch {}
    }
    return fallback;
  };
  const normalizePromptInputCompat = (source, preferredKeys = []) => {
    const keyOrder = [
      ...preferredKeys,
      'quietPrompt',
      'quiet_prompt',
      'prompt',
      'content',
      'message',
      'mes',
      'text',
      'value',
    ];
    if (source && typeof source === 'object') {
      for (const key of keyOrder) {
        if (typeof source[key] === 'string') {
          return {
            content: substituteParamsCompat(source[key]),
            options: { ...source },
          };
        }
      }
      return {
        content: '',
        options: { ...source },
      };
    }
    return {
      content: substituteParamsCompat(String(source ?? '')),
      options: {},
    };
  };
  const normalizeUserMessageInputCompat = (messageText, messageBias = undefined, insertAt = null, compact = false, name = undefined, avatar = undefined) => {
    const normalized = normalizePromptInputCompat(messageText, ['messageText']);
    const options = {
      ...(normalized.options || {}),
      messageBias,
      insertAt,
      compact,
    };
    if (name !== undefined) options.name = name;
    if (avatar !== undefined) options.avatar = avatar;
    if (typeof normalized.options.name === 'string') options.name = normalized.options.name;
    if (typeof normalized.options.avatar === 'string') options.avatar = normalized.options.avatar;
    if (normalized.options.awaitResult !== undefined) options.awaitResult = Boolean(normalized.options.awaitResult);
    return { content: normalized.content, options };
  };
  const normalizeRegexListCompat = (source) => {
    if (!source) return [];
    if (Array.isArray(source)) return source.filter((item) => item && typeof item === 'object');
    const parsed = parseMaybeJsonObject(source, {});
    if (Array.isArray(parsed?.regex_scripts)) return parsed.regex_scripts.filter((item) => item && typeof item === 'object');
    if (Array.isArray(parsed?.extensions?.regex_scripts)) return parsed.extensions.regex_scripts.filter((item) => item && typeof item === 'object');
    if (Array.isArray(parsed?.prompts)) {
      return parsed.prompts.flatMap((prompt) => normalizeRegexListCompat(prompt?.extensions));
    }
    return [];
  };
  let scopedRegexScripts = normalizeRegexListCompat(ctx.characterExtensions);
  let presetRegexScripts = normalizeRegexListCompat(ctx.presetData);
  let globalRegexScripts = normalizeRegexListCompat(ctx.globalRegexScripts);
  const getGlobalRegexScriptsCompat = () => {
    const configured = window.extension_settings?.regex;
    return Array.isArray(configured) ? configured.filter((item) => item && typeof item === 'object') : clone(globalRegexScripts);
  };
  const getScopedRegexScriptsCompat = () => {
    const currentCharacter = window.characters?.[window.this_chid];
    const scoped = currentCharacter?.data?.extensions?.regex_scripts;
    return Array.isArray(scoped) ? scoped.filter((item) => item && typeof item === 'object') : clone(scopedRegexScripts);
  };
  const getPresetRegexScriptsCompat = () => {
    const configured = window.extension_settings?.palink_preset_regex_scripts;
    return Array.isArray(configured) ? configured.filter((item) => item && typeof item === 'object') : clone(presetRegexScripts);
  };
  const getAllRegexScriptsCompat = () => [
    ...getGlobalRegexScriptsCompat().map((script, index) => ({ ...script, __order: Number.isFinite(Number(script.order)) ? Number(script.order) : index })),
    ...getPresetRegexScriptsCompat().map((script, index) => ({ ...script, __order: Number.isFinite(Number(script.order)) ? Number(script.order) : index + 10000 })),
    ...getScopedRegexScriptsCompat().map((script, index) => ({ ...script, __order: Number.isFinite(Number(script.order)) ? Number(script.order) : index + 20000 })),
  ];
  const normalizeBooleanCompat = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  };
  const normalizePlacementListCompat = (value) => {
    if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
    if (typeof value === 'number' && Number.isFinite(value)) return [value];
    if (typeof value === 'string') {
      try { return normalizePlacementListCompat(JSON.parse(value)); } catch {}
      const parsed = Number(value);
      return Number.isFinite(parsed) ? [parsed] : [];
    }
    return [];
  };
  const normalizeDepthCompat = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const regexFromStringCompat = (value) => {
    const source = String(value || '');
    const match = source.match(/^\\/(.+)\\/([gimsuy]*)$/);
    try {
      if (match) return new RegExp(match[1], match[2]);
      return new RegExp(source, 'g');
    } catch {
      return null;
    }
  };
  const trimCapturedRegexStringCompat = (value, trimStrings) => {
    let result = String(value ?? '');
    for (const trim of trimStrings || []) {
      if (!trim) continue;
      while (result.includes(trim)) result = result.replace(trim, '');
    }
    return result;
  };
  const normalizeTrimStringsCompat = (value) => {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0);
    if (typeof value === 'string') {
      try { return normalizeTrimStringsCompat(JSON.parse(value)); } catch {}
      return value ? [value] : [];
    }
    return [];
  };
  const escapeRegexMacroCompat = (value) => {
    const specials = '.^$*+?{}[]/|()';
    return String(value ?? '').split('').map((char) => {
      const code = char.charCodeAt(0);
      if (code === 10) return regexBackslashCompat + 'n';
      if (code === 13) return regexBackslashCompat + 'r';
      if (code === 9) return regexBackslashCompat + 't';
      if (code === 11) return regexBackslashCompat + 'v';
      if (code === 12) return regexBackslashCompat + 'f';
      if (code === 0) return regexBackslashCompat + '0';
      if (char === regexBackslashCompat || specials.includes(char)) return regexBackslashCompat + char;
      return char;
    }).join('');
  };
  const regexScriptMatchesCompat = (script, options) => {
    if (!script || typeof script !== 'object') return false;
    if (normalizeBooleanCompat(script.disabled, false)) return false;
    if (script.enabled !== undefined && script.enabled !== null && !normalizeBooleanCompat(script.enabled, true)) return false;
    const placements = normalizePlacementListCompat(script.placement);
    if (placements.length > 0 && !placements.includes(Number(options.placement))) return false;
    const markdownOnly = normalizeBooleanCompat(script.markdownOnly ?? script.markdown_only, false);
    const promptOnly = normalizeBooleanCompat(script.promptOnly ?? script.prompt_only, false);
    if (markdownOnly && !options.isMarkdown) return false;
    if (promptOnly && !options.isPrompt) return false;
    if (!markdownOnly && !promptOnly && (options.isMarkdown || options.isPrompt)) return false;
    const minDepth = normalizeDepthCompat(script.minDepth ?? script.min_depth);
    const maxDepth = normalizeDepthCompat(script.maxDepth ?? script.max_depth);
    if (typeof options.depth === 'number') {
      if (minDepth !== null && minDepth >= -1 && options.depth < minDepth) return false;
      if (maxDepth !== null && maxDepth >= 0 && options.depth > maxDepth) return false;
    }
    return true;
  };
  const runRegexScriptCompat = (script, text, options) => {
    const rawFindRegex = typeof script.findRegex === 'string' ? script.findRegex : typeof script.find_regex === 'string' ? script.find_regex : '';
    if (!rawFindRegex || !text) return text;
    const substituteRegex = script.substituteRegex ?? script.substitute_regex ?? 0;
    const substituteMode = typeof substituteRegex === 'boolean' ? (substituteRegex ? 1 : 0) : Number(substituteRegex);
    const findRegexSource = substituteMode === 2
      ? rawFindRegex.replace(/{{(?:user|char|character|name1|name2)}}/gi, (match) => escapeRegexMacroCompat(substituteParamsCompat(match)))
      : substituteMode === 1
        ? substituteParamsCompat(rawFindRegex)
        : rawFindRegex;
    const findRegex = regexFromStringCompat(findRegexSource);
    if (!findRegex) return text;
    const replaceString = typeof script.replaceString === 'string'
      ? script.replaceString
      : typeof script.replace_string === 'string'
        ? script.replace_string
        : '';
    const trimStrings = normalizeTrimStringsCompat(script.trimStrings ?? script.trim_strings);
    try {
      return String(text).replace(findRegex, function(match, ...args) {
        const groups = args[args.length - 1];
        const captures = [match, ...args];
        let result = substituteParamsCompat(replaceString).replace(/{{match}}/gi, '$0');
        return result.replace(/\\$(\\d+)|\\$<([^>]+)>/g, (_token, num, groupName) => {
          const captured = num
            ? captures[Number(num)]
            : groupName && groups && typeof groups === 'object'
              ? groups[groupName]
              : '';
          return trimCapturedRegexStringCompat(captured || '', trimStrings);
        });
      });
    } catch {
      return text;
    }
  };
  const applyDisplayRegexScriptsCompat = (text, options) => {
    const ordered = getAllRegexScriptsCompat().sort((a, b) => Number(a.__order || 0) - Number(b.__order || 0));
    let result = String(text ?? '');
    let applied = 0;
    for (const script of ordered) {
      if (applied >= 40) break;
      if (!regexScriptMatchesCompat(script, options)) continue;
      result = runRegexScriptCompat(script, result, options);
      applied += 1;
    }
    const htmlFencePattern = new RegExp('([\\\\x60]{3,})html\\\\s*\\\\r?\\\\n([\\\\s\\\\S]*?)\\\\r?\\\\n\\\\1', 'g');
    return result.replace(htmlFencePattern, (_match, _ticks, htmlContent) => '<palink-html>' + htmlContent + '</palink-html>');
  };
  const hasDisplayLayerOptionsCompat = (options) => {
    if (!options || typeof options !== 'object') return false;
    const displayLayerKeys = [
      'extra',
      'display_text',
      'displayText',
      'swipe_info',
      'swipes',
      'swipe_id',
      'swipeId',
      'role',
      'name',
      'is_user',
      'is_system',
      'is_name',
      'force_avatar',
      'forceAvatar',
      'original_avatar',
      'originalAvatar',
      'avatar',
      'gen_id',
      'genId',
      'group_id',
      'groupId',
      'group_name',
      'groupName',
      'selected_group',
      'selectedGroup',
      'groups',
    ];
    return displayLayerKeys.some((key) => Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined);
  };
  const htmlEscapeCompat = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const sanitizeFormattedHtmlCompat = (value) => {
    const template = document.createElement('template');
    template.innerHTML = String(value ?? '');
    template.content.querySelectorAll('script,iframe,object,embed,base,form').forEach((node) => node.remove());
    template.content.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const rawValue = String(attribute.value || '');
        if (name.startsWith('on') || /javascript:/i.test(rawValue)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
    return template.innerHTML;
  };
  const escapeRegExpCompat = (value) => {
    const specials = '.*+?^{}()|[]\\\\$';
    return String(value ?? '').split('').map((char) => specials.includes(char) ? regexBackslashCompat + char : char).join('');
  };
  const protectFormattingBlocksCompat = (value) => {
    const blocks = [];
    const blockPattern = new RegExp('<style\\\\b[\\\\s\\\\S]*?<\\\\/style>|\\\\x60{3}[\\\\s\\\\S]*?\\\\x60{3}|~~~[\\\\s\\\\S]*?~~~|\\\\x60{2}[\\\\s\\\\S]*?\\\\x60{2}|\\\\x60[^\\\\x60\\\\n]*\\\\x60|<[^>\\\\n]+>', 'g');
    const text = String(value ?? '').replace(blockPattern, (match) => {
      const index = blocks.push(match) - 1;
      return '%%PALINK_FORMAT_BLOCK_' + index + '%%';
    });
    return { text, blocks };
  };
  const restoreFormattingBlocksCompat = (value, blocks) => String(value ?? '').replace(new RegExp('%%PALINK_FORMAT_BLOCK_(\\\\d+)%%', 'g'), (_match, index) => blocks[Number(index)] || '');
  const wrapQuotesForMessageFormattingCompat = (value) => {
    const protectedState = protectFormattingBlocksCompat(value);
    const wrapped = protectedState.text.replace(/(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gims, (match, p1, p2, p3, p4, p5, p6) => {
      if (p1) return '<q>"' + p1.slice(1, -1) + '"</q>';
      if (p2) return '<q>“' + p2.slice(1, -1) + '”</q>';
      if (p3) return '<q>«' + p3.slice(1, -1) + '»</q>';
      if (p4) return '<q>「' + p4.slice(1, -1) + '」</q>';
      if (p5) return '<q>『' + p5.slice(1, -1) + '』</q>';
      if (p6) return '<q>＂' + p6.slice(1, -1) + '＂</q>';
      return match;
    });
    return restoreFormattingBlocksCompat(wrapped, protectedState.blocks);
  };
  const normalizeMessageFormattingMarkdownCompat = (value) => String(value ?? '')
    .replaceAll(regexBackslashCompat + 'begin{align*}', '$$')
    .replaceAll(regexBackslashCompat + 'end{align*}', '$$');
  const markdownPreserveHtmlCompat = (value) => {
    const raw = wrapQuotesForMessageFormattingCompat(normalizeMessageFormattingMarkdownCompat(substituteParamsCompat(value)));
    const protectedBlocks = [];
    let text = String(raw ?? '')
      .replace(new RegExp('\\\\x60\\\\x60\\\\x60([a-zA-Z0-9_-]*)?\\\\s*\\\\r?\\\\n?([\\\\s\\\\S]*?)\\\\r?\\\\n?\\\\x60\\\\x60\\\\x60', 'g'), (_match, lang, code) => {
        protectedBlocks.push('<pre><code>' + htmlEscapeCompat(code) + '</code></pre>');
        return '%%PALINK_BLOCK_' + (protectedBlocks.length - 1) + '%%';
      })
      .replace(new RegExp('^###\\\\s+(.+)$', 'gm'), '<h3>$1</h3>')
      .replace(new RegExp('^##\\\\s+(.+)$', 'gm'), '<h2>$1</h2>')
      .replace(new RegExp('^#\\\\s+(.+)$', 'gm'), '<h1>$1</h1>')
      .replace(new RegExp('\\\\[([^\\\\]\\\\n]+)\\\\]\\\\((https?:\\\\/\\\\/[^)\\\\s]+)\\\\)', 'g'), '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*', 'g'), '<strong>$1</strong>')
      .replace(new RegExp('\\\\*([^*]+)\\\\*', 'g'), '<em>$1</em>')
      .replace(new RegExp('(^|\\\\n)([-*]\\\\s+.+(?:\\\\n[-*]\\\\s+.+)*)', 'g'), (_match, prefix, list) => {
        const items = String(list).split(new RegExp('\\\\n')).map((line) => line.replace(new RegExp('^[-*]\\\\s+'), '').trim()).filter(Boolean);
        return prefix + '<ul>' + items.map((item) => '<li>' + item + '</li>').join('') + '</ul>';
      })
      .replace(/\\n/g, '<br>');
    text = text.replace(new RegExp('%%PALINK_BLOCK_(\\\\d+)%%', 'g'), (_match, index) => protectedBlocks[Number(index)] || '');
    return sanitizeFormattedHtmlCompat(text);
  };
  const formattingStage = {
    BEFORE_REGEX: 'beforeRegex',
    AFTER_REGEX: 'afterRegex',
    AFTER_MARKDOWN: 'afterMarkdown',
  };
  const hookOrder = {
    EARLIEST: 0,
    EARLY: 10,
    NORMAL: 50,
    LATE: 90,
    LATEST: 100,
  };
  const runFormattingStageCompat = (stage, value, base) => {
    try {
      if (typeof window.messageFormatter?.runStage === 'function') {
        return window.messageFormatter.runStage(stage, value, base);
      }
    } catch (error) {
      post({ type: 'error', message: String(error?.message || error) });
    }
    return value;
  };
  const messageFormattingCompat = (mes, chName = ctx.characterName, isSystem = false, isUser = false, messageId = ctx.messageId, sanitizerOverrides = {}, isReasoning = false) => {
    const messagesForDepth = Array.isArray(window.chat) ? window.chat : [];
    const resolvedIndex = (() => {
      const byId = messagesForDepth.findIndex((message, index) => (
        String(message?.id) === String(messageId)
        || String(message?.message_id) === String(messageId)
        || String(message?.mesid) === String(messageId)
        || String(index) === String(messageId)
      ));
      return byId >= 0 ? byId : Number(ctx.messageIndex ?? 0);
    })();
    const usableMessages = messagesForDepth
      .map((message, index) => ({ message, index }))
      .filter((item) => !item.message?.is_system);
    const usableIndex = usableMessages.findIndex((item) => item.index === resolvedIndex);
    const depth = resolvedIndex >= 0 && usableIndex !== -1
      ? Math.max(0, usableMessages.length - usableIndex - 1)
      : Number(ctx.depth || 0);
    const base = {
      characterName: chName || ctx.characterName || '',
      ch_name: chName || ctx.characterName || '',
      isSystem: Boolean(isSystem),
      isUser: Boolean(isUser),
      messageId,
      depth,
      isReasoning: Boolean(isReasoning),
    };
    const messageForDisplay = Number.isInteger(Number(resolvedIndex)) ? messagesForDepth[resolvedIndex] : null;
    const activeSwipeExtra = messageForDisplay?.swipe_info?.[Number(messageForDisplay?.swipe_id || 0)]?.extra;
    const displayText = activeSwipeExtra?.display_text ?? messageForDisplay?.extra?.display_text;
    let text = typeof displayText === 'string' && String(mes ?? '') === String(messageForDisplay?.mes ?? messageForDisplay?.content ?? '')
      ? displayText
      : String(mes ?? '');
    if (Number(messageId) === 0 && !base.isSystem && !base.isUser && !base.isReasoning) {
      text = substituteParamsCompat(text);
    }
    if (!isSystem) {
      text = runFormattingStageCompat(formattingStage.BEFORE_REGEX, text, base);
      const placement = base.isReasoning
        ? 6
        : isUser
          ? 1
          : messageForDisplay?.extra?.type === 'narrator'
            ? 3
            : 2;
      text = applyDisplayRegexScriptsCompat(text, {
        placement,
        isMarkdown: true,
        isPrompt: false,
        depth,
      });
      text = runFormattingStageCompat(formattingStage.AFTER_REGEX, text, base);
    }
    let html = markdownPreserveHtmlCompat(text);
    html = runFormattingStageCompat(formattingStage.AFTER_MARKDOWN, html, base);
    if (!window.power_user?.allow_name2_display && chName && !isUser && !isSystem) {
      const prefixPattern = new RegExp(
        '(^|<br' + regexBackslashCompat + 's*' + regexBackslashCompat + '/?>|' + regexBackslashCompat + 'n)' +
        regexBackslashCompat + 's*' + escapeRegExpCompat(chName) + regexBackslashCompat + 's*[:：]' + regexBackslashCompat + 's*',
        'gi',
      );
      html = html.replace(prefixPattern, '$1');
    }
    if (isSystem) return '<span class="mes-system">' + html + '</span>';
    if (isUser) return '<span class="mes-user">' + html + '</span>';
    const name = htmlEscapeCompat(chName || ctx.characterName || '');
    return name ? '<span class="mes-name">' + name + '</span><span class="mes-text">' + html + '</span>' : html;
  };
  const messageFormatterCompat = (() => {
    const hooks = new Map([
      [formattingStage.BEFORE_REGEX, []],
      [formattingStage.AFTER_REGEX, []],
      [formattingStage.AFTER_MARKDOWN, []],
    ]);
    const api = {
      stage: formattingStage,
      order: hookOrder,
      addHook(fn, { stage = formattingStage.AFTER_MARKDOWN, order = hookOrder.NORMAL } = {}) {
        if (typeof fn !== 'function') throw new TypeError('MessageFormatter: hook must be a function');
        if (fn.constructor?.name === 'AsyncFunction') throw new TypeError('MessageFormatter: async hooks are not supported');
        if (!hooks.has(stage)) throw new RangeError('MessageFormatter: unknown stage ' + String(stage));
        hooks.get(stage).push({ fn, order: Number.isFinite(Number(order)) ? Number(order) : hookOrder.NORMAL });
      },
      removeHook(fn, stage = null) {
        const stages = stage ? [stage] : Array.from(hooks.keys());
        for (const item of stages) {
          const bucket = hooks.get(item);
          if (!bucket) continue;
          const index = bucket.findIndex((hook) => hook.fn === fn);
          if (index >= 0) bucket.splice(index, 1);
        }
      },
      clearHooks(stage = null) {
        const stages = stage ? [stage] : Array.from(hooks.keys());
        for (const item of stages) hooks.get(item)?.splice(0);
      },
      runStage(stage, mes, base = {}) {
        const bucket = hooks.get(stage);
        if (!bucket?.length) return mes;
        const stageContext = Object.freeze({ ...base, stage });
        let result = String(mes ?? '');
        const sorted = bucket.slice().sort((a, b) => a.order - b.order);
        for (const hook of sorted) {
          try {
            const next = hook.fn(result, stageContext);
            if (typeof next === 'string') result = next;
          } catch (error) {
            post({ type: 'error', message: String(error?.message || error) });
          }
        }
        return result;
      },
      format: (...args) => messageFormattingCompat(...args),
      render: (...args) => messageFormattingCompat(...args),
      process: (message) => messageFormattingCompat(
        message?.mes ?? message?.content ?? message?.message ?? message,
        message?.name,
        Boolean(message?.is_system),
        Boolean(message?.is_user),
        message?.mesid ?? message?.id,
      ),
    };
    return api;
  })();
  const stripSwipeInfoFromExtra = (extra) => {
    const source = extra && typeof extra === 'object' ? clone(extra) : {};
    if (source && typeof source === 'object') delete source.swipe_info;
    return source;
  };
  const normalizeSwipeInfoEntry = (entry, fallbackExtra, fallbackSendDate = '') => {
    const source = entry && typeof entry === 'object' ? clone(entry) : {};
    return {
      ...source,
      send_date: source.send_date || fallbackSendDate || '',
      extra: stripSwipeInfoFromExtra(
        source.extra && typeof source.extra === 'object' ? source.extra : fallbackExtra,
      ),
    };
  };
  const stMessageMetaKeys = [
    'is_name',
    'force_avatar',
    'original_avatar',
    'avatar',
    'gen_id',
    'group_id',
    'group_name',
    'selected_group',
    'groups',
  ];
  const getStMessageMeta = (source, key, fallbackExtra) => {
    if (source && typeof source === 'object' && source[key] !== undefined) return source[key];
    if (fallbackExtra && typeof fallbackExtra === 'object' && fallbackExtra[key] !== undefined) return fallbackExtra[key];
    return undefined;
  };
  const applyStMessageMeta = (target, source, fallbackExtra = target?.extra) => {
    stMessageMetaKeys.forEach((key) => {
      const value = getStMessageMeta(source, key, fallbackExtra);
      if (value !== undefined) {
        target[key] = clone(value);
        if (!target.extra || typeof target.extra !== 'object') target.extra = {};
        target.extra[key] = clone(value);
      }
    });
    return target;
  };
  const normalizeChatMessage = (message, index) => {
    const role = String(message?.role || (index === 0 ? 'assistant' : 'user'));
    const content = String(message?.content ?? message?.mes ?? message?.message ?? '');
    const isUser = role === 'user';
    const id = message?.id ?? message?.message_id ?? index;
    const mesid = Number.isFinite(Number(message?.mesid)) ? Number(message.mesid) : index;
    const rawExtra = message?.extra && typeof message.extra === 'object' ? clone(message.extra) : {};
    const swipes = Array.isArray(message?.swipes) && message.swipes.length
      ? message.swipes.map((item) => String(item ?? ''))
      : [content];
    const swipeId = Math.max(0, Math.min(
      Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0,
      Math.max(0, swipes.length - 1),
    ));
    const activeContent = swipes[swipeId] ?? content;
    const sourceSwipeInfo = Array.isArray(message?.swipe_info)
      ? message.swipe_info
      : Array.isArray(rawExtra.swipe_info)
        ? rawExtra.swipe_info
        : null;
    const activeSwipeExtra = sourceSwipeInfo?.[swipeId]?.extra && typeof sourceSwipeInfo[swipeId].extra === 'object'
      ? sourceSwipeInfo[swipeId].extra
      : null;
    const extra = stripSwipeInfoFromExtra(activeSwipeExtra || rawExtra);
    const sendDate = message?.created_at || message?.send_date || '';
    const normalized = {
      id,
      mesid,
      message_id: id,
      name: message?.name || (isUser ? ctx.userName : ctx.characterName),
      role,
      is_user: isUser,
      is_system: role === 'system',
      is_name: getStMessageMeta(message, 'is_name', extra) ?? true,
      content: activeContent,
      mes: activeContent,
      message: activeContent,
      text: activeContent,
      swipes,
      swipe_id: swipeId,
      swipe_info: sourceSwipeInfo
        ? sourceSwipeInfo.map((entry) => normalizeSwipeInfoEntry(entry, extra, sendDate))
        : swipes.map(() => ({ send_date: sendDate, extra: clone(extra) })),
      extra,
      send_date: sendDate,
    };
    return applyStMessageMeta(normalized, message, extra);
  };
  const seedMessages = Array.isArray(ctx.chatMessages) && ctx.chatMessages.length > 0
    ? ctx.chatMessages
    : [{ id: ctx.messageId, role: 'assistant', name: ctx.characterName, content: ctx.messageContent }];
  const compatChat = seedMessages.map(normalizeChatMessage);
  let currentMessageIndex = Number.isFinite(Number(ctx.messageIndex))
    ? Number(ctx.messageIndex)
    : Math.max(0, compatChat.findIndex((message) => String(message.id) === String(ctx.messageId) || String(message.message_id) === String(ctx.messageId)));
  const ensureSwipeInfoShape = (message) => {
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
      const content = String(message?.mes ?? message?.content ?? message?.message ?? '');
      message.swipes = [content];
    }
    if (!Number.isFinite(Number(message.swipe_id))) message.swipe_id = 0;
    message.swipe_id = Math.max(0, Math.min(Number(message.swipe_id), message.swipes.length - 1));
    if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
    const fallbackExtra = stripSwipeInfoFromExtra(message.extra || {});
    while (message.swipe_info.length < message.swipes.length) {
      message.swipe_info.push({ send_date: message.send_date || '', extra: clone(fallbackExtra) });
    }
    message.swipe_info = message.swipe_info
      .slice(0, message.swipes.length)
      .map((entry) => normalizeSwipeInfoEntry(entry, fallbackExtra, message.send_date || ''));
    return message;
  };
  const syncMessageAliases = (message) => {
    const content = String(message?.mes ?? message?.content ?? message?.message ?? '');
    message.content = content;
    message.mes = content;
    message.message = content;
    message.text = content;
    message.extra = stripSwipeInfoFromExtra(message.extra || {});
    ensureSwipeInfoShape(message);
    return message;
  };
  const syncMesToSwipeCompat = (message) => {
    if (!message) return message;
    syncMessageAliases(message);
    message.swipes[message.swipe_id] = String(message.mes ?? '');
    message.swipe_info[message.swipe_id] = {
      ...(message.swipe_info[message.swipe_id] || {}),
      send_date: message.swipe_info[message.swipe_id]?.send_date || message.send_date || '',
      extra: stripSwipeInfoFromExtra(message.extra || {}),
    };
    return syncMessageAliases(message);
  };
  const syncSwipeToMesCompat = (message, swipeId = message?.swipe_id) => {
    if (!message) return message;
    syncMessageAliases(message);
    const nextSwipeId = Math.max(0, Math.min(Number(swipeId) || 0, message.swipes.length - 1));
    message.swipe_id = nextSwipeId;
    message.mes = String(message.swipes[nextSwipeId] ?? '');
    const activeSwipeInfo = message.swipe_info[nextSwipeId];
    if (activeSwipeInfo?.extra && typeof activeSwipeInfo.extra === 'object') {
      message.extra = stripSwipeInfoFromExtra(activeSwipeInfo.extra);
    }
    return syncMessageAliases(message);
  };
  compatChat.forEach((message) => syncSwipeToMesCompat(message, message.swipe_id));
  const primaryCharacter = {
    id: ctx.characterId,
    uuid: ctx.characterId,
    name: ctx.characterName,
    avatar: ctx.characterId,
    chat: ctx.sessionId,
    first_mes: ctx.firstMes || '',
    alternate_greetings: Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [],
    data: {
      name: ctx.characterName,
      extensions: parseMaybeJsonObject(ctx.characterExtensions, {}),
      first_mes: ctx.firstMes || '',
      alternate_greetings: Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [],
    },
  };
  const getMessageGroupIdCompat = (message) => (
    message?.selected_group
    ?? message?.selectedGroup
    ?? message?.group_id
    ?? message?.groupId
    ?? null
  );
  const getMessageGroupNameCompat = (message) => (
    message?.group_name
    ?? message?.groupName
    ?? null
  );
  const buildCharacterFromMessageCompat = (message, index) => {
    const name = String(message?.name || '').trim();
    if (!name || message?.is_user || message?.is_system) return null;
    const avatar = message?.avatar || message?.force_avatar || message?.original_avatar || name;
    const id = message?.character_id || message?.characterId || avatar || name || index;
    return {
      id,
      uuid: id,
      name,
      avatar,
      chat: ctx.sessionId,
      data: {
        name,
        avatar,
        extensions: {},
      },
    };
  };
  const buildGroupContextCompat = () => {
    const explicitGroupSource = compatChat.find((message) => Array.isArray(message?.groups) && message.groups.length > 0);
    const metaGroupSource = compatChat.find((message) => (
      getMessageGroupIdCompat(message) !== null
      || getMessageGroupNameCompat(message) !== null
    ));
    const source = explicitGroupSource || metaGroupSource || null;
    const groupId = getMessageGroupIdCompat(source);
    const groupName = getMessageGroupNameCompat(source);
    const members = [];
    const seenNames = new Set();
    compatChat.forEach((message, index) => {
      const member = buildCharacterFromMessageCompat(message, index);
      if (!member || seenNames.has(member.name)) return;
      seenNames.add(member.name);
      members.push(member);
    });
    if (!seenNames.has(primaryCharacter.name)) {
      members.unshift(primaryCharacter);
    }
    const groups = Array.isArray(explicitGroupSource?.groups)
      ? clone(explicitGroupSource.groups)
      : groupId || groupName
        ? [{
          id: groupId || ctx.sessionId || 'palink-group',
          name: groupName || ctx.characterName || 'Palink Group',
          members: members.map((member) => member.id ?? member.name),
          disabled_members: [],
          chat_id: ctx.sessionId,
          chat_metadata: window.chat_metadata || {},
        }]
        : [];
    return {
      selectedGroup: groupId || (groups[0]?.id ?? null),
      groups,
      members,
    };
  };
  const refreshGroupContextCompat = () => {
    const groupContext = buildGroupContextCompat();
    window.selected_group = groupContext.selectedGroup ?? null;
    window.groups = Array.isArray(groupContext.groups) ? groupContext.groups : [];
    window.characters = Array.isArray(window.characters) ? window.characters : [];
    window.characters[0] = primaryCharacter;
    if (ctx.characterId) window.characters[ctx.characterId] = primaryCharacter;
    groupContext.members.forEach((member, index) => {
      const characterIndex = index === 0 ? 0 : index;
      window.characters[characterIndex] = member;
      if (member.id !== undefined && member.id !== null) window.characters[member.id] = member;
      if (member.name) window.characters[member.name] = member;
    });
    window.this_chid = 0;
    window.characters[0] = primaryCharacter;
    if (ctx.characterId) window.characters[ctx.characterId] = primaryCharacter;
    if (primaryCharacter.name) window.characters[primaryCharacter.name] = primaryCharacter;
    return groupContext;
  };
  const getGroupsCompat = () => clone(Array.isArray(window.groups) ? window.groups : []);
  const getGroupChatCompat = (groupId = window.selected_group) => {
    const groups = Array.isArray(window.groups) ? window.groups : [];
    const group = groups.find((item) => String(item?.id) === String(groupId))
      || groups.find((item) => String(item?.name) === String(groupId))
      || groups[0]
      || null;
    return {
      ...(group && typeof group === 'object' ? clone(group) : {}),
      id: group?.id ?? groupId ?? null,
      name: group?.name ?? ctx.characterName ?? '',
      chat_id: group?.chat_id ?? ctx.sessionId,
      chat: getCompatChatMessages(),
      messages: getCompatChatMessages(),
      members: Array.isArray(group?.members)
        ? clone(group.members)
        : compatChat
          .filter((message) => message && !message.is_user && !message.is_system && message.name)
          .map((message) => message.name),
    };
  };
  window.chat = compatChat;
  window.name1 = ctx.userName || 'User';
  window.name2 = ctx.characterName || 'Character';
  window.this_chid = 0;
  refreshGroupContextCompat();
  const syncCtxMessageFromCompat = (index) => {
    const message = compatChat[index];
    if (!message) return;
    if (Array.isArray(ctx.chatMessages) && ctx.chatMessages[index]) {
      ctx.chatMessages[index] = {
        ...ctx.chatMessages[index],
        content: message.mes,
        mes: message.mes,
        message: message.mes,
        text: message.mes,
        name: message.name,
        role: message.role,
        is_user: message.is_user,
        is_system: message.is_system,
        is_name: message.is_name,
        force_avatar: message.force_avatar,
        original_avatar: message.original_avatar,
        avatar: message.avatar,
        gen_id: message.gen_id,
        group_id: message.group_id,
        group_name: message.group_name,
        selected_group: clone(message.selected_group),
        groups: clone(message.groups),
        swipe_id: message.swipe_id,
        swipes: clone(message.swipes),
        swipe_info: clone(message.swipe_info),
        extra: clone(message.extra || {}),
      };
    }
    if (index === currentMessageIndex || String(message.id) === String(ctx.messageId) || String(message.message_id) === String(ctx.messageId)) {
      ctx.messageContent = message.mes;
    }
    refreshGroupContextCompat();
  };
  const normalizeParentSelectorCompat = (selector) => String(selector || '').trim();
  const parentSelectorMatchesCompat = (selector, id) => {
    const normalized = normalizeParentSelectorCompat(selector);
    if (!normalized) return false;
    return normalized.split(',').map((part) => part.trim()).filter(Boolean).some((part) => {
      const simple = part
        .replace(/:(?:visible|hidden|first|last|first-child|last-child|eq\\([^)]*\\)|not\\([^)]*\\))/gi, '')
        .trim();
      if (simple === '*' || simple === '#' + id || simple === '[id="' + id + '"]' || simple === "[id='" + id + "']") return true;
      if (id === 'send_textarea') return /^(?:textarea)?#send_textarea$|^textarea\\b|send_textarea|send-textarea/i.test(part);
      if (id === 'send_but') return /^(?:button)?#send_but$|^button\\b|send_but|send-button|sendButton/i.test(part);
      if (id === 'send_form') return /^(?:form)?#send_form$|^form\\b|send_form|send-form/i.test(part);
      if (id === 'chat') return /(?:^|\\s|>)#chat\\b|(?:^|\\s|>)\\.chat\\b|chat_container|chat-container/i.test(part);
      if (id === 'chat_scroll') return /chat_scroll|chat-scroll|\\.chat-scroll|\\.chat_container/i.test(part);
      if (/(?:\\.mes_text\\b|#mes_text\\b|mes_text|message_text|message-content)/i.test(part) && (id === 'last_mes' || id === 'mes')) return false;
      if (id === 'last_mes' || id === 'mes') return /(?:^|\\s|>)\\.mes\\b|\\.last_mes\\b|last_mes|mes_block|message-block/i.test(part);
      if (id === 'mes_text') return /\\.mes_text\\b|mes_text|message_text|message-content|\\.mes\\s+.*\\.mes_text|\\.last_mes\\s+.*\\.mes_text/i.test(part);
      if (id === 'mes_buttons') return /\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(part);
      if (id === 'swipe_left') return /swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(part);
      if (id === 'swipe_right') return /swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(part);
      if (id === 'swipe_counter') return /swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(part);
      return false;
    });
  };
  const parentElementStore = {};
  const createParentVirtualElementCompat = (id, tagName = 'DIV', className = '', options = {}) => {
    const listeners = new Map();
    const element = {
      __palinkParentElement: true,
      nodeType: 1,
      id,
      tagName,
      className,
      dataset: { ...(options.dataset || {}) },
      style: {},
      value: options.value || '',
      get textContent() {
        return typeof options.text === 'function' ? String(options.text() ?? '') : String(options.text ?? '');
      },
      set textContent(value) {
        options.text = String(value ?? '');
        if (typeof options.onSetText === 'function') options.onSetText(options.text, this);
      },
      get innerText() { return this.textContent; },
      set innerText(value) { this.textContent = value; },
      get innerHTML() {
        return typeof options.html === 'function' ? String(options.html() ?? '') : this.textContent;
      },
      set innerHTML(value) {
        options.html = String(value ?? '');
        options.text = String(value ?? '').replace(/<[^>]+>/g, '');
        if (typeof options.onSetHtml === 'function') options.onSetHtml(options.html, this);
      },
      parentElement: null,
      children: [],
      addEventListener(type, callback) {
        if (typeof callback !== 'function') return;
        const key = String(type || '');
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(callback);
      },
      removeEventListener(type, callback) {
        listeners.get(String(type || ''))?.delete(callback);
      },
      dispatchEvent(event) {
        const eventType = typeof event === 'string' ? event : event?.type;
        if (!eventType) return true;
        const evt = event && typeof event === 'object' ? event : { type: eventType };
        if (!evt.target) {
          try { Object.defineProperty(evt, 'target', { value: this, configurable: true }); } catch { evt.target = this; }
        }
        if (!evt.currentTarget) {
          try { Object.defineProperty(evt, 'currentTarget', { value: this, configurable: true }); } catch { evt.currentTarget = this; }
        }
        if (typeof evt.preventDefault !== 'function') {
          evt.preventDefault = () => {
            try { Object.defineProperty(evt, 'defaultPrevented', { value: true, configurable: true }); } catch { evt.defaultPrevented = true; }
          };
        }
        Array.from(listeners.get(String(eventType)) || []).forEach((listener) => {
          try { listener.call(this, evt); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
        });
        if (!evt.defaultPrevented && typeof options.dispatch === 'function') options.dispatch.call(this, evt, eventType);
        return !evt.defaultPrevented;
      },
      click() {
        const allowed = this.dispatchEvent({ type: 'click', target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; } });
        if (allowed !== false && typeof options.click === 'function') options.click.call(this);
      },
      focus() {},
      blur() {},
      matches(selector) {
        if (typeof options.matches === 'function') return Boolean(options.matches(selector, this));
        return parentSelectorMatchesCompat(selector, id);
      },
      closest(selector) {
        if (typeof options.closest === 'function') return options.closest(selector, this);
        return this.matches(selector) ? this : null;
      },
      querySelector(selector) { return getParentElementBySelectorCompat(selector); },
      querySelectorAll(selector) { return getParentElementsBySelectorCompat(selector); },
      getAttribute(name) {
        const key = String(name || '');
        if (key === 'id') return id;
        if (key === 'class') return className;
        if (key === 'value') return this.value;
        if (key === 'src' && 'src' in this) return this.src || '';
        if (key === 'alt' && 'alt' in this) return this.alt || '';
        if (key === 'mesid' || key === 'data-mesid' || key === 'data-message-id') {
          const optionIndex = typeof options.getMessageIndex === 'function'
            ? options.getMessageIndex()
            : resolveMessageIndex(ctx.messageId, {});
          return String(optionIndex);
        }
        if (key.startsWith('data-')) return this.dataset[key.slice(5)] ?? null;
        return null;
      },
      setAttribute(name, value) {
        const key = String(name || '');
        if (key === 'value') this.value = String(value ?? '');
        else if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value ?? '');
        else this[key] = String(value ?? '');
      },
      removeAttribute(name) {
        const key = String(name || '');
        if (key.startsWith('data-')) delete this.dataset[key.slice(5)];
      },
    };
    return element;
  };
  const parentMessageElementCache = new Map();
  const selectorHasMessageTextCompat = (selector) => /(?:^|[\\s>+~])\\.mes_text\\b|#mes_text\\b|\\bmes_text\\b|message_text|message-content/i.test(String(selector || ''));
  const selectorHasMessageBlockCompat = (selector) => /(?:^|[\\s>+~])\\.mes\\b|\\.last_mes\\b|#chat\\b|chat_container|chat-container/i.test(String(selector || ''));
  const selectorHasMesBlockInnerCompat = (selector) => /(?:^|[\\s>+~])\\.mes_block\\b|\\bmes_block\\b/i.test(String(selector || ''));
  const selectorHasNameCompat = (selector) => /(?:^|[\\s>+~])\\.ch_name\\b|(?:^|[\\s>+~])\\.name_text\\b|\\bch_name\\b|\\bname_text\\b/i.test(String(selector || ''));
  const selectorHasAvatarCompat = (selector) => /(?:^|[\\s>+~])\\.avatar\\b|\\.avatar\\s+img|force_avatar|original_avatar/i.test(String(selector || ''));
  const selectorHasTimestampCompat = (selector) => /(?:^|[\\s>+~])\\.timestamp\\b|\\btimestamp\\b|send_date/i.test(String(selector || ''));
  const selectorHasSwipeElementCompat = (selector) => /swipe_left|swipe-right|swipe_right|swipe_counter|swipes-counter|\\.swipe_/i.test(String(selector || ''));
  const normalizeSelectorCompat = (selector) => String(selector || '')
    .replace(/:(?:visible|hidden|first|last|first-child|last-child|eq\\([^)]*\\)|not\\([^)]*\\))/gi, '')
    .trim();
  const getSelectorPseudoCompat = (selector) => {
    const raw = String(selector || '');
    const eqMatch = raw.match(/:eq\\(\\s*(-?\\d+)\\s*\\)/i);
    return {
      first: /:(?:first|first-child)\\b/i.test(raw),
      last: /:(?:last|last-child)\\b/i.test(raw),
      eq: eqMatch ? Number(eqMatch[1]) : null,
    };
  };
  const applySelectorPseudoCompat = (indexes, selector) => {
    const uniqueIndexes = Array.from(new Set((indexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < compatChat.length)));
    const pseudo = getSelectorPseudoCompat(selector);
    if (pseudo.eq !== null && Number.isInteger(pseudo.eq)) {
      const resolved = pseudo.eq < 0 ? uniqueIndexes.length + pseudo.eq : pseudo.eq;
      return uniqueIndexes[resolved] !== undefined ? [uniqueIndexes[resolved]] : [];
    }
    if (pseudo.last) return uniqueIndexes.length ? [uniqueIndexes[uniqueIndexes.length - 1]] : [];
    if (pseudo.first) return uniqueIndexes.length ? [uniqueIndexes[0]] : [];
    return uniqueIndexes;
  };
  const getMessageIndexesFromSelectorCompat = (selector) => {
    const normalized = normalizeSelectorCompat(selector);
    if (!normalized) return [];
    const latestIndex = resolveLatestMessageIndexCompat();
    if (/\\.last_mes\\b|last_mes/i.test(normalized)) return latestIndex >= 0 ? [latestIndex] : [];
    const attrMatch = normalized.match(/(?:\\bmesid\\b|\\bdata-mesid\\b|\\bdata-message-id\\b|\\bdata-palink-message-id\\b|\\bmessage_id\\b)\\s*=\\s*["']?([^"'\\]\\s]+)/i);
    if (attrMatch) {
      const raw = attrMatch[1];
      const byIndex = Number(raw);
      if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < compatChat.length) return [byIndex];
      const byId = compatChat.findIndex((message) => String(message.id) === String(raw) || String(message.message_id) === String(raw));
      return byId >= 0 ? [byId] : [];
    }
    const idMatch = normalized.match(/#(?:message-|mes-|chat-message-|mes_text-)(\\d+)\\b/i);
    if (idMatch) {
      const byIndex = Number(idMatch[1]);
      return Number.isInteger(byIndex) && byIndex >= 0 && byIndex < compatChat.length ? [byIndex] : [];
    }
    if (
      selectorHasMessageBlockCompat(normalized)
      || selectorHasMessageTextCompat(normalized)
      || selectorHasMesBlockInnerCompat(normalized)
      || selectorHasNameCompat(normalized)
      || selectorHasAvatarCompat(normalized)
      || selectorHasTimestampCompat(normalized)
    ) {
      return applySelectorPseudoCompat(compatChat.map((_message, index) => index), selector);
    }
    return [];
  };
  const getParentMessageElementCompat = (index, kind = 'mes') => {
    const numericIndex = Number(index);
    if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= compatChat.length) return null;
    const key = String(kind) + ':' + String(numericIndex);
    if (parentMessageElementCache.has(key)) return parentMessageElementCache.get(key);
    const isText = kind === 'mes_text';
    const isButtons = kind === 'mes_buttons';
    const isCounter = kind === 'swipe_counter';
    const isLeft = kind === 'swipe_left';
    const isRight = kind === 'swipe_right';
    const isAvatarImg = kind === 'avatar_img';
    const tagName = isAvatarImg ? 'IMG' : isLeft || isRight ? 'BUTTON' : isCounter ? 'SPAN' : 'DIV';
    const className = isText
      ? 'mes_text'
      : isButtons
        ? 'mes_buttons'
        : isCounter
          ? 'swipe_counter'
          : isLeft
            ? 'swipe_left'
            : isRight
              ? 'swipe_right'
              : kind === 'mes_block'
                ? 'mes_block'
                : kind === 'ch_name'
                  ? 'ch_name'
                  : kind === 'name_text'
                    ? 'name_text'
                    : kind === 'avatar'
                      ? 'avatar'
                      : isAvatarImg
                        ? ''
                        : kind === 'timestamp'
                          ? 'timestamp'
                          : 'mes' + (numericIndex === resolveLatestMessageIndexCompat() ? ' last_mes' : '');
    const getMessage = () => compatChat[numericIndex] || {};
    const element = createParentVirtualElementCompat(kind + '-' + String(numericIndex), tagName, className, {
      dataset: {
        mesid: String(numericIndex),
        messageId: String(getMessage().message_id ?? getMessage().id ?? numericIndex),
        swipeId: String(getMessage().swipe_id ?? 0),
        is_user: getMessage().is_user ? 'true' : 'false',
      },
      getMessageIndex: () => numericIndex,
      text: () => {
        const message = getMessage();
        if (kind === 'ch_name' || kind === 'name_text') return String(message.name || ctx.characterName || '');
        if (kind === 'timestamp') return String(message.send_date || '');
        if (isCounter) {
          const count = Array.isArray(message.swipes) ? message.swipes.length : 1;
          return String(Number(message.swipe_id || 0) + 1) + '/' + String(Math.max(1, count));
        }
        return message.mes || message.content || '';
      },
      html: () => {
        const message = getMessage();
        return isText
          ? messageFormattingCompat(message.mes || message.content || '', message.name, Boolean(message.is_system), Boolean(message.is_user), numericIndex)
          : message.mes || message.content || '';
      },
      onSetText: (value) => {
        if (!isText) return;
        const message = getMessage();
        setMessageDisplayTextCompat(htmlEscapeCompat(value), message.message_id ?? message.id ?? numericIndex, { index: numericIndex, source: 'parent-dom-text' });
      },
      onSetHtml: (value) => {
        if (!isText) return;
        const message = getMessage();
        setMessageDisplayTextCompat(value, message.message_id ?? message.id ?? numericIndex, { index: numericIndex, source: 'parent-dom-html' });
      },
      click: () => {
        if (isLeft) void swipeCompat(null, -1, { source: 'parent-dom', forceMesId: numericIndex });
        if (isRight) void swipeCompat(null, 1, { source: 'parent-dom', forceMesId: numericIndex });
      },
      matches: (selector) => {
        const normalized = normalizeSelectorCompat(selector);
        if (!normalized) return false;
        if (isText) return selectorHasMessageTextCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'mes_block') return selectorHasMesBlockInnerCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'ch_name' || kind === 'name_text') return selectorHasNameCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'avatar' || isAvatarImg) return selectorHasAvatarCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'timestamp') return selectorHasTimestampCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isButtons) return /\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isLeft) return /swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isRight) return /swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isCounter) return /swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        return selectorHasMessageBlockCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
      },
      closest: (selector, self) => {
        const normalized = normalizeSelectorCompat(selector);
        if (!normalized) return null;
        if (selectorHasMessageTextCompat(normalized) && isText) return self;
        if (selectorHasMessageBlockCompat(normalized)) return isText || isButtons || isCounter || isLeft || isRight || kind !== 'mes'
          ? getParentMessageElementCompat(numericIndex, 'mes')
          : self;
        return self.matches(selector) ? self : null;
      },
    });
    if (isAvatarImg) {
      Object.defineProperty(element, 'src', {
        configurable: true,
        get() {
          const message = getMessage();
          return String(message.force_avatar || message.avatar || message.original_avatar || '');
        },
        set(value) {
          const message = getMessage();
          message.force_avatar = String(value || '');
        },
      });
      element.alt = String(getMessage().name || ctx.characterName || '');
    }
    element.querySelector = (selector) => {
      if (isText || isButtons || isCounter || isLeft || isRight) return null;
      if (selectorHasMesBlockInnerCompat(selector)) return getParentMessageElementCompat(numericIndex, 'mes_block');
      if (selectorHasMessageTextCompat(selector)) return getParentMessageElementCompat(numericIndex, 'mes_text');
      if (/\\.name_text\\b|\\bname_text\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'name_text');
      if (/\\.ch_name\\b|\\bch_name\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'ch_name');
      if (/\\.avatar\\s+img|img\\b/i.test(String(selector || '')) && kind === 'avatar') return getParentMessageElementCompat(numericIndex, 'avatar_img');
      if (/\\.avatar\\b|\\bavatar\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'avatar');
      if (/\\.timestamp\\b|\\btimestamp\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'timestamp');
      if (/\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'mes_buttons');
      if (/swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'swipe_left');
      if (/swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'swipe_right');
      if (/swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'swipe_counter');
      return null;
    };
    element.querySelectorAll = (selector) => {
      const found = element.querySelector(selector);
      return found ? [found] : [];
    };
    parentMessageElementCache.set(key, element);
    return element;
  };
  const submitParentDraftCompat = () => {
    const content = String(parentElementStore.send_textarea?.value || '').trim();
    if (!content) return;
    parentElementStore.send_textarea.value = '';
    post({ type: 'st:setInputDraft', content: '' });
    void sendMessageCompat(content, { source: 'parent-send-button' });
  };
  // 双向同步：Palink 真实输入框变化 → 虚拟 #send_textarea（供 ST 插件读取）。
  // NativeRoleplayChat 的输入框 onChange 会派发 palink:input_draft_changed 事件。
  window.addEventListener('palink:input_draft_changed', (event) => {
    const content = event?.detail?.content;
    if (typeof content === 'string' && parentElementStore?.send_textarea) {
      parentElementStore.send_textarea.value = content;
    }
  });
  Object.assign(parentElementStore, {
    send_textarea: createParentVirtualElementCompat('send_textarea', 'TEXTAREA', 'send_textarea', {
      dispatch(_event, eventType) {
        if (eventType === 'input' || eventType === 'change') {
          post({ type: 'st:setInputDraft', content: String(parentElementStore.send_textarea.value || '') });
        }
      },
    }),
    send_but: createParentVirtualElementCompat('send_but', 'BUTTON', 'send_but', {
      click: submitParentDraftCompat,
    }),
    send_form: createParentVirtualElementCompat('send_form', 'FORM', 'send_form', {
      dispatch(_event, eventType) {
        if (eventType === 'submit') submitParentDraftCompat();
      },
    }),
    chat: createParentVirtualElementCompat('chat', 'DIV', 'chat', {
      text: () => compatChat.map((message) => message.mes || '').join('\\n'),
    }),
    chat_scroll: createParentVirtualElementCompat('chat_scroll', 'DIV', 'chat-scroll chat_container', {
      text: () => compatChat.map((message) => message.mes || '').join('\\n'),
    }),
    last_mes: createParentVirtualElementCompat('last_mes', 'DIV', 'mes last_mes', {
      text: () => compatChat[resolveLatestMessageIndexCompat()]?.mes || ctx.messageContent || '',
      dataset: { is_user: 'false' },
    }),
    mes: createParentVirtualElementCompat('mes', 'DIV', 'mes last_mes', {
      text: () => compatChat[resolveLatestMessageIndexCompat()]?.mes || ctx.messageContent || '',
      dataset: { is_user: 'false' },
    }),
    mes_text: createParentVirtualElementCompat('mes_text', 'DIV', 'mes_text', {
      text: () => compatChat[resolveLatestMessageIndexCompat()]?.mes || ctx.messageContent || '',
      html: () => {
        const index = resolveLatestMessageIndexCompat();
        const message = compatChat[index];
        return messageFormattingCompat(message?.mes || ctx.messageContent || '', message?.name, Boolean(message?.is_system), Boolean(message?.is_user), index);
      },
      onSetText: (value) => {
        const index = resolveLatestMessageIndexCompat();
        const message = compatChat[index];
        setMessageDisplayTextCompat(htmlEscapeCompat(value), message?.message_id ?? message?.id ?? index, { index, source: 'parent-dom-text' });
      },
      onSetHtml: (value) => {
        const index = resolveLatestMessageIndexCompat();
        const message = compatChat[index];
        setMessageDisplayTextCompat(value, message?.message_id ?? message?.id ?? index, { index, source: 'parent-dom-html' });
      },
    }),
    mes_buttons: createParentVirtualElementCompat('mes_buttons', 'DIV', 'mes_buttons'),
    swipe_left: createParentVirtualElementCompat('swipe_left', 'BUTTON', 'swipe_left', {
      click: () => { void swipeCompat(null, -1, { source: 'parent-dom' }); },
    }),
    swipe_right: createParentVirtualElementCompat('swipe_right', 'BUTTON', 'swipe_right', {
      click: () => { void swipeCompat(null, 1, { source: 'parent-dom' }); },
    }),
    swipe_counter: createParentVirtualElementCompat('swipe_counter', 'SPAN', 'swipe_counter', {
      text: () => {
        const message = compatChat[resolveMessageIndex(ctx.messageId, {})];
        const count = Array.isArray(message?.swipes) ? message.swipes.length : 1;
        return String(Number(message?.swipe_id || 0) + 1) + '/' + String(Math.max(1, count));
      },
    }),
  });
  parentElementStore.send_form.requestSubmit = () => parentElementStore.send_but.click();
  parentElementStore.send_form.submit = () => parentElementStore.send_but.click();
  const getParentElementsBySelectorCompat = (selector) => {
    const normalized = normalizeParentSelectorCompat(selector);
    if (!normalized) return [];
    const dynamicIndexes = getMessageIndexesFromSelectorCompat(normalized);
    if (dynamicIndexes.length && (
      selectorHasMessageTextCompat(normalized)
      || selectorHasMesBlockInnerCompat(normalized)
      || selectorHasNameCompat(normalized)
      || selectorHasAvatarCompat(normalized)
      || selectorHasTimestampCompat(normalized)
      || /\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(normalized)
      || selectorHasSwipeElementCompat(normalized)
      || selectorHasMessageBlockCompat(normalized)
    )) {
      let kind = 'mes';
      if (selectorHasMessageTextCompat(normalized)) kind = 'mes_text';
      else if (/\\.name_text\\b|\\bname_text\\b/i.test(normalized)) kind = 'name_text';
      else if (/\\.ch_name\\b|\\bch_name\\b/i.test(normalized)) kind = 'ch_name';
      else if (/\\.avatar\\s+img|img\\b.*\\.avatar|force_avatar|original_avatar/i.test(normalized)) kind = 'avatar_img';
      else if (selectorHasAvatarCompat(normalized)) kind = 'avatar';
      else if (selectorHasTimestampCompat(normalized)) kind = 'timestamp';
      else if (selectorHasMesBlockInnerCompat(normalized)) kind = 'mes_block';
      else if (/\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(normalized)) kind = 'mes_buttons';
      else if (/swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(normalized)) kind = 'swipe_left';
      else if (/swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(normalized)) kind = 'swipe_right';
      else if (/swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(normalized)) kind = 'swipe_counter';
      return dynamicIndexes.map((index) => getParentMessageElementCompat(index, kind)).filter(Boolean);
    }
    return Object.values(parentElementStore).filter((element) => parentSelectorMatchesCompat(normalized, element.id));
  };
  const getParentElementBySelectorCompat = (selector) => {
    return getParentElementsBySelectorCompat(selector)[0] || null;
  };
  const createElementsFromHtmlCompat = (html) => {
    const template = document.createElement('template');
    template.innerHTML = String(html || '').trim();
    return Array.from(template.content.childNodes).filter((node) => node.nodeType === 1);
  };
  const parentDocumentStore = {
    __palinkParentDocument: true,
    getElementById(id) {
      const key = String(id || '').trim();
      return parentElementStore[key] || null;
    },
    querySelector(selector) {
      return getParentElementBySelectorCompat(selector);
    },
    querySelectorAll(selector) {
      return getParentElementsBySelectorCompat(selector);
    },
    getElementsByClassName(className) {
      const wanted = String(className || '').trim();
      if (!wanted) return [];
      if (wanted === 'mes') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes')).filter(Boolean);
      if (wanted === 'last_mes') {
        const latestIndex = resolveLatestMessageIndexCompat();
        return latestIndex >= 0 ? [getParentMessageElementCompat(latestIndex, 'mes')].filter(Boolean) : [];
      }
      if (wanted === 'mes_text') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes_text')).filter(Boolean);
      if (wanted === 'mes_block') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes_block')).filter(Boolean);
      if (wanted === 'ch_name') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'ch_name')).filter(Boolean);
      if (wanted === 'name_text') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'name_text')).filter(Boolean);
      if (wanted === 'avatar') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'avatar')).filter(Boolean);
      if (wanted === 'timestamp') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'timestamp')).filter(Boolean);
      if (wanted === 'mes_buttons') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes_buttons')).filter(Boolean);
      return Object.values(parentElementStore).filter((element) => (
        String(element.className || '').split(/\\s+/).includes(wanted)
      ));
    },
    getElementsByTagName(tagName) {
      const tag = String(tagName || '').toLowerCase();
      if (tag === 'textarea') return [parentElementStore.send_textarea];
      if (tag === 'button') return [parentElementStore.send_but, parentElementStore.swipe_left, parentElementStore.swipe_right];
      if (tag === 'form') return [parentElementStore.send_form];
      return Object.values(parentElementStore).filter((element) => String(element.tagName || '').toLowerCase() === tag);
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    createEvent() { return { initEvent() {} }; },
  };
  const readyCompat = (callback) => {
    if (typeof callback !== 'function') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => callback.call(document), { once: true });
    } else {
      setTimeout(() => callback.call(document), 0);
    }
  };
  const createParentDollarCollectionCompat = (nodes) => {
    const collection = Array.from(nodes || []);
    collection.ready = function(cb) { readyCompat(cb); return this; };
    collection.each = function(cb) {
      if (typeof cb === 'function') this.forEach((node, index) => cb.call(node, index, node));
      return this;
    };
    collection.on = function(type, selectorOrCallback, maybeCallback) {
      const eventType = String(type || '');
      const hasDelegatedSelector = typeof selectorOrCallback === 'string';
      const cb = hasDelegatedSelector ? maybeCallback : selectorOrCallback;
      if (typeof cb !== 'function') return this;
      const delegatedNodes = hasDelegatedSelector ? getParentElementsBySelectorCompat(selectorOrCallback) : [];
      const targets = Array.from(new Set([...(this || []), ...delegatedNodes]));
      targets.forEach((node) => node.addEventListener?.(eventType, function(event) {
        if (!hasDelegatedSelector || node.matches?.(selectorOrCallback) || event?.target?.matches?.(selectorOrCallback)) {
          return cb.call(node, event, event?.target || node);
        }
        return undefined;
      }));
      return this;
    };
    collection.off = function(type, cb) {
      this.forEach((node) => node.removeEventListener?.(type, cb));
      return this;
    };
    collection.click = function(cb) {
      if (typeof cb === 'function') return this.on('click', cb);
      this.forEach((node) => node.click?.());
      return this;
    };
    collection.submit = function(cb) {
      if (typeof cb === 'function') return this.on('submit', cb);
      this.forEach((node) => node.requestSubmit?.() || node.submit?.());
      return this;
    };
    collection.val = function(value) {
      if (value === undefined) return this[0]?.value ?? '';
      this.forEach((node) => {
        if ('value' in node) node.value = String(value ?? '');
      });
      return this;
    };
    collection.trigger = function(type) {
      const eventType = typeof type === 'string' ? type : type?.type;
      if (!eventType) return this;
      this.forEach((node) => {
        if (eventType === 'click' && typeof node.click === 'function') {
          node.click();
          return;
        }
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        node.dispatchEvent?.(event);
        if (eventType === 'submit' && !event.defaultPrevented) node.requestSubmit?.();
      });
      return this;
    };
    collection.text = function(value) {
      if (value === undefined) return this.map((node) => node.textContent || '').join('');
      this.forEach((node) => { try { node.textContent = String(value ?? ''); } catch {} });
      return this;
    };
    collection.html = function(value) {
      if (value === undefined) return this[0]?.innerHTML ?? '';
      this.forEach((node) => { try { node.innerHTML = String(value ?? ''); } catch {} });
      return this;
    };
    collection.append = function(value) {
      this.forEach((node) => {
        try {
          if (value?.nodeType) {
            node.appendChild?.(value);
          } else if (Array.isArray(value) || typeof value?.get === 'function') {
            const values = typeof value.get === 'function' ? value.get() : value;
            values.forEach((item) => item?.nodeType ? node.appendChild?.(item) : node.insertAdjacentHTML?.('beforeend', String(item ?? '')));
          } else if (value?.__palinkParentElement) {
            node.insertAdjacentHTML?.('beforeend', value.innerHTML || '');
          } else {
            node.insertAdjacentHTML?.('beforeend', String(value ?? ''));
          }
        } catch {}
      });
      return this;
    };
    collection.prepend = function(value) {
      this.forEach((node) => {
        try {
          if (value?.nodeType) {
            node.insertBefore?.(value, node.firstChild || null);
          } else if (Array.isArray(value) || typeof value?.get === 'function') {
            const values = typeof value.get === 'function' ? value.get() : value;
            values.slice().reverse().forEach((item) => item?.nodeType
              ? node.insertBefore?.(item, node.firstChild || null)
              : node.insertAdjacentHTML?.('afterbegin', String(item ?? '')));
          } else if (value?.__palinkParentElement) {
            node.insertAdjacentHTML?.('afterbegin', value.innerHTML || '');
          } else {
            node.insertAdjacentHTML?.('afterbegin', String(value ?? ''));
          }
        } catch {}
      });
      return this;
    };
    collection.appendTo = function(target) {
      const targets = typeof target === 'string'
        ? parentDollarCompat(target)
        : createParentDollarCollectionCompat(target?.nodeType ? [target] : Array.from(target || []));
      targets.append(this);
      return this;
    };
    collection.prependTo = function(target) {
      const targets = typeof target === 'string'
        ? parentDollarCompat(target)
        : createParentDollarCollectionCompat(target?.nodeType ? [target] : Array.from(target || []));
      targets.prepend(this);
      return this;
    };
    collection.remove = function() {
      this.forEach((node) => { try { node.remove?.(); } catch {} });
      return this;
    };
    collection.show = function() {
      this.forEach((node) => { try { node.style.display = ''; } catch {} });
      return this;
    };
    collection.hide = function() {
      this.forEach((node) => { try { node.style.display = 'none'; } catch {} });
      return this;
    };
    collection.empty = function() {
      this.forEach((node) => { try { node.innerHTML = ''; } catch {} });
      return this;
    };
    collection.find = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.querySelectorAll?.(selector) || []));
      return createParentDollarCollectionCompat(nodes);
    };
    collection.closest = function(selector) {
      const nodes = this.map((node) => node.closest?.(selector)).filter(Boolean);
      return createParentDollarCollectionCompat(nodes);
    };
    collection.filter = function(selectorOrCallback) {
      const nodes = typeof selectorOrCallback === 'function'
        ? Array.prototype.filter.call(this, (node, index) => selectorOrCallback.call(node, index, node))
        : Array.prototype.filter.call(this, (node) => node.matches?.(selectorOrCallback));
      return createParentDollarCollectionCompat(nodes);
    };
    collection.first = function() { return createParentDollarCollectionCompat(this.length ? [this[0]] : []); };
    collection.last = function() { return createParentDollarCollectionCompat(this.length ? [this[this.length - 1]] : []); };
    collection.eq = function(index) {
      const resolved = Number(index) < 0 ? this.length + Number(index) : Number(index);
      return createParentDollarCollectionCompat(this[resolved] ? [this[resolved]] : []);
    };
    collection.addClass = function(value) {
      const classes = String(value || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        const current = new Set(String(node.className || '').split(/\\s+/).filter(Boolean));
        classes.forEach((item) => current.add(item));
        node.className = Array.from(current).join(' ');
      });
      return this;
    };
    collection.removeClass = function(value) {
      const classes = String(value || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        const current = new Set(String(node.className || '').split(/\\s+/).filter(Boolean));
        classes.forEach((item) => current.delete(item));
        node.className = Array.from(current).join(' ');
      });
      return this;
    };
    collection.hasClass = function(value) {
      return String(this[0]?.className || '').split(/\\s+/).includes(String(value || ''));
    };
    collection.css = function(name, value) {
      if (typeof name === 'string' && value === undefined) return this[0]?.style?.[name] || '';
      this.forEach((node) => {
        if (!node.style) node.style = {};
        if (typeof name === 'object') Object.entries(name).forEach(([key, val]) => { node.style[key] = String(val ?? ''); });
        else node.style[name] = String(value ?? '');
      });
      return this;
    };
    collection.attr = function(name, value) {
      if (typeof name === 'string' && value === undefined) return this[0]?.getAttribute?.(name);
      this.forEach((node) => {
        if (typeof name === 'object') {
          Object.entries(name).forEach(([key, val]) => node.setAttribute?.(key, String(val)));
        } else if (value === null) {
          node.removeAttribute?.(name);
        } else {
          node.setAttribute?.(name, String(value));
        }
      });
      return this;
    };
    collection.prop = function(name, value) {
      if (typeof name === 'string' && value === undefined) return this[0]?.[name];
      this.forEach((node) => {
        if (typeof name === 'object') {
          Object.entries(name).forEach(([key, val]) => { try { node[key] = val; } catch {} });
        } else {
          try { node[name] = value; } catch {}
        }
      });
      return this;
    };
    collection.get = function(index) {
      if (index === undefined) return Array.from(this);
      const resolved = Number(index) < 0 ? this.length + Number(index) : Number(index);
      return this[resolved];
    };
    // [STATUSBAR-COMPAT] 补齐 ST 卡片/插件脚本常用的 jQuery 方法（父级集合缺这些会抛
    // "xxx is not a function"，如 $("selector").blur()）。方法与 jQuery 语义对齐。
    collection.blur = function(cb) {
      if (typeof cb === 'function') return this.on('blur', cb);
      this.forEach((node) => { try { node.blur?.(); } catch {} });
      return this;
    };
    collection.focus = function(cb) {
      if (typeof cb === 'function') return this.on('focus', cb);
      this.forEach((node) => { try { node.focus?.(); } catch {} });
      return this;
    };
    collection.toggle = function(force) {
      this.forEach((node) => {
        const wantVisible = force === undefined ? (node.style.display === 'none') : Boolean(force);
        node.style.display = wantVisible ? '' : 'none';
      });
      return this;
    };
    collection.toggleClass = function(value, force) {
      const classes = String(value || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        classes.forEach((cls) => {
          const has = String(node.className || '').split(/\\s+/).includes(cls);
          const add = force === undefined ? !has : Boolean(force);
          if (add && !has) node.className = (String(node.className || '') + ' ' + cls).replace(/^\\s+/, '');
          if (!add && has) node.className = String(node.className || '').split(/\\s+/).filter((c) => c !== cls).join(' ');
        });
      });
      return this;
    };
    collection.is = function(selector) {
      return this.some((node) => {
        if (typeof node.matches === 'function') return node.matches(selector);
        return false;
      });
    };
    collection.not = function(selectorOrNodes) {
      const excluded = typeof selectorOrNodes === 'string'
        ? Array.from(document.querySelectorAll(selectorOrNodes))
        : Array.from(selectorOrNodes || []);
      return createParentDollarCollectionCompat(this.filter((node) => !excluded.includes(node)));
    };
    collection.children = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.children || []));
      return createParentDollarCollectionCompat(selector ? nodes.filter((n) => n.matches?.(selector)) : nodes);
    };
    collection.parent = function() {
      const nodes = this.map((node) => node.parentNode).filter(Boolean);
      return createParentDollarCollectionCompat(Array.from(new Set(nodes)));
    };
    collection.parents = function(selector) {
      const nodes = this.flatMap((node) => {
        const out = [];
        let p = node.parentNode;
        while (p && p.nodeType === 1) {
          if (!selector || p.matches?.(selector)) out.push(p);
          p = p.parentNode;
        }
        return out;
      });
      return createParentDollarCollectionCompat(Array.from(new Set(nodes)));
    };
    collection.siblings = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.parentNode?.children || []).filter((s) => s !== node));
      return createParentDollarCollectionCompat(selector ? nodes.filter((n) => n.matches?.(selector)) : nodes);
    };
    collection.index = function(selector) {
      if (selector !== undefined) {
        const target = typeof selector === 'string' ? document.querySelector(selector) : (selector && selector[0]);
        return this.indexOf(target);
      }
      const node = this[0];
      if (!node?.parentNode) return -1;
      return Array.from(node.parentNode.children).indexOf(node);
    };
    collection.width = function(value) {
      if (value === undefined) return this[0]?.offsetWidth ?? 0;
      this.forEach((node) => { node.style.width = String(typeof value === 'number' ? value + 'px' : value ?? ''); });
      return this;
    };
    collection.height = function(value) {
      if (value === undefined) return this[0]?.offsetHeight ?? 0;
      this.forEach((node) => { node.style.height = String(typeof value === 'number' ? value + 'px' : value ?? ''); });
      return this;
    };
    collection.outerWidth = function() { return this[0]?.offsetWidth ?? 0; };
    collection.outerHeight = function() { return this[0]?.offsetHeight ?? 0; };
    collection.data = function(key, value) {
      if (value === undefined) {
        if (key === undefined) {
          const all = {};
          this[0]?.getAttributeNames?.().forEach((name) => {
            if (name.startsWith('data-')) all[name.slice(5)] = this[0].getAttribute(name);
          });
          return all;
        }
        return this[0]?.getAttribute?.('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
      }
      this.forEach((node) => node.setAttribute?.('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(value)));
      return this;
    };
    collection.before = function(value) {
      this.forEach((node) => {
        try {
          if (value?.nodeType) node.parentNode?.insertBefore?.(value.cloneNode?.(true) ?? value, node);
          else node.insertAdjacentHTML?.('beforebegin', String(value ?? ''));
        } catch {}
      });
      return this;
    };
    collection.after = function(value) {
      this.forEach((node) => {
        try {
          if (value?.nodeType) node.parentNode?.insertBefore?.(value.cloneNode?.(true) ?? value, node.nextSibling);
          else node.insertAdjacentHTML?.('afterend', String(value ?? ''));
        } catch {}
      });
      return this;
    };
    collection.wrap = function(wrapper) {
      this.forEach((node) => {
        try {
          const wrapEl = typeof wrapper === 'string' ? document.createElement(wrapper) : wrapper.cloneNode?.(true);
          if (!wrapEl) return;
          node.parentNode?.insertBefore?.(wrapEl, node);
          wrapEl.appendChild?.(node);
        } catch {}
      });
      return this;
    };
    collection.unwrap = function() {
      this.forEach((node) => {
        try {
          const parent = node.parentNode;
          if (parent && parent.parentNode) {
            while (parent.firstChild) parent.parentNode.insertBefore(parent.firstChild, parent);
            parent.remove();
          }
        } catch {}
      });
      return this;
    };
    collection.hover = function(inCb, outCb) {
      if (typeof inCb === 'function') this.on('mouseenter', inCb);
      if (typeof outCb === 'function') this.on('mouseleave', outCb);
      return this;
    };
    collection.one = function(type, selectorOrCallback, maybeCallback) {
      const eventType = String(type || '');
      const cb = typeof selectorOrCallback === 'string' ? maybeCallback : selectorOrCallback;
      if (typeof cb !== 'function') return this;
      this.forEach((node) => {
        const handler = function(event) {
          node.removeEventListener(eventType, handler);
          cb.call(node, event, event?.target || node);
        };
        node.addEventListener(eventType, handler);
      });
      return this;
    };
    collection.scrollTop = function(value) {
      if (value === undefined) return this[0]?.scrollTop ?? 0;
      this.forEach((node) => { node.scrollTop = value; });
      return this;
    };
    collection.offset = function() {
      const r = this[0]?.getBoundingClientRect?.();
      if (!r) return undefined;
      return { top: r.top + (window.scrollY || 0), left: r.left + (window.scrollX || 0) };
    };
    collection.position = function() {
      const node = this[0];
      if (!node) return undefined;
      const offsetParent = node.offsetParent;
      if (!offsetParent) return { top: 0, left: 0 };
      const r = node.getBoundingClientRect();
      const pr = offsetParent.getBoundingClientRect();
      return { top: r.top - pr.top, left: r.left - pr.left };
    };
    collection.fadeIn = function() { return this.show(); };
    collection.fadeOut = function() { return this.hide(); };
    collection.fadeToggle = function() { return this.toggle(); };
    collection.slideToggle = function() { return this.toggle(); };
    collection.slideUp = function() { return this.hide(); };
    collection.slideDown = function() { return this.show(); };
    collection.animate = function() { return this; };
    collection.delay = function() { return this; };
    collection.serialize = function() {
      const getVal = (node) => {
        if (node.name === undefined) return [];
        if (['checkbox', 'radio'].includes(node.type)) return node.checked ? [[node.name, node.value]] : [];
        return [[node.name, node.value]];
      };
      return this.flatMap((node) => getVal(node).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))).join('&');
    };
    // 其余未显式定义的方法：通用委托到原生 DOM 方法（$el.blur() → el.blur()），
    // 避免未知 jQuery 方法抛 "is not a function"；若元素无该原生方法则空转返回自身以支持链式。
    const nativeFallback = new Proxy(collection, {
      get(target, prop, receiver) {
        if (prop in target || prop in Array.prototype || typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver);
        }
        return function(...args) {
          target.forEach((node) => {
            try { if (typeof node[prop] === 'function') node[prop].apply(node, args); } catch {}
          });
          return target;
        };
      },
    });
    return nativeFallback;
  };
  // [STATUSBAR-COMPAT] 仅接受真实 jQuery（带 fn.jquery 版本标识），排除 legacyShim 注入的
  // 简易 dollar（其集合缺少 .blur() 等 jQuery 方法）。若误捕获 legacy dollar，委托会返回
  // 无 blur 方法的集合，导致 $("...").blur() 抛 "is not a function"。真实 jQuery 由卡片
  // <script src> 加载后通过下方 bridge setter 更新 realDollarCompat。
  // 注意：本函数位于 buildSillyTavernCompatRuntimeV2Shim 的模板字符串内，TS 不会剥离
  // 类型标注，故不写 (fn: unknown): boolean / as any，避免生成非法 JS（Unexpected token ':'）。
  const isRealJQueryCompat = (fn) =>
    typeof fn === 'function' && Boolean(fn?.fn?.jquery);
  let realDollarCompat = (() => {
    if (isRealJQueryCompat(window.jQuery)) return window.jQuery;
    if (isRealJQueryCompat(window.$)) return window.$;
    return null;
  })();
  let bridgedDollarCompat;
  const fallbackDollarCompat = (arg) => {
    if (typeof arg === 'function') {
      readyCompat(arg);
      return createParentDollarCollectionCompat([document]);
    }
    if (arg === parentDocumentStore || arg?.__palinkParentElement) {
      return createParentDollarCollectionCompat([arg]);
    }
    if (typeof arg === 'string') {
      if (/^\\s*</.test(arg)) return createParentDollarCollectionCompat(createElementsFromHtmlCompat(arg));
      ensureStExtensionSettingsSelectorCompat(arg);
      try { return createParentDollarCollectionCompat(Array.from(document.querySelectorAll(arg))); } catch {}
    }
    if (arg?.nodeType) return createParentDollarCollectionCompat([arg]);
    if (Array.isArray(arg)) return createParentDollarCollectionCompat(arg);
    return createParentDollarCollectionCompat([]);
  };
  const parentDollarCompat = (arg, ...args) => {
    if (typeof arg === 'function') {
      if (typeof realDollarCompat === 'function' && realDollarCompat !== bridgedDollarCompat) {
        return realDollarCompat(arg, ...args);
      }
      readyCompat(arg);
      return createParentDollarCollectionCompat([document]);
    }
    if (arg === parentDocumentStore || arg?.__palinkParentElement) {
      return createParentDollarCollectionCompat([arg]);
    }
    if (typeof arg === 'string') {
      if (/^\\s*</.test(arg)) return createParentDollarCollectionCompat(createElementsFromHtmlCompat(arg));
      ensureStExtensionSettingsSelectorCompat(arg);
      const parentElements = getParentElementsBySelectorCompat(arg);
      if (parentElements.length) return createParentDollarCollectionCompat(parentElements);
    }
    if (typeof realDollarCompat === 'function' && realDollarCompat !== bridgedDollarCompat) {
      return realDollarCompat(arg, ...args);
    }
    return fallbackDollarCompat(arg);
  };
  bridgedDollarCompat = new Proxy(function(arg, ...args) {
    return parentDollarCompat(arg, ...args);
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return realDollarCompat?.[prop];
    },
    set(target, prop, value) {
      if (realDollarCompat && realDollarCompat !== target) {
        try { realDollarCompat[prop] = value; return true; } catch {}
      }
      target[prop] = value;
      return true;
    },
    apply(_target, thisArg, args) {
      return parentDollarCompat.apply(thisArg, args);
    },
  });
  const installDollarBridgeCompat = (name) => {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return bridgedDollarCompat; },
        set(value) {
          if (isRealJQueryCompat(value) && value !== bridgedDollarCompat) realDollarCompat = value;
        },
      });
    } catch {
      window[name] = bridgedDollarCompat;
    }
  };
  installDollarBridgeCompat('$');
  installDollarBridgeCompat('jQuery');
  const resolveMessageIndex = (messageId = ctx.messageId, options = {}) => {
    if (Number.isFinite(Number(options?.index))) {
      const byOption = Number(options.index);
      if (byOption >= 0 && byOption < compatChat.length) return byOption;
    }
    if (messageId !== undefined && messageId !== null && messageId !== '') {
      const byId = compatChat.findIndex((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId));
      if (byId >= 0) return byId;
      const asIndex = Number(messageId);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < compatChat.length) return asIndex;
    }
    if (currentMessageIndex >= 0 && currentMessageIndex < compatChat.length) return currentMessageIndex;
    return compatChat.length > 0 ? compatChat.length - 1 : 0;
  };
  const resolveLatestMessageIndexCompat = () => {
    for (let index = compatChat.length - 1; index >= 0; index -= 1) {
      const message = compatChat[index];
      if (message && !message.is_system) return index;
    }
    return resolveMessageIndex(ctx.messageId, {});
  };
  // ST 兼容：插件读取消息文本时剥离 Palink 渲染专用的 <style> 块（原版 ST 的 mes
  // 是纯文本不含 <style>）。仅作用于返回副本，不影响内部 compatChat（回写/更新逻辑
  // 仍使用原始内容）。
  const stripStyleBlocksForPlugin = (message) => {
    if (!message || typeof message !== 'object') return message;
    const clean = (value) => String(value ?? '').replace(/<style[\\s\\S]*?<\\/style>/gi, '');
    const next = { ...message };
    if (typeof next.mes === 'string') next.mes = clean(next.mes);
    if (typeof next.message === 'string') next.message = clean(next.message);
    if (typeof next.text === 'string') next.text = clean(next.text);
    if (typeof next.content === 'string') next.content = clean(next.content);
    if (Array.isArray(next.swipes)) next.swipes = next.swipes.map(clean);
    return next;
  };
  const getCompatChatMessages = (messageId) => {
    const messages = compatChat;
    if (messageId === undefined || messageId === null || messageId === '') return messages.slice().map(stripStyleBlocksForPlugin);
    if (Number.isInteger(Number(messageId)) && Number(messageId) >= 0) {
      const byIndex = messages[Number(messageId)];
      return byIndex ? [stripStyleBlocksForPlugin(byIndex)] : [];
    }
    return messages.filter((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId)).map(stripStyleBlocksForPlugin);
  };
  const setMessageDisplayTextCompat = (html, messageId = ctx.messageId, options = {}) => {
    const index = resolveMessageIndex(messageId, options);
    const message = compatChat[index];
    if (!message) return false;
    const displayText = String(html ?? '');
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra.display_text = displayText;
    ensureSwipeInfoShape(message);
    const swipeIndex = Math.max(0, Math.min(Number(message.swipe_id || 0), message.swipe_info.length - 1));
    message.swipe_info[swipeIndex] = {
      ...(message.swipe_info[swipeIndex] || {}),
      send_date: message.swipe_info[swipeIndex]?.send_date || message.send_date || '',
      extra: {
        ...(message.swipe_info[swipeIndex]?.extra || {}),
        display_text: displayText,
      },
    };
    syncCtxMessageFromCompat(index);
    emitCompatEvent(window.event_types?.MESSAGE_UPDATED || 'message_updated', index, message);
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return true;
    }
    requestParent('setChatMessage', {
      content: message.mes || message.content || '',
      messageId: message.message_id ?? message.id ?? index,
      index,
      options: {
        __palinkHasExplicitContent: false,
        localOnly: true,
        refresh: 'display',
        swipe_id: message.swipe_id,
        swipes: message.swipes,
        swipe_info: message.swipe_info,
        extra: message.extra,
        display_text: displayText,
      },
    }).catch((error) => {
      post({ type: 'error', message: String(error?.message || error) });
    });
    return true;
  };
  const normalizeMessageUpdatePayload = (content, targetMessage, options = {}) => {
    const messageObject = content && typeof content === 'object' ? content : {};
    const mergedOptions = { ...(options && typeof options === 'object' ? options : {}) };
    const hasExplicitContent = Boolean(
      typeof content === 'string'
      || typeof messageObject.content === 'string'
      || typeof messageObject.mes === 'string'
      || typeof messageObject.message === 'string'
      || typeof messageObject.text === 'string'
      || mergedOptions.__palinkHasExplicitContent === true
    );
    const extra = messageObject.extra && typeof messageObject.extra === 'object'
      ? { ...(mergedOptions.extra && typeof mergedOptions.extra === 'object' ? mergedOptions.extra : {}), ...clone(messageObject.extra) }
      : mergedOptions.extra;
    const displayText = mergedOptions.display_text
      ?? mergedOptions.displayText
      ?? messageObject.display_text
      ?? messageObject.displayText;
    const normalizedExtra = typeof displayText === 'string'
      ? { ...(extra && typeof extra === 'object' ? extra : {}), display_text: displayText }
      : extra;
    const resolvedContent = typeof content === 'string'
      ? content
      : String(
        messageObject.content
        ?? messageObject.mes
        ?? messageObject.message
        ?? messageObject.text
        ?? targetMessage?.mes
        ?? targetMessage?.content
        ?? '',
      );
    return {
      content: resolvedContent,
      hasExplicitContent,
      options: {
        ...mergedOptions,
        __palinkHasExplicitContent: hasExplicitContent,
        role: mergedOptions.role ?? messageObject.role,
        name: mergedOptions.name ?? messageObject.name,
        is_user: mergedOptions.is_user ?? messageObject.is_user,
        is_system: mergedOptions.is_system ?? messageObject.is_system,
        is_name: mergedOptions.is_name ?? messageObject.is_name,
        force_avatar: mergedOptions.force_avatar ?? mergedOptions.forceAvatar ?? messageObject.force_avatar ?? messageObject.forceAvatar,
        original_avatar: mergedOptions.original_avatar ?? mergedOptions.originalAvatar ?? messageObject.original_avatar ?? messageObject.originalAvatar,
        avatar: mergedOptions.avatar ?? messageObject.avatar,
        gen_id: mergedOptions.gen_id ?? mergedOptions.genId ?? messageObject.gen_id ?? messageObject.genId,
        group_id: mergedOptions.group_id ?? mergedOptions.groupId ?? messageObject.group_id ?? messageObject.groupId,
        group_name: mergedOptions.group_name ?? mergedOptions.groupName ?? messageObject.group_name ?? messageObject.groupName,
        selected_group: mergedOptions.selected_group ?? mergedOptions.selectedGroup ?? messageObject.selected_group ?? messageObject.selectedGroup,
        groups: mergedOptions.groups ?? messageObject.groups,
        swipe_id: mergedOptions.swipe_id ?? mergedOptions.swipeId ?? messageObject.swipe_id ?? messageObject.swipeId,
        swipes: Array.isArray(mergedOptions.swipes)
          ? mergedOptions.swipes
          : Array.isArray(messageObject.swipes)
            ? messageObject.swipes
            : undefined,
        swipe_info: Array.isArray(mergedOptions.swipe_info)
          ? mergedOptions.swipe_info
          : Array.isArray(messageObject.swipe_info)
            ? messageObject.swipe_info
            : undefined,
        display_text: typeof displayText === 'string' ? displayText : mergedOptions.display_text,
        extra: normalizedExtra,
      },
    };
  };
  const setChatMessageCompat = async (content, messageId = ctx.messageId, options = {}) => {
    const targetIndex = resolveMessageIndex(messageId, options);
    const existingTarget = compatChat[targetIndex];
    const normalizedUpdate = normalizeMessageUpdatePayload(content, existingTarget, options);
    const normalizedContent = normalizedUpdate.content;
    const shouldUpdateContent = normalizedUpdate.hasExplicitContent || !existingTarget;
    const normalizedOptions = normalizedUpdate.options;
    const targetMessage = existingTarget || normalizeChatMessage({ id: messageId, role: 'assistant', content: normalizedContent }, targetIndex);
    compatChat[targetIndex] = targetMessage;
    if (typeof normalizedOptions.role === 'string') targetMessage.role = normalizedOptions.role;
    if (typeof normalizedOptions.name === 'string') targetMessage.name = normalizedOptions.name;
    if (typeof normalizedOptions.is_user === 'boolean') targetMessage.is_user = normalizedOptions.is_user;
    if (typeof normalizedOptions.is_system === 'boolean') targetMessage.is_system = normalizedOptions.is_system;
    const nextSwipes = Array.isArray(normalizedOptions?.swipes) && normalizedOptions.swipes.length
      ? normalizedOptions.swipes.map((item) => String(item ?? ''))
      : Array.isArray(targetMessage.swipes) && targetMessage.swipes.length
        ? targetMessage.swipes.slice()
        : [normalizedContent];
    const nextSwipeId = Number.isFinite(Number(normalizedOptions?.swipe_id ?? normalizedOptions?.swipeId))
      ? Math.max(0, Number(normalizedOptions?.swipe_id ?? normalizedOptions?.swipeId))
      : Number(targetMessage.swipe_id || 0);
    while (nextSwipes.length <= nextSwipeId) nextSwipes.push('');
    if (shouldUpdateContent) nextSwipes[nextSwipeId] = normalizedContent;
    targetMessage.swipes = nextSwipes;
    targetMessage.swipe_id = Math.max(0, Math.min(nextSwipeId, nextSwipes.length - 1));
    if (shouldUpdateContent) {
      targetMessage.mes = normalizedContent;
      targetMessage.content = normalizedContent;
      targetMessage.message = normalizedContent;
      targetMessage.text = normalizedContent;
    }
    if (normalizedOptions?.extra && typeof normalizedOptions.extra === 'object') {
      const nextExtra = stripSwipeInfoFromExtra(normalizedOptions.extra);
      targetMessage.extra = normalizedOptions.replaceExtra
        ? nextExtra
        : { ...(targetMessage.extra || {}), ...nextExtra };
    } else {
      targetMessage.extra = normalizedOptions.replaceExtra ? {} : (targetMessage.extra || {});
    }
    applyStMessageMeta(targetMessage, normalizedOptions, targetMessage.extra || {});
    if (Array.isArray(normalizedOptions.swipe_info)) {
      targetMessage.swipe_info = normalizedOptions.swipe_info.map((entry) => normalizeSwipeInfoEntry(entry, targetMessage.extra, targetMessage.send_date || ''));
    }
    syncMesToSwipeCompat(targetMessage);
    syncCtxMessageFromCompat(targetIndex);
    emitCompatEvent(window.event_types?.MESSAGE_UPDATED || 'message_updated', targetIndex, targetMessage);
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return { success: true, content: normalizedContent, message: targetMessage };
    }
    const targetMessageId = targetMessage.message_id ?? targetMessage.id ?? messageId;
    return requestParent('setChatMessage', {
      content: normalizedContent,
      messageId: targetMessageId,
      index: targetIndex,
      options: {
        ...normalizedOptions,
        __palinkHasExplicitContent: shouldUpdateContent,
        swipe_id: targetMessage.swipe_id,
        swipes: targetMessage.swipes,
        swipe_info: targetMessage.swipe_info,
        extra: targetMessage.extra,
      },
    });
  };
  const addOneMessageCompat = async (message, options = {}) => {
    const content = typeof message === 'string'
      ? message
      : String(message?.mes ?? message?.content ?? message?.message ?? '');
    if (!content) return true;
    const forceId = Number.isInteger(Number(options?.forceId)) ? Number(options.forceId) : null;
    const insertAfter = Number.isInteger(Number(options?.insertAfter)) ? Number(options.insertAfter) : null;
    const insertBefore = Number.isInteger(Number(options?.insertBefore)) ? Number(options.insertBefore) : null;
    const shouldReplaceSwipe = options?.type === 'swipe';
    const index = shouldReplaceSwipe
      ? resolveMessageIndex(message?.message_id ?? message?.id ?? ctx.messageId, {})
      : forceId !== null
        ? Math.max(0, Math.min(forceId, compatChat.length))
        : insertBefore !== null
          ? Math.max(0, Math.min(insertBefore, compatChat.length))
          : insertAfter !== null
            ? Math.max(0, Math.min(insertAfter + 1, compatChat.length))
            : compatChat.length;
    const normalized = normalizeChatMessage({
      ...(typeof message === 'string' ? {} : message),
      content,
      role: typeof message === 'string'
        ? 'assistant'
        : (message?.role || (message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant')),
    }, index);
    const messageObject = typeof message === 'string' ? {} : (message || {});
    const appendDisplayText = options?.display_text
      ?? options?.displayText
      ?? messageObject.display_text
      ?? messageObject.displayText;
    if (shouldReplaceSwipe && compatChat[index]) {
      compatChat[index] = normalized;
    } else if (index >= compatChat.length) {
      compatChat.push(normalized);
    } else {
      compatChat.splice(index, 0, normalized);
    }
    compatChat.forEach((item, itemIndex) => { item.mesid = itemIndex; });
    syncSwipeToMesCompat(normalized, normalized.swipe_id);
    if (typeof appendDisplayText === 'string') {
      normalized.extra = { ...(normalized.extra || {}), display_text: appendDisplayText };
      syncMesToSwipeCompat(normalized);
    }
    const insertedIndex = compatChat.indexOf(normalized);
    const persistedIndex = insertedIndex >= 0 ? insertedIndex : index;
    if (normalized.is_user) {
      emitCompatEvent(window.event_types?.MESSAGE_SENT || 'message_sent', index, normalized);
      emitCompatEvent(window.event_types?.USER_MESSAGE_RENDERED || 'user_message_rendered', index, normalized);
    } else {
      emitCompatEvent(window.event_types?.MESSAGE_RECEIVED || 'message_received', index, normalized);
      emitCompatEvent(window.event_types?.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered', index, normalized);
    }
    const response = await requestParent('addOneMessage', {
      content,
      role: normalized.role,
      name: normalized.name,
      is_user: normalized.is_user,
      is_system: normalized.is_system,
      is_name: normalized.is_name,
      force_avatar: normalized.force_avatar,
      original_avatar: normalized.original_avatar,
      avatar: normalized.avatar,
      gen_id: normalized.gen_id,
      group_id: normalized.group_id,
      group_name: normalized.group_name,
      selected_group: clone(normalized.selected_group),
      groups: clone(normalized.groups),
      swipe_id: normalized.swipe_id,
      swipes: normalized.swipes,
      swipe_info: normalized.swipe_info,
      extra: normalized.extra,
      model: typeof message === 'string' ? undefined : message?.model,
      options,
    });
    if (response?.message && typeof response.message === 'object') {
      compatChat[persistedIndex] = normalizeChatMessage(response.message, persistedIndex);
      syncMessageAliases(compatChat[persistedIndex]);
      syncCtxMessageFromCompat(persistedIndex);
    } else {
      refreshGroupContextCompat();
    }
    return response?.success === false ? false : (response || true);
  };
  const deleteMessageCompat = async (messageId = ctx.messageId, options = {}) => {
    const index = resolveMessageIndex(messageId, options);
    if (index < 0 || index >= compatChat.length) return false;
    const [removed] = compatChat.splice(index, 1);
    compatChat.forEach((item, itemIndex) => { item.mesid = itemIndex; });
    const nextIndex = Math.max(0, Math.min(index, compatChat.length - 1));
    syncCtxMessageFromCompat(nextIndex);
    refreshGroupContextCompat();
    emitCompatEvent(window.event_types?.MESSAGE_DELETED || 'message_deleted', index, removed);
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return true;
    }
    const response = await requestParent('deleteMessage', {
      messageId: removed?.message_id ?? removed?.id ?? messageId,
      index,
      options: normalizedOptions,
    });
    return response?.success === false ? false : true;
  };
  const deleteLastMessageCompat = async (options = {}) => {
    if (!compatChat.length) return false;
    return deleteMessageCompat(compatChat.length - 1, options);
  };
  const printMessagesCompat = async (...args) => {
    emitCompatEvent(window.event_types?.CHAT_CHANGED || 'chat_id_changed', compatChat);
    post({ type: 'refresh', args });
    return true;
  };
  const clearChatCompat = async (options = {}) => {
    compatChat.splice(0, compatChat.length);
    syncCtxMessageFromCompat(0);
    refreshGroupContextCompat();
    emitCompatEvent(window.event_types?.CHAT_CHANGED || 'chat_id_changed', compatChat);
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return true;
    }
    const response = await requestParent('clearChat', { options: normalizedOptions });
    return response?.success === false ? false : true;
  };
  const switchSwipeCompat = async (messageId = ctx.messageId, swipeId = 0) => {
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message || !Array.isArray(message.swipes) || message.swipes.length === 0) return false;
    const nextSwipeId = Math.max(0, Math.min(Number(swipeId) || 0, message.swipes.length - 1));
    syncSwipeToMesCompat(message, nextSwipeId);
    syncCtxMessageFromCompat(index);
    emitCompatEvent(window.event_types?.MESSAGE_SWIPED || 'message_swiped', index, nextSwipeId, message);
    await setChatMessageCompat(message.mes, message.message_id ?? message.id ?? index, {
      index,
      swipe_id: nextSwipeId,
      swipes: message.swipes,
      swipe_info: message.swipe_info,
      extra: message.extra || {},
      refresh: 'display',
    });
    return true;
  };
  const syncMesToSwipeByIdCompat = (messageId = ctx.messageId) => {
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message) return false;
    syncMesToSwipeCompat(message);
    syncCtxMessageFromCompat(index);
    return true;
  };
  const syncSwipeToMesByIdCompat = (messageId = ctx.messageId, swipeId = null) => {
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message) return false;
    syncSwipeToMesCompat(message, swipeId ?? message.swipe_id);
    syncCtxMessageFromCompat(index);
    return true;
  };
  const getSwipeTargetFromOptionsCompat = (options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    return opts.forceMesId ?? opts.messageId ?? opts.mesId ?? ctx.messageId;
  };
  const swipeCompat = async (_event = null, direction = 1, options = {}) => {
    const messageId = getSwipeTargetFromOptionsCompat(options);
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message) return false;
    const explicitSwipeId = options && typeof options === 'object'
      ? options.forceSwipeId ?? options.swipeId ?? options.swipe_id
      : undefined;
    const nextSwipeId = Number.isFinite(Number(explicitSwipeId))
      ? Number(explicitSwipeId)
      : Number(message.swipe_id || 0) + (String(direction).toLowerCase().includes('left') || Number(direction) < 0 ? -1 : 1);
    return switchSwipeCompat(message.message_id ?? message.id ?? index, nextSwipeId);
  };
  const swipeStateCompat = {
    get messageId() { return ctx.messageId; },
    get swipeId() {
      const message = compatChat[resolveMessageIndex(ctx.messageId, {})];
      return Number(message?.swipe_id || 0);
    },
    get count() {
      const message = compatChat[resolveMessageIndex(ctx.messageId, {})];
      return Array.isArray(message?.swipes) ? message.swipes.length : 0;
    },
  };
  const sendMessageCompat = async (content, options = {}) => {
    const normalized = normalizePromptInputCompat(content);
    const insertAt = compatChat.length;
    emitCompatEvent(window.event_types?.MESSAGE_SENT || 'message_sent', insertAt);
    emitCompatEvent(window.event_types?.USER_MESSAGE_RENDERED || 'user_message_rendered', insertAt);
    return requestParent('sendMessage', {
      content: normalized.content,
      awaitResult: Boolean(options?.awaitResult),
      options,
    });
  };
  const sendTextareaCompat = async (options = {}) => {
    const textareaValue = String(parentElementStore.send_textarea?.value || '').trim();
    if (!textareaValue) return false;
    parentElementStore.send_textarea.value = '';
    post({ type: 'st:setInputDraft', content: '' });
    await sendMessageCompat(textareaValue, { ...(options && typeof options === 'object' ? options : {}), source: 'sendTextarea' });
    return true;
  };
  const sendMessageAsUserCompat = async (messageText, messageBias = undefined, insertAt = null, compact = false, name = undefined, avatar = undefined) => {
    const normalized = normalizeUserMessageInputCompat(messageText, messageBias, insertAt, compact, name, avatar);
    const response = await requestParent('sendMessageAsUser', {
      content: normalized.content,
      awaitResult: Boolean(normalized.options.awaitResult),
      options: normalized.options,
    });
    return response?.success !== false;
  };
  const triggerGenerationCompat = async (type = 'normal', options = {}, dryRun = false) => {
    const generationOptions = options && typeof options === 'object' ? options : {};
    const prompt = normalizePromptInputCompat(generationOptions, ['quietPrompt', 'quiet_prompt', 'prompt']);
    const generationType = String(type || 'normal');
    emitCompatEvent(window.event_types?.GENERATION_STARTED || 'generation_started', generationType, generationOptions);
    emitCompatEvent(window.event_types?.GENERATION_AFTER_COMMANDS || 'GENERATION_AFTER_COMMANDS', generationType, generationOptions);
    emitCompatEvent(window.event_types?.GENERATE_BEFORE_COMBINE_PROMPTS || 'generate_before_combine_prompts', generationType, generationOptions);
    emitCompatEvent(window.event_types?.GENERATE_AFTER_COMBINE_PROMPTS || 'generate_after_combine_prompts', {
      type: generationType,
      prompt: prompt.content,
      options: generationOptions,
    });
    try {
      const response = await requestParent('triggerGeneration', {
        type: generationType,
        content: prompt.content,
        options: generationOptions,
        dryRun: Boolean(dryRun),
        awaitResult: true,
      });
      const generated = normalizeGenerationResult(response);
      if (generated) {
        emitCompatEvent(window.event_types?.GENERATE_AFTER_DATA || 'generate_after_data', { content: generated, type: generationType });
        emitCompatEvent(window.event_types?.MESSAGE_RECEIVED || 'message_received', compatChat.length - 1, generated);
        emitCompatEvent(window.event_types?.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered', compatChat.length - 1, generated);
      }
      emitCompatEvent(window.event_types?.GENERATION_ENDED || 'generation_ended', generationType, { message: generated });
      return generated;
    } catch (error) {
      emitCompatEvent(window.event_types?.GENERATION_STOPPED || 'generation_stopped', generationType, error);
      emitCompatEvent(window.event_types?.GENERATION_ENDED || 'generation_ended', generationType, { error: String(error?.message || error) });
      throw error;
    }
  };
  const normalizeGenerationResult = (response) => {
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      if (typeof response.content === 'string') return response.content;
      if (typeof response.text === 'string') return response.text;
      if (typeof response.message === 'string') return response.message;
      if (typeof response.result === 'string') return response.result;
    }
    return '';
  };
  const emitCompatEvent = (type, ...args) => {
    try {
      window.eventSource?.emit?.(type, ...args);
    } catch {}
  };
  const refreshDerivedContextStoresCompat = () => {
    scopedRegexScripts = normalizeRegexListCompat(ctx.characterExtensions);
    presetRegexScripts = normalizeRegexListCompat(ctx.presetData);
    globalRegexScripts = normalizeRegexListCompat(ctx.globalRegexScripts);
    const extensions = parseMaybeJsonObject(ctx.characterExtensions, {});
    primaryCharacter.id = ctx.characterId;
    primaryCharacter.uuid = ctx.characterId;
    primaryCharacter.name = ctx.characterName;
    primaryCharacter.avatar = ctx.characterId;
    primaryCharacter.chat = ctx.sessionId;
    primaryCharacter.first_mes = ctx.firstMes || '';
    primaryCharacter.alternate_greetings = Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [];
    primaryCharacter.data.name = ctx.characterName;
    primaryCharacter.data.extensions = extensions;
    primaryCharacter.data.first_mes = ctx.firstMes || '';
    primaryCharacter.data.alternate_greetings = Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [];
    window.characters[0] = primaryCharacter;
    if (ctx.characterId) window.characters[ctx.characterId] = primaryCharacter;
  };
  const setViewportCssNumberCompat = (style, name, value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    style.setProperty(name, Math.max(0, Math.round(numeric * 100) / 100) + 'px');
  };
  const applyViewportContextCompat = () => {
    const viewport = ctx.viewport && typeof ctx.viewport === 'object' ? ctx.viewport : {};
    const root = document.documentElement;
    const body = document.body;
    if (!root) return;
    const rootStyle = root.style;
    const bodyStyle = body?.style;
    setViewportCssNumberCompat(rootStyle, '--palink-viewport-width', viewport.width);
    setViewportCssNumberCompat(rootStyle, '--palink-viewport-height', viewport.height);
    setViewportCssNumberCompat(rootStyle, '--palink-visual-viewport-width', viewport.visualWidth);
    setViewportCssNumberCompat(rootStyle, '--palink-visual-viewport-height', viewport.visualHeight);
    setViewportCssNumberCompat(rootStyle, '--palink-viewport-offset-top', viewport.offsetTop);
    setViewportCssNumberCompat(rootStyle, '--palink-viewport-offset-left', viewport.offsetLeft);
    setViewportCssNumberCompat(rootStyle, '--palink-safe-top', viewport.safeTop);
    setViewportCssNumberCompat(rootStyle, '--palink-safe-bottom', viewport.safeBottom);
    setViewportCssNumberCompat(rootStyle, '--palink-composer-height', viewport.composerHeight);
    setViewportCssNumberCompat(rootStyle, '--palink-available-height', viewport.availableHeight || viewport.visualHeight || viewport.height);
    rootStyle.setProperty('--palink-viewport-scale', String(Number.isFinite(Number(viewport.scale)) ? viewport.scale : 1));
    root.dataset.palinkKeyboardOpen = viewport.keyboardOpen ? 'true' : 'false';
    root.dataset.palinkPresentationMode = ctx.presentationMode || 'inline';
    root.dataset.palinkImmersive = viewport.immersive ? 'true' : 'false';
    if (viewport.immersive || ctx.presentationMode?.startsWith?.('immersive')) {
      rootStyle.minHeight = 'var(--palink-available-height, 100vh)';
      rootStyle.height = 'var(--palink-available-height, 100vh)';
      if (bodyStyle) {
        bodyStyle.minHeight = 'var(--palink-available-height, 100vh)';
        bodyStyle.height = 'var(--palink-available-height, 100vh)';
      }
    }
  };
  const dispatchViewportEventsCompat = () => {
    try { window.dispatchEvent(new Event('resize')); } catch {}
    try { window.dispatchEvent(new Event('orientationchange')); } catch {}
    try { document.dispatchEvent(new Event('palink:viewport')); } catch {}
  };
  const applyParentContextUpdateCompat = (nextContext) => {
    if (!nextContext || typeof nextContext !== 'object') return;
    Object.assign(ctx, clone(nextContext));
    applyStPluginRuntimeConfigCompat();
    // [P0-SRCDOC-SLIM] context 更新后重试插件 CSS 注入（幂等，styleId 去重）。
    // 首次进入会话时首帧 ctx 为空 config，CSS 未注入；config 到达后补注，
    // 与插件脚本包到达后执行的时序解耦（脚本包到达时也会重试一次）。
    try { injectStPluginCssCompat(); } catch {}
    // [P0-SRCDOC-SLIM] 插件脚本包已就绪但 ctx 插件清单晚到（刷新冷启动时序）：
    // bundle push 先于 context-update 到达时首帧无法遍历插件，此处补执行。
    // executeStPluginScriptsCompat 按 scriptKey 幂等，context 高频更新时重复
    // 调用也只会执行尚未执行过的脚本，不会重复注入。
    try {
      if (stPluginScriptsBundleCompat.scripts.length > 0) {
        executeStPluginScriptsCompat();
      }
    } catch {}
    applyViewportContextCompat();
    dispatchViewportEventsCompat();
    refreshDerivedContextStoresCompat();
    // [SINGLE-SOURCE] 父页面下发的最新 variables（含后端 MVU 引擎生成的 stat_data）必须
    // 热合并进 chatVariableStore（唯一真源），与 legacy-st-sim 218 行的 context-update
    // 合并行为对齐；否则 getVariable()/getAllVariables() 读到的是旧数据。
    if (nextContext.variables && typeof nextContext.variables === 'object') {
      try {
        console.warn('[VAR-DBG] context-update incoming keys=' + JSON.stringify(Object.keys(nextContext.variables)));
        deepMergeVariablesCompat(chatVariableStore, clone(nextContext.variables));
        var _sdUpd = chatVariableStore && chatVariableStore.stat_data;
        console.warn('[VAR-DBG] context-update after merge store.stat_data keys=' + JSON.stringify(_sdUpd && typeof _sdUpd === 'object' ? Object.keys(_sdUpd) : []));
        emitCompatEvent('VARIABLE_UPDATE_ENDED', chatVariableStore);
        emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
      } catch (_vdbgC) {}
    }
    if (Array.isArray(ctx.chatMessages) && ctx.chatMessages.length > 0) {
      compatChat.splice(0, compatChat.length, ...ctx.chatMessages.map(normalizeChatMessage));
      compatChat.forEach((message) => syncSwipeToMesCompat(message, message.swipe_id));
      window.chat = compatChat;
    }
    currentMessageIndex = Number.isFinite(Number(ctx.messageIndex))
      ? Number(ctx.messageIndex)
      : Math.max(0, compatChat.findIndex((message) => String(message.id) === String(ctx.messageId) || String(message.message_id) === String(ctx.messageId)));
    window.name1 = ctx.userName || window.name1 || 'User';
    window.name2 = ctx.characterName || window.name2 || 'Character';
    refreshGroupContextCompat();
    emitCompatEvent(window.event_types?.CHAT_CHANGED || 'chat_id_changed', ctx.sessionId || '', compatChat);
  };
  applyViewportContextCompat();

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'palink-smart-card-parent' || data.frameId !== frameId) return;
    if (data.type === 'plugin-scripts-push') {
      // [P0-SRCDOC-SLIM] 父页面单次推送的插件脚本包（js/modules 源码）→ 执行插件脚本。
      applyPluginScriptsPushCompat(data.bundle);
      return;
    }
    if (data.type === 'context-update') {
      applyParentContextUpdateCompat(data.context);
      return;
    }
    const pending = pendingRequests.get(data.requestId);
    if (!pending) return;
    pendingRequests.delete(data.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(data.ok ? { ok: true, ...(data.result ?? { success: true }) } : { ok: false, success: false, error: data.error || uiText.requestFailed });
  });

  const missingApiAddMessagePatternCompat = new RegExp('(?:^|' + regexBackslashCompat + '.)(?:add|append|insert|create)(?:one)?(?:chat)?message');
  const missingApiUpdateMessagePatternCompat = new RegExp('(?:^|' + regexBackslashCompat + '.)(?:set|update|edit|replace)(?:chat)?message');
  const makeMissingApiFunction = (apiName, options = {}) => async (...args) => {
    const lowerApiName = String(apiName || '').toLowerCase();
    if (missingApiAddMessagePatternCompat.test(lowerApiName) || lowerApiName.endsWith('.addonemessage')) {
      const messageArg = args.find((arg) => arg && typeof arg === 'object') || args.find((arg) => typeof arg === 'string') || '';
      const optionsArg = args.find((arg) => arg && typeof arg === 'object' && arg !== messageArg) || {};
      return addOneMessageCompat(messageArg, optionsArg);
    }
    if (missingApiUpdateMessagePatternCompat.test(lowerApiName) || lowerApiName.endsWith('.updatemessageblock')) {
      const first = args[0];
      const second = args[1];
      const third = args[2];
      const hasExplicitTarget = typeof first === 'number' || (typeof first === 'string' && first.trim() !== '' && args.length > 1);
      const messageId = hasExplicitTarget ? first : ctx.messageId;
      const content = hasExplicitTarget ? second : first;
      const optionsArg = third && typeof third === 'object' ? third : {};
      return setChatMessageCompat(content, messageId, optionsArg);
    }
    reportDiagnostic({
      severity: options.severity || 'warning',
      code: 'missing_api',
      apiName,
      message: uiText.missingApi,
      detail: uiText.missingApiDetail,
      args: args.map(summarizeArg),
      stack: new Error().stack || '',
    });
    const response = await requestParent('unknownApiCall', {
      apiName,
      args: args.map((arg) => sanitizeUnknownApiArg(arg)),
      argSummary: args.map(summarizeArg),
    });
    if (response && typeof response === 'object' && 'result' in response) return response.result;
    return response;
  };

  const ensureFunction = (name, fn) => {
    if (typeof window[name] !== 'function') {
      try { Object.defineProperty(window, name, { value: fn, configurable: true, writable: true }); }
      catch { window[name] = fn; }
    }
  };
  const setCompatFunction = (name, fn) => {
    try { Object.defineProperty(window, name, { value: fn, configurable: true, writable: true }); }
    catch { window[name] = fn; }
  };

  const setFunctionAlias = (name, target) => {
    setCompatFunction(name, (...args) => {
      const fn = typeof target === 'function' ? target : window[target];
      if (typeof fn !== 'function') {
        return makeMissingApiFunction(String(name), { severity: 'warning' })(...args);
      }
      return fn(...args);
    });
  };

  const ensureObject = (name, value) => {
    if (!window[name] || typeof window[name] !== 'object') {
      try { Object.defineProperty(window, name, { value, configurable: true, writable: true }); }
      catch { window[name] = value; }
    }
    return window[name];
  };
  const virtualHistoryCompat = (() => {
    const nativeHistory = window.history;
    if (!nativeHistory || nativeHistory.__palinkVirtualHistory) return nativeHistory;
    const cloneState = (value) => {
      if (value == null) return value;
      try { return structuredClone(value); } catch {}
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    };
    const currentUrl = () => {
      try { return String(window.location.href || 'about:srcdoc'); } catch { return 'about:srcdoc'; }
    };
    const normalizeUrl = (url) => {
      if (url === undefined || url === null || url === '') return currentUrl();
      try { return new URL(String(url), currentUrl()).href; } catch { return String(url); }
    };
    const hashOf = (url) => {
      try { return new URL(String(url), currentUrl()).hash || ''; } catch { return ''; }
    };
    const stack = [{
      state: cloneState(nativeHistory.state),
      title: document.title || '',
      url: currentUrl(),
    }];
    let index = 0;
    const dispatchPopState = (state) => {
      try {
        window.dispatchEvent(new PopStateEvent('popstate', { state: cloneState(state) }));
        return;
      } catch {}
      try {
        const event = document.createEvent('Event');
        event.initEvent('popstate', false, false);
        event.state = cloneState(state);
        window.dispatchEvent(event);
      } catch {}
    };
    const dispatchHashChange = (oldUrl, newUrl) => {
      const oldHash = hashOf(oldUrl);
      const newHash = hashOf(newUrl);
      if (oldHash === newHash) return;
      try {
        window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: oldUrl, newURL: newUrl }));
        return;
      } catch {}
      try {
        const event = document.createEvent('Event');
        event.initEvent('hashchange', false, false);
        event.oldURL = oldUrl;
        event.newURL = newUrl;
        window.dispatchEvent(event);
      } catch {}
    };
    const syncHash = (nextUrl) => {
      const nextHash = hashOf(nextUrl);
      if (!nextHash) return;
      try {
        if (window.location.hash !== nextHash) window.location.hash = nextHash;
      } catch {}
    };
    const notifyNavigation = (oldUrl, entry) => {
      syncHash(entry.url);
      dispatchPopState(entry.state);
      dispatchHashChange(oldUrl, entry.url);
      try { window.dispatchEvent(new CustomEvent('palink:virtual-history-change', { detail: cloneState({ index, entry, length: stack.length }) })); } catch {}
    };
    const pushState = (state, title = '', url = undefined) => {
      const oldUrl = stack[index]?.url || currentUrl();
      const entry = {
        state: cloneState(state),
        title: String(title ?? ''),
        url: normalizeUrl(url),
      };
      stack.splice(index + 1);
      stack.push(entry);
      index = stack.length - 1;
      syncHash(entry.url);
      try { window.dispatchEvent(new CustomEvent('palink:virtual-history-push', { detail: cloneState({ index, entry, length: stack.length }) })); } catch {}
      dispatchHashChange(oldUrl, entry.url);
    };
    const replaceState = (state, title = '', url = undefined) => {
      const oldUrl = stack[index]?.url || currentUrl();
      const entry = {
        state: cloneState(state),
        title: String(title ?? ''),
        url: normalizeUrl(url),
      };
      stack[index] = entry;
      syncHash(entry.url);
      try { window.dispatchEvent(new CustomEvent('palink:virtual-history-replace', { detail: cloneState({ index, entry, length: stack.length }) })); } catch {}
      dispatchHashChange(oldUrl, entry.url);
    };
    const go = (delta = 0) => {
      const step = Number(delta) || 0;
      if (step === 0) {
        notifyNavigation(stack[index]?.url || currentUrl(), stack[index]);
        return;
      }
      const nextIndex = Math.max(0, Math.min(stack.length - 1, index + step));
      if (nextIndex === index) {
        try { window.dispatchEvent(new CustomEvent('palink:virtual-history-empty', { detail: { delta: step, index, length: stack.length } })); } catch {}
        dispatchPopState(stack[index]?.state);
        return;
      }
      const oldUrl = stack[index]?.url || currentUrl();
      index = nextIndex;
      notifyNavigation(oldUrl, stack[index]);
    };
    const api = {
      __palinkVirtualHistory: true,
      pushState,
      replaceState,
      back: () => go(-1),
      forward: () => go(1),
      go,
      entries: () => stack.map((entry) => cloneState(entry)),
      get index() { return index; },
    };
    try { Object.defineProperty(nativeHistory, 'state', { configurable: true, get: () => cloneState(stack[index]?.state) }); } catch {}
    try { Object.defineProperty(nativeHistory, 'length', { configurable: true, get: () => stack.length }); } catch {}
    try { Object.defineProperty(nativeHistory, 'pushState', { value: pushState, configurable: true, writable: true }); } catch { nativeHistory.pushState = pushState; }
    try { Object.defineProperty(nativeHistory, 'replaceState', { value: replaceState, configurable: true, writable: true }); } catch { nativeHistory.replaceState = replaceState; }
    try { Object.defineProperty(nativeHistory, 'back', { value: api.back, configurable: true, writable: true }); } catch { nativeHistory.back = api.back; }
    try { Object.defineProperty(nativeHistory, 'forward', { value: api.forward, configurable: true, writable: true }); } catch { nativeHistory.forward = api.forward; }
    try { Object.defineProperty(nativeHistory, 'go', { value: go, configurable: true, writable: true }); } catch { nativeHistory.go = go; }
    try { Object.defineProperty(nativeHistory, '__palinkVirtualHistory', { value: api, configurable: true }); } catch { nativeHistory.__palinkVirtualHistory = api; }
    return api;
  })();

  window.__palinkSmartCardCompatV2 = {
    version: runtimeVersion,
    mode: runtimeMode,
    context: ctx,
    requiredApis,
    diagnostics,
    report: reportDiagnostic,
    requestParent,
    history: virtualHistoryCompat,
  };

  ensureObject('extension_settings', mergePlainObjectCompat({ ...extensionSettingsStore }, stPluginExtensionSettings));
  applyStPluginRuntimeConfigCompat();
  injectStPluginCssCompat();
  window.extension_settings.regex = Array.isArray(window.extension_settings.regex) && window.extension_settings.regex.length
    ? window.extension_settings.regex
    : clone(globalRegexScripts);
  window.extension_settings.character_allowed_regex = Array.isArray(window.extension_settings.character_allowed_regex)
    ? window.extension_settings.character_allowed_regex
    : [];
  if (ctx.characterId && !window.extension_settings.character_allowed_regex.includes(ctx.characterId)) {
    window.extension_settings.character_allowed_regex.push(ctx.characterId);
  }
  window.extension_settings.preset_allowed_regex = window.extension_settings.preset_allowed_regex || {};
  window.extension_settings.palink_preset_regex_scripts = clone(presetRegexScripts);
  ensureObject('power_user', {});
  ensureObject('chat_metadata', persistedMetadata && typeof persistedMetadata === 'object' ? persistedMetadata : {});
  const resolveExtensionTemplateCompat = (extensionName = '', templateName = '', data = {}) => {
    const found = findStPluginTemplateCompat(extensionName, templateName);
    if (found?.resource?.content) {
      return compileSimpleTemplateCompat(found.resource.content, data);
    }
    const title = String(templateName || extensionName || 'template');
    const payload = data && typeof data === 'object' ? data : {};
    const rows = Object.entries(payload).map(([key, value]) => {
      const safeKey = escapeHtmlCompat(key);
      const safeValue = escapeHtmlCompat(value);
      return '<div data-key="' + safeKey + '">' + safeValue + '</div>';
    }).join('');
    return '<section data-palink-extension-template="' + escapeHtmlCompat(extensionName) + '" data-template="' + escapeHtmlCompat(title) + '">' + rows + '</section>';
  };
  setCompatFunction('renderExtensionTemplate', resolveExtensionTemplateCompat);
  setCompatFunction('renderExtensionTemplateAsync', async (...args) => resolveExtensionTemplateCompat(...args));
  setCompatFunction('renderTemplate', resolveExtensionTemplateCompat);
  setCompatFunction('renderTemplateAsync', async (...args) => resolveExtensionTemplateCompat(...args));
  setCompatFunction('loadExtensionSettings', async () => window.extension_settings);
  setCompatFunction('waitGlobalInitialized', async () => true);
  window.__palinkStModuleNamespace = (modulePath, pluginId = '', basePath = '') => {
    const localExports = resolveStLocalPluginModuleCompat(modulePath, '*', pluginId, basePath);
    if (localExports && typeof localExports === 'object') return localExports;
    return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toStringTag) return 'PalinkSillyTavernModule';
      return window.__palinkStModuleImport?.(modulePath, String(prop), pluginId, basePath);
    },
  });
  };
  ensureObject('event_types', {
    APP_INITIALIZED: 'app_initialized',
    APP_READY: 'app_ready',
    EXTRAS_CONNECTED: 'extras_connected',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
    MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
    MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    IMPERSONATE_READY: 'impersonate_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_LOADED: 'chatLoaded',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    SD_PROMPT_PROCESSING: 'sd_prompt_processing',
    EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
    EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
    SETTINGS_LOADED: 'settings_loaded',
    SETTINGS_UPDATED: 'settings_updated',
    GROUP_UPDATED: 'group_updated',
    MOVABLE_PANELS_RESET: 'movable_panels_reset',
    SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
    SETTINGS_LOADED_AFTER: 'settings_loaded_after',
    CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
    CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
    OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
    OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
    OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
    OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
    WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
    WORLDINFO_UPDATED: 'worldinfo_updated',
    CHARACTER_EDITOR_OPENED: 'character_editor_opened',
    CHARACTER_EDITED: 'character_edited',
    CHARACTER_PAGE_LOADED: 'character_page_loaded',
    CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE: 'character_group_overlay_state_change_before',
    CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER: 'character_group_overlay_state_change_after',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    FORCE_SET_BACKGROUND: 'force_set_background',
    CHAT_DELETED: 'chat_deleted',
    CHAT_CREATED: 'chat_created',
    CHAT_RENAMED: 'chat_renamed',
    GROUP_CHAT_DELETED: 'group_chat_deleted',
    GROUP_CHAT_CREATED: 'group_chat_created',
    GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    GENERATE_AFTER_DATA: 'generate_after_data',
    GROUP_MEMBER_DRAFTED: 'group_member_drafted',
    GROUP_WRAPPER_STARTED: 'group_wrapper_started',
    GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
    CHARACTER_DELETED: 'characterDeleted',
    CHARACTER_DUPLICATED: 'character_duplicated',
    CHARACTER_RENAMED: 'character_renamed',
    CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
    SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    STREAM_REASONING_DONE: 'stream_reasoning_done',
    FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
    WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
    OPEN_CHARACTER_LIBRARY: 'open_character_library',
    ONLINE_STATUS_CHANGED: 'online_status_changed',
    IMAGE_SWIPED: 'image_swiped',
    CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
    TOOL_CALLS_PERFORMED: 'tool_calls_performed',
    TOOL_CALLS_RENDERED: 'tool_calls_rendered',
    CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
    SECRET_WRITTEN: 'secret_written',
    SECRET_DELETED: 'secret_deleted',
    SECRET_ROTATED: 'secret_rotated',
    SECRET_EDITED: 'secret_edited',
    PRESET_CHANGED: 'preset_changed',
    PRESET_DELETED: 'preset_deleted',
    PRESET_RENAMED: 'preset_renamed',
    PRESET_RENAMED_BEFORE: 'preset_renamed_before',
    MAIN_API_CHANGED: 'main_api_changed',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
    WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
    MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
    PERSONA_CHANGED: 'persona_changed',
    PERSONA_CREATED: 'persona_created',
    PERSONA_UPDATED: 'persona_updated',
    PERSONA_RENAMED: 'persona_renamed',
    PERSONA_DELETED: 'persona_deleted',
    TTS_JOB_STARTED: 'tts_job_started',
    TTS_AUDIO_READY: 'tts_audio_ready',
    TTS_JOB_COMPLETE: 'tts_job_complete',
    ITEMIZED_PROMPTS_LOADED: 'itemized_prompts_loaded',
    ITEMIZED_PROMPTS_SAVED: 'itemized_prompts_saved',
    ITEMIZED_PROMPTS_DELETED: 'itemized_prompts_deleted',
  });
  ensureObject('extension_prompt_types', {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
  });
  ensureObject('extension_prompt_roles', {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
  });
  ensureObject('POPUP_TYPE', { TEXT: 'text', DISPLAY: 'display', CONFIRM: 'confirm', INPUT: 'input' });
  ensureObject('POPUP_RESULT', { AFFIRMATIVE: true, NEGATIVE: false, CANCELLED: null });
  const normalizePopupTypeCompat = (type) => {
    if (type && typeof type === 'object') return String(type.type || type.kind || type.popup_type || '').toLowerCase();
    const value = String(type || '').toLowerCase();
    if (value.includes('input')) return 'input';
    if (value.includes('confirm')) return 'confirm';
    if (value.includes('display')) return 'display';
    if (value.includes('text')) return 'text';
    return value || 'text';
  };
  const showPopupCompat = async (message, type = 'text', inputValue = '', options = {}) => {
    const popupType = normalizePopupTypeCompat(type);
    // 提取消息文本(Node 节点取 textContent,其他转字符串)
    const messageText = message instanceof Node
      ? (message.textContent || message.innerText || '')
      : String(message ?? '');
    // 委托到父窗口的 popupManager.show() (Task 8.1)
    const response = await requestParent('callGenericPopup', {
      message: messageText,
      type: popupType,
      inputValue: String(inputValue ?? options?.defaultValue ?? options?.default ?? ''),
      options: options || {},
    });
    // 兼容失败/超时:返回取消语义
    if (!response || response.ok === false) {
      return popupType === 'input' ? null : false;
    }
    const result = response.result;
    // 将 PopupResult 映射回 SillyTavern 旧格式
    // - INPUT: 返回字符串值或 null
    // - CONFIRM/TEXT/DISPLAY: 返回 true/false
    if (popupType === 'input') {
      if (result && typeof result === 'object' && result.result === 1) {
        return String(result.value ?? '');
      }
      return null;
    }
    return result === 1 || result === true;
  };
  const popupShowCompat = async (type, message, options = {}) => showPopupCompat(message, type, options?.defaultValue ?? options?.default ?? '', options);
  popupShowCompat.text = async (message, options = {}) => showPopupCompat(message, 'text', '', options);
  popupShowCompat.confirm = async (message, options = {}) => showPopupCompat(message, 'confirm', '', options);
  popupShowCompat.input = async (message, defaultValue = '', options = {}) => showPopupCompat(message, 'input', defaultValue, options);
  ensureObject('Popup', { show: popupShowCompat });
  ensureObject('toastr', {
    info: (...args) => post({ type: 'log', level: 'info', message: String(args[0] ?? '') }),
    success: (...args) => post({ type: 'log', level: 'info', message: String(args[0] ?? '') }),
    warning: (...args) => post({ type: 'log', level: 'warning', message: String(args[0] ?? '') }),
    error: (...args) => post({ type: 'error', message: String(args[0] ?? '') }),
  });

  ensureFunction('getRequestHeaders', () => ({}));
  const makeStApiJsonResponseCompat = (data, init = {}) => new Response(JSON.stringify(data ?? {}), {
    status: init.status || 200,
    statusText: init.statusText || 'OK',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
  const getStApiCharactersCompat = () => {
    const seen = new Set();
    return (Array.isArray(window.characters) ? window.characters : [])
      .filter((character) => character && typeof character === 'object')
      .filter((character) => {
        const key = String(character.uuid || character.id || character.name || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((character) => clone(character));
  };
  const buildStApiWorldInfoCompat = () => ({
    name: activeWorldbookName || ctx.characterName || 'Palink',
    entries: [],
    data: {},
    world_names: window.world_names || [],
  });
  const handleStApiFetchCompat = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : String(input?.url || '');
    let path = '';
    try {
      const trimmedRawUrl = String(rawUrl || '').trim();
      if (trimmedRawUrl.toLowerCase().startsWith('/api/')) {
        path = trimmedRawUrl.split('?')[0].split('#')[0];
      } else {
        const currentHref = String(window.location.href || '');
        const base = (currentHref.toLowerCase().startsWith('http:') || currentHref.toLowerCase().startsWith('https:'))
          ? window.location.href
          : (document.referrer || 'http://palink.local/');
        path = new URL(rawUrl, base).pathname;
      }
    } catch {
      return null;
    }
    path = path.replace(new RegExp('/+', 'g'), '/');
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (!path.startsWith('/api/')) return null;
    if (path.startsWith('/api/plugins/') && !path.includes('/runtime/config')) return null;
    if (path === '/api/plugins/runtime/config') {
      return makeStApiJsonResponseCompat(stPluginRuntimeConfig);
    }
    if (path === '/api/settings' || path === '/api/settings/get' || path === '/api/settings/load') {
      return makeStApiJsonResponseCompat({
        settings: {},
        extension_settings: window.extension_settings || {},
        power_user: window.power_user || {},
        chat_metadata: window.chat_metadata || {},
      });
    }
    if (path === '/api/settings/save' || path === '/api/settings/save-settings') {
      await window.saveSettings?.();
      return makeStApiJsonResponseCompat({ result: 'ok', ok: true });
    }
    if (path.startsWith('/api/secrets')) {
      return makeStApiJsonResponseCompat(method === 'GET' ? { value: '', entries: {}, secrets: {} } : { result: 'ok', ok: true });
    }
    if (path === '/api/characters' || path === '/api/characters/all' || path === '/api/characters/list') {
      return makeStApiJsonResponseCompat({ characters: getStApiCharactersCompat(), data: getStApiCharactersCompat() });
    }
    if (path.startsWith('/api/worldinfo') || path.startsWith('/api/world-info')) {
      return makeStApiJsonResponseCompat(method === 'GET' ? buildStApiWorldInfoCompat() : { result: 'ok', ok: true });
    }
    if (path.startsWith('/api/groups')) {
      return makeStApiJsonResponseCompat({ groups: getGroupsCompat(), data: getGroupsCompat() });
    }
    if (path.startsWith('/api/backends') || path.startsWith('/api/status') || path.startsWith('/api/tokenizers')) {
      return makeStApiJsonResponseCompat({ result: 'ok', ok: true, online: true });
    }
    return null;
  };
  const nativeFetchCompat = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (nativeFetchCompat) {
    setCompatFunction('fetch', async (input, init = {}) => {
      const compatResponse = await handleStApiFetchCompat(input, init);
      if (compatResponse) return compatResponse;
      return nativeFetchCompat(input, init);
    });
  }
  const persistCompatRuntimeState = () => {
    persistVariableStores();
    persistStorageValue('__palink_chat_metadata', window.chat_metadata || {});
    persistStorageValue('__palink_extension_settings', window.extension_settings || {});
  };
  const persistStPluginSettingsToParentCompat = () => {
    sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat()).forEach((plugin) => {
      const namespace = getStPluginRuntimeNamespaceCompat(plugin);
      if (!namespace || !window.extension_settings || !Object.prototype.hasOwnProperty.call(window.extension_settings, namespace)) return;
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      void requestParent('saveExtensionSettings', {
        pluginId: plugin?.id,
        namespace,
        settings: clone(window.extension_settings[namespace] || {}),
        extensionName: manifest.id || manifest.name || manifest.display_name || plugin.name || plugin.id,
      });
    });
  };
  ensureFunction('saveSettingsDebounced', persistCompatRuntimeState);
  ensureFunction('saveSettings', async () => {
    persistCompatRuntimeState();
    persistStPluginSettingsToParentCompat();
    emitCompatEvent(window.event_types?.SETTINGS_UPDATED || 'settings_updated', window.extension_settings || {});
    return true;
  });
  ensureFunction('saveChatConditional', async () => true);
  ensureFunction('saveChat', async () => requestParent('saveChat'));
  ensureFunction('saveMetadata', async () => {
    persistStorageValue('__palink_chat_metadata', window.chat_metadata || {});
    return true;
  });
  ensureFunction('reloadCurrentChat', async () => post({ type: 'refresh' }));
  ensureFunction('getGroups', async () => getGroupsCompat());
  ensureFunction('getGroupChat', async (groupId = window.selected_group) => getGroupChatCompat(groupId));
  ensureFunction('getCharacters', async () => clone(Array.isArray(window.characters) ? window.characters.filter(Boolean) : []));
  ensureFunction('getOneCharacter', async (id = window.this_chid) => clone(
    window.characters?.[id]
      || window.characters?.find?.((character) => String(character?.id) === String(id) || String(character?.name) === String(id))
      || window.characters?.[window.this_chid]
      || null,
  ));
  ensureFunction('selectCharacterById', async (id) => {
    const character = await window.getOneCharacter?.(id);
    if (character) {
      window.this_chid = 0;
      window.characters[0] = primaryCharacter;
      return true;
    }
    return false;
  });
  ensureFunction('getThumbnailUrl', (_type, path) => String(path || ''));
  ensureFunction('select_group_chats', async (groupId = window.selected_group) => {
    window.selected_group = groupId ?? window.selected_group;
    refreshGroupContextCompat();
    emitCompatEvent(window.event_types?.GROUP_UPDATED || 'group_updated', window.selected_group);
    return getGroupChatCompat(window.selected_group);
  });
  ensureFunction('generateGroupWrapper', async (type = 'normal', options = {}, dryRun = false) => {
    emitCompatEvent(window.event_types?.GROUP_WRAPPER_STARTED || 'group_wrapper_started', window.selected_group, options);
    const group = getGroupChatCompat(window.selected_group);
    const firstMember = Array.isArray(group.members) ? group.members[0] : null;
    if (firstMember) emitCompatEvent(window.event_types?.GROUP_MEMBER_DRAFTED || 'group_member_drafted', firstMember, group);
    const result = await triggerGenerationCompat(type, options, dryRun);
    emitCompatEvent(window.event_types?.GROUP_WRAPPER_FINISHED || 'group_wrapper_finished', window.selected_group, result);
    return result;
  });
  ensureFunction('regenerateGroup', async (options = {}) => window.generateGroupWrapper?.('regenerate', options, false));
  setCompatFunction('Generate', triggerGenerationCompat);
  setCompatFunction('generate', (options = {}) => {
    if (typeof options === 'string') return triggerGenerationCompat('normal', { quiet_prompt: options }, false);
    return triggerGenerationCompat('normal', options && typeof options === 'object' ? options : {}, false);
  });
  setCompatFunction('generateRaw', async (prompt) => {
    const normalized = normalizePromptInputCompat(prompt, ['prompt']);
    const response = await requestParent('generateRaw', {
      content: normalized.content,
      awaitResult: true,
      options: normalized.options,
    });
    return normalizeGenerationResult(response);
  });
  setCompatFunction('generateQuietPrompt', async (prompt) => {
    const normalized = normalizePromptInputCompat(prompt, ['quietPrompt', 'quiet_prompt', 'prompt']);
    const response = await requestParent('generateQuietPrompt', {
      content: normalized.content,
      awaitResult: true,
      options: normalized.options,
    });
    return normalizeGenerationResult(response);
  });
  setCompatFunction('generateRawData', async (prompt) => {
    const result = await window.generateRaw(prompt);
    return { choices: [{ message: { content: String(result ?? '') }, text: String(result ?? '') }] };
  });
  setCompatFunction('sendMessageAsUser', sendMessageAsUserCompat);
  setCompatFunction('sendTextarea', sendTextareaCompat);
  setCompatFunction('doMesSend', sendTextareaCompat);
  setCompatFunction('sendMessage', sendMessageCompat);
  setCompatFunction('sendUserMessage', sendMessageCompat);
  setCompatFunction('addOneMessage', addOneMessageCompat);
  setCompatFunction('deleteMessage', deleteMessageCompat);
  setCompatFunction('deleteChatMessage', deleteMessageCompat);
  setCompatFunction('deleteLastMessage', deleteLastMessageCompat);
  setCompatFunction('printMessages', printMessagesCompat);
  setCompatFunction('clearChat', clearChatCompat);
  setCompatFunction('scrollChatToBottom', () => {
    post({ type: 'scrollChatToBottom' });
    return true;
  });
  setCompatFunction('stopGeneration', async () => {
    const response = await requestParent('stopGeneration', {});
    emitCompatEvent(window.event_types?.GENERATION_STOPPED || 'generation_stopped');
    return response?.success === false ? false : true;
  });
  setFunctionAlias('appendMessage', 'addOneMessage');
  setFunctionAlias('addMessage', 'addOneMessage');
  setFunctionAlias('createMessage', 'addOneMessage');
  setFunctionAlias('insertMessage', 'addOneMessage');
  setFunctionAlias('appendChatMessage', 'addOneMessage');
  setFunctionAlias('addChatMessage', 'addOneMessage');
  setFunctionAlias('createChatMessage', 'addOneMessage');
  setFunctionAlias('insertChatMessage', 'addOneMessage');
  setCompatFunction('callGenericPopup', async (message, type = window.POPUP_TYPE?.TEXT, inputValue = '', options = {}) => (
    showPopupCompat(message, type, inputValue, options)
  ));
  setCompatFunction('callPopup', async (message, type = window.POPUP_TYPE?.TEXT, inputValue = '', options = {}) => (
    showPopupCompat(message, type, inputValue, options)
  ));
  ensureFunction('showLoader', () => true);
  ensureFunction('hideLoader', () => true);
  // [SINGLE-SOURCE] set/get 用 setCompatFunction 无条件接管（覆盖 legacy 占位实现），
  // 数据源统一为 chatVariableStore.__extension_prompts / __extension_fields；写入后经
  // persistVariableStores() 随会话变量持久化到父页面，iframe 销毁/重载不丢。
  setCompatFunction('setExtensionPrompt', (key, value, position, depth, scan, role = window.extension_prompt_roles?.SYSTEM, filter = null) => {
    const next = Object.assign({}, getExtensionPromptStoreCompat());
    next[String(key || 'default')] = { value, position, depth, scan, role, filter };
    setByPath(chatVariableStore, '__extension_prompts', next);
    persistVariableStores();
    // [EP-BRIDGE] 上报父页面 promptInjection（多 source 聚合），使生成管道
    // （useCharacterChat SSE/WS、插件 generate）都能拿到卡内注入的扩展提示词。
    // 完整快照上报，父页面整体替换该 frame 的 source；iframe 重载/父页面刷新后
    // 由初始化上报（见 shim 尾部）恢复。
    post({ type: 'extensionPrompts', prompts: next });
    return true;
  });
  setCompatFunction('getExtensionPrompt', (positionOrKey = window.extension_prompt_types?.IN_PROMPT, depth = undefined, separator = '\\n', role = undefined) => {
    const promptStore = getExtensionPromptStoreCompat();
    const directKey = String(positionOrKey || '');
    if (Object.prototype.hasOwnProperty.call(promptStore, directKey)) {
      return promptStore[directKey]?.value || '';
    }
    const wantedPosition = Number(positionOrKey);
    const wantedDepth = depth === undefined || depth === null ? undefined : Number(depth);
    const wantedRole = role === undefined || role === null ? undefined : Number(role);
    return Object.values(promptStore)
      .filter((entry) => entry && typeof entry === 'object')
      .filter((entry) => !Number.isFinite(wantedPosition) || Number(entry.position) === wantedPosition)
      .filter((entry) => wantedDepth === undefined || Number(entry.depth || 0) === wantedDepth)
      .filter((entry) => wantedRole === undefined || Number(entry.role ?? window.extension_prompt_roles?.SYSTEM) === wantedRole)
      .map((entry) => String(entry.value ?? ''))
      .filter(Boolean)
      .join(String(separator ?? '\\n'));
  });
  setCompatFunction('writeExtensionField', async (_chid, key, value) => {
    const nextFields = Object.assign({}, getExtensionFieldStoreCompat());
    nextFields[String(key || '')] = value;
    setByPath(chatVariableStore, '__extension_fields', nextFields);
    persistVariableStores();
    return value;
  });
  setCompatFunction('writeExtensionFieldBulk', async (_chid, values = {}) => {
    if (values && typeof values === 'object') {
      const nextFields = Object.assign({}, getExtensionFieldStoreCompat());
      Object.entries(values).forEach(([key, value]) => {
        nextFields[String(key || '')] = value;
      });
      setByPath(chatVariableStore, '__extension_fields', nextFields);
      persistVariableStores();
    }
    return values;
  });
  setCompatFunction('readExtensionField', async (_chid, key) => getExtensionFieldStoreCompat()[String(key || '')]);
  setCompatFunction('setChatMessage', async (content, messageIdOrOptions, maybeOptions = {}) => {
    const options = typeof messageIdOrOptions === 'object' && messageIdOrOptions !== null
      ? messageIdOrOptions
      : maybeOptions;
    const messageObject = content && typeof content === 'object' ? content : {};
    const messageId = typeof messageIdOrOptions === 'object' && messageIdOrOptions !== null
      ? options.messageId
        ?? options.message_id
        ?? options.id
        ?? options.mesid
        ?? messageObject.messageId
        ?? messageObject.message_id
        ?? messageObject.id
        ?? messageObject.mesid
        ?? ctx.messageId
      : messageIdOrOptions
        ?? messageObject.messageId
        ?? messageObject.message_id
        ?? messageObject.id
        ?? messageObject.mesid
        ?? ctx.messageId;
    return setChatMessageCompat(content, messageId, options);
  });
  setCompatFunction('updateMessageBlock', async (messageId, content, options = {}) => setChatMessageCompat(content, messageId, {
    ...options,
    replaceExtra: content && typeof content === 'object'
      ? options?.replaceExtra !== false
      : options?.replaceExtra,
  }));
  setFunctionAlias('updateChatMessage', 'updateMessageBlock');
  setFunctionAlias('setMessageBlock', 'updateMessageBlock');
  setFunctionAlias('editMessageBlock', 'updateMessageBlock');
  setFunctionAlias('replaceMessageBlock', 'updateMessageBlock');
  setFunctionAlias('setChatMessageBlock', 'updateMessageBlock');
  setFunctionAlias('editChatMessage', 'updateMessageBlock');
  setFunctionAlias('replaceChatMessage', 'updateMessageBlock');
  setFunctionAlias('replaceChatMessageBlock', 'updateMessageBlock');
  setCompatFunction('setInputDraft', (content) => {
    parentElementStore.send_textarea.value = String(content ?? '');
    post({ type: 'st:setInputDraft', content: parentElementStore.send_textarea.value });
    return true;
  });
  ensureFunction('getCharWorldbookNames', async () => ({
    primary: activeWorldbookName,
    additional: activeWorldbookName ? [activeWorldbookName] : [],
  }));
  ensureFunction('getCharWorldbook', async (...args) => requestParent('getCharWorldbook', { args }));
  ensureFunction('createOrReplaceCharWorldbook', async (name, entries, options = {}) => {
    const result = await requestParent('createOrReplaceWorldbook', { name, entries, options, scope: 'character' });
    return rememberWorldbookNameCompat(name, result);
  });
  ensureFunction('createOrReplaceWorldbook', async (name, entries, options = {}) => {
    const result = await requestParent('createOrReplaceWorldbook', { name, entries, options, scope: 'world' });
    return rememberWorldbookNameCompat(name, result);
  });
  ensureFunction('createWorldbook', async (name, entries = [], options = {}) => {
    const result = await requestParent('createWorldbook', { name, entries, options });
    return rememberWorldbookNameCompat(name, result);
  });
  ensureFunction('createWorldbookEntries', async (target, entries = [], options = {}) => {
    const result = await requestParent('createWorldbookEntries', { target, entries, options });
    return rememberWorldbookNameCompat(target, result);
  });
  ensureFunction('deleteWorldbookEntries', async (target, predicateSource) => requestParent('deleteWorldbookEntries', {
    target,
    predicateSource: String(predicateSource || ''),
  }));
  ensureFunction('getWorldbook', async (...args) => window.getCharWorldbook(...args));
  ensureFunction('getWorldbookEntries', async (target) => requestParent('getWorldbookEntries', { target }));
  ensureFunction('setWorldbookEntries', async (target, entries = [], options = {}) => {
    const result = await requestParent('setWorldbookEntries', { target, entries, options });
    return rememberWorldbookNameCompat(target, result);
  });
  ensureFunction('rebindChatWorldbook', async (chatId, worldbookName) => {
    const result = await requestParent('rebindChatWorldbook', { chatId, worldbookName });
    return rememberWorldbookNameCompat(worldbookName, result);
  });
  ensureFunction('activateChatWorldbook', async (worldbookName) => {
    const result = await requestParent('activateChatWorldbook', { worldbookName });
    return rememberWorldbookNameCompat(worldbookName, result);
  });
  window.PalinkSmartCard = {
    ...(window.PalinkSmartCard && typeof window.PalinkSmartCard === 'object' ? window.PalinkSmartCard : {}),
    context: ctx,
    post,
    sendMessage: sendMessageCompat,
    setInputDraft: window.setInputDraft,
    parentDocument: parentDocumentStore,
    parent$: parentDollarCompat,
    getParentElementById(id) {
      return parentDocumentStore.getElementById(id);
    },
    queryParentSelector(selector) {
      return parentDocumentStore.querySelector(selector);
    },
    queryParentSelectorAll(selector) {
      return parentDocumentStore.querySelectorAll(selector);
    },
  };
  ensureFunction('uuidv4', () => {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const value = Math.random() * 16 | 0;
      return (char === 'x' ? value : (value & 0x3 | 0x8)).toString(16);
    });
  });

  const tavernHelperCompat = {
    getContext: () => (typeof window.getContext === 'function' ? window.getContext() : window.SillyTavern?.getContext?.()),
    getChatMessages: (...args) => (typeof window.getChatMessages === 'function' ? window.getChatMessages(...args) : getCompatChatMessages()),
    getGroups: () => (typeof window.getGroups === 'function' ? window.getGroups() : getGroupsCompat()),
    getGroupChat: (...args) => (typeof window.getGroupChat === 'function' ? window.getGroupChat(...args) : getGroupChatCompat(args[0])),
    getCurrentMessageId: () => (typeof window.getCurrentMessageId === 'function' ? window.getCurrentMessageId() : ctx.messageId),
    setChatMessage: (...args) => window.setChatMessage(...args),
    updateMessageBlock: (...args) => (typeof window.updateMessageBlock === 'function' ? window.updateMessageBlock(...args) : requestParent('updateMessageBlock', { args })),
    updateChatMessage: (...args) => window.updateChatMessage(...args),
    setMessageBlock: (...args) => window.setMessageBlock(...args),
    editMessageBlock: (...args) => window.editMessageBlock(...args),
    replaceMessageBlock: (...args) => window.replaceMessageBlock(...args),
    addOneMessage: (...args) => window.addOneMessage(...args),
    appendMessage: (...args) => window.appendMessage(...args),
    appendChatMessage: (...args) => window.appendMessage(...args),
    addMessage: (...args) => window.addMessage(...args),
    addChatMessage: (...args) => window.addMessage(...args),
    createMessage: (...args) => window.createMessage(...args),
    createChatMessage: (...args) => window.createMessage(...args),
    insertMessage: (...args) => window.insertMessage(...args),
    insertChatMessage: (...args) => window.insertMessage(...args),
    sendMessage: sendMessageCompat,
    sendUserMessage: sendMessageCompat,
    sendMessageAsUser: sendMessageAsUserCompat,
    Generate: window.Generate,
    generate: window.generate,
    generateRaw: window.generateRaw,
    generateRawData: window.generateRawData,
    timestampToMoment: timestampToMomentCompat,
    humanizedDateTime: humanizedDateTimeCompat,
    uuidv4: window.uuidv4,
    generateQuietPrompt: window.generateQuietPrompt,
    setInputDraft: (content) => post({ type: 'st:setInputDraft', content: String(content ?? '') }),
    getVariables: () => (typeof window.getVariables === 'function' ? window.getVariables() : { ...globalVariableStore, ...chatVariableStore, ...localVariableStore }),
    getChatVariables: () => (typeof window.getChatVariables === 'function' ? window.getChatVariables() : chatVariableStore),
    getVariable: (path, fallback) => (typeof window.getVariable === 'function' ? window.getVariable(path, fallback) : getVariableWithPriorityCompat(chatVariableStore, localVariableStore, globalVariableStore, path, fallback)),
    getLocalVariable: (path, fallback) => (typeof window.getLocalVariable === 'function' ? window.getLocalVariable(path, fallback) : getStScopedVariableCompat(localVariableStore, path, fallback)),
    getGlobalVariable: (path, fallback) => (typeof window.getGlobalVariable === 'function' ? window.getGlobalVariable(path, fallback) : getStScopedVariableCompat(globalVariableStore, path, fallback)),
    setVariable: (path, value) => (typeof window.setVariable === 'function' ? window.setVariable(path, value) : (setByPath(chatVariableStore, path, value), persistVariableStores(), value)),
    setLocalVariable: (path, value) => (typeof window.setLocalVariable === 'function' ? window.setLocalVariable(path, value) : (setByPath(localVariableStore, path, value), persistVariableStores(), value)),
    setGlobalVariable: (path, value) => (typeof window.setGlobalVariable === 'function' ? window.setGlobalVariable(path, value) : (setByPath(globalVariableStore, path, value), persistVariableStores(), value)),
    replaceVariables: (text) => (typeof window.replaceVariables === 'function' ? window.replaceVariables(text) : substituteParamsCompat(text)),
    createOrReplaceWorldbook: (...args) => requestParent('createOrReplaceWorldbook', { name: args[0], entries: args[1], options: args[2] }),
    createOrReplaceCharWorldbook: (...args) => requestParent('createOrReplaceWorldbook', { name: args[0], entries: args[1], options: args[2], scope: 'character' }),
    createWorldbookEntries: (...args) => requestParent('createWorldbookEntries', { target: args[0], entries: args[1], options: args[2] }),
    getWorldbookEntries: (...args) => requestParent('getWorldbookEntries', { target: args[0] }),
    activateChatWorldbook: (...args) => requestParent('activateChatWorldbook', { worldbookName: args[0] }),
    rebindChatWorldbook: (...args) => requestParent('rebindChatWorldbook', { chatId: args[0], worldbookName: args[1] }),
    reloadCurrentChat: () => post({ type: 'refresh' }),
    substituteParams: (text) => (typeof window.substituteParams === 'function' ? window.substituteParams(text) : substituteParamsCompat(text)),
    swipe: {
      to: (messageIdOrSwipeId, maybeSwipeId) => {
        const hasExplicitMessage = maybeSwipeId !== undefined;
        return switchSwipeCompat(
          hasExplicitMessage ? messageIdOrSwipeId : ctx.messageId,
          hasExplicitMessage ? maybeSwipeId : messageIdOrSwipeId,
        );
      },
      left: (messageId = ctx.messageId) => {
        const index = resolveMessageIndex(messageId, {});
        const message = compatChat[index];
        return switchSwipeCompat(messageId, Number(message?.swipe_id || 0) - 1);
      },
      right: (messageId = ctx.messageId) => {
        const index = resolveMessageIndex(messageId, {});
        const message = compatChat[index];
        return switchSwipeCompat(messageId, Number(message?.swipe_id || 0) + 1);
      },
      show: () => true,
      hide: () => true,
      refresh: () => true,
      isAllowed: () => true,
      state: () => swipeStateCompat,
    },
    swipe_left: window.swipe_left || ((event = null, options = {}) => swipeCompat(event, -1, options)),
    swipe_right: window.swipe_right || ((event = null, options = {}) => swipeCompat(event, 1, options)),
    syncMesToSwipe: window.syncMesToSwipe || syncMesToSwipeByIdCompat,
    syncSwipeToMes: window.syncSwipeToMes || syncSwipeToMesByIdCompat,
    deleteMessage: deleteMessageCompat,
    deleteChatMessage: deleteMessageCompat,
    deleteLastMessage: deleteLastMessageCompat,
  };

  const installTavernHelperCompatProxy = () => {
    const existingHelper = window.TavernHelper && typeof window.TavernHelper === 'object'
      ? window.TavernHelper
      : {};
    Object.entries(tavernHelperCompat).forEach(([key, value]) => {
      existingHelper[key] = value;
    });
    if (existingHelper.__palinkTavernHelperProxy) {
      window.TavernHelper = existingHelper;
      return;
    }
    const proxy = new Proxy(existingHelper, {
      get(target, prop) {
        if (prop === 'then') return undefined;
        if (prop === '__palinkTavernHelperProxy') return true;
        if (prop in target) return target[prop];
        if (prop in tavernHelperCompat) return tavernHelperCompat[prop];
        return makeMissingApiFunction('TavernHelper.' + String(prop), { severity: 'warning' });
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
      has(target, prop) {
        return prop in target || prop in tavernHelperCompat;
      },
    });
    try { Object.defineProperty(proxy, '__palinkTavernHelperProxy', { value: true, configurable: true }); } catch {}
    window.TavernHelper = proxy;
  };
  installTavernHelperCompatProxy();

  const slashCommandStoreCompat = new Map();
  const registerSlashCommandCompat = (nameOrObject, callback, aliases = [], helpString = '', interrupt = false, purgeFromMessage = true) => {
    const commandObject = nameOrObject && typeof nameOrObject === 'object'
      ? nameOrObject
      : {
          name: nameOrObject,
          callback,
          aliases,
          helpString,
          interrupt,
          purgeFromMessage,
        };
    const name = String(commandObject.name || commandObject.command || '').trim();
    if (!name) return false;
    const entry = {
      ...commandObject,
      name,
      callback: typeof commandObject.callback === 'function' ? commandObject.callback : callback,
      aliases: Array.isArray(commandObject.aliases) ? commandObject.aliases.map(String) : [],
    };
    slashCommandStoreCompat.set(name, entry);
    entry.aliases.forEach((alias) => {
      if (alias) slashCommandStoreCompat.set(String(alias), entry);
    });
    return entry;
  };
  const parseSlashArgsCompat = (sourceText) => {
    const raw = String(sourceText || '').trim();
    if (!raw) return [];
    const slashBacktickCompat = String.fromCharCode(96);
    const slashArgPatternCompat = new RegExp(
      '"([^"]*)"|' + "'([^']*)'" + '|' + slashBacktickCompat + '([^' + slashBacktickCompat + ']*)' + slashBacktickCompat + '|(' + regexBackslashCompat + 'S+)',
      'g',
    );
    const matches = raw.match(slashArgPatternCompat) || [];
    return matches.map((token) => {
      const first = token.charAt(0);
      const last = token.charAt(token.length - 1);
      if ((first === '"' || first === "'" || first === slashBacktickCompat) && last === first) {
        return token.slice(1, -1);
      }
      return token;
    });
  };
  const parseSlashKeyValueArgsCompat = (sourceText) => {
    const tokens = parseSlashArgsCompat(sourceText);
    const firstEquals = tokens.findIndex((token) => token.includes('='));
    if (firstEquals >= 0) {
      const key = tokens[firstEquals].split('=').shift() || '';
      const value = tokens[firstEquals].slice(key.length + 1);
      return {
        key,
        value: [value, ...tokens.slice(firstEquals + 1)].filter(Boolean).join(' ').trim(),
      };
    }
    return { key: tokens[0] || '', value: tokens.slice(1).join(' ').trim() };
  };
  const parseSlashSpeakerArgsCompat = (sourceText) => {
    const tokens = parseSlashArgsCompat(sourceText);
    if (!tokens.length) return { name: ctx.characterName || 'Character', content: '' };
    const first = tokens[0] || '';
    if (first.includes('=')) {
      const key = first.split('=').shift()?.toLowerCase();
      const inlineValue = first.slice(String(key || '').length + 1);
      if (['name', 'char', 'character', 'speaker'].includes(String(key || ''))) {
        return {
          name: inlineValue || ctx.characterName || 'Character',
          content: tokens.slice(1).join(' ').trim(),
        };
      }
    }
    if (first.endsWith(':')) {
      return {
        name: first.slice(0, -1) || ctx.characterName || 'Character',
        content: tokens.slice(1).join(' ').trim(),
      };
    }
    return {
      name: first || ctx.characterName || 'Character',
      content: tokens.slice(1).join(' ').trim(),
    };
  };
  const executeSlashCommandCompat = async (source, context = {}) => {
    const text = String(source || '').trim().replace(/^\\/+/, '');
    if (!text) return '';
    const spaceIndex = text.search(new RegExp(regexBackslashCompat + 's'));
    const name = spaceIndex === -1 ? text : text.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
    const entry = slashCommandStoreCompat.get(name);
    if (entry && typeof entry.callback === 'function') return entry.callback(args, context, source);
    const lowerName = name.toLowerCase();
    if (['send', 'say', 'user', 'me', 'talk'].includes(lowerName)) {
      return sendMessageCompat(args, { source: 'slash-send', awaitResult: Boolean(context?.awaitResult) });
    }
    if (['setinput', 'input', 'draft'].includes(lowerName)) {
      window.setInputDraft?.(args);
      return args;
    }
    if (['sendas', 'char', 'character'].includes(lowerName)) {
      const parsed = parseSlashSpeakerArgsCompat(args);
      return addOneMessageCompat({
        role: 'assistant',
        name: parsed.name,
        is_name: true,
        content: parsed.content,
      });
    }
    if (['sys', 'system'].includes(lowerName)) {
      return addOneMessageCompat({ role: 'system', is_system: true, name: 'System', content: args });
    }
    if (['comment', 'note', 'narrator', 'narrate'].includes(lowerName)) {
      return addOneMessageCompat({
        role: 'assistant',
        name: ctx.characterName || 'Narrator',
        content: args,
        extra: { comment: true },
      });
    }
    if (['popup', 'toast', 'alert'].includes(lowerName)) {
      return window.callPopup?.(args, lowerName === 'popup' ? window.POPUP_TYPE?.TEXT : window.POPUP_TYPE?.DISPLAY);
    }
    if (['gen', 'generate', 'continue', 'regenerate', 'reroll'].includes(lowerName)) {
      return triggerGenerationCompat(lowerName === 'regenerate' ? 'regenerate' : 'normal', {
        quiet_prompt: args,
      }, Boolean(context?.dryRun));
    }
    if (['setvar', 'setglobalvar', 'setlocalvar'].includes(lowerName)) {
      const { key, value } = parseSlashKeyValueArgsCompat(args);
      if (!key) return '';
      if (lowerName === 'setglobalvar') return window.setGlobalVariable?.(key, value);
      if (lowerName === 'setlocalvar') return window.setLocalVariable?.(key, value);
      return window.setVariable?.(key, value);
    }
    if (['addvar', 'incvar', 'decvar'].includes(lowerName)) {
      const { key, value } = parseSlashKeyValueArgsCompat(args);
      if (!key) return '';
      const delta = lowerName === 'decvar' ? -Math.abs(Number(value || 1)) : Number(value || 1);
      return window.addVariable?.(key, Number.isFinite(delta) ? delta : 1);
    }
    if (['delvar', 'deletevar', 'unsetvar'].includes(lowerName)) {
      const key = parseSlashArgsCompat(args)[0] || '';
      if (!key) return false;
      return window.deleteVariable?.(key);
    }
    if (['getvar', 'getglobalvar', 'getlocalvar'].includes(lowerName)) {
      const key = parseSlashArgsCompat(args)[0] || '';
      if (!key) return '';
      if (lowerName === 'getglobalvar') return window.getGlobalVariable?.(key, '');
      if (lowerName === 'getlocalvar') return window.getLocalVariable?.(key, '');
      return window.getVariable?.(key, '');
    }
    if (['append', 'add', 'insert', 'create'].includes(lowerName)) {
      return addOneMessageCompat({ role: 'assistant', name: ctx.characterName, content: args });
    }
    return '';
  };
  window.SlashCommandParser = window.SlashCommandParser && typeof window.SlashCommandParser === 'object'
    ? window.SlashCommandParser
    : {};
  window.SlashCommandParser.addCommandObject = (commandObject) => registerSlashCommandCompat(commandObject);
  window.SlashCommandParser.addCommand = (name, callback, aliases, helpString, interrupt, purgeFromMessage) => (
    registerSlashCommandCompat(name, callback, aliases, helpString, interrupt, purgeFromMessage)
  );
  window.SlashCommandParser.commands = slashCommandStoreCompat;
  window.SlashCommandParser.execute = executeSlashCommandCompat;
  window.SlashCommandParser.parse = executeSlashCommandCompat;
  setCompatFunction('registerSlashCommand', (name, callback, aliases, helpString, interrupt, purgeFromMessage) => (
    registerSlashCommandCompat(name, callback, aliases, helpString, interrupt, purgeFromMessage)
  ));
  setCompatFunction('executeSlashCommandsWithOptions', async (source = '', options = {}) => {
    const normalizedSource = typeof source === 'object' && source !== null
      ? String(source.command || source.source || source.text || source.value || '')
      : String(source || '');
    return executeSlashCommandCompat(normalizedSource, options && typeof options === 'object' ? options : {});
  });
  setCompatFunction('executeSlashCommands', executeSlashCommandCompat);
  setCompatFunction('executeSlashCommandsOnChatInput', async (source = parentElementStore.send_textarea?.value || '', context = {}) => {
    const result = await executeSlashCommandCompat(source, context);
    if (!result && String(source || '').trim() && !String(source || '').trim().startsWith('/')) {
      return sendMessageCompat(source, { source: 'executeSlashCommandsOnChatInput' });
    }
    return result;
  });
  setCompatFunction('executeSlashCommand', executeSlashCommandCompat);
  ensureObject('ARGUMENT_TYPE', {
    STRING: 'string',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
    VARIABLE_NAME: 'variable_name',
  });
  window.SlashCommand = window.SlashCommand || function SlashCommandCompat(config = {}) { Object.assign(this, config); };
  window.SlashCommandArgument = window.SlashCommandArgument || function SlashCommandArgumentCompat(config = {}) { Object.assign(this, config); };
  window.SlashCommandNamedArgument = window.SlashCommandNamedArgument || function SlashCommandNamedArgumentCompat(config = {}) { Object.assign(this, config); };
  window.SlashCommandEnumValue = window.SlashCommandEnumValue || function SlashCommandEnumValueCompat(config = {}) { Object.assign(this, config); };

  window.eventSource = window.eventSource || {
    _listeners: new Map(),
    _palinkFiredEvents: new Map(),
    _palinkReplayReadyPatched: true,
    on(type, callback) {
      if (typeof callback !== 'function') return () => {};
      const key = String(type);
      if (!this._listeners.has(key)) this._listeners.set(key, new Set());
      this._listeners.get(key).add(callback);
      if (this._palinkFiredEvents?.has(key)) {
        const args = this._palinkFiredEvents.get(key) || [];
        setTimeout(() => {
          if (this._listeners.get(key)?.has(callback)) {
            try { callback(...args); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
          }
        }, 0);
      }
      return () => this.off(key, callback);
    },
    makeLast(type, callback) {
      const key = String(type);
      this.off(key, callback);
      return this.on(key, callback);
    },
    off(type, callback) {
      return this._listeners.get(String(type))?.delete(callback) || false;
    },
    removeListener(type, callback) {
      return this.off(type, callback);
    },
    removeAllListeners(type) {
      if (type === undefined) this._listeners.clear();
      else this._listeners.delete(String(type));
    },
    async emit(type, ...args) {
      const key = String(type);
      if (key === window.event_types?.APP_INITIALIZED || key === window.event_types?.APP_READY) {
        this._palinkFiredEvents?.set(key, args);
      }
      const listeners = Array.from(this._listeners.get(key) || []);
      for (const listener of listeners) {
        try {
          // Preserve SillyTavern-style ordering while allowing async listeners.
          // eslint-disable-next-line no-await-in-loop
          await listener(...args);
        } catch (error) {
          post({ type: 'error', message: String(error?.message || error) });
        }
      }
      return true;
    },
    emitAndWait(type, ...args) {
      return this.emit(type, ...args);
    },
    once(type, callback) {
      const off = this.on(type, (...args) => {
        off();
        return callback(...args);
      });
      return off;
    },
  };
  if (!window.eventSource._palinkFiredEvents) window.eventSource._palinkFiredEvents = new Map();
  if (!window.eventSource._palinkReplayReadyPatched) {
    const originalOnCompat = typeof window.eventSource.on === 'function' ? window.eventSource.on.bind(window.eventSource) : null;
    window.eventSource.on = (type, callback) => {
      const off = originalOnCompat ? originalOnCompat(type, callback) : (() => {});
      const key = String(type);
      if (typeof callback === 'function' && window.eventSource._palinkFiredEvents?.has(key)) {
        const args = window.eventSource._palinkFiredEvents.get(key) || [];
        setTimeout(() => {
          try { callback(...args); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
        }, 0);
      }
      return off;
    };
    const originalEmitCompat = typeof window.eventSource.emit === 'function' ? window.eventSource.emit.bind(window.eventSource) : null;
    window.eventSource.emit = (type, ...args) => {
      const key = String(type);
      if (key === window.event_types?.APP_INITIALIZED || key === window.event_types?.APP_READY) {
        window.eventSource._palinkFiredEvents?.set(key, args);
      }
      return originalEmitCompat ? originalEmitCompat(type, ...args) : Promise.resolve();
    };
    window.eventSource._palinkReplayReadyPatched = true;
  }
  {
    const source = window.eventSource && typeof window.eventSource === 'object' ? window.eventSource : {};
    const listeners = source._listeners instanceof Map ? source._listeners : new Map();
    const firedEvents = source._palinkFiredEvents instanceof Map ? source._palinkFiredEvents : new Map();
    source._listeners = listeners;
    source._palinkFiredEvents = firedEvents;
    source.on = (type, callback) => {
      if (typeof callback !== 'function') return () => {};
      const key = String(type);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
      if (firedEvents.has(key)) {
        const args = firedEvents.get(key) || [];
        setTimeout(() => {
          if (listeners.get(key)?.has(callback)) {
            try { callback(...args); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
          }
        }, 0);
      }
      return () => source.off(key, callback);
    };
    source.makeLast = (type, callback) => {
      const key = String(type);
      source.off(key, callback);
      return source.on(key, callback);
    };
    source.off = (type, callback) => listeners.get(String(type))?.delete(callback) || false;
    source.removeListener = source.off;
    source.removeAllListeners = (type) => {
      if (type === undefined) listeners.clear();
      else listeners.delete(String(type));
    };
    source.once = (type, callback) => {
      const off = source.on(type, (...args) => {
        off();
        return callback(...args);
      });
      return off;
    };
    source.emit = async (type, ...args) => {
      const key = String(type);
      if (key === window.event_types?.APP_INITIALIZED || key === window.event_types?.APP_READY) {
        firedEvents.set(key, args);
      }
      const currentListeners = Array.from(listeners.get(key) || []);
      for (const listener of currentListeners) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await listener(...args);
        } catch (error) {
          post({ type: 'error', message: String(error?.message || error) });
        }
      }
      return true;
    };
    source.emitAndWait = (type, ...args) => source.emit(type, ...args);
    source._palinkReplayReadyPatched = true;
    source._palinkAsyncEmitter = true;
    window.eventSource = source;
  }

  ensureFunction('eventOn', (type, callback) => window.eventSource.on(type, callback));
  ensureFunction('eventMakeLast', (type, callback) => window.eventSource.makeLast(type, callback));
  setCompatFunction('getRegexScripts', () => getAllRegexScriptsCompat().map((script) => {
    const copy = clone(script);
    if (copy && typeof copy === 'object') delete copy.__order;
    return copy;
  }));
  setCompatFunction('getRegexedString', (text, placement = 2, options = {}) => applyDisplayRegexScriptsCompat(String(text ?? ''), {
    placement: Number.isFinite(Number(placement)) ? Number(placement) : 2,
    isMarkdown: Boolean(options?.isMarkdown),
    isPrompt: Boolean(options?.isPrompt),
    depth: Number.isFinite(Number(options?.depth)) ? Number(options.depth) : undefined,
  }));
  setCompatFunction('getChatMessages', (messageId) => getCompatChatMessages(messageId));
  setCompatFunction('getCurrentMessageId', () => ctx.messageId);
  setCompatFunction('syncMesToSwipe', syncMesToSwipeByIdCompat);
  setCompatFunction('syncSwipeToMes', syncSwipeToMesByIdCompat);
  setCompatFunction('swipe', swipeCompat);
  setCompatFunction('swipe_left', (event = null, options = {}) => swipeCompat(event, -1, options));
  setCompatFunction('swipe_right', (event = null, options = {}) => swipeCompat(event, 1, options));
  setCompatFunction('getVariables', () => ({ ...globalVariableStore, ...chatVariableStore, ...localVariableStore }));
  setCompatFunction('getChatVariables', () => chatVariableStore);
  setCompatFunction('getVariable', (path, fallback) => getVariableWithPriorityCompat(chatVariableStore, localVariableStore, globalVariableStore, path, fallback));
  setCompatFunction('getLocalVariable', (path, fallback) => getStScopedVariableCompat(localVariableStore, path, fallback));
  setCompatFunction('getGlobalVariable', (path, fallback) => getStScopedVariableCompat(globalVariableStore, path, fallback));
  setCompatFunction('setVariable', (path, value) => {
    const result = setByPath(chatVariableStore, path, value);
    persistVariableStores();
    emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
    return result;
  });
  setCompatFunction('setLocalVariable', (path, value) => {
    const result = setByPath(localVariableStore, path, value);
    persistVariableStores();
    return result;
  });
  setCompatFunction('setGlobalVariable', (path, value) => {
    const result = setByPath(globalVariableStore, path, value);
    persistVariableStores();
    return result;
  });
  setCompatFunction('hasVariable', (path) => getByPath(chatVariableStore, path, undefined) !== undefined);
  setCompatFunction('hasLocalVariable', (path) => getByPath(localVariableStore, path, undefined) !== undefined);
  setCompatFunction('hasGlobalVariable', (path) => getByPath(globalVariableStore, path, undefined) !== undefined);
  setCompatFunction('deleteVariable', (path) => {
    const result = deleteByPath(chatVariableStore, path);
    persistVariableStores();
    emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
    return result;
  });
  setCompatFunction('deleteLocalVariable', (path) => {
    const result = deleteByPath(localVariableStore, path);
    persistVariableStores();
    return result;
  });
  setCompatFunction('deleteGlobalVariable', (path) => {
    const result = deleteByPath(globalVariableStore, path);
    persistVariableStores();
    return result;
  });
  setCompatFunction('addVariable', (path, delta = 1) => {
    const result = mutateNumberByPath(chatVariableStore, path, delta);
    persistVariableStores();
    emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
    return result;
  });
  setCompatFunction('addLocalVariable', (path, delta = 1) => {
    const result = mutateNumberByPath(localVariableStore, path, delta);
    persistVariableStores();
    return result;
  });
  setCompatFunction('addGlobalVariable', (path, delta = 1) => {
    const result = mutateNumberByPath(globalVariableStore, path, delta);
    persistVariableStores();
    return result;
  });
  setCompatFunction('replaceVariables', substituteParamsCompat);
  setCompatFunction('substituteParams', substituteParamsCompat);
  setCompatFunction('substituteParamsExtended', (content, additionalMacro = {}, postProcessFn = (value) => value) => (
    substituteParamsCompat(content, { dynamicMacros: additionalMacro, postProcessFn })
  ));
  setCompatFunction('substituteParamsLegacy', (content, name1, name2, original, group, replaceCharacterCard = true, additionalMacro = {}, postProcessFn = (value) => value) => (
    substituteParamsCompat(content, name1, name2, original, group, replaceCharacterCard, additionalMacro, postProcessFn)
  ));
  setCompatFunction('registerMacro', (name, handlerOrConfig = '') => {
    const normalized = normalizeMacroNameCompat(name);
    if (!normalized) return false;
    macroRegistryCompat.set(normalized, handlerOrConfig);
    macroRegistryCompat.set(normalized.toLowerCase(), handlerOrConfig);
    return true;
  });
  setCompatFunction('unregisterMacro', (name) => {
    const normalized = normalizeMacroNameCompat(name);
    if (!normalized) return false;
    const deleted = macroRegistryCompat.delete(normalized);
    const lowerDeleted = macroRegistryCompat.delete(normalized.toLowerCase());
    return deleted || lowerDeleted;
  });
  const macrosCompat = {
    register: window.registerMacro,
    unregister: window.unregisterMacro,
    registerMacro: window.registerMacro,
    unregisterMacro: window.unregisterMacro,
    get: (name) => macroRegistryCompat.get(normalizeMacroNameCompat(name)) ?? macroRegistryCompat.get(normalizeMacroNameCompat(name).toLowerCase()),
    getMacro: (name) => macroRegistryCompat.get(normalizeMacroNameCompat(name)) ?? macroRegistryCompat.get(normalizeMacroNameCompat(name).toLowerCase()),
    has: (name) => macroRegistryCompat.has(normalizeMacroNameCompat(name)) || macroRegistryCompat.has(normalizeMacroNameCompat(name).toLowerCase()),
    registry: {
      register: window.registerMacro,
      unregister: window.unregisterMacro,
      registerMacro: window.registerMacro,
      unregisterMacro: window.unregisterMacro,
      getMacro: (name) => macroRegistryCompat.get(normalizeMacroNameCompat(name)) ?? macroRegistryCompat.get(normalizeMacroNameCompat(name).toLowerCase()),
      hasMacro: (name) => macroRegistryCompat.has(normalizeMacroNameCompat(name)) || macroRegistryCompat.has(normalizeMacroNameCompat(name).toLowerCase()),
      entries: () => Array.from(macroRegistryCompat.entries()),
    },
  };
  window.macros = window.macros && typeof window.macros === 'object'
    ? Object.assign(window.macros, macrosCompat)
    : macrosCompat;
  window.MacrosParser = window.MacrosParser || {
    registerMacro: window.registerMacro,
    unregisterMacro: window.unregisterMacro,
  };
  window.MacroEnvBuilder = window.MacroEnvBuilder || function MacroEnvBuilderCompat() {
    this.build = () => ({});
    this.set = () => this;
    this.withContext = () => this;
  };
  window.MacroEngine = window.MacroEngine || {
    evaluate: (text) => window.substituteParams?.(text) ?? String(text ?? ''),
    replace: (text) => window.substituteParams?.(text) ?? String(text ?? ''),
  };
  window.IGNORE_SYMBOL = window.IGNORE_SYMBOL || Symbol.for('SillyTavern.ignore');
  window.inject_ids = window.inject_ids || {
    QUIET_PROMPT: 'quiet_prompt',
    DEPTH_PROMPT: 'depth_prompt',
    DEPTH_PROMPT_INDEX: (index) => 'depth_prompt_' + String(index),
    STORY_STRING: 'story_string',
    CUSTOM_WI_OUTLET: (key) => 'custom_wi_' + String(key),
    CUSTOM_WI_DEPTH_ROLE: (depth, role) => 'custom_wi_depth_' + String(depth) + '_' + String(role),
  };
  window.tokenizers = window.tokenizers || {};
  setCompatFunction('getTextTokens', (text) => String(text ?? '').split(/\\s+/).filter(Boolean));
  setCompatFunction('getTokenCount', (text) => Math.ceil(String(text ?? '').length / 4));
  setCompatFunction('getTokenCountAsync', async (text) => window.getTokenCount(text));
  setCompatFunction('getTokenizerModel', () => 'palink');
  window.ToolManager = window.ToolManager || {
    RECURSE_LIMIT: 3,
    registerFunctionTool: () => true,
    unregisterFunctionTool: () => true,
    isToolCallingSupported: () => false,
    canPerformToolCalls: () => false,
    hasToolCalls: () => false,
    invokeFunctionTools: async () => ({ invocations: [], errors: [] }),
    saveFunctionToolInvocations: async () => true,
    showToolCallError: () => true,
    initToolSlashCommands: () => true,
  };
  window.ScraperManager = window.ScraperManager || {
    registerDataBankScraper: () => true,
    unregisterDataBankScraper: () => true,
    getDataBankScrapers: () => [],
  };
  window.ConnectionManagerRequestService = window.ConnectionManagerRequestService || class ConnectionManagerRequestServiceCompat {
    constructor(config = {}) { this.config = config; }
    async sendRequest() { return { ok: true, data: null }; }
    async request() { return { ok: true, data: null }; }
  };
  window.ModuleWorkerWrapper = window.ModuleWorkerWrapper || class ModuleWorkerWrapperCompat {
    constructor(worker = null) { this.worker = worker; }
    terminate() { try { this.worker?.terminate?.(); } catch {} }
    postMessage(message) { try { this.worker?.postMessage?.(message); } catch {} }
  };
  const makeVariableApiCompat = (store, getFn, setFn, delFn, addFn, hasFn) => ({
    get: getFn,
    set: setFn,
    del: delFn,
    delete: delFn,
    deleteVariable: delFn,
    add: addFn,
    inc: (path, delta = 1) => addFn(path, delta),
    dec: (path, delta = 1) => addFn(path, -Math.abs(Number(delta || 1))),
    has: hasFn,
    all: () => store,
  });
  const variablesCompat = {
    chat: makeVariableApiCompat(chatVariableStore, window.getVariable, window.setVariable, window.deleteVariable, window.addVariable, window.hasVariable),
    local: makeVariableApiCompat(localVariableStore, window.getLocalVariable, window.setLocalVariable, window.deleteLocalVariable, window.addLocalVariable, window.hasLocalVariable),
    global: makeVariableApiCompat(globalVariableStore, window.getGlobalVariable, window.setGlobalVariable, window.deleteGlobalVariable, window.addGlobalVariable, window.hasGlobalVariable),
  };
  ensureFunction('saveMetadataDebounced', window.saveSettingsDebounced);
  setCompatFunction('messageFormatter', messageFormatterCompat);
  setCompatFunction('messageFormatting', messageFormattingCompat);
  setCompatFunction('MessageFormatter', messageFormatterCompat);
  setCompatFunction('sendToTavern', (content, options = {}) => sendMessageCompat(content, options));

  const mvuGetAllVariables = () => {
    const merged = { ...globalVariableStore, ...chatVariableStore, ...localVariableStore };
    return merged;
  };

  window.Mvu = window.Mvu || {};
  // [SINGLE-SOURCE] 变量读写统一由 compatV2 的 chatVariableStore/localVariableStore/globalVariableStore
  // 作为唯一真源。这里**无条件覆盖** window.Mvu 上的变量函数，绝不能用
  // window.Mvu.xxx || window.xxx 短路——legacy-st-sim 先注入时已把 window.Mvu.getVariable/
  // setVariable 预置为其独立 smartCardVariableStore 的读写（写 iframe memoryStorage，销毁即丢），
  // 短路会再次把全局变量 API 打回 legacy 版本，导致双 store 读写不一致、iframe 重载后变量丢失。
  Object.assign(window.Mvu, {
    events: window.Mvu.events || {
      VARIABLE_UPDATE_STARTED: 'VARIABLE_UPDATE_STARTED',
      VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED',
      CHAT_VARIABLES_UPDATED: 'CHAT_VARIABLES_UPDATED',
    },
    getAllVariables: mvuGetAllVariables,
    getVariable: (path, fallback) => getVariableWithPriorityCompat(chatVariableStore, localVariableStore, globalVariableStore, path, fallback),
    setVariable: (path, value) => {
      const result = setByPath(chatVariableStore, path, value);
      persistVariableStores();
      emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
      return result;
    },
    replaceVariables: window.replaceVariables,
  });

  // 面板脚本（如 JS-Slash-Runner 生成的状态栏）裸调用 getAllVariables()/getVariable() 等，
  // 必须暴露为 window 全局。原实现仅挂在 window.Mvu 上，裸调用会在 requiredApis 循环里命中空桩，
  // 返回 undefined → stat_data 恒空 → 照片/服饰/内心想法不显示。
  setCompatFunction('getAllVariables', window.Mvu.getAllVariables);
  setCompatFunction('getVariable', window.Mvu.getVariable);
  setCompatFunction('setVariable', window.Mvu.setVariable);
  setCompatFunction('replaceVariables', window.Mvu.replaceVariables);

  // 面板脚本（如状态栏）通常以 $(errorCatched(init)) 触发初始化。
  // 父页面 CharacterCardRenderer.tsx 只在宿主 window 上装了 errorCatched；
  // iframe 内部若未提供，会落入 requiredApis 的空桩（只上报诊断、不真正执行 init），
  // 导致 refreshFromMVU() 永不调用 → getAllVariables() 永不执行 → 动态内容恒空。
  // 对齐 SillyTavern 真实行为：errorCatched 必须真正执行被包装的函数（包 try/catch）。
  if (typeof window.errorCatched !== 'function') {
    setCompatFunction('errorCatched', (fn) => {
      try {
        const result = typeof fn === 'function' ? fn() : undefined;
        if (result && typeof result.catch === 'function') {
          result.catch((err) => { /* swallow async error */ });
        }
        return result;
      } catch (err) {
        return undefined;
      }
    });
  }

  window.AutoCardUpdaterAPI = window.AutoCardUpdaterAPI || {};
  Object.assign(window.AutoCardUpdaterAPI, {
    exportTableAsJson: window.AutoCardUpdaterAPI.exportTableAsJson || (async () => ({ rows: [], data: {}, metadata: window.chat_metadata || {} })),
    initGameSession: window.AutoCardUpdaterAPI.initGameSession || (async () => ({ success: true, chat: getCompatChatMessages() })),
    getChatMessages: window.AutoCardUpdaterAPI.getChatMessages || (() => getCompatChatMessages()),
    updateMessageBlock: window.AutoCardUpdaterAPI.updateMessageBlock || window.updateMessageBlock,
    setChatMessage: window.AutoCardUpdaterAPI.setChatMessage || window.setChatMessage,
    registerTableUpdateCallback: window.AutoCardUpdaterAPI.registerTableUpdateCallback || ((callback) => {
      if (typeof callback === 'function') {
        try { setTimeout(() => callback({ rows: [], data: {}, metadata: window.chat_metadata || {} }), 0); } catch {}
      }
      return () => {};
    }),
  });
  const getContextCompat = () => ({
    accountStorage: accountStorageCompat,
    chat: window.chat,
    characters: window.characters,
    groups: window.groups,
    getGroups: window.getGroups,
    getGroupChat: window.getGroupChat,
    name1: ctx.userName,
    name2: ctx.characterName,
    characterId: window.this_chid,
    characterUuid: ctx.characterId,
    this_chid: window.this_chid,
    groupId: window.selected_group,
    selected_group: window.selected_group,
    chatId: ctx.sessionId,
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    viewport: ctx.viewport || {},
    presentationMode: ctx.presentationMode || 'inline',
    isImmersive: Boolean(ctx.viewport?.immersive) || String(ctx.presentationMode || '').startsWith('immersive'),
    getCurrentChatId: () => ctx.sessionId,
    onlineStatus: 'connected',
    maxContext: 0,
    streamingProcessor: null,
    getRequestHeaders: window.getRequestHeaders,
    reloadCurrentChat: window.reloadCurrentChat,
    renameChat: async () => true,
    saveSettingsDebounced: window.saveSettingsDebounced,
    chatMetadata: window.chat_metadata || {},
    chat_metadata: window.chat_metadata || {},
    saveMetadataDebounced: window.saveMetadataDebounced,
    saveMetadata: window.saveMetadata,
    updateChatMetadata: (key, value) => {
      if (typeof key === 'string') window.chat_metadata[key] = value;
      persistStorageValue('__palink_chat_metadata', window.chat_metadata || {});
      // 通知 ST 插件 chat_metadata 已变更
      emitCompatEvent(window.event_types?.CHAT_METADATA_UPDATED || 'chat_metadata_updated', { metadata: window.chat_metadata || {}, source: 'variable' });
      return window.chat_metadata;
    },
    eventSource: window.eventSource,
    eventTypes: window.event_types,
    event_types: window.event_types,
    addOneMessage: window.addOneMessage,
    appendMessage: window.appendMessage,
    appendChatMessage: window.appendChatMessage,
    addMessage: window.addMessage,
    addChatMessage: window.addChatMessage,
    createMessage: window.createMessage,
    createChatMessage: window.createChatMessage,
    insertMessage: window.insertMessage,
    insertChatMessage: window.insertChatMessage,
    deleteLastMessage: deleteLastMessageCompat,
    deleteMessage: deleteMessageCompat,
    syncMesToSwipe: window.syncMesToSwipe,
    syncSwipeToMes: window.syncSwipeToMes,
    Generate: window.Generate,
    generate: window.generate,
    generateRaw: window.generateRaw,
    generateRawData: window.generateRawData,
    generateQuietPrompt: window.generateQuietPrompt,
    sendGenerationRequest: async (type, data = {}) => window.generate?.({ type, ...(data && typeof data === 'object' ? data : {}) }),
    sendStreamingRequest: async (type, data = {}) => window.generate?.({ type, stream: true, ...(data && typeof data === 'object' ? data : {}) }),
    stopGeneration: window.stopGeneration,
    activateSendButtons: () => true,
    deactivateSendButtons: () => true,
    sendMessageAsUser: sendMessageAsUserCompat,
    sendMessage: sendMessageCompat,
    saveChat: window.saveChat,
    saveChatConditional: window.saveChatConditional,
    saveReply: async (content) => addOneMessageCompat({ role: 'assistant', name: ctx.characterName, content }),
    sendSystemMessage: async (content) => addOneMessageCompat({ role: 'system', is_system: true, name: 'System', content }),
    openCharacterChat: async () => true,
    openGroupChat: async (groupId = window.selected_group) => window.select_group_chats?.(groupId) ?? true,
    generateGroupWrapper: window.generateGroupWrapper,
    regenerateGroup: window.regenerateGroup,
    substituteParams: window.substituteParams,
    substituteParamsExtended: window.substituteParams,
    getTokenCount: (text) => String(text ?? '').length,
    getTokenCountAsync: async (text) => String(text ?? '').length,
    getTextTokens: (text) => String(text ?? '').split(/\s+/).filter(Boolean),
    tokenizers: window.tokenizers || {},
    getTokenizerModel: () => 'palink',
    extensionSettings: window.extension_settings,
    extension_settings: window.extension_settings,
    extensionPrompts: getExtensionPromptStoreCompat(),
    setExtensionPrompt: window.setExtensionPrompt,
    getExtensionPrompt: window.getExtensionPrompt,
    writeExtensionField: window.writeExtensionField,
    writeExtensionFieldBulk: window.writeExtensionFieldBulk,
    readExtensionField: window.readExtensionField,
    updateMessageBlock: window.updateMessageBlock,
    updateChatMessage: window.updateChatMessage,
    replaceChatMessage: window.replaceChatMessage,
    editChatMessage: window.editChatMessage,
    setMessageBlock: window.setMessageBlock,
    setChatMessageBlock: window.setChatMessageBlock,
    editMessageBlock: window.editMessageBlock,
    replaceMessageBlock: window.replaceMessageBlock,
    setChatMessage: window.setChatMessage,
    messageFormatting: window.messageFormatting,
    messageFormatter: window.messageFormatter,
    MessageFormatter: window.MessageFormatter,
    SlashCommandParser: window.SlashCommandParser,
    SlashCommand: window.SlashCommand,
    SlashCommandArgument: window.SlashCommandArgument,
    SlashCommandNamedArgument: window.SlashCommandNamedArgument,
    SlashCommandEnumValue: window.SlashCommandEnumValue,
    ARGUMENT_TYPE: window.ARGUMENT_TYPE,
    executeSlashCommandsWithOptions: window.executeSlashCommandsWithOptions,
    registerSlashCommand: window.registerSlashCommand,
    executeSlashCommands: window.executeSlashCommands,
    registerFunctionTool: window.ToolManager.registerFunctionTool,
    unregisterFunctionTool: window.ToolManager.unregisterFunctionTool,
    isToolCallingSupported: window.ToolManager.isToolCallingSupported,
    canPerformToolCalls: window.ToolManager.canPerformToolCalls,
    ToolManager: window.ToolManager,
    registerDataBankScraper: window.ScraperManager.registerDataBankScraper,
    ScraperManager: window.ScraperManager,
    ModuleWorkerWrapper: window.ModuleWorkerWrapper,
    shouldSendOnEnter: () => true,
    isMobile: window.matchMedia?.('(max-width: 768px)')?.matches || false,
    t: (key) => key,
    translate: (key) => key,
    getCurrentLocale: () => ctx.language || 'zh',
    addLocaleData: () => true,
    Popup: window.Popup,
    POPUP_TYPE: window.POPUP_TYPE,
    POPUP_RESULT: window.POPUP_RESULT,
    callPopup: window.callPopup,
    callGenericPopup: window.callGenericPopup,
    showLoader: () => true,
    hideLoader: () => true,
    mainApi: 'palink',
    powerUserSettings: window.power_user,
    power_user: window.power_user,
    Mvu: window.Mvu,
    TavernHelper: window.TavernHelper,
    getChatMessages: window.getChatMessages,
    getCharacters: window.getCharacters,
    getOneCharacter: window.getOneCharacter,
    getThumbnailUrl: window.getThumbnailUrl,
    selectCharacterById: window.selectCharacterById,
    getCharacterCardFields: (character = window.characters?.[window.this_chid]) => clone(character?.data || character || {}),
    getCharacterSource: () => '',
    importFromExternalUrl: async () => null,
    importTags: async () => [],
    tags: [],
    tagMap: {},
    menuType: ctx.presentationMode || 'chat',
    createCharacterData: {},
    getCurrentMessageId: window.getCurrentMessageId,
    swipe: window.TavernHelper?.swipe || tavernHelperCompat.swipe,
    swipe_left: window.swipe_left,
    swipe_right: window.swipe_right,
    variables: variablesCompat,
    macros: window.macros,
    registerMacro: window.registerMacro,
    unregisterMacro: window.unregisterMacro,
    appendMediaToMessage: async () => true,
    ensureMessageMediaIsArray: (message) => {
      if (message && typeof message === 'object' && !Array.isArray(message.extra?.media)) {
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra.media = [];
      }
      return message?.extra?.media || [];
    },
    getMediaDisplay: () => 'inline',
    getMediaIndex: () => -1,
    scrollChatToBottom: window.scrollChatToBottom,
    scrollOnMediaLoad: () => true,
    loadWorldInfo: async () => ({}),
    saveWorldInfo: async () => true,
    reloadWorldInfoEditor: async () => true,
    updateWorldInfoList: async () => true,
    convertCharacterBook: (book) => book || {},
    getWorldInfoPrompt: async () => '',
    getWorldInfoNames: () => Array.isArray(window.world_names) ? [...window.world_names] : [],
    CONNECT_API_MAP: {},
    getTextGenServer: async () => '',
    extractMessageFromData: (data) => data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.text || data?.content || '',
    getChatCompletionModel: () => '',
    printMessages: window.printMessages,
    clearChat: window.clearChat,
    ChatCompletionService: class ChatCompletionServiceCompat {},
    TextCompletionService: class TextCompletionServiceCompat {},
    ConnectionManagerRequestService: window.ConnectionManagerRequestService,
    updateReasoningUI: () => true,
    parseReasoningFromString: (value) => ({ reasoning: '', content: String(value ?? '') }),
    getReasoningTemplateByName: () => null,
    unshallowCharacter: (character) => character,
    unshallowGroupMembers: (group) => group,
    getExtensionManifest: (extensionName = '') => {
      const plugins = Array.isArray(window.extension_settings?.palink_plugin_runtime?.plugins)
        ? window.extension_settings.palink_plugin_runtime.plugins
        : [];
      const needle = String(extensionName || '').toLowerCase();
      const plugin = plugins.find((item) => {
        const manifest = item?.manifest && typeof item.manifest === 'object' ? item.manifest : {};
        return [item?.id, item?.name, manifest.id, manifest.name, manifest.display_name]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase() === needle);
      });
      return plugin?.manifest || null;
    },
    openThirdPartyExtensionMenu: openThirdPartyExtensionMenuCompat,
    symbols: { ignore: window.IGNORE_SYMBOL },
    constants: { unset: null },
    getPresetManager: () => ({
      getSelectedPresetName: () => 'Palink',
      getSelectedPreset: () => parseMaybeJsonObject(ctx.presetData, {}),
      readPresetExtensionField: ({ path } = {}) => {
        if (!path || path === 'regex_scripts') return clone(presetRegexScripts);
        return getByPath(parseMaybeJsonObject(ctx.presetData, {}), String(path), undefined);
      },
      writePresetExtensionField: async () => true,
    }),
    loader: {
      show: () => post({ type: 'log', level: 'info', message: 'loader.show' }),
      hide: () => post({ type: 'log', level: 'info', message: 'loader.hide' }),
    },
  });
  window.getContext = getContextCompat;
  window.SillyTavern = window.SillyTavern || {};
  window.SillyTavern.libs = {
    ...(window.SillyTavern.libs && typeof window.SillyTavern.libs === 'object' ? window.SillyTavern.libs : {}),
    toastr: window.toastr,
    $: window.$,
    jQuery: window.jQuery || window.$,
    DOMPurify: domPurifyCompat,
    Handlebars: handlebarsCompat,
    _: lodashCompat,
    lodash: lodashCompat,
    moment: momentCompat,
    dayjs: window.dayjs || momentCompat,
    accountStorage: accountStorageCompat,
    localforage: localforageCompat,
  };
  window.SillyTavern.getContext = getContextCompat;
  window.SillyTavern.getCurrentMessageId = window.getCurrentMessageId;
  window.SillyTavern.getChatMessages = window.getChatMessages;
  window.SillyTavern.getGroups = window.getGroups;
  window.SillyTavern.getGroupChat = window.getGroupChat;
  window.SillyTavern.openThirdPartyExtensionMenu = openThirdPartyExtensionMenuCompat;
  window.openThirdPartyExtensionMenu = openThirdPartyExtensionMenuCompat;

  // ── ST 1.18.0 generate_interceptor 编排器（palink-native 模式）─────────
  // ST 核心 extensions.js 的 runGenerationInterceptors 在 compat 运行时未加载，
  // 这里复刻其编排逻辑：遍历已加载扩展（按 loading_order 排序）中声明了
  // manifest.generate_interceptor 的扩展，调用 globalThis[interceptorKey](chat, contextSize, abort, type)。
  // 各扩展在自身 index.js 中自注册 globalThis[manifest.generate_interceptor]（如 vectors_rearrangeChat）。
  const runGenerationInterceptorsCompat = async (chat, contextSize, type) => {
    let aborted = false;
    let exitImmediately = false;
    const abort = (immediately) => {
      aborted = true;
      exitImmediately = immediately;
    };
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat());
    for (const plugin of plugins) {
      if (aborted && exitImmediately) break;
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const interceptorKey = manifest.generate_interceptor;
      if (!interceptorKey) continue;
      // K-7 修复: 沙箱内插件通过 globalThis[interceptorKey] = fn 注册拦截器，但函数存于
      // 沙箱 pluginGlobals、真实 window 不可见。PluginSandbox 已把函数值镜像到共享桥接表
      // __stPluginGlobalBridge，此处优先从桥接表读取，回落真实全局（兼容原生脚本注入路径）。
      const bridge = globalThis.__stPluginGlobalBridge ?? {};
      const fn = bridge[interceptorKey] ?? globalThis[interceptorKey];
      if (typeof fn !== 'function') continue;
      try {
        await fn(chat, contextSize, abort, type);
      } catch (err) {
        console.error('[st-interceptor]', interceptorKey, 'failed:', err);
      }
      if (aborted && exitImmediately) break;
    }
    return aborted;
  };
  // 收集 ST 扩展通过 setExtensionPrompt 注入的扩展提示，转换为后端 extension_prompts 形状。
  const getExtensionPromptsCompat = () => Object.entries(getExtensionPromptStoreCompat()).map(([key, v]) => ({
    identifier: key,
    content: (v && typeof v === 'object' ? v.value : '') ?? '',
    position: typeof (v && v.position) === 'number' ? v.position : -1,
    depth: typeof (v && v.depth) === 'number' ? v.depth : 4,
    role: (v && typeof v.role !== 'undefined') ? v.role : (window.extension_prompt_roles?.SYSTEM ?? 0),
    filter: (v && typeof v.filter === 'object' && v.filter) ? v.filter : {},
  }));
  window.SillyTavern.runGenerationInterceptors = runGenerationInterceptorsCompat;
  window.SillyTavern.getExtensionPrompts = getExtensionPromptsCompat;
  // [P0-SRCDOC-SLIM] 向父页面请求插件脚本包（父页面回推 plugin-scripts-push）。
  // 插件源码不再内联进 srcDoc（瘦身），由父页面按需单次推送：减小 srcDoc 体积、
  // 避免 context-update 高频全量传输 4.4MB，同时支持 iframe 重建后重新拉取。
  try {
    window.parent.postMessage({
      source: 'palink-smart-card',
      runtime: 'st-compat-v2',
      frameId,
      type: 'request-plugin-scripts',
    }, '*');
  } catch {}
  // [P0-SRCDOC-SLIM] load 后再次请求：解析期发出的请求若恰逢 srcDoc 后续更新
  // （React 二次渲染 → iframe 重新导航）会被丢弃，load 时 iframe 已稳定，确保父
  // 页面能收到请求并回推 bundle。iframe 内按 generated_at 幂等，重复请求无害。
  try {
    window.addEventListener('load', () => {
      try {
        window.parent.postMessage({
          source: 'palink-smart-card',
          runtime: 'st-compat-v2',
          frameId,
          type: 'request-plugin-scripts',
        }, '*');
      } catch {}
    });
  } catch {}
  ensureStExtensionSettingsHostCompat();
  executeStPluginScriptsCompat();
  // [EP-BRIDGE] 初始化恢复上报：插件脚本执行完毕后，把 chatVariableStore 中的
  // __extension_prompts 快照上报父页面（父页面整页刷新后 promptInjection 为空，
  // 依赖本次上报重建当前 iframe 的 source）。幂等：完整快照整体替换。
  try {
    post({ type: 'extensionPrompts', prompts: getExtensionPromptStoreCompat() });
  } catch (_epErr) { /* ignore */ }

  // 强制确保 getAllVariables 返回后端下发的真实会话变量（含 stat_data），
  // 不被 ST 插件（酒馆助手/Tavern Helper）的 Mvu 实现覆盖。
  // executeStPluginScriptsCompat() 会接管 window.Mvu.getAllVariables，读它自己的（通常为空的）store，
  // 导致状态栏照片/服饰/内心想法恒空。此处把其覆盖回读取后端 chatVariableStore 的版本，
  // 并与插件数据做合并兜底（后端优先、插件补缺），无论插件执行顺序如何都生效。
  try {
    const pluginGetAllVariables =
      (window.Mvu && typeof window.Mvu.getAllVariables === 'function')
        ? window.Mvu.getAllVariables.bind(window.Mvu)
        : null;

    const mvuGetAllVariablesFinal = () => {
      const ours = { ...globalVariableStore, ...chatVariableStore, ...localVariableStore };
      let theirs = {};
      try { if (pluginGetAllVariables) theirs = pluginGetAllVariables() || {}; } catch (_e) { /* ignore */ }
      // 后端数据（ours）优先，插件数据补充 ours 缺失的键
      const merged = { ...theirs, ...ours };
      try {
        const sd = (merged && merged.stat_data) || {};
        const sdKeys = Object.keys(sd);
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const RE_CHAR = new RegExp('^/api/st/characters/', 'i');
        const absolutize = function (v) {
          if (typeof v === 'string') {
            const t = v.trim();
            if (UUID_RE.test(t)) return SMART_CARD_ORIGIN + '/api/st/characters/' + t;
            if (RE_CHAR.test(t)) return SMART_CARD_ORIGIN + t;
          }
          return v;
        };
        // 判断 stat_data 是否已是嵌套（任一值直接是 object）
        const isNested = sdKeys.some(function (k) { return sd[k] && typeof sd[k] === 'object'; });
        if (!isNested) {
          // 扁平复合 key（如 "桃汐.好感度"、"世界信息.日期时间"）→ 按 "." 第一段分组为嵌套
          // 不依赖 charMeta：通用 split，覆盖所有角色 + 世界信息等任意分组
          const nested = {};
          for (let i = 0; i < sdKeys.length; i++) {
            const fullKey = sdKeys[i];
            const dot = fullKey.indexOf('.');
            let group, attr;
            if (dot > 0) {
              group = fullKey.slice(0, dot);
              attr = fullKey.slice(dot + 1);
            } else {
              group = '_';
              attr = fullKey;
            }
            if (!nested[group]) nested[group] = {};
            nested[group][attr] = absolutize(sd[fullKey]);
          }
          merged.stat_data = nested;
        } else {
          // 已是嵌套：递归对所有头像类 UUID 绝对化
          const walk = function (obj) {
            if (!obj || typeof obj !== 'object') return;
            const ks = Object.keys(obj);
            for (let i = 0; i < ks.length; i++) {
              const val = obj[ks[i]];
              if (typeof val === 'string' && UUID_RE.test(val.trim())) {
                obj[ks[i]] = SMART_CARD_ORIGIN + '/api/st/characters/' + val.trim();
              } else if (val && typeof val === 'object') {
                walk(val);
              }
            }
          };
          walk(sd);
        }
      } catch (_e) { /* ignore */ }
      // [VAR-DBG] 读取链路调试（排查"插件角色面板不能显示变量"）
      try { var _sdRet = (merged && merged.stat_data) || {}; console.warn('[VAR-DBG] getAllVariables stat_data keys=' + JSON.stringify(Object.keys(_sdRet)) + ' sample=' + JSON.stringify(_sdRet).slice(0, 200)); } catch (_vdbgD) {}
      return merged;
    };

    window.Mvu = window.Mvu || {};
    window.Mvu.getAllVariables = mvuGetAllVariablesFinal;
    setCompatFunction('getAllVariables', mvuGetAllVariablesFinal);
    // 插件脚本若异步再次覆盖，延时再保险一次
    setTimeout(() => {
      try {
        window.Mvu.getAllVariables = mvuGetAllVariablesFinal;
        setCompatFunction('getAllVariables', mvuGetAllVariablesFinal);
      } catch (_e) { /* ignore */ }
    }, 0);
  } catch (_e) { /* ignore */ }

  requiredApis.forEach((apiName) => {
    if (apiName === 'SillyTavern' || apiName === 'Mvu' || apiName === 'eventSource' || apiName === 'toastr') return;
    if (apiName === 'TavernHelper' || apiName === 'AutoCardUpdaterAPI') return;
    if (typeof window[apiName] === 'undefined') {
      ensureFunction(apiName, makeMissingApiFunction(apiName, { severity: 'warning' }));
      reportDiagnostic({
        severity: 'info',
        code: 'detected_missing_api_stubbed',
        apiName,
        message: uiText.stubbedApi,
      });
    }
  });

  window.addEventListener('error', (event) => {
    const message = String(event.message || event.error?.message || uiText.unknownError);
    const refMatch = message.match(/(?:ReferenceError:\\s*)?([A-Za-z_$][\\w$]*) is not defined/);
    reportDiagnostic({
      severity: refMatch ? 'warning' : 'error',
      code: refMatch ? 'undefined_global' : 'script_error',
      apiName: refMatch?.[1] || '',
      message,
      stack: String(event.error?.stack || ''),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportDiagnostic({
      severity: 'error',
      code: 'unhandled_rejection',
      message: String(reason?.message || reason || uiText.unhandledRejection),
      stack: String(reason?.stack || ''),
    });
  });

  setTimeout(() => {
    emitCompatEvent(window.event_types?.APP_INITIALIZED || 'app_initialized');
    emitCompatEvent(window.event_types?.APP_READY || 'app_ready');
    emitCompatEvent(window.event_types?.CHAT_LOADED || 'chatLoaded', { detail: { id: window.this_chid, character: window.characters?.[window.this_chid] } });
    emitCompatEvent(window.event_types?.CHAT_CHANGED || 'chat_id_changed', ctx.sessionId || '', compatChat);
    // chat_metadata 加载完成后通知 ST 插件
    emitCompatEvent(window.event_types?.CHAT_METADATA_UPDATED || 'chat_metadata_updated', { metadata: window.chat_metadata || {}, source: 'load' });
    const firstCharacterMessageIndex = compatChat.findIndex((message) => message && !message.is_user && !message.is_system);
    if (firstCharacterMessageIndex >= 0) {
      const firstCharacterMessage = compatChat[firstCharacterMessageIndex];
      emitCompatEvent(
        window.event_types?.CHARACTER_FIRST_MESSAGE_SELECTED || 'character_first_message_selected',
        firstCharacterMessageIndex,
        firstCharacterMessage,
      );
      emitCompatEvent(window.event_types?.MESSAGE_RECEIVED || 'message_received', firstCharacterMessageIndex, firstCharacterMessage);
      emitCompatEvent(
        window.event_types?.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered',
        firstCharacterMessageIndex,
        firstCharacterMessage,
      );
    }
  }, 0);
})();`;
}

export type { SmartCardCompatDiagnostic };
