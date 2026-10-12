import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { LocalControlStore } from './control-store'
import {
  dirExists,
  expectedDefaultPrd,
  issueIdentifierOf,
  isArchivedDir,
  operationIdFor,
  readTaskJsonId,
  scanDiskForReconciliation,
  sha256Hex,
  slugFor,
  todayPrefix
} from './operations'
import { runTaskCreateCli, runTaskArchiveCli } from './cli-runner'
import { atomicWriteText, readFileHash, renderSourcePrd } from './prd'
import {
  CREATED_STAGES,
  META_JIRA_INSTANCE_ID,
  META_JIRA_ISSUE_ID,
  META_JIRA_ISSUE_KEY,
  META_OPERATION_ID,
  META_SOURCE_UPDATED_AT_MS,
  RESUMABLE_STAGES,
  createFromJiraInputSchema,
  type CreateFromJiraInput,
  type CreateOrOpenResult,
  type LocalOperationKey,
  type LocalOperationPayload,
  type LocalOperationRow,
  type LocalTaskStage
} from './types'

/**
 * LocalTaskService（S0 G4 第一片，design §7.2）：Jira → 本地轻任务的单一创建器。
 *
 * 步骤链（每步落控制库，失败可恢复）：
 *   registered →（task.py create --no-start，--meta 扁平恢复标识，禁 --force）
 *   → cli_created →（最小 PRD 来源草稿，原子替换；用户已改则保留）
 *   → prd_written →（source_links 关联 + task_aliases 登记）→ linked →（验证）→ ready
 *
 * 恢复红线：
 * - 控制库操作记录提交失败 → 不调用 CLI（零创建副作用）。
 * - 每次先按 operationId/来源对账真实目录：已有骨架只续写不重复 create；
 *   未创建且跨日 → 先原子更新预备目录再 create；同名不同 operationId → 冲突保持可见；
 *   多候选目录 → 冲突保持可见；曾 ready 后目录消失 → missing 可见，不自动重建。
 * - 不设会话当前任务指针（--no-start）；不覆盖用户已有修改。
 * - 重复点击默认打开已有任务；一单多任务必须显式 allowAdditional（新增序号）。
 *
 * 并发互斥：同操作键（workspaceId+instanceId+issueIdentifier）进程内串行；
 * 控制库 operationId 主键 + CLI 自身的同名拒绝兜底跨进程重复。
 */

export type {
  CreateFromJiraInput,
  CreateOrOpenResult,
  LocalOperationKey,
  LocalOperationPayload,
  LocalOperationRow,
  LocalTaskStage
} from './types'
export { LocalControlStore, localRuntimeDirOf, controlDbExists } from './control-store'
export { jiraInstanceIdFor } from '../jira-instance'
export {
  slugFor,
  todayPrefix,
  scanDiskForReconciliation,
  expectedDefaultPrd,
  issueIdentifierOf,
  operationIdFor,
  sha256Hex,
  dirExists
} from './operations'
export { renderSourcePrd, fenceFor, PRD_DESCRIPTION_LIMIT_BYTES } from './prd'
export { runTaskCreateCli, runTaskArchiveCli } from './cli-runner'
export type { TaskCliRunResult } from './cli-runner'

/** workspaceId：观测绑定存在时沿用其 workspaceId；未绑定项目用 canonical root 派生（本机稳定）。 */
export function workspaceIdForRoot(root: string): string {
  const runtimeDir = join(resolve(root), '.trellis', '.panel', 'runtime')
  try {
    const raw = JSON.parse(readFileSync(join(runtimeDir, 'binding.json'), 'utf-8')) as { workspaceId?: unknown }
    if (typeof raw.workspaceId === 'string' && raw.workspaceId.length > 0) return raw.workspaceId
  } catch {
    /* 未绑定/不可读 → root 派生 */
  }
  return `root-${sha256Hex(resolve(root)).slice(0, 16)}`
}

export interface LocalTaskRunHooks {
  /** 冒烟注入：CLI 成功且记录已推进到 cli_created 后模拟中断（抛错即中断）。 */
  afterCliCreated?: (dirName: string) => void
  /** 冒烟注入：PRD 写入后模拟中断。 */
  afterPrdWritten?: (dirName: string) => void
  /** 冒烟注入：替换 CLI 执行器。 */
  cliRunner?: typeof runTaskCreateCli
  /** 冒烟注入：预置控制库连接（如故意失败的桩）。 */
  controlStore?: LocalControlStore
  /** 冒烟注入：python 命令。 */
  pythonCommand?: string
}

