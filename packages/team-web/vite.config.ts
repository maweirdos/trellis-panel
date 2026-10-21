import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', 'zod'] },
  css: { postcss: { plugins: [] } },
  server: {
    port: 5442, strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
    proxy: Object.fromEntries(['/api', '/auth', '/health', '/ready'].map((path) => [path, {
      target: process.env.TEAM_API_UPSTREAM ?? 'http://127.0.0.1:5441',
      changeOrigin: false
    }]))
  },
  build: { outDir: 'dist', emptyOutDir: true }
})
