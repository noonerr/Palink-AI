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
        manualChunks: {
          recharts: ['recharts'],
          mermaid: ['mermaid'],
          'framer-motion': ['framer-motion'],
          highlight: ['highlight.js'],
        },
      },
    },
    chunkSizeWarningLimit: 500,
  },
})
