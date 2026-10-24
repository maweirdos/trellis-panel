import { lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { z } from 'zod'
import { TaskConversationError } from '../types'
import { readBounded } from './paths'

const MAX_BOOTSTRAP_BYTES = 256 * 1024
const bootstrapSchema = z.object({ dataBaseDir: z.string().min(1).max(4096).optional() })

function directory(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path) || !statSync(path).isDirectory()) {
    throw new TaskConversationError('E_UNAVAILABLE', 'ZCode 原生数据目录无效或不可读取')
  }
  return normalize(path)
}

/** Resolve afresh for discovery; provider configuration and credentials are not needed. */
export function resolveZcodeRoot(explicitRoot?: string): string {
  // Deliberate fixture/diagnostic roots already identify the exact native v2 directory.
  if (explicitRoot !== undefined) return directory(explicitRoot)
  const env = process.env
  let dataBaseDir = env.ZCODE_DATA_BASE_DIR
  if (!dataBaseDir && env.ZCODE_HOME) {
    const home = directory(env.ZCODE_HOME)
    if (basename(home).toLowerCase() !== '.zcode') {
      throw new TaskConversationError('E_UNAVAILABLE', 'ZCODE_HOME 必须指向原生 .zcode 目录')
    }
    dataBaseDir = dirname(home)
  }
  if (!dataBaseDir) {
    const home = directory(env.USERPROFILE || env.HOME || homedir())
    const bootstrap = join(home, '.zcode', 'v2', 'setting.json')
    let exists = true
    try {
      lstatSync(bootstrap)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    if (exists) {
      if (!statSync(bootstrap).isFile()) throw new TaskConversationError('E_UNAVAILABLE', 'ZCode 原生设置不可读取')
      const settings = bootstrapSchema.parse(JSON.parse(readBounded(bootstrap, MAX_BOOTSTRAP_BYTES).replace(/^\uFEFF/, '')))
      dataBaseDir = settings.dataBaseDir
    }
    dataBaseDir ??= home
  }
  return directory(join(directory(dataBaseDir), '.zcode', 'v2'))
}
