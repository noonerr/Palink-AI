#!/usr/bin/env node
/**
 * VER-2 · 事件「emit→订阅往返」离线探针
 * 规格：docs/_active/spec/SPEC_ST三面一致对齐施工计划_2026-10-24.md 的 VER-2 行
 * 报告：docs/_active/report/REPORT_VER2_事件往返对齐_2026-10-25.md
 *
 * 做什么
 *  1) 用生产载体 `COMPAT_V2_RUNTIME_ARTIFACT`（buildSmartCardCompatRuntimeExternalScript()
 *     的返回值，与 iframe 里逐字节相同的**已求值**脚本文本）在 jsdom 里启动帧运行时；
 *  2) 对 `ST_EVENT_TYPES`（lib/sillytavern/getContext.ts，117 条）逐条做
 *     `eventSource.on(v)` → `eventSource.emit(v)` → 回调是否被调用；
 *  3) 用**受控宿主**（postMessage 拦截，全部 no-op 记录器，绝不发真实网络）
 *     驱动生产路径，记录运行期真正 emit 出来的事件名；
 *  4) 静态清点载体里的 emit 调用点（`emitCompatEvent(...)`），作为「有发射点但本轮未触发」的依据；
 *  5) 与 ST 1.18（d:/SillyTavern-release/public/scripts/events.js，104 条）做差集。
 *
 * 不做什么
 *  - 不写 dist、不 build、不联网、不碰容器；只读仓库。
 *  - 不修改生产代码。
 *
 * 用法
 *   node frontend/scripts/verify-event-roundtrip.mjs            # 表格 + 摘要
 *   node frontend/scripts/verify-event-roundtrip.mjs --json     # 只打 JSON（可管道）
 *   node frontend/scripts/verify-event-roundtrip.mjs --quiet     # 只打摘要
 *
 * 判定口径（严格区分「机制的往返」与「生产有没有发」）
 *  - 订阅可用：消费者按 ST 惯例写 `eventSource.on(event_types.KEY, cb)`。
 *    帧内 event_types 没有这个键 ⇒ 订阅落在字符串 'undefined' 上 ⇒ 记为 N（机制能通也不算可用）。
 *  - emit 可达：`观测` = 本轮驱动生产路径时真看到该值被 emit；`静态` = 载体里有 emit 调用点
 *    但本轮没有可离线触发的路径；`宿主静态` = 帧内零发射点、宿主插件沙箱
 *    （lib/sillytavern/runtime.ts|getContext.ts）有 eventSource.emit 调用点（**静态，未求值**）；
 *    `无` = 两级零 emit 点 ⇒ 订阅永不触发（名存实亡）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const REPO = resolve(FRONTEND, '..');
const { JSDOM } = require(join(FRONTEND, 'node_modules/jsdom'));
const { build } = require(join(FRONTEND, 'node_modules/esbuild'));

const ARGV = new Set(process.argv.slice(2));
const AS_JSON = ARGV.has('--json');
const QUIET = ARGV.has('--quiet') || AS_JSON;

const ST_REF_EVENTS_JS = 'd:/SillyTavern-release/public/scripts/events.js';

// ---------------------------------------------------------------- 载体装载

/** 把生产入口编译成 CJS 并就地求值，拿到与 iframe 逐字节一致的脚本文本。 */
async function loadArtifact() {
  // 载体一（未求值源码）用 process.cwd() 拼路径，模块顶层就会 readFileSync，故先切到 frontend。
  process.chdir(FRONTEND);
  const result = await build({
    stdin: {
      contents:
        "export { COMPAT_V2_RUNTIME_ARTIFACT } from './src/components/ui/custom/smart-card-runtime/__tests__/compat-v2-runtime-source';",
      resolveDir: FRONTEND,
      loader: 'ts',
      sourcefile: 'ver2-artifact-entry.ts',
    },
    absWorkingDir: FRONTEND,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  // 信任边界：`code` 由本仓源码经 esbuild 就地打包得到（不落盘、不来自网络/用户输入），
  // 与 R1 探针 `w.eval(artifact)` 同等信任级别；这里只是把它从 ESM bundle 取出来。
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__dirname', '__filename', code)(
    mod, mod.exports, require, FRONTEND, join(FRONTEND, 'ver2-artifact-entry.js'),
  );
  const artifact = mod.exports.COMPAT_V2_RUNTIME_ARTIFACT;
  if (typeof artifact !== 'string' || artifact.length < 10000) {
    throw new Error('COMPAT_V2_RUNTIME_ARTIFACT 装载失败');
  }
  return artifact;
}

// ---------------------------------------------------------------- 静态表

/** 从源码文本里抠出 `NAME: 'value'` 形式的字面量表（只用于名单来源，不用于行为断言）。 */
function parseLiteralTable(text, anchor, endToken = '};') {
  const start = text.indexOf(anchor);
  if (start < 0) throw new Error('找不到锚点: ' + anchor);
  const end = text.indexOf(endToken, start);
  const body = text.slice(start, end);
  const rows = [];
  const re = /^\s*([A-Z][A-Z0-9_]*):\s*'([^']*)',?\s*$/gm;
  let m;
  while ((m = re.exec(body))) rows.push({ key: m[1], value: m[2] });
  return rows;
}

