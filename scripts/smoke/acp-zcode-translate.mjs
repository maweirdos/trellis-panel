/**
 * ZCode ACP 翻译层表驱动单测（纯 node assert，无测试框架依赖；项目无 vitest）。
 * 样例帧全部取自任务 research/protocol-mapping.md §4 实测摘录及其 §1/§2 schema 旁证。
 * 运行：node scripts/smoke/acp-zcode-translate.mjs
 */
import assert from 'node:assert/strict'
import * as translate from '../../adapters/zcode-acp/src/translate.ts'

const cases = []
const test = (name, run) => cases.push({ name, run })

/* ---------- 模型 ID 编解码 ---------- */

test('encodeModelId 拼接 providerId/modelId', () => {
  assert.equal(translate.encodeModelId({ providerId: '36f9abc', modelId: 'K3' }), '36f9abc/K3')
})

test('decodeModelId 容错：合法/缺分隔符/空段/非字符串', () => {
  assert.deepEqual(translate.decodeModelId('36f9abc/K3'), { providerId: '36f9abc', modelId: 'K3' })
  assert.deepEqual(translate.decodeModelId('ns/a/b'), { providerId: 'ns', modelId: 'a/b' }) // 首个 '/' 分隔
  assert.equal(translate.decodeModelId('nomodelid'), undefined)
  assert.equal(translate.decodeModelId('/K3'), undefined)
  assert.equal(translate.decodeModelId('p/'), undefined)
  assert.equal(translate.decodeModelId(42), undefined)
})

/* ---------- 快照 → modes / model config option（§4 create 真实快照形态） ---------- */

const CREATE_SNAPSHOT = {
  messages: [],
  projection: {},
  protocol: { name: 'ZCode Protocol', version: 1 },
  runtime: { eventSeq: 0, stateRevision: 0 },
  session: {
    sessionId: 'sess_162a663c-cce4-460b-922f-5fac6778af25',
    mode: 'build',
    model: { providerId: '36f9-provider', modelId: 'K3' },
    status: 'idle',
    title: '',
    workspace: { workspacePath: 'D:/tmp/zprobe/work', workspaceKey: 'probe-ws' }
  },
  settings: {
    mode: { current: 'build' },
    model: {
      available: [
        { ref: { providerId: '36f9-provider', modelId: 'K3' }, label: 'K3', providerLabel: 'kimi', contextWindow: 1000000, maxOutputTokens: 131072,
          reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'max' },
          properties: { inputFormat: { supportsText: true, supportsImage: true } } }
      ]
    }
  }
}

test('modesFromSnapshot：快照 mode → currentModeId + 固定枚举表', () => {
  const modes = translate.modesFromSnapshot(CREATE_SNAPSHOT)
  assert.equal(modes.currentModeId, 'build')
  assert.ok(modes.availableModes.some((mode) => mode.id === 'plan'))
  assert.ok(modes.availableModes.some((mode) => mode.id === 'yolo'))
})

test('modesFromSnapshot：未知 mode 追加而非丢弃；空快照回退 build', () => {
  const modes = translate.modesFromSnapshot({ settings: { mode: { current: 'future-mode' } } })
  assert.equal(modes.currentModeId, 'future-mode')
  assert.ok(modes.availableModes.some((mode) => mode.id === 'future-mode'))
  assert.equal(translate.modesFromSnapshot({}).currentModeId, 'build')
})

test('modelConfigOptionFromSnapshot：available 目录 → category model 的 select config option', () => {
  const option = translate.modelConfigOptionFromSnapshot(CREATE_SNAPSHOT)
  assert.ok(option)
  assert.equal(option.id, 'zcode.model')
  assert.equal(option.type, 'select')
  assert.equal(option.category, 'model')
  assert.equal(option.currentValue, '36f9-provider/K3')
  assert.deepEqual(option.options, [{ value: '36f9-provider/K3', name: 'kimi › K3' }])
})

test('modelConfigOptionFromSnapshot：空目录/无 available 返回 undefined（不虚构模型表）', () => {
  assert.equal(translate.modelConfigOptionFromSnapshot({ settings: { model: { available: [] } } }), undefined)
  assert.equal(translate.modelConfigOptionFromSnapshot({}), undefined)
})

test('reasoningDefaultsFromSnapshot：目录 defaultLevel → 编码 modelId 映射（setModel 必带档位兜底）', () => {
  const defaults = translate.reasoningDefaultsFromSnapshot(CREATE_SNAPSHOT)
  assert.deepEqual(defaults, { '36f9-provider/K3': 'max' })
  assert.deepEqual(translate.reasoningDefaultsFromSnapshot({}), {})
})

