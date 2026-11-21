import { z } from 'zod'

export const ACP_PERMISSION_REVIEW_BYTES = 32 * 1024
const text = z.string().max(ACP_PERMISSION_REVIEW_BYTES)
export const acpPermissionReviewSchema = z.object({
  command: z.string().min(1).max(8192).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  changes: z.array(z.object({
    path: z.string().min(1).max(4096), oldText: text.nullable().optional(),
    newText: text.nullable().optional(), patch: text.optional()
  }).strict()).max(64).optional(),
  details: text,
  unavailable: z.string().min(1).max(500).optional()
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= ACP_PERMISSION_REVIEW_BYTES, 'Permission review exceeds its byte limit')
export type AcpPermissionReview = z.infer<typeof acpPermissionReviewSchema>
export type AcpPermissionToolFacts = {
  kind?: unknown; rawInput?: unknown; content?: unknown; locations?: unknown; _meta?: unknown
  unavailable?: string
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const unavailable = (reason: string): AcpPermissionReview => ({ details: '', unavailable: reason })

/** Exact JSON facts only; never clip text and then claim that an operation is reviewable. */
function boundedJson(value: unknown): string {
  let nodes = 0
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 12) throw Error('oversized')
    if (typeof item === 'string' && item.length > ACP_PERMISSION_REVIEW_BYTES) throw Error('oversized')
    if (item && typeof item === 'object') {
      const entries = Object.entries(item)
      if (entries.length > 256) throw Error('oversized')
      for (const [key, child] of entries) { if (key.length > 1000) throw Error('oversized'); walk(child, depth + 1) }
    }
  }
  walk(value, 0)
  const json = JSON.stringify(value)
  if (json === undefined || new TextEncoder().encode(json).length > ACP_PERMISSION_REVIEW_BYTES) throw Error('oversized')
  return json
}

/** Called on original current-turn tool events, before presentation/history clipping. */
export function captureAcpPermissionToolFacts(value: unknown): AcpPermissionToolFacts {
  const tool = object(value) ?? {}
  const facts: AcpPermissionToolFacts = {}
  for (const key of ['kind', 'rawInput', 'content', 'locations', '_meta'] as const) {
    if (tool[key] !== undefined && tool[key] !== null) facts[key] = tool[key]
  }
  try { return JSON.parse(boundedJson(facts)) as AcpPermissionToolFacts }
  catch { return { unavailable: '操作内容超过可完整展示的范围，请拒绝或停止后核对。' } }
}

/** A display projection of adapter facts, not a command/path authorization policy. */
export function formatAcpPermissionReview(tool: unknown, nativeMeta: unknown, prior: AcpPermissionToolFacts | undefined,
  redact: (text: string) => string): AcpPermissionReview {
  const request = captureAcpPermissionToolFacts(tool)
  if (request.unavailable) return unavailable(request.unavailable)
  if (prior?.content !== undefined && request.content !== undefined && JSON.stringify(prior.content) !== JSON.stringify(request.content)) {
    return unavailable('文件变更内容与原操作不一致，无法核对完整操作，请拒绝或停止后核对。')
  }
  const facts = { ...prior, ...request }
  if (facts.unavailable) return unavailable(facts.unavailable)
  try {
    const details = boundedJson({ tool: facts, ...(nativeMeta == null ? {} : { nativeMeta }) })
    if (redact(details) !== details) return unavailable('操作内容包含受保护的连接信息，无法完整展示，请拒绝或停止后核对。')
    const input = object(facts.rawInput), changes: NonNullable<AcpPermissionReview['changes']> = []
    if (facts.content !== undefined && !Array.isArray(facts.content)) return unavailable('文件操作内容无法核对。')
    for (const item of Array.isArray(facts.content) ? facts.content : []) {
      const content = object(item)
      if (content?.type !== 'diff') continue
      if (typeof content.path !== 'string') return unavailable('文件变更缺少原始路径。')
      const meta = object(content._meta), air = object(object(meta?.jetbrains)?.air), patch = object(air?.diffPatch)
      if (patch) {
        if (patch.version !== 1 || patch.format !== 'git_patch' || typeof patch.text !== 'string') return unavailable('文件变更格式暂不可审查。')
        changes.push({ path: content.path, patch: patch.text })
      } else {
        if (content.oldText !== null && typeof content.oldText !== 'string'
          || content.newText !== null && typeof content.newText !== 'string') return unavailable('文件变更正文不完整。')
        if (typeof content.oldText !== 'string' && typeof content.newText !== 'string') return unavailable('文件变更正文未提供。')
        changes.push({ path: content.path, oldText: content.oldText, newText: content.newText })
      }
    }
    if (facts.kind === 'edit') {
      const locations = Array.isArray(request.locations) ? request.locations : []
      const paths = locations.map(location => typeof location === 'string' ? location : object(location)?.path)
      if (!changes.length || !locations.length || new Set(paths).size !== paths.length
        || new Set(changes.map(change => change.path)).size !== changes.length
        || changes.some(change => !paths.includes(change.path)) || locations.some(location => {
        const path = typeof location === 'string' ? location : object(location)?.path
        return typeof path !== 'string' || !changes.some(change => change.path === path)
      })) return unavailable('执行引擎未提供全部文件变更内容，请拒绝或停止后核对。')
    }
    const command = typeof input?.command === 'string' ? input.command : undefined
    const cwd = typeof input?.cwd === 'string' ? input.cwd : undefined
    if (facts.kind === 'execute' && !command && !changes.length
      && !(typeof input?.server === 'string' && typeof input?.tool === 'string')) return unavailable('执行引擎未提供本次操作的具体内容。')
    if (command !== undefined && !cwd) return unavailable('执行引擎未提供本次命令的运行目录。')
    if (!command && !changes.length && (!input || Object.keys(input).length === 0)) return unavailable('执行引擎未提供可审查的操作内容，请拒绝或停止后核对。')
    const result = acpPermissionReviewSchema.safeParse({
      ...(command === undefined ? {} : { command }), ...(cwd === undefined ? {} : { cwd }),
      ...(changes.length ? { changes } : {}), details
    })
    return result.success ? result.data : unavailable('操作内容超过可完整展示的范围，请拒绝或停止后核对。')
  } catch { return unavailable('操作内容无法完整展示，请拒绝或停止后核对。') }
}

export function isAcpPermissionReviewable(value: AcpPermissionReview | undefined): boolean {
  return Boolean(value && !value.unavailable && (value.command && value.cwd || value.changes?.length || value.details))
}
