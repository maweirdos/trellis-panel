import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // electron-vite 5 / vite 8 默认输出 ESM(.mjs)；本项目为 CJS（package.json 无 type:module），
      // 强制回 CJS 以匹配 out/main/index.js 入口（Electron 44 + CJS 主进程）
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // externalizeDepsPlugin v5 仅外置 dependencies；electron 位于 devDependencies，
        // 不显式 external 会把 npm 包 index.js 打进产物（运行时误触二进制下载逻辑）
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    server: {
      port: 5373,
      strictPort: true
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