function loadStEventTypes() {
  const text = readFileSync(join(FRONTEND, 'src/lib/sillytavern/getContext.ts'), 'utf8');
  return parseLiteralTable(text, 'export const ST_EVENT_TYPES');
}

function loadStReference() {
  const candidates = [
    ST_REF_EVENTS_JS,
    join(REPO, '_reference/sillytavern-1.18.0/public/scripts/events.js'),
  ];
  for (const p of candidates) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch (e) { continue; }
    // events.js 的 event_types 对象：  NAME: 'value',
    const rows = [];
    const re = /^\s*([A-Z][A-Z0-9_]*):\s*'([^']*)',?\s*$/gm;
    let m;
    while ((m = re.exec(text))) rows.push({ key: m[1], value: m[2] });
    if (rows.length) return { available: true, rows, path: p, reason: '' };
  }
  return { available: false, rows: [], path: '', reason: 'both ST 1.18 copies unreadable' };
}

/**
 * 宿主面（父页面插件沙箱）静态 emit 点：lib/sillytavern/runtime.ts 与 getContext.ts。
 * 这两处的 eventSource 都落在同一个 eventBus 上（sandbox 的 eventSource 也委托同一 bus），
 * 但本探针**没有求值**宿主运行时 —— 只作「静态有发射点」证据，不计入帧内真发数。
 */
function scanHostEmitSites() {
  const runtimeRel = 'src/lib/sillytavern/runtime.ts';
  const files = [runtimeRel, 'src/lib/sillytavern/getContext.ts'];
  let mapTable = {};
  try {
    const runtimeText = readFileSync(join(FRONTEND, runtimeRel), 'utf8');
    for (const r of parseLiteralTable(runtimeText, 'export const ST_TO_PALINK_EVENT_MAP')) {
      mapTable[r.key] = r.value;
    }
  } catch (e) { /* 表读不到就只认字面量 */ }
  const map = new Map(); // value -> Set(file)
  for (const rel of files) {
    let text = '';
    try { text = readFileSync(join(FRONTEND, rel), 'utf8'); } catch (e) { continue; }
    const re = /eventSource\.emit\(\s*(?:ST_TO_PALINK_EVENT_MAP\.([A-Z][A-Z0-9_]*)|'([^']+)')/g;
    let m;
    while ((m = re.exec(text))) {
      const value = m[1] ? mapTable[m[1]] : m[2];
      if (!value) continue;
      if (!map.has(value)) map.set(value, new Set());
      map.get(value).add(rel);
    }
  }
  return map;
}

