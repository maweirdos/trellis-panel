/**
 * G4 第二片：轻任务链路计量脚手架（implement.md「计量新增重复录入、同范围重复确认、
 * 新增管理动作」；试点目标 0 / 0 / ≤2）。
 *
 * 口径声明（fixture）：
 * - 输入为 fixture Jira 工单（mock 传输层 + 真实描述文本），本地侧为真实 python +
 *   真实 task.py 副本于 fixture 仓库——即「服务侧事件计数 / 步骤枚举」口径；
 * - 真实工单录制（用户在真实公司 Jira 上走查并计时/计数）待用户执行，
 *   本脚本结果不冒充试点数据（validation/light-task.md 登记待办）；
 * - 指标定义（与 prd FR4 对齐）：
 *   · 重复录入 = 已提供过的信息需要再次录入的次数（本链证据：重复点击后 CLI create
 *     调用数与任务目录数均不增加；描述由服务侧来源快照承载，无二次输入点）；
 *   · 同范围重复确认 = 同一已定事实被再次要求确认/执行的次数（本链证据：重复点击
 *     返回 already 直接打开、无确认弹层；流转不确定结果先查证，不盲目重复 POST）；
 *   · 新增管理动作 = 主链（创建→重复点击→归档→流转）之外、由系统引发的额外用户
 *     干预（conflict/cli_failed/control_store/interrupted/missing 等需人工处理的结局）。
 * 运行：node scripts/smoke/light-task-metrics.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, cpSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'

const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
const repoRoot = process.cwd()
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-light-task-metrics-'))
let failures = 0
let skipped = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}
const skip = (name) => {
  console.log(`  - SKIP ${name}`)
  skipped += 1
}
const norm = (s) => String(s).replace(/\r\n/g, '\n')

/* ---------------- 打包：jira 服务 + local-task（electron → 冒烟桩） ---------------- */

process.env.TPAP_SMOKE_DIR = workDir
const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export { jiraTransitionVerified } from '${abs('src/main/services/jira.ts')}'`,
    `export * from '${abs('src/main/services/local-task/index.ts')}'`
  ].join('\n'),
  'utf-8'
)
const bundle = join(workDir, 'bundle.mjs')
execFileSync(
  process.execPath,
  [
    join('node_modules', 'esbuild', 'bin', 'esbuild'),
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--alias:electron=${abs('scripts/smoke/mock-electron.mjs')}`,
    `--outfile=${bundle}`
  ],
  { stdio: 'inherit' }
)
const m = await import(pathToFileURL(bundle).href)
const { jiraTransitionVerified, createOrOpenTaskFromJira, archiveLocalTask, runTaskCreateCli } = m

/* ---------------- 通用夹具 ---------------- */

const CFG = { enabled: true, baseUrl: 'http://jira.example.com', user: 'dev', password: 'x', jql: '', statusMap: {} }
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
const timeoutError = () => {
  const e = new Error('The operation was aborted due to timeout')
  e.name = 'TimeoutError'
  return e
}

/* 指标累加器（主链与灵敏度验证分开累计） */
const metrics = { duplicateEntry: 0, duplicateConfirm: 0, managementActions: 0 }
const sensitivity = { duplicateEntry: 0, duplicateConfirm: 0, managementActions: 0 }
const userActions = [] // 主链步骤枚举（谁在何时点了什么）

let pythonCmd = null
for (const candidate of ['python', 'python3']) {
  try {
    const r = spawnSync(candidate, ['-V'], { encoding: 'utf-8', timeout: 8000 })
    if (r.status === 0) {
      pythonCmd = candidate
      break
    }
  } catch {
    /* try next */
  }
}

