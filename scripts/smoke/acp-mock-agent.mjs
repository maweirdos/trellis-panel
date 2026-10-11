/**
 * ACP mock agent 冒烟（10-09-acp-agent-console）。
 *
 * 两种模式：
 *  - `--serve`：作为 NDJSON ACP agent 跑在 stdio 上（可直接配进设置页 agent 注册表，
 *    驱动面板 AcpConsole 端到端走通：对话流 / 工具卡 / 权限卡 / 回合结束）。
 *  - 无参数：自测模式。spawn 自身 --serve 作为 agent，客户端侧断言完整协议序列：
 *    initialize → session/new → prompt（消息分片 + 思考 + 工具调用 + 权限请求）
 *    → 允许路径与拒绝路径 → stopReason。协议栈回归以本脚本为准。
 * 运行：node scripts/smoke/acp-mock-agent.mjs
 */
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const SELF = fileURLToPath(import.meta.url)

/* ---------------- agent 侧（--serve） ---------------- */

function serve() {
  let buf = ''
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const notify = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      handle(msg, { send, notify })
    }
  })
  // 防止 stdout 背压时无声卡死
  process.stdout.on('error', () => {})
}

function handle(msg, { send, notify }) {
  if (msg.id === undefined) return
  const { method, params } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'acp-mock', version: '1.0.0' } } })
    return
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'mock-s1' } })
    return
  }
  if (method === 'session/prompt') {
    const sid = 'mock-s1'
    const text = String(params?.prompt?.[0]?.text ?? '')
    const rejected = /拒绝/.test(text)

    notify(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考：解析请求并规划工具调用…' } })

    if (rejected) {
      // 拒绝路径：请求权限被拒后改道，直接给文字答复
      notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到，' } })
      notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已按拒绝路径改道，未执行写操作。' } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }

    // 允许路径：工具调用 pending → 权限请求 →（客户端放行）→ completed → 最终答复
    notify(sid, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: '写入 prd.md',
      kind: 'edit',
      status: 'pending'
    })
    send({
      jsonrpc: '2.0',
      id: `perm-${Date.now()}`,
      method: 'session/request_permission',
      params: {
        sessionId: sid,
        toolCall: { toolCallId: 'tc-1', title: '写入 prd.md', kind: 'edit' },
        options: [
          { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
          { optionId: 'allow-session', name: '本次会话允许', kind: 'allow_always' },
          { optionId: 'reject', name: '拒绝', kind: 'reject_once' }
        ]
      }
    })
    // 延迟完成工具调用，等权限响应到达（拒绝响应会带 error —— mock 简化：总是走完成分支，由客户端断言响应形状）
    setTimeout(() => {
      notify(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: '写入 prd.md', kind: 'edit', status: 'completed', content: '已写入 3.2KB' })
      notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成：' } })
      notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PRD 已生成（处理请求「${text.slice(0, 24)}」）。` } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }, 120)
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${method}` } })
}

/* ---------------- 客户端侧自测 ---------------- */

async function selfTest() {
  let failures = 0
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
    if (!cond) failures += 1
  }

  const child = spawn(process.execPath, [SELF, '--serve'], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  /** @type {Array<Record<string, unknown>>} */
  const inbox = []
  const waiters = []
  const onMessage = (msg) => {
    const w = waiters.shift()
    if (w) w(msg)
    else inbox.push(msg)
  }
  const next = (pred, label, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待超时：${label}`)), timeoutMs)
      const tryTake = () => {
        const i = inbox.findIndex(pred)
        if (i >= 0) {
          clearTimeout(timer)
          resolve(inbox.splice(i, 1)[0])
          return
        }
        const w = (msg) => {
          if (pred(msg)) {
            clearTimeout(timer)
            resolve(msg)
          } else {
            waiters.push(w)
          }
        }
        waiters.push(w)
      }
      tryTake()
    })
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        // ignore
      }
    }
  })
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)

  try {
    // ① initialize 握手
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'smoke', version: '0' } } })
    const init = await next((m) => m.id === 1, 'initialize 响应')
    check('initialize 返回 agentInfo', init.result?.agentInfo?.name === 'acp-mock')

    // ② 建会话
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } })
    const created = await next((m) => m.id === 2, 'session/new 响应')
    check('session/new 返回 sessionId', typeof created.result?.sessionId === 'string')

    // ③ 允许路径：prompt → thought → tool pending → 权限请求 → 放行 → completed → 消息 → end_turn
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: [{ type: 'text', text: '请生成 PRD' }] } })
    const thought = await next((m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_thought_chunk', '思考分片')
    check('收到思考分片', thought.params.update.content?.text?.includes('思考') === true)
    const toolPending = await next((m) => m.params?.update?.sessionUpdate === 'tool_call' && m.params.update.status === 'pending', '工具 pending')
    check('工具调用 pending 到达', toolPending.params.update.toolCallId === 'tc-1')
    const permReq = await next((m) => m.method === 'session/request_permission', '权限请求')
    check(
      '权限选项三态齐备',
      ['allow_once', 'allow_always', 'reject_once'].every((k) => permReq.params?.options?.some?.((o) => o.kind === k))
    )
    send({ jsonrpc: '2.0', id: permReq.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    const toolDone = await next((m) => m.params?.update?.sessionUpdate === 'tool_call' && m.params.update.status === 'completed', '工具 completed')
    check('权限放行后工具 completed', toolDone.params.update.content === '已写入 3.2KB')
    const promptDone = await next((m) => m.id === 3, 'prompt 响应')
    check('stopReason=end_turn', promptDone.result?.stopReason === 'end_turn')

    // ④ 拒绝路径：含「拒绝」的 prompt 直接改道
    send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { prompt: [{ type: 'text', text: '模拟权限拒绝场景' }] } })
    const rejectDone = await next((m) => m.id === 4, '拒绝路径 prompt 响应')
    check('拒绝路径仍正常结束', rejectDone.result?.stopReason === 'end_turn')

    // ⑤ 未知方法错误响应
    send({ jsonrpc: '2.0', id: 5, method: 'session/set_mode', params: {} })
    const err = await next((m) => m.id === 5, '未知方法错误')
    check('未知方法返回 -32601', err.error?.code === -32601)

    console.log(failures === 0 ? '\nACP mock agent 冒烟：全部通过 ✓' : `\nACP mock agent 冒烟：${failures} 项失败 ✗`)
    child.kill()
    process.exit(failures === 0 ? 0 : 1)
  } catch (e) {
    console.error(`\nACP mock agent 冒烟失败：${e.message}`)
    child.kill()
    process.exit(1)
  }
}

if (process.argv.includes('--serve')) serve()
else selfTest()