/** 载体里的 emit 调用点 → 规范事件值集合。 */
function scanEmitSites(artifact, keyToValue, mvuKeys) {
  const sites = new Map(); // value -> Set(来源描述)
  const add = (value, from) => {
    if (!value) return;
    if (!sites.has(value)) sites.set(value, new Set());
    sites.get(value).add(from);
  };
  const reKeyed = /emitCompatEvent\(\s*window\.event_types\?\.([A-Z][A-Z0-9_]*)\s*\|\|\s*'([^']*)'/g;
  let m;
  while ((m = reKeyed.exec(artifact))) {
    const [, key, literal] = m;
    add(keyToValue[key] || literal, 'emitCompatEvent(event_types?.' + key + ')');
  }
  const reMvu = /emitCompatEvent\(\s*MVU_EVENT_KEYS\.([A-Z][A-Z0-9_]*)/g;
  while ((m = reMvu.exec(artifact))) {
    const key = m[1];
    add(mvuKeys[key] || null, 'emitCompatEvent(MVU_EVENT_KEYS.' + key + ')');
  }
  const reLiteral = /emitCompatEvent\(\s*'([^']*)'/g;
  while ((m = reLiteral.exec(artifact))) {
    add(m[1], "emitCompatEvent('" + m[1] + "')");
  }
  return sites;
}

/** MVU 事件键：载体里是闭包常量，源码里可直接读到（part-01 顶部）。 */
function loadMvuKeys() {
  const text = readFileSync(
    join(FRONTEND, 'src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts'),
    'utf8',
  );
  const rows = parseLiteralTable(text, 'const MVU_EVENT_KEYS', '};');
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

// ---------------------------------------------------------------- 帧启动

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProbeWindow() {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="palink-frame-secret" content=""><meta name="palink-frame-secret-v2" content=""></head><body></body></html>',
    { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const w = dom.window;
  w.structuredClone = w.structuredClone || ((v) => JSON.parse(JSON.stringify(v)));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  w.EventSource = w.EventSource || class { addEventListener() {} removeEventListener() {} close() {} };
  w.requestIdleCallback = w.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 0 }), 0));
  w.cancelIdleCallback = w.cancelIdleCallback || ((id) => clearTimeout(id));
  w.matchMedia = w.matchMedia || (() => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }));
  w.scrollTo = w.scrollTo || (() => {});
  if (w.URL && !w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:probe';
  if (w.URL && !w.URL.revokeObjectURL) w.URL.revokeObjectURL = () => {};
  if (w.crypto && !w.crypto.randomUUID) {
    try { Object.defineProperty(w.crypto, 'randomUUID', { value: () => require('node:crypto').randomUUID(), configurable: true }); } catch (e) { /* ignore */ }
  }
  // 网络面一律不碰。
  w.fetch = () => Promise.reject(new Error('ver2 probe: fetch disabled'));

  const ctx = {
    characterId: 'ver2-probe-char',
    characterName: 'Ver2Probe',
    userName: 'Ver2User',
    language: 'zh',
    worldbookName: '',
    selectedModel: '',
    idbNamespaceDisabled: true,
    messageId: 0,
    messageIndex: 0,
    messageContent: 'hello',
    chatMessages: [
      { message_id: 0, mes: 'hello', name: 'Ver2Probe', is_user: false, swipes: ['hello', 'hello2'], swipe_id: 0 },
      { message_id: 1, mes: 'hi', name: 'Ver2User', is_user: true },
    ],
    firstMes: 'hello',
    alternateGreetings: [],
    presetData: null,
    presetSnapshot: null,
    extensionCatalog: null,
    isAdmin: false,
    globalRegexScripts: [],
    stPluginRuntimeConfig: { plugins: [], extension_settings: {} },
    persistedStorage: { localStorage: {}, sessionStorage: {} },
    sessionId: 'ver2-probe-session',
    depth: 0,
    isInit: true,
    trustedNative: false,
    sourceFingerprint: '',
    presentationMode: 'inline',
    viewport: null,
    variables: { hp: 7 },
  };
  w.__palinkBoot__ = {
    runtimeVersion: '2.0.0',
    origin: 'http://localhost:3000',
    ctx,
    frameId: 'ver2-frame-0001',
    runtimeMode: 'iframe-js',
    requiredApis: [],
    nonce: '',
  };
  w.chat_metadata = { variables: { hp: 7 } };

  // 受控宿主：接 window.parent.postMessage（parent===window）走向外消息，按 action 直接回 no-op 结果。
  const outgoing = [];
  const hostReplies = {
    triggerGeneration: { content: 'VER2_MOCK_REPLY' },
    generateRaw: { content: 'VER2_MOCK_RAW' },
    generateQuietPrompt: { content: 'VER2_MOCK_QUIET' },
    generate: { content: 'VER2_MOCK_REPLY' },
  };
  const inbound = [];
  w.parent.postMessage = (data) => {
    outgoing.push(data);
    if (!data || data.type !== 'request') return;
    const result = hostReplies[data.action] ?? {};
    inbound.push({ requestId: data.requestId, action: data.action });
    // 同步回包：帧内 pendingRequests 在 post() 之前已登记。
    w.dispatchEvent(new w.MessageEvent('message', {
      data: {
        source: 'palink-smart-card-parent',
        frameId: 'ver2-frame-0001',
        requestId: data.requestId,
        ok: true,
        result,
      },
    }));
  };
  return { dom, w, outgoing, inbound };
}

