import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
await mkdir('dist', { recursive: true })
await build({ entryPoints: { index: 'src/index.ts', cli: 'src/cli.ts', 'store-worker': 'src/store-worker.ts', backup: 'src/backup.ts' }, outdir: 'dist', bundle: true, platform: 'node', target: 'node24', format: 'esm', outExtension: { '.js': '.mjs' }, packages: 'external', sourcemap: true })
