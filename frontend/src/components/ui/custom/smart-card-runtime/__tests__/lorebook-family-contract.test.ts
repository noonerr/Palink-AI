/*
 * lorebook 族契约测试（三轨并一轨 · S1 · G10）
 *
 * 背景：真机 MVU bundle 的变量初始化器 zn() 依赖整个 lorebook 族，而单间轨 iframe
 * **一个都没提供**（大堂轨有，单间轨无）：
 *
 *   | ST API                        | 大堂轨 sillyTavernPluginRuntime.ts | 单间轨 iframe |
 *   |---|---|---|
 *   | getCharLorebooks              | :1581 同步读桥缓存 + 惰性刷新       | ❌ 缺失 |
 *   | getCurrentCharPrimaryLorebook | :1599                              | ❌ 缺失 |
 *   | getLorebookEntries            | :1569                              | ❌ 缺失 |
 *   | getLorebookSettings           | （另有路径）                        | ❌ 缺失 |
 *   | setLorebookSettings           | —                                  | ❌ 缺失 |
 *
 * 真机 MVU 代码（backend/data/smart_card_assets/ 三份 bundle 一致）：
 *
 *   async function zn(e, t) {
 *     const n = t || await (async () => {
 *       const e = [...(await getLorebookSettings()).selected_global_lorebooks];   // ← 不在 try 内！
 *       try {
 *         const t = await getCharLorebooks();                                     // ← 被 await
 *         null !== t.primary && e.push(t.primary);
 *         null !== t.additional && e.push(...t.additional);
 *       } catch (e) { console.warn('primaryLorebookReadFailed', e) }
 *       return e;
 *     })();
 *     ...
 *     for (const t of n) if (!_.has(e.initialized_lorebooks, t)) {
 *       e.initialized_lorebooks[t] = [];
 *       const n = await getLorebookEntries(t);                                    // ← 要数组
 *       ...
 *     }
 *   }
 *
 * ⇒ 单间轨下 `await getLorebookSettings()` 直接 TypeError（且不在 try 内）⇒ 变量初始化整体失败。
 *   今天默认走大堂轨所以没事，**S3 把默认切到单间轨就会炸** —— 这是 S3 阻断项。
 *
 * ST 契约（本仓自带 st-plugins/third-party/JS-Slash-Runner-main/@types/function/）：
 *   getLorebookSettings(): LorebookSettings                    ← 同步
 *   setLorebookSettings(s: Partial<LorebookSettings>): void    ← 同步
 *   getCharLorebooks({name,type}?): CharLorebooks              ← 同步（但本帧内桥是异步的）
 *   getCurrentCharPrimaryLorebook(): string | null             ← 同步
 *   getLorebookEntries(lorebook: string): Promise<LorebookEntry[]>  ← 异步
 *
 * 口径：切真实函数体（`>>> S1-G10 ... BEGIN/END` 区域）+ new Function 执行 + 断言行为，
 * 不 grep 源码字符串（唯一例外是"是否注册"—— 缺口的定义就是"没注册"，见 A 组）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/lorebook-family-contract.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
// [S4 2026-10-15] 运行时体已按行拆到 runtime-body/part-01..08.ts，改为读拼接后的源码文本。
// vitest 固定以 frontend/ 为 cwd 运行（同 storage-isolation-contract.test.ts）
import { COMPAT_V2_RUNTIME_SOURCE as COMPAT_V2_SOURCE } from './compat-v2-runtime-source';

const BEGIN_MARKER = '>>> S1-G10 LOREBOOK FAMILY BEGIN';
const END_MARKER = '<<< S1-G10 LOREBOOK FAMILY END';

/** 切出 BEGIN/END 之间的真实源码区域（该区域自带闭包变量声明，可独立求值）。 */
function sliceRegion(src: string): string {
  const begin = src.indexOf(BEGIN_MARKER);
  expect(begin, `missing BEGIN marker: ${BEGIN_MARKER}`).toBeGreaterThan(-1);
  const end = src.indexOf(END_MARKER);
  expect(end, `missing END marker: ${END_MARKER}`).toBeGreaterThan(-1);
  expect(end, 'END marker must come after BEGIN').toBeGreaterThan(begin);
  const bodyStart = src.indexOf('\n', begin) + 1;
  const bodyEnd = src.lastIndexOf('\n', end);
  return src.slice(bodyStart, bodyEnd);
}

