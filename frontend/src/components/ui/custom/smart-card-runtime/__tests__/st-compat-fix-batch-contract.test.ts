/*
 * 单间轨 ST 兼容层修复批 · 行为契约测试（2026-10-16）
 *
 * 来源：REPORT_S5架构重建评审_ST兼容性实测与打分_2026-10-16.md §6 六项建议
 *       → SPEC_ST兼容层修复计划_承接S5评审_2026-10-16.md 批 1（T1/T2/T3/T8）
 *
 * 覆盖四项：
 *   A. T1 假实现显性化：桩被调用时经 reportDiagnostic 留痕（severity/code/apiName 三要素），
 *      且 getContext() 的可枚举键集合**不因留痕而改变**（不污染 184 键口径）。
 *   B. T2 卡内 triggerSlash：getContext().triggerSlash 存在且桥到宿主 runPalinkSlash；
 *      命中 Palink 命令返回其结果，未命中走宿主回落，RPC 抛错不炸。
 *   C. T3 MVU 世界书：loadWorldInfo 返回 { name, entries }，entries 是**对象**形状
 *      （lodash isPlainObject 判定；数组会假阴性 —— 这是真机 MVU 抛错的判据，见下）。
 *   D. T8 setExtensionPrompt 行为：set→get 闭环 + postMessage 上报 + 重载恢复三路。
 *
 * ⚠️ 关于 C 的判据来源（不是我们拍的）：
 *   真机卡 bundle backend/data/smart_card_assets/0c646fb31a….js（MVU beta）原文：
 *     async function $a(t){
 *       const n = await SillyTavern.loadWorldInfo(t);
 *       if(!_.isPlainObject(n)||!_.isPlainObject(_.get(n,'entries')))
 *         throw new Error(at('runtime.characterOverride.worldbookReadFailed',{worldbook:t}));
 *     }
 *   所以「entries 必须是 plain object」是**消费方的真实判据**。测试里直接用 lodash 判，
 *   不自己写近似判据（AGENTS.md：探针参数必须与生产调用方一致）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-compat-fix-batch-contract.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { COMPAT_V2_RUNTIME_SOURCE as COMPAT_V2_SOURCE } from './compat-v2-runtime-source';

// ── 工具：按 marker 切出帧内真实源码区域并独立求值 ────────────────

/** 从 `const <name> = ` 起按花括号配平切出一段（与 worldbook-boot-inline-contract.test.ts 同法）。 */
function sliceDeclaration(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  expect(i, `no '{' after marker: ${marker}`).toBeGreaterThan(-1);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

/**
 * 取 prefix **之后**那个箭头函数表达式整体（签名 + 花括号配平的函数体）。
 *
 * 为什么需要它：被测实现多是「包装调用」，形如
 *   `const stubApi = (apiName, impl) => { ... };`
 *   `loadWorldInfo: stubApi('loadWorldInfo', async (name) => { ... }),`
 *   `setCompatFunction('setExtensionPrompt', (key, value, ...) => { ... });`
 * 多行函数体必须按花括号配平切（按行切会 SyntaxError），且**签名必须一起带回**
 * （只取函数体的话参数名未定义，vm 直接 ReferenceError）。
 *
 * @param prefix 箭头函数签名之前的前缀文本（函数表达式从它的结尾开始）
 * @returns 形如 `(a, b) => { ... }` 的合法表达式文本
 */
function sliceArrowAfter(src: string, prefix: string): string {
  const start = src.indexOf(prefix);
  expect(start, `prefix not found: ${prefix}`).toBeGreaterThan(-1);
  const rest = src.slice(start + prefix.length);
  let depth = 0;
  let i = rest.indexOf('{');
  expect(i, `no '{' after prefix: ${prefix}`).toBeGreaterThan(-1);
  for (; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    else if (rest[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return rest.slice(0, i + 1);
}

interface FrameHarness {
  /** 帧内暴露出来的被测函数 */
  api: Record<string, any>;
  diagnostics: any[];
  posted: any[];
  registry: Record<string, any>;
}

/**
 * 构造一个最小帧环境：只注入被测区域依赖的闭包变量与桩。
 *
 * 说明：整段运行时体 6000+ 行、依赖 DOM 面太宽（同 console-noise 测试文件头论证），
 * 故按「抽段 + new Function 注入依赖」测真行为；断言的仍是仓库里的真实源码。
 */
function buildFrame(overrides: {
  parentByAction?: Record<string, any>;
  parentThrows?: boolean;
  activeWorldbookName?: string;
  diagnostics?: any[];
} = {}): FrameHarness {
  const diagnostics: any[] = [];
  const posted: any[] = [];
  const registry: Record<string, any> = {};

  const reportDiagnostic = (d: any) => { diagnostics.push(d); };
  const post = (msg: any) => { posted.push(msg); };
  const requestParent = vi.fn(async (action: string) => {
    if (overrides.parentThrows) throw new Error('parent rpc exploded');
    const byAction = overrides.parentByAction || {};
    if (Object.prototype.hasOwnProperty.call(byAction, action)) return byAction[action];
    return { success: true, name: '露缇雅1.2', entries: [] };
  });
  const setCompatFunction = (name: string, fn: any) => { registry[name] = fn; };
  const ensureFunction = (name: string, fn: any) => {
    if (typeof registry[name] === 'undefined') registry[name] = fn;
  };

  const api: Record<string, any> = {};

  // ── T1：桩留痕 helper ──
  const stubRegion = sliceDeclaration(COMPAT_V2_SOURCE, 'const PALINK_STUB_API_NOTES = {')
    + '\n'
    + sliceDeclaration(COMPAT_V2_SOURCE, 'const stubApiReported = {};')
    + '\n'
    + 'const reportStubApi = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const reportStubApi = ')
    + '\n'
    + 'const stubApi = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const stubApi = ');
  const stubFactory = new Function(
    'reportDiagnostic',
    stubRegion + '\nreturn { reportStubApi: reportStubApi, stubApi: stubApi, PALINK_STUB_API_NOTES: PALINK_STUB_API_NOTES };',
  );
  const stubKit = stubFactory(reportDiagnostic);

  // ── T2：卡内 triggerSlash ──
  const slashRegion = 'const triggerSlashCompat = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const triggerSlashCompat = ');
  const slashFactory = new Function(
    'requestParent', 'post',
    slashRegion + '\nreturn triggerSlashCompat;',
  );
  api.triggerSlashCompat = slashFactory(requestParent, post);

  // ── T3：loadWorldInfo 真实现 ──
  // 该实现在 getContextCompat 对象字面量里，依赖 requestParent / activeLorebooks /
  // activeWorldbookName / post / reportStubApi。
  // [T6 2026-10-18] 锚点从 'loadWorldInfo: stubApi('loadWorldInfo', ' 改为 'loadWorldInfo: '：
  // 拆掉 stubApi 包装后函数名后是 `async (name) => {`，sliceArrowAfter 需要锚定到
  // 箭头函数签名之前。sliceArrowAfter 仍按花括号配平取出完整箭头函数表达式。
  const loadWorldInfoRegion = sliceArrowAfter(
    COMPAT_V2_SOURCE,
    'loadWorldInfo: ',
  );
  let activeWorldbookName = overrides.activeWorldbookName || '';
  const loadWorldInfoFactory = new Function(
    'requestParent', 'post', 'reportStubApi', 'activeLorebooks', 'getActiveWorldbookName', 'setActiveWorldbookName',
    'const fn = ' + loadWorldInfoRegion + ';\nreturn fn;',
  );
  const activeLorebooks = { primary: activeWorldbookName, additional: [] };
  api.loadWorldInfo = loadWorldInfoFactory(
    requestParent,
    post,
    stubKit.reportStubApi,
    activeLorebooks,
    () => activeWorldbookName,
    (name: string) => { activeWorldbookName = name; activeLorebooks.primary = name; },
  );

  return {
    api,
    diagnostics,
    posted,
    registry,
  };
}

// lodash 的 isPlainObject 判定（消费方 MVU 用的就是它，别自己写近似版）。
function isPlainObjectLodashLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

// ============================================================
// A. T1 假实现显性化
// ============================================================
describe('A T1 假实现留痕 —— 桩被调用必须产出可诊断记录', () => {
  it('reportStubApi 产出 st_api_stub 诊断，且带 severity/code/apiName/message 四要素', () => {
    // 直接跑真实源码里的 helper（抽段 + new Function，注入最小依赖）。
    const region = sliceDeclaration(COMPAT_V2_SOURCE, 'const PALINK_STUB_API_NOTES = {')
      + '\n' + sliceDeclaration(COMPAT_V2_SOURCE, 'const stubApiReported = {};')
      + '\n' + 'const reportStubApi = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const reportStubApi = ')
      + '\n' + 'const stubApi = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const stubApi = ');
    const diags: any[] = [];
    const kit = new Function('reportDiagnostic', region + '\nreturn { reportStubApi: reportStubApi, stubApi: stubApi };')(
      (d: any) => diags.push(d),
    );
    kit.reportStubApi('writePresetExtensionField');
    expect(diags).toHaveLength(1);
    // [T6 2026-10-18] severity 由 warning 降为 info：桩命中只是兼容性提示，
    // 宿主侧只对 severity !== 'info' 弹 toast ⇒ 降级后不再刷屏。
    expect(diags[0].severity).toBe('info');
    expect(diags[0].code).toBe('st_api_stub');
    expect(diags[0].apiName).toBe('writePresetExtensionField');
    expect(String(diags[0].message)).toContain('writePresetExtensionField');
  });

  it('同一桩只上报一次（帧内单会话不去重会刷爆 toast，宿主侧还有 12s 去重）', () => {
    const region = sliceDeclaration(COMPAT_V2_SOURCE, 'const PALINK_STUB_API_NOTES = {')
      + '\n' + sliceDeclaration(COMPAT_V2_SOURCE, 'const stubApiReported = {};')
      + '\n' + 'const reportStubApi = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const reportStubApi = ')
      + '\n' + 'const stubApi = ' + sliceArrowAfter(COMPAT_V2_SOURCE, 'const stubApi = ');
    const diags: any[] = [];
    const kit = new Function('reportDiagnostic', region + '\nreturn { reportStubApi: reportStubApi };')(
      (d: any) => diags.push(d),
    );
    kit.reportStubApi('loadWorldInfo');
    kit.reportStubApi('loadWorldInfo');
    kit.reportStubApi('loadWorldInfo');
    expect(diags).toHaveLength(1);
  });

  it('桩名说明表覆盖 getContextCompat 里所有被 flag 的 API（防加了 flag 漏写说明）', () => {
    const notes = sliceDeclaration(COMPAT_V2_SOURCE, 'const PALINK_STUB_API_NOTES = {');
    // [T6 2026-10-18] 删 loadWorldInfo：T3 修复 + 拆掉 stubApi 后它不再属于桩。
    const flagged = [
      'getWorldInfoPrompt', 'saveWorldInfo', 'getSelectedPresetName',
      'writePresetExtensionField', 'getRequestHeaders', 'getChatCompletionModel',
      'getMediaDisplay', 'getMediaIndex', 'appendMediaToMessage', 'scrollOnMediaLoad',
      'convertCharacterBook', 'getTextGenServer', 'renameChat', 'updateWorldInfoList',
      'reloadWorldInfoEditor', 'fetch:/api/worldinfo',
    ];
    flagged.forEach((name) => {
      expect(notes, `missing note for ${name}`).toContain(name);
    });
  });

  it('源码层：getContextCompat 的桩确实被 stubApi 包裹（不是只建了 helper 没用）', () => {
    const ctx = sliceDeclaration(COMPAT_V2_SOURCE, 'const getContextCompat = () => ({');
    // [T6 2026-10-18] 删 loadWorldInfo：拆掉 stubApi 后它不再是桩。
    ['saveWorldInfo', 'getWorldInfoPrompt', 'convertCharacterBook',
      'getChatCompletionModel', 'getMediaDisplay', 'getMediaIndex', 'getTextGenServer',
      'renameChat', 'scrollOnMediaLoad', 'appendMediaToMessage',
      'getSelectedPresetName', 'writePresetExtensionField',
      'updateWorldInfoList', 'reloadWorldInfoEditor'].forEach((name) => {
      const re = new RegExp(name + ":\\s*stubApi\\('" + name + "'");
      expect(re.test(ctx), `${name} should be wrapped by stubApi`).toBe(true);
    });
  });
});

