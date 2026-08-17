import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vite.config';

/**
 * vitest 独立配置：继承 vite.config.ts（保留 @ alias 与 smart-card 虚拟模块插件），
 * 仅在测试环境追加 showdown 桩 alias —— 中文项目路径下 showdown 的 CJS
 * file://URL require 编码失败，契约测试不测 markdown 渲染，桩替足够。
 * 生产构建走 vite.config.ts，不受影响。
 */
export default mergeConfig(baseConfig as never, defineConfig({
  resolve: {
    alias: {
      showdown: path.resolve(__dirname, './src/test/showdown-stub.ts'),
    },
  },
}));
