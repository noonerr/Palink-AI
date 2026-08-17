// [P1-SHIM-EXTERNAL] Vite 插件：把 ST 兼容运行时（~400KB）生成/服务为可缓存的静态资产。
//
// 背景：智能卡 iframe 的 srcDoc 原先内联整套运行时（每次建 iframe 都要重新传输+解析，
// 且内联脚本吃不到 V8 code cache）。本插件把运行时体输出为 `assets/palink-smart-card-runtime-<hash>.js`：
//  - build：通过 emitFile 产出到 dist（hash 文件名命中 nginx immutable 缓存规则）；
//  - dev：通过 configureServer 中间件在相同路径提供；
//  - 外部脚本 URL 经 virtual module `virtual:palink-smart-card-runtime-url` 注入源码
//    （define 在 Vite dev 对客户端模块不生效，virtual module 在 dev/build 均可用）。
//    hash 变化 → 文件名变化 → 缓存自然失效。
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { buildSmartCardCompatRuntimeExternalScript } from '../src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime';

const RUNTIME_FILENAME_PREFIX = 'palink-smart-card-runtime';
const RUNTIME_URL_MODULE_ID = 'virtual:palink-smart-card-runtime-url';

// build-vite.mjs 会经 loadConfigFromFile 再 build(config) 二次求值配置，插件实例可能
// 出现两份（各自的模块作用域互不相通）；用 globalThis 共享集合保证同一 URL 只 emit 一次，
// 避免 rollup "overwrites" 警告。
const EMITTED_KEY = '__palinkSmartCardRuntimeEmitted__';
const emittedRuntimeAssets: Set<string> = (
  (globalThis as unknown as Record<string, unknown>)[EMITTED_KEY] as Set<string> | undefined
) || new Set<string>();
(globalThis as unknown as Record<string, unknown>)[EMITTED_KEY] = emittedRuntimeAssets;

function computeRuntime(): { source: string; url: string } {
  const source = buildSmartCardCompatRuntimeExternalScript();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return { source, url: `/assets/${RUNTIME_FILENAME_PREFIX}-${hash}.js` };
}

export function smartCardRuntimeAssetPlugin(): Plugin {
  let runtimeSource = '';
  let runtimeUrl = '';
  const ensureRuntime = () => {
    if (runtimeUrl && runtimeSource) return;
    const computed = computeRuntime();
    runtimeSource = computed.source;
    runtimeUrl = computed.url;
  };

  return {
    name: 'palink-smart-card-runtime-asset',
    resolveId(id) {
      if (id === RUNTIME_URL_MODULE_ID) return RUNTIME_URL_MODULE_ID;
      return null;
    },
    load(id) {
      if (id !== RUNTIME_URL_MODULE_ID) return null;
      ensureRuntime();
      return `export default ${JSON.stringify(runtimeUrl)};`;
    },
    configureServer(server) {
      ensureRuntime();
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.split('?')[0] === runtimeUrl) {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.end(runtimeSource);
          return;
        }
        next();
      });
    },
    generateBundle() {
      ensureRuntime();
      if (emittedRuntimeAssets.has(runtimeUrl)) return;
      emittedRuntimeAssets.add(runtimeUrl);
      this.emitFile({
        type: 'asset',
        fileName: runtimeUrl.slice(1),
        source: runtimeSource,
      });
    },
  };
}