interface FrameOpts {
  parentResult?: any;
  parentThrows?: boolean;
  /** 按 action 分派返回（端到端用例需要 getCharWorldbook 与 getWorldbookEntries 给不同结果）。 */
  parentResultByAction?: Record<string, any>;
  /** 注入 legacy 段注册的 window.getWorldbookEntries（真机环境里它先注册、且能拿到真条目）。 */
  legacyWorldbookEntries?: (target?: any) => any;
  /** 第二次及以后 requestParent 的返回（测"只 kick 一次"用不到，保留扩展位）。 */
  parentResultLater?: any;
}

function buildFrame(opts: FrameOpts = {}) {
  const {
    parentResult = { success: true, name: '角色世界书' },
    parentThrows = false,
    parentResultByAction,
    parentResultLater,
  } = opts;
  let call = 0;
  const requestParent = vi.fn(async (action: string, _payload?: any) => {
    call += 1;
    if (parentThrows) throw new Error('parent rpc exploded');
    if (parentResultByAction && Object.prototype.hasOwnProperty.call(parentResultByAction, action)) {
      return parentResultByAction[action];
    }
    if (call > 1 && parentResultLater !== undefined) return parentResultLater;
    return parentResult;
  });
  const post = vi.fn((_msg: any) => undefined);
  // 镜像真实 ensureFunction 语义：仅在未注册时写入（后者不覆盖前者）。
  const registry: Record<string, any> = {};
  const ensureFunction = (name: string, fn: any) => {
    if (typeof registry[name] === 'undefined') registry[name] = fn;
  };
  const region = sliceRegion(COMPAT_V2_SOURCE);
  // 真机环境里帧内 window 已有 legacy 段注册的 getWorldbookEntries；测试按需注入。
  const win: any = {};
  if (opts.legacyWorldbookEntries) win.getWorldbookEntries = opts.legacyWorldbookEntries;
  const factory = new Function(
    'window', 'activeWorldbookName', 'requestParent', 'post', 'ensureFunction',
    region + '\nreturn {\n'
      + '  getCharLorebooksCompat: getCharLorebooksCompat,\n'
      + '  getCurrentCharPrimaryLorebookCompat: getCurrentCharPrimaryLorebookCompat,\n'
      + '  getLorebookSettingsCompat: getLorebookSettingsCompat,\n'
      + '  setLorebookSettingsCompat: setLorebookSettingsCompat,\n'
      + '  getLorebookEntriesCompat: getLorebookEntriesCompat,\n'
      + '};',
  );
  const api = factory(win, '', requestParent, post, ensureFunction);
  return { api, requestParent, post, registry, win };
}

// ============================================================
// A 注册契约：5 个 API 必须真的被注册进全局（行为断言，不 grep 源码）
// ============================================================
describe('A 注册契约 —— lorebook 族 5 个 API 必须被注册', () => {
  const names = [
    'getCharLorebooks',
    'getCurrentCharPrimaryLorebook',
    'getLorebookEntries',
    'getLorebookSettings',
    'setLorebookSettings',
  ];
  it.each(names)('[红→S1 转绿] %s 必须被注册', (name) => {
    const { registry } = buildFrame();
    expect(typeof registry[name]).toBe('function');
  });

  it('[红→S1 转绿] 注册的 getCharLorebooks 就是本区域实现（不是别处的空壳）', async () => {
    const { registry } = buildFrame();
    const books = await registry.getCharLorebooks();
    expect(books).toEqual({ primary: '角色世界书', additional: ['角色世界书'] });
  });
});

// ============================================================
// B MVU zn() 第一行：await getLorebookSettings() 不能抛错，且要有 selected_global_lorebooks
// ============================================================
describe('B getLorebookSettings —— zn() 的第一行，且不在 try 内', () => {
  it('[红→S1 转绿] 返回对象且 selected_global_lorebooks 是数组（不抛错）', () => {
    const { api } = buildFrame();
    const settings = api.getLorebookSettingsCompat();
    expect(typeof settings).toBe('object');
    expect(settings).not.toBeNull();
    expect(Array.isArray(settings.selected_global_lorebooks)).toBe(true);
  });

  it('[红→S1 转绿] 默认值覆盖真机 MVU 期望的 13 个字段（使它的归一化步骤成为 no-op）', () => {
    const { api } = buildFrame();
    const s = api.getLorebookSettingsCompat();
    // 真机原文（去敏）：MVU 用它和当前设置做 _.isEqual(_.merge({}, t, e), t) 比较
    expect(s).toMatchObject({
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
    });
  });

  it('[红→S1 转绿] setLorebookSettings 写入后可读回（合并语义，不整体覆盖）', () => {
    const { api } = buildFrame();
    api.setLorebookSettingsCompat({ scan_depth: 7, selected_global_lorebooks: ['全局书'] });
    const s = api.getLorebookSettingsCompat();
    expect(s.scan_depth).toBe(7);
    expect(s.selected_global_lorebooks).toEqual(['全局书']);
    // 未改的字段保持默认
    expect(s.context_percentage).toBe(100);
  });
});

