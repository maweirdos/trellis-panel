/**
 * Hook 观测生产者冒烟（S0 G1-A/C 本地实验片，design §3/§4.2/§8；PRD FR2/AC3）：
 *
 *   0) 全部用例直接调用 hook 脚本（改造副本 vs `git show HEAD:` 的基线副本），
 *      不触碰任何活体会话；sandbox 仓库/安装身份/观测库均在临时目录构建。
 *   1) 正常路径（SubagentStart + PreToolUse 两类 stdin 夹具）：
 *      - stdout 与 HEAD 逐字节一致（sha256 对比）；stderr 与退出码不变。
 *      - assembled/emitted 事件成对落库、共用 injectionId；payloadDigest 与
 *        TS stableStringify 重算一致（跨语言 digest，known-issues P3-b）。
 *      - emitted.outputDigest === 实际输出上下文字段 SHA-256；
 *        stdoutUtf8Bytes === 实际 stdout 字节数；材料五类结果与源文件摘要可核对。
 *   2) 旁路矩阵：binding 缺失（零写入零报错）、TRELLIS_RECEIPTS=off、
 *      collectionEnabled=false、installationId 不符、canonical root 不符 → 不采集。
 *   3) 存储故障矩阵：库只读 / 库损坏（原文件不被改动）/ journal 路径不可创建
 *      （模拟目录只读）/ 库缺失 → stderr ≤1 行、stdout 不变、退出码不变。
 *   4) 输出故障矩阵：stdout 管道提前关闭（无 emitted、hook 不挂起）、
 *      序列化异常注入（TRELLIS_OBS_TEST_FAIL=serialize，见 observability_emit）。
 *
 * 运行：node scripts/smoke/hook-emitter.mjs
 * 黄金夹具捕获：node scripts/smoke/hook-emitter.mjs --dump-fixtures scripts/fixtures/observability
 */
import { spawn, spawnSync, execFileSync } from 'child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

const repoRoot = join(dirnameOf(import.meta.url), '..', '..')
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-hook-emitter-'))
const modifiedHook = join(repoRoot, '.codex', 'hooks', 'inject-subagent-context.py')

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
  return Boolean(cond) // 供 `if (check(...) && value)` 串联后续断言
}

