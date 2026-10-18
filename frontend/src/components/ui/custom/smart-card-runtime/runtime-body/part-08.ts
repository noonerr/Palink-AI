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
    // [T6 2026-10-18] loadWorldInfo 不再是桩：T3 已合入 getCharWorldbook 桥取真实条目，
    // 拆掉 stubApi 包装以免每帧产一条误报警告 toast。键保留在外部文档表里供卡作者参考。
    // [包B B-3 2026-10-18] 删 saveWorldInfo：已改为真写入（桥 createOrReplaceWorldbook）。
    // [包G G-1 2026-10-18] 本表按「仍是桩」的口径重写。以下 13 项已换真实现或**诚实失败**，
    // 同时从 stubApi 包裹中移除（逐项处置见 buildPowerUserSettingsCompat 起的那一段注释，
    // 编号对应 HANDOFF §2.1）：
    //   #1 powerUserSettings  #2 getChatCompletionModel  #3 getTextGenServer
    //   #4 convertCharacterBook  #5 getWorldInfoPrompt  #6 updateWorldInfoList
    //   #7 reloadWorldInfoEditor  #8 appendMediaToMessage  #9 getMediaDisplay
    //   #10 getMediaIndex  #11 scrollOnMediaLoad  #12 renameChat  #13 createCharacterData
    // 留在表里的只剩两类，都是**故意不补**：
    //   · getRequestHeaders —— 安全决策待用户拍板（给真实头 = 把 palink_session/palink_csrf
    //     送进 opaque origin 帧，与 P1-1 沙箱红线冲突，见路线图 §4）。
    //   · getSelectedPresetName / writePresetExtensionField —— ST 预设体系，Palink 结构
    //     不同，硬补=形状对语义错（getPresetManager 同理由，故它连本表都不进）。
    getSelectedPresetName: 'Palink 无独立 preset 概念，硬编码占位名',
    writePresetExtensionField: '写入为假成功（返回 true 但不落库）',
    getRequestHeaders: 'Palink 由 api 服务统一注入认证头，此处恒空对象',
    'fetch:/api/worldinfo': 'iframe 侧 fetch 白名单对 /api/worldinfo 恒返回空 entries/data（真实内容走 getLorebookEntries 桥，见 SPEC T3）',
  };
  const stubApiReported = {};
  const reportStubApi = (apiName, note) => {
    const key = String(apiName || '');
    if (!key || stubApiReported[key]) return;
    stubApiReported[key] = true;
    try {
      reportDiagnostic({
        // [T6 2026-10-18] 从 warning 降为 info：桩命中是"兼容性提示"，不是用户可处理的
        // 错误。宿主 handleSmartCardCompatDiagnostic 只对 severity !== 'info' 弹 toast
        // ⇒ 降级后只进 console + 诊断通道，不再在右上角刷屏（用户主诉"顶部弹出很多报错"）。
        severity: 'info',
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
  // [包B B-3 2026-10-18] ST 1.18 有、此前单间轨缺的 9 个 getContext 键的配套实现。
  //
  // registerHelper / registerDebugFunction：ST 语义是"登记后返回 void"，这里真的写进
  //   一张表（不是空转），便于插件自检；无可观测副作用，因此不归入 stubApi（桩的判据
  //   是 reportStubApi 留痕，这两个不属于"假成功"）。
  // chatCompletionSettings / textCompletionSettings：ST 里这两个是**可写对象**，
  //   MVU 会写 runtimes.is_function_call_enabled。本段上方记过的教训是"给空对象会在
  //   写 runtimes.* 时 TypeError" ⇒ 必须带 runtimes 子对象；且必须是**同一实例**
  //   （每次新建会让写入丢失，MVU 会以为工具调用被关掉）。
  const registeredHelpersCompat = {};
  const registeredDebugFunctionsCompat = {};
  const buildCompletionSettingsCompat = () => {
    const preset = parseMaybeJsonObject(ctx.presetData, {});
    const base = preset && typeof preset === 'object' ? preset : {};
    const runtimes = base.runtimes && typeof base.runtimes === 'object' ? base.runtimes : {};
    return {
      ...base,
      runtimes: {
        ...runtimes,
        is_function_call_enabled: runtimes.is_function_call_enabled === true,
      },
    };
  };
  const chatCompletionSettingsCompat = buildCompletionSettingsCompat();
  const textCompletionSettingsCompat = buildCompletionSettingsCompat();

  // ══════════════════════════════════════════════════════════════════════════
  // [包G G-1 2026-10-18] getContext 真问题项的帧内真实现。
  // 逐项处置表：docs/_active/HANDOFF_提示词_包G_getContext与libs补齐_2026-10-18.md §2.1
  // 交付报告：docs/_active/report/REPORT_包G_getContext与libs_2026-10-18.md
  // 红线：**不许假成功** —— 能接真通道就接真值，接不到的诚实返回 false / '' 并留痕；
  // 修完的项一律拆掉 stubApi 包装（stubApi 每次调用产一条 st_api_stub 诊断，
  // 是卡脚本调几次就弹几个 toast 的噪音源，见 :127 reportStubApi）。
  // 14 号 getRequestHeaders（安全决策待用户拍板）与 15 号 getPresetManager
  //（架构红线：Palink 预设体系与 ST 结构不同）**按拍板保持原样，本批未动**。
  // ══════════════════════════════════════════════════════════════════════════

  // #1 powerUserSettings / power_user ——
  // 宿主侧同语义实现见 lib/sillytavern/getContext.ts:3225-3235：读
  // window.__palink_power_user（当前**没有写入者** ⇒ 落那份默认值）。
  // 帧内取同样的三级优先级：宿主经 ctx 注入 > 帧内 __palink_power_user > 宿主默认值。
  // ⚠️ 不许留空对象：空对象在真机探针口径里就是「非真可用」，且卡脚本读
  // powerUserSettings.font_size 会拿到 undefined。language 用 ctx.language（宿主真值）。
  const buildPowerUserSettingsCompat = () => {
    const defaults = {
      font_size: 14,
      language: String(ctx.language || 'zh-CN'),
      persona_show_user_name: false,
      // ST power_user 的两项媒体相关默认值（本表 #9/#11 消费它们）。
      scroll_on_media_load: true,
      media_display: 'inline',
    };
    const injected = (ctx.powerUserSettings && typeof ctx.powerUserSettings === 'object')
      ? ctx.powerUserSettings
      : (window.__palink_power_user && typeof window.__palink_power_user === 'object' ? window.__palink_power_user : {});
    return Object.assign(defaults, clone(injected));
  };
  const powerUserSettingsCompat = buildPowerUserSettingsCompat();
  // 同一实例发布到 window.power_user：part-06 的 ensureObject('power_user', {}) 只给了
  // **空对象**，而 ST 侧插件普遍直读全局（本运行时里 part-02:354 的 power_user 访问器、
  // part-06:652 的 /api/settings/get 响应都在读它）⇒ 只补 getContext 不够，全局也得是真值。
  // 用赋值而非 ensureObject，保证与 ctx.powerUserSettings 是**同一个引用**（ST 就是同一对象）。
  try {
    window.power_user = powerUserSettingsCompat;
  } catch (e) { /* 全局被占用时静默：getContext 那份仍是真值 */ }

  // #2 getChatCompletionModel —— 真值 = 宿主当前选择的模型名。
  // 通道：CharacterChat.tsx 的 selectedModel（同一份值已喂给 generationEngine.setContext）
  //   → Message.tsx 传给渲染器的 context.selectedModel
  //   → 帧内 ctx（boot 白名单 + context-update 全量 Object.assign 都带）。
  // 宿主尚未注入时返回 ''（诚实空值，不编造模型名）。
  const getChatCompletionModelCompat = () => String(ctx.selectedModel || ctx.model || '');

  // #3 getTextGenServer —— ST 语义 = 返回**已配置的 textgen 后端**服务器 URL；
  // mainApi 不是 textgen 时 ST 自己同样返回空串。Palink 没有独立 textgen 服务器
  //（mainApi 恒 'palink'）⇒ 空串就是诚实值，不是缺失。只接受宿主显式注入的
  // ctx.textGenServer（当前无写入者）。此前挂 stubApi 只会白弹诊断，已拆。
  const getTextGenServerCompat = async () => String(ctx.textGenServer || '');

  // #4 convertCharacterBook —— ST 侧把 V2 character_book（entries 为数组）转成
  // world_info 形状；Palink 后端存的**已经是 ST 形状**（entries 带 uid/content/keys/
  // comment，见 SmartCardCompatController.ts mapCharBookStagesToEntries:370-377）
  // ⇒ 恒等映射是**语义正确**的实现，不是占位假实现。stubApi 已拆。
  const convertCharacterBookCompat = (book) => (book && typeof book === 'object' ? book : {});

  // #5 getWorldInfoPrompt —— 复用同帧 loadWorldInfo 的取数通道（requestParent
  // 'getCharWorldbook'，卡自建优先、缺失回退角色 character_book），把**启用**条目
  // 按插入顺序组装成提示词串。宿主轨 lib/sillytavern/getContext.ts:2330 的同名 API
  // 返回口径也是 string，两轨一致；无条目返回 ''（ST 空世界书同样返回空）。
  // ⚠️ 实际注入仍由后端 worldbook_service.build_worldbook_context 完成，本函数是
  // 给卡/插件看的展示口径（与宿主轨 F-1 的注记同义）。
  const getWorldInfoPromptCompat = async () => {
    try {
      const detail = await requestParent('getCharWorldbook', { args: [] });
      const list = detail && Array.isArray(detail.entries) ? detail.entries : [];
      const ordered = list
        .filter((entry) => entry && typeof entry === 'object')
        .filter((entry) => entry.disabled !== true && entry.enabled !== false)
        .slice()
        .sort((a, b) => Number(a.insertion_order ?? a.order ?? a.insert_order ?? 100)
          - Number(b.insertion_order ?? b.order ?? b.insert_order ?? 100));
      const parts = [];
      ordered.forEach((entry) => {
        const content = String(entry.content ?? '').trim();
        if (content) parts.push(content);
      });
      return parts.join('\\n');
    } catch (e) {
      post({ type: 'log', level: 'warn', message: 'getWorldInfoPrompt 桥接失败，返回空提示词：' + String(e && e.message || e) });
      return '';
    }
  };

  // #6 updateWorldInfoList —— ST 语义 = 重拉世界书列表（world_names，
  // world-info.js:2061 走 /api/settings/get）。Palink 每角色绑定一份 character_book
  // ⇒ 列表就是"当前角色绑定的那一本"，经既有 getCharWorldbook 桥刷新 window.world_names
  //（getContext().getWorldInfoNames 读的就是这个数组）。桥失败时保留现状并 warn。
  const updateWorldInfoListCompat = async () => {
    try {
      const detail = await requestParent('getCharWorldbook', { args: [] });
      const name = String((detail && detail.name) || activeWorldbookName || ctx.worldbookName || '').trim();
      const next = name ? [name] : [];
      window.world_names = next;
      if (name) activeWorldbookName = name;
      return next.slice();
    } catch (e) {
      post({ type: 'log', level: 'warn', message: 'updateWorldInfoList 桥接失败，保留现有世界书列表：' + String(e && e.message || e) });
      return Array.isArray(window.world_names) ? window.world_names.slice() : [];
    }
  };

  // #7 reloadWorldInfoEditor —— 帧内**没有**世界书编辑器 UI（world-info.js:1040 的
  // reloadEditor 只重画 #world_editor_select 下拉框）。本函数不写任何数据、无副作用
  // 可失败 ⇒ 恒真是 by design，不是假成功；拆掉 stubApi 以免弹诊断噪音。
  const reloadWorldInfoEditorCompat = async () => true;

  // #8 appendMediaToMessage —— ST 侧是"把媒体画进消息块 DOM"（script.js:2157）；
  // Palink 的权威口径是 message.extra.media（服务端快照，Message.tsx:1610 只认它）。
  // ⇒ 帧内实现为：推进 extra.media 后经**既有** setChatMessage 父侧通道落库
  //（part-05.ts:557 setChatMessageCompat 合并 extra → requestParent('setChatMessage')
  // → SmartCardCompatController.ts:827 → CharacterChat.tsx applySmartCardMessageUpdate
  // → PUT 消息）。找不到消息 / 拿不出可用媒体 ⇒ 返回 false（诚实失败）。
  const resolveFrameMessageIndex = (mesOrId, options = {}) => {
    try {
      if (mesOrId && typeof mesOrId === 'object') {
        const byId = compatChat.findIndex((message) => String(message?.id) === String(mesOrId.id ?? mesOrId.message_id ?? '')
          || String(message?.message_id) === String(mesOrId.message_id ?? mesOrId.id ?? ''));
        if (byId >= 0) return byId;
        const byMesid = Number(mesOrId.mesid ?? mesOrId.index);
        if (Number.isInteger(byMesid) && byMesid >= 0 && byMesid < compatChat.length) return byMesid;
      }
      return resolveMessageIndex(mesOrId, options);
    } catch (e) {
      return -1;
    }
  };
  const resolveFrameMessage = (mesOrId) => {
    const index = resolveFrameMessageIndex(mesOrId);
    if (index < 0 || index >= compatChat.length) return null;
    return compatChat[index] || null;
  };
  const newFrameMediaIdCompat = () => {
    // 形态对齐后端 new_media_id 与前端 lib/messageMedia.ts:74 newMediaId：m_ + 12 位十六进制。
    let hex = '';
    while (hex.length < 12) hex += Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
    return 'm_' + hex.slice(0, 12);
  };
  const normalizeFrameMediaEntry = (value) => {
    const urlOf = (candidate) => String(candidate?.url ?? candidate?.path ?? candidate?.src ?? '').trim();
    if (typeof value === 'string') {
      const url = value.trim();
      if (!url) return null;
      return { id: newFrameMediaIdCompat(), status: 'ready', url, width: null, height: null, created_at: new Date().toISOString() };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const url = urlOf(value);
    // 既无 url 又无既有 id 的对象（ST 侧传的是 jQuery 消息元素）在这里无法映射 ⇒ 诚实失败。
    if (!url && !value.id) return null;
    const status = value.status === 'pending' || value.status === 'failed' ? value.status : 'ready';
    const next = clone(value);
    next.id = String(value.id || newFrameMediaIdCompat());
    next.status = status;
    if (url) next.url = url;
    return next;
  };
  const appendMediaToMessageCompat = async (mesOrId, fileOrElement) => {
    const index = resolveFrameMessageIndex(mesOrId);
    const target = index >= 0 && index < compatChat.length ? compatChat[index] : null;
    if (!target) return false;
    // ST 签名是 (mes, messageElement)；Palink 卡/插件常见第二种传参直接给媒体对象/URL。
    // ⚠️ 只认**第二参**为媒体来源（第二参缺省时才回退看第一参是不是媒体对象本身）。
    // 不做"第二参不是媒体就退回去把消息 id 当 URL"的猜测 —— ST 传 jQuery 元素时
    // 那样会拿消息 id 当地址写进 extra.media，是假成功。映射不出来一律 false。
    const mediaInput = fileOrElement === undefined || fileOrElement === null ? mesOrId : fileOrElement;
    const entry = normalizeFrameMediaEntry(mediaInput);
    if (!entry) return false;
    const mediaList = Array.isArray(target.extra?.media) ? clone(target.extra.media) : [];
    mediaList.push(entry);
    const nextExtra = { ...(target.extra && typeof target.extra === 'object' ? clone(target.extra) : {}), media: mediaList };
    if (Number.isInteger(nextExtra.media_index) === false) nextExtra.media_index = mediaList.length - 1;
    // content 传 undefined：normalizeMessageUpdatePayload(part-05:490) 据此判定
    // "无显式内容"，只合并 extra，不会把正文抹成空串。
    const result = await setChatMessageCompat(undefined, target.message_id ?? target.id ?? index, { extra: nextExtra });
    return Boolean(result && result.success !== false);
  };

  // #9 getMediaDisplay —— 真值 = message.extra.media_display。
  // Palink 侧合法取值是 inline / gallery（lib/messageMedia.ts:141），ST 侧是 inline / list
  //（script.js:2130）⇒ 三值原样透传，缺省落偏好值 power_user.media_display，再兜 'inline'。
  const getMediaDisplayCompat = (mesOrId) => {
    const message = resolveFrameMessage(mesOrId);
    const stored = String(message?.extra?.media_display || '').trim();
    if (stored === 'inline' || stored === 'gallery' || stored === 'list') return stored;
    const pref = String(powerUserSettingsCompat.media_display || '').trim();
    if (pref === 'inline' || pref === 'gallery' || pref === 'list') return pref;
    return 'inline';
  };

  // #10 getMediaIndex —— 真值 = message.extra.media_index。
  // 无媒体 ⇒ -1（包G 处置表口径；注意 ST 源码在此情形返回 0，差异已在报告记录）。
  // 有媒体但索引越界/非法 ⇒ 0（与 ST script.js:2140 一致）。
  const getMediaIndexCompat = (mesOrId) => {
    const message = resolveFrameMessage(mesOrId);
    const media = message?.extra?.media;
    if (!Array.isArray(media) || media.length === 0) return -1;
    const raw = Number(message?.extra?.media_index);
    if (!Number.isFinite(raw) || raw < 0 || raw >= media.length) return 0;
    return raw;
  };

  // #11 scrollOnMediaLoad —— ST 是**函数**（script.js:1532：媒体加载完后滚到底），
  // 开关是 power_user.scroll_on_media_load。帧内保留函数形态（卡/插件按 ST 用法调用），
  // 真值口径 = 偏好：偏好为真时走本帧既有 scrollChatToBottom 桥，返回是否执行；
  // 偏好为 false 时不滚动并返回 false。缺省 true（ST 默认）。stubApi 已拆。
  const scrollOnMediaLoadCompat = () => {
    const enabled = powerUserSettingsCompat.scroll_on_media_load !== false;
    if (!enabled) return false;
    try {
      if (typeof window.scrollChatToBottom === 'function') {
        window.scrollChatToBottom();
        return true;
      }
    } catch (e) { /* 静默：滚动失败不值得打断卡脚本 */ }
    return enabled;
  };

  // #12 renameChat —— **诚实失败**。
  // 已核实：单间轨没有任何可改会话标题的父侧通道（SmartCardCompatController.ts 的
  // requestParent 动作表里没有 rename 类动作），故帧内无法完成改名 ⇒ 返回 false +
  // 一次性 console.warn 留痕。不许假成功返 true。
  // ⚠️ 后续项（写进包G 报告）：宿主轨 lib/sillytavern/getContext.ts:2439 走的
  // POST /api/chats/rename-session（backend/app/api/silly_tavern.py:5838）是**存在且真改库**的，
  // 缺的只是给单间轨补一个 requestParent 动作；补上即可把本函数换成真实现。
  let renameChatWarnedCompat = false;
  const renameChatCompat = async () => {
    if (!renameChatWarnedCompat) {
      renameChatWarnedCompat = true;
      try {
        console.warn('[palink-smart-card] getContext().renameChat：单间轨未接会话改名通道（宿主轨用的 POST /api/chats/rename-session 尚未桥到帧内），返回 false。后续项见 docs/_active/report/REPORT_包G_getContext与libs_2026-10-18.md');
      } catch (e) { /* console 被治理时静默 */ }
    }
    return false;
  };

  // #13 createCharacterData —— ST 默认角色数据模板。
  // 逐键照抄 _reference/sillytavern-1.18.0/public/script.js:569-592 的 create_save
  //（注意 ST 用 first_message / mes_example，不是卡 JSON 的 first_mes / mes_example）；
  // 三个默认量取 ST constants：talkativeness_default=0.5、depth_prompt_depth_default=4、
  // depth_prompt_role_default='system'。此前恒 {} ⇒ 卡脚本 createCharacterData.name = x 直接炸。
  const createCharacterDataCompat = {
    name: '',
    description: '',
    creator_notes: '',
    post_history_instructions: '',
    character_version: '',
    system_prompt: '',
    tags: '',
    creator: '',
    personality: '',
    first_message: '',
    avatar: null,
    scenario: '',
    mes_example: '',
    world: '',
    talkativeness: 0.5,
    alternate_greetings: [],
    depth_prompt_prompt: '',
    depth_prompt_depth: 4,
    depth_prompt_role: 'system',
    extensions: {},
    extra_books: [],
  };

  const getContextCompat = () => ({
    accountStorage: accountStorageCompat,
    chat: window.chat,
    characters: window.characters,
    groups: window.groups,
    getGroups: window.getGroups,
    getGroupChat: window.getGroupChat,
    name1: ctx.userName,
    name2: ctx.characterName,
    // [包M 2026-10-18 主控自修] 帧内身份链路取证订正：
    //   ① Palink 从没给帧内设过 window.this_chid ⇒ 原写法让 ST 侧唯一被读的
    //      getContext().characterId 恒为 undefined（包E/包J 报的「恒 0」其实是这里的下游症状，
    //      不是宿主 getContext.ts 的 Number(uuid)=NaN 兜底）。ST 语义是 characters 数组下标，
    //      Palink 卡帧里 characters 为空 ⇒ **诚实给 0，不填假值**。
    //   ② Palink 的真实角色标识是 boot ctx 里那个 UUID 字符串（本帧以 characterUuid 暴露）。
    //      与父侧 lib/sillytavern/getContext.ts 的包J J-2 保持同键名，插件 camel/snake 两种写法都读得到。
    //   ③ 帧内**不存在** window.context 这个全局（boot 的 ctx 是 const，不挂 window）——
    //      这是与 ST 的又一处形状缺口，本包不顺手补，登记在 docs/OPEN_ISSUES.md。
    characterId: (typeof window.this_chid === 'number' && Number.isFinite(window.this_chid)) ? window.this_chid : 0,
    characterUuid: ctx.characterId,
    characterIdString: ctx.characterId || '',
    palink_character_id: ctx.characterId || '',
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
    // [包G G-1 #12] 后端无帧内可用的改名通道 ⇒ 诚实返回 false（详见 renameChatCompat 注释）。
    renameChat: renameChatCompat,
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
    // [包J J-3 2026-10-18] 反斜杠必须成对写：本文件是模板字符串，单反斜杠会被求值吞掉，
    // 空字符类正则会退化成「按字母 s 切词」。与 part-07 的同名实现写法保持一致。
    getTextTokens: (text) => String(text ?? '').split(/\\s+/).filter(Boolean),
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
    // [包G G-1 #1] 真值三级优先：宿主 ctx 注入 > 帧内 __palink_power_user > 宿主默认值
    //（与 lib/sillytavern/getContext.ts:3225-3235 同语义）。不再留空对象。
    powerUserSettings: powerUserSettingsCompat,
    power_user: powerUserSettingsCompat,
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
    // [包B B-3 2026-10-18] 补齐 ST 1.18 有、单间轨缺的 9 个键。
    // 前三个的实现在本帧早已存在（TavernHelper 上有，只是没挂到 getContext 契约上）。
    timestampToMoment: timestampToMomentCompat,
    uuidv4: window.uuidv4,
    humanizedDateTime: humanizedDateTimeCompat,
    registerHelper: (name, fn) => {
      const key = String(name || '');
      if (key) registeredHelpersCompat[key] = fn;
    },
    registerDebugFunction: (name, fn) => {
      const key = String(name || '');
      if (key) registeredDebugFunctionsCompat[key] = fn;
    },
    renderExtensionTemplate: window.renderExtensionTemplate,
    renderExtensionTemplateAsync: window.renderExtensionTemplateAsync,
    chatCompletionSettings: chatCompletionSettingsCompat,
    textCompletionSettings: textCompletionSettingsCompat,
    tags: [],
    tagMap: {},
    menuType: ctx.presentationMode || 'chat',
    // [包G G-1 #13] ST create_save 默认模板（script.js:569-592），此前恒 {} ⇒ 卡脚本写字段即炸。
    createCharacterData: createCharacterDataCompat,
    getCurrentMessageId: window.getCurrentMessageId,
    swipe: window.TavernHelper?.swipe || tavernHelperCompat.swipe,
    swipe_left: window.swipe_left,
    swipe_right: window.swipe_right,
    variables: variablesCompat,
    macros: window.macros,
    registerMacro: window.registerMacro,
    unregisterMacro: window.unregisterMacro,
    // [包G G-1 #8] 推进 message.extra.media 后经既有 setChatMessage 父侧通道落库；
    // 拿不到消息或媒体不可映射时返回 false（诚实失败），不再假成功。
    appendMediaToMessage: appendMediaToMessageCompat,
    ensureMessageMediaIsArray: (message) => {
      if (message && typeof message === 'object' && !Array.isArray(message.extra?.media)) {
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra.media = [];
      }
      return message?.extra?.media || [];
    },
    // [包G G-1 #9/#10/#11] 真值来自 message.extra.* 与 power_user 偏好，stubApi 已拆。
    getMediaDisplay: getMediaDisplayCompat,
    getMediaIndex: getMediaIndexCompat,
    scrollChatToBottom: window.scrollChatToBottom,
    scrollOnMediaLoad: scrollOnMediaLoadCompat,
    // [S5-COMPAT-AUDIT T3 2026-10-16] MVU 世界书读取失败的根因修复（66 次/会话）。
    // [T6 2026-10-18] 不再包 stubApi：本函数已是经 getCharWorldbook 桥取真实条目的
    // 真实现；包成 stubApi 只会每帧产一条 "st_api_stub" 警告 toast 给用户噪音。
    // 同行 stubApi 列表（saveWorldInfo / reloadWorldInfoEditor / 等）保留为假实现。
    loadWorldInfo: async (name) => {
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
    },
    // [包B B-3 2026-10-18] saveWorldInfo 由"假成功"改为真写入。
    // 此前是 stubApi(async () => true)：返回 true 但不落库，MVU / 世界书编辑类插件会
    // 静默丢数据（比报错更糟）。现桥到既有的 createOrReplaceWorldbook 通道
    // （part-07 已接到宿主 createOrReplaceSmartCardWorldBook，真写后端）。
    // 入参按 ST 形状 { entries: { uid: entry } } 收，数组与对象两种都兼容；
    // 空条目直接返回 false（不谎报成功），写入失败也返回 false。
    saveWorldInfo: async (name, data) => {
      const source = data && typeof data === 'object' ? data : {};
      const rawEntries = source.entries && typeof source.entries === 'object' ? source.entries : {};
      const list = Array.isArray(rawEntries)
        ? rawEntries
        : Object.keys(rawEntries).map((key) => rawEntries[key]).filter((entry) => entry && typeof entry === 'object');
      if (!list.length) return false;
      try {
        const result = await window.createOrReplaceWorldbook(String(name || ''), list, {});
        return Boolean(result && result.success !== false);
      } catch (e) {
        post({ type: 'log', level: 'warn', message: 'saveWorldInfo 失败：' + String(e && e.message || e) });
        return false;
      }
    },
    // [包G G-1 #7/#6/#5/#4] 世界书四项全部拆掉 stubApi：
    //   reloadWorldInfoEditor 恒真 by design（帧内无编辑器 UI、无副作用可失败）；
    //   updateWorldInfoList 经 getCharWorldbook 桥刷新 window.world_names；
    //   getWorldInfoPrompt 用同帧真条目组装提示词串（空则 ''）；
    //   convertCharacterBook 恒等映射（Palink 后端存的即 ST 形状，见其注释）。
    reloadWorldInfoEditor: reloadWorldInfoEditorCompat,
    updateWorldInfoList: updateWorldInfoListCompat,
    convertCharacterBook: convertCharacterBookCompat,
    getWorldInfoPrompt: getWorldInfoPromptCompat,
    getWorldInfoNames: () => Array.isArray(window.world_names) ? [...window.world_names] : [],
    CONNECT_API_MAP: {},
    // [包G G-1 #3] Palink 无独立 textgen 后端；ST 在 mainApi != textgen 时同样返回空串。
    getTextGenServer: getTextGenServerCompat,
    extractMessageFromData: (data) => data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.text || data?.content || '',
    // [包G G-1 #2] 真值 = 宿主 ctx.selectedModel（CharacterChat.tsx 的 selectedModel）。
    getChatCompletionModel: getChatCompletionModelCompat,
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

  // ══════════════════════════════════════════════════════════════════════════
  // [包G G-2 2026-10-18] SillyTavern.libs 补齐到 ST 1.18.0 的 **25 个权威键**。
  // 权威口径：_reference/sillytavern-1.18.0/public/lib.js:84-110 的 default export
  //（fixture 已入库：__tests__/fixtures/st-libs-25.json）。
  // 硬约束：帧是 opaque origin 的 sandbox 文档，**拿不到宿主打包模块**；把库源码内联
  // 进 srcdoc 会撑爆单帧（红线 ≤50,000，禁止）。⇒ 唯一兼顾"不撑 srcdoc + 不造假库"的形态：
  //   **同步可见的 25 个键 + 首次访问才发起的 CDN 懒加载 getter**。
  //   加载完成前取到 undefined（诚实，不是形状像的假对象），完成后变成真库；
  //   加载失败静默降级（卡脚本自己会兜）。
  // CDN 与卡脚本 bootstrap 同一供应商、同一风格（card-script-runner.ts:165-171 的
  // dependencyUrls 走 jsdelivr +esm），版本按 ST 1.18.0 的 package.json 锁定。
  // ══════════════════════════════════════════════════════════════════════════
  const PALINK_ST_LIB_BASE = 'https://testingcf.jsdelivr.net/npm/';
  // 键 → [拼在 base 后的包路径（版本锁定）, 取值方式]。
  //   'default'   = 模块默认导出；
  //   'namespace' = 整个模块命名空间（ST 源码是 import * as X，如 Popper/chevrotain）；
  //   其它字符串  = 指定命名导出。**同一模块出多个键**时一次加载两键共享缓存
  //     （@mozilla/readability → Readability + isProbablyReaderable；fflate → gzipSync + gzip）。
  const PALINK_ST_LIB_PACKAGES = {
    Fuse: ['fuse.js@7.1.0/+esm', 'default'],
    hljs: ['highlight.js@11.11.1/+esm', 'default'],
    css: ['@adobe/css-tools@4.4.4/+esm', 'default'],
    Bowser: ['bowser@2.12.1/+esm', 'default'],
    DiffMatchPatch: ['diff-match-patch@1.0.5/+esm', 'default'],
    Readability: ['@mozilla/readability@0.6.0/+esm', 'Readability'],
    isProbablyReaderable: ['@mozilla/readability@0.6.0/+esm', 'isProbablyReaderable'],
    SVGInject: ['@iconfu/svg-inject@1.2.3/+esm', 'default'],
    showdown: ['showdown@2.1.0/+esm', 'default'],
    seedrandom: ['seedrandom@3.0.5/+esm', 'default'],
    Popper: ['@popperjs/core@2.11.8/+esm', 'namespace'],
    droll: ['droll@0.2.1/+esm', 'default'],
    morphdom: ['morphdom@2.7.7/+esm', 'default'],
    slideToggle: ['slidetoggle@4.0.0/+esm', 'toggle'],
    chalk: ['chalk@5.6.0/+esm', 'default'],
    yaml: ['yaml@2.8.3/+esm', 'namespace'],
    chevrotain: ['chevrotain@11.2.0/+esm', 'namespace'],
    gzipSync: ['fflate@0.8.2/+esm', 'gzipSync'],
    gzip: ['fflate@0.8.2/+esm', 'gzip'],
    sha256: ['js-sha256@0.11.1/+esm', 'sha256'],
  };
  // 已加载过就别再拉第二份；下列全局名是帧内既有的 CDN 通道产物（bootstrap 把
  // showdown / yaml 挂成 window.showdown / window.YAML）与 ST initLibraryShims 同名全局习惯。
  const PALINK_ST_LIB_WINDOW_GLOBALS = {
    Fuse: 'Fuse',
    hljs: 'hljs',
    showdown: 'showdown',
    yaml: 'YAML',
    Popper: 'Popper',
    droll: 'droll',
    morphdom: 'morphdom',
    SVGInject: 'SVGInject',
    seedrandom: 'seedrandom',
    chalk: 'chalk',
  };
  const stLibLoaded = {};
  const stLibPending = {};
  // 同一模块出多个键（@mozilla/readability → Readability + isProbablyReaderable、
  // fflate → gzipSync + gzip）时按 **URL** 去重：一次网络请求喂两个 getter。
  const stLibModuleByUrl = {};
  const pickStLibValue = (mod, mode) => {
    if (!mod || typeof mod !== 'object') return undefined;
    if (mode === 'namespace') return mod;
    if (mod[mode] !== undefined) return mod[mode];
    return mod.default;
  };
  const pickWindowStLib = (key) => {
    const globalName = PALINK_ST_LIB_WINDOW_GLOBALS[key];
    if (!globalName) return undefined;
    const value = window[globalName];
    return value === undefined || value === null ? undefined : value;
  };
  // 对齐 ST lib.js:34 initLibraryShims —— 库到货后补一份同名全局，
  // 让读 window.Fuse / window.hljs 的老扩展也能拿到（不覆盖已有值）。
  const exposeStLibWindowGlobal = (key, value) => {
    const globalName = PALINK_ST_LIB_WINDOW_GLOBALS[key];
    if (!globalName || value === undefined) return;
    try {
      if (window[globalName] === undefined || window[globalName] === null) window[globalName] = value;
    } catch (e) { /* 静默：全局被占用不是错误 */ }
  };
  const importStLibModule = (url) => {
    // 默认路径就是真 CDN 动态 import（与 card-script-runner.ts:280 同款）。
    // window.__palinkStLibImport 是**环境与离线镜像注入口**：宿主（或契约测试）可预先
    // 注入 (url) => Promise<module>，用于 CDN 不可达的部署或确定性测试。
    // 帧是 opaque origin，注入只影响本帧自身，不构成跨帧能力面。
    if (typeof window.__palinkStLibImport === 'function') {
      try {
        return Promise.resolve(window.__palinkStLibImport(url));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return import(url);
  };
  const ensureStLibCompat = (key) => {
    const name = String(key || '');
    if (!Object.prototype.hasOwnProperty.call(PALINK_ST_LIB_PACKAGES, name)) {
      return Promise.resolve(stLibLoaded[name]);
    }
    if (stLibLoaded[name] !== undefined) return Promise.resolve(stLibLoaded[name]);
    if (stLibPending[name]) return stLibPending[name];
    const fromWindow = pickWindowStLib(name);
    if (fromWindow !== undefined) {
      stLibLoaded[name] = fromWindow;
      return Promise.resolve(fromWindow);
    }
    const spec = PALINK_ST_LIB_PACKAGES[name];
    const url = PALINK_ST_LIB_BASE + spec[0];
    // 模块级缓存：另一个键已经在拉同一个 URL 就复用它的 promise。
    const modulePromise = stLibModuleByUrl[url] || (stLibModuleByUrl[url] = importStLibModule(url));
    stLibPending[name] = modulePromise
      .then((mod) => {
        delete stLibPending[name];
        const value = pickStLibValue(mod, spec[1]);
        if (value === undefined) {
          post({ type: 'log', level: 'warn', message: 'SillyTavern.libs.' + name + ' 已加载但取不到导出 ' + spec[1] + '：' + url });
          return undefined;
        }
        stLibLoaded[name] = value;
        exposeStLibWindowGlobal(name, value);
        return value;
      })
      .catch((error) => {
        delete stLibPending[name];
        // 失败静默降级（卡脚本自己会兜），只留一条 log 供取证。
        post({ type: 'log', level: 'warn', message: 'SillyTavern.libs.' + name + ' CDN 加载失败：' + String(error && error.message || error) });
        return undefined;
      });
    return stLibPending[name];
  };
  const defineStLibGetter = (target, key) => {
    try {
      Object.defineProperty(target, key, {
        // enumerable: true ⇒ Object.keys(SillyTavern.libs) 能看到全部 25 个权威键（契约测试口径）。
        enumerable: true,
        configurable: true,
        get: () => {
          if (stLibLoaded[key] === undefined && !stLibPending[key]) ensureStLibCompat(key);
          return stLibLoaded[key];
        },
      });
    } catch (e) {
      // defineProperty 失败（被别的注入物占成不可配置属性）就退回普通键，
      // 值仍由 ensureStLibCompat 异步补齐 —— 不因此丢键。
      try { target[key] = stLibLoaded[key]; } catch (inner) { /* 静默 */ }
    }
  };
  const stLibsCompat = {
    ...(window.SillyTavern.libs && typeof window.SillyTavern.libs === 'object' ? window.SillyTavern.libs : {}),
    // Palink 自有项（ST 25 项之外的超集，包G 明确保留）：
    toastr: window.toastr,
    $: window.$,
    jQuery: window.jQuery || window.$,
    _: lodashCompat,
    dayjs: window.dayjs || momentCompat,
    accountStorage: accountStorageCompat,
    // 与 ST 同名且**已经是真库**（宿主 bootstrap 注入或 compat 常量）的 5 项权威键：
    DOMPurify: domPurifyCompat,
    Handlebars: handlebarsCompat,
    lodash: lodashCompat,
    moment: momentCompat,
    localforage: localforageCompat,
  };
  Object.keys(PALINK_ST_LIB_PACKAGES).forEach((key) => {
    // 已有真值（含别的注入物先塞进来的同名全局）就不覆盖；其余一律挂懒 getter。
    if (stLibsCompat[key] !== undefined) {
      stLibLoaded[key] = stLibsCompat[key];
      return;
    }
    defineStLibGetter(stLibsCompat, key);
  });
  window.SillyTavern.libs = stLibsCompat;
  // 取证/预热用：**不可枚举**，故 Object.keys(libs) 仍是 25 权威键 + Palink 超集，
  // 不会因为这个辅助键而多出一项。
  try {
    Object.defineProperty(stLibsCompat, '__ensure', {
      enumerable: false,
      configurable: true,
      value: (key) => (key === undefined || key === null || key === ''
        ? Promise.all(Object.keys(PALINK_ST_LIB_PACKAGES).map((name) => ensureStLibCompat(name)))
        : ensureStLibCompat(String(key))),
    });
    Object.defineProperty(stLibsCompat, '__packageMap', {
      enumerable: false,
      configurable: true,
      value: Object.keys(PALINK_ST_LIB_PACKAGES).reduce((acc, name) => {
        acc[name] = PALINK_ST_LIB_BASE + PALINK_ST_LIB_PACKAGES[name][0];
        return acc;
      }, {}),
    });
  } catch (e) { /* 静默 */ }
  window.libs = window.libs || stLibsCompat;
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
      // [包J J-3 2026-10-18] 反斜杠成对写：单反斜杠会被模板求值吞掉，空字符类正则退化成
      // 「把连续字母 s 换成空格」，多行报错摘要的空白根本没被折叠。
      return String(first.message || '').replace(/\\s+/g, ' ').slice(0, 160);
    } catch { return ''; }
  };

  // [T6 2026-10-18] 把 unknown error / [object Event] 兜底改成可读信号：
  //   - window.onerror：补 filename:lineno:colno 与 stack 首行，便于定位"是哪个
  //     资源 404 / 哪个脚本崩"；不要只回 uiText.unknownError。
  //   - unhandledrejection：Event 序列化 event.type + 资源 URL（本次实拍是
  //     https://drive.baibai.cv/.../Music.js，缺这条只能盲猜）。
  // ⚠️ 本文件主体是注入 iframe 的模板字符串，不允许反引号/美元花括号。
  const formatWindowErrorMessage = (event) => {
    try {
      const direct = String(event?.message || event?.error?.message || '').trim();
      if (direct) {
        if (event?.filename) {
          return direct + ' @ ' + String(event.filename) + ':' + (event.lineno || 0) + ':' + (event.colno || 0);
        }
        return direct;
      }
      // [T6 2026-10-18] 注：本文件是模板字符串，源码里想产出 JS 字面量（被解析为换行符）
      // 需要写两个反斜杠 + n；写单个反斜杠 + n 会被外层模板吃成真换行
      // （generated-script-parse-guard 拦下）。下同：split 的字面量用了 反斜杠 反斜杠 n。
      const stack = String(event?.error?.stack || '').split('\\n').find((line) => line.trim()) || '';
      if (stack) return (uiText.unknownError || 'unknown error') + ' (' + stack.slice(0, 120) + ')';
      if (event?.filename) {
        return (uiText.unknownError || 'unknown error') + ' @ ' + String(event.filename) + ':' + (event.lineno || 0);
      }
      return uiText.unknownError || 'unknown error';
    } catch (_e) {
      return uiText.unknownError || 'unknown error';
    }
  };
  const formatRejectionMessage = (reason) => {
    try {
      if (reason && typeof reason === 'object') {
        // Event（如 <script> 加载失败）—— String(Event) === '[object Event]'
        if (typeof reason.type === 'string' && (reason.target || reason.srcElement || reason.currentTarget)) {
          const src = (reason.target && (reason.target.src || reason.target.href))
            || (reason.srcElement && (reason.srcElement.src || reason.srcElement.href))
            || (reason.currentTarget && (reason.currentTarget.src || reason.currentTarget.href))
            || '';
          return reason.type + (src ? ' @ ' + src : '');
        }
        if (typeof reason.message === 'string' && reason.message) {
          return reason.message;
        }
      }
      const text = String(reason || uiText.unhandledRejection || 'unhandled rejection');
      return text;
    } catch (_e) {
      return uiText.unhandledRejection || 'unhandled rejection';
    }
  };

  // [包I I-2 2026-10-18] 「资源加载失败」与「脚本错误」分家（唯一切分口径）。
  //
  // 实拍（REPORT_真实角色卡兼容性实测_酒馆助手卡_2026-10-18 §6）：露缇雅帧里一个死外链
  // https://drive.baibai.cv/f/ZKEBuW/Music.js 加载失败，reason 是 Event 形态，
  // 经 unhandled_rejection → reportDiagnostic → 宿主 handleSmartCardCompatDiagnostic
  // → Sonner toast「error @ …Music.js」。ST 对这类失败**只落 console**，不弹 toast
  // —— 这正是用户主诉「顶部弹出很多报错」的来源之一。
  // ⚠️ 包G 之后 SillyTavern.libs 是 18 个 jsdelivr CDN 的**懒加载** ⇒ 外链失败在生产里
  // 只会比以前更常发生，这条切分是必需的，不是锦上添花。
  //
  // 切分只认一种形态（**严禁**扩成"吞掉所有 error"）：
  //   · window error：event.target 是 SCRIPT/LINK/IMG/SOURCE/AUDIO/VIDEO/TRACK **且带 src/href**；
  //   · unhandledrejection：reason 本身是上述资源元素，或 reason 是 Event 形态
  //     （有 type，且 target/srcElement/currentTarget 里能取出上面那种元素）。
  // 命中后的处置：console.error + cardErrorLog（logCardError 一次做全这两件）
  //   + 一条 frame-error 消息，由父侧 CharacterCardRenderer 收进 window.__palinkFrameErrors
  //   （上限 50 条）⇒ **取证不丢**，排查死链还得靠它；但**不调 reportDiagnostic** ⇒ 不弹 toast。
  // 其余一律走原有 reportDiagnostic 路径（含 undefined_global 的 severity 降级），一行不改。
  var PALINK_RESOURCE_ERROR_TAGS = { SCRIPT: 1, LINK: 1, IMG: 1, SOURCE: 1, AUDIO: 1, VIDEO: 1, TRACK: 1 };
  function palinkResourceElementInfo(node) {
    try {
      if (!node || typeof node !== 'object') return null;
      var tagName = String(node.tagName || '').toUpperCase();
      if (!PALINK_RESOURCE_ERROR_TAGS[tagName]) return null;
      var url = '';
      try { url = String(node.src || node.href || node.currentSrc || ''); } catch (e) { url = ''; }
      if (!url) return null;
      return { tagName: tagName, url: url };
    } catch (e) {
      return null;
    }
  }
  function palinkResourceFailureFrom(source) {
    try {
      if (!source || typeof source !== 'object') return null;
      var direct = palinkResourceElementInfo(source);
      if (direct) return direct;
      var isEventShape = typeof source.type === 'string'
        && Boolean(source.target || source.srcElement || source.currentTarget);
      if (!isEventShape) return null;
      return palinkResourceElementInfo(source.target)
        || palinkResourceElementInfo(source.srcElement)
        || palinkResourceElementInfo(source.currentTarget);
    } catch (e) {
      return null;
    }
  }
  function palinkRecordFrameErrorForEvidence(message, filename) {
    // 取证通道只有一条：source 'palink-smart-card-frame' + type 'frame-error'
    // 是父侧写 __palinkFrameErrors 认的形状；st:diagnostic 那条会走 toast，所以这里不用它。
    // 帧内直写父窗口不可能（sandbox 只给 allow-scripts ⇒ opaque origin），只能 postMessage。
    // [包N K-4 2026-10-19] 只补取证字段（kind / colno / 兜底非空 message），
    // 不改分类口径、不碰 reportDiagnostic、不弹 toast。
    try {
      var evidenceMessage = (typeof message === 'string' && message)
        ? message
        : 'evidence_message_unavailable: 取证调用未带可读 message（帧内兜底标记，非空串）';
      var evidenceFilename = (typeof filename === 'string' && filename)
        ? filename
        : '<filename-absent>';
      window.parent.postMessage({
        source: 'palink-smart-card-frame',
        frameId: frameId,
        type: 'frame-error',
        kind: 'resource_load_failed',
        message: evidenceMessage,
        filename: evidenceFilename,
        lineno: 0,
        colno: -1,
      }, '*');
    } catch (e) { /* 父窗口不可达时静默：console 与 cardErrorLog 已经留过痕 */ }
  }
  function palinkReportResourceLoadFailure(channel, info) {
    // 消息里带上标签名与 URL：父侧 __palinkFrameErrors 只有这两样就能判断是哪个外链死了。
    var message = 'resource_load_failed[' + String(channel || '') + '] '
      + String(info.tagName || '') + ' @ ' + String(info.url || '');
    logCardError('资源加载失败（静默，不弹 toast）', message, '');
    palinkRecordFrameErrorForEvidence(message, info.url);
    return message;
  }

  // [STYLE-GUARD-INFRAME 2026-10-18] 卡片样式自愈（帧内版，权威实现）。
  //
  // 为什么必须在帧内做：未信任卡 iframe 的 sandbox 只给 allow-scripts（P1-1 修复），
  // 是 opaque origin ⇒ 父页面 iframe.contentDocument === null，父侧守护**根本装不上**
  // （真机实测 window.__palinkStyleGuard === null、iframe 上无 data-palink-style-guard）。
  //
  // 现象：卡先正常渲染 2~3 秒（样式齐全），随后插件 bundle 把 document.head 整张
  // replaceWith 掉 / 重置，卡片自己的 <style> 随之消失 → 整段消息退化成裸 HTML 文本
  // （浮窗按钮变成一行字、背景色/字号调节全丢）。父侧 removeChild / innerHTML 三组
  // 拦截实验 0 命中，说明是 head 节点级替换，不是子节点删除。
  //
  // 做法：DOMContentLoaded 时拍 head 里 style/link 的 outerHTML 快照；用
  // MutationObserver 监听 documentElement 的 childList+subtree，**只在 removedNodes
  // 里出现 STYLE / LINK / HEAD 时才做恢复**（避免卡片高频 DOM 更新时每次都跑全量比对）；
  // 再挂一个 700ms × 60 次的 interval 兜住 observer 失效的极端路径。
  // 恢复只补快照里登记过、当前文档里缺失的节点，幂等。
  try {
    (function installCardStyleGuardInFrame() {
      var styleSnapshot = null;
      var guardObserver = null;
      var guardTimer = null;
      var guardTicks = 0;
      var GUARD_MAX_TICKS = 60;
      var GUARD_INTERVAL_MS = 700;
      var GUARD_SELECTOR = 'style, link[rel="stylesheet"]';

      // [包J J-1 2026-10-18] 快照只在 DOMContentLoaded / load 先到先得地拍一次，而 Palink
      // 自家插件的 CSS 是**等父侧 postMessage 之后**才由 injectStPluginCssCompat 异步注进来的
      // （包E 实测：卡侧外部 bundle 用 head.innerHTML 整体重写后 8 条只剩 3 条基样式，
      // 丢的 5 条全是插件 CSS，守护对它完全无感）。这里开一条**只追加**的登记通道：
      //   - 追加的是调用方交来的插件自有节点的外层 HTML 原文；
      //   - 绝不重拍快照 —— 重拍会把卡侧自己塞进 head 的动态样式一并吸进基线，守护就此失效。
      // 观测面：__palinkStyleGuardSnapshot = 基线快照条数 + 追加登记条数。
      var styleGuardExtraNodes = [];
      var styleGuardPendingNodes = null;

      function styleGuardSetSnapshotCount() {
        try {
          window.__palinkStyleGuardSnapshot =
            (styleSnapshot ? styleSnapshot.length : 0) + styleGuardExtraNodes.length;
        } catch (e) { /* 观测面写不进去不影响守护本身 */ }
      }

      function styleGuardPushExtraNode(outerHtml) {
        var text = String(outerHtml || '');
        if (!text) return false;
        // 已经在基线快照里的（插件 CSS 恰好早于快照登场）不要再登记一遍 ——
        // 否则恢复时会把同一个 id 的节点补两次。
        if (styleSnapshot) {
          for (var s = 0; s < styleSnapshot.length; s++) {
            if (styleSnapshot[s] === text) return false;
          }
        }
        for (var i = 0; i < styleGuardExtraNodes.length; i++) {
          if (styleGuardExtraNodes[i] === text) return false;
        }
        styleGuardExtraNodes.push(text);
        return true;
      }

      function styleGuardAddNode(node) {
        try {
          if (!node) return;
          var outerHtml = String(node.outerHTML || '');
          if (!outerHtml) return;
          // 插件 CSS 比快照还早（少数路径）：先挂起，等拍完快照再补登记
          if (!styleSnapshot) {
            if (!styleGuardPendingNodes) styleGuardPendingNodes = [];
            for (var p = 0; p < styleGuardPendingNodes.length; p++) {
              if (styleGuardPendingNodes[p] === outerHtml) return;
            }
            styleGuardPendingNodes.push(outerHtml);
            return;
          }
          if (!styleGuardPushExtraNode(outerHtml)) return;
          try {
            window.__palinkStyleGuardPluginCss = (window.__palinkStyleGuardPluginCss || 0) + 1;
          } catch (e) { /* 静默 */ }
          styleGuardSetSnapshotCount();
        } catch (e) { /* 守护自身出问题也不许影响插件 CSS 注入 */ }
      }

      function styleGuardFlushPendingNodes() {
        if (!styleGuardPendingNodes || !styleGuardPendingNodes.length) return;
        for (var i = 0; i < styleGuardPendingNodes.length; i++) {
          styleGuardPushExtraNode(styleGuardPendingNodes[i]);
        }
        styleGuardPendingNodes = null;
      }

      // 幂等：同一文档重复安装时先卸掉上一份（防重复 observer / 定时器叠加）。
      try {
        if (typeof window.__palinkStyleGuardDispose === 'function') {
          window.__palinkStyleGuardDispose();
        }
      } catch (e) { /* 静默 */ }
      // [包J J-1] 登记口对帧内其他段可见（part-01 的 injectStPluginCssCompat 用它补快照）。
      try {
        window.__palinkStyleGuardAddNode = styleGuardAddNode;
      } catch (e) { /* 静默 */ }

      function takeStyleSnapshot() {
        try {
          var head = document.head;
          if (!head) return [];
          var list = head.querySelectorAll(GUARD_SELECTOR);
          var out = [];
          for (var i = 0; i < list.length; i++) {
            out.push(String(list[i].outerHTML || ''));
          }
          return out;
        } catch (e) { return []; }
      }

      function restoreCardStyles() {
        try {
          if (!styleSnapshot || !styleSnapshot.length) return;
          var head = document.head || document.documentElement;
          if (!head) return;
          var present = {};
          var cur = head.querySelectorAll(GUARD_SELECTOR);
          for (var i = 0; i < cur.length; i++) {
            try { present[String(cur[i].outerHTML || '')] = true; } catch (e) {}
          }
          var restored = 0;
          for (var j = 0; j < styleSnapshot.length; j++) {
            var html = styleSnapshot[j];
            if (!html || present[html]) continue;
            var tpl = document.createElement('template');
            tpl.innerHTML = html;
            var node = tpl.content && tpl.content.firstElementChild;
            if (node) { head.appendChild(node); restored += 1; }
          }
          // [包J J-1] 第二趟：恢复「快照之后才登记」的插件自有节点。
          // 只有显式登记过的才会进来，卡侧自己往 head 里塞的样式永远不会被补回来。
          for (var k = 0; k < styleGuardExtraNodes.length; k++) {
            var extraHtml = styleGuardExtraNodes[k];
            if (!extraHtml || present[extraHtml]) continue;
            var extraTpl = document.createElement('template');
            extraTpl.innerHTML = extraHtml;
            var extraNode = extraTpl.content && extraTpl.content.firstElementChild;
            if (extraNode) { head.appendChild(extraNode); restored += 1; }
          }
          if (restored > 0) {
            try {
              window.__palinkStyleGuardRestored = (window.__palinkStyleGuardRestored || 0) + restored;
              window.__palinkStyleGuardLastAt = Date.now();
            } catch (e) {}
          }
        } catch (e) { /* 静默 */ }
      }

      function needsRestore(records) {
        try {
          for (var i = 0; i < records.length; i++) {
            var rem = records[i] && records[i].removedNodes;
            if (!rem || !rem.length) continue;
            for (var j = 0; j < rem.length; j++) {
              var tag = String((rem[j] && rem[j].nodeName) || '').toUpperCase();
              if (tag === 'STYLE' || tag === 'LINK' || tag === 'HEAD') return true;
            }
          }
        } catch (e) { /* 静默 */ }
        return false;
      }

      function startCardStyleGuard() {
        try {
          if (styleSnapshot) return;
          styleSnapshot = takeStyleSnapshot();
          // [包J J-1] 比快照还早登场的插件 CSS 在这里补登记（方案 a 的挂起队列）
          styleGuardFlushPendingNodes();
          if (!styleSnapshot.length) return;
          try {
            guardObserver = new MutationObserver(function (records) {
              if (needsRestore(records)) restoreCardStyles();
            });
            guardObserver.observe(document.documentElement, { childList: true, subtree: true });
          } catch (e) { /* 静默 */ }
          try {
            guardTimer = setInterval(function () {
              guardTicks += 1;
              if (guardTicks > GUARD_MAX_TICKS) {
                if (guardTimer) clearInterval(guardTimer);
                guardTimer = null;
                return;
              }
              restoreCardStyles();
            }, GUARD_INTERVAL_MS);
          } catch (e) { /* 静默 */ }
          try { styleGuardSetSnapshotCount(); } catch (e) {}
          try {
            window.__palinkStyleGuardDispose = function () {
              try { if (guardObserver) guardObserver.disconnect(); } catch (e) {}
              try { if (guardTimer) clearInterval(guardTimer); } catch (e) {}
              guardObserver = null;
              guardTimer = null;
            };
          } catch (e) {}
        } catch (e) { /* 静默 */ }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startCardStyleGuard, { once: true });
      } else {
        startCardStyleGuard();
      }
      // 兜底：load 时若还没拍成（DOMContentLoaded 被吃 / 样式是后注入的），再试一次。
      window.addEventListener('load', startCardStyleGuard, { once: true });
    })();
  } catch (e) { /* 静默 */ }

  // [包N ② 2026-10-19] 「节点被移除/被替换」取证观察器（**纯观测面，不改变任何行为**）。
  //   病灶（REPORT_包K §5.1 K-1）：卡自己的 <style>（tavern-cg-album-style 12KB、
  //   galgame-ui-plugin-styles 440KB）在 t8→t16 被整体抹掉，但 __palinkFrameErrors 只有
  //   unknown error，答不出"是谁、用什么方式删的"。这里给移除/替换事件补**节点身份取证**：
  //     - 被移除节点：tagName、id、data-* / data-palink-* 关键属性、文本长度（字节近似）；
  //     - 触发线索：record.target 身份、同批 addedNodes（有 addedNodes = 替换，无 = 纯删除）、
  //       removedNodes 计数；MutationObserver 回调本身是异步微任务，拿不到删除方的同步栈，
  //       所以可得的"方式"线索就是上面这几项（同步栈捕获只在 .tmp_probe 临时探针里做，不进仓库）。
  //   ⛔ 红线：本观察器**只**把取证经 palinkRecordFrameErrorForEvidence 送进 __palinkFrameErrors，
  //   不改 STYLE-GUARD 恢复范围、不碰 reportDiagnostic、不弹 toast、不改 guardSnapshot。
  //   约束：模板字符串，只能 ES5，禁反引号/美元花括号/裸反斜杠。
  try {
    (function installStyleRemovalForensicsInFrame() {
      var STYLE_REMOVAL_MAX_REPORTS = 24;
      var styleRemovalReportCount = 0;
      var styleRemovalObserver = null;

      function styleRemovalByteLen(text) {
        var s = String(text || '');
        return s.length;
      }

      function styleRemovalKeyAttrs(node) {
        var out = {};
        try {
          var attrs = node && node.attributes;
          if (!attrs || !attrs.length) return out;
          var seen = 0;
          for (var i = 0; i < attrs.length && seen < 12; i += 1) {
            var nm = String(attrs[i].name || '');
            if (nm.indexOf('data-') === 0 || nm === 'id' || nm === 'rel' || nm === 'href') {
              out[nm] = String(attrs[i].value || '').slice(0, 80);
              seen += 1;
            }
          }
        } catch (e) { /* 属性不可读时给空集 */ }
        return out;
      }

      function styleRemovalNodeIdentity(node) {
        var ident = { tagName: '', id: '', attrs: {}, textLen: 0 };
        try {
          ident.tagName = String((node && node.tagName) || (node && node.nodeName) || '').toUpperCase();
          ident.id = String((node && node.id) || '');
          ident.attrs = styleRemovalKeyAttrs(node);
          var tc = (node && node.textContent) || '';
          ident.textLen = styleRemovalByteLen(tc);
        } catch (e) { /* 已脱离文档的节点取不到内容时保持已取到的部分 */ }
        return ident;
      }

      function styleRemovalIsStyledNode(node) {
        var tag = String((node && (node.tagName || node.nodeName)) || '').toUpperCase();
        return tag === 'STYLE' || tag === 'LINK' || tag === 'HEAD';
      }

      function handleStyleRemovalRecords(records) {
        try {
          if (styleRemovalReportCount >= STYLE_REMOVAL_MAX_REPORTS) return;
          for (var r = 0; r < records.length; r += 1) {
            if (styleRemovalReportCount >= STYLE_REMOVAL_MAX_REPORTS) return;
            var record = records[r];
            var removed = record && record.removedNodes;
            if (!removed || !removed.length) continue;
            var removedStyled = [];
            for (var n = 0; n < removed.length; n += 1) {
              if (styleRemovalIsStyledNode(removed[n])) removedStyled.push(styleRemovalNodeIdentity(removed[n]));
            }
            if (!removedStyled.length) continue;
            // 同批 addedNodes 身份 = 这是"替换"还是"纯删除"的关键线索
            var added = record.addedNodes || [];
            var addedStyled = [];
            for (var a = 0; a < added.length && a < 12; a += 1) {
              addedStyled.push(styleRemovalNodeIdentity(added[a]));
            }
            var targetIdent = styleRemovalNodeIdentity({
              tagName: (record.target && record.target.nodeName) || '',
              id: (record.target && record.target.id) || '',
              textContent: '',
            });
            var kind = addedStyled.length ? 'node_replaced' : 'node_removed';
            var first = removedStyled[0];
            var message = 'style_removal[' + kind + '] removedStyledCount=' + removedStyled.length
              + ' addedCount=' + added.length
              + ' target=' + targetIdent.tagName + '#' + (targetIdent.id || '-')
              + ' first=' + first.tagName + '#' + (first.id || '-') + ' textLen=' + first.textLen;
            var filename = first.attrs.href || first.id || '';
            try {
              window.parent.postMessage({
                source: 'palink-smart-card-frame',
                frameId: frameId,
                type: 'frame-error',
                kind: kind,
                message: message,
                filename: filename || '<no-filename>',
                lineno: -1,
                colno: -1,
                errorReason: 'style_removal_forensics',
                node: {
                  removedStyled: removedStyled,
                  addedStyled: addedStyled,
                  target: targetIdent.tagName + '#' + (targetIdent.id || '-'),
                  removedTotal: removed.length,
                  addedTotal: added.length,
                },
              }, '*');
              styleRemovalReportCount += 1;
            } catch (postErr) { /* 父不可达时静默 */ }
          }
        } catch (e) { /* 取证自身异常绝不影响页面 */ }
      }

      try {
        styleRemovalObserver = new MutationObserver(function (records) {
          handleStyleRemovalRecords(records);
        });
        styleRemovalObserver.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { /* MutationObserver 不可用时静默：不改变任何行为 */ }
    })();
  } catch (e) { /* 静默 */ }

  window.addEventListener('error', (event) => {
    // [包I I-2] 资源加载失败先分流；真脚本错误（下面的 message/refMatch 逻辑）行为一字未改。
    const resourceFailure = palinkResourceFailureFrom(event && event.target);
    if (resourceFailure) {
      palinkReportResourceLoadFailure('window_error', resourceFailure);
      return;
    }
    const message = formatWindowErrorMessage(event);
    const refMatch = message.match(/(?:ReferenceError:\\s*)?([A-Za-z_$][\\w$]*) is not defined/);
    const stack = String(event?.error?.stack || '');
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
    const reason = event?.reason;
    // [包I I-2] Event 形态且 target 是资源元素 ⇒ 外链加载失败，静默 + 取证，不弹 toast。
    const resourceFailure = palinkResourceFailureFrom(reason);
    if (resourceFailure) {
      palinkReportResourceLoadFailure('unhandled_rejection', resourceFailure);
      return;
    }
    const message = formatRejectionMessage(reason);
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
