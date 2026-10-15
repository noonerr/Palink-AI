/**
 * legacy-st-sim 段 · 第 02 段（原 legacy-st-sim.ts 第 837-1658 行）
 *
 * 机械拆分产物：逐字节搬运，未改任何逻辑。内容是注入卡片 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 拼接顺序由 legacy-st-sim.ts 固定（a → b → c），不可调换。
 *  3. 修改后必须跑 node scripts/verify-shim-identity.mjs 比对字节快照。
 */

export const LEGACY_ST_SIM_SEGMENT_PART_B = `    const content = String(message?.content ?? message?.message ?? message?.mes ?? '');
    const id = message?.id ?? message?.message_id ?? message?.mesid ?? fallbackIndex;
    const mesid = Number.isFinite(Number(message?.mesid)) ? Number(message.mesid) : fallbackIndex;
    const isUser = typeof message?.is_user === 'boolean' ? message.is_user : role === 'user';
    const isSystem = typeof message?.is_system === 'boolean' ? message.is_system : role === 'system';
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    const normalized = {
      id,
      message_id: id,
      mesid,
      name: message?.name || (isUser ? ctx.userName : ctx.characterName),
      role,
      is_user: isUser,
      is_system: isSystem,
      is_name: typeof message?.is_name === 'boolean'
        ? message.is_name
        : typeof extra?.is_name === 'boolean'
          ? extra.is_name
          : true,
      content,
      message: content,
      mes: content,
      text: content,
      swipes: Array.isArray(message?.swipes) && message.swipes.length
        ? message.swipes.map((item) => String(item ?? ''))
        : id === ctx.messageId
          ? buildSwipes()
          : [content],
      swipe_id: Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : (id === ctx.messageId ? currentSwipeId : 0),
      swipe_info: Array.isArray(message?.swipe_info)
        ? clone(message.swipe_info)
        : Array.isArray(extra?.swipe_info)
          ? clone(extra.swipe_info)
          : undefined,
      send_date: message?.created_at || message?.send_date || '',
      extra,
    };
    return copyStMessageMeta(normalized, message, extra);
  };
  const chatMessages = () => {
    const source = Array.isArray(ctx.chatMessages) && ctx.chatMessages.length > 0
      ? ctx.chatMessages
      : [{ id: ctx.messageId, role: 'assistant', name: ctx.characterName, content: ctx.messageContent }];
    return source.map((message, index) => normalizeChatMessage(message, index));
  };
  const currentChatMessage = () => {
    const messages = chatMessages();
    return messages.find((message) => String(message.id) === String(ctx.messageId)) || messages[messages.length - 1] || normalizeChatMessage({}, 0);
  };
  const getChatMessages = (messageId) => {
    const messages = chatMessages();
    if (messageId === undefined || messageId === null || messageId === '') return messages;
    if (Number.isInteger(Number(messageId)) && Number(messageId) >= 0) {
      const byIndex = messages[Number(messageId)];
      if (byIndex) return [byIndex];
      // [P0-FIX 2026-10-06] 下标落空时回退按 id 匹配，与 SillyTavernCompatRuntime 的
      // getCompatChatMessages（09-30 已修）对齐。ST 语义里 messageId 是聊天数组下标，
      // 但 Palink 的 ctx.messageId 是数据库行 id（实测如 2740），而卡脚本的惯用写法是
      // getChatMessages(getCurrentMessageId())[0].message —— 只按下标取值必然落空并返回
      // 空数组，卡侧就报「无法加载状态数据 (messages empty)」。
      // 为什么必须修在这份而不是 compatV2 那份：帧内 shim 拼接顺序是 legacy 在前
      // （CharacterCardRenderer 的 shim = legacyShim + compatV2Shim），legacy 已把
      // window.getChatMessages 挂上，compatV2 的 typeof window.getChatMessages 短路
      // 会优先调它 —— compatV2 里那份带修复的实现永远轮不到。
      const byId = messages.filter((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId));
      if (byId.length > 0) return byId;
      return [];
    }
    return messages.filter((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId));
  };
  const getGroupSource = () => chatMessages().find((message) => (
    message?.selected_group !== undefined
    || message?.group_id !== undefined
    || message?.groupId !== undefined
    || Array.isArray(message?.groups)
  ));
  const getGroups = () => {
    const source = getGroupSource();
    if (Array.isArray(source?.groups)) return clone(source.groups);
    const groupId = source?.selected_group ?? source?.group_id ?? source?.groupId;
    if (!groupId) return [];
    const members = chatMessages()
      .filter((message) => message && !message.is_user && !message.is_system && message.name)
      .map((message) => message.avatar || message.force_avatar || message.original_avatar || message.name);
    return [{
      id: groupId,
      name: source?.group_name ?? source?.groupName ?? ctx.characterName,
      members,
      disabled_members: [],
      chat_id: ctx.sessionId,
    }];
  };
  const getGroupChat = (groupId = getGroupSource()?.selected_group ?? getGroupSource()?.group_id ?? getGroupSource()?.groupId) => {
    const groups = getGroups();
    const group = groups.find((item) => String(item?.id) === String(groupId))
      || groups.find((item) => String(item?.name) === String(groupId))
      || groups[0]
      || {};
    return {
      ...clone(group),
      id: group.id ?? groupId ?? null,
      chat_id: group.chat_id ?? ctx.sessionId,
      chat: chatMessages(),
      messages: chatMessages(),
    };
  };
  // [S1-G7 2026-10-13] 用 srcdoc 构建期内联的会话绑定世界书名做初值。
  // 帧内桥是异步的，不内联则首次同步调用必为空（真机 MVU 只在模块顶层读一次，等不起）。
  let activeWorldbookName = String((ctx && ctx.worldbookName) || '');
  const rememberWorldbookName = (requestedName, result) => {
    const resultName = result && typeof result === 'object'
      ? (result.name || result.worldbookName || result.world_book_name || result.title)
      : '';
    const nextName = String(resultName || requestedName || activeWorldbookName || '').trim();
    if (nextName) activeWorldbookName = nextName;
  };
  const setChatMessageApi = async (content, index = 0, options = {}) => {
    ctx.messageContent = String(content ?? '');
    const requestedIndex = Number.isInteger(Number(index)) && Number(index) >= 0 ? Number(index) : undefined;
    if (Array.isArray(ctx.chatMessages)) {
      const targetIndex = requestedIndex !== undefined
        ? requestedIndex
        : ctx.chatMessages.findIndex((message) => String(message?.id) === String(ctx.messageId));
      const resolvedIndex = targetIndex >= 0 ? targetIndex : ctx.chatMessages.findIndex((message) => String(message?.id) === String(ctx.messageId));
      if (resolvedIndex >= 0 && ctx.chatMessages[resolvedIndex]) {
        ctx.chatMessages[resolvedIndex] = {
          ...ctx.chatMessages[resolvedIndex],
          content: ctx.messageContent,
          mes: ctx.messageContent,
          message: ctx.messageContent,
          swipe_id: Number.isFinite(Number(options?.swipe_id ?? options?.swipeId))
            ? Number(options?.swipe_id ?? options?.swipeId)
            : ctx.chatMessages[resolvedIndex].swipe_id,
        };
      }
    }
    const nextSwipeId = Number(options?.swipe_id ?? options?.swipeId ?? currentSwipeId);
    if (Number.isFinite(nextSwipeId)) currentSwipeId = nextSwipeId;
    post({
      type: 'setChatMessage',
      content: ctx.messageContent,
      index: requestedIndex,
      messageId: requestedIndex !== undefined
        ? (chatMessages()[requestedIndex]?.message_id ?? chatMessages()[requestedIndex]?.id ?? ctx.messageId)
        : ctx.messageId,
      options,
    });
    try {
      eventSource.emit('message_updated', currentChatMessage());
      eventSource.emit('chat_changed', chatMessages());
    } catch {}
    return { content: ctx.messageContent, index, options };
  };
  const sendMessageApi = async (content, options = {}) => requestParent('sendMessage', {
    content: String(content ?? ''),
    awaitResult: Boolean(options?.awaitResult),
    options,
  });
  const generateCompatApi = async (action, prompt) => {
    const response = await requestParent(action, {
      content: substituteParams(String(prompt ?? '')),
      awaitResult: true,
    });
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      return response.content || response.text || response.message || response.result || '';
    }
    return '';
  };
  const triggerGenerationCompatApi = async (type = 'normal', options = {}, dryRun = false) => {
    const generationOptions = options && typeof options === 'object' ? options : {};
    const prompt = generationOptions.quiet_prompt
      ?? generationOptions.quietPrompt
      ?? generationOptions.prompt
      ?? generationOptions.message
      ?? generationOptions.content
      ?? '';
    const response = await requestParent('triggerGeneration', {
      type: String(type || 'normal'),
      content: substituteParams(String(prompt ?? '')),
      options: generationOptions,
      dryRun: Boolean(dryRun),
      awaitResult: true,
    });
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      return response.content || response.text || response.message || response.result || '';
    }
    return '';
  };
  const getContext = () => ({
    accountStorage: window.localStorage,
    name1: ctx.userName,
    name2: ctx.characterName,
    characterId: ctx.characterId,
    this_chid: ctx.characterId,
    messageId: ctx.messageId,
    sessionId: ctx.sessionId,
    chatId: ctx.sessionId,
    viewport: ctx.viewport || {},
    presentationMode: ctx.presentationMode || 'inline',
    isImmersive: Boolean(ctx.viewport?.immersive) || String(ctx.presentationMode || '').startsWith('immersive'),
    chat: chatMessages(),
    characters: [{ id: ctx.characterId, name: ctx.characterName, avatar: ctx.characterId, data: { name: ctx.characterName, extensions: ctx.characterExtensions || {} } }],
    selected_group: getGroupSource()?.selected_group ?? getGroupSource()?.group_id ?? getGroupSource()?.groupId ?? null,
    groupId: getGroupSource()?.selected_group ?? getGroupSource()?.group_id ?? getGroupSource()?.groupId ?? null,
    groups: getGroups(),
    getGroups,
    getGroupChat,
    extensionSettings: window.extension_settings,
    eventSource,
    eventTypes: window.event_types,
    event_types: window.event_types,
    substituteParams,
    substituteParamsExtended: substituteParams,
    getChatMessages,
    getCurrentMessageId: () => ctx.messageId,
    setChatMessage: setChatMessageApi,
    sendMessage: sendMessageApi,
    sendMessageAsUser: (content) => requestParent('sendMessageAsUser', { content: String(content ?? ''), awaitResult: false }),
    Generate: triggerGenerationCompatApi,
    generate: (options = {}) => triggerGenerationCompatApi('normal', options && typeof options === 'object' ? options : {}, false),
    generateRaw: (prompt) => generateCompatApi('generateRaw', prompt),
    generateRawData: async (prompt) => {
      const content = await generateCompatApi('generateRaw', prompt);
      return { choices: [{ message: { content }, text: content }] };
    },
    generateQuietPrompt: (prompt) => generateCompatApi('generateQuietPrompt', prompt),
    addOneMessage: (message) => requestParent('addOneMessage', {
      content: typeof message === 'string' ? message : String(message?.mes ?? message?.content ?? message?.message ?? ''),
      messageId: typeof message === 'string' ? ctx.messageId : message?.id ?? message?.message_id ?? ctx.messageId,
      index: typeof message === 'string' ? undefined : message?.mesid,
      name: typeof message === 'string' ? undefined : message?.name,
      role: typeof message === 'string' ? undefined : message?.role,
      is_user: typeof message === 'string' ? undefined : message?.is_user,
      is_system: typeof message === 'string' ? undefined : message?.is_system,
      is_name: typeof message === 'string' ? undefined : message?.is_name,
      force_avatar: typeof message === 'string' ? undefined : message?.force_avatar ?? message?.forceAvatar,
      original_avatar: typeof message === 'string' ? undefined : message?.original_avatar ?? message?.originalAvatar,
      avatar: typeof message === 'string' ? undefined : message?.avatar,
      gen_id: typeof message === 'string' ? undefined : message?.gen_id ?? message?.genId,
      group_id: typeof message === 'string' ? undefined : message?.group_id ?? message?.groupId,
      group_name: typeof message === 'string' ? undefined : message?.group_name ?? message?.groupName,
      selected_group: typeof message === 'string' ? undefined : message?.selected_group ?? message?.selectedGroup,
      groups: typeof message === 'string' ? undefined : Array.isArray(message?.groups) ? clone(message.groups) : undefined,
      swipe_id: typeof message === 'string' ? undefined : message?.swipe_id ?? message?.swipeId,
      swipes: typeof message === 'string' ? undefined : Array.isArray(message?.swipes) ? message.swipes.map((item) => String(item ?? '')) : undefined,
      swipe_info: typeof message === 'string' ? undefined : Array.isArray(message?.swipe_info) ? clone(message.swipe_info) : undefined,
      extra: typeof message === 'string' ? undefined : message?.extra && typeof message.extra === 'object' ? clone(message.extra) : undefined,
      display_text: typeof message === 'string' ? undefined : message?.display_text ?? message?.displayText,
    }),
    reloadCurrentChat: () => post({ type: 'refresh' }),
    saveSettingsDebounced: () => {},
    saveMetadataDebounced: () => persistSmartCardRuntimeStores(),
    saveMetadata: () => persistSmartCardRuntimeStores(),
    TavernHelper: window.TavernHelper,
    Mvu: window.Mvu,
    extension_settings: window.extension_settings,
    extensionPrompts: window.getVariable?.('__extension_prompts', {}) || {},
    setExtensionPrompt: window.setExtensionPrompt,
    getExtensionPrompt: window.getExtensionPrompt,
    writeExtensionField: window.writeExtensionField,
    readExtensionField: window.readExtensionField,
    chat_metadata: window.chat_metadata || {},
    chatMetadata: window.chat_metadata || {},
    // 防御性补全：避免覆盖 sillyTavernPluginRuntime 已设置好的 stat_data。
    // 优先 ctx，回退到 runtime 已存的 context，再回退空对象。
    stat_data:
      ctx?.stat_data ||
      window.__palinkStRuntime?.context?.stat_data ||
      {},
    messageFormatting: window.messageFormatting,
    messageFormatter: window.messageFormatter,
    MessageFormatter: window.MessageFormatter,
    Popup: window.Popup,
    POPUP_TYPE: window.POPUP_TYPE,
    callGenericPopup: window.callGenericPopup,
    updateMessageBlock: window.updateMessageBlock,
    powerUserSettings: window.power_user,
    power_user: window.power_user,
    getPresetManager: () => ({
      getSelectedPresetName: () => 'Palink',
      getSelectedPreset: () => ({}),
    }),
    loader: {
      show: () => post({ type: 'log', level: 'info', message: 'loader.show' }),
      hide: () => post({ type: 'log', level: 'info', message: 'loader.hide' }),
    },
    variables: {
      local: { get: window.getLocalVariable, set: window.setLocalVariable },
      global: { get: window.getGlobalVariable, set: window.setGlobalVariable },
    },
  });
  window.extension_settings = window.extension_settings || {};
  window.extension_settings.regex = window.extension_settings.regex || [];
  window.extension_settings.character_allowed_regex = window.extension_settings.character_allowed_regex || [];
  window.extension_settings.preset_allowed_regex = window.extension_settings.preset_allowed_regex || {};
  const readStoredJson = (key, fallback = {}) => {
    try {
      const raw = window.localStorage?.getItem?.(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  };
  const writeStoredJson = (key, value) => {
    try { window.localStorage?.setItem?.(key, JSON.stringify(value ?? {})); } catch {}
  };
  window.chat_metadata = window.chat_metadata || readStoredJson('__palink_chat_metadata', {});
  window._ = window._ || {
    get: getByPath,
    set: setByPath,
    cloneDeep: clone,
    isEmpty(value) {
      if (value == null) return true;
      if (Array.isArray(value) || typeof value === 'string') return value.length === 0;
      if (typeof value === 'object') return Object.keys(value).length === 0;
      return false;
    },
  };
  window.Mvu = window.Mvu || {
    events: {
      // [MVU-EVENTS 2026-10-05] 契约真值（见文件头 MVU_EVENT_KEYS 的注释）。
      // 键放在展开/兜底之后：事件键是常量不是实现，必须以契约为准，
      // 否则卡脚本按常量订阅会落空。
      ...MVU_EVENT_KEYS,
      CHAT_VARIABLES_UPDATED: 'CHAT_VARIABLES_UPDATED',
    },
    getAllVariables: () => clone(allVariables),
  };
  // [SINGLE-SOURCE] legacy 保留 smartCardVariableStore 仅作为 compatV2 注入前的
  // 早期兜底（如 shim 启动阶段的 Mvu.getAllVariables 快照）。compatV2 注入后，
  // 变量读写一律惰性转发 window.getVariable/window.setVariable（compatV2 实现，
  // 写 chatVariableStore + postMessage 持久化到父页面 localStorage），不再写
  // iframe memoryStorage 的 __palink_chat_variables（iframe 销毁即丢失）。
  const smartCardVariableStore = mergePlainObjects(allVariables, readStoredJson('__palink_chat_variables', {}));
  const persistSmartCardRuntimeStores = () => {
    // [SINGLE-SOURCE] 变量持久化统一由 compatV2 persistVariableStores() 承担
    // （postMessage → 父页面 localStorage）。这里仅保留 chat_metadata 持久化，
    // 不再写 __palink_chat_variables，避免双 store 互相覆盖导致变量丢失。
    writeStoredJson('__palink_chat_metadata', window.chat_metadata || {});
  };
  const getSmartCardVariable = (path, fallback = undefined) => {
    // compatV2 已接管变量读写时转发（window.getVariable 是 compatV2 实现时，
    // 其引用 !== 本函数 getSmartCardVariable，因此可用引用不等判断接管）。
    if (typeof window.getVariable === 'function' && window.getVariable !== getSmartCardVariable) {
      return window.getVariable(path, fallback);
    }
    return getByPath(smartCardVariableStore, path, fallback);
  };
  const setSmartCardVariable = (path, value) => {
    if (typeof window.setVariable === 'function' && window.setVariable !== setSmartCardVariable) {
      return window.setVariable(path, value);
    }
    setByPath(smartCardVariableStore, path, value);
    persistSmartCardRuntimeStores();
    try {
      // [MVU-EVENTS 2026-10-05] 卡片自己 setVariable 触发一轮更新：
      // ended 要发；before_message_update 的语义是「即将更新楼层」，这条路径不涉及，不发。
      eventSource.emit(MVU_EVENT_KEYS.VARIABLE_UPDATE_ENDED, clone(smartCardVariableStore));
      eventSource.emit('CHAT_VARIABLES_UPDATED', clone(smartCardVariableStore));
    } catch {}
    return value;
  };
  const replaceSmartCardVariables = (text) => substituteParams(String(text ?? '')).replace(/{{var::([^}]+)}}/g, (_match, path) => {
    const value = getSmartCardVariable(String(path || '').trim(), '');
    return value == null ? '' : String(value);
  });
  const htmlEscapeCompat = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const messageFormattingCompat = (mes, chName = ctx.characterName, isSystem = false, isUser = false) => {
    const html = htmlEscapeCompat(substituteParams(String(mes ?? '')))
      .replace(new RegExp('\\\\x60\\\\x60\\\\x60([\\\\s\\\\S]*?)\\\\x60\\\\x60\\\\x60', 'g'), '<pre><code>$1</code></pre>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
      .replace(/\\n/g, '<br>');
    if (isSystem) return '<span class="mes-system">' + html + '</span>';
    if (isUser) return '<span class="mes-user">' + html + '</span>';
    const name = htmlEscapeCompat(chName || ctx.characterName || '');
    return name ? '<span class="mes-name">' + name + '</span><span class="mes-text">' + html + '</span>' : html;
  };
  Object.assign(window.Mvu, {
    getAllVariables: window.Mvu.getAllVariables || (() => clone(smartCardVariableStore)),
    getVariable: window.Mvu.getVariable || getSmartCardVariable,
    setVariable: window.Mvu.setVariable || setSmartCardVariable,
    replaceVariables: window.Mvu.replaceVariables || replaceSmartCardVariables,
  });
  window.getAllVariables = window.getAllVariables || (() => clone(allVariables));
  window.getVariables = window.getVariables || (() => clone(smartCardVariableStore));
  window.getChatVariables = window.getChatVariables || (() => clone(smartCardVariableStore));
  window.getLocalVariable = window.getLocalVariable || getSmartCardVariable;
  window.getGlobalVariable = window.getGlobalVariable || getSmartCardVariable;
  window.getVariable = window.getVariable || getSmartCardVariable;
  window.setLocalVariable = window.setLocalVariable || setSmartCardVariable;
  window.setGlobalVariable = window.setGlobalVariable || setSmartCardVariable;
  window.setVariable = window.setVariable || setSmartCardVariable;
  window.setVariables = window.setVariables || ((value) => {
    // [SINGLE-SOURCE] compatV2 已接管时转发其批量写实现（写 chatVariableStore + 持久化），
    // 避免写进 legacy iframe memoryStorage 后 iframe 销毁丢失。
    if (typeof window.setVariable === 'function' && window.setVariable !== setSmartCardVariable) {
      if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, entryValue]) => window.setVariable(key, entryValue));
      }
      return clone(value || {});
    }
    if (value && typeof value === 'object') mergePlainObjects(smartCardVariableStore, value);
    persistSmartCardRuntimeStores();
    return clone(smartCardVariableStore);
  });
  window.replaceVariables = window.replaceVariables || replaceSmartCardVariables;
  window.messageFormatting = window.messageFormatting || messageFormattingCompat;
  window.messageFormatter = window.messageFormatter || {
    render: messageFormattingCompat,
    format: messageFormattingCompat,
    process: (message) => messageFormattingCompat(
      message?.mes ?? message?.content ?? message?.message ?? message,
      message?.name,
      Boolean(message?.is_system),
      Boolean(message?.is_user),
    ),
  };
  window.MessageFormatter = window.MessageFormatter || window.messageFormatter;
  window.saveSettingsDebounced = window.saveSettingsDebounced || persistSmartCardRuntimeStores;
  window.saveMetadataDebounced = window.saveMetadataDebounced || persistSmartCardRuntimeStores;
  window.waitGlobalInitialized = window.waitGlobalInitialized || (async (name) => window[name] || true);
  const extensionPromptStore = getSmartCardVariable('__extension_prompts', {});
  const extensionFieldStore = getSmartCardVariable('__extension_fields', {});
  window.setExtensionPrompt = window.setExtensionPrompt || ((key, value, position, depth, scan, role, filter) => {
    // [SINGLE-SOURCE] 兜底实现（compatV2 注入后由 setCompatFunction 无条件接管，
    // 其完整签名含 role/filter 并写 chatVariableStore.__extension_prompts）。
    // 此处补齐 role/filter，确保 compatV2 未注入的早期阶段也不丢参数。
    extensionPromptStore[String(key || 'default')] = { value, position, depth, scan, role, filter };
    setSmartCardVariable('__extension_prompts', extensionPromptStore);
    return true;
  });
  window.getExtensionPrompt = window.getExtensionPrompt || ((key) => extensionPromptStore[String(key || 'default')]?.value || '');
  window.writeExtensionField = window.writeExtensionField || (async (_chid, key, value) => {
    extensionFieldStore[String(key || '')] = value;
    setSmartCardVariable('__extension_fields', extensionFieldStore);
    return value;
  });
  window.readExtensionField = window.readExtensionField || (async (_chid, key) => extensionFieldStore[String(key || '')]);
  window.eventOn = window.eventOn || ((type, cb) => {
    eventSource.on(type, cb);
    return () => eventSource.off(type, cb);
  });
  window.eventMakeLast = window.eventMakeLast || ((type, cb) => window.eventOn(type, cb));
  window.errorCatched = window.errorCatched || ((fn) => (...args) => {
    try {
      const result = typeof fn === 'function' ? fn(...args) : undefined;
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn('[errorCatched] async error:', error);
          post({ type: 'error', message: String(error?.message || error) });
        });
      }
      return result;
    } catch (error) {
      console.warn('[errorCatched] sync error:', error);
      post({ type: 'error', message: String(error?.message || error) });
      return undefined;
    }
  });
  window.setChatMessage = window.setChatMessage || setChatMessageApi;
  window.updateMessageBlock = window.updateMessageBlock || (async (_messageId, content, options = {}) => {
    if (typeof content === 'string') return setChatMessageApi(content, 0, options);
    if (content && typeof content === 'object') {
      const nextContent = content.message || content.mes || content.text || content.content;
      if (typeof nextContent === 'string') return setChatMessageApi(nextContent, 0, options);
    }
    return { success: true };
  });
  window.sendMessage = window.sendMessage || sendMessageApi;
  window.sendUserMessage = window.sendUserMessage || window.sendMessage;
  window.sendMessageAsUser = window.sendMessageAsUser || ((content) => requestParent('sendMessageAsUser', { content: String(content ?? ''), awaitResult: false }));
  window.Generate = window.Generate || triggerGenerationCompatApi;
  window.generate = window.generate || ((options = {}) => triggerGenerationCompatApi('normal', options && typeof options === 'object' ? options : {}, false));
  window.generateRaw = window.generateRaw || ((prompt) => generateCompatApi('generateRaw', prompt));
  window.generateRawData = window.generateRawData || (async (prompt) => {
    const content = await generateCompatApi('generateRaw', prompt);
    return { choices: [{ message: { content }, text: content }] };
  });
  window.generateQuietPrompt = window.generateQuietPrompt || ((prompt) => generateCompatApi('generateQuietPrompt', prompt));
  window.addOneMessage = window.addOneMessage || ((message) => requestParent('addOneMessage', {
    content: typeof message === 'string' ? message : String(message?.mes ?? message?.content ?? message?.message ?? ''),
    messageId: typeof message === 'string' ? ctx.messageId : message?.id ?? message?.message_id ?? ctx.messageId,
    index: typeof message === 'string' ? undefined : message?.mesid,
    name: typeof message === 'string' ? undefined : message?.name,
    role: typeof message === 'string' ? undefined : message?.role,
    is_user: typeof message === 'string' ? undefined : message?.is_user,
    is_system: typeof message === 'string' ? undefined : message?.is_system,
    is_name: typeof message === 'string' ? undefined : message?.is_name,
    force_avatar: typeof message === 'string' ? undefined : message?.force_avatar ?? message?.forceAvatar,
    original_avatar: typeof message === 'string' ? undefined : message?.original_avatar ?? message?.originalAvatar,
    avatar: typeof message === 'string' ? undefined : message?.avatar,
    gen_id: typeof message === 'string' ? undefined : message?.gen_id ?? message?.genId,
    group_id: typeof message === 'string' ? undefined : message?.group_id ?? message?.groupId,
    group_name: typeof message === 'string' ? undefined : message?.group_name ?? message?.groupName,
    selected_group: typeof message === 'string' ? undefined : message?.selected_group ?? message?.selectedGroup,
    groups: typeof message === 'string' ? undefined : Array.isArray(message?.groups) ? clone(message.groups) : undefined,
    swipe_id: typeof message === 'string' ? undefined : message?.swipe_id ?? message?.swipeId,
    swipes: typeof message === 'string' ? undefined : Array.isArray(message?.swipes) ? message.swipes.map((item) => String(item ?? '')) : undefined,
    swipe_info: typeof message === 'string' ? undefined : Array.isArray(message?.swipe_info) ? clone(message.swipe_info) : undefined,
    extra: typeof message === 'string' ? undefined : message?.extra && typeof message.extra === 'object' ? clone(message.extra) : undefined,
    display_text: typeof message === 'string' ? undefined : message?.display_text ?? message?.displayText,
  }));
  window.setInputDraft = window.setInputDraft || ((content) => post({ type: 'setInputDraft', content: String(content ?? '') }));
  // Task 8.7: Popup stub 委托到父应用的 popup-system（通过 requestParent）
  window.callGenericPopup = window.callGenericPopup || (async (message, type, inputValue, options) => {
    // input 类型委托到父应用显示真实弹窗
    if (type === 'input' || (typeof type === 'string' && type.includes('input'))) {
      try {
        const res = await requestParent('callGenericPopup', { message: String(message ?? ''), type, inputValue, options });
        if (res?.ok) return res.result ?? '';
      } catch { /* fall through */ }
      return '';
    }
    if (message != null) post({ type: 'log', level: 'info', message: String(message) });
    return true;
  });
  window.POPUP_TYPE = window.POPUP_TYPE || { TEXT: 'text', CONFIRM: 'confirm', INPUT: 'input' };
  window.Popup = window.Popup || {
    show: async (_type, message, inputValue, options) => {
      if (message != null) post({ type: 'log', level: 'info', message: String(message) });
      return true;
    },
    text: async (message, options) => {
      if (message != null) post({ type: 'log', level: 'info', message: String(message) });
      return true;
    },
    confirm: async (message, options) => {
      if (message != null) post({ type: 'log', level: 'info', message: String(message) });
      return true;
    },
    input: async (message, defaultValue, options) => {
      // Task 8.7: input 类型委托到父应用 popup-system
      try {
        const res = await requestParent('callGenericPopup', { message: String(message ?? ''), type: 'input', inputValue: defaultValue, options });
        if (res?.ok) return res.result ?? '';
      } catch { /* fall through */ }
      return '';
    },
  };
  // [S1-G1 2026-10-13] 形状订正：ST 契约是**同步**返回 { primary: string|null, additional: string[] }。
  // 依据（三条实测，详见 utils/sillyTavernPluginRuntime.ts [S1-G1] 注释）：
  //   1. @types/function/worldbook.d.ts:32 声明该函数返回 CharWorldbooks，**非 Promise**；
  //   2. 真机 MVU 写法 getCharWorldbookNames('current').primary ?? 'unknown' —— 不 await、读 .primary；
  //   3. JS-Slash-Runner 自家实现就是同步转调 getCharLorebooks。
  // 此前本处返回 Promise ⇒ 消费者同步读 .primary 恒 undefined ⇒ initialized_lorebooks 退化成 'unknown'。
  let worldbookNamesWarmStarted = false;
  const getCharWorldbookNamesCompat = () => {
    if (!activeWorldbookName && !worldbookNamesWarmStarted) {
      // 冷缓存自热：帧内名字只在卡自己建过世界书后才有值，首次调用几乎必为空。
      // 本 API 同步，等不起 —— 后台拉一次把缓存填上，供**后续**调用取到真值。
      // 只 kick 一次：父侧无世界书时 result.name 恒空，不守卫会每次调用都发一轮 RPC。
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
  window.getCharWorldbookNames = window.getCharWorldbookNames || getCharWorldbookNamesCompat;
  window.getCharWorldbook = window.getCharWorldbook || (async (...args) => requestParent('getCharWorldbook', { args }));
  window.createOrReplaceCharWorldbook = window.createOrReplaceCharWorldbook || (async (name, entries, options = {}) => {
    const result = await requestParent('createOrReplaceWorldbook', { name, entries, options, scope: 'character' });
    rememberWorldbookName(name, result);
    return result;
  });
  window.createOrReplaceWorldbook = window.createOrReplaceWorldbook || (async (name, entries, options = {}) => {
    const result = await requestParent('createOrReplaceWorldbook', { name, entries, options, scope: 'world' });
    rememberWorldbookName(name, result);
    return result;
  });
  window.createWorldbook = window.createWorldbook || (async (name, entries = [], options = {}) => {
    const result = await requestParent('createWorldbook', { name, entries, options });
    rememberWorldbookName(name, result);
    return result;
  });
  window.createWorldbookEntries = window.createWorldbookEntries || (async (target, entries = [], options = {}) => {
    const result = await requestParent('createWorldbookEntries', { target, entries, options });
    rememberWorldbookName(target, result);
    return result;
  });
  window.deleteWorldbookEntries = window.deleteWorldbookEntries || (async (target, predicateSource) => requestParent('deleteWorldbookEntries', { target, predicateSource: String(predicateSource || '') }));
  window.getWorldbook = window.getWorldbook || window.getCharWorldbook;
  window.getWorldbookEntries = window.getWorldbookEntries || (async (target) => requestParent('getWorldbookEntries', { target }));
  window.setWorldbookEntries = window.setWorldbookEntries || (async (target, entries = [], options = {}) => requestParent('setWorldbookEntries', { target, entries, options }));
  window.rebindChatWorldbook = window.rebindChatWorldbook || (async (chatId, worldbookName) => {
    const result = await requestParent('rebindChatWorldbook', { chatId, worldbookName });
    rememberWorldbookName(worldbookName, result);
    return result;
  });
  window.activateChatWorldbook = window.activateChatWorldbook || (async (worldbookName) => {
    const result = await requestParent('activateChatWorldbook', { worldbookName });
    rememberWorldbookName(worldbookName, result);
    return result;
  });
  window.AutoCardUpdaterAPI = window.AutoCardUpdaterAPI || {
    async exportTableAsJson() { return { rows: [], data: {}, metadata: window.chat_metadata || {} }; },
    async initGameSession() { return { success: true, chat: chatMessages() }; },
    getChatMessages: () => chatMessages(),
    setChatMessage: setChatMessageApi,
    updateMessageBlock: window.updateMessageBlock,
    registerTableUpdateCallback(cb) {
      if (typeof cb === 'function') {
        try { setTimeout(() => cb({ rows: [], data: {}, metadata: window.chat_metadata || {} }), 0); } catch {}
      }
      return () => {};
    },
  };
  window.eventSource = eventSource;
  window.substituteParams = substituteParams;
  window.getCurrentMessageId = () => ctx.messageId;
  window.getChatMessages = getChatMessages;
  window.getContext = getContext;
  window.SillyTavern = window.SillyTavern || {};
  window.SillyTavern.getContext = getContext;
  window.SillyTavern.getCurrentMessageId = window.getCurrentMessageId;
  window.SillyTavern.getChatMessages = getChatMessages;
  // P1-7 修复: 注册 window.SillyTavern.getExtensionPrompts，让 generation-engine
  // 能读取主窗口的 extensionPrompt store。之前 generation-engine 调用
  // st.getExtensionPrompts() 时返回 undefined（主窗口未注册），导致所有
  // setExtensionPrompt 注入的提示词被静默丢弃。
  // 读取两套 store 合并:
  //   1. CharacterCardRenderer 的 smartCardVariableStore.__extension_prompts
  //   2. iframe 持久化的 __palink_extension_prompts（localStorage）
  window.SillyTavern.getExtensionPrompts = window.SillyTavern.getExtensionPrompts || (() => {
    const result = [];
    // 1. 读取 CharacterCardRenderer 的 smartCardVariableStore
    try {
      const store = getSmartCardVariable('__extension_prompts', {});
      if (store && typeof store === 'object') {
        for (const [key, v] of Object.entries(store)) {
          if (v && typeof v === 'object') {
            result.push({
              identifier: key,
              content: String((v).value ?? ''),
              position: typeof (v).position === 'number' ? (v).position : -1,
              depth: typeof (v).depth === 'number' ? (v).depth : 4,
              role: (window).extension_prompt_roles?.SYSTEM ?? 0,
              filter: {},
            });
          }
        }
      }
    } catch { /* ignore */ }
    // 2. 读取 iframe 持久化的 __palink_extension_prompts（localStorage）
    try {
      const raw = localStorage.getItem('__palink_extension_prompts');
      if (raw) {
        const store = JSON.parse(raw);
        if (store && typeof store === 'object') {
          for (const [key, v] of Object.entries(store)) {
            if (v && typeof v === 'object') {
              // 去重: 如果 identifier 已存在则跳过
              if (!result.some(r => r.identifier === key)) {
                result.push({
                  identifier: key,
                  content: String((v).value ?? ''),
                  position: typeof (v).position === 'number' ? (v).position : -1,
                  depth: typeof (v).depth === 'number' ? (v).depth : 4,
                  role: typeof (v).role !== 'undefined' ? (v).role : ((window).extension_prompt_roles?.SYSTEM ?? 0),
                  filter: (v).filter || {},
                });
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
    return result;
  });
  window.TavernHelper = window.TavernHelper || {};
  Object.assign(window.TavernHelper, {
    getContext: window.TavernHelper.getContext || getContext,
    getChatMessages: window.TavernHelper.getChatMessages || window.getChatMessages,
    getCurrentMessageId: window.TavernHelper.getCurrentMessageId || window.getCurrentMessageId,
    // API 补齐：真实酒馆助手卡大量走 TavernHelper.* 命名空间，window 层已有
    // 实现但未镜像的 API 全量补上（|| 兜底保持与上方既有条目相同的防御式写法）
    getLastMessageId: window.TavernHelper.getLastMessageId || function () { return Math.max(0, (ctx.chatMessages || []).length - 1); },
    getCurrentChatId: window.TavernHelper.getCurrentChatId || function () { return ctx.sessionId || ''; },
    setChatMessage: window.TavernHelper.setChatMessage || setChatMessageApi,
    updateMessageBlock: window.TavernHelper.updateMessageBlock || window.updateMessageBlock,
    sendMessage: window.TavernHelper.sendMessage || window.sendMessage,
    sendUserMessage: window.TavernHelper.sendUserMessage || window.sendUserMessage,
    sendMessageAsUser: window.TavernHelper.sendMessageAsUser || window.sendMessageAsUser,
    Generate: window.TavernHelper.Generate || window.Generate,
    generate: window.TavernHelper.generate || window.generate,
    generateRaw: window.TavernHelper.generateRaw || window.generateRaw,
    generateRawData: window.TavernHelper.generateRawData || window.generateRawData,
    generateQuietPrompt: window.TavernHelper.generateQuietPrompt || window.generateQuietPrompt,
    setInputDraft: window.TavernHelper.setInputDraft || window.setInputDraft,
    getVariables: window.TavernHelper.getVariables || window.getVariables,
    getAllVariables: window.TavernHelper.getAllVariables || window.getAllVariables,
    getChatVariables: window.TavernHelper.getChatVariables || window.getChatVariables,
    getVariable: window.TavernHelper.getVariable || window.getVariable,
    setVariable: window.TavernHelper.setVariable || window.setVariable,
    setVariables: window.TavernHelper.setVariables || window.setVariables,
    replaceVariables: window.TavernHelper.replaceVariables || window.replaceVariables,
    getGlobalVariable: window.TavernHelper.getGlobalVariable || window.getGlobalVariable,
    setGlobalVariable: window.TavernHelper.setGlobalVariable || window.setGlobalVariable,
    getLocalVariable: window.TavernHelper.getLocalVariable || window.getLocalVariable,
    setLocalVariable: window.TavernHelper.setLocalVariable || window.setLocalVariable,
    getWorldbook: window.TavernHelper.getWorldbook || window.getWorldbook,
    getWorldbookEntries: window.TavernHelper.getWorldbookEntries || window.getWorldbookEntries,
    setWorldbookEntries: window.TavernHelper.setWorldbookEntries || window.setWorldbookEntries,
    createWorldbook: window.TavernHelper.createWorldbook || window.createWorldbook,
    createOrReplaceWorldbook: window.TavernHelper.createOrReplaceWorldbook || window.createOrReplaceWorldbook,
    createOrReplaceCharWorldbook: window.TavernHelper.createOrReplaceCharWorldbook || window.createOrReplaceCharWorldbook,
    createWorldbookEntries: window.TavernHelper.createWorldbookEntries || window.createWorldbookEntries,
    deleteWorldbookEntries: window.TavernHelper.deleteWorldbookEntries || window.deleteWorldbookEntries,
    getCharWorldbook: window.TavernHelper.getCharWorldbook || window.getCharWorldbook,
    getCharWorldbookNames: window.TavernHelper.getCharWorldbookNames || window.getCharWorldbookNames,
    rebindChatWorldbook: window.TavernHelper.rebindChatWorldbook || window.rebindChatWorldbook,
    activateChatWorldbook: window.TavernHelper.activateChatWorldbook || window.activateChatWorldbook,
    substituteParams: window.TavernHelper.substituteParams || window.substituteParams,
    messageFormatting: window.TavernHelper.messageFormatting || window.messageFormatting,
    messageFormatter: window.TavernHelper.messageFormatter || window.messageFormatter,
    eventOn: window.TavernHelper.eventOn || window.eventOn,
    callGenericPopup: window.TavernHelper.callGenericPopup || window.callGenericPopup,
    getExtensionPrompt: window.TavernHelper.getExtensionPrompt || window.getExtensionPrompt,
    setExtensionPrompt: window.TavernHelper.setExtensionPrompt || window.setExtensionPrompt,
    readExtensionField: window.TavernHelper.readExtensionField || window.readExtensionField,
    writeExtensionField: window.TavernHelper.writeExtensionField || window.writeExtensionField,
    saveMetadataDebounced: window.TavernHelper.saveMetadataDebounced || window.saveMetadataDebounced,
  });
  const ready = (cb) => {
    if (typeof cb !== 'function') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      setTimeout(cb, 0);
    }
  };
  const resolveWindowPath = (path) => {
    const parts = String(path || '').split('.').filter(Boolean);
    let value = window;
    for (const part of parts) {
      if (value == null) return undefined;
      value = value[part];
    }
    return value;
  };
  const splitInlineArgs = (source) => {
    const args = [];
    let current = '';
    let quote = null;
    let escaped = false;
    let depth = 0;
    const text = String(source || '');
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        current += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        current += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') depth += 1;
      if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim() || text.trim()) args.push(current.trim());
    return args.filter((arg) => arg.length > 0);
  };
  const parseInlineString = (value) => {
    const text = String(value || '');
    const quote = text[0];
    let result = '';
    let escaped = false;
    for (let index = 1; index < text.length - 1; index += 1) {
      const char = text[index];
      if (!escaped && char === '\\\\') {
        escaped = true;
        continue;
      }
      if (escaped) {
        if (char === 'n') result += '\\n';
        else if (char === 'r') result += '\\r';
        else if (char === 't') result += '\\t';
        else result += char;
        escaped = false;
        continue;
      }
      result += char;
    }
    return quote ? result : text;
  };
`;
