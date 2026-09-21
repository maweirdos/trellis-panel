/**
 * 对话产品化冒烟（AC1–AC5）：
 * mock OpenAI SSE 服务 + 真实 chat/ai/gateway 服务全链路：
 *   模型探测 → 流式对话落库 → 忙碌排队自动续发 → 中止 → 标题总结 →
 *   路径围栏拒绝穿越 → 截断契约字段。
 * 运行：node scripts/smoke/chat.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { createServer } from 'http'

const PORT = 39617
const BASE = `http://127.0.0.1:${PORT}`

process.on('unhandledRejection', (r) => console.error('UNHANDLED REJECTION:', r))

const workDir = mkdtempSync(join(tmpdir(), 'tpanel-chat-smoke-'))
process.env.TPAP_SMOKE_DIR = workDir

/* ---------------- mock OpenAI 服务 ---------------- */

let completionCount = 0
const activeStreams = new Set()
const mockServer = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (process.env.CHAT_SMOKE_DEBUG) console.log('MOCK REQ:', req.method, url)
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }))
    return
  }
  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      completionCount += 1
      const body = JSON.parse(raw || '{}')
      const isTitle = String(body.messages?.[0]?.content ?? '').includes('标题')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunks = isTitle ? ['Mock 标题'] : ['你好', '，', '世', '界']
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      // 自包含流式循环：不依赖外部定时器/集合，连接中断由 write 抛错自然结束
      ;(async () => {
        for (const c of chunks) {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
          await sleep(60)
        }
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })().catch(() => {})
    })
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => mockServer.listen(PORT, '127.0.0.1', resolve))

/* ---------------- 服务 bundle ---------------- */

writeFileSync(
  join(workDir, 'settings.json'),
  JSON.stringify({
    ai: {
      enabled: true,
      baseUrl: `${BASE}/v1`,
      model: 'mock-model-a',
      temperature: 0.3,
      activeProviderId: 'mock',
      providers: [
        {
          id: 'mock',
          name: 'Mock 供应商',
          enabled: true,
          baseUrl: `${BASE}/v1`,
          apiFormat: 'openai',
          apiKey: 'sk-mock',
          models: [{ id: 'mock-model-a', name: 'mock-model-a', enabled: true }]
        }
      ]
    }
  }),
  'utf-8'
)

const bundle = join(workDir, 'services-bundle.mjs')
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/chat.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle}`
], { stdio: 'inherit' })

const bundle2 = join(workDir, 'gateway-bundle.mjs')
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/gateway/manager.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle2}`
], { stdio: 'inherit' })

const { chatService } = await import(pathToFileURL(bundle).href)
const chatStore = await import(pathToFileURL(join(workDir, 'chat-store-bundle.mjs')).href).catch(() => null)
// chat-store 与 chat 同 bundle（chat 依赖 chat-store），直接再导出的模块不可分离 —— 改为通过第三个 bundle 拿 store 函数
const bundle3 = join(workDir, 'store-bundle.mjs')
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/chat-store.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle3}`
], { stdio: 'inherit' })
const store = await import(pathToFileURL(bundle3).href)

const { GatewayManager } = await import(pathToFileURL(bundle2).href)

const { ipcEvent } = await import(pathToFileURL(join(process.cwd(), 'src/shared/ipc-channels.ts')).href)

chatService.init({ getPath: () => workDir })

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const events = () => globalThis.__TPANEL_EVENTS__
const waitFor = async (pred, timeoutMs = 8000, label = '') => {
  const start = Date.now()
  for (;;) {
    const v = pred()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/* 1. 模型探测（mock /v1/models）+ models.dev 富化（离线回退缓存，不得报错） */
const bundle4 = join(workDir, 'ai-bundle.mjs')
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/services/ai.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle4}`
], { stdio: 'inherit' })
const ai = await import(pathToFileURL(bundle4).href)
const discovery = await ai.fetchModelsFromProvider({ baseUrl: `${BASE}/v1`, apiFormat: 'openai', apiKey: 'sk-mock' })
check('模型探测返回 2 个模型', discovery.ok && discovery.models?.length === 2, JSON.stringify(discovery).slice(0, 120))

