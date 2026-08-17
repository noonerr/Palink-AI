/**
 * Smart Card 帧内运行时 · 旧版 SillyTavern 全局模拟段
 *
 * 来源：CharacterCardRenderer.tsx `buildShim()` 原 L2373-4372，逐字节搬运，未改动任何逻辑。
 * 该段是注入到卡片 iframe 内的 JS 源码文本，运行在 iframe 作用域内，
 * 与后续 `buildFrameMeasureSegment()` 产物同处一个 IIFE，共享词法作用域
 * （例如本段定义的 getContext / parentDocumentStore 会被测量段引用，反之
 *  本段结尾的 window.sendToTavern 之后紧接测量段的 imageQueue* 常量）。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串常量，内部**不得**出现反引号或 \${，否则会被宿主模板解析。
 *  2. 拼接顺序固定：HEAD(ctx/frameId) → 本段 → 测量段 → IIFE 收尾，不可调换。
 *  3. 修改后必须跑 `node scripts/verify-shim-identity.mjs` 比对字节快照。
 */
export const LEGACY_ST_SIM_SEGMENT = `  // [PARENT-ALIAS] 沙箱卡的 window.parent / window.top 兼容代理：
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
            has: function (_t, prop) { return Object.prototype.hasOwnProperty.call(KNOWN_KEYS, String(prop)); },
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
        // 这类失败（ERR_ABORTED/403）多为 iframe 重渲染中止在途加载，属良性噪音，不打印。
        if (e && e.target && e.target !== window && (e.target.src || e.target.href)) {
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
  const markUserGesture = () => {
    lastUserGestureAt = Date.now();
  };
  const hasRecentUserGesture = () => Date.now() - lastUserGestureAt <= userGestureWindowMs;
  const post = (payload) => {
    try {
      window.parent.postMessage({
        source: 'palink-smart-card',
        frameId,
        __palinkUserGesture: hasRecentUserGesture(),
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
            if (!compatTookOver) {
              mergePlainObjects(smartCardVariableStore, clone(data.context.variables));
            }
            eventSource.emit('VARIABLE_UPDATE_ENDED', clone(smartCardVariableStore));
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
    const content = String(message?.content ?? message?.message ?? message?.mes ?? '');
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
      return byIndex ? [byIndex] : [];
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
  let activeWorldbookName = '';
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
      VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED',
      VARIABLE_UPDATE_STARTED: 'VARIABLE_UPDATE_STARTED',
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
      eventSource.emit('VARIABLE_UPDATE_ENDED', clone(smartCardVariableStore));
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
  window.getCharWorldbookNames = window.getCharWorldbookNames || (async () => ({
    primary: activeWorldbookName,
    additional: activeWorldbookName ? [activeWorldbookName] : [],
  }));
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
  const parseInlineArg = (value, event, element) => {
    const text = String(value || '').trim();
    if (!text) return undefined;
    if ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'")) {
      return parseInlineString(text);
    }
    if (text === 'event') return event;
    if (text === 'this') return element;
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?\\d+(?:\\.\\d+)?$/.test(text)) return Number(text);
    if (/^[\\[{]/.test(text)) {
      try { return JSON.parse(text); } catch {}
    }
    const resolved = resolveWindowPath(text.replace(/^window\\./, ''));
    return resolved === undefined ? text : resolved;
  };
  const splitJQueryMethodChain = (source) => {
    const calls = [];
    const text = String(source || '').trim();
    let index = 0;
    while (index < text.length) {
      while (/\\s/.test(text[index] || '')) index += 1;
      if (text[index] !== '.') return null;
      index += 1;
      const nameStart = index;
      while (/[A-Za-z0-9_$]/.test(text[index] || '')) index += 1;
      const name = text.slice(nameStart, index);
      if (!name) return null;
      while (/\\s/.test(text[index] || '')) index += 1;
      if (text[index] !== '(') return null;
      index += 1;
      const argsStart = index;
      let quote = null;
      let escaped = false;
      let depth = 1;
      while (index < text.length) {
        const char = text[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === '\\\\') escaped = true;
          else if (char === quote) quote = null;
          index += 1;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          index += 1;
          continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (depth === 0) break;
        index += 1;
      }
      if (depth !== 0) return null;
      calls.push({ name, args: text.slice(argsStart, index) });
      index += 1;
    }
    return calls;
  };
  const invokeJQueryInlineChain = (code, event, element) => {
    const match = String(code || '').trim().match(/^\\$\\s*\\(([\\s\\S]*?)\\)\\s*([\\s\\S]+)$/);
    if (!match || !match[2]?.trim?.().startsWith('.')) return false;
    const calls = splitJQueryMethodChain(match[2]);
    if (!calls || calls.length === 0) return false;
    let collection = dollar(parseInlineArg(match[1], event, element));
    for (const call of calls) {
      const method = collection?.[call.name];
      if (typeof method !== 'function') return false;
      const args = splitInlineArgs(call.args).map((arg) => parseInlineArg(arg, event, element));
      const result = method.apply(collection, args);
      if (result !== undefined && result !== null) collection = result;
    }
    return true;
  };
  const inlineSourceDataKey = (attrName) => {
    const name = String(attrName || '').replace(/^on/, '');
    return 'palinkInlineSource' + name.charAt(0).toUpperCase() + name.slice(1);
  };
  const invokeInlineEventHandler = (element, attrName, event) => {
    const code = element?.getAttribute?.(attrName) || element?.dataset?.[inlineSourceDataKey(attrName)];
    if (!code) return false;
    const normalized = String(code).trim().replace(/^return\\s+/, '').replace(/;\\s*$/, '');
    if (invokeJQueryInlineChain(normalized, event, element)) return true;
    const match = normalized.match(/^([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\(([\\s\\S]*)\\)$/);
    if (match) {
      const fn = resolveWindowPath(match[1].replace(/^window\\./, ''));
      if (typeof fn === 'function') {
        try {
          const args = splitInlineArgs(match[2]).map((arg) => parseInlineArg(arg, event, element));
          fn.apply(element, args);
          return true;
        } catch (error) {
          post({ type: 'error', message: String(error?.message || error) });
          return false;
        }
      }
    }
    try {
      const runner = new Function('event', 'element', 'window', 'document', '$', 'jQuery', String(code));
      runner.call(element, event, element, window, document, window.$, window.jQuery || window.$);
      return true;
    } catch (error) {
      post({ type: 'error', message: String(error?.message || error) });
      return false;
    }
  };
  const bindInlineEventHandlers = (root = document) => {
    const scope = root?.querySelectorAll ? root : document;
    const elements = Array.from(scope.querySelectorAll?.('[onclick],[onchange],[onsubmit]') || []);
    if (scope.nodeType === 1 && scope.matches?.('[onclick],[onchange],[onsubmit]')) elements.unshift(scope);
    const bindings = [
      ['click', 'onclick', 'palinkInlineClick'],
      ['change', 'onchange', 'palinkInlineChange'],
      ['submit', 'onsubmit', 'palinkInlineSubmit'],
    ];
    elements.forEach((element) => {
      bindings.forEach(([eventName, attrName, marker]) => {
        if (!element.hasAttribute?.(attrName) || element.dataset?.[marker] === 'true') return;
        const sourceKey = inlineSourceDataKey(attrName);
        if (element.dataset && !element.dataset[sourceKey]) element.dataset[sourceKey] = element.getAttribute(attrName) || '';
        if (element.dataset) element.dataset[marker] = 'true';
      });
    });
  };
  const nearestDashboardItem = (items, clientX, clientY) => {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    });
    return best;
  };
  const activateDashboardItem = (target, event) => {
    if (!target) return false;
    try {
      const forwardedEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      target.dispatchEvent(forwardedEvent);
      if (forwardedEvent.__palinkInlineHandled) return true;
      if (target.hasAttribute?.('onclick')) return true;
    } catch {}
    if (invokeInlineEventHandler(target, 'onclick', event)) return true;
    const nested = target.querySelector?.('[onclick]');
    if (nested && invokeInlineEventHandler(nested, 'onclick', event)) return true;
    return false;
  };
  const installDashboardTapProxy = () => {
    const dashboard = document.getElementById('dashboard');
    if (!dashboard || dashboard.dataset.palinkTapProxy === 'true') return;
    dashboard.dataset.palinkTapProxy = 'true';
    let lastProxyTap = 0;
    const handleTap = (event) => {
      if (event.defaultPrevented) return;
      if (event.type === 'pointerup' && event.button !== 0) return;
      if (event.target?.closest?.('.item-container, button, a, input, textarea, select')) return;
      const items = Array.from(dashboard.querySelectorAll('.item-container,[onclick]')).filter((item) => {
        if (item === dashboard) return false;
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (items.length === 0) return;
      const now = Date.now();
      if (now - lastProxyTap < 280) return;
      const target = nearestDashboardItem(items, event.clientX, event.clientY);
      if (!target) return;
      lastProxyTap = now;
      event.preventDefault();
      event.stopPropagation();
      activateDashboardItem(target, event);
    };
    dashboard.addEventListener('click', handleTap, true);
    dashboard.addEventListener('pointerup', handleTap, true);
  };
  const installInteractionAdapters = (root = document) => {
    bindInlineEventHandlers(root);
    installDashboardTapProxy();
  };
  ready(() => {
    installInteractionAdapters();
    try {
      new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes?.forEach((node) => {
            if (node?.nodeType === 1) installInteractionAdapters(node);
          });
        });
        installInteractionAdapters();
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
    setTimeout(installInteractionAdapters, 120);
    setTimeout(installInteractionAdapters, 500);
    setTimeout(installInteractionAdapters, 1200);
  });
  const toKebab = (value) => String(value).replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
  const toCamel = (value) => String(value).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
  const normalizeDisplay = (node, fallback = 'block') => {
    if (!node) return fallback;
    const tag = node.tagName?.toLowerCase?.();
    if (tag === 'span' || tag === 'a' || tag === 'label') return 'inline';
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return '';
    return fallback;
  };
  const parseDataValue = (value) => {
    if (value == null) return value;
    const text = String(value);
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?\\d+(?:\\.\\d+)?$/.test(text)) return Number(text);
    if (/^[\\[{]/.test(text)) {
      try { return JSON.parse(text); } catch {}
    }
    return value;
  };
  const setStyleValue = (node, name, value) => {
    if (!node?.style) return;
    const cssName = toKebab(name);
    const cssValue = String(value ?? '');
    if (typeof node.style.setProperty === 'function') {
      node.style.setProperty(cssName, cssValue);
      return;
    }
    try { node.style[name] = cssValue; } catch {}
  };
  const normalizeDollarContent = (content) => {
    if (content == null) return [];
    if (Array.isArray(content)) return content.flatMap(normalizeDollarContent);
    if (content?.nodeType) return [content];
    if (typeof content === 'string') {
      const template = document.createElement('template');
      template.innerHTML = content;
      return Array.from(template.content.childNodes);
    }
    if (typeof content[Symbol.iterator] === 'function') return Array.from(content);
    return [];
  };
  const createParentVirtualElement = (id, tagName, options = {}) => {
    const listeners = new Map();
    const element = {
      __palinkParentElement: true,
      nodeType: 1,
      id,
      tagName,
      value: options.value || '',
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
        Array.from(listeners.get(eventType) || []).forEach((listener) => {
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
      matches(selector) { return parentSelectorMatches(selector, id); },
      closest(selector) { return parentSelectorMatches(selector, id) ? this : null; },
      getAttribute(name) {
        if (name === 'id') return id;
        if (name === 'value') return this.value;
        return null;
      },
      setAttribute(name, value) {
        if (name === 'value') this.value = String(value ?? '');
      },
      removeAttribute() {},
    };
    if (tagName === 'FORM') {
      element.requestSubmit = () => parentElementStore.send_but.click();
      element.submit = () => parentElementStore.send_but.click();
    }
    return element;
  };
  const parentElementStore = {
    send_textarea: createParentVirtualElement('send_textarea', 'TEXTAREA', {
      dispatch(_event, eventType) {
        if (eventType === 'input' || eventType === 'change') {
          post({ type: 'setInputDraft', content: String(parentElementStore.send_textarea.value || '') });
        }
      },
    }),
    send_but: createParentVirtualElement('send_but', 'BUTTON', {
      click() {
        const content = String(parentElementStore.send_textarea.value || '').trim();
        if (!content) return;
        void requestParent('sendMessage', { content, awaitResult: false });
        parentElementStore.send_textarea.value = '';
        post({ type: 'setInputDraft', content: '' });
      },
    }),
    send_form: createParentVirtualElement('send_form', 'FORM', {
      dispatch(_event, eventType) {
        if (eventType === 'submit') parentElementStore.send_but.click();
      },
    }),
  };
  parentElementStore.sendTextarea = parentElementStore.send_textarea;
  parentElementStore.send_textarea_field = parentElementStore.send_textarea;
  parentElementStore.chat_textarea = parentElementStore.send_textarea;
  parentElementStore.sendButton = parentElementStore.send_but;
  parentElementStore.send_button = parentElementStore.send_but;
  parentElementStore.sendButtonWrapper = parentElementStore.send_but;
  parentElementStore.send_form_container = parentElementStore.send_form;
  const parentSelectorMatches = (selector, id) => {
    const normalized = String(selector || '').trim();
    if (!normalized) return false;
    const selectorParts = normalized.split(',').map((part) => part.trim()).filter(Boolean);
    return selectorParts.some((part) => {
      if (part === '*' || part === '#' + id || part === '[id="' + id + '"]' || part === "[id='" + id + "']") return true;
      if (id === 'send_textarea') return /(?:^|[\s>+~])textarea\b|#(?:send_textarea|sendTextarea|chat_textarea|send-textarea|chat-input|send_textarea_field)\b|(?:send_textarea|sendTextarea|chat_textarea|send-textarea|chat-input)/i.test(part);
      if (id === 'send_but') return /(?:^|[\s>+~])button\b|#(?:send_but|sendButton|send-button|send_button|send)\b|(?:send_but|send-button|sendButton|send_button|sendButtonWrapper)/i.test(part);
      if (id === 'send_form') return /^(?:form)?#send_form$|^form\b|send_form|send-form|chat-form/i.test(part);
      return false;
    });
  };
  const getParentElementBySelector = (selector) => {
    const normalized = String(selector || '').trim();
    if (!normalized) return null;
    if (parentSelectorMatches(normalized, 'send_textarea')) return parentElementStore.send_textarea;
    if (parentSelectorMatches(normalized, 'send_but')) return parentElementStore.send_but;
    if (parentSelectorMatches(normalized, 'send_form')) return parentElementStore.send_form;
    return null;
  };
  const parentDocumentStore = {
    __palinkParentDocument: true,
    getElementById(id) {
      const key = String(id || '').trim();
      return parentElementStore[key] || null;
    },
    querySelector(selector) {
      return getParentElementBySelector(selector);
    },
    querySelectorAll(selector) {
      const element = getParentElementBySelector(selector);
      return element ? [element] : [];
    },
    getElementsByClassName() { return []; },
    getElementsByTagName(tagName) {
      const tag = String(tagName || '').toLowerCase();
      if (tag === 'textarea') return [parentElementStore.send_textarea];
      if (tag === 'button') return [parentElementStore.send_but];
      if (tag === 'form') return [parentElementStore.send_form];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    createEvent() { return { initEvent() {} }; },
  };
  const createDollarCollection = (nodes) => {
    const collection = Array.from(nodes || []);
    collection.ready = function(cb) { ready(cb); return this; };
    collection.each = function(cb) {
      if (typeof cb === 'function') this.forEach((node, index) => cb.call(node, index, node));
      return this;
    };
    collection.on = function(type, selectorOrCb, cb) {
      const delegated = typeof selectorOrCb === 'string';
      const handler = delegated ? cb : selectorOrCb;
      if (typeof handler !== 'function') return this;
      this.forEach((node) => {
        node.addEventListener?.(type, function(event) {
          if (delegated) {
            const target = event.target?.closest?.(selectorOrCb);
            if (!target || !node.contains(target)) return;
            handler.call(target, event);
            return;
          }
          handler.call(node, event);
        });
      });
      return this;
    };
    collection.off = function(type, cb) {
      this.forEach((node) => node.removeEventListener?.(type, cb));
      return this;
    };
    collection.click = function(cb) {
      if (typeof cb === 'function') return this.on('click', cb);
      return this.trigger('click');
    };
    collection.submit = function(cb) {
      if (typeof cb === 'function') return this.on('submit', cb);
      return this.trigger('submit');
    };
    collection.css = function(name, value) {
      if (typeof name === 'string' && value === undefined) {
        const node = this[0];
        return node ? window.getComputedStyle(node).getPropertyValue(toKebab(name)) || node.style[name] : undefined;
      }
      this.forEach((node) => {
        if (!node?.style) return;
        if (typeof name === 'object') {
          Object.entries(name).forEach(([key, val]) => setStyleValue(node, key, val));
        } else {
          setStyleValue(node, name, value);
        }
      });
      return this;
    };
    collection.html = function(value) {
      if (value === undefined) return this[0]?.innerHTML;
      this.forEach((node) => { node.innerHTML = String(value ?? ''); });
      return this;
    };
    collection.append = function(...items) {
      this.forEach((node) => {
        if (!node?.appendChild) return;
        items.flatMap(normalizeDollarContent).forEach((child) => {
          try { node.appendChild(child.cloneNode ? child.cloneNode(true) : child); } catch {}
        });
      });
      return this;
    };
    collection.prepend = function(...items) {
      this.forEach((node) => {
        if (!node?.insertBefore) return;
        const first = node.firstChild;
        items.flatMap(normalizeDollarContent).forEach((child) => {
          try { node.insertBefore(child.cloneNode ? child.cloneNode(true) : child, first); } catch {}
        });
      });
      return this;
    };
    collection.appendTo = function(target) {
      dollar(target).append(this);
      return this;
    };
    collection.prependTo = function(target) {
      dollar(target).prepend(this);
      return this;
    };
    collection.empty = function() {
      this.forEach((node) => { if ('innerHTML' in node) node.innerHTML = ''; });
      return this;
    };
    collection.remove = function() {
      this.forEach((node) => node.parentNode?.removeChild?.(node));
      return this;
    };
    collection.text = function(value) {
      if (value === undefined) return this[0]?.textContent;
      this.forEach((node) => { node.textContent = String(value ?? ''); });
      return this;
    };
    collection.addClass = function(value) {
      String(value || '').split(/\\s+/).filter(Boolean).forEach((className) => this.forEach((node) => node.classList?.add(className)));
      return this;
    };
    collection.removeClass = function(value) {
      if (value === undefined) {
        this.forEach((node) => node.removeAttribute?.('class'));
        return this;
      }
      String(value || '').split(/\\s+/).filter(Boolean).forEach((className) => this.forEach((node) => node.classList?.remove(className)));
      return this;
    };
    collection.toggleClass = function(value, force) {
      String(value || '').split(/\\s+/).filter(Boolean).forEach((className) => this.forEach((node) => node.classList?.toggle(className, force)));
      return this;
    };
    collection.hasClass = function(value) {
      return Boolean(this[0]?.classList?.contains(value));
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
    collection.removeAttr = function(name) {
      String(name || '').split(/\\s+/).filter(Boolean).forEach((attrName) => {
        this.forEach((node) => node.removeAttribute?.(attrName));
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
    collection.data = function(name, value) {
      const key = String(name || '');
      const dataName = 'data-' + toKebab(key);
      const camelKey = toCamel(key);
      if (value === undefined) {
        const node = this[0];
        if (!node) return undefined;
        return parseDataValue(node.dataset?.[camelKey] ?? node.dataset?.[key] ?? node.getAttribute?.(dataName));
      }
      this.forEach((node) => {
        if (node.dataset) node.dataset[camelKey] = String(value);
        else node.setAttribute?.(dataName, String(value));
      });
      return this;
    };
    collection.removeData = function(name) {
      const keys = name === undefined
        ? []
        : String(name || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        if (!node) return;
        if (keys.length === 0) {
          Object.keys(node.dataset || {}).forEach((key) => { try { delete node.dataset[key]; } catch {} });
          return;
        }
        keys.forEach((key) => {
          const camelKey = toCamel(key);
          try { delete node.dataset?.[camelKey]; } catch {}
          node.removeAttribute?.('data-' + toKebab(key));
        });
      });
      return this;
    };
    collection.val = function(value) {
      if (value === undefined) return this[0]?.value ?? '';
      this.forEach((node) => { if ('value' in node) node.value = String(value ?? ''); });
      return this;
    };
    collection.get = function(index) {
      if (index === undefined) return Array.from(this);
      const resolved = Number(index) < 0 ? this.length + Number(index) : Number(index);
      return this[resolved];
    };
    collection.toArray = function() { return Array.from(this); };
    collection.add = function(selector) {
      const current = Array.from(this);
      const extra = dollar(selector).toArray ? dollar(selector).toArray() : Array.from(dollar(selector) || []);
      return createDollarCollection([...current, ...extra].filter((node, index, arr) => node && arr.indexOf(node) === index));
    };
    collection.filter = function(selectorOrCb) {
      const nodes = Array.prototype.filter.call(this, (node, index) => {
        if (typeof selectorOrCb === 'function') return Boolean(selectorOrCb.call(node, index, node));
        return Boolean(node?.matches?.(selectorOrCb));
      });
      return createDollarCollection(nodes);
    };
    collection.not = function(selectorOrCb) {
      const filtered = this.filter(selectorOrCb);
      return createDollarCollection(Array.prototype.filter.call(this, (node) => !filtered.includes(node)));
    };
    collection.index = function(target) {
      if (target !== undefined) return Array.prototype.indexOf.call(this, dollar(target)[0]);
      const node = this[0];
      if (!node?.parentElement) return -1;
      return Array.from(node.parentElement.children || []).indexOf(node);
    };
    collection.trigger = function(type) {
      const eventType = typeof type === 'string' ? type : type?.type;
      if (!eventType) return this;
      this.forEach((node) => {
        if (eventType === 'click' && typeof node.click === 'function') {
          try {
            node.click();
            return;
          } catch {}
        }
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        node.dispatchEvent?.(event);
        if (eventType === 'submit' && !event.defaultPrevented && typeof node.requestSubmit === 'function') {
          try { node.requestSubmit(); } catch {}
        }
      });
      return this;
    };
    collection.is = function(selector) {
      const node = this[0];
      if (!node) return false;
      if (selector === ':visible') {
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      }
      return Boolean(node.matches?.(selector));
    };
    collection.hide = function(duration, complete) {
      this.forEach((node) => { if (node?.style) node.style.display = 'none'; });
      if (typeof duration === 'function') duration.call(this[0]);
      if (typeof complete === 'function') setTimeout(() => complete.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.show = function(duration, complete) {
      this.forEach((node) => { if (node?.style) node.style.display = normalizeDisplay(node); });
      if (typeof duration === 'function') duration.call(this[0]);
      if (typeof complete === 'function') setTimeout(() => complete.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.toggle = function(force) {
      this.forEach((node) => {
        if (!node?.style) return;
        const visible = window.getComputedStyle(node).display !== 'none';
        const shouldShow = typeof force === 'boolean' ? force : !visible;
        node.style.display = shouldShow ? normalizeDisplay(node) : 'none';
      });
      return this;
    };
    collection.fadeIn = function(duration, complete) {
      this.show();
      this.css('opacity', 1);
      if (typeof duration === 'function') duration.call(this[0]);
      if (typeof complete === 'function') setTimeout(() => complete.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.fadeOut = function(duration, complete) {
      this.css('opacity', 0);
      const delay = Number(duration) || 0;
      setTimeout(() => {
        this.hide();
        if (typeof complete === 'function') complete.call(this[0]);
      }, delay);
      if (typeof duration === 'function') duration.call(this[0]);
      return this;
    };
    collection.fadeToggle = function(duration, complete) {
      const visible = this.is(':visible');
      return visible ? this.fadeOut(duration, complete) : this.fadeIn(duration, complete);
    };
    collection.slideDown = function(duration, complete) { return this.show(duration, complete); };
    collection.slideUp = function(duration, complete) { return this.hide(duration, complete); };
    collection.slideToggle = function() {
      this.forEach((node) => {
        if (!node?.style) return;
        const style = window.getComputedStyle(node);
        node.style.display = style.display === 'none' ? normalizeDisplay(node) : 'none';
      });
      return this;
    };
    collection.stop = function() { return this; };
    collection.animate = function(properties, duration, easing, complete) {
      const done = typeof duration === 'function'
        ? duration
        : typeof easing === 'function'
          ? easing
          : typeof complete === 'function'
            ? complete
            : null;
      if (properties && typeof properties === 'object') {
        this.css(properties);
      }
      if (done) setTimeout(() => done.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.width = function(value) {
      if (value === undefined) return this[0]?.getBoundingClientRect?.().width ?? 0;
      return this.css('width', typeof value === 'number' ? value + 'px' : value);
    };
    collection.height = function(value) {
      if (value === undefined) return this[0]?.getBoundingClientRect?.().height ?? 0;
      return this.css('height', typeof value === 'number' ? value + 'px' : value);
    };
    collection.outerWidth = function() { return this[0]?.getBoundingClientRect?.().width ?? 0; };
    collection.outerHeight = function() { return this[0]?.getBoundingClientRect?.().height ?? 0; };
    collection.scrollTop = function(value) {
      if (value === undefined) return this[0]?.scrollTop ?? 0;
      this.forEach((node) => { if ('scrollTop' in node) node.scrollTop = Number(value) || 0; });
      return this;
    };
    collection.scrollLeft = function(value) {
      if (value === undefined) return this[0]?.scrollLeft ?? 0;
      this.forEach((node) => { if ('scrollLeft' in node) node.scrollLeft = Number(value) || 0; });
      return this;
    };
    collection.offset = function() {
      const rect = this[0]?.getBoundingClientRect?.();
      return rect ? { top: rect.top + window.scrollY, left: rect.left + window.scrollX } : { top: 0, left: 0 };
    };
    collection.position = function() {
      const rect = this[0]?.getBoundingClientRect?.();
      return rect ? { top: rect.top, left: rect.left } : { top: 0, left: 0 };
    };
    collection.closest = function(selector) {
      return createDollarCollection(this.map((node) => node.closest?.(selector)).filter(Boolean));
    };
    collection.parent = function(selector) {
      const nodes = this.map((node) => node.parentElement).filter((node) => node && (!selector || node.matches?.(selector)));
      return createDollarCollection(nodes);
    };
    collection.children = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.children || [])).filter((node) => !selector || node.matches?.(selector));
      return createDollarCollection(nodes);
    };
    collection.siblings = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.parentElement?.children || []).filter((child) => child !== node));
      return createDollarCollection(nodes.filter((node) => !selector || node.matches?.(selector)));
    };
    collection.prev = function(selector) {
      const nodes = this.map((node) => node.previousElementSibling).filter((node) => node && (!selector || node.matches?.(selector)));
      return createDollarCollection(nodes);
    };
    collection.next = function(selector) {
      const nodes = this.map((node) => node.nextElementSibling).filter((node) => node && (!selector || node.matches?.(selector)));
      return createDollarCollection(nodes);
    };
    collection.eq = function(index) {
      const resolved = index < 0 ? this.length + index : index;
      return createDollarCollection(resolved >= 0 && resolved < this.length ? [this[resolved]] : []);
    };
    collection.first = function() { return this.eq(0); };
    collection.last = function() { return this.eq(-1); };
    collection.find = function(selector) {
      return createDollarCollection(this.flatMap((node) => Array.from(node.querySelectorAll?.(selector) || [])));
    };
    // [STATUSBAR-COMPAT] 补齐 legacyShim 集合缺失的焦点方法（与 compatV2Shim 对齐），
    // 否则面板/卡片脚本调用 $("...").blur()/.focus() 会抛 "is not a function"。
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
  const dollar = (arg) => {
    if (typeof arg === 'function') {
      ready(arg);
      return createDollarCollection([document]);
    }
    if (arg === document || arg === window) {
      return createDollarCollection([arg]);
    }
    if (arg === parentDocumentStore) {
      return createDollarCollection([parentDocumentStore]);
    }
    if (typeof arg === 'string') {
      const parentElement = getParentElementBySelector(arg);
      if (parentElement) return createDollarCollection([parentElement]);
    }
    const nodes = typeof arg === 'string'
      ? Array.from(document.querySelectorAll(arg))
      : arg?.nodeType === 1 || arg?.__palinkParentElement
        ? [arg]
        : Array.isArray(arg)
          ? arg
        : [];
    return createDollarCollection(nodes);
  };
  if (!window.$) window.$ = dollar;
  if (!window.jQuery) window.jQuery = window.$;
  window.PalinkSmartCard = {
    context: ctx,
    post,
    sendMessage: getContext().sendMessage,
    parentDocument: parentDocumentStore,
    parent$: dollar,
    getParentElementById(id) {
      return parentDocumentStore.getElementById(id);
    },
    queryParentSelector(selector) { return parentDocumentStore.querySelector(selector); },
    queryParentSelectorAll(selector) { return parentDocumentStore.querySelectorAll(selector); },
  };
  window.sendToTavern = (content) => getContext().sendMessage(content);
`;
