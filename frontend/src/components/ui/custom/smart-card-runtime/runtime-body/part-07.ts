/**
 * ST 兼容运行时体 · 第 07 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 5579-6459 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

export const RUNTIME_BODY_PART_07 = `  ensureFunction('getCharWorldbook', async (...args) => requestParent('getCharWorldbook', { args }));
  // >>> S1-G10 LOREBOOK FAMILY BEGIN
  // [S1-G10 2026-10-13] 单间轨补齐 lorebook 族（S3 阻断项）。
  //
  // 为什么必须补：真机 MVU 的变量初始化器 zn() 依赖整族 API，而本帧此前**一个都没注册**
  // （大堂轨有，单间轨无）。真机原文（backend/data/smart_card_assets/ 三份 bundle 一致）：
  //   const e = [...(await getLorebookSettings()).selected_global_lorebooks];  // 不在 try 内！
  //   try { const t = await getCharLorebooks(); null !== t.primary && e.push(t.primary); }
  //   catch (e) { console.warn('primaryLorebookReadFailed', e) }
  //   for (const t of n) { ... const n = await getLorebookEntries(t); }
  // ⇒ 第一行就会 TypeError 且不在 try 内 ⇒ 变量初始化整体失败（真机弹「[MVU]变量初始化失败」）。
  // 今天默认走大堂轨所以没暴露；S3 把默认切到单间轨即炸。
  //
  // ST 契约（@types/function/lorebook.d.ts / lorebook_entry.d.ts）：除 getLorebookEntries
  // 声明为 Promise 外，其余四个都是同步。本帧内数据在父侧、桥是异步的，故分两类处理：
  //   - 同步三兄弟（getCharLorebooks 之外的 getCurrentCharPrimaryLorebook / getLorebookSettings）
  //     走「同步读帧内缓存 + 冷缓存只 kick 一次自热」，对齐主页面轨 :1581 的桥缓存策略；
  //   - getCharLorebooks 例外：真机 zn() 是 await 它，返回 Promise 才能确定性拿真值。
  //     本帧内该 API 在本轮之前根本不存在，改 async 不构成对任何既有消费者的回归。
  //
  // 红线：本区域位于 :265-:6981 的模板字符串内，禁止出现反引号与美元花括号。
  let activeLorebooks = { primary: '', additional: [] };
  let lorebooksWarmStarted = false;
  const warmCharLorebooksOnce = () => {
    if (lorebooksWarmStarted) return;
    lorebooksWarmStarted = true;
    requestParent('getCharWorldbook', { args: [] }).then((result) => {
      if (result && result.success === false) {
        post({ type: 'log', level: 'warn', message: 'getCharLorebooks 冷缓存自热失败，返回空绑定' });
        return;
      }
      const name = result && typeof result === 'object'
        ? String(result.name || result.world_book_name || result.worldbookName || '').trim()
        : '';
      if (name) {
        activeLorebooks = { primary: name, additional: [] };
        activeWorldbookName = name;
      }
    }).catch(() => {
      post({ type: 'log', level: 'warn', message: 'getCharLorebooks 冷缓存自热失败，返回空绑定' });
    });
  };
  const readCharLorebooksSync = () => {
    warmCharLorebooksOnce();
    const primary = activeLorebooks.primary || activeWorldbookName || '';
    return {
      primary: primary || null,
      additional: primary ? [primary] : [],
    };
  };
  const getCharLorebooksCompat = async (opts) => {
    // 非当前角色的按名查询：父侧桥只服务当前卡，返回空绑定并留痕（不冒充别人的世界书）。
    if (opts && opts.name && opts.name !== 'current') {
      post({ type: 'log', level: 'warn', message: 'getCharLorebooks 暂不支持按名查询非当前角色，返回空绑定' });
      return { primary: null, additional: [] };
    }
    try {
      const result = await requestParent('getCharWorldbook', { args: [] });
      if (result && result.success === false) {
        return { primary: null, additional: [] };
      }
      const name = result && typeof result === 'object'
        ? String(result.name || result.world_book_name || result.worldbookName || '').trim()
        : '';
      if (name) {
        activeLorebooks = { primary: name, additional: [] };
        activeWorldbookName = name;
      }
      // 父侧没有（例如卡尚未自建世界书）时，回退到构建期内联的会话绑定名 —— 这是 S1-G7
      // 让"同步首次就有值"真正生效的地方，不能因为父侧暂缺就把内联值丢掉。
      const resolved = name || activeLorebooks.primary || activeWorldbookName || '';
      // 形状与 getCharWorldbookNames（T1 契约）保持一致，避免两处再漂移。
      return { primary: resolved || null, additional: resolved ? [resolved] : [] };
    } catch (e) {
      post({ type: 'log', level: 'warn', message: 'getCharLorebooks 失败，返回空绑定' });
      return { primary: null, additional: [] };
    }
  };
  const getCurrentCharPrimaryLorebookCompat = () => {
    const books = readCharLorebooksSync();
    return books && books.primary ? books.primary : null;
  };
  // MVU 用它做 _.isEqual(_.merge({}, 当前设置, 期望值), 当前设置) 比较；下面 13 个字段与它
  // 期望值逐项一致 ⇒ 比较即相等，它的"归一化设置"步骤自然成为 no-op（不产生多余写入）。
  const LOREBOOK_SETTINGS_DEFAULTS = {
    scan_depth: 2,
    context_percentage: 100,
    budget_cap: 0,
    min_activations: 0,
    max_depth: 0,
    max_recursion_steps: 0,
    insertion_strategy: 'character_first',
    include_names: false,
    recursive: true,
    case_sensitive: false,
    match_whole_words: false,
    use_group_scoring: false,
    overflow_alert: false,
    selected_global_lorebooks: [],
  };
  let lorebookSettingsStore = null;
  const getLorebookSettingsCompat = () => {
    const merged = Object.assign({}, LOREBOOK_SETTINGS_DEFAULTS, lorebookSettingsStore || {});
    // 防御共享引用：默认值里的空数组不能把引用漏给调用方（否则调用方 push 会污染默认值）。
    merged.selected_global_lorebooks = Array.isArray(merged.selected_global_lorebooks)
      ? merged.selected_global_lorebooks.slice()
      : [];
    return merged;
  };
  const setLorebookSettingsCompat = (patch) => {
    if (patch && typeof patch === 'object') {
      lorebookSettingsStore = Object.assign({}, lorebookSettingsStore || {}, patch);
    }
    return getLorebookSettingsCompat();
  };
  // [S1-G11 2026-10-13] 归一化 requestParent 的返回形状。
  // 本帧有两套 requestParent：legacy 段（frame-shim）直接 resolve data.result；
  // 而本段（v2）在 :4659 这样 resolve：data.ok ? { ok: true, ...(data.result ?? {...}) }。
  // ⇒ **数组结果会被展开进对象**（Array.isArray 为 false、下标与 length 仍在）。
  // 真机实测（2026-10-13）：未归一化时 getLorebookEntries 恒返回 []，
  // 而 legacy 的 getWorldbookEntries 同参数返回 19 条 —— 就是被这个展开吃掉的。
  const normalizeCompatEntries = (result) => {
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.entries)) return result.entries;
    if (result && typeof result === 'object') {
      // ⚠️ 不能用 result.length 判：数组的 length 是**不可枚举**自有属性，
      // 展开（{...arr}）时不会复制过来 —— 真机实测该对象**没有 length**。
      // 只能按下标键还原。
      const indexKeys = Object.keys(result).filter((k) => /^\d+$/.test(k));
      if (indexKeys.length > 0) {
        return indexKeys
          .map((k) => Number(k))
          .sort((a, b) => a - b)
          .map((i) => result[i]);
      }
    }
    return [];
  };
  const getLorebookEntriesCompat = async (target) => {
    try {
      // 优先复用 legacy 段注册的 getWorldbookEntries：它走 legacy requestParent
      // （直接 resolve data.result），真机实测同参数能拿到 19 条真条目。
      // 本段 v2 requestParent 对数组结果的包装（{ok:true, ...arr}）会吃掉数组。
      if (typeof window.getWorldbookEntries === 'function') {
        const viaLegacy = normalizeCompatEntries(await window.getWorldbookEntries(target));
        if (viaLegacy.length > 0) return viaLegacy;
      }
      return normalizeCompatEntries(await requestParent('getWorldbookEntries', { target }));
    } catch (e) {
      // 必须给数组：真机 zn() 直接 for...of 它，给 undefined 会再炸一层。
      post({ type: 'log', level: 'warn', message: 'getLorebookEntries 失败，返回空数组' });
      return [];
    }
  };
  ensureFunction('getCharLorebooks', getCharLorebooksCompat);
  ensureFunction('getCurrentCharPrimaryLorebook', getCurrentCharPrimaryLorebookCompat);
  ensureFunction('getLorebookSettings', getLorebookSettingsCompat);
  ensureFunction('setLorebookSettings', setLorebookSettingsCompat);
  ensureFunction('getLorebookEntries', getLorebookEntriesCompat);
  // <<< S1-G10 LOREBOOK FAMILY END
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
    const rawSourceCompat = String(source || '').trim();
    const hadLeadingSlashCompat = rawSourceCompat.charAt(0) === '/';
    const text = rawSourceCompat.replace(/^\\/+/, '');
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
    // [包B B-1 2026-10-18] 'add' 已从本组移除：ST 1.18 的 /add 是**数值求和**
    // （variables.js:addValuesCallback），不是"追加一条消息"。留在本地分支会让
    // 卡脚本里最常见的 /add 10 20 恒返回一条消息对象而不是 30。
    // append / insert / create 是 Palink 自有的消息追加别名，保留。
    if (['append', 'insert', 'create'].includes(lowerName)) {
      return addOneMessageCompat({ role: 'assistant', name: ctx.characterName, content: args });
    }
    // [包B B-1 2026-10-18] 本地未命中 → 桥到宿主，不再直接返回空串。
    //
    // 此前这里 return ''：帧内只有上面这十几个硬编码分支，其余命令（/echo /abs /let /if
    // /while /times 以及宿主引擎的 75 条内置命令）在卡脚本里**一律拿到空串**。
    // 宿主落点即 SmartCardCompatController 的 runPalinkSlash：
    //   命中 Palink 九条专有命令 → 返回其结果；未命中 → 回落宿主 executeSlashCommandCompat
    //   → SlashCommandEngine.execute（与沙箱轨 / getContext 轨同一份实现）。
    //
    // 只在原文带前导斜杠时桥接：executeSlashCommandsOnChatInput 会用本函数处理普通聊天
    // 输入（无斜杠），那条热路径必须留在本地，否则每次发消息都多一次 RPC。
    if (!hadLeadingSlashCompat) return '';
    try {
      const bridged = await requestParent('runPalinkSlash', { command: '/' + text });
      if (!bridged || bridged.success === false) return '';
      const bridgedResult = typeof bridged.result === 'string' ? bridged.result : '';
      // 引擎对未知命令返回 "Error: Unknown command: /x"（execute 的 catch 分支把它当 output）。
      // 对卡脚本来说"没这条命令"应当等价于空串，否则卡里的 if(!result) 判定会被带偏。
      if (bridgedResult.indexOf('Error: Unknown command') === 0) return '';
      return bridgedResult;
    } catch (e) {
      post({ type: 'log', level: 'warn', message: 'slash 桥接失败：' + String(e && e.message || e) });
      return '';
    }
  };
  window.SlashCommandParser = window.SlashCommandParser && typeof window.SlashCommandParser === 'object'
    ? window.SlashCommandParser
    : {};
  window.SlashCommandParser.addCommandObject = (commandObject) => registerSlashCommandCompat(commandObject);
  window.SlashCommandParser.addCommand = (name, callback, aliases, helpString, interrupt, purgeFromMessage) => (
    registerSlashCommandCompat(name, callback, aliases, helpString, interrupt, purgeFromMessage)
  );
  // [包B B-1 2026-10-18] 帧内 commands 视图只有"插件注册过的"那几条（真机实测 7 条），
  // 宿主引擎里那 100+ 条命令对三方代码**不可见**：
  //   if (SlashCommandParser.commands['echo']) ...  ⇒ 恒假 ⇒ 走"不支持"降级分支。
  // 这里补一层懒代理：宿主引擎实际注册了哪些命令，从 /help 的返回里取（那是引擎
  // getAllCommands 的权威输出，不是我们自己维护的名单，避免"名单说有、实际调不到"）。
  // 取到之前枚举偏少、取到之后完整；名字对应的 entry 是**真能执行的**合成项，
  // callback 直接桥到宿主（executeSlashCommandCompat 未命中分支 → runPalinkSlash）。
  const slashKnownNamesCompat = new Set();
  const synthesizeSlashEntryCompat = (name) => ({
    name,
    aliases: [],
    helpString: '',
    callback: (args) => executeSlashCommandCompat('/' + name + (args ? ' ' + args : '')),
  });
  const resolveSlashEntryCompat = (name) => {
    const existing = slashCommandStoreCompat.get(name);
    if (existing) return existing;
    return slashKnownNamesCompat.has(name) ? synthesizeSlashEntryCompat(name) : undefined;
  };
  const primeSlashKnownNamesCompat = async () => {
    try {
      const response = await requestParent('runPalinkSlash', { command: '/help' });
      const text = response && typeof response.result === 'string' ? response.result : '';
      const namePattern = new RegExp('^/([A-Za-z0-9:_-]+) ', 'gm');
      let matched = namePattern.exec(text);
      while (matched) {
        slashKnownNamesCompat.add(matched[1]);
        matched = namePattern.exec(text);
      }
      window.__palinkSlashKnownNames = Array.from(slashKnownNamesCompat);
    } catch (e) {
      // 拿不到就保持"只有插件注册项"，不影响既有行为
    }
  };
  // [包B B-1 2026-10-18] SlashCommandParser.commands 必须是 ST 形状的普通对象视图。
  //
  // 此前直接赋 Map（slashCommandStoreCompat）。ST 1.18 里 commands 是普通对象，三方代码
  // 惯用 commands['echo'] / Object.keys(commands) / 'echo' in commands —— 这三种在 Map 上
  // 全部失效（Map 的键不在 Object.keys 里，属性访问也拿不到值）。
  // 真机探针也因此把"已有 7 条命令"误读成"0 条"（Map 上 Object.keys 恒为 []）。
  //
  // 这里用 Proxy 做双面视图：Map 的 get/has/set/delete/keys/entries/values/forEach/size
  // 继续可用（帧内既有调用点走 slashCommandStoreCompat 本体，不受影响），
  // 同时让 [name] 取值、Object.keys 枚举、in 判定、for...in 全部按对象语义工作。
  const slashCommandViewCompat = new Proxy(slashCommandStoreCompat, {
    get(target, prop) {
      if (prop === 'size') return target.size;
      if (prop === Symbol.iterator) return target[Symbol.iterator].bind(target);
      if (
        prop === 'get' || prop === 'has' || prop === 'set' || prop === 'delete' || prop === 'clear'
        || prop === 'keys' || prop === 'values' || prop === 'entries' || prop === 'forEach'
      ) {
        const method = target[prop];
        return typeof method === 'function' ? method.bind(target) : method;
      }
      if (typeof prop === 'string') return resolveSlashEntryCompat(prop);
      return undefined;
    },
    has(target, prop) {
      if (typeof prop !== 'string') return false;
      return target.has(prop) || slashKnownNamesCompat.has(prop);
    },
    set(target, prop, value) {
      if (typeof prop !== 'string') return true;
      target.set(prop, value);
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop !== 'string') return true;
      return target.delete(prop);
    },
    ownKeys(target) {
      return Array.from(new Set([...target.keys(), ...slashKnownNamesCompat]));
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== 'string') return undefined;
      const entry = resolveSlashEntryCompat(prop);
      if (!entry) return undefined;
      return { value: entry, writable: true, enumerable: true, configurable: true };
    },
  });
  window.SlashCommandParser.commands = slashCommandViewCompat;
  primeSlashKnownNamesCompat();
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
  // [S3-ACCEPTANCE-GAP] ST 1.12+ 标准注册方式 SlashCommand(Argument|NamedArgument).fromProps(props)。
  // 此前三个桩均无该静态方法 ⇒ 5 插件 29+20+28 处调用全部 TypeError（2026-10-14 补测定位）。
  // registerSlashCommandCompat 只消费 name/callback/aliases，构造透传的形状即够用。
  if (typeof window.SlashCommand.fromProps !== 'function') {
    window.SlashCommand.fromProps = function fromProps(props = {}) { return new window.SlashCommand(props); };
  }
  if (typeof window.SlashCommandArgument.fromProps !== 'function') {
    window.SlashCommandArgument.fromProps = function fromProps(props = {}) { return new window.SlashCommandArgument(props); };
  }
  if (typeof window.SlashCommandNamedArgument.fromProps !== 'function') {
    window.SlashCommandNamedArgument.fromProps = function fromProps(props = {}) { return new window.SlashCommandNamedArgument(props); };
  }

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
`;
