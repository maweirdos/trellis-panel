import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConversationDriverDescriptor } from '../../../../../shared/conversation/driverCatalog'
import { readBounded, writeAtomic } from '../../../../daemon/files'
import { pathKey } from '../../../task-conversations/lib/paths'
import { driverActionEvidence, hostUnsupported } from './catalog'

const CACHE_VERSION = 1
const MAX_CACHE_BYTES = 512 * 1024
const CACHE_TTL_MS = 24 * 60 * 60_000
const MAX_RECENT_SLOTS = 4

const recentSlotSchema = z.object({
  cwd: z.string().min(1).max(4096),
  projectId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(128),
  updatedAt: z.number().int().positive(),
})

const recentSlotsFileSchema = z.object({
  version: z.literal(CACHE_VERSION),
  slots: z.array(recentSlotSchema).max(MAX_RECENT_SLOTS),
})

export type RecentDriverSlot = z.infer<typeof recentSlotSchema>

const evidenceSchema = z.object({
  state: z.enum(['verified', 'unsupported', 'unknown']),
  source: z.enum(['native-handshake', 'native-catalog', 'native-session', 'host-policy']),
  detail: z.string(),
})

const descriptorSchema = z.object({
  version: z.string().optional(),
  configurationKey: z.string(),
  observedAt: z.string(),
  source: z.enum(['native-catalog', 'native-session']),
  models: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    isDefault: z.boolean(),
    providerId: z.string().optional(),
    group: z.string().optional(),
  })),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    modelId: z.string().optional(),
    turnSelectable: z.literal(true).optional(),
    category: z.string().optional(),
    current: z.union([z.string(), z.boolean()]).optional(),
    choices: z.array(z.object({
      value: z.string(),
      label: z.string(),
      group: z.string().optional(),
    })),
  })),
  skills: z.array(z.object({
    name: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['app', 'repo', 'personal', 'system', 'other']).optional(),
  })).optional(),
  selectedModel: z.string().optional(),
  actions: z.record(z.string(), evidenceSchema),
})

const cacheEntrySchema = z.object({
  version: z.literal(CACHE_VERSION),
  instanceId: z.string(),
  driverKind: z.string(),
  cwdKey: z.string(),
  ordinaryTask: z.boolean(),
  ownerScope: z.string().optional(),
  configurationFingerprint: z.string(),
  cachedAt: z.number().int().positive(),
  descriptor: descriptorSchema,
})

export interface DriverDescriptorCacheLookup {
  readonly instanceId: string
  readonly driverKind: string
  readonly cwd: string
  readonly ordinaryTask: boolean
  readonly ownerScope?: string
  readonly configurationFingerprint: string
}

/**
 * 对标 t3code BUNDLED_MODEL_MANIFEST：当本机 CLI 已确认安装但当前目录首次尚未生成磁盘缓存时，
 * 为普通个人会话立即返回内置静态兜底模型与推理强度，同时后台启动真实进程刷新为精确原生目录。
 */
