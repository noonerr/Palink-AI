import path from 'path'
import fs from 'fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { smartCardRuntimeAssetPlugin } from './vite-plugins/smart-card-runtime-asset'

function stMockPlugin() {
  return {
    name: 'st-mock',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''

        if (url === '/version' || url.startsWith('/version?')) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ agent: 'SillyTavern', pkgVersion: '1.18.0', repo: 'mock', branch: 'mock', commit: 'mock' }))
          return
        }

        if (url === '/csrf-token' || url.startsWith('/csrf-token?')) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ token: 'palink-mock-csrf' }))
          return
        }

        if (url === '/st/index.html' || url.startsWith('/st/index.html?')) {
          const stIndexFile = path.join(__dirname, 'public', 'st', 'index.html')
          if (fs.existsSync(stIndexFile)) {
            res.setHeader('Content-Type', 'text/html')
            res.setHeader('Cache-Control', 'no-store')
            fs.createReadStream(stIndexFile).pipe(res)
            return
          }
        }

        if (url.startsWith('/st/') || url.startsWith('/api/') || url.startsWith('/src/') || url.startsWith('/@') || url.startsWith('/node_modules/') || url.startsWith('/assets/') || url === '/' || url.startsWith('/index.html')) {
          return next()
        }

        const stFile = path.join(__dirname, 'public', 'st', url.split('?')[0])
        if (fs.existsSync(stFile) && fs.statSync(stFile).isFile()) {
          const ext = path.extname(stFile)
          const mimeTypes = {
            '.js': 'application/javascript',
            '.mjs': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.webp': 'image/webp',
            '.webm': 'video/webm',
            '.mp3': 'audio/mpeg',
            '.mp4': 'video/mp4',
            '.html': 'text/html',
            '.map': 'application/json',
          }
          res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
          res.setHeader('Cache-Control', 'no-store')
          fs.createReadStream(stFile).pipe(res)
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  base: '/',
  plugins: [react(), stMockPlugin(), smartCardRuntimeAssetPlugin()],
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
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss: ws:; media-src 'self' blob: data:; worker-src 'self' blob:; frame-src 'self' http://localhost:8000 http://127.0.0.1:8000 http://localhost:8001 http://127.0.0.1:8001; base-uri 'self'; form-action 'self';",
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
        drop_console: false,
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
