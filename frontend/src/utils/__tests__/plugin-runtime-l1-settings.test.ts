/*
 * 经典轨「设置 facade + 缺口可见化」行为守卫（2026-10-04）
 *
 * 依据 docs/SPEC_插件设置按卡隔离适配_2026-10-04.md 批次 0 / 批次 1。
 *
 * 为什么写这个文件的三条事实（都是实测，不是推断）：
 *   1. 插件声明的 SillyTavern facade 有 114 个成员，经典轨此前只挂 7 个，
 *      **没有一个是设置类**。实装卡脚本（MVU）靠 SillyTavern.extensionSettings
 *      读写自己的设置，缺失时 lodash 对 undefined 静默 no-op —— 设置改完刷新即丢。
 *   2. window.TavernHelper 命名空间在经典轨**完全没有**，且没有 Proxy 兜底，
 *      未实现的 API 是裸 undefined 且不进 __palinkCompatStats（缺口不可见）。
 *   3. setup 脚本模板内曾**裸调 recordStubHit**（它是模块 import，注入脚本里
 *      不存在该名字）→ 每次 registerSlashCommand 都抛 ReferenceError。
 *
 * 口径（SOP §七）：**调真实函数、断言行为**，不 grep 源码字符串。
 *   做法：把生成的 setup 脚本文本用 new Function 真正执行一遍，
 *   然后断言执行后 window 上挂出来的东西表现正确。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { SillyTavernPluginRuntime } from '../sillyTavernPluginRuntime';
import { resetCompatStubStats } from '@/lib/plugin-system/compat-stub-registry';

const SETUP_ID = '__palink_runtime_setup__';

/** 按卡设置落盘用的角色 uuid；切卡场景会改它 */
let runtimeConfigSeed: Record<string, unknown> = { card: 'cardA' };
/** 记录发往 /runtime/settings 的请求体，供落盘断言 */
const postedBodies: string[] = [];
/** 下一次 /runtime/settings 的响应（模拟后端 skipped） */
let nextSaveResponse: any = { ok: true, written: 1, removed: 0, skipped: [] };

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts?: any) => {
      const u = String(url);
      if (u.includes('/api/plugins/runtime/config')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ plugins: [], extension_settings: { tavern_helper: { ...runtimeConfigSeed } } }),
          text: async () => '[]',
          clone() { return this; },
        };
      }
      if (u.includes('/api/plugins/runtime/settings')) {
        if (typeof opts?.body === 'string') postedBodies.push(opts.body);
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => nextSaveResponse,
          text: async () => JSON.stringify(nextSaveResponse),
          clone() { return this; },
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => [],
        text: async () => '[]',
        clone() {
          return this;
        },
      };
    }),
  );
});

beforeEach(() => {
  resetCompatStubStats();
  delete (window as any).TavernHelper;
  delete (window as any).chat_metadata;
  delete (window as any).builtin;
  delete (window as any).__palinkCompatStats;
  delete (window as any).SillyTavern;
});

/** 取出注入生成的 setup 脚本并**真正执行**（jsdom 不会自动跑 appendChild 进去的 script） */
function runSetupScript(container: HTMLElement, which: 'first' | 'last' = 'first') {
  const els = Array.from(container.querySelectorAll('script[data-palink-st-plugin-id]')).filter(
    (n) => n.getAttribute('data-palink-st-plugin-id') === SETUP_ID,
  );
  const el = which === 'last' ? els[els.length - 1] : els[0];
  const text = el && typeof el.textContent === 'string' ? el.textContent : null;
  expect(text, 'setup 脚本没被注入，所有断言都失去意义').toBeTruthy();
  new Function(text as string)();
}

/** 注入并**真正执行** setup 脚本，返回 runtime 实例 */
function injectAndRun() {
  const runtime = new SillyTavernPluginRuntime();
  (runtime as any).config = { plugins: [] } as any;
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime.injectIntoContainer(container);

  runSetupScript(container);
  return runtime;
}

const W = () => window as unknown as Record<string, any>;