if (pythonCmd === null) {
  skip('全链计量（本机无 python，真实 CLI 路径未验证——如实记录，不用桩冒充）')
} else {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'tpanel-light-metrics-repo-'))
  mkdirSync(join(fixtureRepo, '.trellis'), { recursive: true })
  cpSync(join(repoRoot, '.trellis', 'scripts'), join(fixtureRepo, '.trellis', 'scripts'), { recursive: true })
  writeFileSync(join(fixtureRepo, '.trellis', '.developer'), 'name=metrics-dev\n', 'utf-8')
  try {
    execFileSync('git', ['init'], { cwd: fixtureRepo })
    execFileSync('git', ['config', 'user.email', 'metrics@local'], { cwd: fixtureRepo })
    execFileSync('git', ['config', 'user.name', 'metrics'], { cwd: fixtureRepo })
  } catch {
    /* 无 git 时归档记账提交降级，不阻塞计量链 */
  }

  const INSTANCE = 'jira-metrics-instance-0001'
  const makeInput = (over = {}) => ({
    root: fixtureRepo,
    instanceId: INSTANCE,
    issueKey: 'MET-101',
    issueId: 510101,
    title: '[MET-101] 计量链路工单',
    summaryDescription: '计量短描述：登录偶发超时',
    description: '完整描述：登录接口偶发超时（>3s）。\n复现步骤：\n1. 低峰期登录\n2. 观察耗时\n包含 {panel} 标记与 [链接|http://x] 原文。',
    url: 'http://jira.example.com/browse/MET-101',
    updatedAtMs: 1760172000000,
    priority: 'P1',
    assignee: 'metrics-dev',
    fetchedAtMs: 1760172001000,
    ...over
  })
  const tasksRoot = join(fixtureRepo, '.trellis', 'tasks')
  const listTaskDirs = () => {
    try {
      return readdirSync(tasksRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => n !== 'archive')
    } catch {
      return []
    }
  }

  /** CLI create 调用计数（重复录入的服务侧证据：默认重复点击不得再次 create） */
  let cliCreateCalls = 0
  const countingRunner = async (opts, args) => {
    cliCreateCalls += 1
    return runTaskCreateCli(opts, args)
  }

  console.log('\n== 主链：创建 → 重复点击 → 归档 → Jira 流转（fixture 工单，真实 CLI） ==')

  /* 步骤 1：首次点击——创建 */
  {
    userActions.push('点击「在当前项目创建任务」（MET-101，第 1 次）')
    const res = await createOrOpenTaskFromJira(makeInput(), { cliRunner: countingRunner })
    const ok = res.ok === true && res.created === true && res.stage === 'ready'
    check('创建成功 ready（created）', ok, JSON.stringify(res).slice(0, 300))
    if (!ok) metrics.managementActions += 1 // 创建未达成：需用户介入
    check('CLI create 恰被调用 1 次', cliCreateCalls === 1)
  }
  const dirsAfterCreate = listTaskDirs()

  /* 步骤 2：重复点击——默认打开已有（不新建、不确认） */
  {
    userActions.push('重复点击同一入口（MET-101，第 2 次）')
    const res = await createOrOpenTaskFromJira(makeInput(), { cliRunner: countingRunner })
    const openedExisting = res.ok === true && res.already === true && res.dirName === dirsAfterCreate[0]
    check('重复点击打开已有（already，同目录）', openedExisting, JSON.stringify(res).slice(0, 300))
    check('重复点击未再次调用 CLI create', cliCreateCalls === 1)
    check('任务目录数仍为 1（无重复录入产物）', listTaskDirs().length === 1)
    if (!openedExisting) metrics.duplicateEntry += listTaskDirs().length - 1
    if (res.ok === false && res.code === 'conflict') {
      // 多候选冲突会要求用户再次选择 = 同范围重复确认 + 管理动作
      metrics.duplicateConfirm += 1
      metrics.managementActions += 1
    }
  }

  /* 步骤 3：本地归档（真实 task.py archive；与 Jira 流转分离） */
  {
    userActions.push('本地归档任务（task.py archive）')
    const arch = await archiveLocalTask(fixtureRepo, dirsAfterCreate[0], { pythonCommand: pythonCmd })
    check('归档成功（fs 核实）', arch.ok === true && !existsSync(join(tasksRoot, dirsAfterCreate[0])), JSON.stringify(arch).slice(0, 300))
    if (!arch.ok) metrics.managementActions += 1
  }

  /* 步骤 4：Jira 流转（fixture 传输层）——显式执行 + 重读核实；不确定先查证不盲重试 */
  {
    userActions.push('手动 Jira 流转（Done）')
    let posts = 0
    const transport = async (_url, init) => {
      if (init?.method === 'POST') {
        posts += 1
        return jsonResponse({}, 200)
      }
      return jsonResponse({ fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } })
    }
    const res = await jiraTransitionVerified(CFG, 'MET-101', '31', { transport, expectedToStatus: 'Done' })
    check('流转成功且重读核实（re-read）', res.ok === true && res.verified === 're-read' && res.status === 'Done')
    check('流转 POST 恰一次（无重复执行）', posts === 1)

    // 不确定结果（POST 超时）→ 先查证：已达目标 → already_applied，不盲目重复
    let posts2 = 0
    const transportUncertain = async (_url, init) => {
      if (init?.method === 'POST') {
        posts2 += 1
        throw timeoutError()
      }
      return jsonResponse({ fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } })
    }
    const retry = await jiraTransitionVerified(CFG, 'MET-101', '31', { transport: transportUncertain, expectedToStatus: 'Done' })
    check('超时后查证已达目标 → already_applied（超时≠成功口径）', retry.ok === true && retry.verified === 'already_applied')
    check('不确定结果未盲目重复 POST（单次调用内恰一次）', posts2 === 1)
    if (retry.ok !== true) metrics.duplicateConfirm += 1 // 需要用户再次确认执行
  }

  /* 步骤 5：分离验证——Jira 403 不回滚本地归档 */
  {
    const fail = await jiraTransitionVerified(CFG, 'MET-101', '31', { transport: async () => jsonResponse({ errorMessages: ['无权限'] }, 403) })
    check('Jira 权限不足独立反馈（permission）', fail.ok === false && fail.code === 'permission')
    check('本地归档不因 Jira 失败回滚（归档目录仍在）', readdirSync(join(tasksRoot, 'archive'), { recursive: true }).some((p) => String(p).includes(dirsAfterCreate[0])))
  }

  console.log('\n== 计量器灵敏度验证（counter-example；不计入主链指标） ==')

  /* 灵敏度 A：一单多任务后默认点击 → conflict（需人工选择）→ 管理动作 +1 */
  {
    const second = await createOrOpenTaskFromJira(makeInput({ allowAdditional: true }))
    check('[灵敏度] 显式一单多任务创建第二任务', second.ok === true && second.created === true)
    const third = await createOrOpenTaskFromJira(makeInput())
    const conflicted = third.ok === false && third.code === 'conflict'
    check('[灵敏度] 默认点击遇多任务 → conflict 可见', conflicted)
    if (conflicted) sensitivity.managementActions += 1
  }

  /* 灵敏度 B：CLI 失败（注入退出码 1）→ 需重试（管理动作 +1）；重试可恢复 */
  {
    const over = { issueKey: 'MET-902', issueId: 510902, title: '[MET-902] CLI 失败灵敏度' }
    let failOnce = true
    const failRunner = async (opts, args) => {
      if (failOnce) {
        failOnce = false
        return { code: 1, stdout: '', stderr: 'Error: simulated failure', aborted: false, failedToStart: false, createdDirName: null }
      }
      return runTaskCreateCli(opts, args)
    }
    const failed = await createOrOpenTaskFromJira(makeInput(over), { cliRunner: failRunner })
    check('[灵敏度] CLI 失败 → cli_failed（未创建≠失败）', failed.ok === false && failed.code === 'cli_failed')
    if (failed.ok === false && failed.code === 'cli_failed') sensitivity.managementActions += 1
    const recovered = await createOrOpenTaskFromJira(makeInput(over))
    check('[灵敏度] 同操作重试恢复成功', recovered.ok === true && recovered.created === true)
  }

  rmSync(fixtureRepo, { recursive: true, force: true })
}

