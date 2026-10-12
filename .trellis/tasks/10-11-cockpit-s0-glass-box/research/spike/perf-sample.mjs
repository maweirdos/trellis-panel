/**
 * 观测开销采样（implement.md G4 / design §9 初值验证）：
 * 同一 stdin 夹具交错运行 hook（TRELLIS_RECEIPTS=on/off），配对差值即观测开销，
 * 消除解释器启动与环境漂移。正常/大材料两档，各 200 对（预热 10 对丢弃）。
 * 口径：直接调用 hook 脚本（sandbox），非真实 Codex 宿主端到端——报告如实标注。
 * 运行：node .trellis/tasks/10-11-cockpit-s0-glass-box/research/spike/perf-sample.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { realpathSync } from 'fs'
import { pathToFileURL } from 'url'

// hook 以 cwd=sandbox 运行：必须用仓库内绝对路径
const HOOK = resolve(process.cwd(), '.codex', 'hooks', 'inject-subagent-context.py')
const PAIRS = Number(process.env.PERF_PAIRS ?? 200)
const WARMUP = 10

const repeatToBytes = (seed, bytes) => {
  let out = ''
  while (out.length < bytes) out += seed
  return out.slice(0, bytes)
}

async function buildSandbox(big) {
  const base = mkdtempSync(join(tmpdir(), `perf-obs-${big ? 'big' : 'norm'}-`))
  const sandbox = join(base, 'repo')
  const installDir = join(base, 'appdata')
  const TASK_DIR = '.trellis/tasks/10-11-fixture'
  for (const d of [
    join(sandbox, TASK_DIR),
    join(sandbox, '.trellis/spec/frontend'),
    join(sandbox, '.trellis/spec/shared'),
    join(sandbox, '.trellis/spec/extra'),
    join(sandbox, 'assets'),
    join(sandbox, '.trellis/.runtime/sessions'),
    join(installDir, 'TrellisPanel')
  ]) {
    mkdirSync(d, { recursive: true })
  }
  const maxFile = big ? 60000 : 3000
  writeFileSync(
    join(sandbox, '.trellis', 'config.yaml'),
    ['context_injection:', `  max_file_bytes: ${maxFile}`, `  max_artifact_bytes: ${maxFile}`, '  max_total_bytes: 200000', ''].join('\n'),
    'utf8'
  )
  writeFileSync(join(sandbox, TASK_DIR, 'task.json'), JSON.stringify({ id: 'perf-fixture-001', title: 'perf', status: 'in_progress' }, null, 2), 'utf8')
  writeFileSync(join(sandbox, TASK_DIR, 'prd.md'), repeatToBytes('# PRD\n\n性能采样夹具。\n', big ? 90000 : 1200), 'utf8')
  writeFileSync(join(sandbox, TASK_DIR, 'design.md'), repeatToBytes('# Design\n\n夹具。\n', big ? 60000 : 1200), 'utf8')
  writeFileSync(
    join(sandbox, TASK_DIR, 'implement.jsonl'),
    [
      '{"file": ".trellis/spec/frontend/components.md", "reason": "spec"}',
      '{"file": ".trellis/spec/shared/typescript.md", "reason": "truncated"}',
      '{"file": "assets/logo.bin", "reason": "binary"}',
      '{"file": ".trellis/spec/shared/missing.md", "reason": "missing"}',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(join(sandbox, '.trellis', 'spec', 'frontend', 'components.md'), repeatToBytes('# Components\n\n夹具。\n', big ? 40000 : 800), 'utf8')
  writeFileSync(join(sandbox, '.trellis', 'spec', 'shared', 'typescript.md'), repeatToBytes('# TS\n\n夹具。\n', big ? 40000 : 3500), 'utf8')
  writeFileSync(join(sandbox, '.trellis', 'spec', 'extra', 'a.md'), '# A\n', 'utf8')
  writeFileSync(join(sandbox, 'assets', 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x1a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))
  writeFileSync(join(sandbox, '.trellis', '.runtime', 'sessions', 'codex_parent-1.json'), JSON.stringify({ current_task: TASK_DIR }), 'utf8')
  writeFileSync(join(installDir, 'TrellisPanel', 'installation.json'), JSON.stringify({ installationId: 'perf-installation', createdAtMs: Date.now() }, null, 2), 'utf8')

  const runtimeDir = join(sandbox, '.trellis', '.panel', 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const canonicalRoot = realpathSync.native(sandbox)
  writeFileSync(
    join(runtimeDir, 'binding.json'),
    JSON.stringify({ schemaVersion: 1, installationId: 'perf-installation', repositoryId: 'perf-repo', workspaceId: 'perf-ws', canonicalRoot, gitCommonDir: null, worktreeRoot: null, boundAtMs: Date.now(), collectionEnabled: true }, null, 2),
    'utf8'
  )
  // Panel 是唯一建库方：esbuild 打包 store-core 建库（与生产 schema 一致）
  const workDir = mkdtempSync(join(tmpdir(), 'perf-obs-bundle-'))
  const entry = join(workDir, 'entry.ts')
  const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
  writeFileSync(entry, `export { ObservationStoreCore } from '${abs('src/main/services/observability/store-core.ts')}'`, 'utf8')
  const bundle = join(workDir, 'bundle.mjs')
  execFileSync(process.execPath, [join('node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`], { stdio: 'ignore' })
  const { ObservationStoreCore } = await import(pathToFileURL(bundle).href)
  const core = new ObservationStoreCore(runtimeDir)
  core.open()
  core.close()
  rmSync(workDir, { recursive: true, force: true })
  return { base, sandbox, installDir, stdin: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'trellis-implement', session_id: 'parent-1', cwd: sandbox }) }
}

const envOf = (ctx, receiptsOn) => {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('TRELLIS_')) continue
    env[k] = v
  }
  env.LOCALAPPDATA = ctx.installDir
  if (!receiptsOn) env.TRELLIS_RECEIPTS = 'off'
  return env
}

const runOnce = (ctx, receiptsOn) => {
  const t0 = process.hrtime.bigint()
  const res = spawnSync('python', ['-X', 'utf8', HOOK], { input: ctx.stdin, cwd: ctx.sandbox, env: envOf(ctx, receiptsOn), timeout: 15000 })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  if (res.status !== 0) throw new Error(`hook exit ${res.status} (${receiptsOn ? 'on' : 'off'}): ${res.stderr?.toString().slice(0, 200)}`)
  return ms
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] }
}
const fmt = (s) => `p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`

const results = {}
for (const big of [false, true]) {
  const ctx = await buildSandbox(big)
  const offs = []
  const ons = []
  const deltas = []
  for (let i = 0; i < WARMUP + PAIRS; i++) {
    const off = runOnce(ctx, false)
    const on = runOnce(ctx, true)
    if (i >= WARMUP) {
      offs.push(off)
      ons.push(on)
      deltas.push(on - off)
    }
  }
  const label = big ? '大材料（~250KB 上下文）' : '正常材料（~12KB 上下文）'
  results[big ? 'big' : 'normal'] = { offs, ons, deltas }
  console.log(`${label}  off: ${fmt(stats(offs))}`)
  console.log(`${label}   on: ${fmt(stats(ons))}`)
  console.log(`${label} Δobs: ${fmt(stats(deltas))}`)
  rmSync(ctx.base, { recursive: true, force: true })
}

const py = spawnSync('python', ['-X', 'utf8', '-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8' })
const report = `# 观测开销性能报告（performance）

日期：${new Date().toISOString().slice(0, 10)}。**口径：直接调用 hook 脚本的 sandbox 配对采样（on/off 交错、差值消漂移），每档 ${PAIRS} 对 + 预热 ${WARMUP} 对丢弃；不是真实 Codex 宿主端到端**（后者待用户走查，见 validation/reader.md）。

环境：Python ${py.stdout.trim()} / Node ${process.version} / Windows；材料构成（spec×3 含截断与二进制、任务产物 prd/design、implement.md 缺失）见 research/spike/perf-sample.mjs。

| 档位 | 关（off） | 开（on） | 观测开销 Δ=on−off |
| --- | --- | --- | --- |
| 正常材料 | ${fmt(stats(results.normal.offs))} | ${fmt(stats(results.normal.ons))} | ${fmt(stats(results.normal.deltas))} |
| 大材料 | ${fmt(stats(results.big.offs))} | ${fmt(stats(results.big.ons))} | ${fmt(stats(results.big.deltas))} |

结论要点（由脚本生成时如实填写）：
- 设计试验预算（p95≤50ms / p99≤150ms）是否达成：正常 Δp95=${stats(results.normal.deltas).p95.toFixed(1)}ms，大材料 Δp95=${stats(results.big.deltas).p95.toFixed(1)}ms。
- on 模式每次注入产生 assembled+emitted 两条事件（含 sha256 摘要与 SQLite 短事务）。
- 未覆盖：真实宿主调用形态（进程复用差异）、长会话累计、并发子代理竞争。
`
const { writeFileSync: wf } = await import('fs')
wf(join('.trellis', 'tasks', '10-11-cockpit-s0-glass-box', 'validation', 'performance.md'), report, 'utf-8')
console.log('\n报告已写入 validation/performance.md')
