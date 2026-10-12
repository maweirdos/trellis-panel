/**
 * 观测存储冒烟（S0 G3 第一片，design §3/§4；D-SQLITE 契约见 backend/database.md）：
 *   1) 核心直驱（store-core，同步）：插入+usage 同事务一致性、eventId 幂等/冲突、
 *      64KiB 删减与跳过、配额暂停/清理恢复、保留清理、迁移 v1 与不可识别库、
 *      损坏重建（epoch 更换 → resetRequired、原文件保留）、cursor 分页回补（≤100）、
 *      taskRef 归档续接/多候选待确认、清理观测不触碰 control；
 *   2) 绑定身份（identity）：安装身份稳定、首绑/复验、installationId/canonical root
 *      不符 → rebind_required、门禁阻断停采集；
 *   3) 服务链（真实 worker 线程）：无绑定不建文件、enableObservation 全链、
 *      双连接写入→查询可见、订阅增量推送/reset 推送/退订停推、项目切换关闭、
 *      installationId 不符经服务呈现 paused。
 * 运行：node scripts/smoke/observability-store.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import assert from 'node:assert/strict'

const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-observability-store-'))

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const waitFor = async (predicate, timeoutMs, label = '') => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 30))
  }
  return false
}

/* ---------------- 打包：核心/身份/服务 + observation worker ---------------- */