/* ---------------- 输出（fixture 口径，如实标注） ---------------- */

console.log('\n== 轻任务链路计量结果（fixture 口径，非真实工单录制） ==')
for (const [label, act] of userActions.entries()) console.log(`  步骤${label + 1} · ${act}`)
console.log(`  重复录入：${metrics.duplicateEntry}（试点目标 0）`)
console.log(`  同范围重复确认：${metrics.duplicateConfirm}（试点目标 0）`)
console.log(`  新增管理动作：${metrics.managementActions}（试点目标 ≤2）`)
console.log(`  计量器灵敏度（counter-example，不并入主链）：管理动作 ${sensitivity.managementActions} 例被正确计数`)
console.log('  边界：Jira 侧为 mock 传输层 fixture；本地侧为真实 python + task.py 副本。')
console.log('  待办：真实工单录制（用户在公司 Jira 实际走查并计数）——validation/light-task.md 登记。')

check(
  '主链指标达标（0 / 0 / ≤2）',
  metrics.duplicateEntry === 0 && metrics.duplicateConfirm === 0 && metrics.managementActions <= 2,
  JSON.stringify(metrics)
)
check('灵敏度验证确有计数（计量器能发现偏差）', sensitivity.managementActions >= 2)

rmSync(workDir, { recursive: true, force: true })
console.log(`\n结果：${failures === 0 ? 'PASS' : 'FAIL'}（失败 ${failures}，跳过 ${skipped}）`)
process.exit(failures === 0 ? 0 : 1)