describe('批次 0 · 缺口可见化', () => {
  it('① 生成的 setup 脚本必须可解析（模板字符串反斜杠/反引号守卫）', () => {
    // 回归本体：模板里再写反引号（会提前终止模板）或丢反斜杠的正则 → 这里红。
    expect(() => injectAndRun()).not.toThrow();
  });

  it('② registerSlashCommand 调用不抛错（原为裸调 recordStubHit → ReferenceError）', () => {
    injectAndRun();
    const fn = W().registerSlashCommand;
    expect(typeof fn).toBe('function');
    // 这是本轮修掉的 bug 的直接守卫：修之前这一行会抛 ReferenceError。
    expect(() => fn('/test', () => {}, [], 'help')).not.toThrow();
  });

  it('③ registerSlashCommand 的降级被真正登记进 __palinkCompatStats', () => {
    injectAndRun();
    W().registerSlashCommand('/x', () => {});
    const stats = W().__palinkCompatStats;
    expect(stats, '降级统计对象应存在').toBeTruthy();
    expect(stats.get('registerSlashCommand')?.count).toBe(1);
  });

  it('④ window.TavernHelper 命名空间被挂上', () => {
    injectAndRun();
    expect(W().TavernHelper).toBeTruthy();
    expect(typeof W().TavernHelper).toBe('object');
  });

  it('⑤ TavernHelper 未实现的 API 返回函数（不是裸 undefined）', () => {
    injectAndRun();
    // 插件的 typeof 守卫不该把它当缺失而跳过整段逻辑
    expect(typeof W().TavernHelper.thisApiDoesNotExist).toBe('function');
  });

  it('⑥ 调用未实现的 TavernHelper API → 登记进降级统计（缺口可见）', () => {
    injectAndRun();
    const before = W().__palinkCompatStats?.get('TavernHelper.notExist')?.count ?? 0;
    W().TavernHelper.notExist();
    const after = W().__palinkCompatStats?.get('TavernHelper.notExist')?.count ?? 0;
    expect(after).toBe(before + 1);
  });

  it('⑦ TavernHelper 已实现的 API 转发到同名 window 全局（同一引用）', () => {
    injectAndRun();
    expect(typeof W().getChatMessages).toBe('function');
    expect(W().TavernHelper.getChatMessages).toBe(W().getChatMessages);
  });

  it('⑧ has trap 不骗人：in 只对真能取到的名字返回 true', () => {
    injectAndRun();
    expect('getChatMessages' in W().TavernHelper).toBe(true);
    expect('thisApiDoesNotExist' in W().TavernHelper).toBe(false);
  });

  it('⑨ Symbol / then / constructor 不返回假函数（不污染 await 与序列化）', () => {
    injectAndRun();
    const th = W().TavernHelper;
    expect(th[Symbol.iterator]).toBeUndefined();
    expect(th.then).toBeUndefined();
    expect(th.constructor).toBeUndefined();
  });

  it('⑩ 记桩函数按名字缓存：同名取两次必须是同一个引用', () => {
    injectAndRun();
    const th = W().TavernHelper;
    expect(th.someMissingApi).toBe(th.someMissingApi);
  });
});

describe('批次 1 · L1 设置 facade', () => {
  it('① SillyTavern.extensionSettings 存在且是对象', () => {
    injectAndRun();
    expect(W().SillyTavern).toBeTruthy();
    expect(W().SillyTavern.extensionSettings).toBeTruthy();
    expect(typeof W().SillyTavern.extensionSettings).toBe('object');
  });

  it('② extensionSettings 与 getExtensionSettings() 是**同一引用**（拷贝就白做了）', () => {
    const runtime = injectAndRun();
    // 插件是「原地改 + 事后落盘」（_.set → saveSettingsDebounced）。
    // 拷一份出去等于永远写不回去 —— 这条是本批最容易做错的地方。
    expect(W().SillyTavern.extensionSettings).toBe(runtime.getExtensionSettings());
  });

  it('③ 原地改 extensionSettings 后，经 getExtensionSettings() 能读回来', () => {
    const runtime = injectAndRun();
    W().SillyTavern.extensionSettings.mvu_settings = { 好感度: 42 };
    expect(runtime.getExtensionSettings().mvu_settings).toEqual({ 好感度: 42 });
  });

  it('④ SillyTavern.saveSettingsDebounced 是函数且不抛错', () => {
    injectAndRun();
    expect(typeof W().SillyTavern.saveSettingsDebounced).toBe('function');
    expect(() => W().SillyTavern.saveSettingsDebounced()).not.toThrow();
  });

  it('⑤ chat_metadata 与 SillyTavern.chatMetadata 是同一对象', () => {
    injectAndRun();
    expect(W().chat_metadata).toBeTruthy();
    expect(W().SillyTavern.chatMetadata).toBe(W().chat_metadata);
  });

  it('⑥ 原地改 chat_metadata 后，经 SillyTavern.chatMetadata 能读回来', () => {
    injectAndRun();
    W().chat_metadata.tavern_helper = { bgm: [] };
    expect(W().SillyTavern.chatMetadata.tavern_helper).toEqual({ bgm: [] });
  });

  it('⑦ 元数据落盘未接通时是**可见**降级（登记而非静默 no-op）', async () => {
    injectAndRun();
    await W().SillyTavern.saveMetadata();
    const stats = W().__palinkCompatStats;
    const hit = stats?.get('SillyTavern.saveMetadata');
    expect(hit?.count, 'saveMetadata 应登记一次降级，让「改了没保存」可见').toBe(1);
    expect(String(hit?.lastDetail)).toContain('仅本次会话有效');
  });
});

