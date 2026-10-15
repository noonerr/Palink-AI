/**
 * ST 兼容运行时体 · 第 02 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 1150-2029 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

export const RUNTIME_BODY_PART_02 = `    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
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
    // [S3-ACCEPTANCE-GAP] regex/index.js:10 import { getSortableDelay } —— utils shim 缺此
    // 函数 ⇒ TypeError（2026-10-14 真机定位）。ST 语义：用户开启 sort delay 时 400ms 否则 0。
    getSortableDelay: () => (window.power_user && window.power_user.sort_delay ? 400 : 0),
    equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
    isTrueBoolean: (value) => value === true || value === 'true' || value === 'True',
    isFalseBoolean: (value) => value === false || value === 'false' || value === 'False',
    regexFromString: (pattern) => {
      try { return new RegExp(pattern); } catch { return null; }
    },
    escapeHtml: escapeHtmlCompat,
    setInfoBlock: () => {},
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
        // [S3-ACCEPTANCE-GAP] i18n 的 t 标签函数：身份翻译桩（与 TavernHelper.t 同语义，
        // 见 6564 行）。token-counter import { t } from i18n.js 此前 maps 无此
        // 模块 => t 为 undefined => t 模板字面量 TypeError（2026-10-14 真机定位）。
        match: ['i18n.js', 'i18n/index.js'],
        values: {
          t: () => ((key) => String(key ?? '')),
          default: () => ((key) => String(key ?? '')),
        },
      },
      {
        // [S3-PLUGIN-SHIM-GAP] ST preset-manager：getPresetManager(apiId) 返回预设管理器。
        // regex/index.js:1680-1685 只用 getSelectedPresetName / readPresetExtensionField。
        // 此前 maps 无此模块 => getPresetManager 为 undefined => TypeError（真机定位）。
        // Palink 无 ST 预设体系，返回空名+空脚本集的降级形状（regex 逻辑对空集合法跳过）。
        match: ['preset-manager.js', 'preset-manager/index.js'],
        values: {
          getPresetManager: () => ((apiId) => ({
            apiId: String(apiId || ''),
            getSelectedPresetName: () => '',
            readPresetExtensionField: () => [],
            writeExtensionField: () => true,
            getPresetExtensionField: () => [],
          })),
          PresetManager: () => function PresetManagerCompat(apiId = '') { this.apiId = apiId; },
          default: () => ((apiId) => ({ apiId: String(apiId || '') })),
        },
      },
      {
        // [S3-PLUGIN-SHIM-GAP] regex/index.js:7/298/2044 import commonEnumProviders/enumIcons。
        // 此前 maps 无此模块 => commonEnumProviders.boolean TypeError（真机定位）。
        match: ['slash-commands/slashcommandcommonenumsprovider.js'],
        values: {
          commonEnumProviders: () => ({
            boolean: (variant) => () => (String(variant) === 'onOffToggle'
              ? ['on', 'off', 'toggle'].map((value) => ({ value: value, text: value }))
              : ['true', 'false'].map((value) => ({ value: value, text: value }))),
          }),
          enumIcons: () => ({
            preset: 'preset',
            getStateIcon: (enabled) => (enabled ? 'on' : 'off'),
          }),
          default: () => ({}),
        },
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
      // [S3-ACCEPTANCE-GAP] 活绑定 getter，不用立即赋值：export 列表可以早于 const 声明
      // （memory/index.js:34 export { MODULE_NAME } 早于 :36 const），ES module 语义是懒绑定，
      // 立即赋值会撞 TDZ（"Cannot access 'MODULE_NAME' before initialization"，补测实锤）。
      return 'Object.defineProperty(exports, ' + JSON.stringify(exported) + ', { enumerable: true, get: function () { return ' + local + '; } });';
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
  // [S3-ACCEPTANCE-GAP] wrapper 参数表镜像。两处脚本包装器（入口 executeStPluginScriptsCompat
  // 与本地模块 evaluateStLocalPluginModuleCompat）用 function 参数向插件源码注入 ST 全局；
  // import 变换遇到同名本地名时必须赋值而非声明（见 normalizeStPluginScriptSourceCompat）。
  // ⚠️ 改动那两处参数表时必须同步本数组，否则撞名防御失效。
  const ST_PLUGIN_WRAPPER_PARAMS_BASE = ['window', 'document', 'SillyTavern', 'getContext', 'extension_settings', 'TavernHelper', 'eventSource'];
  const ST_PLUGIN_WRAPPER_PARAMS_MODULE = ST_PLUGIN_WRAPPER_PARAMS_BASE.concat(['exports', 'module']);
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
      // [S3-ACCEPTANCE-GAP FIX] ES module 语义：import 绑定是词法绑定，优先于 wrapper 注入的
      // 同名全局参数。与参数表同名的本地名不能再生成 const —— 同一作用域重复声明会让整段脚本
      // SyntaxError（2026-10-14 补测实测：5/5 真实插件 import eventSource/getContext 全灭，
      // 报错 "Identifier 'x' has already been declared"）。改为对参数赋值：import 值覆盖全局
      // 注入值，与「import 绑定遮蔽全局」的 ST 语义一致；模块解析不到时同样得到 undefined，
      // 与非参数名的 const 路径行为一致。重复 import 同一非参数本地名以首次为准
      // （真实 ES module 属重复声明错误，此处优雅降级）。
      const wrapperParams = new Set(options.moduleMode ? ST_PLUGIN_WRAPPER_PARAMS_MODULE : ST_PLUGIN_WRAPPER_PARAMS_BASE);
      const declaredLocals = new Set();
      const statements = [];
      imports.forEach((item) => {
        const valueExpr = item.namespace
          ? 'window.__palinkStModuleNamespace?.(' + JSON.stringify(item.modulePath) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ') || {}'
          : 'window.__palinkStModuleImport(' + JSON.stringify(item.modulePath) + ', ' + JSON.stringify(item.imported) + ', ' + JSON.stringify(pluginId) + ', ' + JSON.stringify(resourcePath) + ')';
        if (wrapperParams.has(item.local)) {
          statements.push(item.local + ' = ' + valueExpr + ';');
          return;
        }
        if (declaredLocals.has(item.local)) return;
        declaredLocals.add(item.local);
        statements.push('const ' + item.local + ' = ' + valueExpr + ';');
      });
      if (statements.length) {
        transformed = statements.join(newlineCompat) + newlineCompat + transformed;
      }
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
            // [S3-ACCEPTANCE-GAP] 入口脚本按模块模式变换：export 收进 holder.exports，
            // 供下方 manifest.hooks.activate 调用（ST 标准激活机制，补测定位：
            // ST 框架 import 后调 activate hook；Palink 此前只跑脚本不调 hook ⇒ init 从不执行）。
            moduleMode: true,
          });
          const holderKey = '__palinkStPluginHolder_' + scriptKey.replace(/[^a-z0-9_$]/gi, '_') + '_' + Date.now();
          window[holderKey] = { ok: false, error: '', exports: {}, module: { exports: {} } };
          const holderJson = JSON.stringify(holderKey);
          const pluginNameJson = JSON.stringify(String(plugin.name || plugin.id || ''));
          const wrappedSource = ''
            + '(async () => {' + newlineCompat
            + 'try {' + newlineCompat
            + 'await (async function(window,document,SillyTavern,getContext,extension_settings,TavernHelper,eventSource,exports,module){' + newlineCompat
            + source
            + newlineCompat + '})(window,document,window.SillyTavern,window.getContext,window.extension_settings,window.TavernHelper,window.eventSource,window[' + holderJson + '].exports,window[' + holderJson + '].module);' + newlineCompat
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
          // [S3-ACCEPTANCE-GAP] manifest hooks.activate：脚本主体成功后调用导出的 init。
          // setTimeout(0) 待 async IIFE 的同步部分与 microtask 落定再读 holder（顶层
          // 带 await 的插件也不漏）。hook 异步执行，错误只进诊断、不拖垮执行链。
          const activateHookName = plugin?.manifest?.hooks?.activate;
          if (activateHookName && typeof activateHookName === 'string') {
            setTimeout(() => {
              const holder = window[holderKey];
              if (!holder || !holder.ok) return;
              const hookFn = holder.exports ? holder.exports[activateHookName] : undefined;
              if (typeof hookFn !== 'function') return;
              Promise.resolve()
                .then(() => hookFn())
                .then(() => {
                  reportDiagnostic({
                    severity: 'info',
                    code: 'st_plugin_activate_hook_ok',
                    apiName: String(plugin.name || plugin.id || ''),
`;
