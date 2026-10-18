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

  // >>> H-TH134 FAMILY BEGIN
  // [包H 2026-10-18] TavernHelper 134 权威键广度补齐（分类全表与理由见
  // docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md §3）。
  //
  // 语义来源是**酒馆助手运行时源码本体**，不是自发明：
  //   st-plugins/third-party/JS-Slash-Runner-main/src/function/variables.ts   变量族（作用域派发 :56-94）
  //   .../src/function/{lorebook,worldbook,lorebook_entry}.ts                 lorebook 与 worldbook 同物（worldbook.ts:1-7 直接 import lorebook 的函数）
  //   .../src/function/chat_message.ts                                        set/create/delete 三个消息写族
  //   .../src/function/{character,raw_character}.ts                           角色只读族
  //   .../src/function/{global,util,version}.ts                               initializeGlobal / errorCatched / 版本号
  //
  // 三条硬规矩（本区域逐条守）：
  //  1) 宿主能力只走**已存在**的 requestParent 动作与帧内已注册的真实现，不新造父侧通道；
  //  2) 没有真实现支撑的键（预设 / persona / 音频 / 扩展安装 / 角色库写侧 / 删书 / 正则对象模型 /
  //     inject / rotateChatMessages / importRaw* / getModelList / 脚本按钮）**不在这里出现** ——
  //     proxy 的 has() 会如实报缺，好过注册一个恒真的假成功；
  //  3) 桥接一律**调用时**再取 window 上的实现：本段之后 part-08 才注册 triggerSlash 等全局。
  const th134Warn = (message) => {
    post({ type: 'log', level: 'warn', message: 'TavernHelper: ' + String(message) });
  };
  const th134GlobalFn = (name) => (typeof window[name] === 'function' ? window[name] : null);
  const th134Bridge = (name) => (...args) => {
    const fn = th134GlobalFn(name);
    if (!fn) {
      th134Warn(name + ' 依赖的帧内实现 ' + String(name) + ' 未注册，返回 undefined（不造值）');
      return undefined;
    }
    return fn.apply(window, args);
  };

  // ---- 变量族：ST 用 option.type 决定落到哪张表（variables.ts:56-94）。
  // Palink 帧内只有 chat / global / local 三张真表；preset / message / extension / character
  // 四个作用域在帧内没有对应存储 ⇒ **诚实抛错**。静默返回空表更坏：MVU 这类卡会把"读不到"
  // 当成"变量不存在"，然后把自己的初始值写进去覆盖真数据。
  const th134VarStore = (option) => {
    const type = String((option && option.type) || 'chat');
    if (type === 'chat') return chatVariableStore;
    if (type === 'global') return globalVariableStore;
    if (type === 'local') return localVariableStore;
    throw new Error('TavernHelper 不支持变量作用域 type=' + type + '（Palink 帧内只有 chat/global/local 三张表）');
  };
  const th134JsonClone = (value) => {
    try { return JSON.parse(JSON.stringify(value === undefined ? {} : value)); }
    catch (error) { return {}; }
  };
  const th134IsPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  // 对齐 lodash mergeWith(old, new, (lhs, rhs) => _.isArray(rhs) ? rhs : undefined)：
  // 对象深合并、**数组整体替换**（variables.ts:246）。keepExisting = true 时源值不得覆盖已有键，
  // 用于"只在缺口上生效"的语义；当前两个变量写入函数都把源顺序摆好后统一用 false（见 :th134Insert*）。
  const th134DeepMerge = (target, source, keepExisting) => {
    if (!th134IsPlainObject(source)) return target;
    Object.keys(source).forEach((key) => {
      const nextValue = source[key];
      const currentValue = target[key];
      if (th134IsPlainObject(nextValue) && th134IsPlainObject(currentValue)) {
        th134DeepMerge(currentValue, nextValue, keepExisting);
        return;
      }
      if (keepExisting && currentValue !== undefined) return;
      target[key] = Array.isArray(nextValue) ? nextValue.slice() : nextValue;
    });
    return target;
  };
  const th134GetVariables = (option) => th134JsonClone(th134VarStore(option));
  const th134ReplaceVariables = (variables, option) => {
    const store = th134VarStore(option);
    Object.keys(store).forEach((key) => { delete store[key]; });
    th134DeepMerge(store, th134JsonClone(variables), false);
    persistVariableStores();
    if (store === chatVariableStore && typeof emitCompatEvent === 'function') {
      // 与同帧 setVariable(:870-875) 同一条事件口径 —— 露缇雅「变量变化」面板靠它，不能少发。
      emitCompatEvent('CHAT_VARIABLES_UPDATED', chatVariableStore);
    }
  };
  const th134UpdateVariablesWith = (updater, option) => {
    const variables = th134GetVariables(option);
    const result = typeof updater === 'function' ? updater(variables) : variables;
    if (result && typeof result.then === 'function') {
      return result.then((resolved) => {
        th134ReplaceVariables(resolved, option);
        return th134JsonClone(resolved);
      });
    }
    th134ReplaceVariables(result, option);
    return th134JsonClone(result);
  };
  // insertOrAssign = mergeWith(old, new, ...) ⇒ 新值覆盖，对象深合并、数组整体替换。
  // insert      = mergeWith({}, new, old, ...) ⇒ old 作为**后到的源**覆盖同名叶子，
  //   净效果正是"传入值只在新键上生效、已有键保持原值"（variables.ts:261-269）。
  //   注意别把这里的源顺序想反：写成 new 后置会得到"新值赢"，那就是 assign 了。
  const th134InsertOrAssignVariables = (variables, option) => th134UpdateVariablesWith(
    (oldVariables) => th134DeepMerge(oldVariables, th134JsonClone(variables), false),
    option,
  );
  const th134InsertVariables = (variables, option) => th134UpdateVariablesWith(
    (oldVariables) => th134DeepMerge(th134JsonClone(variables), oldVariables, false),
    option,
  );
  // ST 的返回形状是 { variables, delete_occurred }（variables.ts:281-291），不是布尔。
  const th134DeleteVariable = (path, option) => {
    let deleteOccurred = false;
    const variables = th134UpdateVariablesWith((oldVariables) => {
      deleteOccurred = Boolean(typeof deleteByPath === 'function' ? deleteByPath(oldVariables, path) : false);
      return oldVariables;
    }, option);
    return { variables: variables, delete_occurred: deleteOccurred };
  };

  // ---- lorebook / worldbook 族：ST 源码里两者是同一个东西（worldbook.ts 顶部直接
  // import getCharLorebooks/getChatLorebook/setChatLorebook 并逐条转发），所以这里的
  // "别名"是**上游本来的别名**，不是本包造的映射。
  const th134BookNames = () => {
    const fn = th134GlobalFn('getWorldbookNames');
    const list = fn ? fn.apply(window, []) : [];
    return Array.isArray(list) ? list.slice() : [];
  };
  const th134EntriesOf = async (target) => {
    const getter = th134GlobalFn('getLorebookEntries') || th134GlobalFn('getWorldbookEntries');
    if (!getter) throw new Error('TavernHelper: 帧内 getLorebookEntries 未注册，无法读世界书条目');
    const raw = await getter.apply(window, [target]);
    return Array.isArray(raw) ? raw : [];
  };
  const th134WriteEntries = async (target, entries, options) => {
    const setter = th134GlobalFn('setWorldbookEntries');
    if (!setter) throw new Error('TavernHelper: 帧内 setWorldbookEntries 未注册，无法写世界书条目');
    return setter.apply(window, [target, Array.isArray(entries) ? entries : [], options || {}]);
  };
  // 上游 updateWorldbookWith 的形状：replace(name, await updater(await getWorldbook(name)))
  // 然后回读一遍返回（worldbook.ts:432-439）。
  const th134UpdateEntriesWith = async (target, updater, options) => {
    const current = await th134EntriesOf(target);
    const next = typeof updater === 'function' ? await updater(current) : current;
    await th134WriteEntries(target, next, options);
    return await th134EntriesOf(target);
  };
  const th134ReplaceWorldbook = async (target, entries, options) => {
    if (th134BookNames().indexOf(String(target)) < 0) {
      const create = th134GlobalFn('createOrReplaceWorldbook');
      if (!create) throw new Error('TavernHelper: 帧内 createOrReplaceWorldbook 未注册');
      await create.apply(window, [String(target), Array.isArray(entries) ? entries : [], options || {}]);
      return;
    }
    await th134WriteEntries(target, entries, options);
  };
  const th134GetChatWorldbookName = () => {
    // ST 语义：聊天文件绑定的书，没绑定时返回 null（lorebook.ts:310-322 会顺手清掉脏 metadata）。
    // Palink 的书绑在角色 + 会话上，帧内可读的真值就是当前主绑定名。
    const fn = th134GlobalFn('getCurrentCharPrimaryLorebook');
    const value = fn ? fn.apply(window, []) : '';
    return value ? String(value) : null;
  };
  // 上游 getOrCreateChatLorebook：已绑定就回名；没绑定就用传入名（重名则抛错）或
  // 'Chat Book <chatId>' 归一化出来的名字建一本新书再绑（lorebook.ts:339-362）。
  const th134GetOrCreateChatWorldbook = async (worldbookName) => {
    const existing = th134GetChatWorldbookName();
    if (existing) return existing;
    const names = th134BookNames();
    let wanted = '';
    if (worldbookName) {
      if (names.indexOf(String(worldbookName)) >= 0) {
        throw new Error("TavernHelper: 尝试创建聊天世界书, 但该名称 '" + String(worldbookName) + "' 已存在");
      }
      wanted = String(worldbookName);
    } else {
      wanted = ('Chat Book ' + String(ctx.sessionId || ctx.characterName || 'palink'))
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g, '_')
        .substring(0, 64);
    }
    const create = th134GlobalFn('createWorldbook');
    if (!create) throw new Error('TavernHelper: 帧内 createWorldbook 未注册');
    await create.apply(window, [wanted, []]);
    const rebind = th134GlobalFn('rebindChatWorldbook');
    if (rebind) await rebind.apply(window, ['current', wanted]);
    else th134Warn('createWorldbook 成功但帧内 rebindChatWorldbook 不可用，聊天绑定未写入');
    return wanted;
  };

  // ---- 角色只读族：数据来自 getContext().characters（构建期真内联，非帧内造）与 ctx。
  // 写侧（create/delete/replace/update/importRawCharacter）一律不做：Palink 角色模型不同，
  // 且本包边界禁止新增父侧动作。
  const th134CharacterList = () => {
    try {
      const c = typeof window.getContext === 'function' ? window.getContext() : null;
      return c && Array.isArray(c.characters) ? c.characters : [];
    } catch (error) {
      return [];
    }
  };
  const th134AvatarBaseName = (value) => {
    // 不用正则：本段是模板字符串，反斜杠会被外层吃掉（段首约束第 1 条），纯字符串操作最稳。
    const text = String(value || '');
    const slash = text.lastIndexOf('/');
    const dot = text.lastIndexOf('.');
    return dot > slash ? text.slice(0, dot) : text;
  };
  const th134FindCharacter = (name) => {
    const list = th134CharacterList();
    const currentName = String(ctx.characterName || '');
    if (!name || name === 'current') {
      const byName = list.filter((item) => String((item && item.name) || '') === currentName);
      if (byName.length > 0) return byName[0];
      const byIndex = Number(ctx.characterIndex);
      return Number.isFinite(byIndex) && byIndex >= 0 ? (list[byIndex] || null) : (list[0] || null);
    }
    const wanted = String(name);
    const hit = list.filter((item) => [item && item.name, item && item.avatar, th134AvatarBaseName(item && item.avatar)]
      .filter(Boolean)
      .some((value) => String(value) === wanted));
    return hit.length > 0 ? hit[0] : null;
  };

  // ---- displayed_message 族：messageFormattingCompat 在本段之前已声明（part-03:719）。
  const th134FormatAsDisplayedMessage = (text, option) => {
    const messageId = option && option.message_id !== undefined ? Number(option.message_id) : ctx.messageId;
    const lastId = typeof window.getLastMessageId === 'function' ? Number(window.getLastMessageId()) : -1;
    if (Number.isFinite(messageId) && messageId >= 0 && lastId >= 0 && messageId > lastId) {
      // ST 在楼层越界时抛错（displayed_message.d.ts:40 @throws），不返回空串。
      throw new Error('TavernHelper: formatAsDisplayedMessage 的 message_id ' + messageId + ' 超出 [0, ' + lastId + ']');
    }
    const formatter = th134GlobalFn('messageFormatting');
    if (formatter) return String(formatter.apply(window, [String(text ?? ''), ctx.characterName, false, false, messageId]));
    return String(text ?? '');
  };

  // ---- global 族：上游就是 window[name] = value + 发一条 global_<name>_initialized
  // （global.ts:8-25）。帧内 eventSource 是真实事件总线（part-07:845 的 eventOn 用的就是它）。
  const th134InitializeGlobal = (name, value) => {
    const key = String(name || '');
    if (!key) throw new Error('TavernHelper: initializeGlobal 需要全局名');
    window[key] = value;
    if (window.eventSource && typeof window.eventSource.emit === 'function') {
      window.eventSource.emit('global_' + key + '_initialized');
    }
  };
  const th134WaitGlobalInitialized = (name) => {
    const key = String(name || '');
    if (!key) return Promise.reject(new Error('TavernHelper: waitGlobalInitialized 需要全局名'));
    if (window[key] !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      if (window.eventSource && typeof window.eventSource.once === 'function') {
        window.eventSource.once('global_' + key + '_initialized', () => { resolve(); });
        return;
      }
      resolve();
    });
  };

  // ---- util 族：errorCatched 是"上报后继续抛"（util.ts:17-42），不是吞异常。
  const th134ErrorCatched = (fn) => (...args) => {
    const report = (error) => {
      th134Warn('errorCatched: ' + String((error && error.message) || error));
      throw error;
    };
    try {
      const result = typeof fn === 'function' ? fn.apply(null, args) : undefined;
      if (result && typeof result.then === 'function') return result.then(undefined, report);
      return result;
    } catch (error) {
      return report(error);
    }
  };
  // ST 的 getMessageId 只是对 'TH-message--<id>--<n>' 这个 iframe 名做正则（util.ts:109-115），
  // 名不对就抛 —— 逐字移植，不"顺手放宽"成"读当前 ctx.messageId"。
  // 反斜杠走 regexBackslashCompat（段首约束第 1 条：模板串里的裸反斜杠会被外层吃掉）。
  const th134MessageFramePattern = new RegExp(
    '^TH-message--(' + regexBackslashCompat + 'd+)--' + regexBackslashCompat + 'd+(_' + regexBackslashCompat + 'd+)?$',
  );
  const th134GetMessageId = (iframeName) => {
    const matched = th134MessageFramePattern.exec(String(iframeName || ''));
    if (!matched) {
      throw new Error('TavernHelper: 获取 ' + String(iframeName) + ' 所在楼层 id 时出错: 不要对全局脚本 iframe 调用 getMessageId!');
    }
    return parseInt(matched[1], 10);
  };

  // ---- chat_message 写族：content 走真写路径（帧内 setChatMessage → requestParent setChatMessage，
  // 签名 (content, messageId, options) 见 part-05:557 / part-06:870）。
  // name / is_hidden / extra / variables 父侧没有写通道 ⇒ 只更新帧内镜像 compatChat，
  // 并**显式 warn**（沿用同帧 getCharLorebooks 按名查询的处理口径），不假装写成功了。
  const th134MessageIndex = (messageId) => {
    const list = Array.isArray(compatChat) ? compatChat : [];
    const numeric = Number(messageId);
    if (!Number.isFinite(numeric)) return -1;
    const index = numeric < 0 ? list.length + numeric : numeric;
    return index >= 0 && index < list.length ? index : -1;
  };
  const th134SetChatMessages = async (messages, option) => {
    const list = Array.isArray(messages) ? messages : [];
    const setter = th134GlobalFn('setChatMessage');
    if (!setter) throw new Error('TavernHelper: 帧内 setChatMessage 未注册');
    let mirrorOnlyCount = 0;
    for (const item of list) {
      const index = th134MessageIndex(item && item.message_id);
      if (index < 0) continue;
      const target = compatChat[index];
      if (item.message !== undefined && target) {
        target.mes = String(item.message ?? '');
        await setter.apply(window, [String(item.message ?? ''), index, {}]);
      }
      const mirrorFields = ['name', 'role', 'is_hidden', 'extra', 'data', 'swipe_id', 'swipes', 'swipes_data', 'swipes_info'];
      const touched = mirrorFields.filter((field) => item && item[field] !== undefined);
      if (touched.length > 0 && target) {
        touched.forEach((field) => { target[field] = item[field]; });
        if (item.is_hidden !== undefined) target.is_system = Boolean(item.is_hidden);
        if (item.role !== undefined) target.is_user = item.role === 'user';
        mirrorOnlyCount += 1;
      }
    }
    if (mirrorOnlyCount > 0) {
      th134Warn('setChatMessages 有 ' + mirrorOnlyCount + ' 楼只更新了帧内镜像（父侧无 name/extra/variables 写通道）');
    }
    if (option && option.refresh === 'all') th134Bridge('reloadCurrentChat')();
  };
  const th134CreateChatMessages = async (messages, option) => {
    const list = Array.isArray(messages) ? messages : [];
    const insertBefore = option && option.insert_at !== undefined ? option.insert_at : (option && option.insert_before !== undefined ? option.insert_before : 'end');
    if (insertBefore !== 'end') {
      // 上游是 chat.splice + addOneMessage({insertBefore})；Palink 帧内 addOneMessage 只有追加语义，
      // 插到中间会造成镜像与父侧顺序不一致 ⇒ 抛错而不是悄悄放到末尾。
      throw new Error('TavernHelper: createChatMessages 暂不支持在指定楼层插入（帧内 addOneMessage 只能追加）');
    }
    const adder = th134GlobalFn('addOneMessage');
    if (!adder) throw new Error('TavernHelper: 帧内 addOneMessage 未注册');
    for (const item of list) {
      const role = String((item && item.role) || 'assistant');
      // 上游 convert()：显式 name 优先，否则 system 用 'system'、user 用 name1、其余用 name2
      // （chat_message.ts:325-332）。
      const fallbackName = role === 'system'
        ? 'system'
        : (role === 'user' ? String(ctx.userName || 'You') : String(ctx.characterName || 'Character'));
      const payload = {
        mes: String((item && item.message) ?? ''),
        name: (item && item.name) !== undefined ? String(item.name) : fallbackName,
        is_user: role === 'user',
        is_system: Boolean(item && item.is_hidden),
      };
      if (item && item.extra) payload.extra = item.extra;
      if (item && item.data) payload.variables = [item.data];
      await adder.apply(window, [payload, {}]);
    }
    if (option && option.refresh === 'all') th134Bridge('reloadCurrentChat')();
  };
  const th134DeleteChatMessages = async (messageIds) => {
    const deleter = th134GlobalFn('deleteMessage');
    if (!deleter) throw new Error('TavernHelper: 帧内 deleteMessage 未注册');
    const ids = (Array.isArray(messageIds) ? messageIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a);
    for (const id of ids) {
      if (th134MessageIndex(id) < 0) continue;
      await deleter.apply(window, [id, {}]);
    }
  };

  const tavernHelperTh134Compat = {
    // 变量族（写体，ST 的 option.type 语义；getVariables / replaceVariables 两个 A 类键不动，
    // 它们既有实现是 Palink 已上线口径，改它属回归风险，只写进报告 §7 不当场改）
    updateVariablesWith: th134UpdateVariablesWith,
    insertOrAssignVariables: th134InsertOrAssignVariables,
    insertVariables: th134InsertVariables,
    deleteVariable: th134DeleteVariable,
    // 世界书 / lorebook 族
    getWorldbookNames: th134Bridge('getWorldbookNames'),
    getGlobalWorldbookNames: th134Bridge('getGlobalWorldbookNames'),
    rebindGlobalWorldbooks: th134Bridge('rebindGlobalWorldbooks'),
    replaceWorldbook: th134ReplaceWorldbook,
    updateWorldbookWith: th134UpdateEntriesWith,
    getLorebooks: th134BookNames,
    getLorebookEntries: th134Bridge('getLorebookEntries'),
    getLorebookSettings: th134Bridge('getLorebookSettings'),
    setLorebookSettings: th134Bridge('setLorebookSettings'),
    getCharLorebooks: th134Bridge('getCharLorebooks'),
    getCurrentCharPrimaryLorebook: th134Bridge('getCurrentCharPrimaryLorebook'),
    createLorebook: th134Bridge('createWorldbook'),
    createLorebookEntries: th134Bridge('createWorldbookEntries'),
    deleteLorebookEntries: th134Bridge('deleteWorldbookEntries'),
    setLorebookEntries: (target, entries, options) => th134WriteEntries(target, entries, options),
    replaceLorebookEntries: (target, entries, options) => th134WriteEntries(target, entries, options),
    updatelorebookEntriesWith: th134UpdateEntriesWith,
    getChatWorldbookName: () => th134GetChatWorldbookName(),
    getOrCreateChatWorldbook: th134GetOrCreateChatWorldbook,
    getOrCreateChatLorebook: th134GetOrCreateChatWorldbook,
    // 角色只读族
    getCurrentCharacterName: () => (ctx.characterName ? String(ctx.characterName) : null),
    getCurrentCharacterId: () => {
      const found = th134FindCharacter('current');
      const avatar = found && found.avatar ? th134AvatarBaseName(found.avatar) : '';
      const fallback = ctx.characterId ? String(ctx.characterId) : '';
      return avatar || fallback || null;
    },
    getCharacterNames: () => th134CharacterList().map((item) => String((item && item.name) || '')).filter(Boolean),
    getCharacterIds: () => th134CharacterList().map((item) => th134AvatarBaseName(item && item.avatar)).filter(Boolean),
    getCharData: (name) => {
      const found = th134FindCharacter(name === undefined ? 'current' : name);
      if (!found) return null;
      return found.data && typeof found.data === 'object' ? found.data : found;
    },
    getCharAvatarPath: (name) => {
      const found = th134FindCharacter(name === undefined ? 'current' : name);
      return found && found.avatar ? String(found.avatar) : '';
    },
    getCharacter: async (name) => {
      const found = th134FindCharacter(name === undefined ? 'current' : name);
      if (!found) throw new Error("TavernHelper: 未找到角色卡 '" + String(name) + "'");
      return found;
    },
    // displayed_message / util / global
    formatAsDisplayedMessage: th134FormatAsDisplayedMessage,
    refreshOneMessage: async () => {
      // 帧内没有"重刷单楼显示"的通道，能落到的真能力是整卡重载（父侧 reloadCurrentChat）。
      th134Warn('refreshOneMessage 落到整会话重载（Palink 帧内无单楼重绘通道）');
      const reload = th134GlobalFn('reloadCurrentChat');
      if (reload) await reload.apply(window, []);
    },
    getMessageId: th134GetMessageId,
    errorCatched: th134ErrorCatched,
    initializeGlobal: th134InitializeGlobal,
    waitGlobalInitialized: th134WaitGlobalInitialized,
    getTavernVersion: th134Bridge('getTavernVersion'),
    getTavernHelperVersion: th134Bridge('getTavernHelperVersion'),
    // substitudeMacros（util.ts:9 = substituteParamsExtended）：优先扩展宏，
    // 回落到同帧既有 substituteParams，两者都没有时不造值（warn + 原样返回，可被调用方察觉）。
    substitudeMacros: (text) => {
      const extended = th134GlobalFn('substituteParamsExtended') || th134GlobalFn('substituteParams');
      if (!extended) {
        th134Warn('substitudeMacros 无宏替换实现可用，原样返回（不静默返回空串）');
        return String(text ?? '');
      }
      return String(extended.apply(window, [String(text ?? '')]));
    },
    triggerSlash: th134Bridge('triggerSlash'),
    stopAllGeneration: () => requestParent('stopGeneration', {}),
    // chat_message 写族
    setChatMessages: th134SetChatMessages,
    createChatMessages: th134CreateChatMessages,
    deleteChatMessages: th134DeleteChatMessages,
  };
  // <<< H-TH134 FAMILY END

  const tavernHelperCompat = {
    // [包H] 上面那张 134 补齐表先展开：与下面既有键同名时**既有键胜出**（A 类不动，
    // 零回归优先）。proxy 的 has() 走的是 prop in tavernHelperCompat，展开即生效。
    ...tavernHelperTh134Compat,
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
    // [包F F-1 2026-10-18] 枚举口径修复。
    //
    // 此前 known names 只由 /help 的返回文本解析而来 ⇒ 集合上限 = 宿主引擎真注册了的命令，
    // 与 ST 1.18 的权威名单（静态抽取 293 条）对不上：三方卡脚本 / ST 插件用
    // 'x' in SlashCommandParser.commands、Object.keys(commands)、for...in
    // 做能力探测或命令补全时，看到的比 ST 少 200 多条。
    //
    // 现在先向宿主取**权威名单**（名单常量在宿主侧 lib/slash-engine/st-command-catalog.ts，
    // 帧内只多一段请求 ⇒ 不把 293 个字面量写进模板串，srcdoc 体积红线不破），
    // 再接住 /help 的解析结果补上 Palink 自有、ST 没有的名字。
    //
    // 语义不变的部分：这里只放开「存在性 / 枚举」，get 仍走 resolveSlashEntryCompat，
    // 宿主没实现的名单项拿到的是合成 entry，执行时照旧得到引擎的 Unknown command
    // （executeSlashCommandCompat 会把它折成空串）—— 不是假成功（红线 1）。
    try {
      const seedResponse = await requestParent('getStCompatCommandNames', {});
      const seedNames = seedResponse && Array.isArray(seedResponse.names) ? seedResponse.names : [];
      for (const seedName of seedNames) {
        if (typeof seedName === 'string' && seedName) slashKnownNamesCompat.add(seedName);
      }
      window.__palinkSlashSeedNamesCount = seedNames.length;
      window.__palinkSlashKnownNames = Array.from(slashKnownNamesCompat);
    } catch (e) {
      // 取不到名单就退回 /help 口径（等同修复前），不影响既有行为
    }
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
      // [包F F-1 2026-10-18] has() 与 in 判定口径对齐：两者都算上权威名单种子里
      // "宿主还没实现"的名字（in 走下面的 has 陷阱，这里别再退回裸 Map）。
      // get/keys/values 等仍走 Map 本体 —— keys() 返回的是 Map 原型语义，
      // 三方与探针的取键口径一律是 Object.keys(commands)（见 fixtures/README.md）。
      if (prop === 'has') {
        return (name) => target.has(name) || slashKnownNamesCompat.has(String(name));
      }
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
