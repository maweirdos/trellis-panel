import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve, relative } from 'path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

const ROLE_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['src/main/daemon/gui-scope.ts', 'gui-scope.js'],
  ['src/main/daemon/host.ts', 'daemon-host.js'],
  ['src/main/daemon/control.ts', 'daemon-control.js'],
  ['src/main/daemon/maintenance.ts', 'daemon-maintenance.js'],
  ['src/main/daemon/cli.ts', 'daemon-cli.js']
]

const WORKER_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['src/main/services/knowledge-browse-worker.ts', 'knowledge-browse-worker.js'],
  ['src/main/services/documents/diff-worker.ts', 'diff-worker.js'],
  ['src/main/services/observability/observation-worker.ts', 'observation-worker.js'],
  ['src/main/services/acp/history-worker.ts', 'history-worker.js'],
  ['src/main/services/workflow-control/worker.ts', 'workflow-control-worker.js'],
  ['src/main/services/team-platform/store-worker.ts', 'team-desktop-worker.js'],
  ['src/main/services/creations/whiteboard-v2-worker.ts', 'whiteboard-v2-worker.js']
]

function scanSourceFiles(directory: string, out: string[], manifestEntries: string[]): void {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, item.name)
    if (item.isDirectory()) scanSourceFiles(file, out, manifestEntries)
    else if (item.name.endsWith('.ts') || item.name.endsWith('.json')) {
      if (item.name.endsWith('.ts')) out.push(file)
      try {
        const st = statSync(file, { bigint: true })
        manifestEntries.push(`${relative(__dirname, file)}:${st.size}:${st.mtimeNs}`)
      } catch { /* ignore transient file */ }
    }
  }
}

/**
 * 统一并发编排所有主进程角色 bundle、独立 worker 与 Pi 引擎：
 * - 单次遍历源码树注册 watch，并计算覆盖全部源码路径/大小/mtimeNs 与构建配置的精确 SHA-256 清单指纹；
 * - dev（serve）下仅当输入清单指纹完全一致且目标产物非空时复用，杜绝 git 切分支/删文件导致陈旧产物；
 * - 生产 build 始终全量重新构建，完全保持原有隔离边界与产物路径不变。
 */
function bundleMainCompanions(isDevServe: boolean): Plugin {
  let sourceFingerprint = ''
  const stampPath = resolve(__dirname, 'node_modules/.cache/trellis-panel/main-companions-stamp.json')
  return {
    name: 'bundle-main-companions',
    apply: 'build',
    buildStart() {
      const files: string[] = []
      const manifestEntries: string[] = []
      scanSourceFiles(resolve(__dirname, 'src/main'), files, manifestEntries)
      scanSourceFiles(resolve(__dirname, 'src/shared'), files, manifestEntries)
      for (const extra of ['package.json', 'electron.vite.config.ts', 'resources/brand/identity.json']) {
        try {
          const st = statSync(resolve(__dirname, extra), { bigint: true })
          manifestEntries.push(`${extra}:${st.size}:${st.mtimeNs}`)
        } catch { /* ignore */ }
      }
      manifestEntries.sort()
      sourceFingerprint = createHash('sha256').update(manifestEntries.join('\n')).digest('hex')
      for (const file of files) this.addWatchFile(file)
    },
    async closeBundle() {
      let cachedFingerprint = ''
      if (isDevServe && existsSync(stampPath)) {
        try {
          const parsed = JSON.parse(readFileSync(stampPath, 'utf8')) as { fingerprint?: string } | null
          if (parsed?.fingerprint) cachedFingerprint = parsed.fingerprint
        } catch { /* rebuild */ }
      }
      const sameInputs = isDevServe && Boolean(sourceFingerprint) && cachedFingerprint === sourceFingerprint
      const freshOutput = (outPath: string): boolean => {
        if (!sameInputs || !existsSync(outPath)) return false
        try { return statSync(outPath).size > 0 } catch { return false }
      }
      const tasks: Promise<unknown>[] = []

      const piEngineOut = resolve(__dirname, 'out/pi-engine/engine.mjs')
      const piCompletionOut = resolve(__dirname, 'out/pi-engine/text-completion.mjs')
      if (!freshOutput(piEngineOut) || !freshOutput(piCompletionOut)) {
        tasks.push(esbuild.build({
          entryPoints: {
            engine: resolve(__dirname, 'src/main/services/pi/engine.ts'),
            'text-completion': resolve(__dirname, 'src/main/services/pi/engine/text-completion.ts')
          },
          outdir: resolve(__dirname, 'out/pi-engine'),
          outExtension: { '.js': '.mjs' },
          bundle: true,
          packages: 'external',
          platform: 'node',
          format: 'esm',
          target: 'node24',
          logLevel: 'warning'
        }))
      }

      for (const [entry, filename] of ROLE_TARGETS) {
        const outfile = resolve(__dirname, 'out/main', filename)
        if (freshOutput(outfile)) continue
        tasks.push(esbuild.build({
          entryPoints: [resolve(__dirname, entry)],
          outfile,
          bundle: true,
          packages: 'external',
          external: ['electron'],
          format: 'cjs',
          platform: 'node',
          target: 'node22',
          logLevel: 'warning'
        }))
      }

      for (const [entry, filename] of WORKER_TARGETS) {
        const outfile = resolve(__dirname, 'out/main', filename)
        if (freshOutput(outfile)) continue
        tasks.push(esbuild.build({
          entryPoints: [resolve(__dirname, entry)],
          outfile,
          bundle: true,
          format: 'cjs',
          platform: 'node',
          target: 'node22',
          logLevel: 'warning'
        }))
      }

      await Promise.all(tasks)
      if (isDevServe && sourceFingerprint) {
        try {
          mkdirSync(resolve(__dirname, 'node_modules/.cache/trellis-panel'), { recursive: true })
          writeFileSync(stampPath, JSON.stringify({ fingerprint: sourceFingerprint }))
        } catch { /* ignore */ }
      }
    }
  }
}