// ============================================================
// B. T2 卡内 triggerSlash
// ============================================================
describe('B T2 卡内 triggerSlash —— getContext().triggerSlash 可达', () => {
  it('getContextCompat 暴露 triggerSlash 字段（此前单间轨 0 命中）', () => {
    const ctx = sliceDeclaration(COMPAT_V2_SOURCE, 'const getContextCompat = () => ({');
    expect(ctx).toMatch(/triggerSlash:\s*\(\.\.\.args\)\s*=>\s*triggerSlashCompat\(\.\.\.args\)/);
  });

  it('帧内 window.triggerSlash 也被注册（裸调用路径，JS-Slash-Runner 生态常用）', () => {
    expect(COMPAT_V2_SOURCE).toContain("setCompatFunction('triggerSlash', triggerSlashCompat);");
  });

  it('命中 Palink 命令 → 返回宿主结果（桥到 runPalinkSlash）', async () => {
    const { api } = buildFrame({
      parentByAction: { runPalinkSlash: { ok: true, result: 'palink-session-abc.jsonl' } },
    });
    const out = await api.triggerSlashCompat('/getchatname');
    expect(out).toBe('palink-session-abc.jsonl');
  });

  it('空命令直接返空串，不打 RPC（对齐沙箱轨对空串的短路语义）', async () => {
    const { api } = buildFrame();
    const out = await api.triggerSlashCompat('   ');
    expect(out).toBe('');
  });

  it('宿主 RPC 抛错不炸（返回空串，与共享实现的 catch 口径一致）', async () => {
    const { api, posted } = buildFrame({ parentThrows: true });
    const out = await api.triggerSlashCompat('/profile-list');
    expect(out).toBe('');
    // 降级必须留痕（不是静默吞）
    expect(posted.some((m) => m?.level === 'warn' && String(m.message || '').includes('triggerSlash'))).toBe(true);
  });

  it('宿主 success:false → 空串，不把错误结构透给卡脚本', async () => {
    const { api } = buildFrame({
      parentByAction: { runPalinkSlash: { ok: false, success: false, error: 'boom' } },
    });
    expect(await api.triggerSlashCompat('/branch-create 0')).toBe('');
  });

  it('源码层：宿主侧控制器有 runPalinkSlash 落点（桥的两端都要在）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const controller = readFileSync(
      join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts'),
      'utf8',
    );
    expect(controller).toContain("action.action === 'runPalinkSlash'");
    expect(controller).toContain('runPalinkSlashCommands(command)');
    expect(controller).toContain('executeSlashCommandCompat(command)');
  });
});

