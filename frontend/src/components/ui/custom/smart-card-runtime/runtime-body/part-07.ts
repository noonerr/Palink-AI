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
      // ⚠️ [包L 2026-10-18] 本段在模板字符串里，想让 iframe 看到「反斜杠 + d」必须**成对写两个
      // 反斜杠**：原先只写了一个，模板求值会把反斜杠吞掉，生产产物退化成「只匹配字母 d」的
      // 正则 ⇒ 这个还原分支在线上永不命中。旧测试读的是未求值源码文本，所以本地一直绿。
      const indexKeys = Object.keys(result).filter((k) => /^\\d+$/.test(k));
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
  //  2) 没有真实现支撑的键（预设写侧与类型判定 / 音频 / 扩展**安装**（install /
  //     uninstall / reinstall / update 四键，批次R2 才做）/ 角色库删除以外的写侧 /
  //     删书 / 正则对象模型 / inject / rotateChatMessages / importRaw* / getModelList /
  //     脚本按钮）**不在这里出现** —— proxy 的 has() 会如实报缺，好过注册一个恒真的假成功；
  //     [批次P2 2026-10-21] 预设族里**读类 3 键**（getPresetNames / getLoadedPresetName /
  //     getPreset）已落地，剩下的写类 9 键与 builtin/default_preset/importRawPreset
  //     仍不注册。
  //     [批次TH2 2026-10-26] 旧注释里"本仓预设行没有 marker/system_prompt/
  //     injection_position 这些判定字段，补了只能恒 false"这条**理由已被推翻**：
  //     TH 一手是纯 id 归属判定（preset.ts:107-124），根本不需要那些字段。
  //     ⇒ isPreset* 三键与 getProxyPresetNames 已按用户裁定 D→C 真落地（见下）。
  //     [批次R1 2026-10-21] 扩展族里**读类 5 键**（getExtensionStatus / getExtensionType /
  //     getTavernHelperExtensionId / isInstalledExtension / isAdmin）已落地；安装/卸载/
  //     重装/更新四键**继续不注册**（R2，且必须逐次用户确认 + 白名单源）。
  //     [批次TH 2026-10-26] 预设**写类 9 键**（loadPreset / createPreset / createOrReplacePreset /
  //     deletePreset / renamePreset / replacePreset / setPreset / updatePresetWith /
  //     importRawPreset）、**音频 8 键**（帧内双队列状态机，零父侧通道）与常量 3 键
  //     （builtin 部分桥 / builtin_prompt_default_order / default_preset）已落地。
  //     [批次TH2 2026-10-26] isPreset* 三键与 getProxyPresetNames 已落地（D→C，
  //     用户点头；判定照抄 preset.ts:107-124 的纯 id 归属，代理名单恒空 + 一次性 diag）。
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

  // ---- displayed_message 族 · retrieveDisplayedMessage：读**主页面**那条消息的真实 DOM。
  // 契约一手（酒馆助手）：st-plugins/third-party/JS-Slash-Runner-main/@types/function/displayed_message.d.ts:21
  //   declare function retrieveDisplayedMessage(message_id: number): JQuery<HTMLDivElement>;
  // 实现一手：.../src/function/displayed_message.ts:87-89
  //   return $( '#chat > .mes[mesid = "<id>"]', window.parent.document ).find( 'div.mes_text' );
  // （d.ts 原文：能取到返回对应 JQuery，否则返回空 JQuery。）
  //
  // Palink 主页面同形：#chat 容器下每楼是 .mes[mesid]（CharacterChat.tsx:1949 的容器 +
  // Message.tsx:1441 起的 mesid 属性），正文容器是 .mes_text（Message.tsx:1653）。
  //
  // 与 ST 的两处**必要偏差**（不许当 bug 修回去）：
  //  1) 父文档入口不是 window.parent.document：未授信帧的 parent 被 PARENT-ALIAS 代理
  //     （frame-shim/legacy-st-sim-parts/part-a.ts:41-165），读到的是模拟控件而非真文档；
  //     同源放开后唯一可信的入口是 window.frameElement.ownerDocument —— opaque origin 时
  //     frameElement 恒为 null（浏览器保证），正好就是"读不到"的判据。
  //  2) 读不到时返回 null（批次Q1 执行件原文），不是 ST 的空 JQuery —— 差异见报告 §8。
  const th134ParentDocument = () => {
    try {
      const frame = window.frameElement;
      if (!frame) return null;
      return frame.ownerDocument || null;
    } catch (error) {
      return null;
    }
  };
  const th134DisplayedWarn = (detail) => {
    th134Warn('retrieveDisplayedMessage ' + detail);
    if (typeof palinkDiagRecord === 'function') {
      palinkDiagRecord({
        owner: 'frame_compat',
        kind: 'missing_api',
        name: 'retrieveDisplayedMessage',
        detail: detail,
      });
    }
  };
  // 帧内 $ 的集合在两条轨上不等价：legacy 轨（part-c）自带 .text/.html/.append，
  // v2 轨（part-05）没有这三个方法，其 nativeFallback 会把 .text() 委托给
  // 「DOM 元素上并不存在的 text 方法」⇒ 静默返回集合本身（形状对语义错）。
  // 故只在缺方法时就地补齐 d.ts 示例用到的那三个，补的是真语义
  // （读写真实节点的 textContent / innerHTML / append），不是另造假对象。
  const th134EnsureDisplayedMethods = (collection) => {
    if (!collection) return collection;
    if (typeof collection.text !== 'function') {
      collection.text = function (value) {
        if (value === undefined) {
          return this.map((node) => String((node && node.textContent) || '')).join('');
        }
        this.forEach((node) => { if (node) node.textContent = String(value); });
        return this;
      };
    }
    if (typeof collection.html !== 'function') {
      collection.html = function (value) {
        if (value === undefined) return this[0] ? String(this[0].innerHTML) : '';
        this.forEach((node) => { if (node) node.innerHTML = String(value); });
        return this;
      };
    }
    if (typeof collection.append !== 'function') {
      collection.append = function (content) {
        this.forEach((node) => {
          if (!node) return;
          if (content && content.nodeType) { node.appendChild(content); return; }
          const holder = (node.ownerDocument || document).createElement('div');
          holder.innerHTML = String(content === undefined || content === null ? '' : content);
          while (holder.firstChild) node.appendChild(holder.firstChild);
        });
        return this;
      };
    }
    return collection;
  };
  const th134RetrieveDisplayedMessage = (messageId) => {
    const id = Number(messageId);
    if (!Number.isFinite(id)) {
      th134DisplayedWarn('需要数字楼层号，收到 ' + String(messageId) + ' ⇒ 返回 null（不造 DOM）');
      return null;
    }
    const parentDoc = th134ParentDocument();
    if (!parentDoc) {
      th134DisplayedWarn('当前帧读不到父文档（未放开同源 ⇒ window.frameElement 为 null）⇒ 返回 null');
      return null;
    }
    const row = parentDoc.querySelector('#chat > .mes[mesid="' + String(id) + '"]');
    if (!row) {
      th134DisplayedWarn('主页面 #chat 下没有 mesid=' + String(id) + ' 的楼层（未渲染或已离屏）⇒ 返回 null');
      return null;
    }
    const textNode = row.querySelector('div.mes_text');
    if (!textNode) {
      th134DisplayedWarn('楼层 mesid=' + String(id) + ' 里没有 div.mes_text ⇒ 返回 null');
      return null;
    }
    const dollar = typeof window.$ === 'function' ? window.$ : null;
    if (!dollar) {
      th134DisplayedWarn('帧内没有 $（jQuery 与 shim 均缺席）⇒ 无法按契约返回 JQuery，返回 null');
      return null;
    }
    return th134EnsureDisplayedMethods(dollar(textNode));
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

  // [批次P3 P3-A 2026-10-21] 预设三键的**同步**快照读取器（三个键共用，见下方三键处注释）。
  // 必须定义在 tavernHelperTh134Compat 对象字面量**之外** —— 对象字面量里不能插语句。
  const readPresetSnapshotCompat = () => {
    const snap = ctx && ctx.presetSnapshot && typeof ctx.presetSnapshot === 'object' ? ctx.presetSnapshot : null;
    if (!snap) {
      th134Warn('预设快照未就绪：getPresetNames/getLoadedPresetName/getPreset 只能返回空值（宿主还没把快照送进帧内）');
      if (typeof palinkDiagRecord === 'function') {
        palinkDiagRecord({
          owner: 'frame_compat',
          kind: 'missing_api',
          name: 'preset_snapshot_not_ready',
          detail: 'ctx.presetSnapshot 缺失，预设三键按同步契约返回空数组/null（不是"没有预设"）',
        });
      }
      return null;
    }
    return snap;
  };

  // [批次R1 2026-10-21] 扩展读面（ST extension.d.ts:2/5/15/40 + index.d.ts:47）。
  //
  // 数据源：宿主带进 ctx 的 extensionCatalog（后端 /api/plugins/runtime/config，
  // 已按登录态 user_id 过滤；管理员额外带 include_disabled=1）。为什么同步键读快照：
  // getExtensionType / isInstalledExtension 在 ST 契约里是**同步**的，而帧内
  // requestParent 是异步的 —— 接线成 async 会让真卡拿到 undefined（批次P3 踩过）。
  // 快照未就绪 ⇒ 读类返回 null/false 并**留痕**，不冒充"未安装"。
  const th134ExtensionList = () => {
    const snap = ctx && ctx.extensionCatalog && typeof ctx.extensionCatalog === 'object' ? ctx.extensionCatalog : null;
    if (!snap) return null;
    return Array.isArray(snap.plugins) ? snap.plugins : [];
  };
  // ST getExtensionType 的匹配口径：extensionTypes 的键 endswith(extension_id)
  // （src/function/extension.ts:11-14）。这里同样做后缀匹配，另加精确匹配。
  const th134ExtensionMatches = (entry, extensionId) => {
    const id = String(extensionId === undefined || extensionId === null ? '' : extensionId);
    if (!id) return false;
    const keys = [entry && entry.extensionId, entry && entry.name, entry && entry.manifestName, entry && entry.id];
    for (let i = 0; i < keys.length; i += 1) {
      const value = keys[i] ? String(keys[i]) : '';
      if (!value) continue;
      if (value === id) return true;
      if (value.length > id.length && value.slice(value.length - id.length) === id) return true;
    }
    return false;
  };
  const th134FindExtensionInList = (list, extensionId) => {
    if (!list) return null;
    for (let i = 0; i < list.length; i += 1) {
      if (th134ExtensionMatches(list[i], extensionId)) return list[i];
    }
    return null;
  };
  const th134GetExtensionType = (extensionId) => {
    const list = th134ExtensionList();
    if (!list) {
      th134Warn('getExtensionType: 宿主扩展目录未就绪，返回 null（不是"未安装"）');
      return null;
    }
    const entry = th134FindExtensionInList(list, extensionId);
    if (!entry) return null;
    const type = String(entry.type || '');
    if (type === 'local' || type === 'global' || type === 'system') return type;
    return null;
  };

  // ---- [批次TH 2026-10-26] 音频播放器 8 键：帧内双队列状态机（bgm / ambient 各一份）。
  //
  // 契约一手：@types/function/audio.d.ts（全部**同步**签名）+ 一手实现
  // st-plugins/third-party/JS-Slash-Runner-main/src/function/audio.ts:29-117 与
  // src/store/audio.ts、src/type/settings.ts:15-33（默认值）。
  // 落点（SPEC §2.2 audio_player 改判"急需做"的实义）：要的是"播放队列"这个对象 ——
  // per-type store 九字段 + 每 type 一个 Audio 元素 + ended 按 mode 推进队列，
  // 零 requestParent、零后端；CSP media-src 已实测放行 http/https 外链（curl 实证）。
  // ⚠ 本区域位于模板字符串内：禁止反引号与美元花括号，反斜杠成对写（本段一个都没有）。
  const th134AudioUrlToTitle = (url) => {
    // 一手 audio.ts:15-17：url.split('/').at(-1)?.split('.').at(0) || url —— 等价的纯字符串写法
    //（本区域不允许正则字面量）。
    const text = String(url === undefined || url === null ? '' : url);
    const file = text.slice(text.lastIndexOf('/') + 1);
    const dot = file.indexOf('.');
    const base = dot > 0 ? file.slice(0, dot) : '';
    return base || text;
  };
  const th134AudioMakeStore = (isBgm) => ({
    playlist: [],
    src: '',
    progress: 0,
    playing: false,
    // 默认值一手：type/settings.ts:20-23（bgm）与 :28-31（ambient）—— mode 两队列不同。
    enabled: true,
    mode: isBgm ? 'repeat_all' : 'play_one_and_stop',
    muted: false,
    volume: 50,
  });
  const th134AudioStores = { bgm: th134AudioMakeStore(true), ambient: th134AudioMakeStore(false) };
  const th134AudioElements = {};
  const th134AudioStore = (type) => {
    if (type !== 'bgm' && type !== 'ambient') {
      throw new Error('TavernHelper: 音频类型只支持 bgm/ambient（audio.d.ts:18），收到: ' + String(type));
    }
    return th134AudioStores[type];
  };
  const th134AudioElement = (type) => {
    if (th134AudioElements[type]) return th134AudioElements[type];
    // 非浏览器沙箱（契约测试的 new Function 环境）没有 Audio ⇒ 只记账不发声明；真 iframe 必有。
    if (typeof Audio !== 'function') return null;
    const el = new Audio();
    el.addEventListener('ended', () => { th134AudioAdvance(type); });
    el.addEventListener('timeupdate', () => {
      const duration = Number(el.duration);
      const store = th134AudioStores[type];
      store.progress = Number.isFinite(duration) && duration > 0
        ? Math.min(100, Math.max(0, Math.round((Number(el.currentTime) / duration) * 100)))
        : 0;
    });
    el.addEventListener('error', () => {
      // 加载失败必须可见：TH 的 store 只置 playing=false（音画不同步就没人知道了），这里补 warn 留痕。
      th134AudioStores[type].playing = false;
      th134Warn('音频加载失败（' + type + '），已按暂停处理');
    });
    th134AudioElements[type] = el;
    return el;
  };
  const th134AudioStart = (type, item) => {
    const store = th134AudioStores[type];
    store.src = item.url;
    store.progress = 0;
    // TH 一手 audio.ts:40-43 无条件置 playing=true；autoplay 被浏览器拦下时由 play()
    // 的拒绝回调翻回 false + 留痕（标志与实际发声保持一致，可观测）。
    store.playing = true;
    const el = th134AudioElement(type);
    if (!el) return;
    el.src = item.url;
    el.muted = store.muted;
    el.volume = Math.min(1, Math.max(0, store.volume / 100));
    const playing = el.play();
    if (playing && typeof playing.then === 'function') {
      playing.catch((err) => {
        store.playing = false;
        th134Warn('playAudio 被浏览器拦下（autoplay 需用户先与页面交互）: ' + String(err && err.name ? err.name : err));
        if (typeof palinkDiagRecord === 'function') {
          palinkDiagRecord({
            owner: 'frame_compat',
            kind: 'compat_catch_swallowed',
            name: 'part-07:audio_play_blocked',
            detail: 'play() 拒绝（NotAllowedError 类），playing 标志已翻回 false，标志与实际发声一致',
          });
        }
      });
    }
  };
  const th134AudioAdvance = (type) => {
    const store = th134AudioStores[type];
    const list = store.playlist;
    if (!list.length) { store.playing = false; return; }
    if (store.mode === 'play_one_and_stop') { store.playing = false; return; }
    let current = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].url === store.src) { current = i; break; }
    }
    let next = 0;
    if (store.mode === 'repeat_one') {
      next = current >= 0 ? current : 0;
    } else if (store.mode === 'shuffle') {
      if (list.length > 1) {
        next = current;
        while (next === current) { next = Math.floor(Math.random() * list.length); }
      }
    } else {
      next = (current + 1) % list.length;   // repeat_all；current=-1（src 不在队列）⇒ 从头播
    }
    th134AudioStart(type, list[next]);
  };
  const th134AudioNormalize = (list) => (Array.isArray(list) ? list : []).map((item) => ({
    title: item && item.title ? String(item.title) : th134AudioUrlToTitle(item && item.url),
    url: String(item && item.url !== undefined && item.url !== null ? item.url : ''),
  }));
  const th134PlayAudio = (type, audio) => {
    const store = th134AudioStore(type);
    if (!audio || typeof audio !== 'object' || !audio.url) {
      th134Warn('playAudio 需要 { url }（audio.d.ts:29 AudioWithOptionalTitle），收到: ' + String(audio));
      return;
    }
    const url = String(audio.url);
    const title = audio.title ? String(audio.title) : th134AudioUrlToTitle(url);
    const existing = store.playlist.find((item) => item.title === title || item.url === url);
    if (existing) {
      existing.title = title;
      existing.url = url;
    } else {
      store.playlist.push({ title: title, url: url });
    }
    th134AudioStart(type, { url: url, title: title });
  };
  const th134PauseAudio = (type) => {
    const store = th134AudioStore(type);
    store.playing = false;
    const el = th134AudioElements[type];
    if (el && typeof el.pause === 'function') el.pause();
  };
  const th134GetAudioList = (type) => th134JsonClone(th134AudioStore(type).playlist);
  const th134ReplaceAudioList = (type, list) => {
    // TH 一手 audio.ts:56-59 只换 playlist，不动正在播的 src/playing。
    th134AudioStore(type).playlist = th134AudioNormalize(list);
  };
  const th134AppendAudioList = (type, list) => {
    // 契约明文（audio.d.ts:55-60）"不会重复添加同 title 或 url 的音频"；一手实现 audio.ts:61-66
    // 漏了去重（上游 bug），按契约补上。
    const store = th134AudioStore(type);
    th134AudioNormalize(list).forEach((item) => {
      const dup = store.playlist.find((ex) => ex.title === item.title || ex.url === item.url);
      if (!dup) store.playlist.push(item);
    });
  };
  const th134GetAudioSettings = (type) => {
    const store = th134AudioStore(type);
    return { enabled: store.enabled, mode: store.mode, muted: store.muted, volume: store.volume };
  };
  const th134SetAudioSettings = (type, settings) => {
    const store = th134AudioStore(type);
    const input = settings && typeof settings === 'object' ? settings : {};
    // TH 一手 audio.ts:103-117：缺省字段保持原值；volume clamp(0,100)；enabled 只记账
    //（audio.ts 的函数面不读它，照抄——别自作主张替卡关声音）。
    if (input.enabled !== undefined) store.enabled = Boolean(input.enabled);
    if (input.mode !== undefined) {
      const mode = String(input.mode);
      if (mode === 'repeat_one' || mode === 'repeat_all' || mode === 'shuffle' || mode === 'play_one_and_stop') {
        store.mode = mode;
      } else {
        th134Warn('setAudioSettings 收到未知播放模式 ' + mode + '，保持原值（audio.d.ts:72 四选一）');
      }
    }
    if (input.muted !== undefined) store.muted = Boolean(input.muted);
    if (input.volume !== undefined) {
      const volume = Number(input.volume);
      if (Number.isFinite(volume)) store.volume = Math.min(100, Math.max(0, volume));
    }
    const el = th134AudioElements[type];
    if (el) {
      el.muted = store.muted;
      el.volume = Math.min(1, Math.max(0, store.volume / 100));
    }
  };
  const th134GetCurrentAudio = (type) => {
    const store = th134AudioStore(type);
    let title = '';
    for (let i = 0; i < store.playlist.length; i += 1) {
      if (store.playlist[i].url === store.src) { title = store.playlist[i].title; break; }
    }
    return { src: store.src, title: title, playing: store.playing, progress: store.progress };
  };

  // ---- [批次TH 2026-10-26] 常量 2 键：TH 自身静态值，照抄常量（"静态枚举"先例，SPEC §6）。
  // default_preset 一手：src/function/preset.ts:126-218（TH 的默认预设内容，非用户数据）；
  // builtin_prompt_default_order 一手：src/function/generate/types.ts:172-182（d.ts:525 @deprecated，
  // 值 = placeholder_prompt_default_order 九项）。
  const th134BuiltinPromptDefaultOrder = [
    'world_info_before', 'persona_description', 'char_description', 'char_personality',
    'scenario', 'world_info_after', 'dialogue_examples', 'chat_history', 'user_input',
  ];
  const th134DefaultPreset = {
    settings: {
      max_context: 2000000,
      max_completion_tokens: 300,
      reply_count: 1,
      should_stream: false,
      temperature: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      repetition_penalty: 1,
      top_p: 1,
      min_p: 0,
      top_k: 0,
      top_a: 0,
      seed: -1,
      squash_system_messages: false,
      reasoning_effort: 'auto',
      request_thoughts: false,
      request_images: false,
      enable_function_calling: false,
      enable_web_search: false,
      allow_sending_images: 'disabled',
      allow_sending_videos: false,
      character_name_prefix: 'none',
      wrap_user_messages_in_quotes: false,
    },
    prompts: [
      { id: 'worldInfoBefore', name: 'World Info (before) - 角色定义之前', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'personaDescription', name: 'Persona Description - 玩家描述', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'charDescription', name: 'Char Description - 角色描述', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'charPersonality', name: 'Char Personality - 角色性格', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'scenario', name: 'Scenario - 情景', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'worldInfoAfter', name: 'World Info (after) - 角色定义之后', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'dialogueExamples', name: 'Chat Examples - 对话示例', enabled: true, position: { type: 'relative' }, role: 'system' },
      { id: 'chatHistory', name: 'Chat History - 聊天记录', enabled: true, position: { type: 'relative' }, role: 'system' },
    ],
    prompts_unused: [],
    extensions: { tavern_helper: { scripts: [], variables: {} } },
  };

  // ---- [批次TH2 2026-10-26] 预设提示词**类型判定** 3 键 + 代理预设名单 1 键（D→C，用户点头）。
  // 一手（逐行照抄，不改语义）：st-plugins/third-party/JS-Slash-Runner-main/src/function/preset.ts:107-124
  //   isPresetSystemPrompt(prompt)      = ['main','nsfw','jailbreak','enhanceDefinitions'].includes(prompt.id)
  //   isPresetPlaceholderPrompt(prompt) = ['worldInfoBefore','personaDescription','charDescription',
  //                                       'charPersonality','scenario','worldInfoAfter',
  //                                       'dialogueExamples','chatHistory'].includes(prompt.id)
  //   isPresetNormalPrompt(prompt)      = 两者都不是
  // ⚠️ d.ts 注释里写的是 snake_case（world_info_before 等），**实现判的是 camelCase id**
  //   —— 以实现为准（TH 自己的 default_preset 也是 camelCase，见上方常量段）；
  //   卡手里 preset.prompts[i].id 就是 camelCase，判 snake_case 会恒 false。
  // 唯一必要偏差（如实留痕）：ST 直取 prompt.id（传 null 会 TypeError）；本仓对
  //   null / 非对象 / id 非字符串一律判 false —— 类型守卫语义下"不是预设提示词"就是 false，
  //   不替卡制造崩溃。⛔ 不做内容猜测（不按 name / content 反推类型：那才是"形状对语义错"）。
  const th134PresetSystemPromptIds = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
  const th134PresetPlaceholderPromptIds = [
    'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality',
    'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory',
  ];
  const th134PresetPromptId = (prompt) => (
    prompt && typeof prompt === 'object' && typeof prompt.id === 'string' ? prompt.id : ''
  );
  const th134PresetIdIn = (prompt, ids) => ids.indexOf(th134PresetPromptId(prompt)) >= 0;
  const th134IsPresetSystemPrompt = (prompt) => th134PresetIdIn(prompt, th134PresetSystemPromptIds);
  const th134IsPresetPlaceholderPrompt = (prompt) => th134PresetIdIn(prompt, th134PresetPlaceholderPromptIds);
  const th134IsPresetNormalPrompt = (prompt) => (
    !th134IsPresetSystemPrompt(prompt) && !th134IsPresetPlaceholderPrompt(prompt)
  );
  // getProxyPresetNames（preset.d.ts）：ST 一手是 proxies.map(p => p.name)
  //   （src/function/generate/index.ts:39-41）。Palink **没有代理预设子系统**
  //   （同口径注释见父侧 palink-diag.ts 的 preset_prompt 段与 SmartCardCompatController.ts 同段），
  //   且没有 loadProxyPreset 的落点 ⇒ 返回**空数组**是唯一诚实答案。
  // ⛔ 不返回假名字：假名字会让卡"选中一个不存在的代理预设"然后静默失效，比空数组坏得多。
  // 一次性留痕（每帧只写一条；owner=frame_compat ⇒ 不进 host_capability 缺口排行，
  //   与 retrieveDisplayedMessage 同口径：已实现、受限于子系统，不是宿主能力缺口）。
  let th134ProxyPresetNamesWarned = false;
  const th134GetProxyPresetNames = () => {
    if (!th134ProxyPresetNamesWarned) {
      th134ProxyPresetNamesWarned = true;
      if (typeof palinkDiagRecord === 'function') {
        palinkDiagRecord({
          owner: 'frame_compat',
          kind: 'missing_api',
          name: 'getProxyPresetNames',
          detail: '本仓无代理预设子系统（ST 的 proxies 表不存在）⇒ 恒返回空数组；本记录每帧只写一次',
        });
      }
    }
    return [];
  };

  // ---- [批次TH 2026-10-26] builtin 部分桥（builtin.d.ts:1-85）。
  // 口径：有帧内真实现的成员桥到同一个实现（不复制第二份逻辑），没有的**缺席**
  // （不造假成员 —— 卡取 builtin.saveSettings 得 undefined 是可见的缺席，好过假成功）。
  // 缺席成员（ST 界面/内部对象面，本帧无对应）：duringGenerating / getImageTokenCost /
  // getVideoTokenCost / promptManager / reloadAndRenderChatWithoutEvents /
  // reloadChatWithoutEvents / reloadEditor / reloadEditorDebounced / renderPromptManager /
  // renderPromptManagerDebounced / saveSettings。
  const th134CopyText = (text) => {
    // TH 一手 util/compatibility.ts:101-121：优先 navigator.clipboard，回落隐藏 textarea + execCommand。
    const value = String(text === undefined || text === null ? '' : text);
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      const writing = navigator.clipboard.writeText(value);
      if (writing && typeof writing.then === 'function') {
        writing.catch((err) => { th134Warn('copyText 剪贴板写入被拒绝: ' + String(err)); });
      }
      return;
    }
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (copyErr) { th134Warn('copyText execCommand 异常: ' + String(copyErr)); }
    document.body.removeChild(area);
    if (!copied) th134Warn('copyText execCommand 返回 false（剪贴板可能不可用）');
  };
  const th134RenderMarkdown = (markdown) => {
    // TH 一手 util/tavern.ts:142-144 是纯 markdown→HTML（makeHtml）；本帧最近似的真实现是
    // messageFormatting（markdown 渲染 + ST 消息格式化的超集）—— 有已知形状偏差，不另造假管线。
    const formatter = th134GlobalFn('messageFormatting');
    if (!formatter) {
      th134Warn('renderMarkdown 依赖的帧内实现 messageFormatting 未注册，原样返回文本（不造 HTML）');
      return String(markdown === undefined || markdown === null ? '' : markdown);
    }
    return String(formatter.apply(window, [String(markdown === undefined || markdown === null ? '' : markdown), '', false, false, -1]));
  };
  const th134ParseRegexFromString = (value) => {
    // ST 一手（world-info 的 parseRegexFromString）：'/pattern/flags' → RegExp，解析失败返 null。
    // 本区域禁止正则字面量 ⇒ 纯字符串切分（语义等价：头尾各一个 '/'，flags 只收 dgimsuvy）。
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text.length < 2 || text.charAt(0) !== '/') return null;
    const lastSlash = text.lastIndexOf('/');
    if (lastSlash <= 0) return null;
    const body = text.slice(1, lastSlash);
    const flags = text.slice(lastSlash + 1);
    for (let i = 0; i < flags.length; i += 1) {
      if ('dgimsuvy'.indexOf(flags.charAt(i)) < 0) return null;
    }
    try {
      return new RegExp(body, flags);
    } catch (parseErr) {
      th134Warn('parseRegexFromString 解析失败，返回 null: ' + String(parseErr));
      return null;
    }
  };
  const th134Builtin = {
    addOneMessage: th134Bridge('addOneMessage'),
    uuidv4: th134Bridge('uuidv4'),
    copyText: th134CopyText,
    renderMarkdown: th134RenderMarkdown,
    parseRegexFromString: th134ParseRegexFromString,
  };

  // ---- [批次TH 2026-10-26] 预设**写类** 9 键：帧内复合 + 父侧既有路由（零后端改动）。
  //
  // 路由映射（全部既有端点；写/删严禁落 presets.py 的 user_id IS NULL 共享行 —— 后端
  // PUT/DELETE 本就只认 user_id == 本人 ⇒ 拿共享行 id 操作必 404，帧内按契约转 false）：
  //   loadPreset         → PUT  /api/prompt-manager/presets/selection（prompt_manager.py:111）
  //   createPreset       → POST /api/roleplay/presets/import（multipart；presets.py:251 是唯一能把
  //                        prompts 落进 prompts_data 的既有通道，:287 原样入库）
  //   deletePreset       → DELETE /api/roleplay/presets/{id}（presets.py:194）
  //   renamePreset       → PUT  /api/roleplay/presets/{id}（presets.py:159）
  //   writeSessionPreset → PUT  /api/prompt-manager/sessions/{id}/preset（prompt_manager.py:274，
  //                        P-1 裁定"卡改本对话份"，写时复制）—— 'in_use' 的写全走这里
  //   replaceNamedPreset → PUT  /api/roleplay/presets/{id}（只有生成参数列可写）
  //   importRawPreset    → 父侧把 content 包成 File 走 POST /api/roleplay/presets/import
  //
  // 同步/异步（P2-12 #15 的教训写死）：loadPreset 在 d.ts:169 是**同步** boolean ⇒ 帧内同步实现
  // （快照名单判存在 + kick 父侧 PUT），⛔ 不许接成 async —— Promise 是恒真值，
  // "查无此名返 false"就死了；其余 8 键 d.ts 本就是 async ⇒ async 桥。
  const th134WritePresetContent = async (presetName, preset, options) => {
    const name = String(presetName === undefined || presetName === null ? '' : presetName);
    if (!preset || typeof preset !== 'object') {
      throw new Error('TavernHelper: 写预设需要一份 Preset 对象内容（preset.d.ts），收到: ' + String(preset));
    }
    const render = options && options.render !== undefined ? String(options.render) : 'debounced';
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const settings = preset.settings && typeof preset.settings === 'object' ? preset.settings : {};
    if (name === 'in_use') {
      const res = await requestParent('writeSessionPreset', { settings: settings, prompts: prompts, render: render });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: 写本对话预设份失败: ' + String((res && res.error) || 'unknown'));
      }
      return;
    }
    const res = await requestParent('replaceNamedPreset', { name: name, settings: settings, prompts: prompts, render: render });
    if (!res || res.success !== true) {
      throw new Error('TavernHelper: 写预设 ' + name + ' 失败: ' + String((res && res.error) || 'unknown'));
    }
    if (res.prompts_written === false && prompts.length > 0) {
      // 诚实留痕：generation_presets 行没有 prompts 写通道（PresetUpdateRequest 无该字段，
      // 第一方界面也只编辑生成参数）。卡要改提示词内容请走 in_use（P-1 裁定：卡改本对话份）。
      th134Warn('replacePreset 对具名预设只写入了生成参数；prompts 没有全局写通道（改内容请走 in_use 会话份）');
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
    // [ST-BRIDGE-BOOKBIND 2026-10-20 批次A] 世界书删除 + 卡↔书绑定写侧四键。
    //
    // 契约（一手，逐个抄自 @types/function/）：
    //   worldbook.d.ts:184-190  deleteWorldbook(worldbook_name) —— Promise<boolean>，
    //                           注释写死「是否成功删除，可能因世界书不存在等原因而失败」
    //                           ⇒ **失败返回 false，不是抛错**；
    //   lorebook.d.ts:27-28     deleteLorebook —— 同物的 deprecated 名，形状同上；
    //   worldbook.d.ts:21-39    rebindCharWorldbooks(character_name, {primary, additional})
    //                           —— Promise<void>，无返回值可用；
    //   lorebook.d.ts:51-52     setCurrentCharLorebooks —— 同物的 deprecated 名。
    //
    // 失败形状为什么两族不同（这里是刻意的，不是笔误）：
    //   删除族按 d.ts 返回 false —— 它有返回值这条泄露通道；
    //   绑定族返回 void，没有能承载失败的位置，静默吞掉就等于假成功（本包红线）
    //   ⇒ 只能 throw，让卡自己用 try/catch 接（ST 插件普遍也是这么写的）。
    //
    // 两个 deprecated 名与两个现行名分别指向**同一份父侧实现**，不复制第二份逻辑。
    //
    // ⚠ 本区域位于模板字符串内：禁止反引号与美元花括号，反斜杠成对写。
    deleteWorldbook: async (name) => {
      const res = await requestParent('deleteWorldbook', { name });
      return !!(res && res.success === true);
    },
    deleteLorebook: async (name) => {
      const res = await requestParent('deleteWorldbook', { name });
      return !!(res && res.success === true);
    },
    rebindCharWorldbooks: async (characterName, charWorldbooks) => {
      const res = await requestParent('rebindCharWorldbooks', { characterName, charWorldbooks });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: rebindCharWorldbooks 失败: ' + String((res && res.error) || 'unknown'));
      }
    },
    setCurrentCharLorebooks: async (lorebooks) => {
      const res = await requestParent('rebindCharWorldbooks', {
        characterName: 'current',
        charWorldbooks: lorebooks,
      });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: setCurrentCharLorebooks 失败: ' + String((res && res.error) || 'unknown'));
      }
    },
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
    // [ST-BRIDGE-PERSONA 2026-10-20 批次B] 人设 11 键（契约逐条抄 persona.d.ts）。
    // 失败语义分族（刻意，不是笔误）：
    //   getPersonaNames():30 / getPersonaIds():37 —— 后端访问失败抛，不返空数组装成功；
    //   getCurrentPersonaName():44 / getCurrentPersonaId():51 —— 无当前人设返 null；
    //   getPersonaAvatarPath():60 —— 不存在或名称不唯一返 null（不抛），仅后端失败抛；
    //   getPersona():71 —— 不存在或名称不唯一抛错；
    //   createPersona():85-89 —— 同名/同头像 id/名为 current 返 false，后端失败抛；
    //   createOrReplacePersona():104-108 —— 创建返 true、替换返 false，名称不唯一抛；
    //   deletePersona():119 —— 不存在/不唯一返 false，后端失败抛；
    //   replacePersona():137-141 —— Promise<void>，不存在/不唯一抛；
    //   updatePersonaWith():164-168 —— updater 是帧内函数 ⇒ getPersona + replacePersona
    //     两个父侧动作组合，不另造父侧第三份逻辑。
    // personaRef 语义 = 名称 / 头像 id / 'current'（d.ts LiteralUnion），解析在父侧
    // resolvePersonaRef；返回一律对象包裹（requestParent v2 会把顶层数组/字符串展开成索引键）。
    getPersonaNames: async () => {
      const res = await requestParent('getPersonaNames', {});
      if (!res || res.success !== true) throw new Error('TavernHelper: getPersonaNames 失败: ' + String((res && res.error) || 'unknown'));
      return Array.isArray(res.names) ? res.names : [];
    },
    getPersonaIds: async () => {
      const res = await requestParent('getPersonaIds', {});
      if (!res || res.success !== true) throw new Error('TavernHelper: getPersonaIds 失败: ' + String((res && res.error) || 'unknown'));
      return Array.isArray(res.ids) ? res.ids : [];
    },
    getCurrentPersonaName: async () => {
      const res = await requestParent('getCurrentPersonaName', {});
      if (!res || res.success !== true) throw new Error('TavernHelper: getCurrentPersonaName 失败: ' + String((res && res.error) || 'unknown'));
      return res.name === undefined || res.name === null ? null : String(res.name);
    },
    getCurrentPersonaId: async () => {
      const res = await requestParent('getCurrentPersonaId', {});
      if (!res || res.success !== true) throw new Error('TavernHelper: getCurrentPersonaId 失败: ' + String((res && res.error) || 'unknown'));
      return res.id === undefined || res.id === null ? null : String(res.id);
    },
    getPersonaAvatarPath: async (personaRef) => {
      const res = await requestParent('getPersonaAvatarPath', { personaRef });
      if (!res || res.success !== true) throw new Error('TavernHelper: getPersonaAvatarPath 失败: ' + String((res && res.error) || 'unknown'));
      return res.path === undefined || res.path === null ? null : String(res.path);
    },
    getPersona: async (personaRef) => {
      const res = await requestParent('getPersona', { personaRef });
      if (!res || res.success !== true) throw new Error('TavernHelper: getPersona 失败: ' + String((res && res.error) || 'unknown'));
      return res.persona;
    },
    createPersona: async (personaName, persona) => {
      const res = await requestParent('createPersona', { personaName, persona });
      if (!res || res.success !== true) throw new Error('TavernHelper: createPersona 失败: ' + String((res && res.error) || 'unknown'));
      return res.created === true;
    },
    createOrReplacePersona: async (personaName, persona) => {
      const res = await requestParent('createOrReplacePersona', { personaName, persona });
      if (!res || res.success !== true) throw new Error('TavernHelper: createOrReplacePersona 失败: ' + String((res && res.error) || 'unknown'));
      return res.created === true;
    },
    deletePersona: async (personaRef) => {
      const res = await requestParent('deletePersona', { personaRef });
      if (!res || res.success !== true) throw new Error('TavernHelper: deletePersona 失败: ' + String((res && res.error) || 'unknown'));
      return res.deleted === true;
    },
    replacePersona: async (personaRef, persona) => {
      const res = await requestParent('replacePersona', { personaRef, persona });
      if (!res || res.success !== true) throw new Error('TavernHelper: replacePersona 失败: ' + String((res && res.error) || 'unknown'));
    },
    updatePersonaWith: async (personaRef, updater) => {
      const current = await requestParent('getPersona', { personaRef });
      if (!current || current.success !== true) {
        throw new Error('TavernHelper: updatePersonaWith 读取失败: ' + String((current && current.error) || 'unknown'));
      }
      const updated = typeof updater === 'function' ? await updater(current.persona) : current.persona;
      const res = await requestParent('replacePersona', { personaRef, persona: updated });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: updatePersonaWith 写回失败: ' + String((res && res.error) || 'unknown'));
      }
      return updated;
    },
    // [ST-BRIDGE-PRESET 2026-10-21 批次P2 段③] 预设**读类** 3 键（契约逐条抄 preset.d.ts）。
    //
    // [批次P3 P3-A 2026-10-21 订正] 这三个键在 P2 里被接成了 **async**（帧内 requestParent
    // 是异步的），而 ST 契约是**同步**（preset.d.ts:150 声明 getPresetNames(): string[]）
    // ⇒ 真卡按 ST 写法取 getPresetNames().length 拿到的是 undefined，
    //   getPreset('in_use').prompts 直接崩。**"接错成异步"比"没接"更难发现**：
    //   不报错、不留痕、门禁全绿（用例 await 了返回值，而 await 对同步值和 Promise 一样成立）。
    // ⇒ 改法（主脑定的路线，不要另发明）：宿主在 ctx 里带一份**预设快照**，帧内三键
    //   **同步读快照**；快照的刷新走宿主既有的 context-update 通道（Object.assign(ctx, …)）。
    //   ⛔ 帧内不做"同步等异步"的忙等，也不返回假值。
    //
    // 快照的形状（服务端 GET /api/prompt-manager/presets/snapshot 一次算好）：
    //   ctx.presetSnapshot = { store, names:[], loadedName, inUse, presets:{name:Preset}, source }
    //   数据源 = generation_presets（用户在设置里那份，**不是**全库 0 行的 prompt_presets），
    //   且只含本人那份（user_id IS NULL 的共享行由服务端挡掉）。
    //
    // 语义诚实（快照可能不是最新 —— 刚改完预设立刻读）：
    //   拿不到快照 ⇒ 返回**空数组 / null** 并 palinkDiag 留痕，⛔ 不许返回 undefined 冒充
    //   "没有预设"（undefined 会让 getPresetNames().length 直接 TypeError，卡连错都不知道）。
    //   getPreset(name) 取不到 ⇒ **抛错**（d.ts @throws，且抛错是可见的，不是静默空值）。
    getPresetNames: () => {
      const snap = readPresetSnapshotCompat();
      if (!snap) return [];
      return Array.isArray(snap.names) ? snap.names.slice() : [];
    },
    getLoadedPresetName: () => {
      const snap = readPresetSnapshotCompat();
      if (!snap) return null;
      return snap.loadedName === undefined || snap.loadedName === null ? null : String(snap.loadedName);
    },
    getPreset: (presetName) => {
      const snap = readPresetSnapshotCompat();
      const name = presetName === undefined || presetName === null ? 'in_use' : String(presetName);
      if (!snap) throw new Error('TavernHelper: getPreset 预设快照未就绪: ' + name);
      if (name === 'in_use') {
        if (snap.inUse && typeof snap.inUse === 'object') return snap.inUse;
        throw new Error('TavernHelper: getPreset 当前没有生效的预设: in_use');
      }
      const byName = snap.presets && typeof snap.presets === 'object' ? snap.presets : null;
      if (!byName) throw new Error('TavernHelper: getPreset 预设快照缺 presets 索引: ' + name);
      const found = Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : undefined;
      if (found === undefined || found === null) {
        throw new Error('TavernHelper: getPreset 预设不存在: ' + name);
      }
      return found;
    },
    // [批次TH2 2026-10-26] 预设提示词**类型判定** 3 键 + 代理预设名单 1 键（D→C，用户点头）。
    // 判定语义与必要偏差见上方 th134Preset* 常量段；这里只做"纯 id 归属"，不碰父侧通道。
    isPresetSystemPrompt: (prompt) => th134IsPresetSystemPrompt(prompt),
    isPresetPlaceholderPrompt: (prompt) => th134IsPresetPlaceholderPrompt(prompt),
    isPresetNormalPrompt: (prompt) => th134IsPresetNormalPrompt(prompt),
    // ST 是 proxies.map(p => p.name)；本仓无代理预设子系统 ⇒ 空数组 + 一次性 diag（不造假名字）。
    getProxyPresetNames: () => th134GetProxyPresetNames(),
    // [ST-BRIDGE-PRESET-WRITE 2026-10-26 批次TH] 预设**写类** 9 键（契约逐条抄 preset.d.ts /
    // import_raw.d.ts:40；路由映射与同步/异步纪律见 th134WritePresetContent 上方注释）。
    // 失败语义分族（一手）：
    //   loadPreset():169 —— **同步** boolean：快照名单查无此名 ⇒ false（TH 一手 preset.ts:579-584
    //     findPreset 失败返 false）；命中 ⇒ kick 父侧 PUT selection 并返回 true（TH 的 selectPreset
    //     也是"先接受、保存防抖"的同步语义）。
    //   createPreset():192 —— 同名 / 名为 'in_use' 返 false；不填内容用 default_preset（TH :593-599）。
    //   createOrReplacePreset():204 —— 建 true / 替换 false；'in_use' 恒为替换（TH 名单恒含 'in_use'）。
    //   deletePreset():217 —— 不存在返 false；其他失败抛（可见）。
    //   renamePreset():227 —— 查无此名返 false。
    //   replacePreset():276 —— 不存在 @throws；Promise<void>。
    //   updatePresetWith():332 —— 读-改-写复合（同 updatePersonaWith 先例），返回更新后内容。
    //   setPreset():361 —— 部分深合并（TH preset.ts:733-745：传入值赢、旧值补缺、数组整体替换）。
    //   importRawPreset(import_raw.d.ts:40) —— TH 一手 import_raw.ts:79-85 任何失败返 false，不抛；
    //     TH 的"同名即更新"在本仓不成立（import 路由对同名改建 "(imported)" 新行），如实留痕。
    loadPreset: (presetName) => {
      const wanted = String(presetName === undefined || presetName === null ? '' : presetName);
      if (!wanted || wanted === 'in_use') return false;
      const snap = readPresetSnapshotCompat();
      if (!snap) return false;
      const names = Array.isArray(snap.names) ? snap.names : [];
      if (names.indexOf(wanted) < 0) return false;
      requestParent('loadPreset', { name: wanted }).then((res) => {
        if (!res || res.success !== true) {
          th134Warn('loadPreset 父侧切换失败: ' + String((res && res.error) || 'unknown'));
          if (typeof palinkDiagRecord === 'function') {
            palinkDiagRecord({
              owner: 'frame_compat',
              kind: 'compat_catch_swallowed',
              name: 'part-07:preset_load_failed',
              detail: 'loadPreset 已同步返回 true，父侧 PUT selection 失败 —— 选中名实际未切换',
            });
          }
        }
      }).catch((loadErr) => {
        th134Warn('loadPreset 父侧通道异常: ' + String(loadErr));
      });
      return true;
    },
    createPreset: async (presetName, preset) => {
      const wanted = String(presetName === undefined || presetName === null ? '' : presetName);
      if (!wanted || wanted === 'in_use') return false;
      const res = await requestParent('createPreset', {
        name: wanted,
        preset: preset === undefined || preset === null ? th134DefaultPreset : preset,
      });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: createPreset 失败: ' + String((res && res.error) || 'unknown'));
      }
      return res.created === true;
    },
    createOrReplacePreset: async (presetName, preset, options) => {
      const wanted = String(presetName === undefined || presetName === null ? '' : presetName);
      if (!wanted) return false;
      const content = preset === undefined || preset === null ? th134DefaultPreset : preset;
      if (wanted === 'in_use') {
        await th134WritePresetContent('in_use', content, options);
        return false;
      }
      const current = await requestParent('getPreset', { presetName: wanted });
      if (current && current.success === true) {
        await th134WritePresetContent(wanted, content, options);
        return false;
      }
      if (!current || current.error !== 'preset_not_found') {
        throw new Error('TavernHelper: createOrReplacePreset 存在性判定失败: ' + String((current && current.error) || 'unknown'));
      }
      const res = await requestParent('createPreset', { name: wanted, preset: content });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: createOrReplacePreset 失败: ' + String((res && res.error) || 'unknown'));
      }
      return res.created === true;
    },
    deletePreset: async (presetName) => {
      const wanted = String(presetName === undefined || presetName === null ? '' : presetName);
      if (!wanted || wanted === 'in_use') return false;
      const res = await requestParent('deletePreset', { name: wanted });
      if (!res || res.success !== true) {
        if (res && res.error === 'preset_not_found') return false;
        throw new Error('TavernHelper: deletePreset 失败: ' + String((res && res.error) || 'unknown'));
      }
      return res.deleted === true;
    },
    renamePreset: async (presetName, newName) => {
      const wanted = String(presetName === undefined || presetName === null ? '' : presetName);
      const next = String(newName === undefined || newName === null ? '' : newName);
      if (!wanted || wanted === 'in_use' || !next || next === 'in_use') return false;
      const res = await requestParent('renamePreset', { name: wanted, newName: next });
      if (!res || res.success !== true) {
        if (res && res.error === 'preset_not_found') return false;
        throw new Error('TavernHelper: renamePreset 失败: ' + String((res && res.error) || 'unknown'));
      }
      return true;
    },
    replacePreset: async (presetName, preset, options) => {
      const wanted = String(presetName === undefined || presetName === null ? 'in_use' : presetName);
      if (wanted !== 'in_use') {
        const probe = await requestParent('getPreset', { presetName: wanted });
        if (!probe || probe.success !== true) {
          throw new Error('TavernHelper: replacePreset 预设不存在: ' + wanted);
        }
      }
      await th134WritePresetContent(wanted, preset, options);
    },
    updatePresetWith: async (presetName, updater, options) => {
      const wanted = String(presetName === undefined || presetName === null ? 'in_use' : presetName);
      const current = await requestParent('getPreset', { presetName: wanted });
      if (!current || current.success !== true) {
        throw new Error('TavernHelper: updatePresetWith 预设不存在或读取失败: ' + wanted + ': ' + String((current && current.error) || 'unknown'));
      }
      const updated = typeof updater === 'function' ? await updater(current.preset) : current.preset;
      if (!updated || typeof updated !== 'object') {
        throw new Error('TavernHelper: updatePresetWith 的 updater 必须返回预设对象（preset.d.ts:282 PresetUpdater）');
      }
      await th134WritePresetContent(wanted, updated, options);
      return updated;
    },
    setPreset: async (presetName, partialPreset, options) => {
      const wanted = String(presetName === undefined || presetName === null ? 'in_use' : presetName);
      if (!partialPreset || typeof partialPreset !== 'object') {
        throw new Error('TavernHelper: setPreset 需要部分预设内容（preset.d.ts:363 PartialDeep）');
      }
      const current = await requestParent('getPreset', { presetName: wanted });
      if (!current || current.success !== true) {
        throw new Error('TavernHelper: setPreset 预设不存在或读取失败: ' + wanted + ': ' + String((current && current.error) || 'unknown'));
      }
      const oldPreset = current.preset && typeof current.preset === 'object' ? current.preset : {};
      const merged = {
        settings: th134DeepMerge(th134JsonClone(oldPreset.settings), th134JsonClone(partialPreset.settings), false),
        prompts: partialPreset.prompts !== undefined ? th134JsonClone(partialPreset.prompts) : oldPreset.prompts,
        prompts_unused: partialPreset.prompts_unused !== undefined ? th134JsonClone(partialPreset.prompts_unused) : oldPreset.prompts_unused,
        extensions: th134DeepMerge(th134JsonClone(oldPreset.extensions), th134JsonClone(partialPreset.extensions), false),
      };
      await th134WritePresetContent(wanted, merged, options);
      return merged;
    },
    importRawPreset: async (filename, content) => {
      const res = await requestParent('importRawPreset', {
        filename: String(filename === undefined || filename === null ? '' : filename),
        content: String(content === undefined || content === null ? '' : content),
      });
      if (!res || res.success !== true) {
        th134Warn('importRawPreset 失败: ' + String((res && res.error) || 'unknown'));
        return false;
      }
      return true;
    },
    // [批次TH 2026-10-26] 音频 8 键（全部**同步**签名，audio.d.ts）—— 状态机本体见上方
    // th134AudioStores 段。P2-12 #15 的验收口径：这些键必须 thenable=false 且返回真数据。
    playAudio: th134PlayAudio,
    pauseAudio: th134PauseAudio,
    getAudioList: th134GetAudioList,
    replaceAudioList: th134ReplaceAudioList,
    appendAudioList: th134AppendAudioList,
    getAudioSettings: th134GetAudioSettings,
    setAudioSettings: th134SetAudioSettings,
    getCurrentAudio: th134GetCurrentAudio,
    // [批次TH 2026-10-26] 常量 3 键：builtin 部分桥（缺席成员见 th134Builtin 上方注释）+
    // TH 自身静态值两键（照抄常量，非用户数据；值出处见 th134DefaultPreset 上方注释）。
    builtin: th134Builtin,
    builtin_prompt_default_order: th134BuiltinPromptDefaultOrder,
    default_preset: th134DefaultPreset,
    // [批次R1 2026-10-21] 扩展读面 5 键（契约逐条抄 @types/function/extension.d.ts）。
    //
    // 契约一手：
    //   isAdmin(): boolean                                   —— extension.d.ts:2（同步）
    //   getTavernHelperExtensionId(): string                 —— :5（同步，助手恒为 'JS-Slash-Runner'）
    //   getExtensionType(id): 'local'|'global'|'system'|null —— :15（同步）
    //   isInstalledExtension(id): boolean                    —— :40（同步，= getExtensionType !== null）
    //   getExtensionStatus = getExtensionInstallationInfo    —— index.d.ts:47 +
    //     src/function/extension.ts:23-39（**异步**，Promise<{current_branch_name,
    //     current_commit_hash,is_up_to_date,remote_url}|null>；不是"启用与否"）
    //
    // isAdmin 的真值来源：宿主把 App.tsx 的 user.role === 'admin' 经
    // current-user-role 快照写进 ctx.isAdmin（boot 内联 + context-update 热更）。
    // ⛔ 不从帧内 payload 取、不恒 true/false；宿主没下发时按安全默认 false 返回并留痕。
    isAdmin: () => {
      if (typeof ctx.isAdmin === 'boolean') return ctx.isAdmin;
      th134Warn('isAdmin: 宿主未下发当前用户角色，按 false 返回（安全默认，不是权限判定）');
      return false;
    },
    getTavernHelperExtensionId: () => 'JS-Slash-Runner',
    getExtensionType: th134GetExtensionType,
    isInstalledExtension: (extensionId) => th134GetExtensionType(extensionId) !== null,
    // 异步桥：父侧 getExtensionStatus 动作拉一次作用域内插件目录再回答。
    // 找不到 ⇒ null（d.ts 的"未安装"口径）；父侧失败 ⇒ 抛错（不静默 null 装成"未安装"）。
    getExtensionStatus: async (extensionId) => {
      const res = await requestParent('getExtensionStatus', { extensionId: extensionId });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: getExtensionStatus 失败: ' + String((res && res.error) || 'unknown'));
      }
      return res.info === undefined || res.info === null ? null : res.info;
    },
    // [ST-BRIDGE-CHARLIB 2026-10-20 批次B 段②] 角色库写侧 7 键（character.d.ts）。
    // 失败语义（一手）：
    //   createCharacter():59-62 —— 同名/名为 current 返 false，后端失败抛；
    //   createOrReplaceCharacter():76-80 —— 创建 true / 替换 false；
    //   deleteCharacter():91-94 —— Promise<boolean>；⚠ 本仓删除必然级联席聊
    //     （character_service.py:118-145）⇒ 父侧要求显式 options.delete_chats === true，
    //     否则失败返 false（防按 ST 默认调用意外删掉聊天）；
    //   replaceCharacter():141-145 —— Promise<void>，不存在抛；
    //   updateCharacterWith():183-186 —— updater 是帧内函数 ⇒ getCharacterDetail +
    //     replaceCharacter 两个父侧动作组合，不另造第三份逻辑；
    //   importRawCharacter（import_raw.d.ts:12）—— Blob 在帧内转 dataURL 再交给父侧
    //     （postMessage 不保证 Blob 原样到达）；返回 {ok,status,character_id} 而非
    //     fetch Response —— 已留痕的语义偏差；
    //   RawCharacter（raw_character.d.ts:5-97）—— 帧内本地类，数据源 getContext().characters；
    //     getChatsFromFiles / findCharacterIndex 依赖 ST 聊天文件面（本仓不同源）⇒ 契约不明。
    // 角色引用 = 名称 / 头像 id / 'current'，解析在父侧 resolveCharacterRef。
    createCharacter: async (characterName, character) => {
      const res = await requestParent('createCharacter', { characterName, character });
      if (!res || res.success !== true) throw new Error('TavernHelper: createCharacter 失败: ' + String((res && res.error) || 'unknown'));
      return res.created === true;
    },
    createOrReplaceCharacter: async (characterName, character) => {
      const res = await requestParent('createOrReplaceCharacter', { characterName, character });
      if (!res || res.success !== true) throw new Error('TavernHelper: createOrReplaceCharacter 失败: ' + String((res && res.error) || 'unknown'));
      return res.created === true;
    },
    deleteCharacter: async (characterName, options) => {
      const res = await requestParent('deleteCharacter', { characterName, options });
      if (!res || res.success !== true) throw new Error('TavernHelper: deleteCharacter 失败: ' + String((res && res.error) || 'unknown'));
      return res.deleted === true;
    },
    replaceCharacter: async (characterName, character) => {
      const res = await requestParent('replaceCharacter', { characterName, character });
      if (!res || res.success !== true) throw new Error('TavernHelper: replaceCharacter 失败: ' + String((res && res.error) || 'unknown'));
    },
    updateCharacterWith: async (characterName, updater) => {
      const current = await requestParent('getCharacterDetail', { characterName });
      if (!current || current.success !== true) {
        throw new Error('TavernHelper: updateCharacterWith 读取失败: ' + String((current && current.error) || 'unknown'));
      }
      const updated = typeof updater === 'function' ? await updater(current.character) : current.character;
      const res = await requestParent('replaceCharacter', { characterName, character: updated });
      if (!res || res.success !== true) {
        throw new Error('TavernHelper: updateCharacterWith 写回失败: ' + String((res && res.error) || 'unknown'));
      }
      return updated;
    },
    importRawCharacter: async (filename, content) => {
      const dataUrl = await new Promise((resolve) => {
        try {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => resolve('');
          reader.readAsDataURL(content);
        } catch (err) {
          resolve('');
        }
      });
      const res = await requestParent('importRawCharacter', { filename, dataUrl });
      if (!res || res.success !== true) throw new Error('TavernHelper: importRawCharacter 失败: ' + String((res && res.error) || 'unknown'));
      return { ok: true, status: res.status || 'ok', character_id: res.character_id || null };
    },
    RawCharacter: (function () {
      function RawCharacterCompat(characterData) {
        this.__data = characterData && typeof characterData === 'object' ? characterData : {};
      }
      RawCharacterCompat.find = function (options) {
        const opts = options && typeof options === 'object' ? options : {};
        const target = opts.name === undefined || opts.name === null ? 'current' : opts.name;
        const found = th134FindCharacter(target);
        if (!found) return null;
        return found.data && typeof found.data === 'object' ? found.data : found;
      };
      RawCharacterCompat.findCharacterIndex = function (name) {
        const target = name === undefined || name === null ? 'current' : name;
        const list = th134CharacterList();
        for (let i = 0; i < list.length; i += 1) {
          const item = list[i];
          if (!item) continue;
          if (String(item.name || '') === String(target)) return i;
          if (th134AvatarBaseName(item.avatar) === String(target)) return i;
        }
        return -1;
      };
      RawCharacterCompat.getChatsFromFiles = function () {
        throw new Error('TavernHelper: RawCharacter.getChatsFromFiles 在本仓未实现（聊天文件面不同源）');
      };
      RawCharacterCompat.prototype.getCardData = function () {
        return this.__data || {};
      };
      RawCharacterCompat.prototype.getAvatarId = function () {
        const avatar = this.__data && this.__data.avatar ? String(this.__data.avatar) : '';
        return th134AvatarBaseName(avatar);
      };
      RawCharacterCompat.prototype.getRegexScripts = function () {
        const ext = this.__data ? this.__data.extensions : null;
        const scripts = ext && typeof ext === 'object' ? ext.regex_scripts : null;
        return Array.isArray(scripts) ? scripts : [];
      };
      RawCharacterCompat.prototype.getCharacterBook = function () {
        const book = this.__data ? this.__data.character_book : null;
        return book && typeof book === 'object' ? book : null;
      };
      RawCharacterCompat.prototype.getWorldName = function () {
        const ext = this.__data ? this.__data.extensions : null;
        const world = ext && typeof ext === 'object' ? ext.world : null;
        return world === undefined || world === null ? '' : String(world);
      };
      return RawCharacterCompat;
    })(),
    // displayed_message / util / global
    formatAsDisplayedMessage: th134FormatAsDisplayedMessage,
    // [批次Q1 2026-10-21] 用户第三次裁定后放开：本机/内网默认给 allow-same-origin ⇒
    // 帧内终于能读主页面那条消息的真实 DOM。读不到（公网未授信 / 楼层没渲染 / 没有 .mes_text）
    // 一律诚实返回 null 并走 palinkDiag 留痕，⛔ 不返回假字符串/假对象凑数。
    retrieveDisplayedMessage: th134RetrieveDisplayedMessage,
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
    // [包Z 批次三 macro_register → 包AA C 2026-10-20 放行成员形态]
    // 一手依据：st-plugins/third-party/JS-Slash-Runner-main/@types/function/index.d.ts:98
    //   'readonly registerMacroLike' 就写在 **TavernHelper 的成员清单**里（同清单含 deleteLorebook 等），
    //   ⇒ 成员形态是上游真实存在的形状，不是我们造的。
    // 包Z 当时没加这一行，是因为底层实现还没交付前它属包H 的 D 类（未实现），
    // 而"D 类键一个都没注册"是**诚实红线**；现在实现已在 part-03（registerMacroLikeCompat，
    // 主脑复跑 10/10 绿）并经下面 :1410 附近的 setCompatFunction 暴露成窗口全局 ⇒ 成员键有实物。
    // 用 th134Bridge 桥到**同一个**窗口全局函数（与真实卡按全局调用的那份实现完全同一），
    // 不复制第二份逻辑；桥在实现缺席时 warn + undefined，不造返回值。
    registerMacroLike: th134Bridge('registerMacroLike'),
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
    try { Object.defineProperty(proxy, '__palinkTavernHelperProxy', { value: true, configurable: true }); } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-07:tavernhelper-proxy-marker', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) }
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
      // [包W 2026-10-19] 返回值一字未改（仍是空串），但这条「装作会」的路径现在必须留痕：
      // 命令被真调用过、宿主引擎没有它 ⇒ host_capability（该谁修：宿主命令表 / 后端能力面）。
      if (bridgedResult.indexOf('Error: Unknown command') === 0) {
        // 存在性守卫见 part-06 同注释（切片夹具里没有记录器）。
        if (typeof palinkDiagRecord === 'function') palinkDiagRecord({
          owner: 'host_capability',
          kind: 'slash_command_unimplemented',
          name: lowerName,
          detail: '帧内 slash 桥接到宿主引擎后得到 ' + bridgedResult.slice(0, 160) + '；返回值按既有约定折成空串，卡侧无感',
          stack: String((bridged && bridged.stack) || ''),
          textLength: String(text || '').length,
        });
        return '';
      }
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
  // [包AA A 2026-10-20] 别名**进表**（此前是包Z §2.4 的待裁决遗留，主脑已裁决按 ST 补）。
  // 依据一手：slash-commands/SlashCommandParser.js:95 'this.commands[command.name] = command;'、
  // :97-100 'command.aliases.forEach((alias) => { this.commands[alias] = command; });'
  // ⇒ ST 的 Object.keys(commands) 里**本来就有别名**，而且 commands[alias] 与 commands[base]
  //   是同一个对象（不是两份）。重名时 :79-82 只 console.trace 告警，:95/:99 照样赋值。
  // 这张表只记 alias 到 base 的**指向**，不新增独立命令条目：取值仍解析到 base 的那一个 entry。
  const slashKnownAliasesCompat = new Map();
  // [API-8b 2026-10-26] 可执行面观察集：宿主引擎真注册的名字（同一种子响应的 implemented 键）。
  // 只读不改表：commands 的键集仍是「真注册 ∪ 权威主名 ∪ 别名」三源并集，不受本集影响。
  const slashImplementedNamesCompat = new Set();
  // 合成项缓存：主名每次取值必须是同一个对象（ST 表里存的是注册时那个对象），
  // 否则 commands[alias] 与 commands[base] 会各自 new 一份，「同一个对象」这条语义就守不住。
  const slashSynthEntryCacheCompat = new Map();
  // [API-8b 2026-10-26] 纯加性来源标记：合成项一律带 __palinkSeedOnly=true，帧内真注册
  // （registerSlashCommandCompat 进 Map）不带这个键 ⇒ 卡与探针面有抓手分辨「真注册」与
  // 「种子合成」（此前 helpString 恒空串、callback 恒为函数，两者完全不可分辨）。
  // 语义只是「来源 = 种子合成」；能不能真执行由 window.__palinkSlashImplementedNames 给出。
  const synthesizeSlashEntryCompat = (name) => ({
    name,
    aliases: [],
    helpString: '',
    __palinkSeedOnly: true,
    callback: (args) => executeSlashCommandCompat('/' + name + (args ? ' ' + args : '')),
  });
  const resolveSlashEntryCompat = (name) => {
    const existing = slashCommandStoreCompat.get(name);
    if (existing) return existing;
    // 顺序照 ST 的表语义：真注册过的（Map 本体）优先 ⇒ 主名次之 ⇒ 别名最后折到主名。
    // 对账实测权威主名与别名**交集为 0**（.tmp_probe/AA/reconcile_out.txt），
    // 所以第三条分支不会把某个真命令名盖掉；宿主名单之外也不会凭空造键。
    // [批次E 2026-10-20 · 别名面形状差异 ②] 重名裁决 = 有意偏离（我们比 ST 保守）。
    // 一手核实：ST 的别名 'help' → '?' 注册于 slash-commands.js:658-661；
    // SlashCommandParser.js:79-82 对重名只 console.trace 告警，:95/:99 照常赋值
    // ⇒ 后注册者覆盖，ST 没有"主名优先"这个概念。我们让 Palink 自有 help（宿主真命令，
    // 经 /help 解析进主名名单）优先占位：折到 '?' 会让 /help 行为漂移到 ST 侧。
    // 这是有意偏离，e-package 测试钉住优先级，⛔ 不许改成别名优先。
    if (slashKnownNamesCompat.has(name)) {
      const cachedByName = slashSynthEntryCacheCompat.get(name);
      if (cachedByName) return cachedByName;
      const createdByName = synthesizeSlashEntryCompat(name);
      slashSynthEntryCacheCompat.set(name, createdByName);
      return createdByName;
    }
    const baseName = slashKnownAliasesCompat.get(name);
    if (!baseName || !slashKnownNamesCompat.has(baseName)) return undefined;
    const cached = slashSynthEntryCacheCompat.get(baseName);
    if (cached) return cached;
    const created = synthesizeSlashEntryCompat(baseName);
    slashSynthEntryCacheCompat.set(baseName, created);
    return created;
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
      // [包AA A 2026-10-20] 同一个种子里的别名表（alias → base）。
      // **计数口径分家**：__palinkSlashSeedNamesCount 仍是「权威主名数」，必须保持 293；
      // 别名只登记到 slashKnownAliasesCompat，另给一个 __palinkSlashSeedAliasCount（176），
      // 表内键计数由 Object.keys(commands) 自己反映（主名 ∪ 别名），两者不许混成一个数。
      // 宿主没给 aliases 时这里就是空操作 ⇒ 退回修复前的表形状（不炸、不凭空造键）。
      const seedAliases = seedResponse && seedResponse.aliases && typeof seedResponse.aliases === 'object'
        ? seedResponse.aliases
        : null;
      if (seedAliases) {
        for (const aliasKey of Object.keys(seedAliases)) {
          const aliasBaseName = seedAliases[aliasKey];
          // 只承认「主名本身在权威名单里」的别名：不认识的主名不发明键（红线：不造 ST 没有的形状）。
          if (!aliasKey || typeof aliasBaseName !== 'string' || !aliasBaseName) continue;
          if (!slashKnownNamesCompat.has(aliasBaseName)) continue;
          slashKnownAliasesCompat.set(aliasKey, aliasBaseName);
        }
      }
      // [API-8b 2026-10-26] 同一响应的 implemented（宿主引擎真注册名）落观察面。纯加性：
      // 宿主没发（旧形状）时是空操作，与 aliases 同一条「退回修复前形状」纪律，不炸、不凭空造名字。
      const seedImplemented = seedResponse && Array.isArray(seedResponse.implemented) ? seedResponse.implemented : [];
      for (const implementedName of seedImplemented) {
        if (typeof implementedName === 'string' && implementedName) slashImplementedNamesCompat.add(implementedName);
      }
      window.__palinkSlashSeedNamesCount = seedNames.length;
      window.__palinkSlashSeedAliasCount = slashKnownAliasesCompat.size;
      window.__palinkSlashKnownNames = Array.from(slashKnownNamesCompat);
      window.__palinkSlashKnownAliases = Array.from(slashKnownAliasesCompat.keys());
      window.__palinkSlashImplementedNames = Array.from(slashImplementedNamesCompat);
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
      // keys/values 等仍走 Map 本体 —— keys() 返回的是 Map 原型语义，
      // 三方与探针的取键口径一律是 Object.keys(commands)（见 fixtures/README.md）。
      // （get 自批次E起不再直通 Map，改走与 [] 相同的解析路径，见下一段注释。）
      if (prop === 'has') {
        return (name) => target.has(name)
          || slashKnownNamesCompat.has(String(name))
          || slashKnownAliasesCompat.has(String(name));
      }
      // [批次E 2026-10-20 · 别名面形状差异 ③] commands.get(别名) 与 [] 同路径。
      // 一手核实 ST 1.18.0（_reference/sillytavern-1.18.0/public/scripts/slash-commands/
      // SlashCommandParser.js）：commands 是普通对象（:44 'static commands = {}'），对象上
      // **没有 .get() 方法**（:105-107 的 'get commands()' 是 parser 实例的取值器，
      // 不是 commands 对象的方法）⇒ 我们的 .get 是**多出来的便利面**，不是 ST 形状。
      // 此前它被直通成 Map.get（只认真注册项，主名/别名合成项一律 undefined），与
      // commands[name] 的执行路径分裂；本批按内部一致性接到 resolveSlashEntryCompat
      // （Map 本体 > 主名 > 别名），未知名照旧返回 undefined。不对外宣称这是 ST 行为。
      if (prop === 'get') return (name) => resolveSlashEntryCompat(String(name));
      // [批次E 2026-10-20 · 别名面形状差异 ①] delete 等 Map 方法占位 = 保持现状，理由：
      // 一手核实 ST 1.18.0 没有任何"删命令"的公开路径 —— SlashCommandParser.js 全文
      // （1357 行）的写入 API 只有 addCommand(:53) / addCommandObject(:65) /
      // addCommandObjectUnsafe(:78) 三个，且对 public/scripts 全树 grep
      // deleteCommand / removeCommand 零命中。
      // ⇒ 按派包口径"ST 没有对应语义就保持现状"：commands.delete 继续是 Map 的删除方法，
      //   别名键 'delete'(→del) 被该方法占位是已知形状差异（f-package 测试已记账）；
      //   ⛔ 不造"能删命令"的行为：没有 deleteCommand、也没有把别名键从表里摘掉的新能力。
      // deleteProperty（delete commands[x]）同样维持现状：Map 本体的键可删；别名/主名
      // 来自宿主种子，视图层删不掉，也不新造删除能力。
      if (
        prop === 'has' || prop === 'set' || prop === 'delete' || prop === 'clear'
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
      // [包AA A] 别名同样是表里的键（ST SlashCommandParser.js:97-100）⇒ in 判定要认它。
      return target.has(prop) || slashKnownNamesCompat.has(prop) || slashKnownAliasesCompat.has(prop);
    },
    set(target, prop, value) {
      if (typeof prop !== 'string') return true;
      target.set(prop, value);
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop !== 'string') return true;
      // [批次E 2026-10-20] 保持现状（ST 无"删命令"公开路径，完整理由见 get 陷阱同批注释）：
      // Map 本体的键可删；别名/主名来自宿主种子，视图层删不掉，也不新造删除能力。
      return target.delete(prop);
    },
    ownKeys(target) {
      // [包AA A] 表内键 = 真注册项 ∪ 权威主名 ∪ 别名（ST 的 commands 就是这三者的并集，
      // 见 SlashCommandParser.js:95/:97-100）。键数由此上涨，与「权威名计数」是两个口径。
      return Array.from(new Set([
        ...target.keys(),
        ...slashKnownNamesCompat,
        ...slashKnownAliasesCompat.keys(),
      ]));
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
  // [包Z 批次三 macro_register] 窗口全局入口（卡脚本按助手习惯直接调全局函数）。
  // 契约：JS-Slash-Runner-main/@types/function/macro_like.d.ts:27-37。
  setCompatFunction('registerMacroLike', (regex, replace) => registerMacroLikeCompat(regex, replace));
  setCompatFunction('unregisterMacroLike', (regex) => unregisterMacroLikeCompat(regex));
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
  // [批次C C-1 2026-10-20] tokenizers 从空壳改为**照抄 ST 的静态枚举**。
  // 一手锚点：_reference/sillytavern-1.18.0/public/scripts/tokenizers.js:16-38
  //   export const tokenizers = { NONE:0, GPT2:1, OPENAI:2, LLAMA:3, NERD:4, NERD2:5,
  //   API_CURRENT:6, MISTRAL:7, YI:8, API_TEXTGENERATIONWEBUI:9, API_KOBOLD:10, CLAUDE:11,
  //   LLAMA3:12, GEMMA:13, JAMBA:14, QWEN2:15, COMMAND_R:16, NEMO:17, DEEPSEEK:18,
  //   COMMAND_A:19, BEST_MATCH:99 }
  // ST 侧它就不是子系统，而是一张常量表（唯一消费者是按枚举值选分词器）。
  // 此前给 {} ⇒ 卡写 getTokenCountAsync(text, tokenizers.OPENAI) 传的是 undefined，
  // 静默退化成默认分词器。这里逐值照抄，不增不减字段（造字段=假实现）。
  // 已有同名全局时以既有值为准（不覆盖别人写入的键）。
  window.tokenizers = Object.assign(
    {
      NONE: 0, GPT2: 1, OPENAI: 2, LLAMA: 3, NERD: 4, NERD2: 5,
      API_CURRENT: 6, MISTRAL: 7, YI: 8, API_TEXTGENERATIONWEBUI: 9, API_KOBOLD: 10,
      CLAUDE: 11, LLAMA3: 12, GEMMA: 13, JAMBA: 14, QWEN2: 15, COMMAND_R: 16,
      NEMO: 17, DEEPSEEK: 18, COMMAND_A: 19, BEST_MATCH: 99,
    },
    window.tokenizers && typeof window.tokenizers === 'object' ? window.tokenizers : {},
  );
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
    terminate() { try { this.worker?.terminate?.(); } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-07:worker-terminate', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } }
    postMessage(message) { try { this.worker?.postMessage?.(message); } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-07:worker-postmessage', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } }
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
