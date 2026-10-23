/**
 * ZCode ACP 适配器端到端冒烟（仿 acp-mock-agent 独立脚本模式，不依赖 Electron）。
 *
 * 流程：起适配器（node 直跑，真实用户态——不传 --isolated，模型/登录复用本机 ~/.zcode）
 * → ACP initialize → session/new（临时目录 workspace）→ 断言快照 settings.model.available
 * 模型数 > 0（真实登录态应有 codingplan 等模型；为 0 则如实失败，不伪造）→ set_mode / set_model
 * → session/prompt 短文本 → 收流式事件直到 turn 结束（真实模型成功断言 message chunk；
 * 认证失败等场景断言 error/turn.failed 且适配器不崩）→ session/cancel → session/load 恢复
 * → 关闭后无进程残留。
 * 隔离验证（仅 --isolated 显式模式）：第二次起适配器带 --isolated <临时目录>，断言数据落
 * 隔离目录（<dir>/.zcode）且不写用户 ~/.zcode。
 * 取证硬化断言：伪装 app-server（应答 create 后自杀）→ 断言 <隔离目录>/zcode-adapter-last-error.log
 * 生成且含 stderr/收发帧/退出码；再用真实 CLI 成功启动 → 断言尸检日志被清除。
 *
 * zcode CLI 发现顺序：TRELLIS_ZCODE_BIN / ZCODE_BIN → PATH → 标准安装位置表。
 * 前置小节：用 esbuild+mock 打包真实 setup.ts，断言 nativePaths.zcode / env ZCODE_BIN 检测链与 probe 诊断。
 * 运行：node scripts/smoke/acp-zcode-adapter.mjs（隔离协议夹具）；--live 才调用真实 provider
 */
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')
const ADAPTER_ENTRY = join(ROOT, 'adapters', 'zcode-acp', 'src', 'index.mjs')
const PROMPT_FIRST_WAIT_MS = 75_000
const PROMPT_CANCEL_WAIT_MS = 30_000
const RPC_TIMEOUT_MS = 90_000

function regularFile(path) {
  try { return typeof path === 'string' && statSync(path).isFile() } catch { return false }
}

/** 与适配器一致的三级发现顺序；本机自定义安装可用 TRELLIS_ZCODE_BIN 指定。 */
function resolveZcodeBin() {
  const explicit = process.env.TRELLIS_ZCODE_BIN ?? process.env.ZCODE_BIN
  if (regularFile(explicit)) return explicit
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory.replace(/^"|"$/g, ''), `zcode${suffix}`)
      if (regularFile(candidate)) return candidate
    }
  }
  const standard = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
    : process.platform === 'darwin' ? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs' : undefined
  return regularFile(standard) ? standard : undefined
}

