/**
 * 卡脚本依赖的第三方全局（对齐上游 JS-Slash-Runner）
 *
 * ## 为什么需要这个模块
 *
 * 上游 JS-Slash-Runner 会**免费送**一批第三方库给卡内脚本，卡作者因此直接写裸标识符：
 *
 * | 上游机制 | 文件 | 提供 |
 * |---|---|---|
 * | `initThirdPartyObject()` | `src/third_party_object.ts` | `globalThis.z = zod`、`globalThis.YAML` |
 * | 脚本 iframe 预置 | `src/iframe/predefine.js` | 从父窗口合并 `_ / z / YAML / showdown / toastr` 等 |
 * | 脚本 iframe 模板 | `src/iframe/third_party_script.html` | 从 CDN 加载 **Vue + vue-router** |
 *
 * Palink 此前**一个都没提供**，实测后果（2026-10-03 真机复现）：
 *
 * ```
 * Uncaught ReferenceError: z is not defined
 *   at .../StageDog/tavern_resource/dist/util/mvu_zod.js:1:362
 * Uncaught ReferenceError: Vue is not defined
 *   at .../MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js:2:332847
 * ```
 *
 * 这两条直接打死**整个变量系统**——变量结构脚本（`mvu_zod.js` 用 `z.z.object` / `_.get`）
 * 与 MVU 引擎本体（Vue 应用）双双加载失败 → `Mvu` 为 undefined → 状态栏 / 好感度 /
 * 变量面板全失效。
 *
 * ## 三条设计约束
 *
 * 1. **幂等**：同一份全局只装一次；已有实现不覆盖（lodash 例外，见下）。
 * 2. **不阻塞**：调用方可以 `await`，但整体带超时上限；CDN 挂掉只是回到今天的行为，
 *    绝不把页面卡住。
 * 3. **失败留痕**：加载失败走 `recordStubHit` 进 `window.__palinkCompatStats`，
 *    而不是只打 console（生产构建 terser `drop_console` 会剥掉全部 console.*）。
 *
 * ## 为什么走 CDN 而不是打进 bundle
 *
 * 与本仓库既有口径一致：`frontend/security-headers.conf` 的 CSP 已为
 * 「允许卡片执行自带脚本并从 CDN 拉库」放行 `https://*.jsdelivr.net`；
 * 卡内脚本本身就是从 `testingcf.jsdelivr.net` 拉的。镜像域选择沿用同一口径
 * （主域 `cdn.jsdelivr.net` 在大陆被阻断，实测只有 `testingcf` 可用）。
 */

import { recordStubHit } from '@/lib/plugin-system/compat-stub-registry';

/** 与卡内脚本同源的镜像域（见文件头说明） */
const CDN = 'https://testingcf.jsdelivr.net/npm';

/** 单次加载的总超时。超时后放弃等待，脚本按「缺库」的老行为走（不阻断页面）。 */
const LOAD_TIMEOUT_MS = 8000;

interface GlobalSpec {
  /** 全局名（卡脚本里直接写的裸标识符） */
  name: string;
  /** 加载方式：classic = 注入 <script src> 由库自己挂全局；esm = import() 后手动挂命名空间 */
  kind: 'classic' | 'esm';
  url: string;
  /**
   * 已有实现是否算「够用」。缺省 = 只要不是 undefined 就不覆盖。
   * lodash 特例：Palink 自己有个只有 4 个方法的 lite 版 `_`（get/set/cloneDeep/isEmpty），
   * 而卡内 schema 会用 `_.clamp` —— 所以这里按「有没有 clamp」判断是不是 lite 版。
   */
  isSatisfied?: (current: unknown) => boolean;
}

