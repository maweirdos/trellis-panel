import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, parse, resolve } from 'node:path'
import { RESERVED_RUNTIME_IDS } from './runtime-catalog'
import { acpLocalProviderSaveSchema, type AcpLocalProviderRecord, type AcpLocalProviderSaveInput, type AcpProviderLaunchProvenance } from '../../../shared/acp-provider-ecosystem'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { readLocalProviderStore, writeLocalProviderStore } from './provider-store'

const MAX_PROVIDERS = 64
const RESERVED_PROVIDER_IDS = RESERVED_RUNTIME_IDS
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat'])

export class LocalProviderValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalProviderValidationError' }
}

function canonicalExecutable(input: string): string {
  if (!isAbsolute(input) || /^[a-z]:[\\/]/i.test(input) === false || input.startsWith('\\\\')) {
    throw new LocalProviderValidationError('可执行文件必须使用本地盘符绝对路径')
  }
  const lexical = resolve(input)
  let real: string
  try {
    const link = lstatSync(lexical)
    if (!link.isFile()) throw new LocalProviderValidationError('可执行文件必须是普通文件，不能是目录或设备')
    real = realpathSync.native(lexical)
  } catch (error) {
    if (error instanceof LocalProviderValidationError) throw error
    throw new LocalProviderValidationError('可执行文件不存在或不可读取')
  }
  const samePath = process.platform === 'win32' ? real.toLowerCase() === lexical.toLowerCase() : real === lexical
  if (!samePath) throw new LocalProviderValidationError('拒绝链接或 junction 路径')
  if (process.platform === 'win32' && !WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(lexical).toLowerCase())) {
    throw new LocalProviderValidationError('Windows 仅支持 .exe、.cmd 或 .bat 可执行文件')
  }
  const file = statSync(lexical, { bigint: true })
  if (!file.isFile()) throw new LocalProviderValidationError('可执行文件必须是普通文件')
  try { accessSync(lexical, constants.X_OK) } catch { throw new LocalProviderValidationError('当前用户没有可执行权限') }
  return process.platform === 'win32' ? lexical.replace(/[\\/]+$/, '').toLowerCase() : lexical
}

function provenance(executable: string): AcpProviderLaunchProvenance {
  const file = statSync(executable, { bigint: true })
  return {
    executable,
    realpath: realpathSync.native(executable),
    dev: String(file.dev),
    ino: String(file.ino),
    size: Number(file.size),
    mtimeNs: String(file.mtimeNs),
    ctimeNs: String(file.ctimeNs),
    birthtimeNs: file.birthtimeNs ? String(file.birthtimeNs) : undefined,
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex')
  }
}

function sameProvenance(left: AcpProviderLaunchProvenance, right: AcpProviderLaunchProvenance): boolean {
  return left.executable === right.executable && left.realpath === right.realpath && left.dev === right.dev
    && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs && left.sha256 === right.sha256
}

function providerEnv(provider: AcpLocalProviderRecord): Record<string, string> {
  return Object.fromEntries(provider.env.map(item => [process.platform === 'win32' ? item.key.toUpperCase() : item.key, item.value]))
}

function normalize(input: unknown): AcpLocalProviderSaveInput {
  return acpLocalProviderSaveSchema.parse(input)
}

export function listLocalProviders(userData: string): AcpLocalProviderRecord[] {
  return structuredClone(readLocalProviderStore(userData).providers)
}