/* 同键并发互斥：operationKey → in-flight promise */
const inflight = new Map<string, Promise<CreateOrOpenResult>>()

function tasksDirOf(root: string): string {
  return join(resolve(root), '.trellis', 'tasks')
}

function dirNameOf(repoRelativeDir: string): string {
  const parts = repoRelativeDir.split('/')
  return parts[parts.length - 1]
}

function buildPayload(input: CreateFromJiraInput, key: LocalOperationKey, slug: string): LocalOperationPayload {
  const fetchedAtMs = input.fetchedAtMs ?? Date.now()
  const description = input.description ?? null
  return {
    operationKey: key,
    slug,
    prepDir: `${todayPrefix()}-${slug}`,
    finalDir: null,
    source: {
      issueKey: input.issueKey,
      issueId: input.issueId ?? null,
      instanceId: input.instanceId,
      url: input.url,
      updatedAtMs: input.updatedAtMs ?? null,
      fetchedAtMs,
      title: input.title,
      summaryDescription: input.summaryDescription,
      descriptionBytes: description !== null ? Buffer.byteLength(description, 'utf-8') : null,
      descriptionSha256: description !== null ? sha256Hex(description) : null,
      truncated: false
    },
    prdBaselineSha256: null,
    attempts: 0
  }
}

/** 入口：从 Jira 行创建或打开本地任务。 */
export async function createOrOpenTaskFromJira(rawInput: unknown, hooks: LocalTaskRunHooks = {}): Promise<CreateOrOpenResult> {
  const parsed = createFromJiraInputSchema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? '参数不合法'
    return { ok: false, code: 'invalid', error: `创建参数非法：${first}` }
  }
  const input = parsed.data
  const workspaceId = workspaceIdForRoot(input.root)
  const issueIdentifier = issueIdentifierOf(input.issueId ?? null, input.issueKey)
  const mutexKey = `${workspaceId}|${input.instanceId}|${issueIdentifier}`
  const existing = inflight.get(mutexKey)
  if (existing !== undefined) return existing
  const run = runCreateOrOpen(input, { workspaceId, issueIdentifier }, hooks).finally(() => {
    inflight.delete(mutexKey)
  })
  inflight.set(mutexKey, run)
  return run
}

