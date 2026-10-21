/**
 * ST 兼容运行时体 · 第 01 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 270-1149 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

import { IDB_NS_RUNTIME_SOURCE } from '../../../../../lib/sillytavern/card-idb-namespace';

export function runtimeBodyPart01(bootHeader: string): string {
  return `(() => {
${bootHeader}
  // [MVU-EVENTS 2026-10-05] MVU 事件键的契约真值，取自插件契约
  // st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts。
  // 事件总线（eventSource.on）以事件字符串本身为 key —— 值写错就意味着卡脚本
  // eventOn(Mvu.events.X) 永远收不到。此前 emit 的是无前缀的 VARIABLE_UPDATE_ENDED，
  // 与契约的 mag_ 前缀不符，MVU 事件整体是「假活」。
  // 注意 VARIABLE_INITIALIZED 契约原文拼写就是 initiailized（少一个 l），照抄不要修正。
  // COMMAND_PARSED 键在此定义但不 emit：契约要的是解析出的命令对象且要求应用前拦截改写，
  // 我们后端留存的是已应用完的 JSON Patch，结构与时序都不符，emit 出来是假活（留空并登记）。
  const MVU_EVENT_KEYS = {
    VARIABLE_INITIALIZED: 'mag_variable_initiailized',
    VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
    COMMAND_PARSED: 'mag_command_parsed',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
    BEFORE_MESSAGE_UPDATE: 'mag_before_message_update'
  };
  // 父页面在 iframe onLoad 后首次 context-update 上带 mvuInit 标记 → 置 true，
  // 下一轮带 variables 的更新据此 emit mag_variable_initiailized，随后自清。
  let mvuInitPendingCompat = false;
  // [SEC-2026-09-02 F-1] 帧内密钥（gesture token）——只被本 IIFE 闭包持有。
  // 与 legacy shim 同理：密钥经 <head> 的 <meta> 一次性投递，本段读取后立即移除该 meta，
  // 后续执行的卡片脚本既读不到 meta 也读不到本闭包变量（二者同 realm，写在源码里或走
  // postMessage 传输都会被读到，唯此投递方式安全）。内联与外部两种加载路径共用本入口。
  const __palinkFrameSecretV2 = (() => {
    try {
      var el = document.querySelector('meta[name="palink-frame-secret-v2"]');
      if (!el) return '';
      var value = String(el.getAttribute('content') || '');
      if (el.parentNode) el.parentNode.removeChild(el);
      return value;
    } catch (e) { return ''; }
  })();
  const uiText = ctx.language === 'en'
    ? {
        requestTimeout: 'Palink smart card request timed out',
        requestFailed: 'Palink smart card request failed',
        compatTimeout: 'SillyTavern compatibility request timed out.',
        missingApi: 'The card called a Tavern API that Palink does not fully implement yet.',
        missingApiDetail: 'A safe fallback response was returned.',
        stubbedApi: 'A detected Tavern API was stubbed before the card used it.',
        unknownError: 'Unknown smart card error',
        unhandledRejection: 'Unhandled smart card promise rejection',
        pluginSettingsTitle: 'Third-party extension settings',
        pluginSettingsEmpty: 'No enabled SillyTavern extension settings were found.',
        pluginScriptsDisabled: 'Third-party extension scripts are disabled. Enable runtime.execute_scripts in plugin settings to run them in the sandbox.',
        nativeSettingsTitle: 'Extension UI',
        jsonSettingsTitle: 'Raw settings',
        ok: 'OK',
        cancel: 'Cancel',
        close: 'Close',
      }
    : {
        requestTimeout: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6',
        requestFailed: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u5931\u8d25',
        compatTimeout: 'SillyTavern \u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6\u3002',
        missingApi: '\u8fd9\u5f20\u89d2\u8272\u5361\u8c03\u7528\u4e86 Palink \u6682\u672a\u5b8c\u6574\u5b9e\u73b0\u7684 Tavern API\u3002',
        missingApiDetail: '\u5df2\u8fd4\u56de\u5b89\u5168\u7684\u517c\u5bb9\u7ed3\u679c\u3002',
        stubbedApi: '\u5df2\u5728\u89d2\u8272\u5361\u8c03\u7528\u524d\u4e3a\u68c0\u6d4b\u5230\u7684 Tavern API \u6ce8\u5165\u517c\u5bb9\u6869\u3002',
        unknownError: '\u672a\u77e5\u89d2\u8272\u5361\u9519\u8bef',
        unhandledRejection: '\u672a\u5904\u7406\u7684\u89d2\u8272\u5361 Promise \u5f02\u5e38',
        pluginSettingsTitle: '\u7b2c\u4e09\u65b9\u6269\u5c55\u8bbe\u7f6e',
        pluginSettingsEmpty: '\u672a\u627e\u5230\u5df2\u542f\u7528\u7684 SillyTavern \u6269\u5c55\u8bbe\u7f6e\u3002',
        pluginScriptsDisabled: '\u7b2c\u4e09\u65b9\u6269\u5c55\u811a\u672c\u672a\u542f\u7528\u3002\u5982\u9700\u5728\u6c99\u7bb1\u4e2d\u8fd0\u884c\uff0c\u8bf7\u5728\u63d2\u4ef6\u8bbe\u7f6e\u91cc\u5f00\u542f runtime.execute_scripts\u3002',
        nativeSettingsTitle: '\u6269\u5c55\u81ea\u5e26\u754c\u9762',
        jsonSettingsTitle: '\u539f\u59cb\u8bbe\u7f6e',
        ok: '\u786e\u5b9a',
        cancel: '\u53d6\u6d88',
        close: '\u5173\u95ed',
      };
  if (ctx.language !== 'en') {
    Object.assign(uiText, {
      requestTimeout: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6',
      requestFailed: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u5931\u8d25',
      compatTimeout: 'SillyTavern \u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6\u3002',
      missingApi: '\u8fd9\u5f20\u89d2\u8272\u5361\u8c03\u7528\u4e86 Palink \u6682\u672a\u5b8c\u6574\u5b9e\u73b0\u7684 Tavern API\u3002',
      missingApiDetail: '\u5df2\u8fd4\u56de\u5b89\u5168\u7684\u517c\u5bb9\u7ed3\u679c\u3002',
      stubbedApi: '\u5df2\u5728\u89d2\u8272\u5361\u8c03\u7528\u524d\u4e3a\u68c0\u6d4b\u5230\u7684 Tavern API \u6ce8\u5165\u517c\u5bb9\u6869\u3002',
      unknownError: '\u672a\u77e5\u89d2\u8272\u5361\u9519\u8bef',
      unhandledRejection: '\u672a\u5904\u7406\u7684\u89d2\u8272\u5361 Promise \u5f02\u5e38',
      pluginSettingsTitle: '\u7b2c\u4e09\u65b9\u6269\u5c55\u8bbe\u7f6e',
      pluginSettingsEmpty: '\u672a\u627e\u5230\u5df2\u542f\u7528\u7684 SillyTavern \u6269\u5c55\u8bbe\u7f6e\u3002',
      pluginScriptsDisabled: '\u7b2c\u4e09\u65b9\u6269\u5c55\u811a\u672c\u672a\u542f\u7528\u3002\u5982\u9700\u5728\u6c99\u7bb1\u4e2d\u8fd0\u884c\uff0c\u8bf7\u5728\u63d2\u4ef6\u8bbe\u7f6e\u91cc\u5f00\u542f runtime.execute_scripts\u3002',
      nativeSettingsTitle: '\u6269\u5c55\u81ea\u5e26\u754c\u9762',
      jsonSettingsTitle: '\u539f\u59cb\u8bbe\u7f6e',
      ok: '\u786e\u5b9a',
      cancel: '\u53d6\u6d88',
      close: '\u5173\u95ed',
    });
  }
  // [CONSOLE-GOVERNOR 2026-10-06] 卡脚本的 console 噪音治理。
  //
  // 问题（2026-10-06 用户真机日志实测）：一张 4MB 的卡脚本在控制台打 5~6 份**完全相同**
  // 的日志——因为它被重复实例化，每次 init 都重新打一遍（TitleScreenDiag / GSAP /
  // Live2D profile / BubbleDialogue 全是 5~6×）。769 行日志里 383 行是 React 内部堆栈，
  // 真正有信息量的不足 30 行。用户描述「吐出来很多没必要的信息，数据量太大」。
  //
  // 策略（保守，只压「重复」，不压「首次」）：
  //  - log / info / debug：**同一条**相同内容只放行第一次，后续折叠并累计次数，
  //    每 N 次打一条「（已折叠 xN）」提示。首次照常可见 ⇒ 不丢信息，只去重。
  //  - warn / error：**原样放行**。告警和报错可能含唯一信息（数值/时序），折叠会藏 bug。
  //  - dir / table / trace / group：同样按 debug 处理（卡脚本常用于调试转储）。
  //  - 只包一层，且**不吞异常**：任何内部失败都退回原生 console。
  //
  // 逃生开关：卡片设置面板或控制台执行 window.__palinkConsoleVerbose = true 即全量放行。
  // 折叠上限按 key 计数，key 表超过 500 条时清空（防长跑内存增长）。
  //
  // ⚠️ 本段是注入 iframe 的模板字符串的一部分：注释与代码里禁止出现反引号和美元花括号。
  const __nativeConsole = (typeof window !== 'undefined' && window.console) || null;
  if (__nativeConsole && !window.__palinkConsoleGovernor) {
    try {
      const foldMap = new Map();
      const FOLD_KEY_LIMIT = 500;
      const ANNOUNCE_EVERY = 20;
      const passThrough = ['warn', 'error', 'assert', 'count', 'countReset', 'groupEnd', 'time', 'timeEnd', 'timeLog'];
      const foldable = ['log', 'info', 'debug', 'dir', 'table', 'trace'];
      const makeKey = (args) => {
        try {
          let text = '';
          for (let i = 0; i < args.length && i < 4; i++) {
            const value = args[i];
            if (typeof value === 'string') text += value.slice(0, 240);
            else if (value === null) text += 'null';
            else if (typeof value === 'object') text += '[object]';
            else text += String(value).slice(0, 120);
            text += '|';
          }
          return text;
        } catch (e) { return ''; }
      };
      const governed = {};
      foldable.forEach((name) => {
        const native = __nativeConsole[name];
        if (typeof native !== 'function') return;
        governed[name] = function () {
          try {
            if (window.__palinkConsoleVerbose === true) return native.apply(__nativeConsole, arguments);
            const key = name + '::' + makeKey(arguments);
            if (!key.trim() || key === name + '::') return native.apply(__nativeConsole, arguments);
            if (foldMap.size > FOLD_KEY_LIMIT) foldMap.clear();
            const seen = foldMap.get(key) || 0;
            foldMap.set(key, seen + 1);
            if (seen === 0) return native.apply(__nativeConsole, arguments);
            if (seen % ANNOUNCE_EVERY === 0) {
              return native.call(__nativeConsole, '[已折叠重复日志 x' + (seen + 1) + '] ' + String(arguments[0] || '').slice(0, 120));
            }
            return undefined;
          } catch (e) {
            return native.apply(__nativeConsole, arguments);
          }
        };
      });
      passThrough.forEach((name) => {
        const native = __nativeConsole[name];
        if (typeof native === 'function') governed[name] = native.bind(__nativeConsole);
      });
      // 保底：其余未列出的原生方法（clear / dirxml / profile 等）直接透传。
      Object.keys(__nativeConsole).forEach((name) => {
        if (governed[name] === undefined && typeof __nativeConsole[name] === 'function') {
          governed[name] = __nativeConsole[name].bind(__nativeConsole);
        }
      });
      window.__palinkConsoleGovernor = governed;
      window.console = governed;
    } catch (e) { /* console 不可用时保持原生 */ }
  }
  const console = window.console;

  const diagnostics = [];
  const diagnosticKeys = new Set();
  let requestSeq = 0;
  const pendingRequests = new Map();
  const regexBackslashCompat = String.fromCharCode(92);
  const newlineCompat = String.fromCharCode(10);
  const userGestureWindowMs = 15000;
  let lastUserGestureAt = 0;

  const post = (payload) => {
    try {
      window.parent.postMessage({
        source: 'palink-smart-card',
        runtime: 'st-compat-v2',
        frameId,
        ...payload,
      }, '*');
    } catch {}
  };
  const markUserGesture = (event) => {
    // [SEC-2026-09-02 F-1] 只认浏览器派发的可信事件（isTrusted 无法被 JS 伪造），
    // 与 legacy shim 同语义：卡片脚本 dispatchEvent 合成的事件不记入手势，
    // 防止「伪造手势 → 让本 shim 主动附上帧内密钥」绕过父侧令牌校验。
    if (event && event.isTrusted === false) return;
    lastUserGestureAt = Date.now();
  };
  const hasRecentUserGesture = () => Date.now() - lastUserGestureAt <= userGestureWindowMs;
  try {
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'].forEach((eventName) => {
      window.addEventListener(eventName, markUserGesture, { capture: true, passive: true });
      document.addEventListener(eventName, markUserGesture, { capture: true, passive: true });
    });
  } catch {}

  const summarizeArg = (value) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return value.length > 180 ? value.slice(0, 180) + '...' : value;
    if (type === 'number' || type === 'boolean') return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (type === 'function') return { type: 'function', name: value.name || '' };
    if (type === 'object') {
      try { return { type: 'object', keys: Object.keys(value).slice(0, 12) }; } catch {}
    }
    return { type };
  };
  const sanitizeUnknownApiArg = (value, depth = 0, seen = new WeakSet()) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return value.length > 12000 ? value.slice(0, 12000) : value;
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'function') return undefined;
    if (type !== 'object') return undefined;
    if (value?.nodeType || value === window || value === document) return undefined;
    if (seen.has(value)) return undefined;
    if (depth >= 4) return summarizeArg(value);
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 40).map((item) => sanitizeUnknownApiArg(item, depth + 1, seen));
    }
    const result = {};
    try {
      Object.keys(value).slice(0, 80).forEach((key) => {
        const next = sanitizeUnknownApiArg(value[key], depth + 1, seen);
        if (next !== undefined) result[key] = next;
      });
    } catch {
      return summarizeArg(value);
    }
    return result;
  };

  const reportDiagnostic = (diagnostic) => {
    const normalized = {
      severity: diagnostic.severity || 'warning',
      code: diagnostic.code || 'compat_notice',
      apiName: diagnostic.apiName || '',
      message: diagnostic.message || '',
      detail: diagnostic.detail || '',
      args: diagnostic.args || [],
      stack: diagnostic.stack || '',
      runtimeVersion,
      runtimeMode,
      timestamp: Date.now(),
    };
    const key = [normalized.code, normalized.apiName, normalized.message].join('|');
    if (diagnosticKeys.has(key)) return normalized;
    diagnosticKeys.add(key);
    diagnostics.push(normalized);
    post({ type: 'st:diagnostic', diagnostic: normalized });
    return normalized;
  };
  window.__palinkReportCompatDiagnostic = reportDiagnostic;
  // ==== [包W 2026-10-19] 帧内静默失败记录器 ====
  // 要解决的问题：兼容层里「什么都没发生」的路径（未实现的命令返回空串、catch 吞掉异常、
  // 未授信全局读不到）对用户安静、对开发者也零痕迹，于是永远定不了责。
  // 产品形状（用户已拍板）：对用户仍然安静，对记录必须啰嗦。每条记录带「该谁修」标签 owner，
  // 同名去重但不丢弃（首次带细节，后续只累加 count 与 lastAt）。
  // 通道：只复用既有的 st:diagnostic（severity 固定 info ⇒ 宿主 toast 闸门不弹，用户可见行为零变化）。
  // 开关：真正的门在宿主侧（palink-diag.ts 的本机站点/手动开关判定）；帧内缓冲区有界（≤200 条），
  //       所以外部站点也不会涨内存。帧内数据只能经 postMessage 上送（opaque origin，父侧读不到帧内 DOM）。
  // 约束：本段是注入 iframe 的模板字符串 —— 只能 ES5、不许反引号、不许美元花括号、
  //       字符串与注释里不许裸反斜杠（换行符用 String.fromCharCode(10) 取，彻底绕开转义）。
  var PALINK_DIAG_OWNERS = { frame_compat: 1, host_capability: 1, card_authored: 1, display_pipeline: 1 };
  var PALINK_DIAG_LF = String.fromCharCode(10);
  var palinkDiagRecords = [];
  var palinkDiagIndex = {};
  var palinkDiagDropped = 0;
  var palinkDiagDigits = new RegExp('^[0-9]+$');
  function palinkDiagSafeText(value, max) {
    var text = '';
    try { text = String(value === undefined || value === null ? '' : value); } catch (e) { text = '[unstringifiable]'; }
    var limit = typeof max === 'number' ? max : 400;
    return text.length > limit ? text.slice(0, limit) : text;
  }
  // 位置行与消息行不是一回事：V8 的栈第一行是 "Error: 消息"，位置在后面的 "at … :81:1"。
  // 直接取第一行会让 filename 恒为空（真机实测 rejection 轨那条就是这样丢的位置）。
  function palinkDiagLocationLine(stack) {
    var lines = palinkDiagSafeText(stack, 4000).split(PALINK_DIAG_LF);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (!line) continue;
      if (line.indexOf('at ') >= 0 || line.indexOf('@') >= 0) {
        if (line.indexOf('Error:') === 0 || line.indexOf('TypeError:') === 0 || line.indexOf('ReferenceError:') === 0) continue;
        return line.slice(0, 300);
      }
    }
    return '';
  }
  // 前缀剥离：位置行的两种真实形态各自带一个会粘进文件名的前缀 ——
  //   Chrome 裸形「at url:line:col」和 Firefox/Safari 形「fn@url:line:col」。
  // 不剥就会实测拿到 "execute@about:srcdoc"（包W 守卫用例 C 钉这条）。
  // 保守条件：只有 @ 之前那段看起来像标识符（不含 / 也不含 :）才剥，
  // 免得把 http://user@host/x.js 这种带 userinfo 的 URL 切坏。
  function palinkDiagLocationCore(head) {
    var core = palinkDiagSafeText(head, 400);
    if (typeof core.trim === 'function') core = core.trim();
    if (core.indexOf('at ') === 0) core = core.slice(3);
    var at = core.lastIndexOf('@');
    if (at >= 0) {
      var fnPart = core.slice(0, at);
      if (fnPart.indexOf('/') < 0 && fnPart.indexOf(':') < 0) core = core.slice(at + 1);
    }
    return core;
  }
  function palinkDiagFilenameFromStack(stack) {
    var line = palinkDiagLocationLine(stack);
    if (!line) return '';
    var open = line.indexOf('(');
    var head = open >= 0 ? line.slice(open + 1) : line;
    var close = head.indexOf(')');
    if (close >= 0) head = head.slice(0, close);
    head = palinkDiagLocationCore(head);
    var parts = head.split(':');
    if (parts.length < 3) return '';
    var colno = parts[parts.length - 1];
    var lineno = parts[parts.length - 2];
    if (!palinkDiagDigits.test(palinkDiagSafeText(colno, 12)) || !palinkDiagDigits.test(palinkDiagSafeText(lineno, 12))) return '';
    return parts.slice(0, parts.length - 2).join(':');
  }
  function palinkDiagLineFromStack(stack) {
    var line = palinkDiagLocationLine(stack);
    if (!line) return { lineno: -1, colno: -1 };
    var parts = line.split(':');
    if (parts.length < 3) return { lineno: -1, colno: -1 };
    var colno = parseInt(parts[parts.length - 1], 10);
    var lineno = parseInt(parts[parts.length - 2], 10);
    return {
      lineno: isNaN(lineno) ? -1 : lineno,
      colno: isNaN(colno) ? -1 : colno,
    };
  }
  function palinkDiagUpsend(record, delta) {
    // 上送的是**增量**（delta），父侧按同 key 累加，绝不会出现「帧里 12 次、父里 24 次」。
    // 首次必送；之后每满 10 次送一批，且总上送次数封顶 30 —— 防止热路径把 postMessage 打爆。
    try {
      if (record.upposts >= 30 && delta < 50) return;
      record.upposts += 1;
      post({
        type: 'st:diagnostic',
        diagnostic: {
          severity: 'info',
          code: 'palink_diag',
          apiName: palinkDiagSafeText(record.kind, 80),
          message: 'palink-diag ' + palinkDiagSafeText(record.kind, 80) + ' ' + palinkDiagSafeText(record.name, 120),
          detail: 'palinkDiag:' + JSON.stringify({
            owner: record.owner,
            kind: record.kind,
            name: record.name,
            detail: record.detail,
            stack: record.stack,
            filename: record.filename,
            lineno: record.lineno,
            colno: record.colno,
            textLength: record.textLength,
            count: delta,
            frameId: frameId,
          }),
          stack: record.stack,
          runtimeVersion: runtimeVersion,
          runtimeMode: runtimeMode,
          timestamp: Date.now(),
        },
      });
    } catch (e) { /* 父窗口不可达时静默：帧内缓冲仍然留痕 */ }
  }
  function palinkDiagRecord(input) {
    try {
      var src = input && typeof input === 'object' ? input : {};
      var owner = PALINK_DIAG_OWNERS[src.owner] ? src.owner : 'frame_compat';
      var kind = palinkDiagSafeText(src.kind || 'frame_record', 80);
      var name = palinkDiagSafeText(src.name === undefined || src.name === null ? '' : src.name, 200);
      var key = owner + '|' + kind + '|' + name;
      var now = Date.now();
      var stack = palinkDiagSafeText(src.stack || '', 1200);
      var hit = palinkDiagIndex[key];
      if (hit) {
        hit.lastAt = now;
        hit.count += 1;
        if (!hit.stack && stack) {
          hit.stack = stack;
          hit.filename = palinkDiagSafeText(src.filename || '', 300) || palinkDiagFilenameFromStack(stack);
          var pos = palinkDiagLineFromStack(stack);
          if (src.filename) pos = { lineno: hit.lineno, colno: hit.colno };
          if (hit.lineno < 0) hit.lineno = typeof src.lineno === 'number' ? src.lineno : pos.lineno;
          if (hit.colno < 0) hit.colno = typeof src.colno === 'number' ? src.colno : pos.colno;
        }
        if (hit.count % 10 === 0) palinkDiagUpsend(hit, 10);
        return hit;
      }
      if (palinkDiagRecords.length >= 200) {
        var oldest = palinkDiagRecords.shift();
        if (oldest) delete palinkDiagIndex[oldest.key];
        palinkDiagDropped += 1;
      }
      var coords = palinkDiagLineFromStack(stack);
      var record = {
        key: key,
        owner: owner,
        kind: kind,
        name: name,
        detail: palinkDiagSafeText(src.detail || '', 600),
        stack: stack,
        filename: palinkDiagSafeText(src.filename || '', 300) || palinkDiagFilenameFromStack(stack),
        lineno: typeof src.lineno === 'number' ? src.lineno : coords.lineno,
        colno: typeof src.colno === 'number' ? src.colno : coords.colno,
        textLength: typeof src.textLength === 'number' ? src.textLength : -1,
        frameId: palinkDiagSafeText(frameId, 64),
        cardId: palinkDiagSafeText(ctx && ctx.characterId ? ctx.characterId : '', 64),
        count: 1,
        firstAt: now,
        lastAt: now,
        upposts: 0,
      };
      palinkDiagRecords.push(record);
      palinkDiagIndex[key] = record;
      palinkDiagUpsend(record, 1);
      return record;
    } catch (e) {
      return null;
    }
  }
  function palinkDiagDumpText() {
    try {
      var byOwner = { frame_compat: 0, host_capability: 0, card_authored: 0, display_pipeline: 0 };
      var events = 0;
      var i = 0;
      for (i = 0; i < palinkDiagRecords.length; i += 1) {
        byOwner[palinkDiagRecords[i].owner] = (byOwner[palinkDiagRecords[i].owner] || 0) + 1;
        events += palinkDiagRecords[i].count;
      }
      return JSON.stringify({
        schema: 'palink-diag/v1',
        side: 'frame',
        frameId: palinkDiagSafeText(frameId, 64),
        cardId: palinkDiagSafeText(ctx && ctx.characterId ? ctx.characterId : '', 64),
        generatedAt: new Date().toISOString(),
        limits: { perFrame: 200 },
        totals: { records: palinkDiagRecords.length, events: events, dropped: palinkDiagDropped, byOwner: byOwner },
        records: palinkDiagRecords,
      }, null, 2);
    } catch (e) {
      return '{"schema":"palink-diag/v1","error":"frame dump failed"}';
    }
  }
  window.__palinkDiagRecord = palinkDiagRecord;
  window.__palinkDiagDump = palinkDiagDumpText;
  window.__palinkDiagRecords = palinkDiagRecords;
  // [包W 2026-10-19 / 批次C C-2 2026-10-20 改文案 / 批次H 2026-10-20 二改] 全局形状留痕。
  // 一手事实（两棵 ST 1.18 树 + 酒馆助手插件全仓）：**ST 里也没有 window.context 这个全局**。
  //   ST 的 context 恒为局部变量 —— authors-note.js:325/444、extensions.js:90/2062/2144、
  //   slash-commands.js:3892、utils.js:1344、world-info.js:1116 全是 const context = getContext()；
  //   window.context / window.getContext / globalThis.getContext 在 ST 全树与插件里 0 命中。
  //   （包N B-2 当年依据的「st-context.js 的 export const context」经核实不存在：该文件只有
  //     export function getContext() 与 export default —— 依据本身是误读。）
  // 用户裁定「与 ST 冲突以 ST 为准」⇒ 帧内定义已于 2026-10-20 批次H 撤掉（part-08 原位留撤销注记）
  // ⇒ 本留痕说的「未提供」对 ST 与 Palink 两侧同时成立，且 boot 后恒真（本段先于一切卡脚本求值，
  //    定义已不存在，不存在"先判不存在、后又补出来"的自相矛盾）。
  // 记录本身保留：① 它是「哪张卡在这么写」的证据之一（另一条是 error 轨 refMatch 命中时记的
  //   name='context'，见 part-08 的 window error 监听）；② 判定逻辑一律不动：
  //   owner / kind / name / 同名合并去重 / 上送口径全部原样。
  if (!Object.getOwnPropertyDescriptor(window, 'context')) {
    palinkDiagRecord({
      owner: 'frame_compat',
      kind: 'global_shape_absent',
      name: 'window.context',
      detail: 'ST 亦无此全局：ST 1.18 的 context 恒为局部变量（const context = getContext()），'
        + 'window.context 在两棵 ST 树与酒馆助手插件里全树 0 命中 ⇒ 卡这么写本身不合规。'
        + '用户裁定「与 ST 冲突以 ST 为准」⇒ Palink 帧内同样不提供（2026-10-20 批次H 撤掉包N B-2 的定义）。'
        + '卡应调 getContext()，不要直读 window.context；本条只用于统计「哪张卡按不合规写法读了它」，'
        + 'count 增长说明该卡需要作者改写法。',
    });
  }
  const executeCompatInlineScriptCompat = (source, label = '') => {
    const script = document.createElement('script');
    if (runtimeScriptNonce) script.setAttribute('nonce', runtimeScriptNonce);
    if (label) script.setAttribute('data-palink-st-script', label);
    const sourceText = String(source || '');
    script.textContent = sourceText;
    try {
      (document.head || document.documentElement || document.body).appendChild(script);
    } catch (error) {
      reportDiagnostic({
        severity: 'error',
        code: 'inline_script_injection_failed',
        apiName: String(label || ''),
        message: String(error?.message || error || uiText.unknownError),
        detail: String(label || ''),
        stack: String(error?.stack || ''),
      });
      throw error;
    } finally {
      script.remove();
    }
    return true;
  };

  const requestParent = (action, payload = {}, options = {}) => new Promise((resolve) => {
    const requestId = frameId + ':v2:' + (++requestSeq);
    // 用户交互弹窗（callGenericPopup/callPopup）使用更长超时（60秒），其他请求默认 8 秒
    const timeoutMs = typeof options.timeout === 'number'
      ? options.timeout
      : (action === 'callGenericPopup' || action === 'callPopup' ? 60000 : 8000);
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reportDiagnostic({
        severity: 'warning',
        code: 'parent_request_timeout',
        apiName: action,
        message: uiText.compatTimeout,
      });
      resolve({ success: false, ok: false, error: uiText.requestTimeout });
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, timeout });
    post({
      type: 'request',
      requestId,
      action,
      payload: {
        ...(payload && typeof payload === 'object' ? payload : {}),
        __palinkUserGesture: hasRecentUserGesture(),
        // [SEC-2026-09-02 F-1] 仅在真实发生用户手势时附帧内密钥（与 legacy shim 同语义）。
        __palinkGestureToken: hasRecentUserGesture()
          ? (typeof __palinkFrameSecretV2 === 'string' ? __palinkFrameSecretV2 : '')
          : '',
        __palinkRuntimeMode: runtimeMode,
        __palinkContext: {
          characterId: ctx.characterId,
          messageId: ctx.messageId,
          sessionId: ctx.sessionId,
        },
      },
    });
  });

  const clone = (value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  };
  const makeCompatStorage = (storageType, initialValues = {}) => {
    const values = new Map(Object.entries(initialValues || {}).map(([key, value]) => [String(key), String(value)]));
    const persist = (op, key, value) => {
      post({
        type: 'storage',
        storageType,
        op,
        key: key == null ? undefined : String(key),
        value: value == null ? undefined : String(value),
      });
    };
    return {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
      getItem(key) {
        key = String(key);
        return values.has(key) ? values.get(key) : null;
      },
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
  if (!ctx.trustedNative) {
    try {
      Object.defineProperty(window, 'localStorage', { value: makeCompatStorage('localStorage', ctx.persistedStorage?.localStorage), configurable: true });
      Object.defineProperty(window, 'sessionStorage', { value: makeCompatStorage('sessionStorage', ctx.persistedStorage?.sessionStorage), configurable: true });
    } catch {}
  }

  // ── [IDB-NS 甲] IndexedDB 按角色分库（2026-10-02）─────────────────────────
  // 气泡插件把 CG / 头像缓存在 BubbleDialogueAvatars，而 cg_groups 的主键不含角色，
  // 两张卡用了同名分组时后写的会整条覆盖前者，且按 charId 过滤后前者永久不可见（数据丢失）。
  // 给它加角色后缀即可彻底隔开。
  //
  // 白名单而非一刀切：GalgameUIPluginDB 是父帧 Live2D 面板与帧内 galgame 插件共用的库名，
  // 一刀切会让插件去读一个空库，Live2D 绑定直接失效。所以只动有实证问题的那个。
  //
  // 为什么还要往子帧传播：shim 装的是本 realm 的 window，而气泡插件跑在嵌套 srcdoc 子帧
  // （dcRoot）里，那是浏览器给的全新 realm，不继承任何父帧属性 —— 不传播等于白做。
  //
  // ⚠️ 从这里往下都是**纯 JS**（本文件整体是注入 iframe 的脚本源码模板串）：
  // 不许出现 TS 类型注解、as 断言、反引号，也不许出现美元符号紧跟花括号的插值写法 ——
  // 前者会在 iframe 里报语法错，后者会直接把外层模板串截断。
${IDB_NS_RUNTIME_SOURCE}
  var IDB_NS_SUFFIX = sanitizeIdbSuffix(ctx && ctx.characterId);
  var IDB_NS_BOOTSTRAP = buildIdbBootstrap(IDB_NS_SUFFIX);
  // 止血：主框架里写 localStorage.palink_idb_namespace = '0' 后刷新即整体关闭。
  // 万一分库在线上出怪问题，不必重新构建就能退回去。
  if (IDB_NS_SUFFIX && !idbNamespaceDisabled()) {
    try {
      var nativeIdb = window.indexedDB;
      if (nativeIdb && typeof nativeIdb.open === 'function') {
        Object.defineProperty(window, 'indexedDB', {
          configurable: true,
          value: makeScopedIdbShim(nativeIdb, IDB_NS_SUFFIX),
        });
      }
    } catch (e) {
      /* 装不上就算了：宁可不隔离，也不能因为这一步让卡渲染不出来 */
    }
    installIdbShimPropagation(IDB_NS_SUFFIX, IDB_NS_BOOTSTRAP);
  }
  const persistedLocalStore = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_local_variables || '{}'); } catch { return {}; }
  })();
  const persistedGlobalStore = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_global_variables || '{}'); } catch { return {}; }
  })();
  const persistedChatStore = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_chat_variables || '{}'); } catch { return {}; }
  })();
  const persistedMetadata = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_chat_metadata || '{}'); } catch { return {}; }
  })();
  const persistedExtensionPrompts = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_extension_prompts || '{}'); } catch { return {}; }
  })();
  const persistedExtensionFields = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_extension_fields || '{}'); } catch { return {}; }
  })();
  const persistedExtensionSettings = (() => {
    try { return JSON.parse(ctx.persistedStorage?.localStorage?.__palink_extension_settings || '{}'); } catch { return {}; }
  })();
  const localVariableStore = persistedLocalStore && typeof persistedLocalStore === 'object' ? persistedLocalStore : {};
  const globalVariableStore = persistedGlobalStore && typeof persistedGlobalStore === 'object' ? persistedGlobalStore : {};
  // [SINGLE-SOURCE] chat 变量 store 的深度合并工具：初始化与 context-update 热更新共用，
  // 保证后端下发的 variables（含 stat_data）始终 merge 进唯一真源 chatVariableStore。
  const deepMergeVariablesCompat = (target, source) => {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = deepMergeVariablesCompat(typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  };
  // 合并后端下发的会话级 variables（含 stat_data）进 chat store，
  // 使 iframe 内 getAllVariables() 能返回真实数据，驱动状态栏/角色卡动态内容（照片/服饰/内心想法）填充。
  const ctxVariables = (typeof ctx.variables === 'object' && ctx.variables && Object.keys(ctx.variables).length > 0) ? ctx.variables : null;
  const chatVariableStore = (() => {
    const base = (persistedChatStore && typeof persistedChatStore === 'object') ? JSON.parse(JSON.stringify(persistedChatStore)) : {};
    if (!ctxVariables) return base;
    return deepMergeVariablesCompat(base, ctxVariables);
  })();
  // [SINGLE-SOURCE] extension prompts/fields 与 V4 变量同构：不再维护独立副本，
  // 统一存于 chatVariableStore.__extension_prompts / __extension_fields（随会话变量
  // 由 persistVariableStores 持久化到父页面 __palink_chat_variables）。旧独立持久化
  // key（__palink_extension_prompts / __palink_extension_fields）仅做一次性迁移合并，
  // 之后不再读写；读取一律走下方 helper，保证 set/get/context 读到同一份数据。
  if (persistedExtensionPrompts && typeof persistedExtensionPrompts === 'object') {
    const legacyPrompts = chatVariableStore.__extension_prompts;
    chatVariableStore.__extension_prompts = Object.assign(
      legacyPrompts && typeof legacyPrompts === 'object' ? legacyPrompts : {},
      persistedExtensionPrompts,
    );
  }
  if (persistedExtensionFields && typeof persistedExtensionFields === 'object') {
    const legacyFields = chatVariableStore.__extension_fields;
    chatVariableStore.__extension_fields = Object.assign(
      legacyFields && typeof legacyFields === 'object' ? legacyFields : {},
      persistedExtensionFields,
    );
  }
  const getExtensionPromptStoreCompat = () => {
    const store = chatVariableStore.__extension_prompts;
    return store && typeof store === 'object' ? store : {};
  };
  const getExtensionFieldStoreCompat = () => {
    const store = chatVariableStore.__extension_fields;
    return store && typeof store === 'object' ? store : {};
  };
  const extensionSettingsStore = persistedExtensionSettings && typeof persistedExtensionSettings === 'object' ? persistedExtensionSettings : {};
  const stPluginRuntimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
    ? ctx.stPluginRuntimeConfig
    : { plugins: [], extension_settings: {} };
  const stPluginExtensionSettings = stPluginRuntimeConfig.extension_settings && typeof stPluginRuntimeConfig.extension_settings === 'object'
    ? stPluginRuntimeConfig.extension_settings
    : {};
  const mergePlainObjectCompat = (target, source) => {
    if (!source || typeof source !== 'object') return target;
    Object.entries(source).forEach(([key, value]) => {
      if (!key) return;
      if (
        value && typeof value === 'object' && !Array.isArray(value)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      ) {
        target[key] = { ...target[key], ...value };
      } else {
        target[key] = clone(value);
      }
    });
    return target;
  };
  const getStPluginExtensionSettingsCompat = () => {
    const runtimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
      ? ctx.stPluginRuntimeConfig
      : {};
    return runtimeConfig.extension_settings && typeof runtimeConfig.extension_settings === 'object'
      ? runtimeConfig.extension_settings
      : {};
  };
  const applyStPluginRuntimeConfigCompat = () => {
    if (!window.extension_settings || typeof window.extension_settings !== 'object') window.extension_settings = {};
    mergePlainObjectCompat(window.extension_settings, getStPluginExtensionSettingsCompat());
    // [S3-ACCEPTANCE-GAP] ST 契约字段：extension_settings.disabledExtensions 恒为数组。
    // regex 插件 init 首行 extension_settings.disabledExtensions.includes('regex')，
    // Palink 侧无此键 => TypeError => init 死（2026-10-14 真机定位）。
    if (!Array.isArray(window.extension_settings.disabledExtensions)) window.extension_settings.disabledExtensions = [];
    // [S3-PLUGIN-SHIM-GAP] ST 扩展的 settings 子对象：ST 里由扩展首次 init 时自建并持久化，
    // Palink 的 settings.json 从来没有这些键 => translate loadSettings 的
    // Object.hasOwn(undefined) / memory loadSettings 的 Object.keys(undefined) 全抛。
    // 键名 = 各扩展实际读取的 extension_settings.<key>（见 st-plugins 各 index.js loadSettings），
    // 新增扩展时按同名单补。regex_presets 是数组型（305 行有 .map）。
    ['quickReply', 'quickReplyV2', 'translate', 'memory', 'regex'].forEach((key) => {
      const current = window.extension_settings[key];
      if (!current || typeof current !== 'object' || Array.isArray(current)) window.extension_settings[key] = {};
    });
    if (!Array.isArray(window.extension_settings.regex_presets)) window.extension_settings.regex_presets = [];
    const runtimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
      ? ctx.stPluginRuntimeConfig
      : {};
    window.extension_settings.palink_plugin_runtime = {
      plugins: Array.isArray(runtimeConfig.plugins) ? clone(runtimeConfig.plugins) : [],
      generated_at: runtimeConfig.generated_at || '',
    };
  };
  const getStPluginRuntimePluginsCompat = () => {
    const runtimeConfig = ctx.stPluginRuntimeConfig && typeof ctx.stPluginRuntimeConfig === 'object'
      ? ctx.stPluginRuntimeConfig
      : {};
    const configuredPlugins = Array.isArray(runtimeConfig.plugins) ? runtimeConfig.plugins : [];
    const livePlugins = Array.isArray(window.extension_settings?.palink_plugin_runtime?.plugins)
      ? window.extension_settings.palink_plugin_runtime.plugins
      : [];
    if (!livePlugins.length) return configuredPlugins;
    const merged = new Map();
    [...configuredPlugins, ...livePlugins].forEach((plugin) => {
      if (!plugin || typeof plugin !== 'object') return;
      const key = String(plugin.id || plugin.name || JSON.stringify(plugin)).toLowerCase();
      if (!merged.has(key)) merged.set(key, plugin);
    });
    return Array.from(merged.values());
  };
  const getStPluginRuntimeNamespaceCompat = (plugin) => {
    const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
    return String(
      plugin?.runtime?.namespace
      || plugin?.namespace
      || plugin?.extension_name
      || manifest.id
      || manifest.name
      || plugin?.name
      || plugin?.id
      || ''
    ).trim();
  };
  const getStPluginRuntimeAliasesCompat = (plugin) => {
    const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
    return [
      plugin?.id,
      plugin?.name,
      plugin?.namespace,
      plugin?.extension_name,
      plugin?.runtime?.namespace,
      manifest.id,
      manifest.name,
      manifest.display_name,
    ].filter(Boolean).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  };
  const findStPluginRuntimeByNamespaceCompat = (namespace = '') => {
    const needle = String(namespace || '').trim().toLowerCase();
    if (!needle) return null;
    return getStPluginRuntimePluginsCompat().find((plugin) => (
      getStPluginRuntimeAliasesCompat(plugin).includes(needle)
      || String(getStPluginRuntimeNamespaceCompat(plugin)).trim().toLowerCase() === needle
    )) || null;
  };
  const sortStPluginRuntimePluginsCompat = (plugins) => [...plugins].sort((left, right) => {
    const leftManifest = left?.manifest && typeof left.manifest === 'object' ? left.manifest : {};
    const rightManifest = right?.manifest && typeof right.manifest === 'object' ? right.manifest : {};
    const leftOrder = Number(leftManifest.loading_order ?? left?.runtime?.loading_order ?? 100);
    const rightOrder = Number(rightManifest.loading_order ?? right?.runtime?.loading_order ?? 100);
    return (Number.isFinite(leftOrder) ? leftOrder : 100) - (Number.isFinite(rightOrder) ? rightOrder : 100);
  });
  const stPluginAssetUrlCompat = (pluginId, assetPath) => {
    const parts = String(assetPath || '').split('/').filter(Boolean).map((part) => encodeURIComponent(part));
    return '/api/plugins/' + encodeURIComponent(String(pluginId || '')) + '/asset/' + parts.join('/');
  };
  const normalizeStPluginPathCompat = (value) => {
    const input = String(value || '').replace(/\\\\/g, '/').split('?')[0].split('#')[0];
    const parts = [];
    input.split('/').forEach((part) => {
      if (!part || part === '.') return;
      if (part === '..') parts.pop();
      else parts.push(part);
    });
    return parts.join('/');
  };
  // [P0-SRCDOC-SLIM] 插件脚本包：js/modules 源码由父页面经 plugin-scripts-push 单次推送，
  // 不再随 srcDoc / context-update 内联 ~4.4MB 源码反复传输与解析（滑动卡顿主因）。
  // context 内插件仍保留元信息（path/execute/missing 等），content 统一从本包查询。
  const stPluginScriptsBundleCompat = { generated_at: '', scripts: [] };
  const stPluginScriptIndexCompat = new Map();
  const indexStPluginScriptsCompat = () => {
    stPluginScriptIndexCompat.clear();
    (Array.isArray(stPluginScriptsBundleCompat.scripts) ? stPluginScriptsBundleCompat.scripts : []).forEach((script) => {
      if (!script || typeof script !== 'object') return;
      const pluginId = String(script.pluginId || '');
      const path = normalizeStPluginPathCompat(script.zip_path || script.path || '');
      if (!pluginId || !path) return;
      stPluginScriptIndexCompat.set(pluginId + '::' + path, script);
    });
  };
  const getStPluginScriptContentCompat = (plugin, resource) => {
    if (resource && typeof resource.content === 'string') return resource.content;
    if (!plugin || !resource) return null;
    const pluginId = String(plugin.id || plugin.name || '');
    const path = normalizeStPluginPathCompat(resource.zip_path || resource.path || '');
    if (!pluginId || !path) return null;
    const script = stPluginScriptIndexCompat.get(pluginId + '::' + path);
    return script && typeof script.content === 'string' ? script.content : null;
  };
  // [P1-SRCDOC-SLIM] 清单化内容拉取：postMessage 推送的 bundle 只含元数据 + source URL，
  // 这里按需向父页面批量请求缺失源码（父侧走内存/HTTP 缓存），填入 bundle 条目后执行。
  // 幂等：已含 content 的条目跳过；in-flight 守卫避免并发重复请求。
  let stPluginScriptsHydratingCompat = false;
  const hydrateStPluginScriptsCompat = async () => {
    const scripts = Array.isArray(stPluginScriptsBundleCompat.scripts) ? stPluginScriptsBundleCompat.scripts : [];
    const missing = scripts.filter((script) => script && typeof script.content !== 'string');
    if (missing.length === 0) return;
    if (stPluginScriptsHydratingCompat) return;
    stPluginScriptsHydratingCompat = true;
    const hydrationVersion = String(stPluginScriptsBundleCompat.generated_at || '');
    try {
      const wanted = missing.map((script) => ({
        pluginId: String(script.pluginId || ''),
        path: normalizeStPluginPathCompat(script.zip_path || script.path || ''),
      })).filter((item) => item.pluginId && item.path);
      if (wanted.length === 0) return;
      const response = await requestParent('getPluginScriptContents', { scripts: wanted }, { timeout: 30000 });
      // 父页面应答经 pending.resolve 展平：{ ok: true, ...result }，内容键位于顶层。
      const contents = (response && typeof response === 'object' && response.ok !== false) ? response : {};
      missing.forEach((script) => {
        if (!script) return;
        const key = String(script.pluginId || '') + '::' + normalizeStPluginPathCompat(script.zip_path || script.path || '');
        const value = contents[key];
        if (typeof value === 'string') script.content = value;
      });
    } catch {
      // 父页面未响应/异常：内容保持缺失，插件脚本在后续 push/context 更新时重试。
    } finally {
      stPluginScriptsHydratingCompat = false;
    }
    // 内容就绪后补执行（按 scriptKey 幂等）。
    try {
      if (getStPluginRuntimePluginsCompat().length > 0) executeStPluginScriptsCompat();
    } catch {}
    try { injectStPluginCssCompat(); } catch {}
    // 自愈：拉取期间若 bundle 版本被更新（新清单），in-flight 守卫曾跳过其拉取，
    // 此处重新触发，确保新清单的内容也被填充。
    if (hydrationVersion !== String(stPluginScriptsBundleCompat.generated_at || '')) {
      void hydrateStPluginScriptsCompat();
    }
  };
  const dirnameStPluginPathCompat = (value) => {
    const path = normalizeStPluginPathCompat(value);
    const index = path.lastIndexOf('/');
    return index >= 0 ? path.slice(0, index) : '';
  };
  const stPluginAssetPathCandidatesCompat = (assetPath, basePath = '') => {
    const raw = String(assetPath || '').trim();
    if (!raw || /^(?:data:|blob:|https?:|\\/|#)/i.test(raw)) return [];
    const candidates = [];
    if (basePath) {
      const base = dirnameStPluginPathCompat(basePath);
      candidates.push(normalizeStPluginPathCompat((base ? base + '/' : '') + raw));
    }
    candidates.push(normalizeStPluginPathCompat(raw));
    return Array.from(new Set(candidates.filter(Boolean)));
  };
  const resolveStPluginAssetPathCompat = (plugin, assetPath, basePath = '') => {
    const candidates = stPluginAssetPathCandidatesCompat(assetPath, basePath);
    if (!candidates.length) return normalizeStPluginPathCompat(assetPath);
    const assets = Array.isArray(plugin?.resources?.assets)
      ? plugin.resources.assets
      : Object.keys(plugin?.resources?.assets || {}).map((path) => ({ path }));
    const assetPaths = new Set(assets.map((asset) => normalizeStPluginPathCompat(asset?.path || asset)).filter(Boolean));
    return candidates.find((candidate) => assetPaths.has(candidate)) || candidates[0];
  };
  const resolveStPluginModulePathCompat = (modulePath, basePath = '') => {
    const raw = String(modulePath || '').trim();
    if (!raw) return '';
    if (/^(?:https?:|data:|blob:|\\/)/i.test(raw)) return normalizeStPluginPathCompat(raw);
    if (raw.startsWith('.')) {
      const base = dirnameStPluginPathCompat(basePath);
      return normalizeStPluginPathCompat((base ? base + '/' : '') + raw);
    }
    return normalizeStPluginPathCompat(raw);
  };
  const stPluginResourcePathCandidatesCompat = (resource) => {
    const base = [resource?.zip_path, resource?.path]
      .filter(Boolean)
      .map((item) => normalizeStPluginPathCompat(item));
    return Array.from(new Set(base));
  };
  const stPluginModulePathCandidatesCompat = (modulePath, basePath = '') => {
    const resolved = resolveStPluginModulePathCompat(modulePath, basePath);
    if (!resolved) return [];
    const candidates = [resolved];
    if (!/\\.(?:mjs|js)$/i.test(resolved)) {
      candidates.push(resolved + '.js', resolved + '.mjs', resolved + '/index.js', resolved + '/index.mjs');
    }
    return Array.from(new Set(candidates.map((item) => normalizeStPluginPathCompat(item))));
  };
  const findStPluginRuntimePluginCompat = (pluginId) => {
    const plugins = getStPluginRuntimePluginsCompat();
    const needle = String(pluginId || '').toLowerCase();
    return plugins.find((plugin) => {
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      return [plugin?.id, plugin?.name, manifest.id, manifest.name, manifest.display_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === needle);
    }) || null;
  };
  const findStPluginModuleResourceCompat = (pluginId, modulePath, basePath = '') => {
    const plugin = findStPluginRuntimePluginCompat(pluginId);
    if (!plugin) return null;
    const wanted = stPluginModulePathCandidatesCompat(modulePath, basePath);
    if (!wanted.length) return null;
    const resources = [
      ...(Array.isArray(plugin?.resources?.js) ? plugin.resources.js : []),
      ...(Array.isArray(plugin?.resources?.modules) ? plugin.resources.modules : []),
    ];
    const found = resources.find((resource) => {
      if (!resource || resource.missing || getStPluginScriptContentCompat(plugin, resource) == null) return false;
      return stPluginResourcePathCandidatesCompat(resource).some((candidate) => wanted.includes(candidate));
    });
    return found ? { plugin, resource: found } : null;
  };
  const stLocalModuleCacheCompat = new Map();
  // [批次E2 2026-10-21] @import 也要重写：st-plugins/regex/style.css 首行是
  // @import "debugger.css"。此前只重写 url()，@import 的相对路径按帧文档 base
  // （继承父页 /characters/<cid>）解析 → GET /characters/debugger.css → nginx SPA
  // fallback 返回 text/html → strict MIME 拒绝（批次Q1 放开 same-origin 后每轮 14 条）。
  // 与 url() 同源解析：相对路径改指插件资产端点（后端 resources.assets 已收 debugger.css，
  // /api/plugins/<id>/asset/... 返回 text/css）；外链/data:/blob:/根路径原样保留。
  // 重写后仍是 @import 且位于样式表首部，后面的 url() 规则不会二次改写绝对路径。
  const rewriteStPluginCssUrlsCompat = (css, plugin, basePath = '') => String(css || '')
    .replace(/@import\\s+url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/gi, (match, quote, raw) => {
      const value = String(raw || '').trim();
      if (!value || /^(?:data:|blob:|https?:|\\/\\/|\\/|#)/i.test(value)) return match;
      return '@import url("' + stPluginAssetUrlCompat(plugin?.id, resolveStPluginAssetPathCompat(plugin, value, basePath)) + '")';
    })
    .replace(/@import\\s+(['"])([^'"]+)\\1/gi, (match, quote, raw) => {
      const value = String(raw || '').trim();
      if (!value || /^(?:data:|blob:|https?:|\\/\\/|\\/|#)/i.test(value)) return match;
      return '@import url("' + stPluginAssetUrlCompat(plugin?.id, resolveStPluginAssetPathCompat(plugin, value, basePath)) + '")';
    })
    .replace(/url\\(\\s*(['"]?)([^)'"]+)\\1\\s*\\)/gi, (match, quote, url) => {
      const value = String(url || '').trim();
      if (!value || /^(?:data:|blob:|https?:|\\/|#)/i.test(value)) return match;
      return 'url("' + stPluginAssetUrlCompat(plugin?.id, resolveStPluginAssetPathCompat(plugin, value, basePath)) + '")';
    });
  const escapeHtmlCompat = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
  const getByPathCompat = (source, path, fallback = '') => {
    const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
    let value = source;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return fallback;
      value = value[part];
    }
    return value == null ? fallback : value;
  };
  const compileSimpleTemplateCompat = (template, data = {}) => {
    const payload = data && typeof data === 'object' ? data : {};
    return String(template || '')
      .replace(/\\{\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}\\}/g, (_match, key) => String(getByPathCompat(payload, key, '')))
      .replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (_match, key) => escapeHtmlCompat(getByPathCompat(payload, key, '')));
  };
  const normalizeTemplateNameCompat = (value) => String(value || '')
    .replace(/\\\\/g, '/')
    .replace(/\\.(?:html|hbs|handlebars|mustache)$/i, '')
    .split('/')
    .filter(Boolean)
    .join('/')
    .toLowerCase();
  const findStPluginTemplateCompat = (extensionName = '', templateName = '') => {
    const wantedExtension = String(extensionName || '').trim().toLowerCase();
    const wantedTemplate = normalizeTemplateNameCompat(templateName || extensionName || 'template');
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat());
    for (const plugin of plugins) {
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const aliases = [plugin?.id, plugin?.name, manifest.id, manifest.name, manifest.display_name]
        .filter(Boolean)
        .map((item) => String(item).toLowerCase());
      if (wantedExtension && !aliases.includes(wantedExtension)) continue;
      const templates = Array.isArray(plugin?.resources?.templates) ? plugin.resources.templates : [];
      const found = templates.find((resource) => {
        if (!resource || resource.missing || typeof resource.content !== 'string') return false;
        const normalizedPath = normalizeTemplateNameCompat(resource.path || '');
        return normalizedPath === wantedTemplate
          || normalizedPath.endsWith('/' + wantedTemplate)
          || normalizedPath.endsWith('/templates/' + wantedTemplate)
          || normalizedPath.endsWith('/template/' + wantedTemplate);
      });
      if (found) return { plugin, resource: found };
    }
    return null;
  };
  const injectStPluginCssCompat = () => {
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat());
    plugins.forEach((plugin) => {
      const cssResources = Array.isArray(plugin?.resources?.css) ? plugin.resources.css : [];
      cssResources.forEach((resource, index) => {
        if (!resource || resource.missing || typeof resource.content !== 'string' || !resource.content.trim()) return;
        const styleId = 'palink-st-plugin-css-' + String(plugin.id || plugin.name || index).replace(/[^a-z0-9_-]/gi, '-') + '-' + index;
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.setAttribute('data-palink-st-plugin', String(plugin.name || plugin.id || ''));
        style.textContent = rewriteStPluginCssUrlsCompat(resource.content, plugin, resource.zip_path || resource.path || '');
        (document.head || document.documentElement).appendChild(style);
        // [包J J-1 2026-10-18] 插件 CSS 晚于帧内样式守护的快照登场（本函数的调用点全是
        // 等父侧 postMessage 的异步路径），卡侧外部 bundle 用 head.innerHTML 整体重写时
        // 守护只认快照里那几条基样式，插件 CSS 被抹掉后永久丢失（包E 实测 8 条到 3 条，
        // 丢的正是 Quick Replies 44KB 这类自家插件样式）。所以每成功 append 一条就向守护
        // 登记一次 —— 只登记插件自有节点，绝不重拍快照（重拍会把卡侧动态样式吸进基线）。
        // 守护尚未初始化时该调用走挂起队列，不影响注入本身。
        try {
          if (typeof window.__palinkStyleGuardAddNode === 'function') {
            window.__palinkStyleGuardAddNode(style);
          }
        } catch (guardError) { /* 守护缺席/异常一律不影响插件 CSS 注入 */ }
      });
    });
  };
  const delayCompat = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
  const debounceCompat = (fn, wait = 0) => {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn?.(...args), Number(wait) || 0);
    };
  };
  const throttleCompat = (fn, wait = 0) => {
    let last = 0;
    let timer = 0;
    return (...args) => {
      const now = Date.now();
      const remaining = Number(wait || 0) - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = 0;
        last = now;
        fn?.(...args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = 0;
          fn?.(...args);
        }, remaining);
      }
    };
  };
  const waitUntilConditionCompat = async (condition, timeout = 5000, interval = 50) => {
    const started = Date.now();
    while (Date.now() - started < Number(timeout || 0)) {
      if (await condition?.()) return true;
      await delayCompat(interval);
    }
    return false;
  };
  const regexSpecialCharsCompat = '.*+?^' + '$' + '{}()|[]' + regexBackslashCompat;
  const escapeRegexCompat = (value) => String(value ?? '').replace(/./g, (char) => (
    regexSpecialCharsCompat.includes(char) ? regexBackslashCompat + char : char
  ));
  const getFileTextCompat = async (file) => {
    if (typeof file === 'string') return file;
    if (file?.text && typeof file.text === 'function') return file.text();
    return String(file ?? '');
  };
  const parseJsonFileCompat = async (file) => JSON.parse(await getFileTextCompat(file));
  const downloadCompat = (content, fileName = 'download.txt', mimeType = 'text/plain') => {
    const blob = content instanceof Blob ? content : new Blob([String(content ?? '')], { type: String(mimeType || 'text/plain') });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(fileName || 'download.txt');
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      anchor.remove();
    }, 0);
    return true;
  };
  const saveJsonToFileCompat = (data, fileName = 'data.json') => (
    downloadCompat(JSON.stringify(data ?? {}, null, 2), fileName, 'application/json')
  );
  const humanizedDateTimeCompat = (value = Date.now()) => {
    const date = value instanceof Date ? value : new Date(value || Date.now());
`;
}
