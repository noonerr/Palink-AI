/**
 * legacy-st-sim 段 · 第 01 段（原 legacy-st-sim.ts 第 15-836 行）
 *
 * 机械拆分产物：逐字节搬运，未改任何逻辑。内容是注入卡片 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 拼接顺序由 legacy-st-sim.ts 固定（a → b → c），不可调换。
 *  3. 修改后必须跑 node scripts/verify-shim-identity.mjs 比对字节快照。
 */

export const LEGACY_ST_SIM_SEGMENT_PART_A = `  // [MVU-EVENTS 2026-10-05] MVU 事件键的契约真值，取自插件契约
  // st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts。
  // 事件总线以事件字符串本身为 key，值写错 = 卡脚本 eventOn(Mvu.events.X) 永远收不到。
  // 此前 emit 的是无前缀的 VARIABLE_UPDATE_ENDED，与契约的 mag_ 前缀不符，事件整体是假活。
  // 注意 VARIABLE_INITIALIZED 契约原文拼写就是 initiailized（少一个 l），照抄不要修正。
  // COMMAND_PARSED 键在此定义但不 emit：契约要的是解析出的命令对象且要求应用前拦截改写，
  // 我们后端留存的是已应用完的 JSON Patch，结构与时序都不符，emit 出来是假活（留空并登记）。
  var MVU_EVENT_KEYS = {
    VARIABLE_INITIALIZED: 'mag_variable_initiailized',
    VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
    COMMAND_PARSED: 'mag_command_parsed',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
    BEFORE_MESSAGE_UPDATE: 'mag_before_message_update'
  };
  // [PARENT-ALIAS] 沙箱卡的 window.parent / window.top 兼容代理：
  // 未信任卡 iframe 为 opaque origin（P1-1 沙箱），卡片脚本读 parent.jQuery /
  // parent.$ 会抛 "Blocked a frame with origin null from accessing a
  // cross-origin frame"（ST 卡惯用 parent.jQuery —— ST 内卡片 iframe 同源可用）。
  // 此处以"传递窗"代理替换 parent/top：
  //   - jQuery / $ → 惰性返回卡内 shim 提供的 window.jQuery / window.$（本段
  //     结尾有 $ 兜底，安装时可能尚未初始化，故必须在访问时才读取）
  //   - postMessage → 转发真实父帧（跨源白名单方法；本段自身的 frame-error /
  //     frame-csp / resize 上报通道依赖它，不可断）
  //   - 其余属性读取返回 undefined（不抛错、优雅降级），写入静默忽略
  // 真实父帧对象本身不暴露：parent.localStorage / token / DOM 依旧不可达，
  // 安全面与原沙箱一致。trusted-native（同源）不安装 —— 真实 parent 访问
  // 合法且必需（卡片需读真实存储），覆盖反而破坏功能。
  try {
    if (!ctx.trustedNative) {
      (function () {
        var realParent = null, realTop = null;
        try { realParent = window.parent; } catch (e) { return; }
        try { realTop = window.top; } catch (e) { realTop = realParent; }
        if (!realParent || realParent === window) return;
        var KNOWN_KEYS = { postMessage: 1, jQuery: 1, '$': 1, document: 1, localStorage: 1, sessionStorage: 1, addEventListener: 1, removeEventListener: 1, dispatchEvent: 1, parent: 1, top: 1, self: 1, window: 1, globalThis: 1, frames: 1, length: 1, location: 1 };
        // [PARENT-ALIAS-ST 2026-10-03] 上游 JS-Slash-Runner 的脚本 iframe 预置脚本
        // （src/iframe/predefine.js）会把父页面的这些全局合并进脚本作用域：
        //   _.pick(window.parent, ['EjsTemplate','TavernHelper','YAML','showdown','toastr','z'])
        //   + 另外单独接上 SillyTavern / Mvu
        // 生态脚本因此惯用 topWindow.SillyTavern / topWindow.Mvu / topWindow.TavernHelper
        // 跨帧读上下文（topWindow = window.parent）。
        //
        // 实测后果（2026-10-03 真机复现，露缇雅1.2 卡 + 数据库界面插件）：
        // 本代理对未列入白名单的属性一律返回 undefined，于是
        //   const st = topWindow?.SillyTavern || null  ->  null
        //   resolvedCharacterId = ""  ->  characterName = ""  ->  currentCharId = "default"
        // 插件把当前角色认成 "default"，所有「按角色」的配置都读不到 →
        // 面板/按钮整片不出现（主页面日志是 露缇雅1.2::slot::1333400005，iframe 里是 default）。
        //
        // 处理策略与上面的 jQuery/$ 一致：**返回 iframe 自己的同名全局**
        // （这些名字本段后文都挂在 window 上），既让脚本读得到，
        // 又不把真实父帧对象暴露出去 —— 安全面与原沙箱完全一致。
        var ST_GLOBAL_KEYS = {
          SillyTavern: 1, TavernHelper: 1, Mvu: 1, EjsTemplate: 1,
          YAML: 1, showdown: 1, toastr: 1, z: 1,
          eventSource: 1, event_types: 1, eventTypes: 1, tavern_events: 1, iframe_events: 1,
          extension_settings: 1, chat_metadata: 1, power_user: 1,
          getContext: 1, getVariables: 1, getAllVariables: 1, getChatVariables: 1,
          getVariable: 1, setVariable: 1, setVariables: 1, replaceVariables: 1,
          insertOrAssignVariables: 1, deleteVariable: 1,
          getChatMessages: 1, setChatMessage: 1, setChatMessages: 1,
          getCurrentMessageId: 1, getLastMessageId: 1,
          generate: 1, generateRaw: 1, generateQuietPrompt: 1,
          triggerSlash: 1, substituteParams: 1, substitudeMacros: 1,
          getButtonEvent: 1, getScriptId: 1, getScriptName: 1,
        };
        var parentAlias = null;
        var documentAlias = null;
        // 卡片对 parent 的命名空间写入存储（如 parent.LSM = {...} 或链式
        // parent.LSM.LipSyncManager = X）：写入留在卡内，读取原样返回，
        // 使 ST 卡常见的"往父页面挂全局"模式不再抛 undefined 错
        var aliasStore = {};
        // parent.document 别名：目标为卡内真实 document（readyState/body/addEventListener
        // 等全部可用 —— 修复卡脚本 parent.document.readyState 读 undefined 报错），
        // 仅 getElementById/querySelector/querySelectorAll 先查本段后文的
        // parentDocumentStore 模拟父元素（#send_but/#send_textarea 等虚拟控件），
        // 未命中再兜底卡内 DOM。TDZ：parentDocumentStore 在本段后文才初始化，
        // 卡片代码必然在 shim 执行完毕后访问，try/catch 兜底防早期触发。
        function getDocumentAlias() {
          if (documentAlias) return documentAlias;
          documentAlias = new Proxy(document, {
            get: function (t, prop) {
              if (prop === 'getElementById' || prop === 'querySelector' || prop === 'querySelectorAll') {
                return function (arg) {
                  try {
                    if (parentDocumentStore && typeof parentDocumentStore[prop] === 'function') {
                      var sim = parentDocumentStore[prop](arg);
                      if (sim) return sim;
                    }
                  } catch (e) { /* parentDocumentStore 未初始化 → 走卡内 document */ }
                  var fn = t[prop];
                  return typeof fn === 'function' ? fn.call(t, arg) : null;
                };
              }
              var v = t[prop];
              return typeof v === 'function' ? v.bind(t) : v;
            },
            set: function (t, prop, value) { t[prop] = value; return true; },
          });
          return documentAlias;
        }
        function makeAlias(target) {
          var post = null;
          try { post = target.postMessage; } catch (e) { post = null; }
          return new Proxy({}, {
            get: function (_t, prop) {
              if (prop === 'postMessage') {
                return post ? post.bind(target) : function () {};
              }
              if (prop === 'jQuery' || prop === '$') {
                return window[prop];
              }
              // [PARENT-ALIAS-ST] ST 生态全局：返回卡内自身的同名实现（见 ST_GLOBAL_KEYS 注释）。
              // 惰性读取 —— 这些名字在本段后文才挂到 window，安装时刻可能还是 undefined。
              if (Object.prototype.hasOwnProperty.call(ST_GLOBAL_KEYS, String(prop))) {
                try { return window[prop]; } catch (e) { return undefined; }
              }
              if (prop === 'document') {
                return getDocumentAlias();
              }
              if (prop === 'localStorage' || prop === 'sessionStorage') {
                // 卡内 shim 已用 memoryStorage 模拟（本段后文 defineProperty），非真实共享存储
                try { return window[prop]; } catch (e) { return undefined; }
              }
              if (prop === 'addEventListener' || prop === 'removeEventListener' || prop === 'dispatchEvent') {
                // topWindow.addEventListener 等事件绑定转发卡内自身 window
                //（修复 "topWindow.addEventListener is not a function"）
                var evtFn = window[prop];
                return typeof evtFn === 'function' ? evtFn.bind(window) : function () {};
              }
              if (Object.prototype.hasOwnProperty.call(aliasStore, String(prop))) {
                return aliasStore[prop];
              }
              if (prop === 'parent' || prop === 'top' || prop === 'self' || prop === 'window' || prop === 'globalThis') {
                return parentAlias;
              }
              if (prop === 'frames' || prop === 'length' || prop === 'location') {
                return window[prop];
              }
              if (typeof prop === 'symbol') {
                return prop === Symbol.toStringTag ? 'Window' : undefined;
              }
              return undefined;
            },
            set: function (_t, prop, value) {
              if (typeof prop === 'string') {
                aliasStore[prop] = value;
              }
              return true;
            },
            has: function (_t, prop) {
              var key = String(prop);
              return Object.prototype.hasOwnProperty.call(KNOWN_KEYS, key)
                || Object.prototype.hasOwnProperty.call(ST_GLOBAL_KEYS, key);
            },
          });
        }
        parentAlias = makeAlias(realParent);
        var topAlias = (realTop === realParent) ? parentAlias : makeAlias(realTop);
        Object.defineProperty(window, 'parent', { get: function () { return parentAlias; }, configurable: true });
        Object.defineProperty(window, 'top', { get: function () { return topAlias; }, configurable: true });
      })();
    }
  } catch (e) { /* 安装失败保持现状：parent 访问继续抛 SecurityError，行为不变 */ }

  // [IDB-POLYFILL] 沙箱 iframe（opaque origin）中浏览器禁止 IndexedDB：
  // Galgame 插件 initDB / BubbleDialogue AvatarDB 初始化第一步即抛
  // "Failed to execute 'open' on 'IDBFactory'"，插件整体初始化中断
  //（图片/变量/面板全部失效的根因）。此处提供内存实现的最小 IDB 垫片
  //（open/transaction/objectStore/put/get/getAll/delete/clear/createIndex），
  // 数据不跨 iframe 重建持久化——先保证插件初始化与当次会话功能可用。
  // trusted-native（同源）不安装，真实 IndexedDB 可用。
  try {
    if (!ctx.trustedNative) {
      (function () {
        var realOpen = null;
        try { realOpen = window.indexedDB && window.indexedDB.open; } catch (e) { realOpen = null; }
        if (!realOpen) return;
        function mkReq(result) {
          var req = { result: result, error: null, readyState: 'done', source: null, transaction: null, onsuccess: null, onerror: null };
          setTimeout(function () { try { req.onsuccess && req.onsuccess({ target: req, type: 'success' }); } catch (e) {} }, 0);
          return req;
        }
        function openDb(name) {
          var stores = {};
          var db = {
            name: name, version: 1,
            objectStoreNames: { contains: function (n) { return Object.prototype.hasOwnProperty.call(stores, n); } },
            createObjectStore: function (n) {
              var data = new Map();
              var idx = {};
              var store = {
                put: function (v, k) { var key = k !== undefined ? k : (v && v.id); data.set(key, v); return mkReq(key); },
                add: function (v, k) { var key = k !== undefined ? k : (v && v.id); data.set(key, v); return mkReq(key); },
                get: function (k) { return mkReq(data.get(k)); },
                getAll: function () { return mkReq(Array.from(data.values())); },
                getAllKeys: function () { return mkReq(Array.from(data.keys())); },
                delete: function (k) { data.delete(k); return mkReq(undefined); },
                clear: function () { data.clear(); return mkReq(undefined); },
                count: function () { return mkReq(data.size); },
                createIndex: function (n2) { idx[n2] = true; return { name: n2 }; },
                index: function (n2) { return { get: function () { return mkReq(undefined); }, getAll: function () { return mkReq([]); } }; }
              };
              stores[n] = store;
              return store;
            },
            deleteObjectStore: function (n) { delete stores[n]; },
            transaction: function (names) {
              var list = Array.isArray(names) ? names : [names];
              var tx = {
                mode: 'readwrite', db: db, error: null,
                objectStore: function (n) {
                  if (!stores[n]) { openDb.lastDb && openDb.lastDb.createObjectStore(n); }
                  return stores[n] || openDb.lastDb.createObjectStore(n);
                },
                abort: function () {}, oncomplete: null, onerror: null, onabort: null
              };
              setTimeout(function () { try { tx.oncomplete && tx.oncomplete({ type: 'complete', target: tx }); } catch (e) {} }, 0);
              return tx;
            },
            close: function () {}
          };
          openDb.lastDb = db;
          return db;
        }
        var fakeIndexedDB = {
          open: function (name, version) {
            var db = openDb(String(name || 'palink-idb'));
            var req = mkReq(db);
            setTimeout(function () {
              try { req.onupgradeneeded && req.onupgradeneeded({ target: req, oldVersion: 0, type: 'upgradeneeded' }); } catch (e) {}
              try { req.onsuccess && req.onsuccess({ target: req, type: 'success' }); } catch (e) {}
            }, 0);
            return req;
          },
          deleteDatabase: function (name) { return mkReq(undefined); },
          databases: function () { return Promise.resolve([]); }
        };
        try {
          Object.defineProperty(window, 'indexedDB', { get: function () { return fakeIndexedDB; }, configurable: true });
        } catch (e) { try { window.indexedDB = fakeIndexedDB; } catch (e2) {} }
      })();
    }
  } catch (e) { /* 垫片安装失败：维持浏览器原生（沙箱内仍会抛 SecurityError） */ }

  // [WB-GLOBAL-STUB] iframe 侧 Galgame 等插件裸调用 getGlobalWorldbookNames
  //（主窗口 setup 脚本有桩、iframe shim 没有 → ReferenceError 中断初始化）。
  // Palink 无世界书全局绑定，返回空数组/no-op 即可让插件跳过该分支。
  try {
    if (typeof window.getGlobalWorldbookNames !== 'function') {
      window.getGlobalWorldbookNames = function () { return []; };
    }
    if (typeof window.getWorldbookNames !== 'function') {
      window.getWorldbookNames = function () {
        var n = [];
        try {
          var raw = window.localStorage && window.localStorage.getItem('palink_wb_names');
          if (raw) n = JSON.parse(raw);
        } catch (e) {}
        return Array.isArray(n) ? n : [];
      };
    }
    if (typeof window.rebindGlobalWorldbooks !== 'function') {
      window.rebindGlobalWorldbooks = function () { return Promise.resolve(); };
    }
  } catch (e) { /* ignore */ }

  // [IMG-SRC-FIX] 卡片把 Windows 本地路径（A:\\...\\文件名.png）拼进图床 URL：
  // raw.githubusercontent.com/<repo>/<branch>/A%3A%5C...%5C文件名.png → 502。
  // ST 侧 avatar 为纯文件名所以能用。此处拦截 Image.src 赋值，剥掉
  // branch 之后、最后一个 %5C 之前的路径段，仅保留文件名（对正常 URL 无影响）。
  try {
    var _imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (_imgSrcDesc && _imgSrcDesc.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: function () { return _imgSrcDesc.get.call(this); },
        set: function (v) {
          var s = String(v || '');
          // [TEMPLATE-ESCAPE-FIX] 本段是模板字符串常量：正则字面量里的 \/ 会被模板求值吞成 /，
          // 生成非法正则 /^([a-z][a-z0-9+.-]*://.../ 导致整个 shim 脚本解析失败（SyntaxError:
          // Unterminated group）→ PARENT-ALIAS/IDB 垫片/measure() 全部不运行（面板 220px 卡死、
          // IDB denied、parent.jQuery 跨源报错都是它的连锁反应）。改用 new RegExp('字符串')，
          // 模式内斜杠无需转义，模板求值不再破坏。
          var m = s.match(new RegExp('^([a-z][a-z0-9+.-]*://[^/]+/[^/]+/[^/]+)/.+%5C([^?#]+)', 'i'));
          if (m) {
            try { s = m[1] + '/' + m[2]; } catch (e2) {}
          }
          return _imgSrcDesc.set.call(this, s);
        },
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }

  // [STATUSBAR-DEBUG] iframe 内部错误捕获：脚本执行抛错或被 CSP 拦截时，
  // 以 postMessage（frame-error / frame-csp）上报父页面，避免直接 console 噪音。
  try {
    window.addEventListener('error', function (e) {
      try {
        // 资源加载失败（img/link/script）会触发 error 事件但无 error 对象，仅 e.target 带 src/href。
        // img/link 失败（ERR_ABORTED/403）多为 iframe 重渲染中止在途加载，属良性噪音，不打印。
        if (e && e.target && e.target !== window && (e.target.src || e.target.href)) {
          // [P0 2026-09-30] <script> 资源失败不再静默：脚本请求拿到 404/HTML 页
          // （本站 SPA 兜底、跨站 404 页）时浏览器会把响应体当 JS 解析，
          // 产生 SyntaxError: Unexpected token '<' —— "内容在源里、渲染全空白"
          // 的候选元凶，必须连同 URL 上报，否则这一整类故障在父页面不可见。
          // isConnected 过滤：元素已脱离 DOM 的在途加载中止仍按重渲染噪音跳过。
          var failedTarget = e.target;
          var failedTag = String(failedTarget.tagName || '').toUpperCase();
          if (failedTag === 'SCRIPT' && failedTarget.isConnected && window.parent && window.parent.postMessage) {
            var failedUrl = String(failedTarget.src || failedTarget.href || '');
            window.parent.postMessage({ source: 'palink-smart-card-frame', frameId: frameId, type: 'frame-error', message: 'script resource failed to load (HTML-as-JS suspect): ' + failedUrl, filename: failedUrl, lineno: 0 }, '*');
          }
          return;
        }
        var detail = (e && e.error && e.error.stack) ? e.error.stack : ((e && e.message) || 'unknown error');
        if (window.parent && window.parent.postMessage) {
          window.parent.postMessage({ source: 'palink-smart-card-frame', frameId: frameId, type: 'frame-error', message: detail, filename: e && e.filename, lineno: e && e.lineno }, '*');
        }
      } catch (_) {}
    }, true);
    window.addEventListener('securitypolicyviolation', function (e) {
      try {
        if (window.parent && window.parent.postMessage) {
          window.parent.postMessage({ source: 'palink-smart-card-frame', frameId: frameId, type: 'frame-csp', directive: e.violatedDirective, blockedURI: e.blockedURI }, '*');
        }
      } catch (_) {}
    });
    window.addEventListener('unhandledrejection', function (e) {
      try {
        if (window.parent && window.parent.postMessage) {
          window.parent.postMessage({ source: 'palink-smart-card-frame', frameId: frameId, type: 'frame-error', message: e.reason && (e.reason.stack || e.reason) }, '*');
        }
      } catch (_) {}
    });
    // [P0-FIX 2026-09-30] DOMContentLoaded 晚注册补发。卡脚本常用裸
    // document.addEventListener('DOMContentLoaded', init) 做初始化（如图文排版
    // 前端的故事渲染），但 iframe 的数据（chatMessages/variables）经
    // context-update 晚到；数据到达后运行时重放卡脚本时 DOMContentLoaded 早已
    // 触发过——此时注册的是一个永远不会触发的事件，init 永不执行，故事帧
    // 永远停留在 boot 时空数据下的"故事正文为空"。此处对"文档已加载完毕后的
    // DOMContentLoaded 注册"改为异步补发一次，语义与主页面 card-script-runner
    // 的 DOMContentLoaded 改写、本 shim readyCompat（jQuery 式 $(fn)）的
    // setTimeout 兜底一致——那两条路已有兜底，面板脚本因此能恢复，本补丁
    // 补齐裸 DOM API 这最后一条路。
    // ⚠️ 本段整体位于模板字符串内：注释与代码不得出现单反斜杠+字母字面量。
    try {
      var realDocAddEventListener = document.addEventListener.bind(document);
      document.addEventListener = function (type, listener, options) {
        if (String(type) === 'DOMContentLoaded' && document.readyState !== 'loading') {
          setTimeout(function () {
            try {
              if (typeof listener === 'function') {
                listener.call(document);
              } else if (listener && typeof listener.handleEvent === 'function') {
                listener.handleEvent({ type: 'DOMContentLoaded' });
              }
            } catch (_) {}
          }, 0);
          return;
        }
        return realDocAddEventListener(type, listener, options);
      };
    } catch (_) {}
  } catch (_) {}
  const uiText = ctx.language === 'en'
    ? {
        requestTimeout: 'Palink smart card request timed out',
        requestFailed: 'Palink smart card request failed',
      }
    : {
        requestTimeout: '角色卡兼容请求超时',
        requestFailed: '角色卡兼容请求失败',
      };
  if (ctx.language !== 'en') {
    Object.assign(uiText, {
      requestTimeout: '角色卡兼容请求超时',
      requestFailed: '角色卡兼容请求失败',
    });
  }
  const listeners = new Map();
  const memoryStorage = (storageType, initialValues = {}) => {
    const values = new Map(Object.entries(initialValues || {}).map(([key, value]) => [String(key), String(value)]));
    const persist = (op, key, value) => {
      post({ type: 'storage', storageType, op, key: key == null ? undefined : String(key), value: value == null ? undefined : String(value) });
    };
    return {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
      getItem(key) { key = String(key); return values.has(key) ? values.get(key) : null; },
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
  const userGestureWindowMs = 15000;
  let lastUserGestureAt = 0;
  // [SEC-2026-09-02 F-1] 只认浏览器派发的可信事件：isTrusted 由浏览器设置且无法被 JS 伪造，
  // 卡片脚本 dispatchEvent 合成的事件（isTrusted=false）不记入手势。否则恶意卡片一行合成
  // 事件就能让本 shim「主动」附上真帧内密钥，令牌校验形同虚设。
  // 宽松度说明：真实用户的 pointerdown/keydown/click 均为可信事件，正常卡片交互不受影响；
  // 唯一被排除的是「无任何真实交互却想骗手势」的场景——这正是要拦的攻击。
  const markUserGesture = (event) => {
    if (event && event.isTrusted === false) return;
    lastUserGestureAt = Date.now();
  };
  const hasRecentUserGesture = () => Date.now() - lastUserGestureAt <= userGestureWindowMs;
  const post = (payload) => {
    try {
      window.parent.postMessage({
        source: 'palink-smart-card',
        frameId,
        __palinkUserGesture: hasRecentUserGesture(),
        // [SEC-2026-09-02 F-1] 仅在「确实发生过真实用户手势」时附上帧内密钥。
        // 父侧据此判定手势声明可信（密钥由 <head> 的 meta 一次性投递，恶意卡片拿不到）；
        // 未发生手势时附空串，语义与旧的 __palinkUserGesture=false 完全一致。
        __palinkGestureToken: hasRecentUserGesture()
          ? (typeof __palinkFrameSecret === 'string' ? __palinkFrameSecret : '')
          : '',
        __palinkRuntimeMode: 'legacy',
        ...payload,
      }, '*');
    } catch {}
  };
  try {
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'].forEach((eventName) => {
      window.addEventListener(eventName, markUserGesture, { capture: true, passive: true });
      document.addEventListener(eventName, markUserGesture, { capture: true, passive: true });
    });
  } catch {}
  const isEditableTarget = (target) => {
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    if (!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
    }
    return element.isContentEditable || Boolean(element.closest?.('[contenteditable="true"],textarea,input,select'));
  };
  const postFrameFocusState = (focused) => {
    post({
      type: 'frameFocus',
      focused: Boolean(focused),
      editable: Boolean(focused && isEditableTarget(document.activeElement)),
    });
  };
  try {
    document.addEventListener('focusin', (event) => postFrameFocusState(isEditableTarget(event.target)), { capture: true });
    document.addEventListener('focusout', () => setTimeout(() => postFrameFocusState(false), 0), { capture: true });
    window.addEventListener('blur', () => postFrameFocusState(false));
    window.addEventListener('pagehide', () => postFrameFocusState(false));
  } catch {}
  if (!ctx.trustedNative) {
    try {
      Object.defineProperty(window, 'localStorage', { value: memoryStorage('localStorage', ctx.persistedStorage?.localStorage), configurable: true });
      Object.defineProperty(window, 'sessionStorage', { value: memoryStorage('sessionStorage', ctx.persistedStorage?.sessionStorage), configurable: true });
    } catch {}
  }
  let parentRequestSeq = 0;
  const parentRequests = new Map();
  const requestParent = (action, payload = {}) => new Promise((resolve) => {
    const requestId = frameId + ':rpc:' + (++parentRequestSeq);
    const timeout = setTimeout(() => {
      parentRequests.delete(requestId);
      resolve({ success: false, error: uiText.requestTimeout });
    }, 12000);
    parentRequests.set(requestId, { resolve, timeout });
    post({
      type: 'request',
      requestId,
      action,
      payload: {
        ...(payload && typeof payload === 'object' ? payload : {}),
        __palinkUserGesture: hasRecentUserGesture(),
        __palinkRuntimeMode: 'legacy',
        __palinkContext: {
          characterId: ctx.characterId,
          messageId: ctx.messageId,
          sessionId: ctx.sessionId,
        },
      },
    });
  });
  const setViewportCssNumber = (style, name, value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    style.setProperty(name, Math.max(0, Math.round(numeric * 100) / 100) + 'px');
  };
  const applyViewportContext = () => {
    const viewport = ctx.viewport && typeof ctx.viewport === 'object' ? ctx.viewport : {};
    const root = document.documentElement;
    const body = document.body;
    if (!root) return;
    const rootStyle = root.style;
    const bodyStyle = body?.style;
    setViewportCssNumber(rootStyle, '--palink-viewport-width', viewport.width);
    const stableViewportHeight = viewport.height || viewport.availableHeight || viewport.visualHeight;
    const stableAvailableHeight = viewport.availableHeight || stableViewportHeight || viewport.visualHeight;
    setViewportCssNumber(rootStyle, '--palink-viewport-height', stableViewportHeight);
    setViewportCssNumber(rootStyle, '--palink-visual-viewport-width', viewport.visualWidth);
    setViewportCssNumber(rootStyle, '--palink-visual-viewport-height', stableViewportHeight);
    setViewportCssNumber(rootStyle, '--palink-viewport-offset-top', viewport.offsetTop);
    setViewportCssNumber(rootStyle, '--palink-viewport-offset-left', viewport.offsetLeft);
    setViewportCssNumber(rootStyle, '--palink-safe-top', viewport.safeTop);
    setViewportCssNumber(rootStyle, '--palink-safe-bottom', viewport.safeBottom);
    setViewportCssNumber(rootStyle, '--palink-composer-height', viewport.composerHeight);
    setViewportCssNumber(rootStyle, '--palink-available-height', stableAvailableHeight);
    rootStyle.setProperty('--palink-viewport-scale', String(Number.isFinite(Number(viewport.scale)) ? viewport.scale : 1));
    root.dataset.palinkKeyboardOpen = viewport.keyboardOpen ? 'true' : 'false';
    root.dataset.palinkPresentationMode = ctx.presentationMode || 'inline';
    root.dataset.palinkImmersive = viewport.immersive ? 'true' : 'false';
    if (viewport.immersive || String(ctx.presentationMode || '').startsWith('immersive')) {
      rootStyle.minHeight = 'var(--palink-available-height, 100vh)';
      rootStyle.height = 'var(--palink-available-height, 100vh)';
      if (bodyStyle) {
        bodyStyle.minHeight = 'var(--palink-available-height, 100vh)';
        bodyStyle.height = 'var(--palink-available-height, 100vh)';
      }
    }
  };
  const dispatchViewportEvents = () => {
    try { window.dispatchEvent(new Event('resize')); } catch {}
    try { window.dispatchEvent(new Event('orientationchange')); } catch {}
    try { document.dispatchEvent(new Event('palink:viewport')); } catch {}
  };
  applyViewportContext();
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'palink-smart-card-parent' || data.frameId !== frameId) return;
    if (data.type === 'context-update') {
      if (data.context && typeof data.context === 'object') {
        Object.assign(ctx, clone(data.context));
        // MVU 变量热更新：收到新 variables 时刷新运行时并触发事件
        if (data.context.variables && typeof data.context.variables === 'object') {
          try {
            // [SINGLE-SOURCE] compatV2 已接管变量读写时，由 compatV2 的 context-update
            // 处理（applyParentContextUpdateCompat → deepMergeVariablesCompat 合并进
            // chatVariableStore），legacy 不再重复 merge，避免双 store 分叉。
            const compatTookOver = typeof window.setVariable === 'function'
              && typeof window.getVariable === 'function'
              && window.setVariable !== setSmartCardVariable
              && window.getVariable !== getSmartCardVariable;
            // [MVU-EVENTS 2026-10-05] started 必须在合并**前** emit（契约：某轮变量更新开始时）。
            eventSource.emit(MVU_EVENT_KEYS.VARIABLE_UPDATE_STARTED, clone(smartCardVariableStore));
            if (!compatTookOver) {
              mergePlainObjects(smartCardVariableStore, clone(data.context.variables));
            }
            // [MVU-EVENTS 2026-10-05] 顺序对齐契约：started 已在合并前 emit，
            // 此处 ended → before_message_update（即将用更新后的变量更新楼层）。
            eventSource.emit(MVU_EVENT_KEYS.VARIABLE_UPDATE_ENDED, clone(smartCardVariableStore));
            eventSource.emit(MVU_EVENT_KEYS.BEFORE_MESSAGE_UPDATE, clone(smartCardVariableStore));
            eventSource.emit('CHAT_VARIABLES_UPDATED', clone(smartCardVariableStore));
          } catch {}
        }
        applyViewportContext();
        dispatchViewportEvents();
      }
      return;
    }
    const pending = parentRequests.get(data.requestId);
    if (!pending) return;
    parentRequests.delete(data.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(data.ok ? (data.result ?? { success: true }) : { success: false, error: data.error || uiText.requestFailed });
  });
  const substituteParams = (text) => String(text ?? '')
    .replaceAll('{{user}}', ctx.userName)
    .replaceAll('{{char}}', ctx.characterName)
    .replaceAll('{{name1}}', ctx.userName)
    .replaceAll('{{name2}}', ctx.characterName);
  const clone = (value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  };
  const getByPath = (source, path, fallback) => {
    const parts = Array.isArray(path)
      ? path
      : String(path ?? '').replace(/\\[(\\w+)\\]/g, '.$1').split('.').filter(Boolean);
    let current = source;
    for (const part of parts) {
      if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), part)) return fallback;
      current = current[part];
    }
    return current === undefined ? fallback : current;
  };
  const setByPath = (source, path, value) => {
    const parts = Array.isArray(path) ? path : String(path ?? '').split('.').filter(Boolean);
    if (parts.length === 0) return source;
    let current = source;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
    return source;
  };
  const countIndent = (line) => (String(line || '').match(/^ */)?.[0]?.length || 0);
  const isBlankLine = (line) => !String(line || '').trim();
  const stripInlineValueTags = (value) => String(value ?? '')
    .replace(/^<q>([\\s\\S]*)<\\/q>$/i, '$1')
    .replace(/^<lore>([\\s\\S]*)<\\/lore>$/i, '$1')
    .trim();
  const parseVariableScalar = (value) => {
    const raw = stripInlineValueTags(value);
    if (raw === '{}') return {};
    if (raw === '[]') return [];
    if (raw === 'null' || raw === '~') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1).replace(/\\\\(["'\\\\])/g, '$1').replace(/\\\\n/g, '\\n');
    }
    if (/^-?\\d+(?:\\.\\d+)?$/.test(raw)) return Number(raw);
    return raw;
  };
  const splitVariablePair = (line) => {
    const source = String(line || '');
    const colonIndex = source.indexOf(':');
    if (colonIndex < 0) return null;
    return {
      key: source.slice(0, colonIndex).trim(),
      value: source.slice(colonIndex + 1).trim(),
    };
  };
  const parseIndentedVariables = (source) => {
    const lines = String(source || '')
      .replace(/\\t/g, '  ')
      .split(/\\r?\\n/)
      .filter((line) => !isBlankLine(line));
    const nextIndexAtOrAfter = (index) => {
      let next = index;
      while (next < lines.length && isBlankLine(lines[next])) next += 1;
      return next;
    };
    const parseBlock = (startIndex, indent) => {
      let index = nextIndexAtOrAfter(startIndex);
      if (index >= lines.length) return { value: {}, index };
      const firstTrimmed = lines[index].trim();
      if (countIndent(lines[index]) < indent) return { value: {}, index };
      const arrayMode = firstTrimmed.startsWith('- ');
      if (arrayMode) {
        const values = [];
        while (index < lines.length) {
          const lineIndent = countIndent(lines[index]);
          if (lineIndent < indent) break;
          const trimmed = lines[index].trim();
          if (lineIndent !== indent || !trimmed.startsWith('- ')) break;
          const rest = trimmed.slice(2).trim();
          if (!rest) {
            const child = parseBlock(index + 1, indent + 2);
            values.push(child.value);
            index = child.index;
            continue;
          }
          const pair = splitVariablePair(rest);
          if (pair && pair.key) {
            const item = {};
            if (pair.value) {
              item[pair.key] = parseVariableScalar(pair.value);
              index += 1;
            } else {
              const child = parseBlock(index + 1, indent + 2);
              item[pair.key] = child.value;
              index = child.index;
            }
            values.push(item);
            continue;
          }
          values.push(parseVariableScalar(rest));
          index += 1;
        }
        return { value: values, index };
      }
      const object = {};
      while (index < lines.length) {
        const lineIndent = countIndent(lines[index]);
        if (lineIndent < indent) break;
        if (lineIndent > indent) {
          index += 1;
          continue;
        }
        const trimmed = lines[index].trim();
        if (trimmed.startsWith('- ')) break;
        const pair = splitVariablePair(trimmed);
        if (!pair || !pair.key) {
          index += 1;
          continue;
        }
        if (pair.value) {
          object[pair.key] = parseVariableScalar(pair.value);
          index += 1;
          continue;
        }
        const nextIndex = nextIndexAtOrAfter(index + 1);
        if (nextIndex >= lines.length || countIndent(lines[nextIndex]) <= lineIndent) {
          object[pair.key] = {};
          index += 1;
          continue;
        }
        const child = parseBlock(nextIndex, countIndent(lines[nextIndex]));
        object[pair.key] = child.value;
        index = child.index;
      }
      return { value: object, index };
    };
    return parseBlock(0, countIndent(lines[nextIndexAtOrAfter(0)] || '')).value;
  };
  const extractInitVariableBlocks = () => {
    const candidates = [
      ctx.messageContent,
      ctx.firstMes,
      ...(Array.isArray(ctx.alternateGreetings) ? ctx.alternateGreetings : []),
    ];
    for (const candidate of candidates) {
      const text = substituteParams(candidate || '');
      const blocks = [];
      const pattern = /<initvar>([\\s\\S]*?)<\\/initvar>/gi;
      let match;
      while ((match = pattern.exec(text))) {
        if (match[1]?.trim()) blocks.push(match[1]);
      }
      if (blocks.length > 0) return blocks;
    }
    return [];
  };
  const mergePlainObjects = (target, source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
    Object.entries(source).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        mergePlainObjects(target[key], value);
      } else {
        target[key] = value;
      }
    });
    return target;
  };
  // 变量真源：后端下发的 ctx.variables（替代硬编码默认值）
  const defaultVariables = (ctx.variables && typeof ctx.variables === 'object')
    ? clone(ctx.variables)
    : { stat_data: {} };
  const parsedVariableBlocks = extractInitVariableBlocks()
    .map((block) => {
      try { return parseIndentedVariables(block); } catch { return {}; }
    })
    .filter((value) => value && typeof value === 'object' && Object.keys(value).length > 0);
  const allVariables = clone(defaultVariables);
  parsedVariableBlocks.forEach((value) => {
    const normalized = value.stat_data && typeof value.stat_data === 'object'
      ? value
      : { stat_data: value };
    mergePlainObjects(allVariables, normalized);
  });
  const eventSource = {
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
      return () => eventSource.off(type, cb);
    },
    off(type, cb) { listeners.get(type)?.delete(cb); },
    once(type, cb) {
      const wrapped = (...args) => {
        eventSource.off(type, wrapped);
        cb?.(...args);
      };
      eventSource.on(type, wrapped);
    },
    removeListener(type, cb) { eventSource.off(type, cb); },
    makeFirst(type, cb) { eventSource.on(type, cb); return cb; },
    makeLast(type, cb) { eventSource.on(type, cb); return cb; },
    emit(type, ...args) {
      for (const cb of listeners.get(type) || []) {
        try { cb(...args); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
      }
      return Promise.resolve();
    },
  };
  const buildSwipes = () => {
    const primarySwipe = ctx.isInit && ctx.firstMes ? ctx.firstMes : ctx.messageContent;
    const swipes = [String(primarySwipe || '')];
    if (Array.isArray(ctx.alternateGreetings)) {
      ctx.alternateGreetings.forEach((greeting) => {
        const value = String(greeting || '');
        if (value) swipes.push(value);
      });
    }
    return swipes;
  };
  let currentSwipeId = 0;
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
  const copyStMessageMeta = (target, source, extra = source?.extra) => {
    stMessageMetaKeys.forEach((key) => {
      const value = source?.[key] !== undefined ? source[key] : extra?.[key];
      if (value !== undefined) target[key] = clone(value);
    });
    return target;
  };
  const normalizeChatMessage = (message, fallbackIndex = 0) => {
    const role = String(message?.role || 'assistant');
`;