async function runCreateOrOpen(
  input: CreateFromJiraInput,
  ids: { workspaceId: string; issueIdentifier: string },
  hooks: LocalTaskRunHooks
): Promise<CreateOrOpenResult> {
  const root = resolve(input.root)
  const tasksRoot = tasksDirOf(root)
  const cliRunner = hooks.cliRunner ?? runTaskCreateCli
  const cliOptions = { root, pythonCommand: hooks.pythonCommand }

  // ① 控制库：打开失败 → 不调用 CLI（零副作用，design §7.2/G3 铁律）
  let store: LocalControlStore
  const ownStore = hooks.controlStore === undefined
  try {
    store = hooks.controlStore ?? openStore(root)
  } catch (e) {
    return { ok: false, code: 'control_store', error: e instanceof Error ? e.message : String(e) }
  }
  try {
    // ② 磁盘对账（panel_operation_id / panel_jira_issue_key / 旧 meta.jiraKey 双索引）
    const disk = scanDiskForReconciliation(root)
    const keyBase = { workspaceId: ids.workspaceId, instanceId: input.instanceId, issueIdentifier: ids.issueIdentifier }
    const priorOps = store.findOperationsByKey(keyBase)

    // ③ 重复点击默认打开已有任务：优先真实磁盘（含旧流程创建、无 op 记录的任务）。
    //    但存在可续跑（中断中）操作时不得短路——必须走 ④⑤ 的恢复管线补完创建。
    if (input.allowAdditional === false) {
      const byKey = disk.byIssueKey.get(input.issueKey.toUpperCase()) ?? []
      const hasResumable = priorOps.some((r) => RESUMABLE_STAGES.includes(r.stage))
      if (!hasResumable) {
        if (byKey.length === 1) {
          return {
            ok: true,
            dirName: dirNameOf(byKey[0]),
            created: false,
            already: true,
            operationId: priorOps.length > 0 ? priorOps[priorOps.length - 1].operationId : '',
            stage: 'ready',
            notes: [isArchivedDir(byKey[0]) ? '该工单关联任务已归档' : '该工单已有本地任务，已直接打开'],
            archived: isArchivedDir(byKey[0])
          }
        }
        if (byKey.length > 1) {
          return { ok: false, code: 'conflict', error: `该工单关联了多个本地任务目录，无法自动选择：${byKey.map(dirNameOf).join(', ')}` }
        }
      }
    }

    // ④ 选定操作记录：存在可续跑记录 → 恢复；否则新序号（allowAdditional 显式新增）
    let row: LocalOperationRow
    const resumable = input.allowAdditional === false ? priorOps.filter((r) => RESUMABLE_STAGES.includes(r.stage)) : []
    if (resumable.length > 0) {
      row = resumable[resumable.length - 1] // 最近一次显式新增的序号
    } else {
      const ordinal = store.maxOrdinal(keyBase) + 1
      // 一单多任务的显式新增序号也体现在 slug 上（同日同名会被 CLI 拒绝；用户未显式命名时追加序号）
      const derived = slugFor(input.issueKey, input.title)
      const slug = input.slug ?? (ordinal > 1 ? `${derived}-${ordinal}` : derived)
      const key: LocalOperationKey = { ...keyBase, ordinal }
      const operationId = operationIdFor(key)
      // 控制库提交是 CLI 的前置；提交失败 → 抛出、不调用 CLI
      row = store.insertOperation(operationId, ids.workspaceId, 'registered', buildPayload(input, key, slug))
    }
    const operationId = row.operationId
    const notes: string[] = []
    // created 语义：进入本调用前 CLI 尚未成功（registered/failed）且本调用完成了创建
    const creatingFresh = row.stage === 'registered' || row.stage === 'failed'

    // ⑤ 对账本 operationId 的真实目录
    const ownDirs = disk.byOperationId.get(operationId) ?? []
    if (ownDirs.length > 1) {
      safeUpdate(store, operationId, 'conflict', { error: '发现多个目录带同一 operationId，需人工确认' })
      return { ok: false, code: 'conflict', error: `发现多个目录带同一 operationId（${ownDirs.join(', ')}），保持可见待人工确认`, operationId }
    }
    if (ownDirs.length === 1 && isArchivedDir(ownDirs[0])) {
      return { ok: true, dirName: dirNameOf(ownDirs[0]), created: false, already: true, operationId, stage: row.stage, notes: ['关联任务已归档'], archived: true }
    }

    let finalDir: string | null = ownDirs.length === 1 ? ownDirs[0] : null
    if (finalDir === null && CREATED_STAGES.includes(row.stage)) {
      // 曾推进到创建后阶段但目录消失（活跃/归档均无）→ missing 可见，不自动重建
      safeUpdate(store, operationId, 'missing', { error: '关联任务目录消失（未在活跃/归档区找到）' })
      return { ok: false, code: 'conflict', error: '关联任务目录不存在（可能被移动或删除），已标记 missing 待人工确认，不自动重建', operationId }
    }
    if (finalDir !== null && row.stage === 'ready') {
      return { ok: true, dirName: dirNameOf(finalDir), created: false, already: true, operationId, stage: 'ready', notes, archived: false }
    }
    if (finalDir !== null && row.stage === 'registered') {
      notes.push('检测到 CLI 已创建目录但操作记录未推进（中断恢复），续写而不重复 create')
    }

    // ⑥ 未创建 →（跨日先原子更新预备目录）→ CLI create
    if (finalDir === null) {
      const today = todayPrefix()
      let prepDir = row.payload.prepDir
      if (!prepDir.startsWith(`${today}-`)) {
        // 跨午夜：CLI 目录前缀取执行当天——先原子更新控制库预备目录，再 create
        prepDir = `${today}-${row.payload.slug}`
        store.updateOperation(operationId, 'registered', { prepDir })
        notes.push(`跨日恢复：预备目录已从 ${row.payload.prepDir} 原子更新为 ${prepDir}`)
      }
      // 同名不同 operationId 预检（CLI 自身同名拒绝为兜底；从不传 --force）
      const prepAbs = join(tasksRoot, prepDir)
      if (dirExists(prepAbs)) {
        const occupant = disk.byOperationId
        let owner: string | null = null
        for (const [op, dirs] of occupant) {
          if (dirs.includes(`.trellis/tasks/${prepDir}`)) owner = op
        }
        if (owner === null) {
          safeUpdate(store, operationId, 'conflict', { error: `预备目录 ${prepDir} 已存在且不携带面板恢复标识（手工或旧流程创建）` })
          return {
            ok: false,
            code: 'conflict',
            error: `任务目录 ${prepDir} 已存在且不携带面板恢复标识（手工或旧流程创建），保持可见待确认；不使用 --force`,
            operationId
          }
        }
        if (owner !== operationId) {
          safeUpdate(store, operationId, 'conflict', { error: `预备目录被其他操作占用` })
          return {
            ok: false,
            code: 'conflict',
            error: `任务目录 ${prepDir} 已属于其他操作（同名不同 operationId），不覆盖；请换用新 slug 或显式处理`,
            operationId
          }
        }
        // owner === operationId：对账未命中但目录在（task.json 尚不可读等）→ 不强采，转冲突可见
        safeUpdate(store, operationId, 'conflict', { error: `预备目录存在但 task.json 无法对账` })
        return { ok: false, code: 'conflict', error: `任务目录 ${prepDir} 存在但 task.json 无法读取对账，保持可见待人工确认`, operationId }
      }

      // --meta 扁平键：时间值显式校验（非法/缺失 → 整键省略，不写垃圾值）
      const meta: Array<[string, string]> = [
        [META_OPERATION_ID, operationId],
        [META_JIRA_INSTANCE_ID, input.instanceId],
        [META_JIRA_ISSUE_KEY, input.issueKey]
      ]
      if (input.issueId !== null && input.issueId !== undefined) meta.push([META_JIRA_ISSUE_ID, String(input.issueId)])
      const updatedAtMs = input.updatedAtMs ?? null
      if (updatedAtMs !== null && Number.isSafeInteger(updatedAtMs) && updatedAtMs > 0) {
        meta.push([META_SOURCE_UPDATED_AT_MS, String(updatedAtMs)])
      }
      const res = await cliRunner(cliOptions, {
        title: input.title,
        description: input.summaryDescription.trim() !== '' ? input.summaryDescription : input.title,
        slug: row.payload.slug,
        assignee: input.assignee,
        priority: input.priority,
        meta
      })
      if (res.code !== 0 || res.aborted || res.failedToStart) {
        // CLI 失败：不留半成品（python 自清理 + 本侧不采未知目录）；记录原因可重试
        const reason = res.aborted ? '执行超时被终止（超时≠成功）' : res.failedToStart ? 'task.py 无法启动' : `退出码 ${res.code}`
        const detail = tailOf(stripAbsPaths(res.stderr))
        safeUpdate(store, operationId, 'failed', { error: `${reason}：${detail}` })
        return { ok: false, code: 'cli_failed', error: `task.py create 失败（${reason}）：${detail}`, operationId }
      }
      // 验证以 fs 为准（输出解析只是线索，不作为成功依据）
      const fresh = scanDiskForReconciliation(root)
      const found = fresh.byOperationId.get(operationId) ?? []
      if (found.length === 1) {
        finalDir = found[0]
      } else {
        const detail = res.createdDirName !== null ? `（CLI 输出目录 ${res.createdDirName} 未带上本操作标识）` : ''
        safeUpdate(store, operationId, 'failed', { error: `CLI 成功但未找到可核实的任务目录${detail}` })
        return { ok: false, code: 'cli_failed', error: `CLI 成功但未找到携带本操作恢复标识的任务目录${detail}，不采纳`, operationId }
      }
      // 基线快照：CLI 默认 PRD 的哈希（后续判定用户是否改过）
      const baseline = readFileHash(join(tasksRoot, dirNameOf(finalDir), 'prd.md'))
      store.updateOperation(operationId, 'cli_created', {
        finalDir,
        prepDir: dirNameOf(finalDir),
        prdBaselineSha256: baseline !== null ? baseline.sha256 : null
      })
      row = store.getOperation(operationId) ?? row
      try {
        hooks.afterCliCreated?.(dirNameOf(finalDir))
      } catch (e) {
        return { ok: false, code: 'interrupted', error: `CLI 创建后中断（目录已保留，可恢复）：${e instanceof Error ? e.message : String(e)}`, operationId }
      }
    }

    const dirName = dirNameOf(finalDir)
    const taskDirAbs = join(tasksRoot, dirName)

    // ⑦ PRD 来源草稿（原子替换；已过该阶段不重写；用户已改则保留）
    const prdPath = join(taskDirAbs, 'prd.md')
    if (row.stage === 'cli_created' || row.stage === 'registered' || row.stage === 'failed') {
      const current = readFileHash(prdPath)
      const baselineSha = row.payload.prdBaselineSha256
      const expected = expectedDefaultPrd(row.payload.source.title, cliDescriptionOf(row.payload))
      const pristine =
        current === null
          ? true // prd.md 缺失 → 重建草稿
          : baselineSha !== null
            ? current.sha256 === baselineSha
            : // 控制库无基线（极端中断）→ 模板判定（python write_text 在 Windows 写 CRLF，先归一化）
              current.content.replace(/\r\n/g, '\n') === expected
      if (pristine) {
        const rendered = renderSourcePrd({
          issueKey: input.issueKey,
          issueId: input.issueId ?? null,
          instanceId: input.instanceId,
          url: input.url,
          updatedAtMs: input.updatedAtMs ?? null,
          fetchedAtMs: row.payload.source.fetchedAtMs,
          title: input.title,
          summaryDescription: input.summaryDescription,
          description: input.description ?? null
        })
        atomicWriteText(prdPath, rendered.content)
        store.updateOperation(operationId, 'prd_written', { finalDir, stageDetail: rendered.truncated ? 'prd_truncated_marked' : undefined })
        try {
          hooks.afterPrdWritten?.(dirName)
        } catch (e) {
          return { ok: false, code: 'interrupted', error: `PRD 写入后中断（可恢复）：${e instanceof Error ? e.message : String(e)}`, operationId }
        }
      } else {
        notes.push('prd.md 已被修改（非 CLI 原样），保留用户内容不覆盖；来源草稿未写入')
      }
    }

    // ⑧ 关联登记 + 别名（source_links / task_aliases；清理观测不得触碰）
    const trellisTaskId = readTaskJsonId(root, finalDir)
    const taskRef = trellisTaskId !== null ? `task:${trellisTaskId}` : `dir:${finalDir}`
    store.insertSourceLink({
      workspaceId: ids.workspaceId,
      sourceKind: 'jira',
      sourceKey: `${input.instanceId}#${input.issueId ?? input.issueKey}`,
      taskRef,
      payload: {
        operationId,
        issueKey: input.issueKey,
        issueId: input.issueId ?? null,
        url: input.url,
        updatedAtMs: input.updatedAtMs ?? null,
        fetchedAtMs: row.payload.source.fetchedAtMs
      }
    })
    store.upsertAlias(taskRef, trellisTaskId, finalDir)
    store.updateOperation(operationId, 'linked', { finalDir })

    // ⑨ 最终验证 → ready（不凭阶段宣称，重读核实）
    const taskJson = readFileHash(join(taskDirAbs, 'task.json'))
    let metaOk = false
    if (taskJson !== null) {
      try {
        const parsed = JSON.parse(taskJson.content) as { meta?: Record<string, unknown> }
        metaOk = parsed.meta?.panel_operation_id === operationId
      } catch {
        metaOk = false
      }
    }
    if (!metaOk || readFileHash(prdPath) === null) {
      safeUpdate(store, operationId, 'failed', { error: '最终验证未通过（task.json 恢复标识或 prd.md 缺失）' })
      return { ok: false, code: 'conflict', error: '任务目录最终验证未通过（恢复标识或 prd.md 缺失），已保留目录待人工检查', operationId }
    }
    store.updateOperation(operationId, 'ready', { finalDir, error: undefined })
    return { ok: true, dirName, created: creatingFresh, already: !creatingFresh, operationId, stage: 'ready', notes, archived: false }
  } catch (e) {
    return { ok: false, code: 'internal', error: `操作失败：${stripAbsPaths(e instanceof Error ? e.message : String(e))}` }
  } finally {
    if (ownStore) store.close()
  }
}