/* ---------- ACP prompt → session/send content ---------- */

test('promptToZcodeContent：文本块拼接、非文本块忽略、空输入空串', () => {
  assert.equal(translate.promptToZcodeContent([{ type: 'text', text: 'hi' }]), 'hi')
  assert.equal(translate.promptToZcodeContent([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(translate.promptToZcodeContent([{ type: 'image', data: 'x' }]), '')
  assert.equal(translate.promptToZcodeContent('not-array'), '')
})

/* ---------- session/event 翻译表（分类 + 更新） ---------- */

test('classifyZcodeEvent：turn 边界 / 权限 / 更新 / 忽略', () => {
  assert.equal(translate.classifyZcodeEvent({ type: 'turn.completed' }), 'turn-end')
  assert.equal(translate.classifyZcodeEvent({ type: 'turn.failed' }), 'turn-failed')
  assert.equal(translate.classifyZcodeEvent({ type: 'permission.requested' }), 'permission')
  assert.equal(translate.classifyZcodeEvent({ type: 'model.streaming' }), 'updates')
  assert.equal(translate.classifyZcodeEvent({ type: 'tool.updated' }), 'updates')
  assert.equal(translate.classifyZcodeEvent({ type: 'permission.resolved' }), 'updates')
  assert.equal(translate.classifyZcodeEvent({ type: 'session.updated' }), 'updates')
  assert.equal(translate.classifyZcodeEvent({ type: 'session.titleUpdated' }), 'ignore')
  assert.equal(translate.classifyZcodeEvent({ type: 'checkpoint.created' }), 'ignore')
  assert.equal(translate.classifyZcodeEvent({}), 'ignore')
})

test('model.streaming text_delta → agent_message_chunk（§2.1 kind 枚举实测旁证）', () => {
  const updates = translate.zcodeEventToAcpUpdates({
    type: 'model.streaming',
    payload: { kind: 'text_delta', delta: '你好', assistantMessageId: 'msg_1', partId: 'part_1' }
  })
  assert.deepEqual(updates, [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } }])
})

test('model.streaming reasoning_delta → agent_thought_chunk', () => {
  const updates = translate.zcodeEventToAcpUpdates({ type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '思考中' } })
  assert.deepEqual(updates, [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考中' } }])
})

test('model.streaming tool_call / tool_input_start → tool_call 声明；text_start 等忽略', () => {
  const declared = translate.zcodeEventToAcpUpdates({ type: 'model.streaming', payload: { kind: 'tool_call', toolCallId: 'tc1', toolName: 'Read', input: {} } })
  assert.deepEqual(declared, [{ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read', kind: 'execute', rawInput: {} }])
  const start = translate.zcodeEventToAcpUpdates({ type: 'model.streaming', payload: { kind: 'tool_input_start', toolCallId: 'tc1', toolName: 'Read' } })
  assert.deepEqual(start, [{ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read', kind: 'execute' }])
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'model.streaming', payload: { kind: 'tool_input_delta', toolCallId: 'tc1', delta: '{' } }), [])
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'model.streaming', payload: { kind: 'text_start' } }), [])
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'model.streaming', payload: { kind: 'finish' } }), [])
})

test('tool.updated scheduled/started → tool_call(pending) / tool_call_update(in_progress)', () => {
  assert.deepEqual(
    translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'tc1', toolName: 'Bash' } }),
    [{ sessionUpdate: 'tool_call', toolCallId: 'tc1', kind: 'execute', status: 'pending', title: 'Bash' }]
  )
  assert.deepEqual(
    translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'started', toolCallId: 'tc1' } }),
    [{ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'in_progress' }]
  )
})

test('tool.updated result/error → completed/failed + outputTail 内容', () => {
  const done = translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc1', outputTail: 'file contents' } })
  assert.deepEqual(done, [{ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] }])
  const failed = translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'error', toolCallId: 'tc1', stderrTail: 'boom' } })
  assert.deepEqual(failed, [{ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom' } }] }])
  const failedNoTail = translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'error', toolCallId: 'tc1' } })
  assert.equal(failedNoTail[0].status, 'failed')
  assert.equal(failedNoTail[0].content[0].content.text, '工具执行失败')
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'batch' } }), [])
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'result' } }), []) // 缺 toolCallId 不虚构
})

