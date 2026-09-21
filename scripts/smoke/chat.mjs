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
const chatBodies = []
const activeStreams = new Set()
const mockServer = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (process.env.CHAT_SMOKE_DEBUG) console.log('MOCK REQ:', req.method, url)
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }))
    return
  }
  if (req.method === 'POST' && url.endsWith('/messages')) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      chatBodies.push(JSON.parse(raw || '{}'))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events = [
        { delta: { type: 'thinking_delta', thinking: '思考A' } },
        { delta: { type: 'thinking_delta', thinking: '思考B' } },
        { delta: { type: 'text_delta', text: '回答文本' } }
      ]
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      ;(async () => {
        for (const ev of events) {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', ...ev })}

`)
          await sleep(40)
        }
        if (!res.writableEnded) res.end()
      })().catch(() => {})
    })
    return
  }
  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      completionCount += 1
      const body = JSON.parse(raw || '{}')
      chatBodies.push(body)
      const isTitle = String(body.messages?.[0]?.content ?? '').includes('标题')
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // 工具轮：携带 tools 的请求返回 tool_calls；结果回灌后返回最终文本
      if (body.tools?.length) {
        const chunks2 = hasToolResult
          ? [{ delta: { content: '工具答案' } }]
          : [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: `call-${completionCount}`, type: 'function', function: { name: 'db_list_tables', arguments: '{}' } }
                  ]
                }
              }
            ]
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms))
        ;(async () => {
          for (const c of chunks2) {
            if (res.writableEnded || res.destroyed) return
            res.write(`data: ${JSON.stringify({ choices: [c] })}\n\n`)
            await sleep2(40)
          }
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n')
            res.end()
          }
        })().catch(() => {})
      }
      if (body.tools?.length) return
      // 先思考流（reasoning_content）后正文（content）
      const chunks = isTitle
        ? [['reasoning_content', 'Mock 标题'], ['content', 'Mock 标题']]
        : [
            ['reasoning_content', '用户想打招呼，'],
            ['reasoning_content', '礼貌回应即可。'],
            ['content', '你好'],
            ['content', '，'],
            ['content', '世'],
            ['content', '界']
          ]
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      // 自包含流式循环：不依赖外部定时器/集合，连接中断由 write 抛错自然结束
      ;(async () => {
        for (const [field, text] of chunks) {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { [field]: text } }] })}\n\n`)
          await sleep(50)
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
const { activePath } = store
const msgsOf = (id) => activePath(store.openSession({ getPath: () => workDir }, id))

const { GatewayManager } = await import(pathToFileURL(bundle2).href)

const { ipcEvent } = await import(pathToFileURL(join(process.cwd(), 'src/shared/ipc-channels.ts')).href)

chatService.init({ getPath: () => workDir })

let failures = 0
const deltasA = []
const thinkingA = []
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
const persisted = { messages: msgsOf(session.id) }
check('首轮落库：user+assistant 两条', persisted?.messages?.length === 2 && persisted.messages[1].content === '你好，世界', JSON.stringify(persisted?.messages))
check(
  'assistant 落库携带思考流 reasoning',
  persisted?.messages?.[1]?.reasoning === '用户想打招呼，礼貌回应即可。',
  JSON.stringify(persisted?.messages?.[1]?.reasoning)
)
await waitFor(
  () => {
    const path = msgsOf(session.id)
    return path.length >= 4 && path[3]?.content === '你好，世界'
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

/* 8. thinking 档位：openai 形态 reasoning_effort 随请求体下发 */
const session2 = store.createSession({ getPath: () => workDir }, { providerId: 'mock', modelId: 'mock-model-a', thinkingLevel: 'high' })
chatService.send({ sessionId: session2.id, content: '档位检查', providerId: 'mock', modelId: 'mock-model-a' })
await waitFor(
  () => {
    return msgsOf(session2.id).length >= 2
  },
  10000,
  '档位轮完成'
)
const levelBodies = chatBodies.filter(
  (b) => (b.messages ?? []).some((m) => m.content === '档位检查') && !String(b.messages?.[0]?.content ?? '').includes('标题')
)
const levelBody = levelBodies[levelBodies.length - 1]
check('openai 形态 reasoning_effort=high 随请求体下发', levelBody?.reasoning_effort === 'high', JSON.stringify(levelBody).slice(0, 160))

/* 9. anthropic thinking_delta 解析 + off 不携带 thinking 字段 */
const anthropicOff = await ai.aiChatStream(
  { baseUrl: `${BASE}/v1`, apiFormat: 'anthropic', model: 'claude-x' },
  [{ role: 'user', content: 'hi' }],
  { onDelta: () => {}, onReasoning: () => {} }
)
const anthropicOffBody = chatBodies[chatBodies.length - 1]
check('anthropic off：请求体不含 thinking 字段', anthropicOffBody?.thinking === undefined, JSON.stringify(anthropicOffBody))
const anthropicLow = await ai.aiChatStream(
  { baseUrl: `${BASE}/v1`, apiFormat: 'anthropic', model: 'claude-x', thinkingLevel: 'low' },
  [{ role: 'user', content: 'hi' }],
  { onDelta: (d) => deltasA.push(d), onReasoning: (r) => thinkingA.push(r) }
)
check('anthropic thinking_delta 解析为 reasoning', anthropicLow.ok && thinkingA.join('') === '思考A思考B' && deltasA.join('') === '回答文本', JSON.stringify(anthropicLow))
const anthropicLowBody = chatBodies[chatBodies.length - 1]
check('anthropic low：thinking.budget_tokens=4096', anthropicLowBody?.thinking?.budget_tokens === 4096, JSON.stringify(anthropicLowBody).slice(0, 200))

/* 10. 重新生成 */
const session3 = store.createSession({ getPath: () => workDir }, { providerId: 'mock', modelId: 'mock-model-a' })
chatService.send({ sessionId: session3.id, content: '原始提问', providerId: 'mock', modelId: 'mock-model-a' })
await waitFor(
  () => msgsOf(session3.id).length >= 2,
  10000,
  'regenerate 前置轮'
)
const regen = chatService.regenerate(session3.id)
check('regenerate 接受并开跑', regen.ok && !!regen.runId, JSON.stringify(regen))
await waitFor(
  () => events().some((e) => e.channel === ipcEvent.chatDone && e.payload.runId === regen.runId && e.payload.kind === 'done'),
  10000,
  'regenerate 完成'
)
const regenSession = { messages: msgsOf(session3.id) }
check('regenerate 后仍为 user+assistant 且不叠加', regenSession.messages.length === 2 && regenSession.messages[1].role === 'assistant', JSON.stringify(regenSession.messages.map((m) => m.role)))
const session4 = store.createSession({ getPath: () => workDir }, { providerId: 'mock', modelId: 'mock-model-a' })
const regenBad = chatService.regenerate(session4.id)
check('空会话 regenerate 拒绝', !regenBad.ok, JSON.stringify(regenBad))

/* 10.5 v1 → v2 迁移：旧线性会话打开自动迁移为链 */
const v1Id = 'legacy-v1-session'
const v1File = join(workDir, 'chat-sessions', `${v1Id}.json`)
writeFileSync(
  v1File,
  JSON.stringify({
    id: v1Id,
    title: '旧格式会话',
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    messageCount: 2,
    providerId: 'mock',
    modelId: 'mock-model-a',
    messages: [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' }
    ]
  }),
  'utf-8'
)
const migrated = store.openSession({ getPath: () => workDir }, v1Id)
const migratedPath = activePath(migrated)
check('v1 会话自动迁移为 v2 树', migrated.version === 2 && Object.keys(migrated.nodes).length === 2)
check('迁移后活跃路径内容等价', migratedPath.length === 2 && migratedPath[0].content === '旧问题' && migratedPath[1].content === '旧回答')

/* 10.7 多模态：图片附件经 openai 图像内容分片（TPD-019） */
const smallPng = 'data:image/png;base64,' + Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
).toString('base64')
const mmSession = store.createSession({ getPath: () => workDir }, { providerId: 'mock', modelId: 'mock-model-a' })
const mmSend = chatService.send({
  sessionId: mmSession.id,
  content: '这张图里是什么？',
  providerId: 'mock',
  modelId: 'mock-model-a',
  images: [smallPng]
})
check('带图发送接受', mmSend.ok && !!mmSend.runId, JSON.stringify(mmSend))
await waitFor(
  () => events().some((e) => e.channel === ipcEvent.chatDone && e.payload.runId === mmSend.runId && e.payload.kind === 'done'),
  10000,
  '带图轮完成'
)
const mmBody = chatBodies.filter((b) => (b.messages ?? []).some((m) => Array.isArray(m.content))).pop()
const mmUserMsg = mmBody?.messages?.find((m) => Array.isArray(m.content))
check(
  'openai 请求体 user 消息升维为图像分片数组',
  Array.isArray(mmUserMsg?.content) && mmUserMsg.content.some((c) => c.type === 'image_url' && String(c.image_url?.url ?? '').startsWith('data:image/png;base64,')),
  JSON.stringify(mmUserMsg).slice(0, 200)
)
check('图像分片同时包含文本分片', Array.isArray(mmUserMsg?.content) && mmUserMsg.content.some((c) => c.type === 'text'))
const mmPersisted = activePath(store.openSession({ getPath: () => workDir }, mmSession.id))
check('落库消息携带 images 元数据', mmPersisted[0]?.images?.[0]?.mediaType === 'image/png' && (mmPersisted[0]?.images?.[0]?.dataBase64 ?? '').length > 0)
const oversize = chatService.send({
  sessionId: mmSession.id,
  content: '超图',
  providerId: 'mock',
  modelId: 'mock-model-a',
  images: ['data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024)]
})
check('超限图片被拒（4MB 门槛）', !oversize.ok && /4MB/.test(oversize.error ?? ''), JSON.stringify(oversize))

/* 11. 树结构：编辑重发兄弟分支 + 分支切换 + regenerate 保留旧回答 */
const pathBefore = msgsOf(session.id)
const user0Id = pathBefore[0].id
const beforeNodes = Object.keys(store.openSession({ getPath: () => workDir }, session.id).nodes).length

// 编辑首条用户消息 → 兄弟分支重跑
const editRes = chatService.editAndResend(session.id, user0Id, '编辑后的问候')
check('编辑重发接受并开跑', editRes.ok && !!editRes.runId, JSON.stringify(editRes))
await waitFor(
  () => events().some((e) => e.channel === ipcEvent.chatDone && e.payload.runId === editRes.runId && e.payload.kind === 'done'),
  10000,
  '编辑轮完成'
)
const afterEdit = store.openSession({ getPath: () => workDir }, session.id)
const afterEditPath = activePath(afterEdit)
check('编辑后活跃路径为新内容', afterEditPath[0]?.content === '编辑后的问候', JSON.stringify(afterEditPath.map((m) => m.content)))
check('编辑生成兄弟分支（节点数增加且旧分支保留）', Object.keys(afterEdit.nodes).length === beforeNodes + 2, `nodes=${Object.keys(afterEdit.nodes).length}`)

// 分支切换：切回旧用户节点（视图截至提问处），再切回旧回答
const oldAssistantId = pathBefore[1].id
const branchToUser = chatService.branch(session.id, user0Id)
check('分支切换到旧用户节点', branchToUser.ok, JSON.stringify(branchToUser))
const userLeafPath = msgsOf(session.id)
check('切到 user 叶后视图截至提问处', userLeafPath.length === 1 && userLeafPath[0]?.content === '打个招呼', JSON.stringify(userLeafPath.map((m) => m.content)))
const branchBack = chatService.branch(session.id, oldAssistantId)
check('分支切换回旧回答节点', branchBack.ok, JSON.stringify(branchBack))
const oldPath = msgsOf(session.id)
check('切回旧分支后路径恢复旧内容', oldPath.length === 2 && oldPath[0]?.content === '打个招呼' && oldPath[1]?.content === '你好，世界', JSON.stringify(oldPath.map((m) => m.content)))

// regenerate 分支保留：在当前叶（assistant）同父生成新兄弟，旧回答不丢弃
const beforeRegenNodes = Object.keys(store.openSession({ getPath: () => workDir }, session.id).nodes).length
const regen2 = chatService.regenerate(session.id)
check('regenerate 接受（分支保留语义）', regen2.ok && !!regen2.runId, JSON.stringify(regen2))
await waitFor(
  () => events().some((e) => e.channel === ipcEvent.chatDone && e.payload.runId === regen2.runId && e.payload.kind === 'done'),
  10000,
  'regenerate 分支完成'
)
const afterRegen = store.openSession({ getPath: () => workDir }, session.id)
check('regenerate 新增兄弟 assistant（+1 节点）且路径不变长', Object.keys(afterRegen.nodes).length === beforeRegenNodes + 1 && msgsOf(session.id).length === 2, `nodes=${Object.keys(afterRegen.nodes).length}`)

/* 13. Agent 工具循环：权限四路径 + steer 注入 */
chatService.configure({ permissionTimeoutMs: 20000 })
const permEventsOf = (runId) => events().filter((e) => e.channel === ipcEvent.chatPermission && e.payload.runId === runId)
const mkAgent = () => {
  const sess = store.createSession({ getPath: () => workDir }, { providerId: 'mock', modelId: 'mock-model-a' })
  chatService.send({ sessionId: sess.id, content: '查一下表', providerId: 'mock', modelId: 'mock-model-a', agent: true })
  return sess.id
}

// A. allow-session：发卡→allow-session→工具执行→回答；白名单持久化
const agentA = mkAgent()
const doneA = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatDone && e.payload.runId === /^$/.test('') ? null : e.payload.runId) ?? null,
  1,
  'noop'
).catch(() => null)
// 上面 noop 忽略；等待权限卡
const permA = await waitFor(() => permEventsOf('__none__').length ? null : true, 1, 'noop').catch(() => null)
let permAEvent = null
try {
  permAEvent = await waitFor(
    () => {
      const pendingRun = events().find((e) => e.channel === ipcEvent.chatPermission && e.payload.sessionId === agentA)
      return pendingRun ? pendingRun.payload : null
    },
    10000,
    '权限卡'
  )
} catch (e) {
  console.error('DEBUG channels:', JSON.stringify(events().slice(0, 10).map((x) => x.channel)))
  console.error('DEBUG all events:', JSON.stringify(events().map((x) => x.channel + ':' + (x.payload?.toolName ?? x.payload?.kind ?? ''))))
  throw e
}
check('工具调用触发权限卡', permAEvent?.toolName === 'db_list_tables', JSON.stringify(permAEvent))
chatService.resolvePermission(permAEvent.permId, 'allow-session')
const doneA2 = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatDone && e.payload.runId === permAEvent.runId && e.payload.kind === 'done')?.payload,
  10000,
  'agent 回答完成'
)
const agentAPath = msgsOf(agentA)
check('assistant 节点携带 toolOps（success）', agentAPath.some((m) => m.toolOps?.[0]?.status === 'success' && m.toolOps[0].toolName === 'db_list_tables'), JSON.stringify(agentAPath))
check('allow-session 白名单已持久化', store.openSession({ getPath: () => workDir }, agentA).allowedTools?.includes('db_list_tables') === true)
const secondRoundBody = chatBodies.find((b) => (b.messages ?? []).some((m) => m.role === 'tool'))
check('工具结果已回灌模型（role:tool）', !!secondRoundBody)

