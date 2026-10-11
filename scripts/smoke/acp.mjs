/**
 * ACP 服务级冒烟（10-09-acp-agent-console）：
 * esbuild 打包真实 src/main/services/acp.ts（electron 桩），驱动真实 mock agent 子进程，
 * 全链路断言：注册表探测 → 建会话（initialize/session/new）→ prompt（思考/工具/消息分片）
 * → 权限卡广播 → 放行 → 工具完成 → turn-done → trellis 轨道（watcher 路由/notify 前缀）
 * → 会话记录落盘 → 结束进程树。
 * 运行：node scripts/smoke/acp.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'

const workDir = mkdtempSync(join(tmpdir(), 'tpanel-acp-smoke-'))
process.env.TPAP_SMOKE_DIR = workDir

const bundle = join(workDir, 'acp-bundle.mjs')
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/acp.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle}`
], { stdio: 'inherit' })

const acp = await import(pathToFileURL(bundle).href)

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const events = () => globalThis.__TPANEL_EVENTS__ ?? []
const outEvents = () => events().filter((e) => e.channel === 'acp:output').map((e) => e.payload)
const permEvents = () => events().filter((e) => e.channel === 'acp:permission').map((e) => e.payload)
const doneEvents = () => events().filter((e) => e.channel === 'acp:done').map((e) => e.payload)
const waitFor = async (pred, label, timeoutMs = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = pred()
    if (hit) return hit
    await sleep(60)
  }
  throw new Error(`等待超时：${label}`)
}

const projectRoot = join(workDir, 'proj')
mkdirSync(join(projectRoot, '.trellis', 'tasks', '10-09-demo'), { recursive: true })
mkdirSync(join(projectRoot, '.trellis', 'spec', 'backend'), { recursive: true })

try {
  /* ① 注册表：mock 预置可用 */
  const { agents } = acp.listAcpAgents()
  const mock = agents.find((a) => a.id === 'mock')
  check('注册表含 mock 且可用', !!mock && mock.available === true)

  /* ② 建会话 → ready */
  const created = acp.newAcpSession(projectRoot, { agentId: 'mock' })
  check('建会话返回 sessionId', created.ok === true && typeof created.sessionId === 'string')
  const sid = created.sessionId
  await waitFor(() => doneEvents().some((d) => d.sessionId === sid && d.status === 'ready'), '会话 ready')

  /* ③ prompt 全链路：思考 → 工具 pending → 权限 → 放行 → completed → 消息 → turn-done */
  const promptPromise = acp.promptAcpSession(sid, '请生成 PRD')
  await waitFor(() => outEvents().some((e) => e.kind === 'tool-call' && e.payload?.status === 'pending'), '工具 pending')
  const perm = await waitFor(() => permEvents().find((p) => p.sessionId === sid), '权限请求广播')
  check(
    '权限选项三态齐备',
    ['allow_once', 'allow_always', 'reject_once'].every((k) => perm.options.some((o) => o.kind === k))
  )
  const allowOnce = perm.options.find((o) => o.kind === 'allow_once')
  const resp = acp.respondAcpPermission(perm.requestId, allowOnce.optionId)
  check('权限放行回写成功', resp.ok === true)
  const promptRes = await promptPromise
  check('prompt 完成 ok', promptRes.ok === true)
  const kinds = outEvents().map((e) => e.kind)
  check('思考分片入流', kinds.includes('thought'))
  check('工具完成入流', outEvents().some((e) => e.kind === 'tool-call' && e.payload?.status === 'completed'))
  check('agent 消息入流', outEvents().some((e) => e.kind === 'message' && !e.payload?.role))
  check('用户消息回显', outEvents().some((e) => e.kind === 'message' && e.payload?.role === 'user'))
  check('turn-done 入流', kinds.includes('turn-done'))
  await waitFor(() => doneEvents().some((d) => d.sessionId === sid && d.status === 'ready'), '回合后回 ready')

  /* ④ 会话记录落盘 */
  await waitFor(() => existsSync(join(workDir, 'acp-sessions', `${sid}.json`)), '记录落盘')
  const rec = JSON.parse(readFileSync(join(workDir, 'acp-sessions', `${sid}.json`), 'utf-8'))
  check('记录含事件且 agent 名正确', Array.isArray(rec.events) && rec.events.length > 0 && rec.agentName.includes('Mock'))

  /* ⑤ trellis 轨道：watcher 路由 */
  writeFileSync(join(projectRoot, '.trellis', 'tasks', '10-09-demo', 'task.json'), JSON.stringify({ status: 'in_progress' }))
  acp.routeWatcherEvent(projectRoot, join(projectRoot, '.trellis', 'tasks', '10-09-demo', 'task.json'), 'change')
  await waitFor(() => outEvents().some((e) => e.source === 'trellis' && e.kind === 'task-status'), 'task-status 卡片')
  check(
    'task-status 含状态字段',
    outEvents().some((e) => e.kind === 'task-status' && e.payload?.status === 'in_progress')
  )
  acp.routeWatcherEvent(projectRoot, join(projectRoot, '.trellis', 'tasks', '10-09-demo', 'prd.md'), 'add')
  check('doc-created 卡片', outEvents().some((e) => e.source === 'trellis' && e.kind === 'doc-created'))
  acp.routeWatcherEvent(projectRoot, join(projectRoot, '.trellis', 'spec', 'backend', 'index.md'), 'change')
  check('spec-updated 卡片', outEvents().some((e) => e.source === 'trellis' && e.kind === 'spec-updated'))
  acp.routeNotifyRail(projectRoot, 'acp:spec-injected:注入 spec/backend/index.md')
  check('notify 前缀路由 spec-injected', outEvents().some((e) => e.kind === 'spec-injected'))
  acp.routeNotifyRail(projectRoot, '普通桥接消息不进轨道')
  check('普通 notify 不进轨道', !outEvents().some((e) => e.text === '普通桥接消息不进轨道'))

  /* ⑥ jira 轨道入口 */
  acp.emitTrellisTimeline(projectRoot, 'jira-sync', 'Jira 流转：DEV-12', { key: 'DEV-12' })
  check('jira-sync 卡片', outEvents().some((e) => e.source === 'trellis' && e.kind === 'jira-sync'))

  /* ⑦ 结束会话（进程树退出 → closed） */
  const killRes = acp.killAcpSession(sid)
  check('结束会话 ok', killRes.ok === true)
  await waitFor(() => doneEvents().some((d) => d.sessionId === sid && d.status === 'closed'), '会话 closed')
  const after = acp.promptAcpSession(sid, '不应发出')
  check('结束后再发被拒绝', (await after).ok === false)

  console.log(failures === 0 ? '\nACP 服务冒烟：全部通过 ✓' : `\nACP 服务冒烟：${failures} 项失败 ✗`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (e) {
  console.error(`\nACP 服务冒烟失败：${e.message}`)
  process.exitCode = 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