export function bundledFallbackDescriptor(
  driverKind: string,
  configurationKey: string,
): ConversationDriverDescriptor | undefined {
  const now = new Date().toISOString()
  if (driverKind === 'codex') {
    const models = [
      { id: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true },
      { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', isDefault: false },
      { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', isDefault: false },
    ]
    const choices = [
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
      { value: 'xhigh', label: '超高' },
    ]
    return {
      source: 'native-catalog',
      provisional: true,
      observedAt: now,
      configurationKey,
      models,
      options: models.map(model => ({
        id: 'reasoningEffort',
        label: '推理强度',
        category: 'reasoning',
        modelId: model.id,
        turnSelectable: true as const,
        current: 'medium',
        choices,
      })),
      actions: driverActionEvidence({
        chat: { state: 'verified', source: 'native-catalog', detail: '已加载内置默认模型目录，后台正在同步原生目录。' },
        steer: { state: 'verified', source: 'host-policy', detail: 'turn/steer 绑定当前原生回合，回执确认目标回合。' },
        planning: hostUnsupported('团队规划的批准工具和项目资料边界尚未接入该入口。'),
        execution: hostUnsupported('当前 Codex 线程固定为只读模式。'),
        toolApproval: hostUnsupported('当前 Codex 线程拒绝临时审批。'),
      }),
    }
  }
  if (driverKind === 'claudeCode') {
    return {
      source: 'native-catalog',
      provisional: true,
      observedAt: now,
      configurationKey,
      models: [
        { id: 'sonnet', displayName: 'Claude Sonnet', isDefault: true },
        { id: 'opus', displayName: 'Claude Opus', isDefault: false },
        { id: 'haiku', displayName: 'Claude Haiku', isDefault: false },
      ],
      options: [],
      actions: driverActionEvidence({
        chat: { state: 'verified', source: 'native-catalog', detail: '已加载内置默认模型目录，后台正在同步原生目录。' },
      }),
    }
  }
  return undefined
}

/**
 * 借鉴 t3code providerStatusCache：在受保护的 daemon 目录下按驱动配置指纹持久化
 * 最近一次真实握手得到的模型/选项/技能目录；冷启动进入项目时先毫秒级水合展示，
 * 同时后台静默启动真实驱动进程刷新缓存。任何配置/凭据变更都会使指纹失效。
 */
export class DriverDescriptorCache {
  private readonly cacheDir: string
  private readonly memory = new Map<string, { configurationFingerprint: string; cachedAt: number; descriptor: ConversationDriverDescriptor }>()

  constructor(protectedDirectory: string) {
    this.cacheDir = join(protectedDirectory, 'driver-catalog-cache')
  }

  private slotKey(input: Omit<DriverDescriptorCacheLookup, 'configurationFingerprint'>): string {
    return JSON.stringify([input.instanceId, input.driverKind, pathKey(input.cwd), input.ordinaryTask, input.ownerScope ?? null])
  }

  private filePath(slotKey: string): string {
    const hash = createHash('sha256').update(slotKey).digest('hex')
    return join(this.cacheDir, `${hash}.json`)
  }

  load(input: DriverDescriptorCacheLookup): ConversationDriverDescriptor | undefined {
    const key = this.slotKey(input)
    const now = Date.now()
    const inMem = this.memory.get(key)
    if (inMem) {
      if (inMem.configurationFingerprint === input.configurationFingerprint && now - inMem.cachedAt < CACHE_TTL_MS) {
        return structuredClone(inMem.descriptor)
      }
      this.memory.delete(key)
    }
    try {
      const file = this.filePath(key)
      if (!existsSync(file)) return undefined
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined
      const parsed = cacheEntrySchema.safeParse(JSON.parse(readBounded(file, MAX_CACHE_BYTES)))
      if (!parsed.success) return undefined
      const entry = parsed.data
      if (
        entry.instanceId !== input.instanceId
        || entry.driverKind !== input.driverKind
        || entry.cwdKey !== pathKey(input.cwd)
        || entry.ordinaryTask !== input.ordinaryTask
        || (entry.ownerScope ?? undefined) !== input.ownerScope
        || entry.configurationFingerprint !== input.configurationFingerprint
        || now - entry.cachedAt >= CACHE_TTL_MS
      ) {
        return undefined
      }
      const descriptor = entry.descriptor as unknown as ConversationDriverDescriptor
      this.memory.set(key, { configurationFingerprint: entry.configurationFingerprint, cachedAt: entry.cachedAt, descriptor })
      return structuredClone(descriptor)
    } catch {
      return undefined
    }
  }

  save(input: DriverDescriptorCacheLookup, descriptor: ConversationDriverDescriptor): void {
    if (descriptor.provisional) return
    const key = this.slotKey(input)
    const cachedAt = Date.now()
    this.memory.set(key, { configurationFingerprint: input.configurationFingerprint, cachedAt, descriptor: structuredClone(descriptor) })
    while (this.memory.size > 64) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const stat = lstatSync(this.cacheDir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      const payload = {
        version: CACHE_VERSION,
        instanceId: input.instanceId,
        driverKind: input.driverKind,
        cwdKey: pathKey(input.cwd),
        ordinaryTask: input.ordinaryTask,
        ...(input.ownerScope !== undefined ? { ownerScope: input.ownerScope } : {}),
        configurationFingerprint: input.configurationFingerprint,
        cachedAt,
        descriptor,
      }
      const serialized = JSON.stringify(payload)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHE_BYTES) return
      writeAtomic(this.filePath(key), serialized)
    } catch { /* 缓存落盘失败绝不影响主流程 */ }
  }

  private recentSlotsPath(): string {
    return join(this.cacheDir, 'recent-slots.json')
  }

  /** 记录最近在普通个人工作区中使用过的 (cwd, projectId, instanceId)，用于下次 daemon 启动时自动后台预热。 */
  recordRecentSlot(slot: Omit<RecentDriverSlot, 'updatedAt'>): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const dirStat = lstatSync(this.cacheDir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return
      const existing = this.listRecentSlots()
      const keyOf = (item: Pick<RecentDriverSlot, 'cwd' | 'instanceId'>): string =>
        `${pathKey(item.cwd)}\0${item.instanceId}`
      const targetKey = keyOf(slot)
      const next: RecentDriverSlot[] = [
        { cwd: slot.cwd, projectId: slot.projectId, instanceId: slot.instanceId, updatedAt: Date.now() },
        ...existing.filter(item => keyOf(item) !== targetKey),
      ].slice(0, MAX_RECENT_SLOTS)
      writeAtomic(this.recentSlotsPath(), JSON.stringify({ version: CACHE_VERSION, slots: next }))
    } catch { /* 预热提示记录失败不影响主流程 */ }
  }

  listRecentSlots(): readonly RecentDriverSlot[] {
    try {
      const file = this.recentSlotsPath()
      if (!existsSync(file)) return []
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return []
      const parsed = recentSlotsFileSchema.safeParse(JSON.parse(readBounded(file, 32 * 1024)))
      if (!parsed.success) return []
      return parsed.data.slots
    } catch {
      return []
    }
  }
}
