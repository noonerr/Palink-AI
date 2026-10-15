/**
 * ST 兼容运行时体 · 第 06 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 4680-5578 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

export const RUNTIME_BODY_PART_06 = `    const numeric = Number(value);
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
  // [P0-FIX 2026-09-30] 数据首达 DOMContentLoaded 补发的一次性标志（闭包级，见
  // applyParentContextUpdateCompat 的 chat 分支）。
  var didFireDataReadyDOMContentLoadedCompat = false;
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
        // [MVU-EVENTS 2026-10-05] mag_variable_initiailized：契约是「新开聊天对变量
        // 初始化时触发」。由父页面在 iframe onLoad 后的**首次** context-update 上打
        // mvuInit 标记带进来（见 CharacterCardRenderer.tsx），而不是靠「本帧第一次收到
        // variables」猜 —— 后者会在 iframe 重载/重挂时误发，让卡脚本以为要重新初始化。
        if (mvuInitPendingCompat) {
          mvuInitPendingCompat = false;
          deepMergeVariablesCompat(chatVariableStore, clone(nextContext.variables));
          emitCompatEvent(MVU_EVENT_KEYS.VARIABLE_INITIALIZED, chatVariableStore);
        }
        // 顺序对齐契约：started 在合并前、ended 在合并后，
        // before_message_update 表示「即将用更新后的变量更新楼层」，紧跟 ended。
        emitCompatEvent(MVU_EVENT_KEYS.VARIABLE_UPDATE_STARTED, chatVariableStore);
        deepMergeVariablesCompat(chatVariableStore, clone(nextContext.variables));
        emitCompatEvent(MVU_EVENT_KEYS.VARIABLE_UPDATE_ENDED, chatVariableStore);
        emitCompatEvent(MVU_EVENT_KEYS.BEFORE_MESSAGE_UPDATE, chatVariableStore);
        emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
      } catch (_e) {}
    }
    if (Array.isArray(ctx.chatMessages) && ctx.chatMessages.length > 0) {
      compatChat.splice(0, compatChat.length, ...ctx.chatMessages.map(normalizeChatMessage));
      compatChat.forEach((message) => syncSwipeToMesCompat(message, message.swipe_id));
      window.chat = compatChat;
      // [P0-FIX 2026-09-30] 首次拿到消息数据时补发一次 DOMContentLoaded。沙箱 iframe
      // 的卡脚本（如图文排版前端）在解析期注册 DOMContentLoaded init，此刻
      // chatMessages 尚未经 context-update 到达（boot ctx 刻意轻量），init 只跑一次
      // 且读到空数据 → 故事帧永远"故事正文为空"。ST 里脚本执行时聊天早已加载完毕，
      // 这里在数据首达后重放该事件对齐 ST 生命周期；一次性标志防止高频
      // context-update 反复重初始化卡脚本。late-DOMContentLoaded 监听（shim 补发路径）
      // 不在真实监听列表里，不会被重复触发。
      if (!didFireDataReadyDOMContentLoadedCompat) {
        didFireDataReadyDOMContentLoadedCompat = true;
        try { document.dispatchEvent(new Event('DOMContentLoaded')); } catch (_) {}
      }
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
      // [白边修复 2026-08-29] 父页面随 context 同步应用主题：显式设置文档
      // color-scheme，画布底色与聊天背景融合，消除卡片 body 透明 padding 区域
      // 透出的白色硬边（srcdoc 构建时注入的是构建时刻主题，此处置为运行时权威值）。
      if (data.colorScheme === 'dark' || data.colorScheme === 'light') {
        try { document.documentElement.style.setProperty('color-scheme', data.colorScheme); } catch (e) { /* ignore */ }
      }
      // [MVU-EVENTS 2026-10-05] 父页面只在帧加载后的首次 context-update 上打 mvuInit。
      if (data.mvuInit) mvuInitPendingCompat = true;
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
    // [iOS-HISTORY] 刻意不再写 window.location.hash：
    // 本 iframe 是 srcdoc（继承父页面 origin，不是 opaque origin），改 hash 是一次
    // 真实的 fragment 导航，会往 Safari 的联合会话历史（顶层 + 所有子框架）插入一条
    // 幽灵条目——顶层 URL 不变，滑动返回时表现为先闪过若干与当前页相同的快照。
    // 虚拟历史只需要把 hashchange 事件派发出去（见 dispatchHashChange），
    // 真实 hash 的副作用由事件模拟，不再触发导航。
    const syncHash = (_nextUrl) => {
      /* no-op：见上方 [iOS-HISTORY] 说明 */
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
  // [S1-G1 2026-10-13] 形状订正：ST 契约是**同步**返回 { primary, additional }，非 Promise。
  // 依据同 frame-shim/legacy-st-sim.ts 的同名注释（真机 MVU 不 await、直接读 .primary）。
  // 本帧内 legacy 段先注入并占了 window.getCharWorldbookNames，故本实现通常轮不到
  // （与 getChatMessages 同构）；仍一并订正，防止只改一处导致两轨形状再漂移。
  let worldbookNamesWarmStarted = false;
  const getCharWorldbookNamesCompat = () => {
    if (!activeWorldbookName && !worldbookNamesWarmStarted) {
      worldbookNamesWarmStarted = true;
      requestParent('getCharWorldbook', { args: [] }).then((result) => {
        if (result && result.success === false) {
          post({ type: 'log', level: 'warn', message: 'getCharWorldbookNames 冷缓存自热失败，返回空绑定' });
          return;
        }
        const name = result && typeof result === 'object'
          ? String(result.name || result.world_book_name || result.worldbookName || '').trim()
          : '';
        if (name) activeWorldbookName = name;
      }).catch(() => {
        post({ type: 'log', level: 'warn', message: 'getCharWorldbookNames 冷缓存自热失败，返回空绑定' });
      });
    }
    return {
      primary: activeWorldbookName || null,
      additional: activeWorldbookName ? [activeWorldbookName] : [],
    };
  };
  ensureFunction('getCharWorldbookNames', getCharWorldbookNamesCompat);
`;