const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${abs('src/main/services/observability/store-core.ts')}'`,
    `export * from '${abs('src/main/services/observability/identity.ts')}'`,
    `export * from '${abs('src/main/services/observability/service.ts')}'`,
    `export * from '${abs('src/main/services/task-identity/index.ts')}'`,
    `export { OBSERVATION_EVENT_ENCODE_LIMIT_BYTES, OBSERVATION_QUERY_PAGE_MAX } from '${abs('src/shared/observability/store.ts')}'`
  ].join('\n'),
  'utf-8'
)
const bundle = join(workDir, 'bundle.mjs')
execFileSync(
  process.execPath,
  [join('node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
  { stdio: 'inherit' }
)
const workerBundle = join(workDir, 'observation-worker.mjs')
execFileSync(
  process.execPath,
  [join('node_modules', 'esbuild', 'bin', 'esbuild'), abs('src/main/services/observability/observation-worker.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${workerBundle}`],
  { stdio: 'inherit' }
)
// ESM bundle 无 __filename：worker 文件必须显式指定（与生产 CJS 邻位定位互补）
process.env.TRELLIS_OBSERVATION_WORKER_FILE = workerBundle
process.env.TRELLIS_OBSERVATION_POLL_MS = '150'

const m = await import(pathToFileURL(bundle).href)
const {
  ObservationStoreCore,
  createOrVerifyBinding,
  ensureInstallationIdentity,
  readInstallationIdentity,
  initObservationForRoot,
  enableObservation,
  queryObservations,
  subscribeObservations,
  unsubscribeObservations,
  onObservationEvents,
  closeObservationForProject,
  stopObservationWorker,
  noteTaskDir,
  refreshTaskAliases,
  OBSERVATION_EVENT_ENCODE_LIMIT_BYTES,
  OBSERVATION_QUERY_PAGE_MAX,
  parseTrellisTaskPath,
  taskRefFor
} = m

/* ---------------- 事件夹具（符合 shared/observability v1 契约） ---------------- */

let eventSeq = 0
const makeEvent = (over = {}) => {
  eventSeq += 1
  return {
    schemaVersion: 1,
    eventId: `evt-${eventSeq}-${Math.random().toString(36).slice(2, 8)}`,
    injectionId: 'inj-smoke',
    kind: 'context.assembled',
    occurredAtMs: 1760172000000 + eventSeq,
    producer: { host: 'codex', hook: 'subagent-context', version: '0.1.0', capability: 'context.v1' },
    scope: {
      repositoryId: 'repo-smoke',
      workspaceId: 'ws-smoke',
      taskRef: null,
      trellisTaskId: null,
      taskPath: null,
      association: 'unresolved'
    },
    session: { parentId: null, childId: null, runId: null },
    materials: [
      {
        source: 'prd.md',
        origin: 'file',
        outcome: 'included',
        reason: null,
        sourceBytes: 10,
        sourceDigest: 'a'.repeat(64),
        includedBytes: 10,
        includedDigest: 'a'.repeat(64)
      }
    ],
    totals: {
      expectedEntries: 1,
      recordedEntries: 1,
      omittedEntries: 0,
      contextUtf8Bytes: 100,
      stdoutUtf8Bytes: null,
      budgetBytes: null,
      completeness: 'complete'
    },
    outputDigest: null,
    diagnosticCode: null,
    ...over
  }
}

const newRuntime = (name) => {
  const dir = join(workDir, `rt-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ================= A. 核心直驱 ================= */

console.log('\n== A. 观测库核心（store-core 直驱） ==')

{
  const dir = newRuntime('core')
  const core = new ObservationStoreCore(dir)
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.open()
  const h0 = core.health()
  check('A1 建库即 v1（journal=DELETE 约定经 D-SQLITE 探针另证）', h0.dbVersion === 1 && h0.state === 'active' && h0.storeEpoch !== null)
  check('A1 控制库独立初始化', h0.controlState === 'active')

  const ev1 = makeEvent()
  const r1 = core.insertEvent(ev1, Date.now())
  const h1 = core.health()
  check('A2 插入成功且 usage 计数同事务（count=1、bytes>0）', r1.status === 'inserted' && h1.logicalCount === 1 && h1.logicalPayloadBytes > 0)
  check('A2 events 行数与 usage 计数一致', core.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 10 }).items.length === h1.logicalCount)

  const bad = { ...makeEvent(), materials: 'not-an-array' }
  const ri = core.insertEvent(bad, Date.now())
  check('A2 非法事件 → invalid，usage 不变', ri.status === 'invalid' && core.health().logicalCount === 1)

  const rd = core.insertEvent(ev1, Date.now())
  check('A3 同 eventId 同内容 → duplicate 幂等（count 仍 1）', rd.status === 'duplicate' && rd.seq === r1.seq && core.health().logicalCount === 1)

  const conflict = makeEvent({ eventId: ev1.eventId, occurredAtMs: ev1.occurredAtMs + 9999 })
  const rc = core.insertEvent(conflict, Date.now())
  const diagCodes = core.listDiagnostics(100).map((d) => d.code)
  check('A4 同 eventId 异内容 → conflict 不覆盖', rc.status === 'conflict' && core.health().logicalCount === 1)
  check('A4 冲突留诊断 event_id_conflict', diagCodes.includes('event_id_conflict'))
  const storedRow = core.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 10 }).items.find((i) => i.eventId === ev1.eventId)
  check('A4 首见记录保留（occurredAtMs 未被覆盖）', storedRow !== undefined && storedRow.occurredAtMs === ev1.occurredAtMs)

  // 64KiB：删减明细 → partial；汇总仍超限 → 跳过
  const many = []
  for (let i = 0; i < 400; i += 1) {
    many.push({ source: `materials/very/long/relative/path/number-${i}.md`, origin: 'file', outcome: 'included', reason: null, sourceBytes: 1000, sourceDigest: 'b'.repeat(64), includedBytes: 1000, includedDigest: 'b'.repeat(64) })
  }
  const big = makeEvent({ materials: many, totals: { ...makeEvent().totals, recordedEntries: 400, contextUtf8Bytes: 400000 } })
  const rb = core.insertEvent(big, Date.now())
  check('A5 明细超编码预算 → 删减标 partial 记遗漏数', rb.status === 'inserted' && rb.trimmed === true && rb.omittedMaterials === 400)
  const bigRow = core.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 10 }).items.find((i) => i.eventId === big.eventId)
  check('A5 存储行 materials 已删减且 completeness=partial', bigRow !== undefined && bigRow.event.materials.length === 0 && bigRow.event.totals.completeness === 'partial' && bigRow.event.totals.omittedEntries === 400)
  check('A5 删减留诊断 event_materials_dropped', core.listDiagnostics(100).some((d) => d.code === 'event_materials_dropped'))

  const huge = makeEvent({ hugeExtraField: 'x'.repeat(OBSERVATION_EVENT_ENCODE_LIMIT_BYTES + 4096) })
  const rh = core.insertEvent(huge, Date.now())
  check('A5 汇总仍超限 → 跳过观测（rejected event_too_large）', rh.status === 'rejected' && rh.reason === 'event_too_large')
  check('A5 跳过留诊断 event_skipped_too_large', core.listDiagnostics(100).some((d) => d.code === 'event_skipped_too_large'))
  core.close()
}

/* A6 配额暂停/恢复 */
{
  const dir = newRuntime('quota')
  const core = new ObservationStoreCore(dir, { maxEvents: 2 })
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.open()
  const OLD = Date.now() - 90 * 24 * 60 * 60 * 1000
  check('A6 配额内插入 2 条成功', core.insertEvent(makeEvent({ occurredAtMs: OLD }), Date.now()).status === 'inserted' && core.insertEvent(makeEvent({ occurredAtMs: OLD }), Date.now()).status === 'inserted')
  const r3 = core.insertEvent(makeEvent({ occurredAtMs: OLD }), Date.now())
  const h3 = core.health()
  check('A6 满额第 3 条 → quota_paused 拒绝', r3.status === 'rejected' && r3.reason === 'quota_paused')
  check('A6 健康呈现 paused/quota_retention', h3.state === 'paused' && h3.pauseReason === 'quota_retention')
  const usagePaused = core.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 10 }).items.length === 2 // 读路径不受暂停影响
  check('A6 暂停只停新增，读取照常', usagePaused)
  const cleaned = core.cleanupRetention()
  check('A6 保留清理删除过期并恢复采集', cleaned.removed === 2 && cleaned.resumed === true && core.health().state === 'active')
  check('A6 恢复后可继续写入', core.insertEvent(makeEvent(), Date.now()).status === 'inserted')
  core.close()
}

/* A7 保留清理（时间窗） */
{
  const dir = newRuntime('retention')
  const core = new ObservationStoreCore(dir)
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.open()
  const OLD = Date.now() - 30 * 24 * 60 * 60 * 1000
  const RECENT = Date.now() - 1000
  core.insertEvent(makeEvent({ eventId: 'keep-recent', occurredAtMs: RECENT }), Date.now())
  core.insertEvent(makeEvent({ occurredAtMs: OLD }), Date.now())
  core.insertEvent(makeEvent({ occurredAtMs: OLD + 1000 }), Date.now())
  const c = core.cleanupRetention()
  const q = core.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 10 })
  check('A7 清理只删过期（removed=2）', c.removed === 2 && q.items.length === 1 && q.items[0].eventId === 'keep-recent')
  check('A7 retainedFrom=存活最老事件时间、usage 重算', q.retainedFrom === RECENT && core.health().logicalCount === 1)
  core.close()
}

/* A8 迁移 v1 与不可识别库 */
{
  const dir = newRuntime('migrate')
  const pre = join(dir, 'observations.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(pre)
  db.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta(key, value) VALUES('dbVersion', '0')")
  db.close()
  const core = new ObservationStoreCore(dir)
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.open()
  check('A8 v0 库迁移到 v1', core.health().dbVersion === 1 && core.health().state === 'active')
  check('A8 迁移后可写入', core.insertEvent(makeEvent(), Date.now()).status === 'inserted')
  core.close()

  const dir2 = newRuntime('alien')
  const alien = join(dir2, 'observations.sqlite')
  const db2 = new DatabaseSync(alien)
  db2.exec('CREATE TABLE someone_elses(x)')
  db2.close()
  const core2 = new ObservationStoreCore(dir2)
  core2.open()
  check('A8 无 schema_meta 的库 → corrupted 不猜不写', core2.health().state === 'corrupted' && core2.insertEvent(makeEvent(), Date.now()).status === 'rejected')
  check('A8 不可识别库原文件保留', existsSync(alien))
  core2.close()
}

/* A9 损坏重建：epoch 更换 → resetRequired、原文件保留 */
{
  const dir = newRuntime('rebuild')
  const core = new ObservationStoreCore(dir)
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.open()
  core.insertEvent(makeEvent(), Date.now())
  const epoch1 = core.health().storeEpoch
  core.close()
  // 损坏：截断成非 SQLite 内容
  const target = join(dir, 'observations.sqlite')
  writeFileSync(target, Buffer.alloc(64, 7))
  const core2 = new ObservationStoreCore(dir)
  core2.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core2.open()
  check('A9 损坏库 → corrupted 停写', core2.health().state === 'corrupted')
  const qOld = core2.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 5, cursorEpoch: epoch1 })
  check('A9 损坏期旧 cursor → resetRequired', qOld.resetRequired === true && qOld.items.length === 0)
  const rebuilt = core2.rebuildObservations()
  const epoch2 = core2.health().storeEpoch
  check('A9 重建生成新 storeEpoch', rebuilt.preservedFile !== null && typeof epoch2 === 'string' && epoch2 !== epoch1)
  check('A9 原损坏文件保留（改名留证）', rebuilt.preservedFile !== null && readdirSync(dir).some((f) => f.startsWith('observations.sqlite.corrupt-')))
  check('A9 重建后恢复写入', core2.insertEvent(makeEvent(), Date.now()).status === 'inserted')
  const qNew = core2.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 5, cursorEpoch: epoch2 })
  const qStale = core2.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 5, cursorEpoch: epoch1 })
  check('A9 新 cursor 正常 / 旧 cursor → resetRequired', qNew.resetRequired === false && qStale.resetRequired === true)
  core2.close()
}

/* A10 cursor 分页回补 + 每页 ≤100 */
{
  const dir = newRuntime('paging')
  const core = new ObservationStoreCore(dir)
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.open()
  const TOTAL = 105
  for (let i = 0; i < TOTAL; i += 1) core.insertEvent(makeEvent(), Date.now())
  const p1 = core.queryEvents({ workspaceId: 'ws-smoke' }, { limit: 1000 })
  check(`A10 limit 超限收敛到 ${OBSERVATION_QUERY_PAGE_MAX}`, p1.items.length === 100 && OBSERVATION_QUERY_PAGE_MAX === 100)
  const p2 = core.queryEvents({ workspaceId: 'ws-smoke' }, { after: p1.nextCursor.seq, limit: 100 })
  const ids = new Set([...p1.items, ...p2.items].map((i) => i.eventId))
  check('A10 翻页回补无遗漏无重复', p2.items.length === 5 && ids.size === TOTAL && p2.highWatermark === TOTAL)
  check('A10 taskRef 过滤不串线（另一任务/未归属）', core.queryEvents({ workspaceId: 'ws-smoke', taskRef: 'task:other' }, { limit: 100 }).items.length === 0)
  core.close()
}

/* A11 taskRef 归档续接（控制库） */
{
  const dir = newRuntime('alias')
  const core = new ObservationStoreCore(dir)
  core.open()
  core.recordTaskAlias('task:abc', 'abc', '.trellis/tasks/10-01-a')
  const moved = core.verifyTaskAliases([{ dir: '.trellis/tasks/archive/2026-10/10-01-a', trellisTaskId: 'abc' }])
  const alias = core.getTaskAlias('task:abc')
  check('A11 原路径消失+唯一同 ID 目标 → 续接（moved=1）', moved.moved === 1 && alias.currentDir === '.trellis/tasks/archive/2026-10/10-01-a')
  check('A11 旧目录进 priorDirs 留痕', alias.priorDirs.includes('.trellis/tasks/10-01-a'))

  core.recordTaskAlias('task:dup', 'dup', '.trellis/tasks/10-02-keep')
  const pending = core.verifyTaskAliases([
    { dir: '.trellis/tasks/10-02-keep', trellisTaskId: 'dup' },
    { dir: '.trellis/tasks/10-02-copy', trellisTaskId: 'dup' }
  ])
  const dupAlias = core.getTaskAlias('task:dup')
  check('A11 复制目录（同 ID 多处）→ 待确认不自动合并', pending.pending.length === 1 && dupAlias.status === 'pending_confirmation' && dupAlias.currentDir === '.trellis/tasks/10-02-keep')

  core.recordTaskAlias('dir:.trellis/tasks/10-03-gone', null, '.trellis/tasks/10-03-gone')
  const missing = core.verifyTaskAliases([
    { dir: '.trellis/tasks/archive/2026-10/10-01-a', trellisTaskId: 'abc' },
    { dir: '.trellis/tasks/10-02-keep', trellisTaskId: 'dup' }
  ])
  check('A11 目录消失且无 ID 线索 → missing（数据保留）', missing.missing >= 1 && core.getTaskAlias('dir:.trellis/tasks/10-03-gone').status === 'missing')

  /* A12 清理观测不触碰 control */
  core.insertEvent(makeEvent(), Date.now()) // 无绑定直驱核心：本片仅验证 clear 不动别名
  const before = core.listTaskAliases().length
  core.clearAllObservations()
  check('A12 清理观测后别名仍在（task_aliases 不删）', core.listTaskAliases().length === before && core.getTaskAlias('task:abc') !== null)
  check('A12 清理重置 usage（count=0）', core.health().logicalCount === 0)
  core.close()
}

/* ================= B. 绑定身份（identity） ================= */

console.log('\n== B. 绑定身份（identity） ==')

const installDir = join(workDir, 'install')
const repoA = join(workDir, 'repo-a')
mkdirSync(repoA, { recursive: true })

{
  const i1 = ensureInstallationIdentity(installDir)
  const i2 = ensureInstallationIdentity(installDir)
  check('B1 安装身份生成且稳定（升级不动）', i1.installationId === i2.installationId && readInstallationIdentity(installDir).installationId === i1.installationId)
  check('B1 installationId 缺失目录读取为 null（不自动创建）', readInstallationIdentity(join(workDir, 'no-such-install')) === null)

  const runtimeA = join(repoA, '.trellis', '.panel', 'runtime')
  mkdirSync(runtimeA, { recursive: true })
  const v1 = createOrVerifyBinding({ runtimeDir: runtimeA, root: repoA, installation: i1, installDir, gitFacts: { gitCommonDir: null, worktreeRoot: null } })
  const v2 = createOrVerifyBinding({ runtimeDir: runtimeA, root: repoA, installation: i1, installDir, gitFacts: { gitCommonDir: null, worktreeRoot: null } })
  check('B2 首绑 created → 复验不重建', v1.status === 'bound' && v1.created === true && v2.status === 'bound' && v2.created === false && v1.binding.workspaceId === v2.binding.workspaceId)

  const otherInstall = join(workDir, 'install-other')
  const forged = ensureInstallationIdentity(otherInstall)
  const mismatch = createOrVerifyBinding({ runtimeDir: runtimeA, root: repoA, installation: forged, installDir: otherInstall })
  check('B3 installationId 不符 → rebind_required（数据不删）', mismatch.status === 'rebind_required' && mismatch.reason === 'installation_mismatch' && existsSync(join(runtimeA, 'binding.json')))
  const rebind = createOrVerifyBinding({ runtimeDir: runtimeA, root: repoA, installation: forged, installDir: otherInstall, rebind: true })
  check('B3 显式确认迁移 → 覆盖绑定', rebind.status === 'bound')

  const repoB = join(workDir, 'repo-b')
  mkdirSync(repoB, { recursive: true })
  const rootMismatch = createOrVerifyBinding({ runtimeDir: runtimeA, root: repoB, installation: forged, installDir: otherInstall })
  check('B3 canonical root 不符 → rebind_required', rootMismatch.status === 'rebind_required' && rootMismatch.reason === 'root_mismatch')
}

/* 门禁阻断 → 停采集（核心级） */
{
  const dir = newRuntime('blocked')
  const core = new ObservationStoreCore(dir)
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: true, blockReason: 'installation_mismatch' })
  core.open()
  const r = core.insertEvent(makeEvent(), Date.now())
  check('B4 绑定门禁阻断 → 插入拒绝（停采集）', r.status === 'rejected' && r.reason === 'installation_mismatch')
  check('B4 停采集呈现 paused/installation_mismatch', core.health().state === 'paused' && core.health().pauseReason === 'installation_mismatch')
  // 门禁解除 → 恢复（重新绑定/重新启用后）
  core.setBinding({ repositoryId: 'repo-smoke', workspaceId: 'ws-smoke', collectionEnabled: true, collectionBlocked: false, blockReason: null })
  core.clearAllObservations() // 触发 applyBindingGateToUsage
  check('B4 门禁解除后恢复采集', core.health().state === 'active' && core.insertEvent(makeEvent(), Date.now()).status === 'inserted')
  core.close()
}

/* ================= C. 服务链（真实 worker 线程） ================= */

console.log('\n== C. 服务链（worker 线程 + 订阅推送） ==')

const repoC = join(workDir, 'repo-c')
mkdirSync(repoC, { recursive: true })

{
  const notBound = await initObservationForRoot(repoC)
  check('C1 无绑定 → not_bound 且不创建任何文件', notBound.ok === true && notBound.bound === false && !existsSync(join(repoC, '.trellis')))
}

const installC = join(workDir, 'install-c')
const enabled = await enableObservation(repoC, { installDir: installC, gitFacts: { gitCommonDir: null, worktreeRoot: null } })
check('C2 显式绑定初始化（worker 线程拉起）', enabled.ok === true && enabled.bound === true && enabled.health.state === 'active')
check('C2 安装身份与绑定文件落盘（临时目录，未触真实 LOCALAPPDATA）', existsSync(join(installC, 'installation.json')) && existsSync(join(repoC, '.trellis', '.panel', 'runtime', 'binding.json')))
const bindingC = JSON.parse(readFileSync(join(repoC, '.trellis', '.panel', 'runtime', 'binding.json'), 'utf-8'))
const scopeC = { workspaceId: bindingC.workspaceId }

{
  const q0 = await queryObservations(scopeC, { limit: 10 })
  check('C3 空库查询 ok（无 cursor → resetRequired=false）', q0.ok === true && q0.items.length === 0 && q0.resetRequired === false && typeof q0.health.storeEpoch === 'string')

  const qBad = await queryObservations({ workspaceId: '' }, { limit: 10 })
  check('C3 非法 scope → E_INVALID_ARG', qBad.ok === false && qBad.code === 'E_INVALID_ARG')

  /* C4 双连接写入（模拟 Hook 侧生产者）→ 查询可见 + 订阅推送 */
  const writerCore = new ObservationStoreCore(join(repoC, '.trellis', '.panel', 'runtime'))
  writerCore.setBinding({ repositoryId: bindingC.repositoryId, workspaceId: bindingC.workspaceId, collectionEnabled: true, collectionBlocked: false, blockReason: null })
  writerCore.open()

  const pushes = []
  const off = onObservationEvents((e) => pushes.push(e))
  const sub = await subscribeObservations(scopeC)
  check('C4 订阅建立返回快照基准 cursor', sub.ok === true && typeof sub.subscriptionId === 'string' && sub.snapshotCursor.storeEpoch === q0.health.storeEpoch && sub.snapshotCursor.seq === 0)

  const evA = makeEvent({ scope: { ...makeEvent().scope, workspaceId: bindingC.workspaceId, repositoryId: bindingC.repositoryId } })
  const evB = makeEvent({ scope: { ...makeEvent().scope, workspaceId: bindingC.workspaceId, repositoryId: bindingC.repositoryId } })
  writerCore.insertEvent(evA, Date.now())
  writerCore.insertEvent(evB, Date.now())

  const gotAll = await waitFor(() => {
    const items = pushes.filter((p) => p.event.type === 'events').flatMap((p) => p.event.items.map((i) => i.eventId))
    return items.includes(evA.eventId) && items.includes(evB.eventId)
  }, 4000)
  check('C4 订阅在轮询窗口内收到两条增量', gotAll)
  const q1 = await queryObservations(scopeC, { limit: 10, cursorEpoch: q0.health.storeEpoch })
  check('C4 双连接写入对查询可见', q1.ok === true && q1.items.length === 2 && q1.highWatermark === 2)

  /* C5 清理换 epoch → 订阅推 reset */
  const epochBefore = q0.health.storeEpoch
  writerCore.clearAllObservations()
  const gotReset = await waitFor(() => pushes.some((p) => p.event.type === 'reset'), 4000)
  check('C5 清理换 epoch → 订阅收到 reset（不默默跳过）', gotReset)
  const qAfterClear = await queryObservations(scopeC, { limit: 10, cursorEpoch: epochBefore })
  check('C5 旧 cursor → resetRequired', qAfterClear.ok === true && qAfterClear.resetRequired === true && qAfterClear.items.length === 0)

  /* C6 退订停推 */
  unsubscribeObservations(sub.subscriptionId)
  const pushCountAtUnsub = pushes.length
  writerCore.insertEvent(makeEvent({ scope: { ...makeEvent().scope, workspaceId: bindingC.workspaceId, repositoryId: bindingC.repositoryId } }), Date.now())
  await new Promise((r) => setTimeout(r, 600))
  check('C6 退订后不再推送', pushes.length === pushCountAtUnsub)
  off()

  /* C7 noteTaskDir → 别名登记（taskRef 身份接线；fire-and-forget，等落库后核验） */
  const taskDir = join(repoC, '.trellis', 'tasks', '10-99-smoke')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({ id: 'smoke-task-99', title: 'smoke', status: 'planning' }), 'utf-8')
  noteTaskDir(repoC, '10-99-smoke')
  const refreshed = refreshTaskAliases(repoC) // 归档续接核验同链路（结果不阻塞断言）
  const aliases = await waitFor(
    () => {
      const probe = new ObservationStoreCore(join(repoC, '.trellis', '.panel', 'runtime'))
      probe.open()
      const list = probe.listTaskAliases()
      probe.close()
      return list.some((a) => a.taskRef === 'task:smoke-task-99') ? list : null
    },
    4000
  )
  void refreshed
  check(
    'C7 watcher 任务路径 → taskRef 别名登记（task:<id>）',
    Array.isArray(aliases) && aliases.some((a) => a.taskRef === 'task:smoke-task-99' && a.currentDir === '.trellis/tasks/10-99-smoke')
  )

  writerCore.close()

  /* C8 项目关闭 → 查询回落哨兵空集 */
  closeObservationForProject()
  const qClosed = await queryObservations(scopeC, { limit: 10 })
  check('C8 项目关闭后查询回落未初始化口径', qClosed.ok === true && qClosed.items.length === 0 && qClosed.nextCursor.storeEpoch === 'store-unavailable')

  /* C9 installationId 不符（安装身份被重置）→ 服务呈现 paused + 停采集 */
  const identityFile = join(installC, 'installation.json')
  const original = JSON.parse(readFileSync(identityFile, 'utf-8'))
  writeFileSync(identityFile, JSON.stringify({ installationId: 'reset-identity-0000', createdAtMs: original.createdAtMs }), 'utf-8')
  const mismatched = await initObservationForRoot(repoC, { installDir: installC })
  check(
    'C9 安装身份重置 → rebind_required + paused/installation_mismatch（读取照常）',
    mismatched.ok === true &&
      mismatched.bound === true &&
      mismatched.bindingStatus === 'rebind_required' &&
      mismatched.health.state === 'paused' &&
      mismatched.health.pauseReason === 'installation_mismatch'
  )
  const stillReadable = await queryObservations(scopeC, { limit: 10 })
  check('C9 停采集不阻断读取', stillReadable.ok === true)
  writeFileSync(identityFile, JSON.stringify(original), 'utf-8')
}

/* 任务身份纯函数抽查（路径解析/归档识别/taskRef 派生） */
{
  const p1 = parseTrellisTaskPath('C:/x/r', 'C:/x/r/.trellis/tasks/10-01-a/prd.md')
  const p2 = parseTrellisTaskPath('C:/x/r', 'C:\\x\\r\\.trellis\\tasks\\archive\\2026-10\\10-01-a\\task.json')
  const p3 = parseTrellisTaskPath('C:/x/r', 'C:/x/r/src/main/index.ts')
  check('D1 活动任务路径解析（含反斜杠）', p1 !== null && p1.taskDir === '10-01-a' && p1.innerPath === 'prd.md' && p1.archived === false && p1.repoRelativeDir === '.trellis/tasks/10-01-a')
  check('D1 归档任务路径显式识别', p2 !== null && p2.archived === true && p2.taskDir === '10-01-a' && p2.innerPath === 'task.json')
  check('D1 任务外路径不解析', p3 === null)
  check('D1 taskRef 派生前缀隔离', taskRefFor('abc', '.trellis/tasks/x') === 'task:abc' && taskRefFor(null, '.trellis/tasks/x') === 'dir:.trellis/tasks/x')
}

stopObservationWorker()

rmSync(workDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n观测存储冒烟：${failures} 项失败`)
  process.exit(1)
}
console.log('\n观测存储冒烟：全部通过 ✓（未覆盖：打包 asar 内 worker 加载、真实 Hook 并发——G1-B 既有待办）')
process.exit(0)
