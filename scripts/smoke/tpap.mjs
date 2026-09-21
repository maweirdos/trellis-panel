/**
 * TPAP 接入协议冒烟测试（AC6）：
 *   401 无 token → 200 带 token 读 host → 422 缺 confirm → 变更成功 →
 *   requestId 幂等重放 → 游标增量拉取 → token 轮换后旧 token 失效。
 *
 * 运行：node scripts/smoke/tpap.mjs（自动完成 bundle → 起服 → curl 断言 → 收尾）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'

const PORT = 39589
const BASE = `http://127.0.0.1:${PORT}`

const workDir = mkdtempSync(join(tmpdir(), 'tpap-smoke-'))
process.env.TPAP_SMOKE_DIR = workDir

// settings.json 先于服务启动写入：access 默认关闭，冒烟直接以开启态进入
writeFileSync(join(workDir, 'settings.json'), JSON.stringify({ access: { enabled: true, port: PORT } }), 'utf-8')

const bundle = join(workDir, 'server-bundle.mjs')
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/access/server.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle}`
], { stdio: 'inherit' })

const { accessServer } = await import(pathToFileURL(bundle).href)

await accessServer.syncFromSettings()
await new Promise((r) => setTimeout(r, 400))
console.log('server status:', JSON.stringify(accessServer.status()))

// 触发 token 懒生成：带一个 64 位假 token，使 verifyToken 走到 getAccessToken 并落盘
try {
  await fetch(`${BASE}/tpap/v1/host`, { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } })
} catch (e) {
  console.log('warmup fetch error:', e.cause?.message ?? e.message)
}

/** token 与 server 共享 userData 文件落盘，直接读文件 */
const token = readFileSync(join(workDir, 'access-token'), 'utf-8').trim()

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const req = async (method, path, { token: tk, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

// 1. 无 token → 401
const noAuth = await req('GET', '/tpap/v1/host')
check('无 token 返回 401', noAuth.status === 401 && noAuth.json?.error?.code === 'E_UNAUTHORIZED')

// 2. 错误 token → 401
const badAuth = await req('GET', '/tpap/v1/host', { token: 'f'.repeat(64) })
check('错误 token 返回 401', badAuth.status === 401)

// 3. 带 token → host 200
const host = await req('GET', '/tpap/v1/host', { token })
check('host 200 且协议版本 tpap/1', host.status === 200 && host.json?.data?.protocol === 'tpap/1', JSON.stringify(host.json))

// 4. 变更缺 confirm → 422
const noConfirm = await req('POST', '/tpap/v1/tools/call', { token, body: { toolName: 'db_list_tables', args: {} } })
check('变更缺 confirm 返回 422 E_DENIED', noConfirm.status === 422 && noConfirm.json?.error?.code === 'E_DENIED')

// 5. 变更带 confirm → 200
const rid = 'smoke-rid-1'
const call1 = await req('POST', '/tpap/v1/tools/call', {
  token,
  body: { toolName: 'db_list_tables', args: {}, confirm: true, requestId: rid }
})
check('tools/call 带 confirm 返回 200', call1.status === 200 && call1.json?.ok === true, JSON.stringify(call1.json))

// 6. 同 requestId 重放 → 幂等
const call2 = await req('POST', '/tpap/v1/tools/call', {
  token,
  body: { toolName: 'db_list_tables', args: {}, confirm: true, requestId: rid }
})
check('同 requestId 重放命中幂等缓存', call2.status === 200 && call2.json?.idempotentReplay === true)

// 7. 游标：先取最新 cursor，再拉 events（应含 gateway.tool_called）
const ev1 = await req('GET', '/tpap/v1/events', { token })
check('events 无 cursor 返回 reset（首连语义）', ev1.json?.reset === true && typeof ev1.json?.nextCursor?.seq === 'number')
const cursor = `${ev1.json.nextCursor.epoch}:${ev1.json.nextCursor.seq}`
await req('POST', '/tpap/v1/tools/call', { token, body: { toolName: 'db_list_tables', args: {}, confirm: true, requestId: 'smoke-rid-2' } })
const ev2 = await req('GET', `/tpap/v1/events?cursor=${encodeURIComponent(cursor)}`, { token })
check('游标之后能增量拉到新事件', ev2.json?.reset === false && ev2.json?.events?.some((e) => e.type === 'gateway.tool_called'), JSON.stringify(ev2.json))

// 8. 错误游标 epoch → reset
const ev3 = await req('GET', `/tpap/v1/events?cursor=${encodeURIComponent('bogus-epoch:3')}`, { token })
check('epoch 不匹配触发 reset', ev3.json?.reset === true)

// 9. token 轮换（需 confirm）→ 旧 token 401，新 token 可用
const rotate = await req('POST', '/tpap/v1/token/rotate', { token, body: { confirm: true, requestId: 'smoke-rotate-1' } })
check('token/rotate 返回 200', rotate.status === 200)
const newToken = readFileSync(join(workDir, 'access-token'), 'utf-8').trim()
check('轮换后 token 已变化', newToken !== token)
const oldAfter = await req('GET', '/tpap/v1/host', { token })
check('旧 token 轮换后 401', oldAfter.status === 401)
const newAfter = await req('GET', '/tpap/v1/host', { token: newToken })
check('新 token 可继续访问', newAfter.status === 200)

// 10. 非环回路径不可达性（代码层 listen('127.0.0.1') 硬编码，无配置面）
console.log('  ℹ 环回绑定由 server.listen(port, "127.0.0.1") 硬编码保证（无可配置项）')

/* 11. 对话只读面：列表 + 单个转录（复用 chat-store 单一实现） */
const chatStoreBundle = join(workDir, 'chatstore-bundle.mjs')
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/chat-store.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${chatStoreBundle}`
], { stdio: 'inherit' })
const chatStore = await import(pathToFileURL(chatStoreBundle).href)
const created = chatStore.createSession({ getPath: () => workDir }, { providerId: 'p1', modelId: 'm1' })
const listed = await req('GET', '/tpap/v1/chat/sessions', { token: newToken })
check(
  'chat/sessions 列出会话',
  listed.status === 200 && listed.json?.data?.some((x) => x.id === created.id),
  JSON.stringify(listed.json).slice(0, 160)
)
const readOne = await req('GET', `/tpap/v1/chat/session?id=${created.id}`, { token: newToken })
check('chat/session 读取完整转录', readOne.status === 200 && readOne.json?.data?.id === created.id)
const readMissing = await req('GET', '/tpap/v1/chat/session?id=nonexistent', { token: newToken })
check('chat/session 不存在返回 404', readMissing.status === 404 && readMissing.json?.error?.code === 'E_NOT_FOUND')

/* 12. ToolSearch deferred 模式（roadmap #6） */
const deferredTools = await req('GET', '/tpap/v1/tools?mode=deferred', { token: newToken })
check(
  'deferred 模式仅暴露 tool_search 元工具',
  deferredTools.status === 200 && deferredTools.json?.data?.length === 1 && deferredTools.json.data[0].name === 'tool_search',
  JSON.stringify(deferredTools.json).slice(0, 160)
)
const searchCall = await req('POST', '/tpap/v1/tool_search', { token: newToken, body: { query: 'sql' } })
check(
  'tool_search 按关键词检索到 sql 工具',
  searchCall.status === 200 && searchCall.json?.data?.some((t) => t.name === 'db_query_readonly'),
  JSON.stringify(searchCall.json).slice(0, 160)
)
const fullTools = await req('GET', '/tpap/v1/tools', { token: newToken })
check('默认模式仍返回全量工具目录', fullTools.status === 200 && (fullTools.json?.data?.length ?? 0) >= 8)

accessServer.stop()
rmSync(workDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`TPAP smoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('TPAP smoke: 全部通过')