/** ~/.zcode 快照（存在性 + 有界文件清单），用于隔离断言。 */
function homeZcodeSnapshot() {
  const root = join(homedir(), '.zcode')
  if (!existsSync(root)) return { existed: false, files: [] }
  const files = []
  const walk = (directory) => {
    if (files.length > 20000) return
    let entries = []
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(root)
  return { existed: true, files }
}

const inbox = []
let child
let buffer = ''
let stderrTail = ''
let exited
let lastModelSummary = '（尚未探测）'

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

async function next(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = inbox.findIndex(predicate)
    if (index >= 0) return inbox.splice(index, 1)[0]
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时（${timeoutMs / 1000}s）。stderr：${stderrTail.slice(-400)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

let rpcId = 0
async function call(method, params, timeoutMs = RPC_TIMEOUT_MS) {
  rpcId += 1
  const id = rpcId
  send({ jsonrpc: '2.0', id, method, params })
  return next((message) => message.id === id && (message.result !== undefined || message.error !== undefined), timeoutMs, method)
}

/** 进程残留扫描：命令行含本冒烟临时目录标记的 node 进程必须为空。 */
function assertNoLeftoverProcesses(marker) {
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`
  let output = ''
  try { output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true }) } catch (error) {
    console.log(`  SKIP 进程残留扫描不可用：${error.message.split('\n')[0]}`)
    return
  }
  const pids = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line))
  assert.deepEqual(pids, [], `发现残留进程：${pids.join(', ')}`)
}

/**
 * 主进程 setup.ts 检测链路断言：esbuild 打包真实 src/main/services/acp/setup.ts（electron 用 mock 桩，
 * 与 acp-foundation.mjs 同款），用临时 stub 文件断言三级检测语义——
 * nativePaths.zcode 手动指定（available=true 且诊断含「手动指定」）> env ZCODE_BIN > 无效手动路径回退。
 * 不依赖真实 zcode CLI；stub 仅为 regularFile 校验目标，不会被当作 CLI 执行出有意义结果。
 */
async function assertSetupProbeDetection() {
  const tempDir = mkdtempSync(join(tmpdir(), 'zcode-acp-probe-'))
  const stubNative = join(tempDir, 'stub-zcode-nativepaths.cjs')
  const stubEnv = join(tempDir, 'stub-zcode-env.cjs')
  for (const stub of [stubNative, stubEnv]) writeFileSync(stub, '// smoke stub：仅用于存在性校验，不产生真实 CLI 行为\n')
  const previousEnv = process.env.ZCODE_BIN
  try {
    const outfile = join(tempDir, 'setup-probe.mjs')
    await build({
      stdin: { contents: `export { listAcpAgents } from './src/main/services/acp/setup'; export { setSettings } from './src/main/services/store';`, resolveDir: ROOT, loader: 'ts' },
      bundle: true, format: 'esm', platform: 'node',
      alias: { electron: join(ROOT, 'scripts', 'smoke', 'mock-electron.mjs') },
      outfile
    })
    process.chdir(ROOT) // resolveAdapterEntry 依赖 app.getAppPath()=cwd；mock 桩返回 process.cwd()
    process.env.TPAP_SMOKE_DIR = tempDir // mock app.getPath('userData')，隔离 settings 落盘
    const setup = await import(pathToFileURL(outfile).href)
    const bundledRow = async () => (await setup.listAcpAgents(true)).agents.find((agent) => agent.launchKind === 'bundled')
    const diagnostics = (row) => JSON.stringify(row.diagnostics)

    // 1. nativePaths.zcode 手动指定 → available=true，诊断标注「手动指定」且含指定路径
    setup.setSettings({ acp: { nodePath: process.execPath, nativePaths: { zcode: stubNative } } })
    let row = await bundledRow()
    assert.equal(row.available, true, `设置 nativePaths.zcode 后应 available=true：${diagnostics(row)}`)
    assert.ok(row.diagnostics.some((line) => line.includes('手动指定') && line.includes(stubNative)), `诊断应标注手动指定并含路径：${diagnostics(row)}`)
    console.log('  ok  probe：nativePaths.zcode 手动指定 → available=true 且诊断含「手动指定」')

    // 2. env ZCODE_BIN 前插（优先于 PATH）：无手动指定时应命中 env 值
    setup.setSettings({ acp: { nodePath: process.execPath, nativePaths: {} } })
    process.env.ZCODE_BIN = stubEnv
    row = await bundledRow()
    assert.equal(row.available, true, `设置 env ZCODE_BIN 后应 available=true：${diagnostics(row)}`)
    assert.ok(row.diagnostics.some((line) => line.includes(stubEnv)), `诊断应含 env ZCODE_BIN 命中路径：${diagnostics(row)}`)
    console.log('  ok  probe：env ZCODE_BIN → available=true 且诊断含指定路径')

    // 3. 手动路径无效 → 回退 env ZCODE_BIN（而非标 unavailable）
    setup.setSettings({ acp: { nodePath: process.execPath, nativePaths: { zcode: join(tempDir, 'missing.cjs') } } })
    row = await bundledRow()
    assert.equal(row.available, true, `无效手动路径应回退 env 检测：${diagnostics(row)}`)
    assert.ok(row.diagnostics.some((line) => line.includes(stubEnv)), `回退后诊断应含 env 命中路径：${diagnostics(row)}`)
    console.log('  ok  probe：无效手动路径回退 env ZCODE_BIN')
  } finally {
    if (previousEnv === undefined) delete process.env.ZCODE_BIN
    else process.env.ZCODE_BIN = previousEnv
    try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (error) {
      console.log(`  ~   probe 临时目录清理失败（留待系统清理）：${tempDir}：${error.message.split('\n')[0]}`)
    }
  }
}

async function main() {
  await assertSetupProbeDetection()
  const zcodeBin = resolveZcodeBin()
  if (!zcodeBin) {
    console.log('SKIP 未检测到 ZCode CLI（设 TRELLIS_ZCODE_BIN 可指定路径）；适配器与翻译层单测另行覆盖')
    return
  }
  console.log(`ZCode CLI：${zcodeBin}`)
  const workspace = mkdtempSync(join(tmpdir(), 'zcode-acp-ws-'))
  const nonce = randomUUID()
  writeFileSync(join(workspace, 'nonce.txt'), nonce)
  let assistantText = ''
  let sawNonceTool = false
  const adapterEnv = { ...process.env }
  delete adapterEnv.ZCODE_BASE_URL // 适配器应自行剔除；宿主侧先剔除用于验证剔除语义
  adapterEnv.TRELLIS_ZCODE_ACP_DEBUG = '1'

let sawMessageChunk = false
let sawThoughtChunk = false
/** 最近一次 session/new 探测到的模型目录摘要（如实报告用；失败时随 FAIL 输出，不伪造）。 */
/** 启动一个适配器实例并接管其 stdout/stderr（重置 inbox/buffer/exited 供 send/call/next 使用）。
 *  isolatedDir 给定则走显式隔离模式（--isolated），缺省真实用户态。 */
const wireAdapter = (bin, isolatedDir) => {
  inbox.length = 0
  buffer = ''
  stderrTail = ''
  exited = undefined
  child = spawn(process.execPath, [ADAPTER_ENTRY, '--zcode-bin', bin, ...(isolatedDir ? ['--isolated', isolatedDir] : [])], {
    cwd: workspace,
    env: adapterEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
    child.once('exit', (code, signal) => { exited = { code, signal } })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        try { inbox.push(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-4000) })
  }

  try {
    wireAdapter(zcodeBin) // 真实用户态：默认无 --isolated

    // 1. ACP initialize：image 如实声明 false
    const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(init.error, undefined, `initialize 失败：${JSON.stringify(init.error)}`)
    assert.equal(init.result.protocolVersion, 1)
    assert.equal(init.result.agentCapabilities.promptCapabilities.image, false)
    assert.equal(init.result.agentCapabilities.loadSession, true)
    assert.equal(init.result.agentInfo.name, 'zcode-acp')
    console.log('  ok  initialize（protocolVersion 1，image=false，loadSession=true）')

    // 2. session/new：临时目录 workspace，真实用户态——快照 settings.model.available 必须有可用模型
    const created = await call('session/new', { cwd: workspace, mcpServers: [] })
    assert.equal(created.error, undefined, `session/new 失败：${JSON.stringify(created.error)}`)
    const sessionId = created.result.sessionId
    assert.match(sessionId, /^sess_/)
    assert.ok(created.result.modes?.availableModes?.length > 0, '应声明 modes')
    const modelOption = (created.result.configOptions ?? []).find((option) => option.category === 'model')
    assert.ok(modelOption, '应声明 category=model 的 config option（模型目录来自快照 settings.model.available）')
    assert.ok(modelOption.options.length > 0,
      `真实用户态模型数应为 > 0（实际 ${modelOption.options.length}）：session/create 快照 settings.model.available 不可见，登录态/模型目录未复用本机 ~/.zcode`)
    lastModelSummary = modelOption.options.map((option) => `${option.value}（${option.name}）`).join('；')
    console.log(`  ok  session/new ${sessionId}（mode=${created.result.modes.currentModeId}，模型 ${modelOption.options.length} 个）：${lastModelSummary}`)

    // 3. set_mode（默认 build → edit：实测同值 setMode 不发事件，必须选一个真实变化）
    const targetMode = created.result.modes.currentModeId === 'edit' ? 'build' : 'edit'
    const setMode = await call('session/set_mode', { sessionId, modeId: targetMode })
    assert.equal(setMode.error, undefined, `set_mode 失败：${JSON.stringify(setMode.error)}`)
    const modeUpdate = await next((message) => message.method === 'session/update' && message.params?.update?.sessionUpdate === 'current_mode_update', 20_000, 'current_mode_update')
    assert.equal(modeUpdate.params.update.currentModeId, targetMode, `模式回推 ${modeUpdate.params.update.currentModeId} ≠ 请求 ${targetMode}`)
    console.log(`  ok  set_mode ${targetMode} → current_mode_update`)

    // 4. set_model（经 config option 通道 → session/setModel providerId/modelId 解码）
    const targetModel = process.env.TRELLIS_ZCODE_SMOKE_MODEL ?? modelOption.currentValue
    assert.ok(modelOption.options.some(option => option.value === targetModel), 'Choose an advertised TRELLIS_ZCODE_SMOKE_MODEL explicitly when current model is unknown')
    const setModel = await call('session/set_config_option', { sessionId, configId: modelOption.id, value: targetModel })
    assert.equal(setModel.error, undefined, `set_model 失败：${JSON.stringify(setModel.error)}`)
    console.log(`  ok  set_model ${targetModel}`)
    inbox.length = 0

    // 5. prompt 短文本：收流式事件直到 turn 结束；无凭据环境下 provider 会长时间重试，
    //    此时以 ACP cancel（→ session/stop）真实终止 turn，断言 stopReason=cancelled 收尾。
    send({ jsonrpc: '2.0', id: ++rpcId, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Use the Read tool to read nonce.txt in this workspace, then reply with its exact content. Do not guess.' }] } })
    const promptId = rpcId
    const findPromptReply = () => {
      const index = inbox.findIndex((message) => message.id === promptId && (message.result !== undefined || message.error !== undefined))
      return index >= 0 ? inbox.splice(index, 1)[0] : undefined
    }
    const drainChunks = () => {
      for (const message of inbox.splice(0, inbox.length)) {
        const update = message.params?.update
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) { sawMessageChunk = true; assistantText += update.content.text }
        if (update?.status === 'completed' && JSON.stringify(update.rawOutput ?? update.content).includes(nonce)) sawNonceTool = true
        if (message.method === 'session/request_permission') {
          const deny = message.params?.options?.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')
          send({ jsonrpc: '2.0', id: message.id, result: { outcome: deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } } })
        }
        if (update?.sessionUpdate === 'agent_thought_chunk') sawThoughtChunk = true
      }
    }
    const waitPromptReply = async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const reply = findPromptReply()
        if (reply) return reply
        drainChunks()
        if (Date.now() > deadline) return undefined
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    let promptReply = await waitPromptReply(75_000)
    let cancelledFallback = false
    if (!promptReply) {
      // turn 未在时限内结束（本机无模型凭据时 provider 重试属预期）：cancel 真实终止 turn。
      console.log('  ~   turn 未在 75s 内结束（provider 重试中，多为无凭据环境）→ 发送 session/cancel')
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
      promptReply = await waitPromptReply(30_000)
      cancelledFallback = true
    }
    assert.ok(promptReply, 'cancel 后仍收到 prompt 应答')
    if (promptReply.error !== undefined && promptReply.error !== null) {
      // turn.failed 翻译路径：收到 error 且适配器不崩
      throw new Error(`Live provider inference failed: ${promptReply.error.message}`)
    } else if (promptReply.result.stopReason === 'cancelled') {
      assert.ok(cancelledFallback, '未发送 cancel 却收到 cancelled 应答')
      throw new Error('Live inference timed out and was cancelled; cancellation is not successful inference')
    } else {
      assert.ok(['end_turn'].includes(promptReply.result.stopReason), `stopReason=${promptReply.result.stopReason}`)
      drainChunks()
      assert.ok(sawMessageChunk && assistantText.includes(nonce), 'Live inference needs assistant text containing the exact file nonce')
      assert.ok(sawNonceTool, 'Live inference needs a completed real tool reading the nonce')
      console.log(`  ok  prompt stopReason=${promptReply.result.stopReason}（messageChunk=${sawMessageChunk}，thoughtChunk=${sawThoughtChunk}）— 真实模型调用成功`)
    }
    assert.equal(exited, undefined, 'prompt 期间适配器不应退出')

    // 6. cancel 幂等性（turn 已结束后再发一次，连接保持不崩）
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(exited, undefined, 'cancel 后适配器不应退出')
    console.log('  ok  session/cancel 幂等（连接保持）')

    // 7. load 恢复（协议层 session/resume）
    const loaded = await call('session/load', { sessionId, cwd: workspace, mcpServers: [] })
    assert.equal(loaded.error, undefined, `session/load 失败：${JSON.stringify(loaded.error)}`)
    assert.ok(loaded.result.modes?.currentModeId, 'resume 后应返回 modes')
    console.log('  ok  session/load（resume）')

    // 8. 关闭后无进程残留（真实用户态主流程：app-server 命令行以 workspace 临时目录为标记）
    child.stdin.end()
    const exitDeadline = Date.now() + 20_000
    while (exited === undefined && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(exited !== undefined, '适配器未在 20s 内退出')
    assert.equal(exited.code, 0, `适配器退出码 ${exited.code}（期望 0）`)
    await assertNoLeftoverProcesses('zcode-acp-ws-')
    console.log('  ok  适配器退出 code=0，无 app-server 进程残留（真实用户态主流程）')

    // 8b. 隔离验证（仅显式 --isolated 模式）：数据落隔离目录、不写用户 ~/.zcode。
    //     默认真实用户态按设计复用 ~/.zcode，隔离红线只对 --isolated 生效。
    const isolatedDir = mkdtempSync(join(tmpdir(), 'zcode-acp-iso-'))
    try {
      const isoHomeBefore = homeZcodeSnapshot()
      wireAdapter(zcodeBin, isolatedDir)
      const isoInit = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
      assert.equal(isoInit.error, undefined, `隔离模式 initialize 失败：${JSON.stringify(isoInit.error)}`)
      const isoCreated = await call('session/new', { cwd: workspace, mcpServers: [] }, 60_000)
      assert.equal(isoCreated.error, undefined, `隔离模式 session/new 失败：${JSON.stringify(isoCreated.error)}`)
      assert.ok(existsSync(join(isolatedDir, '.zcode')), '隔离目录应产生 .zcode 数据（正向证据）')
      const isoHomeAfter = homeZcodeSnapshot()
      if (!isoHomeBefore.existed) assert.ok(!isoHomeAfter.existed, '--isolated 模式不得创建用户 ~/.zcode')
      else if (isoHomeAfter.files.length !== isoHomeBefore.files.length) console.log(`  ~   注意：--isolated 运行期间用户 ~/.zcode 文件数变化（${isoHomeBefore.files.length}→${isoHomeAfter.files.length}）；存在并发进程时可能来自其他应用，请人工复核`)
      console.log('  ok  --isolated 隔离验证（ZCODE_DATA_BASE_DIR=临时目录，HOME 系变量重定向，ZCODE_BASE_URL 已剔除）')
      child.stdin.end()
      const isoExitDeadline = Date.now() + 20_000
      while (exited === undefined && Date.now() < isoExitDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(exited !== undefined && exited.code === 0, `隔离实例应正常退出 code=0，实际 ${exited ? exited.code : '未退出'}`)
      await assertNoLeftoverProcesses('zcode-acp-ws-')
    } finally {
      try { rmSync(isolatedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (error) {
        console.log(`  ~   隔离目录清理失败（留待系统清理）：${isolatedDir}：${error.message.split('\n')[0]}`)
      }
    }
    // 10. 取证硬化：伪装 app-server（发 ready 通知 → 应答 session/create → 写 stderr 后自杀），
    //     断言意外退出后尸检日志生成且含 stderr/帧/退出码；再用真实 CLI 成功启动，断言日志被清除。
    const forensicDataDir = mkdtempSync(join(tmpdir(), 'zcode-acp-fx-'))
    const forensicLogPath = join(forensicDataDir, 'zcode-adapter-last-error.log')
    const stubBin = join(forensicDataDir, 'stub-zcode-crash.cjs')
    writeFileSync(stubBin, [
      '// smoke stub：伪装 app-server——ready 通知 → 应答 session/create → stderr 自杀（code=9）',
      "process.stdout.write(JSON.stringify({ method: 'startup/storageState', params: { phase: 'ready' } }) + '\\n')",
      "let buffered = ''",
      'process.stdin.on("data", (chunk) => {',
      '  buffered += chunk',
      '  let index',
      `  while ((index = buffered.indexOf("\\n")) >= 0) {`,
      `    const line = buffered.slice(0, index); buffered = buffered.slice(index + 1)`,
      '    if (!line.trim()) continue',
      '    let message; try { message = JSON.parse(line) } catch { continue }',
      `    if (message.method === "session/create") {`,
      `      process.stdout.write(JSON.stringify({ id: message.id, result: { session: { sessionId: "sess_stub_forensic" } } }) + "\\n")`,
      `      console.error("stub-zcode: simulated app-server crash after session/create")`,
      '      process.exit(9)',
      '    }',
      '  }',
      '})'
    ].join('\n'), 'utf8')
    try {
      wireAdapter(stubBin, forensicDataDir)
      const stubInit = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
      assert.equal(stubInit.error, undefined, `stub 场景 initialize 失败：${JSON.stringify(stubInit.error)}`)
      send({ jsonrpc: '2.0', id: ++rpcId, method: 'session/new', params: { cwd: workspace, mcpServers: [] } })
      const stubExitDeadline = Date.now() + 30_000
      while (exited === undefined && Date.now() < stubExitDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(exited !== undefined, 'stub app-server 崩溃后适配器应退出（意外退出路径 shutdown(1)）')
      assert.equal(exited.code, 1, `意外退出路径适配器退出码应为 1，实际 ${exited.code}`)
      const logDeadline = Date.now() + 10_000
      while (!existsSync(forensicLogPath) && Date.now() < logDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(existsSync(forensicLogPath), '崩溃后应生成 zcode-adapter-last-error.log')
      const forensic = readFileSync(forensicLogPath, 'utf8')
      assert.match(forensic, /stub-zcode: simulated app-server crash/, '尸检日志应包含 app-server stderr')
      assert.match(forensic, /session\/create/, '尸检日志应包含最近收发帧')
      assert.match(forensic, /code=9|signal=/, '尸检日志应包含退出码或信号')
      assert.match(forensic, /意外退出/, '尸检日志应标注意外退出原因')
      console.log('  ok  取证：app-server 意外退出 → 尸检日志生成（stderr/帧/退出码）')

      wireAdapter(zcodeBin, forensicDataDir)
      const freshInit = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
      assert.equal(freshInit.error, undefined, `成功启动场景 initialize 失败：${JSON.stringify(freshInit.error)}`)
      const freshSession = await call('session/new', { cwd: workspace, mcpServers: [] }, 60_000)
      assert.equal(freshSession.error, undefined, `成功启动场景 session/new 失败：${JSON.stringify(freshSession.error)}`)
      assert.ok(!existsSync(forensicLogPath), '适配器成功启动后旧尸检日志应被清除')
      child.stdin.end()
      const freshExitDeadline = Date.now() + 20_000
      while (exited === undefined && Date.now() < freshExitDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(exited !== undefined && exited.code === 0, `第二次适配器应正常退出 code=0，实际 ${exited ? exited.code : '未退出'}`)
      await assertNoLeftoverProcesses('zcode-acp-fx-')
      await assertNoLeftoverProcesses('zcode-acp-ws-') // 第二次实例的真实 app-server 以 workspace 为命令行标记
      console.log('  ok  取证：成功启动后尸检日志被清除，无残留进程')
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill() } catch { /* 已退出 */ }
        await new Promise((resolve) => setTimeout(resolve, 500))
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      }
      try { rmSync(forensicDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (error) {
        console.log(`  ~   取证临时目录清理失败（留待系统清理）：${forensicDataDir}：${error.message.split('\n')[0]}`)
      }
    }

    console.log('\nZCode ACP 适配器冒烟通过')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch { /* 已退出 */ }
      await new Promise((resolve) => setTimeout(resolve, 500))
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
    for (const directory of [workspace]) {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (error) {
        console.log(`  ~   临时目录清理失败（留待系统清理）：${directory}：${error.message.split('\n')[0]}`)
      }
    }
  }
}

if (!process.argv.includes('--live')) {
  await import('./acp-zcode-protocol.mjs')
} else main().then(() => process.exit(0)).catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  console.error(`真实用户态模型探测摘要：${lastModelSummary}`)
  if (stderrTail) console.error(`适配器 stderr 尾部：\n${stderrTail.slice(-1500)}`)
  process.exit(1)
})
