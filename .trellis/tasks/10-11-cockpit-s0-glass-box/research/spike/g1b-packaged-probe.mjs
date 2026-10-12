/**
 * G1-B 打包运行时探针：用随包 Electron 二进制（ELECTRON_RUN_AS_NODE）验证
 * 1) 交付运行时内 node:sqlite 可用；
 * 2) app.asar.unpacked 中的 observation-worker.js 可被 worker_threads 加载并响应协议。
 * 协议：请求 { requestId, op, args }，响应 { requestId, ok, result|error }（observation-worker.ts）。
 * 运行（在仓库根）：
 *   ELECTRON_RUN_AS_NODE=1 "release/win-unpacked/Trellis Panel.exe" <本脚本>
 */
import { Worker } from 'node:worker_threads'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const unpacked = join('release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'out', 'main', 'observation-worker.js')

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

/* 1. 交付运行时的 node:sqlite */
try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t(a)')
  db.prepare('INSERT INTO t VALUES(?)').run(1)
  check(`打包运行时 node:sqlite 可用（sqlite ${db.prepare('SELECT sqlite_version() v').get().v}）`, true)
  db.close()
} catch (e) {
  check('打包运行时 node:sqlite 可用', false, String(e))
}

/* 2. 真实加载 unpacked worker 并驱动协议 */
const worker = new Worker(new URL(pathToFileURL(unpacked).href))
const pending = new Map()
let reqId = 0
let workerBroken = null
const call = (op, args) => {
  if (workerBroken !== null) return Promise.reject(new Error(workerBroken))
  const id = ++reqId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`worker ${op} 10s 超时`))
    }, 10000)
    pending.set(id, {
      settle: (msg) => {
        clearTimeout(timer)
        resolve(msg)
      }
    })
    worker.postMessage({ requestId: id, op, args })
  })
}
worker.on('message', (msg) => {
  pending.get(msg.requestId)?.settle(msg)
  pending.delete(msg.requestId)
})
worker.on('error', (e) => {
  workerBroken = `worker error: ${e}`
})
worker.on('exit', (code) => {
  workerBroken = workerBroken ?? `worker exit ${code}`
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'g1b-pack-'))
const repoRoot = join(tmpRoot, 'repo')
mkdirSync(join(repoRoot, '.trellis'), { recursive: true })
writeFileSync(join(repoRoot, '.trellis', 'config.yaml'), '# probe\n', 'utf-8')
const runtimeDir = join(repoRoot, '.trellis', '.panel', 'runtime')

try {
  const init = await call('init', {
    runtimeDir,
    binding: {
      installationId: 'probe-installation',
      repositoryId: 'repo-probe',
      workspaceId: 'ws-probe',
      canonicalRoot: repoRoot,
      collectionEnabled: true
    },
    limits: null
  })
  check('unpacked worker init 响应', init?.ok === true, JSON.stringify(init).slice(0, 200))

  const fixture = {
    schemaVersion: 1,
    eventId: 'g1b-packaged-0001',
    injectionId: 'g1b-inj-0001',
    kind: 'context.emitted',
    occurredAtMs: Date.now(),
    producer: { host: 'probe', hook: 'probe-hook', version: '0', capability: 'probe' },
    scope: {
      repositoryId: 'repo-probe',
      workspaceId: 'ws-probe',
      taskRef: null,
      trellisTaskId: null,
      taskPath: null,
      association: 'unresolved'
    },
    session: { parentId: null, childId: null, runId: null },
    materials: [],
    totals: {
      expectedEntries: null,
      recordedEntries: 0,
      omittedEntries: 0,
      contextUtf8Bytes: 0,
      stdoutUtf8Bytes: null,
      budgetBytes: null,
      completeness: 'not_applicable'
    },
    outputDigest: null,
    diagnosticCode: null
  }
  const ins = await call('insert', { event: fixture, receivedAtMs: Date.now() })
  check('worker 插入事件接受', ins?.ok === true, JSON.stringify(ins).slice(0, 200))

  const q = await call('query', {
    scope: { workspaceId: 'ws-probe' },
    request: { after: 0, limit: 10 }
  })
  const items = q?.ok === true ? (q.result?.items ?? []) : []
  check('worker 查询可见刚插入事件', items.length === 1 && items[0].eventId === 'g1b-packaged-0001', JSON.stringify(q).slice(0, 240))

  const h = await call('health', null)
  check('worker health 响应', h?.ok === true, JSON.stringify(h).slice(0, 140))

  await call('close', null)
  await worker.terminate()
} catch (e) {
  check('unpacked worker 协议驱动', false, String(e))
  try {
    await worker.terminate()
  } catch {
    /* 已退出 */
  }
} finally {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* Windows 句柄延迟释放不碍事 */
  }
}

if (failures > 0) {
  console.error(`G1-B 打包探针：${failures} 项失败`)
  process.exit(1)
}
console.log('G1-B 打包探针：全部通过 ✓')