test('session.updated mode → current_mode_update（§4 setMode 真实帧 + plan 覆盖层语义）', () => {
  // 原帧：{"payload":{"mode":"build","planEnabled":true,"previousMode":"build","previousPlanEnabled":false,"source":"command"},"seq":1,"type":"session.updated"}
  const planOverlay = translate.zcodeEventToAcpUpdates({ type: 'session.updated', payload: { mode: 'build', planEnabled: true, previousMode: 'build', previousPlanEnabled: false, source: 'command' } })
  assert.deepEqual(planOverlay, [{ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }])
  const pureMode = translate.zcodeEventToAcpUpdates({ type: 'session.updated', payload: { mode: 'edit', planEnabled: false, previousMode: 'build', previousPlanEnabled: false, source: 'command' } })
  assert.deepEqual(pureMode, [{ sessionUpdate: 'current_mode_update', currentModeId: 'edit' }])
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'session.updated', payload: {} }), [])
})

test('modesFromSnapshot：planEnabled=true 时呈现 plan 覆盖（快照本身不带 planEnabled 时回落 mode 值）', () => {
  const planOn = translate.modesFromSnapshot({ settings: { mode: { current: 'yolo' } }, session: { planEnabled: true } })
  assert.equal(planOn.currentModeId, 'plan')
  const plain = translate.modesFromSnapshot({ settings: { mode: { current: 'yolo' } }, session: {} })
  assert.equal(plain.currentModeId, 'yolo')
})

test('turn.completed resultType=cancelled → cancelled（§4 stop 真实帧）', () => {
  // 原帧 payload：{"response":"","tokenCount":0,"toolCallCount":0,"duration":6049,"resultType":"cancelled","inputId":"probe-input-1"}
  assert.equal(translate.turnStopReason({ type: 'turn.completed', payload: { resultType: 'cancelled', duration: 6049 } }), 'cancelled')
  assert.equal(translate.turnStopReason({ type: 'turn.completed', payload: { resultType: 'success' } }), 'end_turn')
  assert.equal(translate.turnStopReason({ type: 'turn.completed', payload: {} }), undefined)
})

test('turn.failed → 可读错误消息', () => {
  assert.equal(translate.turnFailureMessage({ type: 'turn.failed', payload: { error: { message: '认证失败' } } }), '认证失败')
  assert.equal(translate.turnFailureMessage({ type: 'turn.failed', payload: { message: 'provider 403' } }), 'provider 403')
  assert.equal(translate.turnFailureMessage({ type: 'turn.failed', payload: {} }), 'ZCode turn 失败（无错误详情）')
})

/* ---------- 权限 ---------- */

test('permissionRequestFromZcode：保留 native option IDs 与 response', () => {
  const request = translate.permissionRequestFromZcode({ requestId: 'req-1', toolName: 'Write', input: { path: 'a.txt' }, riskLevel: 'medium', options: [{ optionId: 'opaque-allow', name: '允许一次', kind: 'allow_once', response: { decision: 'allow' } }, { optionId: 'opaque-deny', name: '拒绝', kind: 'deny', response: { decision: 'deny' } }] })
  assert.ok(request)
  assert.equal(request.requestId, 'req-1')
  assert.deepEqual(request.options, [
    { optionId: 'opaque-allow', name: '允许一次', kind: 'allow_once' },
    { optionId: 'opaque-deny', name: '拒绝', kind: 'reject_once' }
  ])
  assert.equal(request.toolCall.toolCallId, 'req-1') // 无独立 toolCallId 时以 requestId 兜底
  assert.equal(translate.permissionRequestFromZcode({ toolName: 'Write' }), undefined)
})

/* ---------- workspace 键 ---------- */

test('workspaceKeyFromPath：Windows 路径规范化为 POSIX 形态', () => {
  assert.equal(translate.workspaceKeyFromPath('D:\\my_demo\\trellis-panel'), 'D:/my_demo/trellis-panel')
  assert.equal(translate.workspaceKeyFromPath('D:/tmp/work/'), 'D:/tmp/work')
})

test('unlisted/missing current never substitutes the first candidate; settings.current is authority', () => {
  const snapshot = structuredClone(CREATE_SNAPSHOT)
  snapshot.session.model = { providerId: 'p', modelId: 'missing' }
  assert.equal(translate.modelConfigOptionFromSnapshot(snapshot).currentValue, 'p/missing')
  delete snapshot.session.model
  assert.equal(translate.modelConfigOptionFromSnapshot(snapshot).currentValue, '')
  snapshot.settings.model.current = { providerId: 'actual', modelId: 'unlisted' }
  assert.equal(translate.modelConfigOptionFromSnapshot(snapshot).currentValue, 'actual/unlisted')
})