// 探针：直接验证 aiChatStream 的 SSE 解析（隔离 chat 服务与广播层）
const probe = await ai.aiChatStream(
  { baseUrl: `${BASE}/v1`, apiFormat: 'openai', model: 'mock-model-a', apiKey: 'sk-mock' },
  [{ role: 'user', content: 'probe' }],
  { onDelta: (d) => console.log('  PROBE DELTA:', d) }
)
check('aiChatStream 探针收齐增量', probe.ok && probe.content === '你好，世界', JSON.stringify(probe))

/* 2. 流式对话：发送 → 依序 delta → done 落库 */
const session = store.createSession({ getPath: () => workDir }, { providerId: 'mock', modelId: 'mock-model-a' })
const send1 = chatService.send({ sessionId: session.id, content: '打个招呼', providerId: 'mock', modelId: 'mock-model-a' })
check('首轮发送直接开跑（非排队）', send1.ok && !send1.queued && !!send1.runId, JSON.stringify(send1))
const deltas = await waitFor(
  () => {
    const arr = events().filter((e) => e.channel === ipcEvent.chatOutput && e.payload.runId === send1.runId)
    return arr.length >= 3 ? arr : null
  },
  8000,
  '流式增量'
)
check('收到流式增量（chat:output）', deltas.length >= 3)

/* 3. 忙碌排队：趁首轮流式中发第二条 → queued → 首轮完成后自动续发 */
const send2 = await chatService.send({ sessionId: session.id, content: '排队消息A', providerId: 'mock', modelId: 'mock-model-a' })
check('忙碌时发送进入队列', send2.ok && send2.queued && send2.queueLen === 1, JSON.stringify(send2))

const done1 = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatDone && e.payload.runId === send1.runId)?.payload,
  8000,
  '首轮完成'
)
check('首轮 done 且 kind=done', done1?.kind === 'done')
const persisted = store.openSession({ getPath: () => workDir }, session.id)
check('首轮落库：user+assistant 两条', persisted?.messages?.length === 2 && persisted.messages[1].content === '你好，世界', JSON.stringify(persisted?.messages))
await waitFor(
  () => {
    const s = store.openSession({ getPath: () => workDir }, session.id)
    return s.messages.length >= 4 && s.messages[3]?.content === '你好，世界'
  },
  10000,
  '队列自动续发'
)
check('队列项在首轮结束后自动发送并落库', true)

/* 4. 中止：发一条，收到首个 delta 后 abort */
const send3 = chatService.send({ sessionId: session.id, content: '会被中止的消息', providerId: 'mock', modelId: 'mock-model-a' })
await waitFor(() => events().some((e) => e.channel === ipcEvent.chatOutput && e.payload.runId === send3.runId), 8000, '中止前增量')
chatService.abort(session.id)
const done3 = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatDone && e.payload.runId === send3.runId)?.payload,
  8000,
  '中止完成'
)
check('中止后 done kind=aborted', done3?.kind === 'aborted', JSON.stringify(done3))

/* 5. 标题总结（首轮 assistant 完成后触发；ai.enabled 且供应商可用 → mock 标题） */
await waitFor(
  () => store.openSession({ getPath: () => workDir }, session.id).title.includes('Mock 标题'),
  10000,
  '标题总结'
).catch(() => {})
const titled = store.openSession({ getPath: () => workDir }, session.id)
check('标题被自动总结更新', titled.title.includes('Mock 标题'), `title=${titled.title}`)

/* 6. 路径围栏：穿越被拒 */
const evil = await GatewayManager.executeTool('trellis_get_spec', { name: '../../../package.json' }, process.cwd())
check('spec 读取拒绝 ../ 穿越', !evil.ok && /越界/.test(evil.error ?? ''), JSON.stringify(evil))
const evilTask = await GatewayManager.executeTool('trellis_get_task', { taskDir: '../../..' }, process.cwd())
check('task 读取拒绝 ../ 穿越', !evilTask.ok && /越界/.test(evilTask.error ?? ''), JSON.stringify(evilTask))

/* 7. 截断契约 */
GatewayManager.updateSecurity({ maxResponseChars: 20 })
const trunc = await GatewayManager.executeTool('db_list_tables', {}, '')
check('截断响应带 truncated/totalChars', trunc.ok && trunc.truncated === true && trunc.totalChars > 20, JSON.stringify(trunc).slice(0, 160))

/* 收尾 */
mockServer.close()
rmSync(workDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`chat smoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('chat smoke: 全部通过')
