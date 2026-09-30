import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { smartCardRuntimeAssetPlugin } from './vite-plugins/smart-card-runtime-asset'
import { assetContentHashPlugin } from './vite-plugins/asset-content-hash'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  // assetContentHashPlugin 放最后（enforce:'post'）：在文件名与引用全部定稿后，
  // 按 CSS 等非 JS 资产的**自身内容**重命名 —— 见 vite-plugins/asset-content-hash.ts
  // 的 K20 说明（Vite 默认给纯 CSS 的 hash 不含 CSS 自身内容，导致改 CSS 不换文件名，
  // 叠加 nginx 年度 immutable 缓存后 iOS 端永远拿不到 CSS 更新）。
  plugins: [react(), smartCardRuntimeAssetPlugin(), assetContentHashPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  publicDir: 'public',
  // [性能 2026-09-21 B2] Worker 是独立的 Rollup 构建，build.rollupOptions.treeshake
  // 对它不生效（实测：worker 仍 513KB、KaTeX 特征串 mord 仍 43 次），必须写在
  // worker.rollupOptions 下。
  //
  // 作用：告诉打包器 katex 无副作用，从而把 worker 根本用不到的整份 KaTeX 摇掉。
  // 背景：formatting-worker/worker.ts 只从 ../formatting 引入了 8 个纯函数，一个都不碰
  // KaTeX；但 formatting.ts 顶层 import katex，而 katex 包未声明 sideEffects: false，
  // 打包器不敢删，于是整份 KaTeX 在 worker 里被复制了一份（实测 513KB / gzip 142KB）。
  //
  // ⛔ 已实测无效的两条路，别再试：
  //   1) worker: { format: 'es' }            → 517KB，mord 仍 43
  //   2) 只写 build.rollupOptions.treeshake  → 517KB，mord 仍 43
  //
  // 验收硬指标：worker 产物 mord === 0 且 入口产物 mord >= 1，两者同时成立才算成功。
  worker: {
    rollupOptions: {
      treeshake: {
        moduleSideEffects: (id: string) => !/node_modules[\\/]katex[\\/]/.test(id),
      },
    },
  },
  server: {
    port: 3000,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
    proxy: {
      '/api': {
        target: 'http://backend:8000',
        changeOrigin: true,
        ws: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        // [N-19] 生产构建移除全部 console.*（terser 仅在 build 期生效，dev 不受影响）
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info'],
        passes: 2,
      },
      mangle: {
        safari10: true,
      },
    },
    rollupOptions: {
      input: 'index.html',
      output: {
        // [K20 2026-09-30] ⚠️ 勿改成 `[hash:8]` —— 那是另一条**错路**（实测验证过）。
        // Vite 的 [hash:8] 走 `chunk.contentHash`，而纯 CSS chunk 的 viteMetadata.importedCss
        // 为空 ⇒ hash 退化为空串 ⇒ 产物被同名互相覆盖（实测：加 [hash:8] 后重构建，
        // index-DAHj4yWK.css 与旧文件 SHA256 完全一致、161699 字节不变 —— 名字没换）。
        // 真正的问题在别处（见下方 vite-plugins/asset-content-hash.ts）：Vite 对纯 CSS 资源
        // 的 [hash] 取「入口依赖图 hash」，**不含该 CSS 自身内容** —— index.css 改 37 行后
        // 产物仍叫 index-DAHj4yWK.css。叠加 nginx 自 2026-09-21「性能优化 N1」的
        // `immutable, max-age=31536000`（前提是「内容变则名字变」）⇒ iOS 端 CSS 改动永远
        // 送不到：真机实证 iPhone 请求同名 CSS 被回 304、吃本地旧副本；桌面 Chrome 因刷新
        // 策略不同侥幸拿到新版，从而掩盖了问题一年。
        // 修复：由插件按「CSS 自身内容」的 sha256 重命名（含回写引用），保持 [name]-[hash8] 格式。
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        // [P0-1 2026-09-15] 原先这里是对象式 manualChunks：
        //   { recharts:['recharts'], mermaid:['mermaid'],
        //     'framer-motion':['framer-motion'], highlight:['highlight.js'] }
        // 对象式写法会把「目标包的依赖」一并吸进该命名 chunk（除非依赖已另行分配）：
        //   mermaid chunk 吸走 dompurify（126KB 源码）、recharts chunk 吸走 clsx、
        //   framer-motion chunk 吸走 react 运行时。
        // 而 entry 静态 import 了 dompurify/clsx/react，于是被迫静态依赖这三个巨型 chunk，
        // Vite 随之在 index.html 里对它们发 modulepreload —— mermaid(587KB)/recharts(392KB)
        // 本应只在「渲染 mermaid 图表 / 打开设置页看用量图」时动态加载，却进了首屏关键路径。
        // 实测移除后：首屏关键路径 3.06MB→2.08MB（raw）、844KB→597KB（gzip），-29%；
        // mermaid 回归动态 chunk、recharts 并入懒加载的 SettingsView。
        // 已核验：assets/palink-smart-card-runtime-*.js 独立资产与虚拟 URL 注入不受影响
        // （ST 智能卡运行时链路完好），全仓无任何地方硬编码引用 chunk 文件名。
        // 若将来确需再切分，请改用函数式 manualChunks 且只匹配目标包自身的 node_modules 路径，
        // 切勿把 dompurify / clsx / react / katex 等共享依赖纳入命名 chunk。
      },
    },
    chunkSizeWarningLimit: 500,
  },
})