function dirnameOf(url) {
  return fileURLToPath(new URL('.', url)).replace(/\\$/, '')
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/* ---------------- 打包：store-core（建库/读取）+ schema（解析） ---------------- */

const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export { ObservationStoreCore, stableStringify } from '${(repoRoot + '/src/main/services/observability/store-core.ts').replace(/\\/g, '/')}'`,
    `export { parseContextEvent } from '${(repoRoot + '/src/shared/observability/schema.ts').replace(/\\/g, '/')}'`
  ].join('\n'),
  'utf-8'
)
const bundle = join(workDir, 'bundle.mjs')
execFileSync(
  process.execPath,
  [join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
  { stdio: 'pipe' }
)
const { ObservationStoreCore, stableStringify, parseContextEvent } = await import(pathToFileURL(bundle).href)

/* ---------------- HEAD 基线副本 ---------------- */

const headHook = join(workDir, 'head-inject-subagent-context.py')
writeFileSync(headHook, execFileSync('git', ['-C', repoRoot, 'show', 'HEAD:.codex/hooks/inject-subagent-context.py']))

/* ---------------- sandbox 构建 ---------------- */

const TASK_DIR = '.trellis/tasks/10-12-obs-fixture'
const INSTALLATION_ID = 'install-obs-fixture-0001'
const REPO_ID = 'repo-obs-fixture'
const WS_ID = 'ws-obs-fixture'

const repeatToBytes = (text, targetBytes) => {
  const unit = Buffer.byteLength(text, 'utf8')
  const repeats = Math.max(1, Math.floor(targetBytes / unit))
  let out = text.repeat(repeats)
  while (Buffer.byteLength(out, 'utf8') < targetBytes) out += text
  return out.slice(0, Math.max(0, targetBytes))
}

function makeSandbox({ big = false } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'tpanel-obs-repo-'))
  const installDir = mkdtempSync(join(tmpdir(), 'tpanel-obs-install-'))
  mkdirSync(join(sandbox, '.git'), { recursive: true }) // find_repo_root 只检查存在性
  mkdirSync(join(sandbox, '.trellis', 'tasks', '10-12-obs-fixture'), { recursive: true })
  mkdirSync(join(sandbox, '.trellis', 'spec', 'frontend'), { recursive: true })
  mkdirSync(join(sandbox, '.trellis', 'spec', 'shared'), { recursive: true })
  mkdirSync(join(sandbox, '.trellis', 'spec', 'extra'), { recursive: true })
  mkdirSync(join(sandbox, 'assets'), { recursive: true })
  mkdirSync(join(sandbox, '.trellis', '.runtime', 'sessions'), { recursive: true })

  writeFileSync(join(sandbox, '.trellis', '.version'), '0.6.17-obs-test\n', 'utf8')
  // hook 依赖 .trellis/scripts/common/active_task.py 解析会话任务指针 → 整树拷贝
  //（排除 __pycache__），保持 sandbox 自包含、不读真实仓库任务状态
  cpSync(join(repoRoot, '.trellis', 'scripts'), join(sandbox, '.trellis', 'scripts'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__')
  })
  const limits = big
    ? { max_file_bytes: 100000, max_artifact_bytes: 100000, max_total_bytes: 200000 }
    : { max_file_bytes: 3000, max_artifact_bytes: 5000, max_total_bytes: 131072 }
  writeFileSync(
    join(sandbox, '.trellis', 'config.yaml'),
    [
      'context_injection:',
      `  max_file_bytes: ${limits.max_file_bytes}`,
      `  max_artifact_bytes: ${limits.max_artifact_bytes}`,
      `  max_total_bytes: ${limits.max_total_bytes}`,
      ''
    ].join('\n'),
    'utf8'
  )

  writeFileSync(
    join(sandbox, TASK_DIR, 'task.json'),
    JSON.stringify({ id: 'obs-fixture-task-001', title: 'Observability fixture task', status: 'in_progress' }, null, 2),
    'utf8'
  )
  const prdBytes = big ? 60000 : 1200
  writeFileSync(join(sandbox, TASK_DIR, 'prd.md'), repeatToBytes('# PRD\n\n需求文档夹具内容（观测冒烟）。\n', prdBytes), 'utf8')
  writeFileSync(join(sandbox, TASK_DIR, 'design.md'), repeatToBytes('# Design\n\n设计文档夹具内容（观测冒烟）。\n', 1200), 'utf8')
  // implement.md 故意缺失：覆盖 artifact missing 材料结果
  writeFileSync(
    join(sandbox, TASK_DIR, 'implement.jsonl'),
    [
      '{"file": ".trellis/spec/frontend/components.md", "reason": "spec fixture included"}',
      '{"file": ".trellis/spec/shared/typescript.md", "reason": "spec fixture truncated"}',
      '{"file": "assets/logo.bin", "reason": "binary fixture"}',
      '{"file": ".trellis/spec/shared/missing.md", "reason": "missing fixture"}',
      '{"file": ".trellis/spec/extra/", "type": "directory", "reason": "directory fixture"}',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(join(sandbox, TASK_DIR, 'check.jsonl'), '{"file": ".trellis/spec/frontend/components.md", "reason": "check spec"}\n', 'utf8')

  writeFileSync(join(sandbox, '.trellis', 'spec', 'frontend', 'components.md'), repeatToBytes('# Components\n\n组件复用规范夹具。\n', 800), 'utf8')
  writeFileSync(join(sandbox, '.trellis', 'spec', 'shared', 'typescript.md'), repeatToBytes('# TypeScript\n\n类型契约夹具内容。\n', 3500), 'utf8')
  writeFileSync(join(sandbox, '.trellis', 'spec', 'extra', 'a.md'), '# Extra A\n\n目录展开夹具 A。\n', 'utf8')
  writeFileSync(join(sandbox, '.trellis', 'spec', 'extra', 'b.md'), '# Extra B\n\n目录展开夹具 B。\n', 'utf8')
  writeFileSync(join(sandbox, 'assets', 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]))

  writeFileSync(
    join(sandbox, '.trellis', '.runtime', 'sessions', 'codex_parent-1.json'),
    JSON.stringify({ current_task: TASK_DIR }),
    'utf8'
  )
  writeFileSync(
    join(sandbox, '.trellis', '.runtime', 'sessions', 'session_s1.json'),
    JSON.stringify({ current_task: TASK_DIR }),
    'utf8'
  )

  // 安装身份（隔离的 LOCALAPPDATA；绝不触碰真实 %LOCALAPPDATA%/TrellisPanel）。
  // emitter/identity.ts 的固定规则是 <LOCALAPPDATA>/TrellisPanel/installation.json
  // → 安装目录自身即覆盖值，installation.json 写在其 TrellisPanel 子目录。
  mkdirSync(join(installDir, 'TrellisPanel'), { recursive: true })
  writeFileSync(
    join(installDir, 'TrellisPanel', 'installation.json'),
    JSON.stringify({ installationId: INSTALLATION_ID, createdAtMs: Date.now() }, null, 2),
    'utf8'
  )

  // 绑定（手写固定 ID）。canonicalRoot 必须与 hook/Python 的 Path.resolve() 同型：
  // os.tmpdir() 在本机为 8.3 短路径（MAWEIR~1），Python resolve 展开为长名 →
  // 用 realpathSync.native 取最终形态，避免假性 root_mismatch。
  const runtimeDir = join(sandbox, '.trellis', '.panel', 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const canonicalRoot = realpathSync.native(sandbox)
  const writeBinding = (overrides = {}) =>
    writeFileSync(
      join(runtimeDir, 'binding.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          installationId: INSTALLATION_ID,
          repositoryId: REPO_ID,
          workspaceId: WS_ID,
          canonicalRoot,
          gitCommonDir: null,
          worktreeRoot: null,
          boundAtMs: Date.now(),
          collectionEnabled: true,
          ...overrides
        },
        null,
        2
      ),
      'utf8'
    )
  writeBinding()

  // 观测库：Panel 是唯一建库方 → 用真实 store-core 建库（schema 与生产一致）
  const core = new ObservationStoreCore(runtimeDir)
  core.open()
  core.close()

  const dbPath = join(runtimeDir, 'observations.sqlite')
  return { sandbox, installDir, runtimeDir, dbPath, writeBinding }
}

/* ---------------- hook 执行与读取 ---------------- */

const SCRUB_ENV_RE = /(^|_)(PROJECT_DIR|SESSION_ID|SESSIONID|CONVERSATION_ID|CONVERSATIONID|TRANSCRIPT_PATH|THREAD_ID)$/

function hookEnv(ctx, extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('TRELLIS_')) continue
    if (SCRUB_ENV_RE.test(key)) continue
    env[key] = value
  }
  env.LOCALAPPDATA = ctx.installDir
  Object.assign(env, extra)
  return env
}

const SUBAGENT_START_STDIN = (cwd) =>
  JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'trellis-implement', session_id: 'parent-1', cwd })
const PRE_TOOL_USE_STDIN = (cwd) =>
  JSON.stringify({
    session_id: 's1',
    cwd,
    tool_name: 'Task',
    tool_input: { subagent_type: 'trellis-implement', prompt: 'implement the fixture' }
  })

function runHook(script, stdinText, ctx, extraEnv = {}) {
  const res = spawnSync('python', [script], {
    cwd: ctx.sandbox,
    input: stdinText,
    env: hookEnv(ctx, extraEnv),
    timeout: 60000
  })
  return res
}

function readEvents(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db
      .prepare(
        'SELECT seq, eventId, payloadDigest, injectionId, kind, taskRef, occurredAtMs, receivedAtMs, payloadBytes, payload FROM events ORDER BY seq'
      )
      .all()
    const usage = db.prepare('SELECT logicalCount, logicalPayloadBytes FROM store_usage WHERE id=1').get()
    return { rows, usage }
  } finally {
    db.close()
  }
}

const stderrLineCount = (buf) => {
  const text = buf.length === 0 ? '' : buf.toString('utf8')
  if (text.trim() === '') return 0
  return text.split('\n').filter((l) => l.trim() !== '').length
}

/** 断言一次运行与 HEAD 基线逐字节一致（stdout）且退出码/stderr 不劣化。 */
function assertBaseline(label, headRes, modRes) {
  const headSha = sha256(headRes.stdout)
  const modSha = sha256(modRes.stdout)
  console.log(`    [stdout sha256] head=${headSha} (${headRes.stdout.length}B) mod=${modSha} (${modRes.stdout.length}B)`)
  check(`${label}: stdout 与 HEAD 逐字节一致（sha256）`, headSha === modSha && headRes.stdout.length === modRes.stdout.length, `head=${headSha.slice(0, 12)} mod=${modSha.slice(0, 12)}`)
  check(`${label}: 退出码与 HEAD 一致`, modRes.status === headRes.status, `head=${headRes.status} mod=${modRes.status}`)
  check(`${label}: stdout 非空（夹具真实注入）`, modRes.stdout.length > 0)
}

/** 验证一对 assembled/emitted 事件的完整契约（含跨语言 digest 证明）。 */
function assertEventPair(label, rows, stdoutBuf, { expectedParentId, expectedHost, ctx, sandbox }) {
  const kinds = rows.map((r) => r.kind)
  check(`${label}: 恰好两条事件（assembled+emitted）`, kinds.join(',') === 'context.assembled,context.emitted', kinds.join(','))
  const [assembledRow, emittedRow] = rows
  const assembled = parseContextEvent(JSON.parse(assembledRow.payload))
  const emitted = parseContextEvent(JSON.parse(emittedRow.payload))
  check(`${label}: 两事件均通过 TS parseContextEvent`, assembled.success === true && emitted.success === true)
  if (assembled.success !== true || emitted.success !== true) return null

  check(`${label}: injectionId 配对且 eventId 不同`, assembled.event.injectionId === emitted.event.injectionId && assembled.event.eventId !== emitted.event.eventId)
  check(`${label}: seq/时间顺序（assembled 先于 emitted）`, assembledRow.seq < emittedRow.seq && assembled.event.occurredAtMs <= emitted.event.occurredAtMs)

  const scope = assembled.event.scope
  check(
    `${label}: scope 身份与绑定一致`,
    scope.repositoryId === REPO_ID && scope.workspaceId === WS_ID && scope.taskRef === '10-12-obs-fixture' && scope.trellisTaskId === 'obs-fixture-task-001' && scope.taskPath === TASK_DIR && scope.association === 'resolved',
    JSON.stringify(scope)
  )
  check(
    `${label}: session 仅填宿主实际提供的 parentId`,
    assembled.event.session.parentId === expectedParentId && assembled.event.session.childId === null && assembled.event.session.runId === null,
    JSON.stringify(assembled.event.session)
  )
  check(`${label}: producer 标识（host=${expectedHost}）`, assembled.event.producer.host === expectedHost && assembled.event.producer.hook === 'inject-subagent-context' && assembled.event.producer.capability === 'subagent-context-v1')

  // 跨语言 digest 证明（P3-b）：Python 侧写入的 payloadDigest 与 TS stableStringify 重算一致
  for (const [row, ev] of [[assembledRow, assembled.event], [emittedRow, emitted.event]]) {
    const recomputed = sha256(Buffer.from(stableStringify(ev), 'utf8'))
    check(`${label}: ${ev.kind} payloadDigest 与 TS 重算一致`, row.payloadDigest === recomputed, `row=${row.payloadDigest.slice(0, 12)} ts=${recomputed.slice(0, 12)}`)
  }

  // outputDigest / stdoutUtf8Bytes 对实际 stdout 核对
  const stdoutJson = JSON.parse(stdoutBuf.toString('utf8'))
  const contextField =
    stdoutJson?.hookSpecificOutput?.additionalContext ?? stdoutJson?.hookSpecificOutput?.updatedInput?.prompt ?? null
  check(`${label}: 可从 stdout 提取上下文字段`, typeof contextField === 'string' && contextField.length > 0)
  if (typeof contextField === 'string') {
    check(`${label}: outputDigest === 实际输出上下文字段 SHA-256`, emitted.event.outputDigest === sha256(Buffer.from(contextField, 'utf8')))
  }
  check(`${label}: stdoutUtf8Bytes === 实际 stdout 字节数`, emitted.event.totals.stdoutUtf8Bytes === stdoutBuf.length, `${emitted.event.totals.stdoutUtf8Bytes} vs ${stdoutBuf.length}`)
  check(`${label}: assembled 阶段 outputDigest/stdoutUtf8Bytes 为 null`, assembled.event.outputDigest === null && assembled.event.totals.stdoutUtf8Bytes === null)

  // 材料结果与字节口径
  const outcomes = new Set(assembled.event.materials.map((m) => m.outcome))
  check(`${label}: 材料结果覆盖 included/truncated/index_only/missing`, ['included', 'truncated', 'index_only', 'missing'].every((o) => outcomes.has(o)), [...outcomes].join(','))
  check(`${label}: totals 完整（budget=131072、expectedEntries=null、complete）`, assembled.event.totals.budgetBytes === 131072 && assembled.event.totals.expectedEntries === null && assembled.event.totals.completeness === 'complete' && assembled.event.totals.recordedEntries === assembled.event.materials.length)
  check(`${label}: 组装上下文小于完整 stdout 包装`, assembled.event.totals.contextUtf8Bytes > 0 && assembled.event.totals.contextUtf8Bytes < emitted.event.totals.stdoutUtf8Bytes)

  const comp = assembled.event.materials.find((m) => m.source === '.trellis/spec/frontend/components.md')
  if (check(`${label}: components.md 材料在列`, comp !== undefined) && comp) {
    const fileSha = sha256(readFileSync(join(sandbox, '.trellis', 'spec', 'frontend', 'components.md')))
    check(`${label}: sourceDigest 与源文件 SHA-256 一致（hashlib==crypto）`, comp.sourceDigest === fileSha && comp.includedDigest === fileSha && comp.outcome === 'included')
  }
  const trunc = assembled.event.materials.find((m) => m.source === '.trellis/spec/shared/typescript.md')
  const truncActualBytes = readFileSync(join(sandbox, '.trellis', 'spec', 'shared', 'typescript.md')).length
  if (check(`${label}: typescript.md 为 truncated 且字节口径正确`, trunc !== undefined && trunc.outcome === 'truncated') && trunc) {
    check(
      `${label}: truncated 字节口径（源=${truncActualBytes}B → ≤3000B 纳入）`,
      trunc.sourceBytes === truncActualBytes && trunc.includedBytes <= 3000 && trunc.includedBytes > 2500,
      `${trunc.sourceBytes}/${trunc.includedBytes}`
    )
  }
  const bin = assembled.event.materials.find((m) => m.source === 'assets/logo.bin')
  if (check(`${label}: 二进制材料 index_only+binary`, bin !== undefined && bin.outcome === 'index_only' && bin.reason === 'binary') && bin) {
    check(`${label}: 二进制不计入纳入字节（null 非 0）`, bin.includedBytes === null && bin.includedDigest === null && bin.sourceBytes === 12)
  }
  const miss = assembled.event.materials.find((m) => m.source === '.trellis/spec/shared/missing.md')
  check(`${label}: 缺失材料 missing/not_found 且字节为 null`, miss !== undefined && miss.outcome === 'missing' && miss.reason === 'not_found' && miss.sourceBytes === null)
  const implMissing = assembled.event.materials.find((m) => m.source === `${TASK_DIR}/implement.md`)
  check(`${label}: 缺失 artifact（implement.md）登记为 missing`, implMissing !== undefined && implMissing.outcome === 'missing')
  const dirA = assembled.event.materials.find((m) => m.source === '.trellis/spec/extra/a.md')
  check(`${label}: 目录展开材料以相对路径登记`, dirA !== undefined && dirA.outcome === 'included')
  check(`${label}: usage 同事务递增（2 条）`, rows.length === 2 && ctx.usage.logicalCount === 2 && ctx.usage.logicalPayloadBytes === rows.reduce((s, r) => s + r.payloadBytes, 0), JSON.stringify(ctx.usage))
  return { assembled: assembled.event, emitted: emitted.event }
}

/* ---------------- 用例 ---------------- */

console.log('== 1. 正常路径：SubagentStart（codex 原生）==')
{
  const ctx0 = makeSandbox()
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('SubagentStart', headRes, modRes)
  check('SubagentStart: 快乐路径 stderr 与 HEAD 一致（零额外输出）', modRes.stderr.equals(headRes.stderr))
  const { rows, usage } = readEvents(ctx0.dbPath)
  assertEventPair('SubagentStart', rows, modRes.stdout, { expectedParentId: 'parent-1', expectedHost: 'codex', ctx: { usage }, sandbox: ctx0.sandbox })
}

console.log('== 2. 正常路径：PreToolUse（Task 工具，claude 兼容格式）==')
{
  const ctx0 = makeSandbox()
  const headRes = runHook(headHook, PRE_TOOL_USE_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, PRE_TOOL_USE_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('PreToolUse', headRes, modRes)
  check('PreToolUse: 快乐路径 stderr 与 HEAD 一致', modRes.stderr.equals(headRes.stderr))
  const { rows, usage } = readEvents(ctx0.dbPath)
  assertEventPair('PreToolUse', rows, modRes.stdout, { expectedParentId: 's1', expectedHost: 'unknown', ctx: { usage }, sandbox: ctx0.sandbox })
}

console.log('== 3. 旁路矩阵：观测关闭/未启用/身份不符 → 不采集 ==')
{
  // 3.1 binding 缺失（观测未启用）：一次 stat 短路，零写入零报错
  const ctx0 = makeSandbox()
  renameSync(ctx0.runtimeDir, ctx0.runtimeDir + '-off')
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('binding 缺失', headRes, modRes)
  check('binding 缺失: stderr 无观测输出', !modRes.stderr.toString('utf8').includes('observability'))
  check('binding 缺失: 零事件写入', !existsSync(ctx0.dbPath) || readEvents(ctx0.dbPath).rows.length === 0)
}
{
  // 3.2 TRELLIS_RECEIPTS=off 全局旁路
  const ctx0 = makeSandbox()
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0, { TRELLIS_RECEIPTS: 'off' })
  assertBaseline('TRELLIS_RECEIPTS=off', headRes, modRes)
  check('TRELLIS_RECEIPTS=off: 零事件写入', readEvents(ctx0.dbPath).rows.length === 0)
}
{
  // 3.3 binding.collectionEnabled=false（面板侧停用采集）
  const ctx0 = makeSandbox()
  ctx0.writeBinding({ collectionEnabled: false })
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('collectionEnabled=false', headRes, modRes)
  check('collectionEnabled=false: 零事件写入', readEvents(ctx0.dbPath).rows.length === 0)
}
{
  // 3.4 installationId 不符（复制到另一机器/安装身份被重置）
  const ctx0 = makeSandbox()
  ctx0.writeBinding({ installationId: 'install-from-another-machine' })
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('installationId 不符', headRes, modRes)
  check('installationId 不符: 零事件写入', readEvents(ctx0.dbPath).rows.length === 0)
}
{
  // 3.5 canonical root 不符（目录被移动/重挂载）
  const ctx0 = makeSandbox()
  ctx0.writeBinding({ canonicalRoot: 'D:\\definitely\\another\\root' })
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('canonical root 不符', headRes, modRes)
  check('canonical root 不符: 零事件写入', readEvents(ctx0.dbPath).rows.length === 0)
}
{
  // 3.6 安装身份缺失（Panel 从未运行）：跳过且不创建任何文件
  const ctx0 = makeSandbox()
  rmSync(join(ctx0.installDir, 'TrellisPanel', 'installation.json'))
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('installation.json 缺失', headRes, modRes)
  check(
    'installation.json 缺失: 零事件写入且未建安装文件',
    readEvents(ctx0.dbPath).rows.length === 0 && !existsSync(join(ctx0.installDir, 'TrellisPanel', 'installation.json'))
  )
}

console.log('== 4. 存储故障矩阵：写库失败不影响 stdout/退出码 ==')
{
  // 4.1 库只读（Windows 只读属性）
  const ctx0 = makeSandbox()
  chmodSync(ctx0.dbPath, 0o444)
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('库只读', headRes, modRes)
  check('库只读: stderr ≤1 行', stderrLineCount(modRes.stderr) <= 1, modRes.stderr.toString('utf8'))
  check('库只读: stderr 不泄露绝对路径', !modRes.stderr.toString('utf8').includes(ctx0.sandbox))
  check('库只读: 零事件写入', readEvents(ctx0.dbPath).rows.length === 0)
  chmodSync(ctx0.dbPath, 0o666)
}
{
  // 4.2 库损坏（垃圾字节）：保留原文件、停写、不改 stdout
  const ctx0 = makeSandbox()
  const garbage = Buffer.from('this is definitely not a sqlite database, keep bytes unchanged after hook run!!')
  writeFileSync(ctx0.dbPath, garbage)
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('库损坏', headRes, modRes)
  check('库损坏: stderr ≤1 行', stderrLineCount(modRes.stderr) <= 1, modRes.stderr.toString('utf8'))
  check('库损坏: 原文件字节保持不变（不自动删除/改名）', readFileSync(ctx0.dbPath).equals(garbage))
}
{
  // 4.3 journal 路径不可创建（模拟 runtime 目录只写失败）
  const ctx0 = makeSandbox()
  mkdirSync(ctx0.dbPath + '-journal')
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('journal 路径不可创建', headRes, modRes)
  check('journal 路径不可创建: stderr ≤1 行', stderrLineCount(modRes.stderr) <= 1, modRes.stderr.toString('utf8'))
  check('journal 路径不可创建: 零事件写入', readEvents(ctx0.dbPath).rows.length === 0)
  rmSync(ctx0.dbPath + '-journal', { recursive: true, force: true })
}
{
  // 4.4 库文件缺失（Panel 未建库）：Hook 不建库，静默跳过
  const ctx0 = makeSandbox()
  rmSync(ctx0.dbPath)
  const headRes = runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0)
  assertBaseline('库缺失', headRes, modRes)
  check('库缺失: 未创建库文件（Panel 是唯一建库方）', !existsSync(ctx0.dbPath))
}

console.log('== 5. 输出故障矩阵 ==')
{
  // 5.1 stdout 管道被父端提前关闭：无 emitted、hook 不挂起
  const ctx0 = makeSandbox({ big: true })
  const stdinText = SUBAGENT_START_STDIN(ctx0.sandbox)
  await new Promise((resolve) => {
    const child = spawn('python', [modifiedHook], { cwd: ctx0.sandbox, env: hookEnv(ctx0), stdio: ['pipe', 'pipe', 'pipe'] })
    let exited = false
    const timer = setTimeout(() => {
      if (!exited) {
        child.kill()
        check('stdout 提前关闭: hook 在 15s 内退出（不挂起）', false)
        resolve()
      }
    }, 15000)
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.stdin.end(stdinText)
    child.stdout.resume()
    child.stdout.destroy() // 父端立刻关闭读端 → 子进程写入 EPIPE
    child.on('exit', (code) => {
      exited = true
      clearTimeout(timer)
      check('stdout 提前关闭: hook 在 15s 内退出（不挂起）', true)
      const { rows } = readEvents(ctx0.dbPath)
      const kinds = rows.map((r) => r.kind)
      check('stdout 提前关闭: 无 emitted 事件（禁止提前/失败记成功）', !kinds.includes('context.emitted'), kinds.join(','))
      const failed = rows.find((r) => r.kind === 'context.output_failed')
      if (check('stdout 提前关闭: 登记 output_failed 证据', failed !== undefined, kinds.join(',')) && failed) {
        const parsed = parseContextEvent(JSON.parse(failed.payload))
        check(
          'stdout 提前关闭: 诊断码为 stdout 写/冲刷失败',
          parsed.success === true && ['stdout_write_failed', 'stdout_flush_failed'].includes(parsed.event.diagnosticCode),
          parsed.success === true ? parsed.event.diagnosticCode : 'parse failed'
        )
      }
      check('stdout 提前关闭: 退出码为有限值', code !== null && Number.isFinite(code), String(code))
      resolve()
    })
  })
}
{
  // 5.2 序列化异常注入（TRELLIS_OBS_TEST_FAIL=serialize：emitter 改写 json.dumps，
  //     自身用加载时捕获的私有引用不受影响——注入方式见 observability_emit 文档）
  const ctx0 = makeSandbox()
  const modRes = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0, { TRELLIS_OBS_TEST_FAIL: 'serialize' })
  check('序列化注入: stdout 为空（未输出）', modRes.stdout.length === 0)
  check('序列化注入: 退出码与原失败语义一致（codex 路径被捕获 → 0）', modRes.status === 0, String(modRes.status))
  const { rows } = readEvents(ctx0.dbPath)
  const kinds = rows.map((r) => r.kind)
  check('序列化注入: 无 emitted', !kinds.includes('context.emitted'), kinds.join(','))
  check('序列化注入: assembled 已落库', kinds.includes('context.assembled'), kinds.join(','))
  const failed = rows.find((r) => r.kind === 'context.output_failed')
  if (check('序列化注入: output_failed 落库', failed !== undefined) && failed) {
    const parsed = parseContextEvent(JSON.parse(failed.payload))
    check('序列化注入: 诊断码 serialization_failed', parsed.success === true && parsed.event.diagnosticCode === 'serialization_failed')
  }
}

/* ---------------- 黄金夹具捕获（--dump-fixtures <dir>，一次性） ---------------- */

const dumpFlag = process.argv.indexOf('--dump-fixtures')
if (dumpFlag !== -1 && process.argv[dumpFlag + 1]) {
  const dumpDir = process.argv[dumpFlag + 1]
  mkdirSync(dumpDir, { recursive: true })
  const ctx0 = makeSandbox()
  const res = runHook(modifiedHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0, {
    TRELLIS_OBS_DUMP_DIR: resolve(dumpDir) // hook cwd 是 sandbox，必须给绝对路径
  })
  assertBaseline('夹具捕获运行', runHook(headHook, SUBAGENT_START_STDIN(ctx0.sandbox), ctx0), res)
  const assembledPath = join(dumpDir, 'python-produced-assembled.json')
  const emittedPath = join(dumpDir, 'python-produced-emitted.json')
  check('夹具捕获: python-produced-assembled.json 已生成', existsSync(assembledPath))
  check('夹具捕获: python-produced-emitted.json 已生成', existsSync(emittedPath))
  console.log(`夹具已写入 ${dumpDir}`)
}

if (failures > 0) {
  console.error(`Hook 观测生产者冒烟：${failures} 项失败`)
  process.exit(1)
}
console.log('Hook 观测生产者冒烟：全部通过 ✓')
