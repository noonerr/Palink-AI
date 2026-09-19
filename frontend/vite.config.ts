import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { smartCardRuntimeAssetPlugin } from './vite-plugins/smart-card-runtime-asset'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [react(), smartCardRuntimeAssetPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  publicDir: 'public',
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