// ============================================================
// C MVU zn() 第二段：await getCharLorebooks() 必须给出真名
// ============================================================
describe('C getCharLorebooks —— zn() 里被 await，必须拿到真世界书名', () => {
  it('[红→S1 转绿] 返回 Promise，await 后得到 { primary, additional }（形状对齐 T1 契约）', async () => {
    const { api } = buildFrame();
    const out = api.getCharLorebooksCompat();
    expect(typeof out.then).toBe('function');
    const books = await out;
    expect(typeof books).toBe('object');
    expect(books).not.toBeNull();
    expect(Array.isArray(books)).toBe(false);
    expect(books.primary).toBe('角色世界书');
    expect(Array.isArray(books.additional)).toBe(true);
  });

  it('[红→S1 转绿] 父侧无世界书时返回 { primary: null, additional: [] }（不是 undefined、不抛错）', async () => {
    const { api } = buildFrame({ parentResult: { success: true, name: '' } });
    const books = await api.getCharLorebooksCompat();
    expect(books).toEqual({ primary: null, additional: [] });
  });

  it('[红→S1 转绿] 父侧 RPC 抛错时降级为空绑定并留痕（不把异常抛给卡脚本）', async () => {
    const { api, post } = buildFrame({ parentThrows: true });
    const books = await api.getCharLorebooksCompat();
    expect(books).toEqual({ primary: null, additional: [] });
    expect(post).toHaveBeenCalled();
  });

  it('[红→S1 转绿] 父侧返回 success:false 时降级为空绑定', async () => {
    const { api } = buildFrame({ parentResult: { success: false } });
    const books = await api.getCharLorebooksCompat();
    expect(books).toEqual({ primary: null, additional: [] });
  });

  it('[红→S1 转绿] 非 current 的按名查询不冒充当前卡（返回空绑定，不误报别人的书）', async () => {
    const { api } = buildFrame();
    const books = await api.getCharLorebooksCompat({ name: '别的角色' });
    expect(books).toEqual({ primary: null, additional: [] });
  });
});