function cliDescriptionOf(payload: LocalOperationPayload): string {
  return payload.source.summaryDescription.trim() !== '' ? payload.source.summaryDescription : payload.source.title
}

function openStore(root: string): LocalControlStore {
  const store = new LocalControlStore(join(resolve(root), '.trellis', '.panel', 'runtime'))
  store.open()
  return store
}

/** 阶段推进失败不掩盖主流程结果（下次恢复按磁盘重新对账）。 */
function safeUpdate(store: LocalControlStore, operationId: string, stage: LocalTaskStage, patch: Partial<LocalOperationPayload>): void {
  try {
    store.updateOperation(operationId, stage, patch)
  } catch {
    /* 控制库更新失败：以内存判定为准 */
  }
}

function tailOf(text: string): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-3).join(' | ')
}

/** 输出脱敏：剥离本机绝对路径形态（与 observability redactText 同规则；本地实现避免循环依赖）。 */
function stripAbsPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"']*/g, '<path>')
    .replace(/\/(?:[\w.-]+\/)+/g, '<path>/')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
}

/* ---------------- 本地归档（design §7.3：与 Jira 流转分离） ---------------- */

export interface ArchiveLocalTaskResult {
  ok: boolean
  /** 归档后目录名（basename 不变；归档位置见 archivedRepoDir）。 */
  dirName?: string
  /** 仓库相对归档目录（正斜杠）。 */
  archivedRepoDir?: string
  /** 别名登记失败等不影响归档成功的提示。 */
  notes: string[]
  error?: string
}

