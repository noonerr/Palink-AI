import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  publicDir: 'public',
  server: {
    port: 3000,
    host: '0.0.0.0',
    watch: {
      usePolling: !!process.env.DOCKER_DEV,
      interval: 1000,
    },
    proxy: {
      '/api': {
        target: process.env.DOCKER_DEV ? 'http://backend:8000' : 'http://localhost:8000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    minify: 'terser',
    terserOptions: {
      compress: {
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
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          recharts: ['recharts'],
          mermaid: ['mermaid'],
          'framer-motion': ['framer-motion'],
          highlight: ['highlight.js'],
          ChatSessionList: ['src/components/ui/custom/ChatSessionList.tsx'],
          useMobileBottomPadding: ['src/hooks/useMobileBottomPadding.ts'],
        },
      },
    },
    chunkSizeWarningLimit: 500,
  },
})