// ============================================================
// C. T3 MVU 世界书读取
// ============================================================
describe('C T3 loadWorldInfo —— MVU 的 isPlainObject 判据必须满足', () => {
  const PARENT_WITH_ENTRIES = {
    ok: true,
    success: true,
    name: '露缇雅1.2',
    entries: [
      { uid: 0, comment: '[InitVar]变量初始化', content: 'stat_data: {}' },
      { uid: 1, comment: '世界观', content: '某设定' },
    ],
  };

  it('返回对象且 entries 是 plain object（数组会让 MVU 抛 worldbookReadFailed）', async () => {
    const { api } = buildFrame({ parentByAction: { getCharWorldbook: PARENT_WITH_ENTRIES } });
    const out = await api.loadWorldInfo('露缇雅1.2');
    expect(isPlainObjectLodashLike(out)).toBe(true);
    expect(isPlainObjectLodashLike(out.entries)).toBe(true);
  });

  it('entries 以 uid 为键（ST world_info 契约形状，不是数组下标拼的假键）', async () => {
    const { api } = buildFrame({ parentByAction: { getCharWorldbook: PARENT_WITH_ENTRIES } });
    const out = await api.loadWorldInfo('露缇雅1.2');
    expect(Object.keys(out.entries)).toEqual(['0', '1']);
    expect(out.entries['0'].comment).toContain('[InitVar]');
    expect(out.name).toBe('露缇雅1.2');
  });

  it('条目零条时 entries 仍是 {}（不是 undefined/null —— MVU 会 _.get 后判 isPlainObject）', async () => {
    const { api } = buildFrame({ parentByAction: { getCharWorldbook: { success: true, name: '空书', entries: [] } } });
    const out = await api.loadWorldInfo('空书');
    expect(out.entries).toEqual({});
    expect(isPlainObjectLodashLike(out.entries)).toBe(true);
  });

  it('父侧 RPC 抛错 → 降级为空世界书，不抛给卡脚本（否则变量初始化整链断）', async () => {
    const { api, posted } = buildFrame({ parentThrows: true });
    const out = await api.loadWorldInfo('露缇雅1.2');
    expect(out.entries).toEqual({});
    expect(posted.some((m) => m?.level === 'warn')).toBe(true);
  });

  it('拿到书名后回写帧内 activeWorldbookName（后续同步 API 首次就有值）', async () => {
    const { api } = buildFrame({ parentByAction: { getCharWorldbook: PARENT_WITH_ENTRIES } });
    await api.loadWorldInfo(undefined);
    // loadWorldInfo 未显式传名时应采用父侧返回的书名
    const out = await api.loadWorldInfo(undefined);
    expect(out.name).toBe('露缇雅1.2');
  });

  it('桩留痕与真实现不重复报：loadWorldInfo 现在有真值，不应再打 st_api_stub', async () => {
    const { api, diagnostics } = buildFrame({ parentByAction: { getCharWorldbook: PARENT_WITH_ENTRIES } });
    await api.loadWorldInfo('露缇雅1.2');
    // reportStubApi 被注入但成功路径不应触发；只有 catch 分支的 post 留痕
    expect(diagnostics.some((d) => d.code === 'st_api_stub' && d.apiName === 'loadWorldInfo')).toBe(false);
  });
});

