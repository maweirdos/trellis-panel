import { dirname, join, sep } from 'path'

/**
 * 主进程邻位 worker 产物定位（G1-B 打包验证修复）。
 *
 * worker_threads 无法从 asar 归档内加载文件：electron-vite 开发/构建产物在
 * out/main/ 下与主 bundle 邻位，打包后被收进 app.asar——因此 electron-builder
 * 以 asarUnpack 将 `out/main/*-worker.js` 解包到 `app.asar.unpacked/`，加载
 * 侧必须把 asar 路径重写为真实文件路径（.unpacked）。开发环境路径不含
 * app.asar 段，原样返回。
 */
export function neighborWorkerFile(workerFileName: string, envKey: string): string {
  const fromEnv = process.env[envKey]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  if (typeof __filename !== 'string') {
    throw new Error(`${workerFileName} 未定位（当前为 ESM 运行环境）：请设置 ${envKey}`)
  }
  const neighbor = join(dirname(__filename), workerFileName)
  const marker = `${sep}app.asar${sep}`
  const idx = neighbor.lastIndexOf(marker)
  if (idx !== -1) {
    return `${neighbor.slice(0, idx)}${sep}app.asar.unpacked${sep}${neighbor.slice(idx + marker.length)}`
  }
  return neighbor
}
