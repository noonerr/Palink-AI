import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vite.config';

/**
 * vitest 独立配置：继承 vite.config.ts（保留 @ alias 与 smart-card 虚拟模块插件），
 * 仅在测试环境追加 showdown 桩 alias —— 中文项目路径下 showdown 的 CJS
 * file://URL require 编码失败，契约测试不测 markdown 渲染，桩替足够。
 * 生产构建走 vite.config.ts，不受影响。
 *
 * environment: 'jsdom' —— src/lib/sillytavern/formatting.ts:17 在模块顶层执行
 * DOMPurify.addHook(...)，纯 Node 下 dompurify 检测不到 window 就不自动初始化，
 * default.addHook 不是函数 → 任何 import 链碰到它整个测试文件崩在收集阶段。
 * jsdom 提供真实 window/document，dompurify 走自身初始化路径，无需在测试里 mock 它。
 * （原 `npm run test:contract` 靠 _tsx-loader.mjs 手工 mock dompurify 绕过同一问题。）
 */
export default mergeConfig(baseConfig as never, defineConfig({
  resolve: {
    alias: {
      showdown: path.resolve(__dirname, './src/test/showdown-stub.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    // jsdom 未实现 matchMedia、且 Node 25 内置的 globalThis.localStorage 访问器会盖掉
    // jsdom 的实现 —— 详见该文件头注释。
    setupFiles: [path.resolve(__dirname, './src/test/setup-browser-globals.ts')],
  },
}));