const SPECS: readonly GlobalSpec[] = [
  {
    name: '_',
    kind: 'classic',
    url: `${CDN}/lodash@4.17.21/lodash.min.js`,
    // 缺 clamp 说明是 lite 替身（或压根没有）→ 用完整 lodash 覆盖
    isSatisfied: (cur) => typeof cur !== 'undefined' && typeof (cur as { clamp?: unknown })?.clamp === 'function',
  },
  {
    name: 'Vue',
    kind: 'classic',
    // 与上游 third_party_script.html 同款运行时全局构建（Vue 3.5.x，MVU 生态要求）
    url: `${CDN}/vue@3.5.13/dist/vue.runtime.global.prod.min.js`,
  },
  {
    name: 'showdown',
    kind: 'classic',
    url: `${CDN}/showdown@2.1.0/dist/showdown.min.js`,
  },
  {
    // zod 必须是 v4：卡内 mvu_zod.js 用的是 `z.z.ZodObject` / `z.z.looseObject` 形状。
    // 版本与上游 package.json 的 `zod ^4.4.3` 对齐。
    name: 'z',
    kind: 'esm',
    url: `${CDN}/zod@4.4.3/+esm`,
  },
  {
    name: 'YAML',
    kind: 'esm',
    url: `${CDN}/yaml@2.8.1/+esm`,
  },
];

/** 已在进行的加载（并发调用只跑一次） */
let inflight: Promise<void> | null = null;
/** 已完成（成功或超时放弃）的标记 */
let settled = false;

/** 向页面注入一个 classic <script> 并等它 load/error */
function loadClassicScript(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    // 与仓库其它动态注入同款 nonce 约定（CSP 存在时缺 nonce 会被拦）
    el.setAttribute('nonce', 'palink-smart-card');
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`script load failed: ${src}`));
    document.head.appendChild(el);
  });
}

/** 单个全局的装载。失败不抛，登记降级后返回 false。 */
async function installOne(spec: GlobalSpec): Promise<boolean> {
  const w = window as unknown as Record<string, unknown>;
  const current = w[spec.name];
  const satisfied = spec.isSatisfied ? spec.isSatisfied(current) : typeof current !== 'undefined';
  if (satisfied) return true;

  try {
    if (spec.kind === 'classic') {
      await loadClassicScript(spec.url);
      if (typeof w[spec.name] === 'undefined') {
        throw new Error(`${spec.name} not defined after loading ${spec.url}`);
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ spec.url);
      w[spec.name] = mod;
    }
    return true;
  } catch (error) {
    recordStubHit(
      `st-global:${spec.name}`,
      `卡脚本依赖的全局未就绪：${error instanceof Error ? error.message : String(error)}`,
    );
    console.warn(`[ST-GLOBALS] 装载 ${spec.name} 失败（卡内相关功能将不可用）:`, error);
    return false;
  }
}

/** 给单个 Promise 套超时（超时返回 null，不 reject，避免 unhandled rejection） */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    p,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * 确保卡脚本依赖的第三方全局就绪。
 *
 * - 幂等：重复调用复用同一个 Promise，不会重复下载。
 * - 不抛：任何单项失败只登记降级，其余项继续装。
 * - 有超时上限：CDN 慢/挂掉时最坏等 `LOAD_TIMEOUT_MS`，之后照常放行脚本。
 *
 * 调用时机要求：**必须在 `runCardTavernHelperScripts()` 之前 await**，
 * 因为卡脚本是注入即执行、且带幂等去重，晚到的全局不会让已跑过的脚本重跑。
 */
export function ensureStThirdPartyGlobals(): Promise<void> {
  if (settled) return Promise.resolve();
  if (inflight) return inflight;

  inflight = withTimeout(
    (async () => {
      // 串行装载：卡脚本对顺序无强要求，但串行能让失败定位更清楚、并发压力更小
      for (const spec of SPECS) {
        await installOne(spec);
      }
    })(),
    LOAD_TIMEOUT_MS,
  )
    .catch((error) => {
      console.warn('[ST-GLOBALS] 装载流程异常（不阻断）:', error);
    })
    .finally(() => {
      settled = true;
      inflight = null;
    });

  return inflight;
}

/** 仅供测试：重置模块级状态。 */
export function resetStThirdPartyGlobalsForTest(): void {
  inflight = null;
  settled = false;
}

/** 导出清单供测试断言（不参与运行时逻辑）。 */
export const ST_THIRD_PARTY_GLOBAL_SPECS: readonly GlobalSpec[] = SPECS;
