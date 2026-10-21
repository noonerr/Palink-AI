/*
 * ST 插件 import 变换 vs wrapper 参数表 撞名防御（2026-10-14，S3 补测事故常驻守卫）
 *
 * 背景：兼容 runtime 把插件源码的 `import { eventSource } from '.../script.js'` 变换为
 * `const eventSource = window.__palinkStModuleImport(...)`，再套进
 * `async function(window,document,SillyTavern,getContext,extension_settings,TavernHelper,eventSource){...}`
 * 执行 —— 同一作用域 const 与参数同名 ⇒ SyntaxError ⇒ 整段插件静默死亡。
 * 2026-10-14 补测实测：5/5 真实插件（quick-reply/translate/token-counter/memory/regex）
 * 全部死于此；且「已执行」标记在注入前设置、st_plugin_script_executed 诊断注入后无条件发，
 * 表面全绿，只有斜杠命令 0 条/挂载容器不存在/触发器返空串才暴露。
 *
 * 修法（ES module 语义：import 绑定是词法绑定，遮蔽同名全局）：与 wrapper 参数表同名的
 * 本地名改为**对参数赋值**而非 const 声明。本文件钉住：
 *   1. 镜像常量 ST_PLUGIN_WRAPPER_PARAMS_* 与真实 wrapper 参数表一致（改参数表忘同步会红）；
 *   2. 5 个真实插件入口 + 所有 import ST 核心的本地模块，经「真变换+真参数表」后可解析；
 *   3. import 绑定覆盖参数注入的全局（语义正确性，不只是不炸）；
 *   4. 经典脚本（无 import）仍拿到参数注入的全局（不能把老路径修坏）；
 *   5. module 模式（本地子模块，wrapper 多 exports/module 两参数）同样不撞名。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-plugin-import-wrapper-collision.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// st-plugins 在仓库根（本文件位于 frontend/src/components/ui/custom/smart-card-runtime/__tests__/）
const PLUGINS_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', 'st-plugins');

const SHIM_OPTS = {
  context: { characterId: 'collision-char', language: 'zh' },
  frameId: 'collision-frame-0001',
  sourceHtml: '<div></div>',
  mode: 'inline',
} as any;

/** 取兼容运行时**运行时体**（无 <script> 外壳）——正是注入 iframe 的那段。 */
function runtimeBody(): string {
  const shim = buildSillyTavernCompatRuntimeV2Shim(SHIM_OPTS);
  const blocks = [...String(shim).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const body = blocks.sort((a, b) => b.length - a.length)[0] || '';
  expect(body.length, '运行时体为空').toBeGreaterThan(1000);
  return body;
}

/** 抽出可在 vm 里独立执行的 transform 集群（含它依赖的两个 const）。 */
function extractTransformCluster(): string {
  const body = runtimeBody();
  const bs = body.indexOf('const regexBackslashCompat = String.fromCharCode(92);');
  const nl = body.indexOf('const newlineCompat = String.fromCharCode(10);');
  expect(bs, '找不到 regexBackslashCompat 定义').toBeGreaterThanOrEqual(0);
  expect(nl, '找不到 newlineCompat 定义').toBeGreaterThan(bs);
  const start = body.indexOf('const parseStImportClauseCompat = (clause) => {');
  const end = body.indexOf('const executeStPluginScriptsCompat = () => {');
  expect(start, '找不到 transform 集群起点').toBeGreaterThan(nl);
  expect(end, '找不到 transform 集群终点').toBeGreaterThan(start);
  const nlLineEnd = body.indexOf('\n', nl);
  return body.slice(bs, nlLineEnd) + '\n' + body.slice(start, end);
}

/** 从生成文本抽**真实** wrapper 参数表（不写字面量，改了 runtime 这边跟着变）。 */
function extractWrapperParams(mode: 'entry' | 'module'): string[] {
  const body = runtimeBody();
  const re = mode === 'entry'
    ? /await \(async function\(([^)]*)\)\{/g
    : /\(function\(([^)]*)\)\{/g;
  const found: string[][] = [];
  for (const m of body.matchAll(re)) {
    found.push(m[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  // [S3-ACCEPTANCE-GAP 二层修复后] 入口与本地模块统一为同一张九参数表
  // （经典 ST 全局七件套 + exports/module 模块收集中间件）。
  const picked = found.find((ps) => ps.includes('eventSource') && ps.includes('exports') && ps.includes('module'));
  expect(picked, `生成文本里找不到 ${mode} 模式 wrapper 参数表`).toBeTruthy();
  return picked as string[];
}

/** 从生成文本抽镜像常量（防止手写 literals 与产品脱节）。 */
function extractMirrorParams(mode: 'entry' | 'module'): string[] {
  const body = runtimeBody();
  const baseMatch = body.match(/const ST_PLUGIN_WRAPPER_PARAMS_BASE = \[([^\]]*)\]/);
  expect(baseMatch, '生成文本里找不到镜像常量 ST_PLUGIN_WRAPPER_PARAMS_BASE').toBeTruthy();
  const base = (baseMatch as RegExpMatchArray)[1]
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  if (mode === 'entry') return base;
  // MODULE = BASE.concat(['exports', 'module']) —— 抓 concat 实参再拼接
  const modMatch = body.match(/const ST_PLUGIN_WRAPPER_PARAMS_MODULE = ST_PLUGIN_WRAPPER_PARAMS_BASE\.concat\(\[([^\]]*)\]\)/);
  expect(modMatch, '生成文本里找不到 ST_PLUGIN_WRAPPER_PARAMS_MODULE 的 concat 定义').toBeTruthy();
  const extras = (modMatch as RegExpMatchArray)[1]
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  return [...base, ...extras];
}

function makeSandbox() {
  const importedLog: Array<[string, string]> = [];
  const sandbox: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {},
    __exp: { __kind: 'exports-holder' },
    __mod: { __kind: 'module-holder' },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__palinkStModuleImport = (mod: string, what: string) => {
    importedLog.push([mod, what]);
    return { __kind: 'import', __imported: what, __from: mod };
  };
  sandbox.__palinkStModuleNamespace = () => ({ __kind: 'namespace' });
  (sandbox.window as Record<string, unknown>).__palinkStModuleImport = sandbox.__palinkStModuleImport;
  (sandbox.window as Record<string, unknown>).__palinkStModuleNamespace = sandbox.__palinkStModuleNamespace;
  // wrapper 参数注入的「全局」——与真实 runtime 传参同形的占位对象
  const w = sandbox.window as Record<string, unknown>;
  w.SillyTavern = { __kind: 'param' };
  w.getContext = { __kind: 'param' };
  w.extension_settings = { __kind: 'param' };
  w.TavernHelper = { __kind: 'param' };
  w.eventSource = { __kind: 'param' };
  return { sandbox, importedLog };
}

/** 在 vm 里装上 transform 集群，返回 normalize 函数。 */
function loadTransform() {
  const { sandbox, importedLog } = makeSandbox();
  const context = vm.createContext(sandbox);
  new vm.Script(
    extractTransformCluster() + '\n;globalThis.__normalize = normalizeStPluginScriptSourceCompat;',
    { filename: 'transform-cluster.generated.js' },
  ).runInContext(context);
  return {
    normalize: (src: string, opts: Record<string, unknown> = {}) =>
      (sandbox as any).__normalize(src, { pluginId: 'p', resourcePath: 'index.js', ...opts }) as string,
    importedLog,
    sandbox,
  };
}

type WrapMode = 'entry' | 'module';

/** 用**真实参数表**把变换后的源码包成与 runtime 同形的 wrapper，返回可执行文本。 */
function wrapWithRealParams(transformed: string, mode: WrapMode): string {
  const params = extractWrapperParams(mode);
  const args = params
    .map((p) => (p === 'window' || p === 'document' ? p : p === 'exports' ? '__exp' : p === 'module' ? '__mod' : `window.${p}`))
    .join(',');
  if (mode === 'entry') {
    return '(async () => { try {\nawait (async function(' + params.join(',') + '){\n'
      + transformed + '\n})(' + args + ');\n} catch (e) { globalThis.__wrapError = String(e && e.message || e); } })();';
  }
  return 'try {\n(function(' + params.join(',') + '){\n' + transformed + '\n})(' + args + ');\n'
    + '} catch (e) { globalThis.__wrapError = String(e && e.message || e); }';
}

/** 跑一遍 wrapper，返回执行后的 sandbox（async entry 模式会 await 收敛）。 */
async function runWrapped(wrapped: string) {
  const { sandbox } = makeSandbox();
  const context = vm.createContext(sandbox);
  const result = new vm.Script(wrapped, { filename: 'wrapped.generated.js' }).runInContext(context);
  if (result && typeof (result as Promise<unknown>).then === 'function') await result;
  return sandbox as Record<string, any>;
}

/** 递归列出插件 js（排除 third-party / assets / samples —— 不由本仓库适配保证）。 */
function pluginSources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!['third-party', 'assets', 'samples', 'node_modules'].includes(e.name)) {
        pluginSources(path.join(dir, e.name), out);
      }
    } else if (e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const CORE_IMPORT_RE = /import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*(?:script|extensions)\.js['"]/;

describe('ST 插件 import 变换 vs wrapper 参数表 撞名防御', () => {
  it('镜像常量与真实 wrapper 参数表一致（改参数表忘同步镜像会红）', () => {
    // [S3-ACCEPTANCE-GAP 二层修复后] 入口与本地模块两个 wrapper 已统一为同一张九参数表
    const entry = extractWrapperParams('entry');
    const module = extractWrapperParams('module');
    expect(entry).toEqual(module);
    expect(extractMirrorParams('module')).toEqual(entry);
    // 形状：经典 ST 全局七件套 + exports/module
    expect(entry.slice(0, 7)).toEqual(['window', 'document', 'SillyTavern', 'getContext', 'extension_settings', 'TavernHelper', 'eventSource']);
    expect(entry.slice(7)).toEqual(['exports', 'module']);
  });

  it('manifest hooks.activate 调用链在场（ST 标准激活机制，init 从不执行缺陷的守卫）', () => {
    const body = runtimeBody();
    expect(body, '入口执行处未读取 manifest.hooks.activate').toContain('plugin?.manifest?.hooks?.activate');
    expect(body, '缺少 activate hook 成功诊断码').toContain('st_plugin_activate_hook_ok');
    expect(body, '缺少 activate hook 失败诊断码').toContain('st_plugin_activate_hook_failed');
    // 入口脚本必须按模块模式变换（exports 收集是 hook 调用的前提）。
    // 锚 scriptContent 入参——本地模块调用点（resourceContent）本就传 true，不锚会盲区。
    // （入口调用点带一段中文注释，距离上限放到 600。）
    expect(body, '入口 normalize 调用未按模块模式变换').toMatch(
      /normalizeStPluginScriptSourceCompat\(scriptContent,[\s\S]{0,600}?moduleMode:\s*true/,
    );
  });

  it('SlashCommand(Argument|NamedArgument).fromProps 静态桩在场（29+20+28 处调用的守卫）', () => {
    const body = runtimeBody();
    expect(body, 'SlashCommand.fromProps 桩缺失').toMatch(/window\.SlashCommand\.fromProps = /);
    expect(body, 'SlashCommandArgument.fromProps 桩缺失').toMatch(/window\.SlashCommandArgument\.fromProps = /);
    expect(body, 'SlashCommandNamedArgument.fromProps 桩缺失').toMatch(/window\.SlashCommandNamedArgument\.fromProps = /);
  });

  it('i18n.js 模块映射与 disabledExtensions 默认值在场（init 第一道坎的守卫）', () => {
    const body = runtimeBody();
    expect(body, 'i18n.js 模块映射缺失（token-counter import { t } 会拿到 undefined）').toMatch(/match: \['i18n\.js'/);
    expect(body, 'disabledExtensions 默认数组缺失（regex init 首行 includes 会抛）').toMatch(/\.disabledExtensions = \[\]/);
  });

  it('preset-manager.js 模块映射在场（regex getPresetManager 的守卫）', () => {
    const body = runtimeBody();
    expect(body, 'preset-manager.js 映射缺失（regex import { getPresetManager } 会拿到 undefined）').toMatch(/match: \['preset-manager\.js'/);
  });

  it('SlashCommandCommonEnumsProvider 映射与 settings 子对象初始化在场（regex/translate/memory 的守卫）', () => {
    const body = runtimeBody();
    expect(body, 'SlashCommandCommonEnumsProvider 映射缺失（regex commonEnumProviders.boolean 会抛）')
      .toMatch(/match: \['slash-commands\/slashcommandcommonenumsprovider\.js'/);
    // settings 子对象键名 ensure（translate/memory loadSettings 的前提）。
    // [批次E2b 2026-10-21] 名单按类型拆分：regex 必须是数组，不能混在对象名单里。
    // [批次D1 2026-10-21] 对象名单补齐到 ST 1.18.0 的 15 个命名空间。
    expect(body, 'settings 子对象初始化缺失（Object.hasOwn(undefined) 会抛）').toMatch(
      /ST_PLUGIN_PRESET_OBJECT_NAMESPACES_COMPAT = \['caption', 'cfg', 'chromadb', 'dice', 'expressions', 'memory', 'note', 'objective', 'quickReply', 'randomizer', 'rvc', 'sd', 'speech_recognition', 'translate', 'tts'\]/,
    );
    expect(body, 'regex/expressionOverrides/disabledExtensions 数组初始化缺失（.forEach 会抛）').toMatch(
      /ST_PLUGIN_PRESET_ARRAY_NAMESPACES_COMPAT = \['disabledExtensions', 'expressionOverrides', 'regex'\]/,
    );
    expect(body, 'regex_presets 数组初始化缺失（.map 会抛）').toMatch(/\.regex_presets = \[\]/);
  });

  it('iframe 内挂载容器桩在场（quick-reply init 的 #qr_container 前提）', () => {
    const body = runtimeBody();
    expect(body, '挂载容器 ensure 函数缺失').toContain('ensureStPluginMountPointsCompat');
    expect(body, 'qr_container 不在桩清单里（quick-reply init 会抛 null.append）').toMatch(/'qr_container'/);
    expect(body, 'ensure 未在脚本执行前调用').toMatch(/ensureStPluginMountPointsCompat\(\);\s*\n\s*executeStPluginScriptsCompat\(\)/);
  });

  it('moduleMode 下 export 收成 exports.x（activate hook 拿得到 init）', () => {
    const { normalize } = loadTransform();
    const src = [
      "import { getContext } from '../../extensions.js';",
      'export async function init() { globalThis.__hookRan = typeof getContext; }',
      'export const marker = 1;',
      "export { helper };",
      'function helper() { return 1; }',
    ].join('\n');
    const out = normalize(src, { moduleMode: true });
    expect(out, 'export async function init 未转成 exports.init').toContain('exports.init = async function init');
    expect(out, 'export const 未转成 exports.x').toContain('exports.marker = 1');
    expect(out, 'export 列表未转成 exports 活绑定 getter').toMatch(
      /Object\.defineProperty\(exports, "helper", \{ enumerable: true, get: function \(\) \{ return helper; \} \}\)/,
    );
    // 经典脚本路径不受影响：无 export 时文本只含 import 处理结果
    const plain = normalize('globalThis.__x = 1;', { moduleMode: false });
    expect(plain).toContain('globalThis.__x = 1;');
  });

  it('5 个真实插件入口：变换 + 真实参数表后可解析（曾经的 5/5 SyntaxError）', () => {
    const { normalize } = loadTransform();
    const entries = ['quick-reply', 'translate', 'token-counter', 'memory', 'regex'];
    const failures: string[] = [];
    for (const name of entries) {
      const file = path.join(PLUGINS_ROOT, name, 'index.js');
      expect(fs.existsSync(file), `插件入口不存在: ${file}`).toBe(true);
      const src = fs.readFileSync(file, 'utf-8');
      const wrapped = wrapWithRealParams(normalize(src, { moduleMode: false }), 'entry');
      try {
        new vm.Script(wrapped, { filename: name + '.entry.js' });
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    }
    expect(failures, '以下插件入口仍无法解析（撞名回归？）:\n' + failures.join('\n')).toEqual([]);
  });

  it('守卫自身不失效：5 个入口里确有 import 撞名符号（否则本条测试会假绿）', () => {
    const entries = ['quick-reply', 'translate', 'token-counter', 'memory', 'regex'];
    const paramNames = new Set(extractWrapperParams('entry'));
    let collisionCount = 0;
    for (const name of entries) {
      const src = fs.readFileSync(path.join(PLUGINS_ROOT, name, 'index.js'), 'utf-8');
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
        for (const item of m[1].split(',')) {
          const local = item.trim().split(/\s+as\s+/).pop()?.trim();
          if (local && paramNames.has(local)) collisionCount += 1;
        }
      }
    }
    expect(collisionCount, '5 个入口里没有撞名 import 了——本守卫的靶子已消失，应复核后删改').toBeGreaterThan(0);
  });

  it('所有 import ST 核心的本地模块：module 模式变换 + 九参数表后可解析', () => {
    const { normalize } = loadTransform();
    const files = pluginSources(PLUGINS_ROOT).filter((f) => CORE_IMPORT_RE.test(fs.readFileSync(f, 'utf-8')));
    expect(files.length, '未扫到任何 import ST 核心的本地模块，守卫可能已失效').toBeGreaterThan(0);
    const failures: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      const rel = path.relative(PLUGINS_ROOT, f).replace(/\\/g, '/');
      const wrapped = wrapWithRealParams(normalize(src, { moduleMode: true, resourcePath: rel }), 'module');
      try {
        new vm.Script(wrapped, { filename: rel });
      } catch (e) {
        failures.push(`${rel}: ${(e as Error).message}`);
      }
    }
    expect(failures, '以下本地模块仍无法解析（module 模式撞名回归？）:\n' + failures.join('\n')).toEqual([]);
  });

  it('语义：import 绑定覆盖参数注入的全局（不只是不炸）', async () => {
    const { normalize } = loadTransform();
    const src = [
      "import { eventSource } from '../../../script.js';",
      "import { getContext } from '../../extensions.js';",
      'globalThis.__probeEvent = eventSource;',
      'globalThis.__probeCtx = getContext;',
    ].join('\n');
    const sandbox = await runWrapped(wrapWithRealParams(normalize(src, { moduleMode: false }), 'entry'));
    expect(sandbox.__wrapError, 'wrapper 执行报错（本应静默成功）').toBeUndefined();
    expect(sandbox.__probeEvent?.__kind, 'eventSource 应取到 import 值而非参数注入的全局').toBe('import');
    expect(sandbox.__probeEvent?.__from).toContain('script.js');
    expect(sandbox.__probeCtx?.__kind, 'getContext 应取到 import 值而非参数注入的全局').toBe('import');
    expect(sandbox.__probeCtx?.__from).toContain('extensions.js');
  });

  it('经典脚本（无 import）仍拿到参数注入的全局（老路径不能被修坏）', async () => {
    const { normalize } = loadTransform();
    const src = [
      'globalThis.__probeEvent = eventSource;',
      'globalThis.__probeCtx = getContext;',
      'globalThis.__probeSettings = extension_settings;',
    ].join('\n');
    const sandbox = await runWrapped(wrapWithRealParams(normalize(src, { moduleMode: false }), 'entry'));
    expect(sandbox.__wrapError).toBeUndefined();
    expect(sandbox.__probeEvent?.__kind).toBe('param');
    expect(sandbox.__probeCtx?.__kind).toBe('param');
    expect(sandbox.__probeSettings?.__kind).toBe('param');
  });

  it('module 模式：本地模块 import 核心全局同样不撞名且 import 优先', async () => {
    const { normalize } = loadTransform();
    const src = [
      "import { getContext } from '../../extensions.js';",
      "import { eventSource } from '../../../script.js';",
      'exports.init = () => ({ ctx: getContext, ev: eventSource });',
    ].join('\n');
    const sandbox = await runWrapped(wrapWithRealParams(normalize(src, { moduleMode: true }), 'module'));
    expect(sandbox.__wrapError, 'module wrapper 执行报错').toBeUndefined();
    const init = (sandbox.__exp as any)?.init;
    expect(typeof init, '本地模块应把 init 挂到 exports').toBe('function');
    const out = init();
    expect(out.ctx?.__kind).toBe('import');
    expect(out.ev?.__kind).toBe('import');
  });

  it('重复 import 同一非参数本地名不炸（首次生效，优雅降级）', async () => {
    const { normalize } = loadTransform();
    const src = [
      "import { chat } from '../../../script.js';",
      "import { chat } from '../../events.js';",
      'globalThis.__probeChat = chat;',
    ].join('\n');
    const sandbox = await runWrapped(wrapWithRealParams(normalize(src, { moduleMode: false }), 'entry'));
    expect(sandbox.__wrapError).toBeUndefined();
    expect(sandbox.__probeChat?.__kind).toBe('import');
    expect(sandbox.__probeChat?.__from).toContain('script.js');
  });

  it('namespace import 撞名同样走赋值（不生成 const）', async () => {
    const { normalize } = loadTransform();
    const src = [
      "import * as eventSource from '../../../script.js';",
      'globalThis.__probeNs = eventSource;',
    ].join('\n');
    const sandbox = await runWrapped(wrapWithRealParams(normalize(src, { moduleMode: false }), 'entry'));
    expect(sandbox.__wrapError).toBeUndefined();
    expect(sandbox.__probeNs?.__kind).toBe('namespace');
  });
});