describe('端到端：模拟实装卡脚本（MVU）的真实调用序列', () => {
  /**
   * 这一段直接对应用户最关心的那件事：
   * 「插件能否通过这层兼容层，把它的功能跑起来」。
   *
   * 卡脚本原文（0c646fb3….js / d2245aa5….js，字节流可直接 grep 到）：
   *   const t = ref(parse(_.get(SillyTavern.extensionSettings,'mvu_settings',{})));
   *   watch(t, e => {
   *     _.set(SillyTavern.extensionSettings,'mvu_settings', toRaw(e));
   *     if (!It) SillyTavern.saveSettingsDebounced();
   *   }, { deep:true });
   *
   * 所以这里不测「函数存不存在」，而是**照抄这段调用序列**跑一遍，
   * 断言「改了能被读回来」+「落盘真的被触发」。
   */
  it('MVU 式读写：写入后能原样读回来（设置不再刷新即丢的前提）', () => {
    const runtime = injectAndRun();
    const settings = W().SillyTavern.extensionSettings;

    // _.get(SillyTavern.extensionSettings,'mvu_settings',{})
    const before = settings.mvu_settings ?? {};
    expect(before).toEqual({});

    // _.set(SillyTavern.extensionSettings,'mvu_settings', v)
    const next = { 好感度: 88, 环境: { 地点: '教室' } };
    settings.mvu_settings = next;

    // 再读一次 —— 必须能拿到刚写的值
    expect(W().SillyTavern.extensionSettings.mvu_settings).toEqual(next);
    // 且后端侧（runtime.getExtensionSettings）看得到同一份
    expect(runtime.getExtensionSettings().mvu_settings).toEqual(next);
  });

  it('MVU 式落盘：saveSettingsDebounced 真的触发了后端保存（不是打空号）', async () => {
    const runtime = injectAndRun();
    const spy = vi.spyOn(runtime, 'saveExtensionSettings');

    W().SillyTavern.extensionSettings.mvu_settings = { 好感度: 1 };
    W().SillyTavern.saveSettingsDebounced();

    // 这条是本轮修的 404 死路径的直接守卫：
    // 修之前 saveSettingsDebounced 存在也会走通，但打的是不存在的端点。
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('嵌套写入（_.set 风格）同样生效：extensionSettings 是活对象不是快照', () => {
    const runtime = injectAndRun();
    const settings = W().SillyTavern.extensionSettings;
    if (!settings.mvu_settings) settings.mvu_settings = {};
    settings.mvu_settings.嵌套 = { 深: { 值: 1 } };
    expect(runtime.getExtensionSettings().mvu_settings.嵌套.深.值).toBe(1);
  });
});

describe('批次 1 · 只读项（A1/A3/A4/A5/A6）', () => {
  it('getLorebookEntries 是函数（别名到已有 getWorldbook）', () => {
    injectAndRun();
    expect(typeof W().getLorebookEntries).toBe('function');
  });

  it('getCharLorebooks 是函数，且无数据时返回安全空结构（不抛错）', () => {
    injectAndRun();
    expect(typeof W().getCharLorebooks).toBe('function');
    const books = W().getCharLorebooks();
    expect(books).toHaveProperty('primary');
    expect(Array.isArray(books.additional)).toBe(true);
  });

  it('getCurrentCharPrimaryLorebook 无数据时返回 null（不是 undefined 也不是抛错）', () => {
    injectAndRun();
    expect(W().getCurrentCharPrimaryLorebook()).toBeNull();
  });

  it('getPresetNames 是函数且返回数组', () => {
    injectAndRun();
    expect(typeof W().getPresetNames).toBe('function');
    expect(Array.isArray(W().getPresetNames())).toBe(true);
  });

  it('builtin.saveSettings 是函数（MVU 真实调用点）', () => {
    injectAndRun();
    expect(typeof W().builtin.saveSettings).toBe('function');
    expect(() => W().builtin.saveSettings()).not.toThrow();
  });

  it('builtin.uuidv4 返回合法 UUID', () => {
    injectAndRun();
    const id = W().builtin.uuidv4();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('builtin 未实现成员返回函数且不抛错（保持 typeof 守卫可过）', () => {
    injectAndRun();
    expect(typeof W().builtin.renderMarkdown).toBe('function');
    expect(() => W().builtin.renderMarkdown('# x')).not.toThrow();
  });
});

/*
 * ── 以下两组是 2026-10-04 独立复核后补的 ────────────────────────────────
 * 复核发现上一批的实现有两个洞，而它自己的 27 例都测不到：
 *
 *   ① 设置挂载用了「已存在就不覆盖」的守卫。切角色卡时 loadRuntimeConfig 会把
 *      runtime 那份整个换成新对象，facade 却还攥着上一张卡的旧对象 ——
 *      插件写进旧对象、落盘发的是新对象，**写入永远进不了请求**，
 *      且 B 卡的插件读到 A 卡的值（跨卡串味）。
 *      为什么原测试测不到：每一例都只注入一次，从没走过「切卡再注入」这一步。
 *   ② 落盘的失败/部分失败只打在 console.error，插件侧 saveSettingsDebounced 是
 *      fire-and-forget，永远不会自己发现 —— 「不静默丢数据」只在测试里成立。
 */
describe('切卡时序（复核修复：facade 不得停在旧对象）', () => {
  beforeEach(() => {
    postedBodies.length = 0;
    runtimeConfigSeed = { card: 'cardA' };
    nextSaveResponse = { ok: true, written: 1, removed: 0, skipped: [] };
  });

  /** 走真实路径：loadRuntimeConfig（真发请求）→ injectIntoContainer → 执行 setup 脚本 */
  async function firstInject(runtime: SillyTavernPluginRuntime, container: HTMLElement, charId: string) {
    runtime.setContext({ characterUuid: charId } as any);
    await runtime.loadRuntimeConfig(charId);
    runtime.injectIntoContainer(container);
    runSetupScript(container, 'last');
  }

  it('切卡后 SillyTavern.extensionSettings 必须仍与 runtime 当前那份同一引用', async () => {
    const runtime = new SillyTavernPluginRuntime();
    const container = document.createElement('div');
    document.body.appendChild(container);

    await firstInject(runtime, container, 'card-a');
    expect(W().SillyTavern.extensionSettings.tavern_helper).toEqual({ card: 'cardA' });

    // 切到 B 卡：CharacterChat 的真实序列 = 重新拉配置 + 同容器差集重注入
    runtimeConfigSeed = { card: 'cardB' };
    await firstInject(runtime, container, 'card-b');

    expect(W().SillyTavern.extensionSettings).toBe(runtime.getExtensionSettings());
    // 并且 B 卡的插件看到的是 B 卡下发的配置，而不是 A 卡的残留
    expect(W().SillyTavern.extensionSettings.tavern_helper).toEqual({ card: 'cardB' });
  });

  it('切卡后插件写入的值必须真的出现在落盘请求体里', async () => {
    const runtime = new SillyTavernPluginRuntime();
    const container = document.createElement('div');
    document.body.appendChild(container);

    await firstInject(runtime, container, 'card-a');
    await firstInject(runtime, container, 'card-b');

    // MVU 的真实动作：原地改 facade → saveSettingsDebounced()
    W().SillyTavern.extensionSettings.mvu_settings = { 好感度: 77 };
    W().SillyTavern.saveSettingsDebounced();
    await new Promise((r) => setTimeout(r, 0));

    expect(postedBodies.length, '应发出一次落盘请求').toBe(1);
    const body = JSON.parse(postedBodies[0]);
    expect(body.extension_settings.mvu_settings).toEqual({ 好感度: 77 });
    expect(body.character_id, '落盘必须带作用域，否则会跨卡渗漏').toBe('card-b');
  });
});

describe('落盘结果的可见性（复核修复：不许静默丢）', () => {
  beforeEach(() => {
    postedBodies.length = 0;
    runtimeConfigSeed = { card: 'cardA' };
    nextSaveResponse = { ok: true, written: 1, removed: 0, skipped: [] };
  });

  it('后端把某项列入 skipped → 登记进降级统计（插件侧可见）', async () => {
    nextSaveResponse = { ok: true, written: 1, removed: 0, skipped: ['big_ext'] };
    const runtime = new SillyTavernPluginRuntime();
    runtime.setContext({ characterUuid: 'card-a' } as any);
    expect(await runtime.saveExtensionSettings()).toBeUndefined();

    const hit = W().__palinkCompatStats?.get('saveSettingsDebounced:big_ext');
    expect(hit?.count, '未落库的命名空间应登记一次降级').toBe(1);
    expect(String(hit?.lastDetail)).toContain('未落库');
  });

  it('取不到角色 id 时不发请求，且登记可见降级', async () => {
    const runtime = new SillyTavernPluginRuntime();
    await runtime.saveExtensionSettings();

    expect(postedBodies.length, '没有作用域就不该写').toBe(0);
    const hit = W().__palinkCompatStats?.get('saveSettingsDebounced');
    expect(hit?.count, '应登记「未落库」而非静默返回').toBe(1);
    expect(String(hit?.lastDetail)).toContain('角色卡');
  });

  it('请求失败时登记降级（不再只打一行 console.error）', async () => {
    const runtime = new SillyTavernPluginRuntime();
    runtime.setContext({ characterUuid: 'card-a' } as any);
    vi.spyOn(runtime as any, 'getExtensionSettings').mockReturnValue({ x: 1 });
    const origPost = (await import('@/services/api')).api.post;
    vi.spyOn((await import('@/services/api')).api, 'post').mockRejectedValue(new Error('network down'));

    await runtime.saveExtensionSettings();

    const hit = W().__palinkCompatStats?.get('saveSettingsDebounced');
    expect(hit?.count, '落盘失败必须登记').toBe(1);
    expect(String(hit?.lastDetail)).toContain('network down');
    vi.restoreAllMocks();
    void origPost;
  });
});

/*
 * ── L2 生成参数「放，但封顶」（2026-10-04 用户裁定）──────────────────────
 * 实装卡脚本缺 SillyTavern.chatCompletionSettings 时是直接 throw
 * 'openAiSettingsUnavailable'（缺口清单 A4：MVU 的「额外模型解析」面板整块失效）。
 * 这里挂的是按卡设置里的**活子对象** —— 不开第二条落盘通道，插件改完仍走
 * saveSettingsDebounced 落 (用户, 卡)。后端只消费 openai_max_context 一项，
 * 且必过闸 3（见 backend/tests/{test_ctx_hard_floor,test_l2_card_shadow}.py）。
 */
describe('批次 2 · L2 生成参数影子副本', () => {
  beforeEach(() => {
    postedBodies.length = 0;
    runtimeConfigSeed = { card: 'cardA' };
    nextSaveResponse = { ok: true, written: 1, removed: 0, skipped: [] };
  });

  it('chatCompletionSettings 挂上了（缺它时卡脚本当场抛错）', () => {
    injectAndRun();
    expect(W().SillyTavern.chatCompletionSettings).toBeTruthy();
    expect(typeof W().SillyTavern.chatCompletionSettings).toBe('object');
  });

  it('它是 extensionSettings 的**活子对象**（拷贝的话改了也白改）', () => {
    injectAndRun();
    const st = W().SillyTavern;
    expect(st.chatCompletionSettings).toBe(st.extensionSettings.chatCompletionSettings);
    st.chatCompletionSettings.openai_max_context = 16384;
    expect(st.extensionSettings.chatCompletionSettings.openai_max_context).toBe(16384);
  });

  it('写生成参数 → 落盘 body 带上它，且带这张卡的作用域', async () => {
    const runtime = new SillyTavernPluginRuntime();
    const container = document.createElement('div');
    document.body.appendChild(container);
    runtime.setContext({ characterUuid: 'card-z' } as any);
    (runtime as any).config = { plugins: [] } as any;
    runtime.injectIntoContainer(container);
    runSetupScript(container);

    W().SillyTavern.chatCompletionSettings.openai_max_context = 999999;
    await runtime.saveExtensionSettings();

    expect(postedBodies.length).toBe(1);
    const body = JSON.parse(postedBodies[0]);
    expect(body.character_id).toBe('card-z');
    expect(body.extension_settings.chatCompletionSettings.openai_max_context).toBe(999999);
    // 封顶发生在后端闸 3，不在这里 —— 前端不假装夹（夹了插件会读到被改过的值，反而更困惑）
  });

  it('写 custom_include_body → 记账说明它不生效（不静默）', async () => {
    const runtime = new SillyTavernPluginRuntime();
    const container = document.createElement('div');
    document.body.appendChild(container);
    runtime.setContext({ characterUuid: 'card-z' } as any);
    (runtime as any).config = { plugins: [] } as any;
    runtime.injectIntoContainer(container);
    runSetupScript(container);

    W().SillyTavern.chatCompletionSettings.custom_include_body = { whatever: true };
    await runtime.saveExtensionSettings();

    const hit = W().__palinkCompatStats?.get('chatCompletionSettings.custom_include_body');
    expect(hit?.count, '"往请求里塞任意字段"未开放，必须登记').toBe(1);
    expect(String(hit?.lastDetail)).toContain('不会进上游模型请求');
  });

  it('切卡后影子跟着换卡：不把上一张卡的参数残留给新卡', async () => {
    const runtime = new SillyTavernPluginRuntime();
    const container = document.createElement('div');
    document.body.appendChild(container);

    runtime.setContext({ characterUuid: 'card-a' } as any);
    await runtime.loadRuntimeConfig('card-a');
    runtime.injectIntoContainer(container);
    runSetupScript(container, 'last');
    W().SillyTavern.chatCompletionSettings.openai_max_context = 16384;

    runtime.setContext({ characterUuid: 'card-b' } as any);
    await runtime.loadRuntimeConfig('card-b');
    runtime.injectIntoContainer(container, { diffOnly: true });
    runSetupScript(container, 'last');

    expect(W().SillyTavern.chatCompletionSettings.openai_max_context,
      'A 卡写的生成参数不应出现在 B 卡').toBeUndefined();
    expect(W().SillyTavern.chatCompletionSettings)
      .toBe(W().SillyTavern.extensionSettings.chatCompletionSettings);
  });
});

/*
 * ── A 半桶里"实卡真在调用"的两条（2026-10-04 逐个数过命中数）──────────────
 *   saveChat ×8、getPreset ×5。其余（人设 / 角色增删改 / 预设增删改 / importRaw）
 *   在现有 4 个缓存脚本里命中 **0** —— 不接，接了是给不存在的用户写代码。
 */
describe('A 半桶 · saveChat 与 getPreset', () => {
  it('saveChat 不再静默谎报成功：调用会登记说明', async () => {
    injectAndRun();
    await W().SillyTavern.saveChat();
    const hit = W().__palinkCompatStats?.get('SillyTavern.saveChat');
    expect(hit?.count, '聊天在 setChatMessages 时就已落库，本调用无需再存 —— 必须说明而非假装').toBe(1);
    expect(String(hit?.lastDetail)).toContain('不是失败');
  });

  it('saveChat 仍返回已 resolve 的 promise（MVU 的 debounce 链不能被断）', async () => {
    injectAndRun();
    const p = W().SillyTavern.saveChat();
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
  });

  it('getPreset 是函数，无数据时返回 null 而非抛错', () => {
    injectAndRun();
    expect(typeof W().getPreset).toBe('function');
    expect(W().getPreset('不存在的那份')).toBeNull();
  });
});
