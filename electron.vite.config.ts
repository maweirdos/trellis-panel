import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import esbuild from 'esbuild'
import type { Plugin } from 'vite'
import { reactHookRefresh } from './scripts/vite-hook-refresh'

/**
 * S0 G2：diff worker 单独 esbuild 打包（不走 rollup 多入口——实测 vite 会给第二入口
 * 生成 require('./index.js') 的 facade 依赖，worker 线程内加载主 bundle 即 require
 * ('electron') 崩溃）。与 scripts/smoke/reading-session.mjs 的 worker 打包路径一致。
 * dev（main 为 build --watch）与 build 均会触发 closeBundle。
 */
function bundleDiffWorker(): Plugin {
  return {
    name: 'bundle-diff-worker',
    apply: 'build',
    async closeBundle() {
      await esbuild.build({
        entryPoints: [resolve(__dirname, 'src/main/services/documents/diff-worker.ts')],
        outfile: resolve(__dirname, 'out/main/diff-worker.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        logLevel: 'warning'
      })
    }
  }
}

/**
 * S0 G3：observation worker 同一先例单独 esbuild 打包（node:sqlite + 控制库核心，
 * 独立于主 bundle；service 侧按 __dirname 邻位定位 out/main/observation-worker.js）。
 */
function bundleObservationWorker(): Plugin {
  return {
    name: 'bundle-observation-worker',
    apply: 'build',
    async closeBundle() {
      await esbuild.build({
        entryPoints: [resolve(__dirname, 'src/main/services/observability/observation-worker.ts')],
        outfile: resolve(__dirname, 'out/main/observation-worker.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        logLevel: 'warning'
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), bundleDiffWorker(), bundleObservationWorker(), {
      name: 'bundle-history-worker',
      apply: 'build',
      closeBundle: () => esbuild.build({
        entryPoints: [resolve(__dirname, 'src/main/services/acp/history-worker.ts')],
        outfile: resolve(__dirname, 'out/main/history-worker.js'),
        bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'warning'
      }).then(() => {})
    }],
    build: {
      // electron-vite 5 / vite 8 默认输出 ESM(.mjs)；本项目为 CJS（package.json 无 type:module），
      // 强制回 CJS 以匹配 out/main/index.js 入口（Electron 44 + CJS 主进程）
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // externalizeDepsPlugin v5 仅外置 dependencies；electron 位于 devDependencies，
        // 不显式 external 会把 npm 包 index.js 打进产物（运行时误触二进制下载逻辑）
        // Keep acpx's public CommonJS export and package-relative owner paths intact.
        // Bundling its ESM branch rewrites import.meta.resolve and breaks packaged launches.
        external: ['electron', /^acpx(?:\/|$)/],
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
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    server: {
      port: 5373,
      strictPort: true
    },
    plugins: [reactHookRefresh(resolve(__dirname, 'src/renderer/src')), react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
