/**
 * ST 兼容运行时体 · 第 08 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 6460-7312 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

export const RUNTIME_BODY_PART_08 = `  setCompatFunction('messageFormatting', messageFormattingCompat);
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
    // [MVU-EVENTS 2026-10-05] 事件键是**常量不是实现**，必须无条件以契约为准。
    // 原写法 window.Mvu.events || {...} 意味着插件自己装过 MVU 时我们完全不注入，
    // 而插件若给的是别的值（或压根没装、走我们的兜底），卡脚本按常量订阅就会落空。
    // 合并顺序：插件的在前、契约的在后 —— 契约值最终胜出，其余键不丢。
    events: Object.assign({}, window.Mvu.events, MVU_EVENT_KEYS, {
      CHAT_VARIABLES_UPDATED: 'CHAT_VARIABLES_UPDATED',
    }),
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
  // [S5-COMPAT-AUDIT 2026-10-16] 单间轨「假实现」显性化（承接
  // REPORT_S5架构重建评审 §4.3 / SPEC_ST兼容层修复计划 T1）。
  //
  // 背景：本帧的 getContextCompat 有一批 API 名字在、值是假的（世界书恒空、preset 名硬编码、
  // 假成功……）。它们不报错、返回看起来合理的值 ⇒ 插件功能静默失效，用户与开发者都无从感知
  // （评审原话：「对用户来说这比直接报错更糟」）。此前单间轨**完全没有**留痕通道。
  //
  // 落点选择（关键，别改错）：
  //   主页面 getContext 轨的 recordStubHit（lib/plugin-system/compat-stub-registry.ts）**不能
  //   在这里用** —— 它是主 bundle 的模块，iframe 里 import 不到；单间轨既有的可见通道是
  //   reportDiagnostic → post({type:'st:diagnostic'}) → 宿主 CharacterCardRenderer 的
  //   onAction({type:'diagnostic'}) → handleSmartCardCompatDiagnostic（toast，12s 去重）。
  //   本 helper 只是把「桩被调用」翻译成一条 diagnostic，不新建第二套统计。
  //
  // 为什么不用 __stub 标记（SPEC T1 方案①）：getContextCompat 是每次调用新建的对象字面量，
  //   defineProperty 会让它变稠且仍不可枚举可见；真正要的「调用时留痕」由 reportStubApi 完成。
  const PALINK_STUB_API_NOTES = {
    loadWorldInfo: '世界书内容读取在单间轨未接线，恒返回空对象（见 SPEC T3 立项）',
    getWorldInfoPrompt: '世界书提示词恒返回空串，实际注入走后端 worldbook_service',
    saveWorldInfo: '写入为假成功（返回 true 但不落库），请改用 createOrReplaceWorldbook',
    getSelectedPresetName: 'Palink 无独立 preset 概念，硬编码占位名',
    writePresetExtensionField: '写入为假成功（返回 true 但不落库）',
    getRequestHeaders: 'Palink 由 api 服务统一注入认证头，此处恒空对象',
    'fetch:/api/worldinfo': 'iframe 侧 fetch 白名单对 /api/worldinfo 恒返回空 entries/data（真实内容走 getLorebookEntries 桥，见 SPEC T3）',
    getChatCompletionModel: '模型名经 generationEngine 读取，此处恒空串',
    getMediaDisplay: '消息媒体显示形态由 React 组件管理，此处为占位常量',
    getMediaIndex: '消息媒体索引由 React 组件管理，此处为占位常量',
    appendMediaToMessage: '消息媒体追加由后端 extra.media 管理，此处为假成功',
    scrollOnMediaLoad: '滚动由宿主管理，此处为假成功',
    convertCharacterBook: 'Palink 后端已存 ST 形状，此处为恒等占位',
    getTextGenServer: 'Palink 不使用独立 textgen 服务器，占位空串',
    renameChat: '会话改名入口未接线，此处为假成功',
    updateWorldInfoList: '世界书列表由宿主 UI 管理，此处为假成功',
    reloadWorldInfoEditor: '世界书编辑器由宿主 UI 管理，此处为假成功',
  };
  const stubApiReported = {};
  const reportStubApi = (apiName, note) => {
    const key = String(apiName || '');
    if (!key || stubApiReported[key]) return;
    stubApiReported[key] = true;
    try {
      reportDiagnostic({
        severity: 'warning',
        code: 'st_api_stub',
        apiName: key,
        message: 'ST API ' + key + ' 在 Palink 单间轨为无操作/部分实现：' + String(note || PALINK_STUB_API_NOTES[key] || ''),
      });
    } catch (e) { /* 静默 */ }
  };
  const stubApi = (apiName, impl) => {
    const wrapped = (...args) => {
      reportStubApi(apiName);
      return impl(...args);
    };
    // 保留 async 语义：原实现多为 async，包一层后调用方 await/catch 行为不变。
    if (impl && typeof impl.then === 'function') return wrapped;
    return wrapped;
  };
  window.__palinkStubApiNotes = PALINK_STUB_API_NOTES;
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
    renameChat: stubApi('renameChat', async () => true),
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
    appendMediaToMessage: stubApi('appendMediaToMessage', async () => true),
    ensureMessageMediaIsArray: (message) => {
      if (message && typeof message === 'object' && !Array.isArray(message.extra?.media)) {
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra.media = [];
      }
      return message?.extra?.media || [];
    },
    getMediaDisplay: stubApi('getMediaDisplay', () => 'inline'),
    getMediaIndex: stubApi('getMediaIndex', () => -1),
    scrollChatToBottom: window.scrollChatToBottom,
    scrollOnMediaLoad: stubApi('scrollOnMediaLoad', () => true),
    loadWorldInfo: stubApi('loadWorldInfo', async (name) => {
      // [S5-COMPAT-AUDIT T3 2026-10-16] MVU 世界书读取失败的根因修复（66 次/会话）。
      //
      // 根因（从真机卡 bundle backend/data/smart_card_assets/0c646fb31a….js 的 MVU beta
      // 原文挖出，非推测；调用形如 await SillyTavern.loadWorldInfo(t)，随后
      // if(!_.isPlainObject(n) || !_.isPlainObject(_.get(n,'entries'))) throw ...）：
      //   async function $a(t){
      //     const n = await SillyTavern.loadWorldInfo(t);
      //     if(!_.isPlainObject(n)||!_.isPlainObject(_.get(n,'entries')))
      //       throw new Error(at('runtime.characterOverride.worldbookReadFailed',{worldbook:t}));
      //   }
      // ⇒ 判据是「返回值是 plain object 且 .entries 是 plain object」。
      // 原实现恒返回 {}（没有 entries 键）⇒ **必然命中抛错分支**，这就是
      // 「无法读取角色世界书"露缇雅1.2"」的来源。
      //
      // 数据源：与 getLorebookEntries / getCharWorldbookNames **同源**（S1-G10/G11 的成果，
      // 卡自建优先、缺失回退角色 character_book，title→comment 已由父侧映射好）。
      //
      // ⚠️ 形状约束（关键，别改错）：MVU 用 lodash isPlainObject 判定
      //    （_.isPlainObject(_.get(n,'entries'))），而 **数组不是 plain object**
      //    （isPlainObject([]) === false）⇒ 直接透传 getWorldbookEntries 的数组仍会抛错。
      //    必须包成 { entries: {...} } 对象形状（ST 的 world_info.entries 契约本身就是
      //    uid→entry 的对象，不是数组）。
      try {
        const detail = await requestParent('getCharWorldbook', { args: [] });
        const list = detail && Array.isArray(detail.entries) ? detail.entries : [];
        const entries = {};
        list.forEach((entry, index) => {
          const uid = Number(entry?.uid ?? entry?.id ?? index) || index;
          entries[String(uid)] = entry;
        });
        const resolvedName = String(name || detail?.name || activeLorebooks?.primary || '');
        if (resolvedName) activeWorldbookName = resolvedName;
        return { name: resolvedName, entries };
      } catch (e) {
        // 拿不到也不能抛：抛给卡脚本会让整个变量初始化链断掉（与 S1-G10 的降级口径一致）。
        post({ type: 'log', level: 'warn', message: 'loadWorldInfo 失败，返回空世界书' });
        return { name: String(name || ''), entries: {} };
      }
    }),
    saveWorldInfo: stubApi('saveWorldInfo', async () => true),
    reloadWorldInfoEditor: stubApi('reloadWorldInfoEditor', async () => true),
    updateWorldInfoList: stubApi('updateWorldInfoList', async () => true),
    convertCharacterBook: stubApi('convertCharacterBook', (book) => book || {}),
    getWorldInfoPrompt: stubApi('getWorldInfoPrompt', async () => ''),
    getWorldInfoNames: () => Array.isArray(window.world_names) ? [...window.world_names] : [],
    CONNECT_API_MAP: {},
    getTextGenServer: stubApi('getTextGenServer', async () => ''),
    extractMessageFromData: (data) => data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.text || data?.content || '',
    getChatCompletionModel: stubApi('getChatCompletionModel', () => ''),
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
      getSelectedPresetName: stubApi('getSelectedPresetName', () => 'Palink'),
      getSelectedPreset: () => parseMaybeJsonObject(ctx.presetData, {}),
      readPresetExtensionField: ({ path } = {}) => {
        if (!path || path === 'regex_scripts') return clone(presetRegexScripts);
        return getByPath(parseMaybeJsonObject(ctx.presetData, {}), String(path), undefined);
      },
      writePresetExtensionField: stubApi('writePresetExtensionField', async () => true),
    }),
    loader: {
      show: () => post({ type: 'log', level: 'info', message: 'loader.show' }),
      hide: () => post({ type: 'log', level: 'info', message: 'loader.hide' }),
    },
    // [S5-GDEP3 T2] 卡内可达的 triggerSlash（宿主桥 → 共享 slash 实现）。
    // 声明在 getContextCompat **之后**定义的闭包，这里用函数声明提升引用，避免时序问题。
    triggerSlash: (...args) => triggerSlashCompat(...args),
  });
  window.getContext = getContextCompat;
  // [S5-GDEP3 2026-10-16] 卡内 triggerSlash 缺口补齐（承接 REPORT_S5架构重建评审 §3.1 /
  // SPEC_ST兼容层修复计划 T2 / OPEN_ISSUES.md [P2-10] 第 1 项）。
  //
  // 缺口事实（实测复核）：沙箱轨 sandbox.ts:3605 与主页面 getContext 轨
  // getContext.ts:2517 都有 triggerSlash（且前置 runPalinkSlashCommands 的 9 条 Palink 命令），
  // 唯独**单间轨（卡内）没有** —— getContextCompat 无此字段，runtime-body 全段 0 命中。
  // 后果：S5 评审总表里「9 条命令逐条实跑 = 通过」只在沙箱轨成立，容易被读成卡内也能用。
  //
  // 修法：桥到宿主，由宿主调**现成的共享实现**（不重写命令逻辑）：
  //   命中 Palink 命令 → 返回其结果；未命中（null）→ 宿主回落 executeSlashCommandCompat
  //   （与沙箱轨/getContext 轨完全同源，见 getContext.ts:2518-2520）。
  // 依赖边界：不读任何大堂注入物，只走 requestParent 这条既有 RPC 通道。
  const triggerSlashCompat = async (command) => {
    const text = String(command ?? '').trim();
    if (!text) return '';
    try {
      const response = await requestParent('runPalinkSlash', { command: text });
      if (response && response.success === false) return '';
      return response && typeof response.result === 'string' ? response.result : '';
    } catch (e) {
      // 不把 RPC 异常抛给卡脚本：宿主侧 handleSmartCardCompatRequest 已有兜底，
      // 这里再拦一层是防御（对齐同帧 getLorebookEntriesCompat 的降级口径）。
      post({ type: 'log', level: 'warn', message: 'triggerSlash 桥接失败：' + String(e && e.message || e) });
      return '';
    }
  };
  setCompatFunction('triggerSlash', triggerSlashCompat);
  window.triggerSlashWithResult = triggerSlashCompat;
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

  // [SILLYTAVERN-PROXY 2026-10-06 二修] 卡脚本从 SillyTavern 上取的 API，我们一直没给全。
  //
  // 实测（2026-10-06，用户追问「是不是我们缺 API」——**用户是对的**）：
  // MVU 插件从 SillyTavern 上取 23 个 API（chat / callGenericPopup / POPUP_TYPE /
  // POPUP_RESULT / saveChat / getRequestHeaders / extensionSettings / ToolManager /
  // registerFunctionTool / chatCompletionSettings ...），而 window.SillyTavern 上
  // 只挂了 9 个通用键，**交集几乎为零**。
  //
  // ★ 一修（同一天早些时候）**方向对、落点错**，已废止，留作教训：
  //   一修把回落指向了 tavernHelperCompat —— 但那个对象只有 57 个键，MVU 要的 23 个里
  //   实测只命中 1 个（uuidv4）。真正装着这些实现的是**上面的 getContextCompat()**
  //   （ST 的 getContext() 契约，220+ 键，命中 MVU 要的 ~20 个）。
  //   ⇒ 一修的 ② 层几乎全部漏到 ③ 层，等于没修。
  //
  // ★★ 更要命的是 ③ 层本身：makeMissingApiFunction 返回的是**函数**，而函数在 JS 里
  //   **恒为真**。卡判断"这个能力有没有"用的是最朴素的特性检测，MVU 原文即：
  //     const { registerFunctionTool: e } = SillyTavern;
  //     return e ? 走注册分支 : (提示不支持, 返回安全空实现)
  //   undefined ⇒ 走右边，优雅降级；给了个空函数 ⇒ 走左边，**炸在更深处**。
  //   即一修把「缺 API 就优雅降级」改成了「缺 API 就假装支持」——比不改更糟。
  //   （同一条判据也否决了给 chatCompletionSettings 塞空对象：MVU 校验通过后立刻写
  //    e.runtimes.is_function_call_enabled，空对象会在那里 TypeError；
  //    给 undefined 反而走它自己那句 throw new Error，被我们捕获，不打断初始化。）
  //   ⇒ 缺口一律返回 **undefined**，只上报一次诊断让缺口可见，**不替卡改变结论**。
  //
  // 现在的四层回落：
  //   ① SillyTavern 自己的键（上面的 9 个，优先，不被覆盖）
  //   ② getContextCompat() 的真实实现（ST getContext 契约，命中 ~20 个）
  //   ③ tavernHelperCompat（补充）
  //   ④ 都没有 ⇒ undefined + 一条 diagnostics（**不再给假函数**）
  // 不动 P1-1 沙箱红线。卡脚本不会整体覆盖 window.SillyTavern（实测无赋值），代理稳定。
  const installSillyTavernCompatProxy = () => {
    const existingHelper = window.SillyTavern && typeof window.SillyTavern === 'object'
      ? window.SillyTavern
      : {};
    if (existingHelper.__palinkSillyTavernProxy) {
      window.SillyTavern = existingHelper;
      return;
    }
    let ctxSnapshotCache = null;
    const contextSnapshotCompat = () => {
      if (ctxSnapshotCache) return ctxSnapshotCache;
      try {
        ctxSnapshotCache = (typeof getContextCompat === 'function') ? getContextCompat() : {};
      } catch (e) {
        ctxSnapshotCache = {};
      }
      return ctxSnapshotCache;
    };
    const missingReported = {};
    const proxy = new Proxy(existingHelper, {
      get(target, prop) {
        if (prop === 'then') return undefined;
        if (prop === '__palinkSillyTavernProxy') return true;
        if (prop in target) return target[prop];
        const ctxObj = contextSnapshotCompat();
        if (ctxObj && prop in ctxObj) return ctxObj[prop];
        if (prop in tavernHelperCompat) return tavernHelperCompat[prop];
        // 缺口：返回 undefined，不要返回"看起来像实现"的空函数（理由见上方 ★★）。
        const keyName = String(prop);
        if (!missingReported[keyName]) {
          missingReported[keyName] = true;
          try {
            reportDiagnostic({
              severity: 'warning',
              code: 'sillytavern_api_missing',
              apiName: 'SillyTavern.' + keyName,
              message: '卡脚本需要 SillyTavern.' + keyName + '，Palink 尚未实现；已返回 undefined，让卡走自己的降级分支。',
            });
          } catch (e) { /* 静默 */ }
        }
        return undefined;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
      has(target, prop) {
        if (prop in target) return true;
        const ctxObj = contextSnapshotCompat();
        return Boolean(ctxObj && prop in ctxObj) || prop in tavernHelperCompat;
      },
    });
    try { Object.defineProperty(proxy, '__palinkSillyTavernProxy', { value: true, configurable: true }); } catch {}
    window.SillyTavern = proxy;
  };
  installSillyTavernCompatProxy();
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
  ensureStPluginMountPointsCompat();
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

    // 归一化任意来源（扁平复合 key 或已嵌套）的变量对象，提取出嵌套 stat_data
    // （含头像 UUID 绝对化）。与 ST 真实 MVU 契约一致：stat_data 永远是
    // 嵌套结构 { 角色: { 属性: 值 }, 世界信息: { ... } }。
    const mvuNormalizeStatData = (rawVars) => {
      const vars = (rawVars && typeof rawVars === 'object') ? rawVars : {};
      const sd = (vars.stat_data && typeof vars.stat_data === 'object') ? vars.stat_data : {};
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
        return nested;
      }
      // 已是嵌套：递归对所有头像类 UUID 绝对化（返回副本，避免改写原对象）
      const out = {};
      const walk = function (src, dst) {
        if (!src || typeof src !== 'object') return;
        const ks = Object.keys(src);
        for (let i = 0; i < ks.length; i++) {
          const val = src[ks[i]];
          if (typeof val === 'string' && UUID_RE.test(val.trim())) {
            dst[ks[i]] = SMART_CARD_ORIGIN + '/api/st/characters/' + val.trim();
          } else if (val && typeof val === 'object') {
            dst[ks[i]] = {};
            walk(val, dst[ks[i]]);
          } else {
            dst[ks[i]] = val;
          }
        }
      };
      walk(sd, out);
      return out;
    };

    // 解析 getMvuData/getAllVariables 的变量来源：
    // - message：按 message_id（负数=深度索引，-1=最新）取该楼层 extra.variables
    // - global ：仅全局 store
    // - chat/character/默认：合并后端 chat+global+local 与插件 store（后端优先）
    // 返回的是"原始变量对象"，stat_data 的扁平→嵌套由 mvuNormalizeStatData 统一处理。
    const mvuResolveSourceVars = (type, option) => {
      if (type === 'message') {
        let msgId = option.message_id;
        if (msgId === undefined || msgId === null || msgId === 'latest' || msgId === '') msgId = -1;
        const messages = getCompatChatMessages();
        let idx;
        if (typeof msgId === 'number' && Number.isFinite(msgId)) {
          idx = (msgId < 0) ? (messages.length + msgId) : msgId;
        } else {
          idx = messages.findIndex((m) => String(m.id) === String(msgId) || String(m.message_id) === String(msgId));
        }
        const msg = (idx >= 0 && idx < messages.length) ? messages[idx] : null;
        const vars = (msg && msg.extra && typeof msg.extra.variables === 'object') ? msg.extra.variables : {};
        return vars;
      }
      if (type === 'global') return globalVariableStore;
      const ours = { ...globalVariableStore, ...chatVariableStore, ...localVariableStore };
      let theirs = {};
      try { if (pluginGetAllVariables) theirs = pluginGetAllVariables() || {}; } catch (_e) { /* ignore */ }
      return { ...theirs, ...ours };
    };

    const mvuGetAllVariablesFinal = () => {
      const merged = mvuResolveSourceVars('chat', {});
      try { merged.stat_data = mvuNormalizeStatData(merged); } catch (_e) { /* ignore */ }
      return merged;
    };

    // [MVU-FAITHFUL] 忠实复刻 MVU 框架 getMvuData 契约（非单卡特调）：
    // getMvuData({type, message_id}) → MvuData（含 .stat_data），按 type 解析来源、
    // 按 message_id 解析楼层。任何依赖 Mvu.getMvuData 的卡片/插件（数据库界面/Galgame 等）通用。
    const mvuGetMvuDataFinal = (option) => {
      const opt = (option && typeof option === 'object') ? option : {};
      const type = (typeof opt.type === 'string' && opt.type) ? opt.type : 'chat';
      let sourceVars;
      try { sourceVars = mvuResolveSourceVars(type, opt); } catch (_e) { sourceVars = {}; }
      let statData;
      try { statData = mvuNormalizeStatData(sourceVars); } catch (_e) { statData = {}; }
      return { initialized_lorebooks: {}, stat_data: statData };
    };

    window.Mvu = window.Mvu || {};
    window.Mvu.getAllVariables = mvuGetAllVariablesFinal;
    setCompatFunction('getAllVariables', mvuGetAllVariablesFinal);
    // [MVU-PANEL-DATA 2026-10-05] getMvuData 同样**无条件覆盖**，与 getAllVariables 口径一致。
    //
    // 原实现是条件覆盖（仅当插件尚未提供该函数时才装，带 typeof 判定守卫），
    // 结果：插件自带 MVU 引擎时，它自己的 getMvuData 胜出 → 变量面板读的是**插件自己的
    // （通常为空的）变量表**，而不是后端下发的 stat_data → 面板恒空/恒默认值。
    //
    // 实测依据（卡脚本 backend/data/smart_card_assets/0c646fb31a…js，MVU bundle 原文）：
    //   getMvuData:function(e){return getVariables(e)},replaceMvuData:function(e,t){return replaceVariables(e,t)}
    // 即 MVU 的 getMvuData 只是"裸全局 getVariables 的薄包装"。只要让 getVariables 指向我们的
    // 数据源，面板就能显示真实 stat_data —— 这正是本处覆盖要保证的事（覆盖后本函数按
    // type/message_id 解析来源，行为是 getVariables 的超集，不会更差）。
    //
    // 风险边界：只覆盖"读"，**不碰** replaceMvuData / parseMessage（写与解析），
    // 因此不会与后端 mvu_engine 形成双写。详见
    // docs/REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md 第 11.5 节。
    window.Mvu.getMvuData = mvuGetMvuDataFinal;
    setCompatFunction('getMvuData', mvuGetMvuDataFinal);
    // 插件脚本若异步再次覆盖，延时再保险一次
    setTimeout(() => {
      try {
        window.Mvu.getAllVariables = mvuGetAllVariablesFinal;
        setCompatFunction('getAllVariables', mvuGetAllVariablesFinal);
        window.Mvu.getMvuData = mvuGetMvuDataFinal;
        setCompatFunction('getMvuData', mvuGetMvuDataFinal);
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

  // [DEBUG-VISIBLE 2026-10-06] 卡内报错必须**同时**满足两件事：上报（reportDiagnostic，
  // 走 postMessage 给宿主页）+ **在 console 留一条带前缀的可见记录**。
  //
  // 为什么以前查不到：上报走 postMessage，宿主页 CharacterCardRenderer.tsx:889 收到后
  // 转成 onAction({type:'diagnostic'})，**由调用方决定要不要渲染**——Palink 当前没有
  // 消费方，于是这条错误等于进了黑洞。实测（2026-10-06 用户真机日志）那张卡崩在
  // legacy_chat.ts:9，报错确实被上报了，但 console 里只有浏览器原生的
  // "Uncaught (in promise)"，没有卡名、没有归类，排查时极易当成噪音划过去。
  //
  // ⚠️ 本文件主体是**注入 iframe 的模板字符串**：注释里禁止出现反引号和美元花括号，
  // 否则提前终止模板（本注释第一版就是因此炸出一堆 TS1005/TS1443）。
  //
  // 加前缀「卡内错误」：一是搜索方便（console 过滤框打「卡内错误」即可只看卡的问题），
  // 二是与浏览器原生堆栈区分开。**不改变上报行为**，只是多一条可见记录。
  // ⚠️ 注意：下面这个 helper 的实参**不能写 TS 类型标注** —— 本文件主体是注入 iframe 的
  // 模板字符串，产出的必须是**纯 JS**；写 (label: string) 会在生成文本里留下冒号，
  // 运行时 SyntaxError（2026-10-06 被 generated-script-parse-guard.test.ts 拦下）。
  // 卡内错误留一份内存副本（上限 20 条）：哨兵要把它写进诊断与浮层提示，
  // 否则用户只看到"初始化失败"四个字，不知道到底缺了什么。
  const cardErrorLog = [];
  const logCardError = (label, message, stack) => {
    try {
      if (cardErrorLog.length < 20) cardErrorLog.push({ label, message, stack });
      // 带前缀 + 卡标识，便于在噪音里一眼认出
      console.error('[卡内错误] ' + label + (frameId ? ' @' + String(frameId).slice(-6) : '') + ': ' + message, stack || '');
    } catch { /* console 不可用时静默 */ }
  };
  const firstCardErrorText = () => {
    try {
      const first = cardErrorLog[0];
      if (!first) return '';
      return String(first.message || '').replace(/\s+/g, ' ').slice(0, 160);
    } catch { return ''; }
  };

  window.addEventListener('error', (event) => {
    const message = String(event.message || event.error?.message || uiText.unknownError);
    const refMatch = message.match(/(?:ReferenceError:\\s*)?([A-Za-z_$][\\w$]*) is not defined/);
    const stack = String(event.error?.stack || '');
    logCardError('脚本错误', message, stack);
    reportDiagnostic({
      severity: refMatch ? 'warning' : 'error',
      code: refMatch ? 'undefined_global' : 'script_error',
      apiName: refMatch?.[1] || '',
      message,
      stack,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = String(reason?.message || reason || uiText.unhandledRejection);
    const stack = String(reason?.stack || '');
    logCardError('未处理的异步错误', message, stack);
    reportDiagnostic({
      severity: 'error',
      code: 'unhandled_rejection',
      message,
      stack,
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

  // [CARD-CRASH-GUARD 2026-10-06] 卡脚本崩了怎么办——给它留一条能走通的出口。
  //
  // 现象（2026-10-06 用户真机）：卡脚本 init 中途抛错死掉（实测崩在它自己从 CDN 拉的
  // legacy_chat.ts:9），于是它后段的 setEventsRefs({showSettingsPanel}) 永不执行。
  // 结果：设置按钮**已经渲染出来**（所以 hover 有反馈、看起来"点了没反应"），
  // 但点击处理里 _showSettingsPanelRef2 仍是 null，而那段代码是「null 就静默跳过」
  // ——无 else、无报错、无 toast 之外的任何提示。用户完全无法判断发生了什么。
  //
  // 这里做的事（不改卡、不动它的代码）：
  //  1. 监听捕获阶段文档点击：若点的是卡的设置入口（data-action=config/open-settings），
  //     且**卡自己的处理器已经跑过**（用标记位判断），就额外弹一条可见提示，
  //     告诉用户"卡片初始化失败，设置面板打不开"，而不是让点击石沉大海。
  //  2. 把这次崩溃通过已有的 diagnostic 通道上报，宿主页可自行决定展示。
  //
  // 刻意**不替代**卡的功能（不自己实现设置面板）：卡的面板是它私有的 UI 结构，
  // 我们拿不到可靠的挂载点与状态。只做"失败要可见"，不做"替它干活"。
  // 这符合本项目一贯纪律：不猜卡内部语义，只补可见性与可观测性。
  // [CARD-CRASH-GUARD 二修 2026-10-06] 一修的判据是**写死卡名**，实测误报。
  // 一修只看 galgame/GalgameUI/TavernHelper_init_done/__galgame_ui_ready 四个名字，
  // 这四个是**那一张卡**的导出；换张卡、或这张卡走了别的分支，哨兵就一直喊"没初始化"，
  // 而卡其实是好的——告警本身成了新的噪音，还误导排查方向（用户据此来问"为什么还不行"）。
  // 二修改成两条判据（任一命中即认为卡跑起来了）：
  //   ① 已知卡的全局导出白名单（保留，命中快）
  //   ② **通用判据**：window 上出现了基线之外的新键 ⇒ 确实有卡/插件脚本执行完了初始化
  // 基线在哨兵安装这一刻取（本 shim 已装完、卡脚本还在等父页面推送，尚未执行），
  // 并滤掉 Palink 自己装的键，避免把自己算成卡。
  const cardCrashGuardState = { sawCardBootstrap: false, warnedAt: 0, baselineKeys: [] };
  try {
    cardCrashGuardState.baselineKeys = Object.keys(window).filter((k) => !/^(?:__)?palink/i.test(k));
  } catch (e) { cardCrashGuardState.baselineKeys = []; }

  const detectCardBootstrapCompat = () => {
    const known = ['galgame', 'GalgameUI', 'TavernHelper_init_done', '__galgame_ui_ready__'];
    for (let i = 0; i < known.length; i++) {
      if (window[known[i]] !== undefined) return true;
    }
    try {
      const baseSet = new Set(cardCrashGuardState.baselineKeys || []);
      const keysNow = Object.keys(window);
      for (let i = 0; i < keysNow.length; i++) {
        const k = keysNow[i];
        if (baseSet.has(k)) continue;
        if (/^(?:__)?palink/i.test(k)) continue;
        return true;
      }
    } catch (e) { /* 静默 */ }
    return false;
  };

  try {
    // 5 秒一查、共 4 次（5/10/15/20 秒）后才告警：卡脚本是父页面**异步推送**的，
    // 单张插件脚本就有 4MB，慢机器上光解析就超过 5 秒，一修那次单点判定必然误报。
    const runBootstrapCheckCompat = (attempt) => {
      try {
        if (detectCardBootstrapCompat()) { cardCrashGuardState.sawCardBootstrap = true; return; }
        if (attempt < 3) {
          setTimeout(() => runBootstrapCheckCompat(attempt + 1), 5000);
          return;
        }
        const firstError = firstCardErrorText();
        reportDiagnostic({
          severity: 'warning',
          code: 'card_bootstrap_incomplete',
          message: '卡片脚本未完成初始化（20 秒内未挂载任何全局导出）'
            + (firstError ? '，首个卡内错误：' + firstError : '，且未捕获到卡内错误（可能是卡脚本未加载或静默退出）。')
            + ' 其设置面板等入口可能无响应。',
          detail: 'frameId=' + String(frameId || '') + '; capturedErrors=' + String(cardErrorLog.length),
        });
      } catch (e) { /* 静默 */ }
    };
    setTimeout(() => runBootstrapCheckCompat(0), 5000);
  } catch (e) { /* 静默 */ }

  try {
    document.addEventListener('click', (event) => {
      try {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        const hit = target.closest('[data-action="config"], [data-action="open-settings"]');
        if (!hit) return;
        // 卡自己处理过就不打扰（它自己会开面板或切菜单）。
        if (cardCrashGuardState.sawCardBootstrap) return;
        const now = Date.now();
        if (now - cardCrashGuardState.warnedAt < 6000) return;
        cardCrashGuardState.warnedAt = now;
        const actionName = String(hit.getAttribute('data-action') || '');
        // 报错要**可见**：走 diagnostics（宿主页可展示）+ 控制台带前缀一条。
        // 不自己实现卡的设置面板：那是它私有的 UI 结构与状态，替它干活只会做出错的界面。
        reportDiagnostic({
          severity: 'warning',
          code: 'card_settings_entry_unresponsive',
          apiName: actionName,
          message: '卡片初始化未完成，设置入口无响应（点击已被 Palink 捕获）。',
          detail: 'frameId=' + String(frameId || ''),
        });
        logCardError('设置入口无响应', '卡片脚本初始化未完成，data-action=' + actionName, '');
        // 卡内自己的 toast 也可能因挂载点为空而静默不显示（实测过），所以再叠一条
        // 不依赖卡挂载点的浮层提示，确保用户**一定**看得到"为什么点了没反应"。
        try {
          const noticeId = 'palink-card-crash-notice';
          const old = document.getElementById(noticeId);
          if (old) old.remove();
          const notice = document.createElement('div');
          notice.id = noticeId;
          notice.setAttribute('data-palink-card-crash-notice', '1');
          notice.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483646;max-width:92vw;padding:9px 14px;border-radius:8px;background:rgba(24,24,28,.95);color:#fde68a;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.35);border:1px solid rgba(253,230,138,.35);pointer-events:none;';
          // 把**真正的错误**写到浮层上：只写"初始化失败"等于没说，用户无法据此判断
          // 是缺 API、是脚本没加载、还是卡自己的 bug。这里直接把首条卡内错误贴出来。
          const errText = firstCardErrorText();
          notice.textContent = '卡片初始化失败，设置面板暂时打不开'
            + (errText ? '：' + errText : '（按 F12 搜「卡内错误」看详情）');
          (document.body || document.documentElement).appendChild(notice);
          setTimeout(() => { try { notice.remove(); } catch (e) {} }, 4200);
        } catch (e) { /* 静默 */ }
      } catch (e) { /* 静默 */ }
    }, true);
  } catch (e) { /* 静默 */ }
})();`;
