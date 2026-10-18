// [P1-SHIM-EXTERNAL] Vite 插件：把 ST 兼容运行时（~400KB）与 legacy shim（~135KB）
// 生成/服务为可缓存的静态资产。
//
// 背景：智能卡 iframe 的 srcDoc 原先内联整套运行时（每次建 iframe 都要重新传输+解析，
// 且内联脚本吃不到 V8 code cache）。本插件把两段运行时体输出为
// `assets/palink-smart-card-runtime-<hash>.js` 与 `assets/palink-smart-card-legacy-<hash>.js`：
//  - build：通过 emitFile 产出到 dist（hash 文件名命中 nginx immutable 缓存规则）；
//  - dev：通过 configureServer 中间件在相同路径提供；
//  - 外部脚本 URL 经 virtual module `virtual:palink-smart-card-*-url` 注入源码
//    （define 在 Vite dev 对客户端模块不生效，virtual module 在 dev/build 均可用）。
//    hash 变化 → 文件名变化 → 缓存自然失效。
//
// [LEGACY-EXTERNAL 2026-10-18] 新增 legacy 资产。⚠️ 本文件在**加载 vite/vitest 配置时**
// 就被 import，那一刻 '@' 别名尚未生效 ⇒ 只能 import 零 '@/' 依赖的模块
// （legacy-shim-source.ts 就是为此抽出来的，见其文件头注释）。
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { buildSmartCardCompatRuntimeExternalScript } from '../src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime';
import { buildSmartCardLegacyExternalScript } from '../src/components/ui/custom/smart-card-runtime/frame-shim/legacy-shim-source';

const RUNTIME_URL_MODULE_ID = 'virtual:palink-smart-card-runtime-url';
const LEGACY_URL_MODULE_ID = 'virtual:palink-smart-card-legacy-url';

interface ExternalAsset {
  /** virtual module id */
  moduleId: string;
  /** 构建产物源码 */
  build: () => string;
  /** 文件名前缀（决定 dist 路径与缓存键） */
  prefix: string;
}

const ASSETS: ExternalAsset[] = [
  {
    moduleId: RUNTIME_URL_MODULE_ID,
    prefix: 'palink-smart-card-runtime',
    build: buildSmartCardCompatRuntimeExternalScript,
  },
  {
    moduleId: LEGACY_URL_MODULE_ID,
    prefix: 'palink-smart-card-legacy',
    build: buildSmartCardLegacyExternalScript,
  },
];

// build-vite.mjs 会经 loadConfigFromFile 再 build(config) 二次求值配置，插件实例可能
// 出现两份（各自的模块作用域互不相通）；用 globalThis 共享集合保证同一 URL 只 emit 一次，
// 避免 rollup "overwrites" 警告。
const EMITTED_KEY = '__palinkSmartCardRuntimeEmitted__';
const emittedRuntimeAssets: Set<string> = (
  (globalThis as unknown as Record<string, unknown>)[EMITTED_KEY] as Set<string> | undefined
) || new Set<string>();
(globalThis as unknown as Record<string, unknown>)[EMITTED_KEY] = emittedRuntimeAssets;

export function smartCardRuntimeAssetPlugin(): Plugin {
  // moduleId → { source, url }
  const resolved = new Map<string, { source: string; url: string }>();

  const ensure = (asset: ExternalAsset) => {
    const cached = resolved.get(asset.moduleId);
    if (cached) return cached;
    const source = asset.build();
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    const value = { source, url: `/assets/${asset.prefix}-${hash}.js` };
    resolved.set(asset.moduleId, value);
    return value;
  };

  const ensureAll = () => ASSETS.forEach(ensure);

  return {
    name: 'palink-smart-card-runtime-asset',
    resolveId(id) {
      if (ASSETS.some((asset) => asset.moduleId === id)) return id;
      return null;
    },
    load(id) {
      const asset = ASSETS.find((item) => item.moduleId === id);
      if (!asset) return null;
      return `export default ${JSON.stringify(ensure(asset).url)};`;
    },
    configureServer(server) {
      ensureAll();
      server.middlewares.use((req, res, next) => {
        const pathname = req.url ? req.url.split('?')[0] : '';
        for (const asset of ASSETS) {
          const entry = ensure(asset);
          if (pathname !== entry.url) continue;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.end(entry.source);
          return;
        }
        next();
      });
    },
    generateBundle() {
      ensureAll();
      for (const asset of ASSETS) {
        const entry = ensure(asset);
        if (emittedRuntimeAssets.has(entry.url)) continue;
        emittedRuntimeAssets.add(entry.url);
        this.emitFile({
          type: 'asset',
          fileName: entry.url.slice(1),
          source: entry.source,
        });
      }
    },
  };
}