/**
 * 本地归档：task.py archive 既有语义 + fs 核实移动结果 + 别名更新（G3 task_aliases）。
 * 本地归档成功不因 Jira 失败回滚：两者独立调用，本函数不触碰 Jira（design §7.3）。
 */
export async function archiveLocalTask(
  rootInput: string,
  dirName: string,
  flags: { skipBranchValidation?: boolean; noCommit?: boolean; pythonCommand?: string } = {},
  hooks: { controlStore?: LocalControlStore } = {}
): Promise<ArchiveLocalTaskResult> {
  const root = resolve(rootInput)
  const notes: string[] = []
  const res = await runTaskArchiveCli(
    { root, pythonCommand: flags.pythonCommand },
    dirName,
    { skipBranchValidation: flags.skipBranchValidation, noCommit: flags.noCommit }
  )
  if (res.code !== 0 || res.aborted || res.failedToStart) {
    const reason = res.aborted ? '执行超时被终止（超时≠成功）' : res.failedToStart ? 'task.py 无法启动' : `退出码 ${res.code}`
    return { ok: false, notes, error: `task.py archive 失败（${reason}）：${tailOf(stripAbsPaths(res.stderr))}` }
  }
  // fs 核实：原目录消失 + 归档区出现（不凭退出码宣称成功）
  const active = `.trellis/tasks/${dirName}`
  if (dirExists(join(root, active))) {
    return { ok: false, notes, error: 'archive 返回成功但原目录仍在（不宣称成功，请检查）' }
  }
  let archivedRepoDir: string | null = null
  const disk = scanDiskForReconciliation(root)
  for (const meta of disk.known) {
    if (isArchivedDir(meta.dir) && meta.dir.endsWith(`/${dirName}`)) archivedRepoDir = meta.dir
  }
  if (archivedRepoDir === null) {
    return { ok: false, notes, error: 'archive 返回成功但未在归档区找到任务目录（不宣称成功，请检查）' }
  }
  // 别名更新（归档续接语义：旧目录进 priorDirs；失败不影响归档结果）
  const trellisTaskId = readTaskJsonId(root, archivedRepoDir)
  const taskRef = trellisTaskId !== null ? `task:${trellisTaskId}` : `dir:${active}`
  let store: LocalControlStore | null = null
  const ownStore = hooks.controlStore === undefined
  try {
    store = hooks.controlStore ?? openStore(root)
    store.upsertAlias(taskRef, trellisTaskId, archivedRepoDir)
  } catch (e) {
    notes.push(`别名登记失败（归档已完成，不影响结果）：${stripAbsPaths(e instanceof Error ? e.message : String(e))}`)
  } finally {
    if (ownStore) store?.close()
  }
  return { ok: true, dirName, archivedRepoDir, notes }
}
