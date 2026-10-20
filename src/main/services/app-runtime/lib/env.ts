import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { APP_RUNTIME_LIMITS } from '../../../../shared/app-runtime'
import { AppRuntimeError } from '../types'
import { IpcErrorCode } from '../../../../shared/ipc-errors'

function invalid(file: string, line: number): never { throw new AppRuntimeError(`环境文件 ${basename(file)} 第 ${line} 行格式无效`, IpcErrorCode.InvalidArg) }

/** A deliberately literal, single-line dotenv subset; no shell expansion. */
export function parseEnv(text: string, file = '.env'): Record<string, string> {
  if (Buffer.byteLength(text, 'utf8') > APP_RUNTIME_LIMITS.envFileBytes || text.includes('\0')) throw new AppRuntimeError('环境文件过大或包含无效字符', IpcErrorCode.InvalidArg)
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) invalid(file, index + 1)
    const key = match[1]
    const raw = match[2]
    let value = ''
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0]
      let position = 1
      let closed = false
      while (position < raw.length) {
        const char = raw[position]
        if (char === quote) { position += 1; closed = true; break }
        if (char === '\\' && position + 1 < raw.length) {
          const next = raw[position + 1]
          if (next === quote || next === '\\') { value += next; position += 2; continue }
          if (quote === '"' && next === 'n') { value += '\n'; position += 2; continue }
          if (quote === '"' && next === 'r') { value += '\r'; position += 2; continue }
          if (quote === '"' && next === 't') { value += '\t'; position += 2; continue }
        }
        value += char
        position += 1
      }
      const tail = raw.slice(position).trim()
      if (!closed || (tail && !tail.startsWith('#'))) invalid(file, index + 1)
    } else value = raw.replace(/(^|\s)#.*$/, '').trimEnd()
    if (key.length > 256 || Buffer.byteLength(value) > APP_RUNTIME_LIMITS.envValueBytes) invalid(file, index + 1)
    values[key] = value
    if (Object.keys(values).length > APP_RUNTIME_LIMITS.envKeys) throw new AppRuntimeError('环境变量数量超过限额', IpcErrorCode.InvalidArg)
  }
  return values
}

export function mergeEnvironment(base: NodeJS.ProcessEnv, layers: Record<string, string>[], windows = process.platform === 'win32'): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const names = new Map<string, string>()
  for (const layer of [base, ...layers]) for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    const normalized = windows ? key.toUpperCase() : key
    const previous = names.get(normalized)
    if (previous !== undefined && previous !== key) delete result[previous]
    names.set(normalized, key)
    Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true })
  }
  return result
}

export function loadEnvironment(cwd: string, references: string[], overrides: Record<string, string>): { env: NodeJS.ProcessEnv; secrets: string[]; files: string[] } {
  const layers: Record<string, string>[] = []
  const files = references.map((file) => resolve(cwd, file))
  for (const file of files) {
    try {
      if (statSync(file).size > APP_RUNTIME_LIMITS.envFileBytes) throw new AppRuntimeError('环境文件超过读取限额', IpcErrorCode.InvalidArg)
      layers.push(parseEnv(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)), file))
    } catch (error) {
      if (error instanceof AppRuntimeError) throw error
      throw new AppRuntimeError(`环境文件 ${basename(file)} 无法读取`, IpcErrorCode.Io)
    }
  }
  layers.push(overrides)
  if (new Set(layers.flatMap((layer) => Object.keys(layer).map((key) => process.platform === 'win32' ? key.toUpperCase() : key))).size > APP_RUNTIME_LIMITS.envKeys) throw new AppRuntimeError('合并后的环境变量数量超过限额', IpcErrorCode.InvalidArg)
  const secrets = [...new Set(layers.flatMap((layer) => Object.values(layer)).filter((value) => value.length > 0))]
  return { env: mergeEnvironment(process.env, layers), secrets, files }
}