// B. allow-session 复用：同名工具不再发卡
let permEventsBefore = events().filter((e) => e.channel === ipcEvent.chatPermission && e.payload.sessionId === agentA).length
chatService.send({ sessionId: agentA, content: '再查一次', providerId: 'mock', modelId: 'mock-model-a', agent: true })
await waitFor(
  () => {
    const p = activePath(store.openSession({ getPath: () => workDir }, agentA))
    return p.length >= 4
  },
  10000,
  'B 轮完成'
)
const permEventsAfter = events().filter((e) => e.channel === ipcEvent.chatPermission && e.payload.sessionId === agentA).length
check('白名单工具不再发权限卡', permEventsAfter === permEventsBefore)

// C. deny 回灌 + steer 注入
const agentC = mkAgent()
const permC = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatPermission && e.payload.sessionId === agentC)?.payload,
  10000,
  'C 权限卡'
)
chatService.steer(agentC, '补充内容')
const steerEvent = await waitFor(() => events().some((e) => e.channel === ipcEvent.chatSteer && e.payload.sessionId === agentC), 5000, 'steer 事件')
check('steer 事件已广播', steerEvent)
chatService.resolvePermission(permC.permId, 'deny')
const doneC = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatDone && e.payload.runId === permC.runId && e.payload.kind === 'done')?.payload,
  10000,
  'C 完成'
)
check('deny 后回答仍完成', doneC?.kind === 'done')
const denyBody = chatBodies.find((b) => (b.messages ?? []).some((m) => m.role === 'tool' && String(m.content).includes('拒绝')))
check('拒绝文案作为工具结果回灌', !!denyBody)
const steerInCtx = chatBodies.some((b) => (b.messages ?? []).some((m) => String(m.content).includes('[用户补充] 补充内容')))
check('steer 文本注入后续请求上下文', steerInCtx)

// D. 超时默认拒绝
chatService.configure({ permissionTimeoutMs: 800 })
const agentD = mkAgent()
const permD = await waitFor(
  () => events().find((e) => e.channel === ipcEvent.chatPermission && e.payload.sessionId === agentD)?.payload,
  10000,
  'D 权限卡'
)
const doneD = await waitFor(
  () => {
    const ev = events().find((e) => e.channel === ipcEvent.chatDone && e.payload.runId === permD.runId && e.payload.kind === 'done')
    return ev?.payload ?? null
  },
  15000,
  'D 超时完成'
)
const agentDPath = msgsOf(agentD)
check('超时未决策默认拒绝（toolOps denied）', agentDPath.some((m) => m.toolOps?.[0]?.status === 'denied'), JSON.stringify(agentDPath.map((m) => m.toolOps)))
void doneD

/* 收尾 */
mockServer.close()
rmSync(workDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`chat smoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('chat smoke: 全部通过')