export default defineConfig(({ command }) => ({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      bundleMainCompanions(command === 'serve')
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/bootstrap.ts'),
          gui: resolve(__dirname, 'src/main/index.ts')
        },
        // Sibling role bundles emitted in closeBundle are resolved at runtime from out/main.
        // gui + desktop-runtime-deps are code-split by Rollup so module singletons stay unified.
        external: ['electron', './gui-scope.js', './daemon-host.js', './daemon-control.js', './daemon-maintenance.js'],
        output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: 'gui-shared-[name]-[hash].js' }
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
      // 对标 t3code：预先把首屏、图标库、编辑器、Markdown 与状态管理重型依赖全部预构建为单文件缓存，
      // 消除 dev 模式下打开主窗和首次点击「对话」时上千个 ESM 小模块请求与中途触发重打包的 2-4s 卡顿。
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zustand',
        'clsx',
        'lucide-react',
        '@base-ui/react',
        '@floating-ui/dom',
        '@legendapp/list/react',
        'zod',
        'effect',
        'effect/Effect',
        'effect/Schema',
        'effect/Option',
        'react-markdown',
        'remark-gfm',
        'rehype-sanitize',
        'dompurify',
        'marked',
        '@pierre/diffs',
        '@tiptap/core',
        '@tiptap/react',
        '@tiptap/react/menus',
        '@tiptap/markdown',
        '@tiptap/starter-kit',
        '@tiptap/extension-list',
        '@tiptap/extension-table',
        '@tiptap/pm/model',
        '@tiptap/pm/state',
        '@tiptap/pm/history'
      ]
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
      strictPort: true,
      // 对标 t3code server.warmup：仅预热轻量受限首屏入口 ./src/main.tsx（及其全局样式），
      // 避免一次性把 7 个巨型业务模块压入 Vite 单线程导致首窗请求排队阻塞数秒；
      // 主应用与对话工作台分包在首窗亮屏后、后台连接期间由 preloadApp 异步预取。
      warmup: {
        clientFiles: ['./src/main.tsx']
      }
    },
    plugins: [reactHookRefresh(resolve(__dirname, 'src/renderer/src')), react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html'), 'docx-preview': resolve(__dirname, 'src/renderer/docx-preview.html') }
      }
    }
  }
}))
