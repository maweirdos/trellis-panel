import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readdirSync } from 'node:fs'
import esbuild from 'esbuild'
import type { Plugin } from 'vite'
import { reactHookRefresh } from './scripts/vite-hook-refresh'
import { canonicalTeamOrigin } from './src/main/services/team-platform/http'

const DEFAULT_DESKTOP_TEAM_ORIGIN = 'http://127.0.0.1:5441'

function desktopTeamOrigin(command: 'build' | 'serve'): string {
  const configured = process.env.CRUX_TEAM_SERVICE_ORIGIN
  if (configured === undefined) return command === 'serve' ? DEFAULT_DESKTOP_TEAM_ORIGIN : ''
  try {
    return canonicalTeamOrigin(configured, command === 'serve')
  } catch (error) {
    throw new Error(`Invalid CRUX_TEAM_SERVICE_ORIGIN: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * S0 G2：diff worker 单独 esbuild 打包（不走 rollup 多入口——实测 vite 会给第二入口
 * 生成 require('./index.js') 的 facade 依赖，worker 线程内加载主 bundle 即 require
 * ('electron') 崩溃）。与 scripts/smoke/reading-session.mjs 的 worker 打包路径一致。
 * dev（main 为 build --watch）与 build 均会触发 closeBundle。
 */
function bundleMainWorker(name: string, entry: string, filename: string): Plugin {
  return {
    name,
    apply: 'build',
    async closeBundle() {
      await esbuild.build({
        entryPoints: [resolve(__dirname, entry)],
        outfile: resolve(__dirname, 'out/main', filename),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        logLevel: 'warning'
      })
    }
  }
}

/** Isolated role bundles cannot share an eager GUI chunk with the headless host. */
function bundleMainRole(entry: string, filename: string): Plugin {
  return {
    name: `bundle-${filename}`,
    apply: 'build',
    buildStart() {
      const watch = (directory: string): void => {
        for (const item of readdirSync(directory, { withFileTypes: true })) {
          const file = resolve(directory, item.name)
          if (item.isDirectory()) watch(file)
          else if (item.name.endsWith('.ts')) this.addWatchFile(file)
        }
      }
      watch(resolve(__dirname, 'src/main')); watch(resolve(__dirname, 'src/shared'))
    },
    async closeBundle() {
      await esbuild.build({
        entryPoints: [resolve(__dirname, entry)], outfile: resolve(__dirname, 'out/main', filename),
        bundle: true, packages: 'external', external: ['electron'], format: 'cjs', platform: 'node',
        target: 'node22', logLevel: 'warning'
      })
    }
  }
}

function bundlePiEngine(): Plugin {
  return { name: 'bundle-pi-sdk-engine', apply: 'build', async closeBundle() {
    await esbuild.build({ entryPoints: {
      engine: resolve(__dirname, 'src/main/services/pi/engine.ts'),
      'text-completion': resolve(__dirname, 'src/main/services/pi/engine/text-completion.ts')
    }, outdir: resolve(__dirname, 'out/pi-engine'), outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external',
      platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning' })
  } }
}

export default defineConfig(({ command }) => ({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      bundlePiEngine(),
      bundleMainRole('src/main/index.ts', 'gui.js'),
      bundleMainRole('src/main/daemon/gui-scope.ts', 'gui-scope.js'),
      bundleMainRole('src/main/daemon/host.ts', 'daemon-host.js'),
      bundleMainRole('src/main/daemon/control.ts', 'daemon-control.js'),
      bundleMainRole('src/main/daemon/maintenance.ts', 'daemon-maintenance.js'),
      bundleMainRole('src/main/daemon/cli.ts', 'daemon-cli.js'),
      bundleMainWorker('bundle-knowledge-browse-worker', 'src/main/services/knowledge-browse-worker.ts', 'knowledge-browse-worker.js'),
      bundleMainWorker('bundle-diff-worker', 'src/main/services/documents/diff-worker.ts', 'diff-worker.js'),
      bundleMainWorker('bundle-observation-worker', 'src/main/services/observability/observation-worker.ts', 'observation-worker.js'),
      bundleMainWorker('bundle-history-worker', 'src/main/services/acp/history-worker.ts', 'history-worker.js'),
      bundleMainWorker('bundle-workflow-control-worker', 'src/main/services/workflow-control/worker.ts', 'workflow-control-worker.js'),
      bundleMainWorker('bundle-team-desktop-worker', 'src/main/services/team-platform/store-worker.ts', 'team-desktop-worker.js'),
      bundleMainWorker('bundle-whiteboard-v2-worker', 'src/main/services/creations/whiteboard-v2-worker.ts', 'whiteboard-v2-worker.js')
    ],
    build: {
      // electron-vite 5 / vite 8 默认输出 ESM(.mjs)；本项目为 CJS（package.json 无 type:module），
      // 强制回 CJS 以匹配 out/main/index.js 入口（Electron 44 + CJS 主进程）
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/bootstrap.ts') },
        // externalizeDepsPlugin v5 仅外置 dependencies；electron 位于 devDependencies，
        // 不显式 external 会把 npm 包 index.js 打进产物（运行时误触二进制下载逻辑）
        // These sibling bundles are emitted by bundleMainRole in closeBundle.
        // Resolve them from the emitted bootstrap at runtime, not from src/main.
        external: ['electron', './gui.js', './gui-scope.js', './daemon-host.js', './daemon-control.js', './daemon-maintenance.js'],
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), {
      name: 'bundle-docx-sandbox-preload', apply: 'build', async closeBundle() {
        await esbuild.build({ entryPoints: [resolve(__dirname, 'src/preload/docx-preview.ts')],
          outfile: resolve(__dirname, 'out/preload/docx-preview.js'), bundle: true, platform: 'node',
          format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning' })
      }
    }],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    define: {
      __CRUX_TEAM_SERVICE_ORIGIN__: JSON.stringify(desktopTeamOrigin(command))
    },
    optimizeDeps: {
      // The editor is lazy. Discover its public dependencies before the first
      // workbench visit so dev optimization cannot invalidate its import mid-open.
      include: ['@tiptap/core', '@tiptap/react', '@tiptap/react/menus', '@tiptap/markdown', '@tiptap/starter-kit', '@tiptap/extension-list', '@tiptap/extension-table', '@tiptap/pm/model', '@tiptap/pm/state', '@tiptap/pm/history']
    },
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
        input: { index: resolve(__dirname, 'src/renderer/index.html'), 'docx-preview': resolve(__dirname, 'src/renderer/docx-preview.html') }
      }
    }
  }
}))
