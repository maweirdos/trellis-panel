import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { applicationIdSchema, type ApplicationListResult, type ApplicationLogsResult, type ApplicationResult } from '../../../shared/app-runtime'
import { getSnapshot } from '../../state'
import { appRuntime } from '../app-runtime'
import { canonicalDirectory } from '../acp/metadata'
import { getSettings } from '../store'
import { accessEventLog } from './event-log'
import { MutationCache, MutationRequestError } from './mutation-cache'

const projectSchema = z.string().trim().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'))
const readSchema = z.object({ project: projectSchema, appId: applicationIdSchema.optional(), after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict()
const mutationSchema = z.object({ project: projectSchema, appId: applicationIdSchema, confirm: z.literal(true), requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/) }).strict()

interface AccessReply { status: number; payload: Record<string, unknown> }
type RuntimeReply = ApplicationListResult | ApplicationResult | ApplicationLogsResult

function errorReply(code: string, message: string, status: number, extra?: Record<string, unknown>): AccessReply {
  return { status, payload: { ok: false, error: { code, message }, ...extra } }
}

function runtimeReply(result: RuntimeReply, replay = false): AccessReply {
  if (result.ok === true) {
    const { ok: _ok, ...data } = result
    return { status: 200, payload: { ok: true, data, ...(replay ? { idempotentReplay: true } : {}) } }
  }
  const status = { E_INVALID_ARG: 422, E_NO_PROJECT: 404, E_NOT_FOUND: 404, E_UNAUTHORIZED: 401, E_DENIED: 403, E_CONFLICT: 409, E_TIMEOUT: 504, E_IO: 500, E_UPSTREAM: 502, E_UNKNOWN: 500 }[result.code]
  return errorReply(result.code, result.error, status, {
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.root ? { root: result.root } : {}),
    ...(result.appId ? { appId: result.appId } : {}),
    ...(replay ? { idempotentReplay: true } : {})
  })
}

async function knownProject(project: string): Promise<string | null> {
  const canonical = canonicalDirectory(project)
  const current = getSnapshot()?.meta.root
  const known = [...getSettings().recentProjects, ...(current ? [current] : [])]
  if (known.some((root) => canonicalDirectory(root) === canonical) || await appRuntime.knownProject(canonical)) return canonical
  return null
}

export class ApplicationAccessRoutes {
  private mutations = new MutationCache()

  async route(method: string, operation: string, url: URL, readBody: () => Promise<Record<string, unknown>>): Promise<AccessReply> {
    if (method === 'GET' && ['list', 'status', 'logs'].includes(operation)) {
      const parsed = readSchema.safeParse(Object.fromEntries(url.searchParams))
      if (!parsed.success || operation !== 'list' && !parsed.data.appId || operation === 'list' && parsed.data.appId) return errorReply('E_INVALID_ARG', '需要明确的项目路径与应用标识', 422)
      const root = await knownProject(parsed.data.project)
      if (!root) return errorReply('E_NOT_FOUND', '该项目尚未在面板配置，请先打开项目并配置应用', 404)
      if (operation === 'logs') return runtimeReply(await appRuntime.logs(root, parsed.data.appId ?? '', parsed.data.after))
      const listed = await appRuntime.list(root)
      if (listed.ok === false || operation === 'list') return runtimeReply(listed)
      const found = listed.apps.find((candidate) => candidate.definition.id === parsed.data.appId)
      return found ? runtimeReply({ ok: true, root, app: found }) : errorReply('E_NOT_FOUND', '应用不存在，请先在面板配置', 404)
    }
    if (method !== 'POST' || !['start', 'stop', 'restart'].includes(operation)) return errorReply('E_NOT_FOUND', '未知应用操作', 404)
    const body = await readBody()
    if (body.confirm !== true) return errorReply('E_DENIED', '变更操作必须显式携带 confirm: true', 422)
    const parsed = mutationSchema.safeParse(body)
    if (!parsed.success) return errorReply('E_INVALID_ARG', '需要项目、应用标识和有效 requestId；不接受启动命令或授权字段', 422)
    const root = await knownProject(parsed.data.project)
    if (!root) return errorReply('E_NOT_FOUND', '该项目尚未在面板配置，请先打开项目并配置应用', 404)
    const { appId, requestId } = parsed.data
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, root, appId })).digest('hex')
    try {
      const result = await this.mutations.execute(requestId, fingerprint, async () => {
        const value = operation === 'start' ? await appRuntime.start(root, appId) : operation === 'restart' ? await appRuntime.restart(root, appId) : await appRuntime.stop(root, appId)
        accessEventLog.append('access.mutated', { op: `apps/${operation}`, root, appId, ok: value.ok })
        return value
      })
      return runtimeReply(result.value, result.replay)
    } catch (error) {
      if (error instanceof MutationRequestError) return errorReply(error.code, error.message, error.code === 'E_CONFLICT' ? 409 : 429)
      return errorReply('E_IO', '应用操作未完成，请在面板检查实际运行状态', 500)
    }
  }
}

export function appendApplicationAccessEvent(event: { kind: string; root: string; appId: string; runId: string | null; app: { processState: string; readiness: { state: string }; approval: string } }): void {
  if (event.kind === 'output') return
  accessEventLog.append(`application.${event.kind}`, { root: event.root, appId: event.appId, runId: event.runId, processState: event.app.processState, readiness: event.app.readiness.state, approval: event.app.approval })
}

appRuntime.subscribe(appendApplicationAccessEvent)