// ============================================================
// D. T8 setExtensionPrompt 行为契约
// ============================================================
describe('D T8 setExtensionPrompt —— set→get→上报→恢复 四路行为', () => {
  it('源码层：setExtensionPrompt 用 setCompatFunction 无条件接管（SINGLE-SOURCE 口径未被改坏）', () => {
    expect(COMPAT_V2_SOURCE).toContain("setCompatFunction('setExtensionPrompt'");
    expect(COMPAT_V2_SOURCE).toContain('getExtensionPromptStoreCompat()');
  });

  it('源码层：set 后 post extensionPrompts 快照（EP-BRIDGE 通道仍在）', () => {
    const region = 'const setExtensionPrompt = ' + sliceArrowAfter(COMPAT_V2_SOURCE, "setCompatFunction('setExtensionPrompt', ");
    expect(region).toContain("post({ type: 'extensionPrompts', prompts: next });");
    expect(region).toContain("setByPath(chatVariableStore, '__extension_prompts', next);");
  });

  it('源码层：宿主侧消费 extensionPrompts 并转 promptInjection（多 source 聚合）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const renderer = readFileSync(
      join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
      'utf8',
    );
    expect(renderer).toContain("data.type === 'extensionPrompts'");
    expect(renderer).toContain('promptInjection.setSourcePrompts(');
  });

  it('源码层：getExtensionPrompt 支持按 position/depth/role 过滤（不是只认 direct key）', () => {
    const region = 'const getExtensionPrompt = ' + sliceArrowAfter(COMPAT_V2_SOURCE, "setCompatFunction('getExtensionPrompt', ");
    expect(region).toContain('wantedPosition');
    expect(region).toContain('wantedDepth');
    expect(region).toContain('wantedRole');
  });

  it('行为级：set 的形状写进 __extension_prompts，get 按 key 读回同值', () => {
    // 直接跑 set/get 两段真实源码，喂最小 store。
    const setRegion = 'const setExtensionPrompt = ' + sliceArrowAfter(COMPAT_V2_SOURCE, "setCompatFunction('setExtensionPrompt', ");
    const getRegion = 'const getExtensionPrompt = ' + sliceArrowAfter(COMPAT_V2_SOURCE, "setCompatFunction('getExtensionPrompt', ");
    const chatVariableStore: Record<string, any> = {};
    const posted: any[] = [];
    const setByPath = (obj: any, path: string, value: any) => { obj[path] = value; };
    const getExtensionPromptStoreCompat = () => chatVariableStore.__extension_prompts || {};
    const persistVariableStores = () => {};
    const extension_prompt_roles = { SYSTEM: 0 };
    const extension_prompt_types = { IN_PROMPT: 0 };
    const factory = new Function(
      'setByPath', 'chatVariableStore', 'post', 'persistVariableStores',
      'getExtensionPromptStoreCompat', 'extension_prompt_roles', 'extension_prompt_types',
      setRegion + '\n' + getRegion
        + "\nreturn { set: setExtensionPrompt, get: getExtensionPrompt };",
    );
    const { set, get } = factory(
      setByPath, chatVariableStore, (m: any) => posted.push(m), persistVariableStores,
      getExtensionPromptStoreCompat, extension_prompt_roles, extension_prompt_types,
    );
    set('mvu-status', '当前状态：健康', 0, 4, false, 0, null);
    expect(get('mvu-status')).toBe('当前状态：健康');
    // 上报快照必须带同值
    expect(posted.some((m) => m?.type === 'extensionPrompts' && m.prompts['mvu-status'].value === '当前状态：健康')).toBe(true);
    // store 形状（供 iframe 重载后恢复）
    expect(chatVariableStore.__extension_prompts['mvu-status']).toMatchObject({
      value: '当前状态：健康', position: 0, depth: 4,
    });
  });
});