test('native nested tool result/error and progress preserve content/raw output/input', () => {
  const result = { output: 'NONCE', nested: { details: 'kept' } }
  const update = translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 't', result, duration: 1 } })[0]
  assert.deepEqual(update.rawOutput, result)
  assert.equal(update.content[0].content.text, 'NONCE')
  const error = { type: 'Error', message: 'DENIED', detail: 'scope denied' }
  const failed = translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'error', toolCallId: 't', error } })[0]
  assert.deepEqual(failed.rawOutput, error)
  assert.match(failed.content[0].content.text, /DENIED.*scope denied/s)
  const progress = translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'progress', toolCallId: 't', stdoutTail: 'out', stderrTail: 'err' } })[0]
  assert.equal(progress.content[0].content.text, 'out\nerr')
  assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 't', input: { path: 'x' } } })[0].rawInput, { path: 'x' })
})

test('native failed/limited/unknown terminal values never report end_turn', () => {
  for (const resultType of ['error_max_turns', 'error_max_budget', 'error_max_tool_calls', 'error_during_execution', 'future']) {
    const event = { type: 'turn.completed', payload: { resultType } }
    assert.equal(translate.turnStopReason(event), undefined)
    assert.match(translate.turnFailureMessage(event), new RegExp(resultType))
  }
})

test('native permission.resolved denial fails the original tool; allow/unknown/missing identity never settle it', () => {
  // Installed 0.16.9 Wfo / Uhr: resolved request; ffc also adds decision:deny
  // to direct policy denials, which have toolName/inputSummary but no requestId.
  for (const payload of [
    { requestId: 'perm-native', toolCallId: 'original-write', decision: 'deny', reason: 'Rejected by user' },
    { toolCallId: 'original-write', toolName: 'Write', decision: 'deny', reason: 'Policy denied', inputSummary: { file_path: 'owned.txt' } }
  ]) {
    const updates = translate.zcodeEventToAcpUpdates({ type: 'permission.resolved', payload })
    assert.equal(updates.length, 1)
    assert.equal(updates[0].toolCallId, 'original-write')
    assert.equal(updates[0].status, 'failed')
    assert.deepEqual(updates[0].rawOutput, payload)
    assert.equal(updates[0].content[0].content.text, payload.reason)
  }
  for (const payload of [
    { toolCallId: 'original-write', decision: 'allow' },
    { toolCallId: 'original-write', decision: 'modify' },
    { toolCallId: 'original-write', decision: 'escalate' },
    { toolCallId: 'original-write' }, { requestId: 'not-a-tool-id', decision: 'deny' },
    { toolCallId: '', decision: 'deny' }
  ]) assert.deepEqual(translate.zcodeEventToAcpUpdates({ type: 'permission.resolved', payload }), [])
})

/* ---------- 运行 ---------- */

test('model display qualifies providers and deduplicates exact refs without changing wire/current IDs', () => {
  const row = (providerId, modelId, label, providerLabel) => ({ ref: { providerId, modelId }, label, providerLabel })
  const option = translate.modelConfigOptionFromSnapshot({ settings: { model: {
    current: { providerId: 'account:bigmodel', modelId: 'GLM-5.3' },
    available: [row('account:bigmodel', 'GLM-5.3', 'GLM-5.3', 'BigModel'),
      row('kimi', 'K3', 'K3', 'kimi'), row('kimi', 'K3', 'duplicate ignored', 'ignored'),
      row('first', 'ccs-zhipu/glm-5.3[1M]', 'Same label', 'Same provider'),
      row('second', 'ccs-zhipu/glm-5.3[1M]', 'Same label', 'Same provider')] } } })
  assert.equal(option.currentValue, 'account:bigmodel/GLM-5.3')
  assert.deepEqual(option.options.slice(0, 2), [
    { value: 'account:bigmodel/GLM-5.3', name: 'GLM-5.3' }, { value: 'kimi/K3', name: 'kimi › K3' }])
  assert.equal(option.options.length, 4)
  assert.equal(new Set(option.options.map(item => item.name)).size, 4)
  assert.deepEqual(option.options.slice(2).map(item => item.value), ['first/ccs-zhipu/glm-5.3[1M]', 'second/ccs-zhipu/glm-5.3[1M]'])
  assert.ok(option.options[2].name.includes('first/'))
  assert.ok(option.options[3].name.includes('second/'))
})

let failed = 0
for (const { name, run } of cases) {
  try {
    run()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 翻译层用例通过`)
if (failed > 0) process.exit(1)
