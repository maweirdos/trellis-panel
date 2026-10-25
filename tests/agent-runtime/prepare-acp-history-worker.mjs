import { build } from 'esbuild'
import { join } from 'node:path'

/** ACP service smoke bundles are ESM; worker location is an explicit fixture input. */
export async function prepareAcpHistoryWorker(directory) {
  const file = join(directory, 'history-worker.cjs')
  await build({ entryPoints: ['src/main/services/acp/history-worker.ts'], outfile: file,
    bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent' })
  process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = file
  return file
}