export function saveLocalProvider(userData: string, input: unknown): { ok: true; provider: AcpLocalProviderRecord } | IpcFail {
  try {
    const value = normalize(input)
    const store = readLocalProviderStore(userData)
    if (RESERVED_PROVIDER_IDS.has(value.agentId.toLowerCase())) return ipcFail(IpcErrorCode.InvalidArg, '本地 provider 不能覆盖内置执行引擎 ID')
    if (store.providers.some(item => item.agentId.toLowerCase() === value.agentId.toLowerCase() && item.id !== value.id)) return ipcFail(IpcErrorCode.Conflict, '本地 provider agent ID 与现有记录冲突')
    if (value.argv.some(arg => /\0/.test(arg))) return ipcFail(IpcErrorCode.InvalidArg, '启动参数不能包含空字节')
    const executable = canonicalExecutable(value.executable)
    const record: AcpLocalProviderRecord = {
      schemaVersion: 1,
      id: value.id ?? `local-${randomUUID()}`,
      source: 'local',
      agentId: value.agentId,
      name: value.name,
      executable,
      argv: [...value.argv],
      env: value.env.map(item => ({ ...item })),
      enabled: value.enabled,
      provenance: provenance(executable),
      savedAt: Date.now()
    }
    if (value.id && !store.providers.some(item => item.id === value.id) && store.providers.length >= MAX_PROVIDERS) return ipcFail(IpcErrorCode.Busy, '本地 provider 数量已达上限')
    if (!value.id && store.providers.length >= MAX_PROVIDERS) return ipcFail(IpcErrorCode.Busy, '本地 provider 数量已达上限')
    const index = store.providers.findIndex(item => item.id === record.id)
    if (index >= 0) store.providers[index] = record
    else store.providers.push(record)
    if (new Set(store.providers.map(item => item.id)).size !== store.providers.length) return ipcFail(IpcErrorCode.Conflict, 'provider ID 已存在')
    if (new Set(store.providers.map(item => item.agentId)).size !== store.providers.length) return ipcFail(IpcErrorCode.Conflict, 'provider agent ID 已存在')
    writeLocalProviderStore(userData, store)
    return { ok: true, provider: structuredClone(record) }
  } catch (error) {
    return ipcFail(IpcErrorCode.InvalidArg, error instanceof Error ? error.message : '本地 provider 保存失败')
  }
}

export function deleteLocalProvider(userData: string, id: string): { ok: true } | IpcFail {
  const store = readLocalProviderStore(userData)
  const next = store.providers.filter(item => item.id !== id)
  if (next.length === store.providers.length) return ipcFail(IpcErrorCode.NotFound, '本地 provider 不存在')
  writeLocalProviderStore(userData, { schemaVersion: 1, providers: next })
  return { ok: true }
}

export function resolveAdmittedLocalProvider(userData: string, id: string): AcpLocalProviderRecord {
  const provider = readLocalProviderStore(userData).providers.find(item => item.id === id)
  if (!provider || provider.schemaVersion !== 1) throw new LocalProviderValidationError('本地 provider 不存在或记录不可读取')
  if (!provider.enabled) throw new LocalProviderValidationError('本地 provider 已停用')
  validateSavedProviderRecordShape(provider)
  const current = canonicalExecutable(provider.executable)
  if (current !== provider.executable) throw new LocalProviderValidationError('provider 可执行路径已漂移，请重新保存后再启动')
  if (!sameProvenance(provider.provenance, provenance(current))) throw new LocalProviderValidationError('provider 启动来源已变化，请重新保存后再启动')
  return provider
}

type LocalProviderSnapshot = { id?: string; launchKind?: string; executable?: string; args?: string[]; env?: Array<{ key: string; value: string }> }

export function validateLocalProviderSnapshot(userData: string, runtime: LocalProviderSnapshot): AcpLocalProviderRecord | undefined {
  if (runtime.launchKind !== 'local') return undefined
  const provider = resolveAdmittedLocalProvider(userData, runtime.id ?? '')
  const sameLaunch = provider.executable === runtime.executable
    && JSON.stringify(provider.argv) === JSON.stringify(runtime.args ?? [])
    && JSON.stringify(provider.env) === JSON.stringify(runtime.env ?? [])
  if (!sameLaunch) throw new LocalProviderValidationError('本地 provider 启动快照与保存记录不一致')
  return provider
}

export function localProviderLaunchEnvironment(userData: string, runtime: LocalProviderSnapshot): Record<string, string> {
  const provider = validateLocalProviderSnapshot(userData, runtime)
  if (!provider) throw new LocalProviderValidationError('本地 provider 定义无效')
  return providerEnv(provider)
}

export function validateSavedProviderRecordShape(record: AcpLocalProviderRecord): void {
  if (RESERVED_PROVIDER_IDS.has(record.agentId.toLowerCase())) throw new LocalProviderValidationError('本地 provider 记录覆盖了内置 ID，已拒绝执行')
  if (!isAbsolute(record.executable)) throw new LocalProviderValidationError('本地 provider 记录缺少绝对路径，已拒绝执行')
  if (parse(record.executable).root === '\\\\') throw new LocalProviderValidationError('本地 provider 记录使用远程路径，已拒绝执行')
}