// ============================================================
// D 同步 API：getCurrentCharPrimaryLorebook（ST 声明 string|null）
// ============================================================
describe('D getCurrentCharPrimaryLorebook —— 同步、string|null、不抛错', () => {
  it('[红→S1 转绿] 冷缓存时返回 null（不是 undefined、不抛错），并 kick 一次自热', () => {
    const { api, requestParent } = buildFrame();
    const out = api.getCurrentCharPrimaryLorebookCompat();
    expect(out).toBeNull();
    expect(requestParent).toHaveBeenCalledTimes(1);
  });

  it('[红→S1 转绿] 自热完成后同步读到真名', async () => {
    const { api } = buildFrame();
    api.getCurrentCharPrimaryLorebookCompat();       // kick
    await new Promise((resolve) => setTimeout(resolve, 0));   // 让 .then 落地
    expect(api.getCurrentCharPrimaryLorebookCompat()).toBe('角色世界书');
  });

  it('[红→S1 转绿] 自热只 kick 一次（防每次调用都发一轮 RPC）', () => {
    const { api, requestParent } = buildFrame();
    api.getCurrentCharPrimaryLorebookCompat();
    api.getCurrentCharPrimaryLorebookCompat();
    api.getCurrentCharPrimaryLorebookCompat();
    expect(requestParent).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// E getLorebookEntries：zn() 里 for...of 的对象，必须是数组
// ============================================================
describe('E getLorebookEntries —— 必须给数组（zn() 直接 for...of）', () => {
  it('[红→S1 转绿] 优先复用 legacy 的 getWorldbookEntries（真机实测只有它能拿到条目）', async () => {
    const legacy = vi.fn(async () => [{ comment: '[InitVar]', content: 'x' }]);
    const { api, requestParent } = buildFrame({ legacyWorldbookEntries: legacy });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(entries).toHaveLength(1);
    expect(legacy).toHaveBeenCalledWith('角色世界书');
    expect(requestParent).not.toHaveBeenCalled();
  });

  it('[红→S1 转绿] legacy 返回空时回退到 RPC（两条路都要试，不能因一条空就放弃）', async () => {
    const legacy = vi.fn(async () => []);
    const { api, requestParent } = buildFrame({
      legacyWorldbookEntries: legacy,
      parentResult: [{ comment: 'a' }],
    });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(entries).toHaveLength(1);
    expect(requestParent).toHaveBeenCalled();
  });

  it('[红→S1 转绿] 父侧返回数组时原样透传', async () => {
    const { api } = buildFrame({ parentResult: [{ comment: '[InitVar]', content: 'x' }] });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('[红→S1 转绿] 父侧返回 { entries: [...] } 时取 entries', async () => {
    const { api } = buildFrame({ parentResult: { entries: [{ comment: 'a' }, { comment: 'b' }] } });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);
  });

  it('[红→S1 转绿] v2 requestParent 把数组展开进 {ok:true,...} 时也能还原（真机实测形状）', async () => {
    // SillyTavernCompatRuntime.ts:4659 的 v2 requestParent：
    //   data.ok ? { ok: true, ...(data.result ?? {...}) } : {...}
    // ⇒ 数组被展开成普通对象：Array.isArray=false、.entries 不存在，
    //   而且**没有 length**（数组的 length 是不可枚举自有属性，展开不复制）。
    // ⚠️ 这个形状是真机实测出来的；早先按"有 length"写的实现与测试都通过、
    //    真机却仍返回 [] —— 教训：桩必须照抄真机形状，不能照抄自己的假设。
    const { api } = buildFrame({
      parentResult: { ok: true, 0: { comment: 'a' }, 1: { comment: 'b' } },
    });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries[0].comment).toBe('a');
    expect(entries[1].comment).toBe('b');
  });

  it('[红→S1 转绿] 无下标键的展开对象返回 []（不能造出伪数组）', async () => {
    const { api } = buildFrame({ parentResult: { ok: true, success: true } });
    expect(await api.getLorebookEntriesCompat('角色世界书')).toEqual([]);
  });

  it('[红→S1 转绿] 父侧返回非数组时降级为 []（不能让 zn() 的 for...of 崩）', async () => {
    const { api } = buildFrame({ parentResult: { success: true } });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(entries).toEqual([]);
  });

  it('[红→S1 转绿] 父侧 RPC 抛错时降级为 [] 并留痕', async () => {
    const { api, post } = buildFrame({ parentThrows: true });
    const entries = await api.getLorebookEntriesCompat('角色世界书');
    expect(entries).toEqual([]);
    expect(post).toHaveBeenCalled();
  });
});

// ============================================================
// F 端到端：按真机 zn() 的调用顺序走一遍，必须拿到真名且不抛错
// ============================================================
describe('F 端到端 —— 复现真机 MVU zn() 的调用顺序', () => {
  it('[红→S1 转绿] settings → charLorebooks → lorebookEntries 全链路可得，名字进 initialized_lorebooks', async () => {
    const { api } = buildFrame({
      parentResultByAction: {
        getCharWorldbook: { success: true, name: '角色世界书' },
        getWorldbookEntries: [{ comment: '[InitVar]变量初始化', content: 'stat_data: {}' }],
      },
    });
    // 逐行对齐真机 zn() 的依赖顺序
    const settings = api.getLorebookSettingsCompat();
    const names: string[] = [...settings.selected_global_lorebooks];

    const books = await api.getCharLorebooksCompat();
    if (books.primary !== null) names.push(books.primary);
    if (books.additional !== null) names.push(...books.additional);

    const initializedLorebooks: Record<string, any[]> = {};
    for (const t of names) {
      if (!Object.prototype.hasOwnProperty.call(initializedLorebooks, t)) {
        initializedLorebooks[t] = [];
        const entries = await api.getLorebookEntriesCompat(t);
        for (const entry of entries) {
          if (String(entry && entry.comment).toLowerCase().includes('[initvar]')) {
            initializedLorebooks[t].push(entry);
          }
        }
      }
    }

    // 关键：真名进了键集合，而不是只有 'unknown'
    expect(Object.keys(initializedLorebooks)).toContain('角色世界书');
    expect(initializedLorebooks['角色世界书']).toHaveLength(1);
  });
});