function bootFrame(artifact) {
  const probe = makeProbeWindow();
  let evalError = null;
  const t0 = Date.now();
  try {
    probe.w.eval(artifact);
  } catch (e) {
    evalError = String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e);
  }
  return { ...probe, evalError, bootMs: Date.now() - t0 };
}

// ---------------------------------------------------------------- 驱动生产路径

async function driveProductionPaths(w) {
  const run = async (label, fn) => {
    try { await fn(); } catch (e) { return { label, error: String((e && e.message) || e) }; }
    return { label };
  };
  const ctxUpdate = (data) => {
    w.dispatchEvent(new w.MessageEvent('message', {
      data: { source: 'palink-smart-card-parent', frameId: 'ver2-frame-0001', type: 'context-update', ...data },
    }));
  };
  const steps = [
    ['boot-timer', async () => { await sleep(30); }],
    ['generate(str)', () => w.generate('VER2_PROBE_PROMPT')],
    ['generate(obj)', () => w.generate({ quiet_prompt: 'VER2_PROBE_QUIET' })],
    ['sendMessage', () => w.sendMessage('VER2_PROBE_USER')],
    ['addOneMessage(user)', () => w.addOneMessage({ mes: 'VER2_ADD_USER', is_user: true })],
    ['addOneMessage(char)', () => w.addOneMessage({ mes: 'VER2_ADD_CHAR', is_user: false })],
    ['setChatMessage', () => w.setChatMessage('VER2_EDITED', 1, {})],
    ['swipe', () => (w.swipe ? w.swipe(null, 1, { forceMesId: 0 }) : null)],
    ['deleteMessage', () => w.deleteMessage(1)],
    ['saveSettings', () => w.saveSettings()],
    ['saveSettingsDebounced', () => w.saveSettingsDebounced()],
    ['stopGeneration', () => w.stopGeneration()],
    ['select_group_chats', () => w.select_group_chats('ver2-group')],
    ['generateGroupWrapper', () => w.generateGroupWrapper('normal', { quiet_prompt: 'VER2_GROUP' })],
    ['setVariable', () => (typeof w.setVariable === 'function' ? w.setVariable('hp', 9) : null)],
    ['getContext().updateChatMetadata', () => {
      const api = typeof w.getContext === 'function' ? w.getContext() : null;
      return api && typeof api.updateChatMetadata === 'function' ? api.updateChatMetadata('ver2_probe_key', 1) : null;
    }],
    ['replaceVariables(TavernHelper)', () => (w.TavernHelper && w.TavernHelper.replaceVariables
      ? w.TavernHelper.replaceVariables({ hp: 11 }, { type: 'chat' }) : null)],
    ['context-update(mvuInit)', async () => { ctxUpdate({ mvuInit: true, context: { variables: { hp: 12 } } }); await sleep(10); }],
    ['context-update(chatMessages)', async () => {
      ctxUpdate({ context: { chatMessages: [{ message_id: 0, mes: 'hello', is_user: false, swipes: ['hello'], swipe_id: 0 }] } });
      await sleep(10);
    }],
  ];
  const report = [];
  for (const [label, fn] of steps) {
    const r = await run(label, fn);
    report.push(r);
    await sleep(5);
  }
  return report;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const artifact = await loadArtifact();
  const stTypes = loadStEventTypes();
  const stRef = loadStReference();
  const mvuKeys = loadMvuKeys();

  const frame = bootFrame(artifact);
  const { w, evalError } = frame;

  // 监听 emitted（在 boot 定时器之前包好）
  const emitted = [];
  const source = w.eventSource;
  if (!source) throw new Error('帧内没有 eventSource（运行时未启动）');
  const origEmit = source.emit.bind(source);
  source.emit = (...args) => { emitted.push(String(args[0])); return origEmit(...args); };

  const driveReport = await driveProductionPaths(w);
  const observed = new Set(emitted);

  // 帧内表（运行期权威）
  const frameTable = {};
  {
    const raw = w.event_types;
    if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) frameTable[k] = raw[k];
  }
  const keyToValue = { ...frameTable };
  for (const r of stTypes) if (!(r.key in keyToValue)) keyToValue[r.key] = r.value;
  // 反向：值 → 键（帧内优先）
  const valueToFrameKey = new Map();
  for (const [k, v] of Object.entries(frameTable)) if (!valueToFrameKey.has(v)) valueToFrameKey.set(v, k);

  const emitSites = scanEmitSites(artifact, keyToValue, mvuKeys);
  const hostEmitSites = scanHostEmitSites();

  // ---- 逐条往返
  const rows = [];
  for (const { key, value } of stTypes) {
    const frameValue = frameTable[key];
    const canonical = frameValue || value;
    // 机制往返：用规范值订阅 + emit
    let busRoundtrip = false;
    let busError = '';
    const hits = [];
    const cb = (...args) => hits.push(args);
    let off = null;
    try {
      off = source.on(canonical, cb);
      await source.emit(canonical, { ver2: true });
      await sleep(0);
      busRoundtrip = hits.length > 0;
    } catch (e) {
      busError = String((e && e.message) || e);
    } finally {
      if (typeof off === 'function') off();
      source.off(canonical, cb);
    }
    // 消费者路径：按 ST 惯例用 event_types.KEY
    const consumerKey = frameValue;
    let consumerDelivered = false;
    if (consumerKey !== undefined) {
      const hits2 = [];
      const cb2 = () => hits2.push(1);
      let off2 = null;
      try {
        off2 = source.on(consumerKey, cb2);
        await source.emit(consumerKey, { ver2: true });
        await sleep(0);
        consumerDelivered = hits2.length > 0;
      } catch (e) { /* ignore */ } finally {
        if (typeof off2 === 'function') off2();
        source.off(consumerKey, cb2);
      }
    }

    const siteSet = emitSites.get(canonical) || emitSites.get(value);
    const hostSet = hostEmitSites.get(canonical) || hostEmitSites.get(value);
    const stRefRow = stRef.rows.find((r) => r.key === key);
    const stKeyMatch = Boolean(stRefRow);
    const stValueMatch = stRefRow ? stRefRow.value === value : false;

    const observedFlag = observed.has(canonical);
    // 判定（帧内为主表面；宿主面只作静态证据）：
    //  真发      = 本轮驱动生产路径时帧内真的 emit 了
    //  宿主面真发 = 帧内零发射点，但宿主 eventBus 上有静态 emit 点（未求值，标静态）
    //  名存实亡   = 帧内无发射点、宿主也无发射点 ⇒ 两级订阅都永不触发
    //  未实现    = 帧内 event_types 无此键，且两级都无发射点
    let verdict;
    if (observedFlag) verdict = '真发';
    else if (hostSet) verdict = '帧内未发·宿主静态';
    else if (!frameValue) verdict = '未实现';
    else verdict = '名存实亡';

    rows.push({
      key,
      value,
      canonical,
      frameKeyPresent: frameValue !== undefined,
      frameValue: frameValue === undefined ? null : frameValue,
      subscribeViaEventTypes: consumerKey !== undefined ? consumerDelivered : false,
      busRoundtrip,
      busError,
      emitSite: siteSet ? Array.from(siteSet) : [],
      hostEmitSite: hostSet ? Array.from(hostSet) : [],
      observed: observedFlag,
      stKeyMatch,
      stValueMatch,
      verdict,
    });
  }

  // ---- MVU 事件（mag_）+ CHAT_VARIABLES_UPDATED：不在 ST_EVENT_TYPES 里，单列
  const mvuRows = [];
  for (const [key, value] of Object.entries(mvuKeys)) {
    const hits = [];
    const cb = () => hits.push(1);
    const off = source.on(value, cb);
    await source.emit(value, { ver2: true });
    await sleep(0);
    if (typeof off === 'function') off();
    source.off(value, cb);
    mvuRows.push({
      key, value,
      busRoundtrip: hits.length > 0,
      observed: observed.has(value),
      emitSite: Array.from(emitSites.get(value) || []),
    });
  }

  // ---- ST-EVT-05：监听器泄漏（同事件反复 on/off 后计数不涨）
  // 注意：帧在 jsdom 的另一个 realm，`instanceof Map` 跨 realm 为 false，只能鸭子类型判断。
  const listenerCount = () => {
    const m = source._listeners;
    if (!m || typeof m.get !== 'function' || typeof m.size !== 'number') return -1;
    let n = 0;
    const iter = typeof m.forEach === 'function' ? m : null;
    if (!iter) return -1;
    m.forEach((set) => { if (set && typeof set.size === 'number') n += set.size; });
    return n;
  };
  const leakProbeEvent = rows[0] ? rows[0].canonical : 'app_ready';
  const beforeLeak = listenerCount();
  for (let i = 0; i < 50; i++) {
    const cb = () => {};
    const off = source.on(leakProbeEvent, cb);
    await source.emit(leakProbeEvent, { ver2: true });
    if (typeof off === 'function') off(); else source.off(leakProbeEvent, cb);
  }
  const afterLeak = listenerCount();

  // ---- ST-EVT-01 附：eventSource 方法面 / Mvu 对象成员（MVU beta 6 键基线）
  const eventSourceApi = {};
  for (const k of ['on', 'off', 'once', 'emit', 'emitAndWait', 'makeLast', 'removeListener', 'removeAllListeners']) {
    eventSourceApi[k] = typeof source[k] === 'function';
  }
  const mvuApi = {
    present: Boolean(w.Mvu),
    keys: w.Mvu && typeof w.Mvu === 'object' ? Object.keys(w.Mvu).sort() : [],
    eventsKeys: w.Mvu && w.Mvu.events && typeof w.Mvu.events === 'object' ? Object.keys(w.Mvu.events) : [],
  };
  const MVU_OBJECT_BASELINE = ['events', 'getAllVariables', 'getVariable', 'setVariable', 'replaceVariables', 'getMvuData'];
  mvuApi.baseline = MVU_OBJECT_BASELINE.map((k) => ({
    key: k,
    present: Boolean(w.Mvu && typeof w.Mvu[k] !== 'undefined'),
  }));
  // Mvu.events 才是「露缇雅基线 6 个事件」的权威集合：逐键看本轮有没有真 emit。
  mvuApi.eventCoverage = Object.entries(mvuApi.eventsKeys.length
    ? Object.fromEntries(mvuApi.eventsKeys.map((k) => [k, w.Mvu.events[k]]))
    : {})
    .map(([k, v]) => ({ key: k, value: v, observed: observed.has(String(v)) }));

  // ---- 汇总
  const stTypesKeys = new Set(stTypes.map((r) => r.key));
  const stRefKeys = new Set(stRef.rows.map((r) => r.key));
  const frameKeys = new Set(Object.keys(frameTable));
  const countVerdict = (v) => rows.filter((r) => r.verdict === v).length;
  const metrics = {
    stTypesCount: stTypes.length,
    stRefCount: stRef.rows.length,
    stRefAvailable: stRef.available,
    stRefPath: stRef.path,
    frameTableCount: frameKeys.size,
    frameMissingFromStTypes: Array.from(frameKeys).filter((k) => !stTypesKeys.has(k)).sort(),
    stTypesMissingFromFrame: Array.from(stTypesKeys).filter((k) => !frameKeys.has(k)).sort(),
    stRefOnly: Array.from(stRefKeys).filter((k) => !frameKeys.has(k)).sort(),
    frameOnlyVsRef: Array.from(frameKeys).filter((k) => !stRefKeys.has(k)).sort(),
    valueMismatchVsRef: stRef.rows
      .filter((r) => frameTable[r.key] !== undefined && frameTable[r.key] !== r.value)
      .map((r) => ({ key: r.key, st: r.value, palink: frameTable[r.key] })),
    roundtripOk: rows.filter((r) => r.busRoundtrip).length,
    subscribeViaEventTypesOk: rows.filter((r) => r.subscribeViaEventTypes).length,
    emittedDistinct: Array.from(observed).sort(),
    emittedCount: observed.size,
    observedStTypes: rows.filter((r) => r.observed).length,
    staticOnlyStTypes: rows.filter((r) => !r.observed && r.emitSite.length > 0).length,
    noEmitSiteStTypes: rows.filter((r) => !r.observed && r.emitSite.length === 0).length,
    noFrameKeyStTypes: rows.filter((r) => !r.frameKeyPresent).length,
    // 发得出但订不上：帧内真 emit 了，但 event_types 里没有这个键（消费者按 ST 惯例订不到）
    emittedButUnsubscribable: rows.filter((r) => r.observed && !r.frameKeyPresent).map((r) => r.key).sort(),
    verdicts: {
      trueEmit: countVerdict('真发'),
      hostStatic: countVerdict('帧内未发·宿主静态'),
      dead: countVerdict('名存实亡'),
      notImplemented: countVerdict('未实现'),
    },
    frameTableEqualsSt118: {
      sameKeys: frameKeys.size === stRefKeys.size
        && Array.from(frameKeys).every((k) => stRefKeys.has(k)),
      valueMismatch: stRef.rows.filter((r) => frameTable[r.key] !== r.value).length,
    },
    listenerLeak: { event: leakProbeEvent, before: beforeLeak, after: afterLeak, delta: afterLeak - beforeLeak },
    eventSourceApi,
    mvuApi,
    evalError,
    artifactLength: artifact.length,
    driveReport,
  };

  const payload = { generatedAt: new Date().toISOString(), metrics, rows, mvuRows };

  if (AS_JSON) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  // ---- 表格
  const pad = (s, n) => {
    const str = String(s);
    let width = 0;
    for (const ch of str) width += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
    return str + ' '.repeat(Math.max(0, n - width));
  };
  const out = [];
  out.push('VER-2 事件往返探针 · 载体 COMPAT_V2_RUNTIME_ARTIFACT len=' + artifact.length
    + ' · ST_EVENT_TYPES=' + metrics.stTypesCount + ' · 帧内 event_types=' + metrics.frameTableCount
    + ' · ST1.18=' + metrics.stRefCount + ' @' + stRef.path);
  out.push('');
  const head = ['事件名', '值', '帧内存在', '订阅可用', 'emit可达', '与ST对齐'];
  out.push(head.map((h, i) => pad(h, [39, 37, 9, 9, 11, 11][i])).join(''));
  for (const r of rows) {
    const emitCell = r.observed ? '观测' : (r.emitSite.length ? '静态' : (r.hostEmitSite.length ? '宿主静态' : '无'));
    const stCell = !r.stKeyMatch ? 'N' : (r.stValueMatch ? 'Y' : '值差异');
    const notes = [r.verdict];
    if (r.observed && !r.frameKeyPresent) notes.push('发得出但 event_types 无键');
    if (r.emitSite.length) notes.push('frame:' + r.emitSite.length + '处');
    if (r.hostEmitSite.length) notes.push('host:' + r.hostEmitSite.map((f) => f.split('/').pop()).join(','));
    out.push([
      pad(r.key, 39),
      pad(r.value, 37),
      pad(r.frameKeyPresent ? 'Y' : 'N', 9),
      pad(r.subscribeViaEventTypes ? 'Y' : 'N', 9),
      pad(emitCell, 11),
      pad(stCell, 11),
      notes.join(' | '),
    ].join(''));
  }
  out.push('');
  out.push('-- MVU 事件（mag_*，不属于 ST_EVENT_TYPES）--');
  for (const m of mvuRows) {
    out.push('  ' + pad(m.key, 26) + pad(m.value, 30) + '往返=' + (m.busRoundtrip ? 'Y' : 'N')
      + ' 观测=' + (m.observed ? 'Y' : 'N') + ' 发射点=' + (m.emitSite.join('; ') || '无'));
  }
  if (!QUIET) process.stdout.write(out.join('\n') + '\n');

  console.log('');
  console.log('RESULT eval_error=' + (evalError ? evalError : 'none'));
  console.log('RESULT st_types_count=' + metrics.stTypesCount + ' frame_event_types=' + metrics.frameTableCount
    + ' st118=' + metrics.stRefCount);
  console.log('RESULT roundtrip_ok=' + metrics.roundtripOk + '/' + metrics.stTypesCount
    + ' subscribe_via_event_types_ok=' + metrics.subscribeViaEventTypesOk + '/' + metrics.stTypesCount);
  console.log('RESULT emitted_distinct=' + metrics.emittedCount);
  console.log('RESULT st_true_emit=' + metrics.observedStTypes
    + ' has_emit_site_not_observed=' + metrics.staticOnlyStTypes
    + ' no_emit_site=' + metrics.noEmitSiteStTypes
    + ' no_frame_key=' + metrics.noFrameKeyStTypes);
  console.log('RESULT verdicts true_emit=' + metrics.verdicts.trueEmit
    + ' host_static=' + metrics.verdicts.hostStatic
    + ' dead=' + metrics.verdicts.dead
    + ' not_implemented=' + metrics.verdicts.notImplemented
    + ' emitted_but_unsubscribable=' + metrics.emittedButUnsubscribable.length);
  console.log('RESULT frame_equals_st118 keys=' + metrics.frameTableEqualsSt118.sameKeys
    + ' value_mismatch=' + metrics.frameTableEqualsSt118.valueMismatch);
  console.log('RESULT frame_missing_from_st_types=' + metrics.frameMissingFromStTypes.length
    + ' st_types_missing_from_frame=' + metrics.stTypesMissingFromFrame.length
    + ' value_mismatch_vs_st=' + metrics.valueMismatchVsRef.length);
  console.log('RESULT listener_leak delta=' + metrics.listenerLeak.delta
    + ' (' + metrics.listenerLeak.before + '->' + metrics.listenerLeak.after + ')');
  console.log('RESULT eventSource_api=' + Object.entries(metrics.eventSourceApi)
    .map(([k, v]) => k + ':' + (v ? 'Y' : 'N')).join(','));
  console.log('RESULT mvu_present=' + metrics.mvuApi.present
    + ' mvu_events_keys=' + metrics.mvuApi.eventsKeys.join('|')
    + ' mvu_baseline_missing=' + metrics.mvuApi.baseline.filter((b) => !b.present).map((b) => b.key).join(',') );
  console.log('EMITTED=' + metrics.emittedDistinct.join(','));
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e);
  process.exit(1);
});
