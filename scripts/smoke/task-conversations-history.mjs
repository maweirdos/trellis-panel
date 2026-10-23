/** Native history parser/scanner + real isolated persistence; never activates clients. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createFixture, database } from './fixtures/task-conversations-data.mjs'
import { checkStaticExec } from './fixtures/task-conversations-static-exec.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-conversation-history-'))
let checks = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
const at = '2026-09-24T12:00:00Z'
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n'
const receipt = (dir, id, prefix = 'codex', create = false) => `\x1b[32m${create ? 'Activated task for this session:' : '✓ Current task set to:'} .trellis/tasks/${dir}\x1b[0m\r\nSource: session:${prefix}_${id}\r\n${create ? `Created task: ${dir}\n` : ''}`
const taskCommand = (dir, flag = '-X utf8') => `python ${flag} .trellis/scripts/task.py start .trellis/tasks/${dir}`
function codexPair(command, output, options = {}) {
  const callId = randomUUID()
  return [
    { type: 'response_item', timestamp: at, payload: options.direct ? { type: 'function_call', call_id: callId, name: 'exec_command', arguments: JSON.stringify({ cmd: command, workdir: options.cwd }) }
      : { type: 'custom_tool_call', call_id: callId, name: 'exec', input: `const r=await tools.exec_command(${JSON.stringify({ cmd: command, workdir: options.cwd })}); text(r.output);` } },
    { type: 'response_item', timestamp: at, payload: { type: options.direct ? 'function_call_output' : 'custom_tool_call_output', call_id: callId,
      output: options.raw ? [{ type: 'input_text', text: 'Script completed\nWall time 0.7 seconds\nOutput:\n' }, { type: 'input_text', text: output }]
        : [{ type: 'input_text', text: JSON.stringify({ exit_code: options.failed ? 1 : 0, output }) }] } }
  ]
}
function prepare(base) {
  const f = createFixture(base)
  const task = (name, id = name, createdAt = '2026-09-24') => {
    const path = f.task(name, id)
    writeFileSync(join(path, 'task.json'), JSON.stringify({ id, createdAt, status: 'in_progress' }))
    return path
  }
  const log = join(f.roots.codex, 'rollout-name-does-not-prove-id.jsonl')
  database(f.codexFile, 'ALTER TABLE threads ADD COLUMN rollout_path TEXT; ALTER TABLE threads ADD COLUMN thread_source TEXT', db => {
    db.prepare('UPDATE threads SET rollout_path=?,thread_source=? WHERE id=?').run(log, 'user', f.codexId)
  })
  const head = { type: 'session_meta', payload: { id: f.codexId, cwd: f.root, source: 'vscode' } }
  return { ...f, task, log, head }
}
try {
  const bundle = join(directory, 'history.cjs')
  await build({ stdin: { contents: `export {TaskConversationsService} from './src/main/services/task-conversations';
    export {nativeReader} from './src/main/services/task-conversations/lib/native';
    export {taskCommands,nestedShellInputs} from './src/main/services/task-conversations/lib/history-command';
    export {HistoryParser} from './src/main/services/task-conversations/lib/history-parser';
    export {HISTORY_LIMITS} from './src/main/services/task-conversations/lib/history';
    export {ZcodeJsonStream} from './src/main/services/task-conversations/lib/history-stream';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const { TaskConversationsService: Service, nativeReader, taskCommands, nestedShellInputs, HistoryParser, HISTORY_LIMITS, ZcodeJsonStream } = createRequire(import.meta.url)(bundle)
  await checkStaticExec({ HistoryParser, nestedShellInputs, taskCommands }, check)
  if (!process.argv.includes('--commands-only')) {
    const selected = []
    const keyStream = new ZcodeJsonStream((kind, value) => selected.push({ kind, value }))
    keyStream.feed(Buffer.from('{"meta":{"taskId":"expected"},"' + 'x'.repeat(100)))
    keyStream.feed(Buffer.from('x'.repeat(2 * 1024 * 1024)))
    check(keyStream.limited, 'oversized JSON key is bounded and diagnosed before its closing quote')
    keyStream.feed(Buffer.from('\\'))
    keyStream.feed(Buffer.from('"escaped":{"taskId":"wrong"},"messages":[{"role":"assistant","tools":[]}]}'))
    check(selected.length === 2 && selected[0].kind === 'meta' && selected[0].value.taskId === 'expected' && selected[1].kind === 'message', 'oversized escaped key across chunks cannot inherit meta or corrupt subsequent messages')
    const f = prepare(join(directory, 'associations'))
    const positive = ['workflow', 'jira', 'created-child', 'direct-start', 'claude-task', 'zcode-task', 'zcode-runtime']
    const negative = ['failed', 'read-example', 'prose', 'wrong-source', 'wrong-project', 'parent', 'duplicate', 'reused', 'wrong-call', 'sidechain']
    for (const name of [...positive, ...negative]) f.task(name)
    f.task('copy', 'duplicate')
    f.task('reused', 'replacement', '2026-10-22')
    f.task('archive/2026-10/stable-archive', 'stable-id')
    f.task('archive/2026-10/path-only-archive', 'path-only-id')
    f.task('archive/2026-10/ambiguous-a', 'ambiguous-id'); f.task('archive/2026-10/ambiguous-b', 'ambiguous-id')
    const rows = [f.head, null, [], 'example', 12, { type: 'response_item', payload: null },
      ...codexPair(taskCommand('workflow'), receipt('workflow', f.codexId), { raw: true }),
      ...codexPair(taskCommand('jira', '-Xutf8'), receipt('jira', f.codexId)),
      ...codexPair('py -3 .trellis/scripts/task.py create child --parent .trellis/tasks/parent', receipt('created-child', f.codexId, 'codex', true)),
      ...codexPair(taskCommand('direct-start', '-u'), receipt('direct-start', f.codexId), { direct: true }),
      ...codexPair(taskCommand('failed'), receipt('failed', f.codexId), { failed: true }),
      ...codexPair('Get-Content .trellis/tasks/read-example/prd.md', receipt('read-example', f.codexId), { raw: true }),
      ...codexPair(taskCommand('wrong-source'), receipt('wrong-source', randomUUID())),
      ...codexPair(taskCommand('wrong-project'), receipt('wrong-project', f.codexId), { cwd: f.foreign }),
      ...codexPair(taskCommand('duplicate'), receipt('duplicate', f.codexId)),
      ...codexPair(taskCommand('reused'), receipt('reused', f.codexId)),
      ...codexPair(taskCommand('path-only-archive'), receipt('path-only-archive', f.codexId)),
      ...codexPair('python .trellis/scripts/task.py current --json', JSON.stringify({ current_task: { dir: '.trellis/tasks/stable-archive', id: 'stable-id' }, source: `session:codex_${f.codexId}`, stale: false })),
      ...codexPair('python .trellis/scripts/task.py current --json', JSON.stringify({ current_task: { dir: '.trellis/tasks/missing-ambiguous', id: 'ambiguous-id' }, source: `session:codex_${f.codexId}`, stale: false })),
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: receipt('prose', f.codexId) }] } }
    ]
    const wrongCall = codexPair(taskCommand('wrong-call'), receipt('wrong-call', f.codexId)); wrongCall[1].payload.call_id = randomUUID(); rows.push(...wrongCall)
    // Multiple nested invocations retain their own output slots; failed task output cannot borrow a dump's receipt.
    const multi = randomUUID()
    rows.push({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: multi, name: 'exec', input:
      `text(await tools.exec_command({cmd:${JSON.stringify(taskCommand('read-example'))}}));text(await tools.exec_command({cmd:'Get-Content sample.txt'}));` } },
    { type: 'response_item', timestamp: at, payload: { type: 'custom_tool_call_output', call_id: multi, output: [
      { type: 'input_text', text: JSON.stringify({ exit_code: 1, output: 'failed' }) },
      { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: receipt('read-example', f.codexId) }) }
    ] } })
    writeFileSync(f.log, jsonl(rows))
    const mismatchFile = join(f.roots.codex, 'wrong-session.jsonl')
    writeFileSync(mismatchFile, jsonl([f.head, ...codexPair(taskCommand('prose'), receipt('prose', f.codexOther))]))
    const foreignHeaderId = randomUUID(), foreignHeaderFile = join(f.roots.codex, 'wrong-cwd.jsonl')
    writeFileSync(foreignHeaderFile, jsonl([{ type: 'session_meta', payload: { id: foreignHeaderId, cwd: f.foreign } }, ...codexPair(taskCommand('prose'), receipt('prose', foreignHeaderId))]))
    database(f.codexFile, null, db => {
      db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(mismatchFile, f.codexOther)
      db.prepare('INSERT INTO threads(id,cwd,title,updated_at_ms,rollout_path,thread_source) VALUES(?,?,?,?,?,?)').run(foreignHeaderId, f.root, 'Metadata must match its indexed project', 1800000000000, foreignHeaderFile, 'user')
    })
    f.runtimeRecord(`codex_${f.codexId}.json`, { platform: 'codex', current_task: join(f.root, '.trellis', 'tasks', 'jira'), cwd: f.root })
    const claudeCall = randomUUID()
    appendFileSync(f.claudeFile, jsonl([
      { type: 'assistant', sessionId: f.claudeId, cwd: f.root, timestamp: at, message: { content: [{ type: 'tool_use', id: claudeCall, name: 'Bash', input: { command: taskCommand('claude-task') } }] } },
      { type: 'user', sessionId: f.claudeId, cwd: f.root, timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: claudeCall, content: receipt('claude-task', f.claudeId, 'claude'), is_error: false }] } },
      { type: 'user', sessionId: f.claudeId, cwd: f.root, message: { content: receipt('prose', f.claudeId, 'claude') } }
    ]))
    const sidechain = randomUUID()
    writeFileSync(join(f.partition, `${sidechain}.jsonl`), jsonl([
      { type: 'system', sessionId: sidechain, cwd: f.root, isSidechain: true },
      { type: 'assistant', sessionId: sidechain, cwd: f.root, message: { content: [{ type: 'tool_use', id: 'child-tool', name: 'Bash', input: { command: taskCommand('sidechain') } }] } },
      { type: 'user', sessionId: sidechain, cwd: f.root, timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: receipt('sidechain', sidechain, 'claude') }] } }
    ]))
    const providerId = randomUUID(), workspaceKey = 'fixture-workspace'
    database(f.zcodeFile, 'ALTER TABLE tasks ADD COLUMN workspace_key TEXT', db => db.prepare('UPDATE tasks SET workspace_key=?,acp_session_id=? WHERE task_id=?').run(workspaceKey, providerId, f.zcodeId))
    const zfile = join(f.roots.zcode, 'sessions', workspaceKey, `${f.zcodeId}.json`)
    mkdirSync(join(f.roots.zcode, 'sessions', workspaceKey), { recursive: true })
    const zmessage = name => ({ role: 'assistant', timestamp: at, tools: [{ status: 'completed', input: { command: taskCommand(name) }, output: receipt(name, providerId, 'claude'), raw: { _meta: { claudeCode: { toolName: 'Bash' } } } }] })
    const zjson = { meta: { taskId: f.zcodeId, workspacePath: f.root, acpSessionId: providerId }, messages: [zmessage('zcode-task')] }
    writeFileSync(zfile, JSON.stringify(zjson))
    f.runtimeRecord('zcode-alias.json', { platform: 'zcode', session_id: providerId, current_task: 'tasks/zcode-runtime', cwd: f.root })
    let service = new Service(f.options)
    let snapshot = await service.list(f.root)
    for (const name of positive) check(snapshot.bindings.some(link => link.taskDir === name), `recover actual ${name} task without manual association`)
    for (const name of negative) check(!snapshot.bindings.some(link => link.taskDir === name), `refuse ${name} false association`)
    check(snapshot.bindings.some(link => link.taskDir === 'archive/2026-10/stable-archive'), 'explicit successful current JSON recovers unique stable-ID archive')
    check(!snapshot.bindings.some(link => link.taskDir === 'archive/2026-10/path-only-archive'), 'path-only output cannot establish archive identity')
    check(!snapshot.bindings.some(link => link.taskRef === 'task:ambiguous-id'), 'explicit stable ID still cannot select between copied archive targets')
    check(snapshot.bindings.find(link => link.taskDir === 'zcode-runtime').conversation.sessionId === f.zcodeId, 'provider alias imports native desktop ID')
    check(!snapshot.indexing, 'small logs complete in one bounded pass')
    const candidates = await service.discover(f.root)
    check(!candidates.items.some(item => item.sessionId === sidechain), 'Claude sidechain history is excluded from default discovery')
    check(Object.keys(candidates).sort().join(',') === 'items,projectRoot,sources,truncated', 'internal evidence/progress/aliases never leak in discovery')
    check(!('evidence' in snapshot) && !('runtimeAliases' in snapshot) && !('historyProgress' in snapshot), 'snapshot projects only the indexing flag')
    const workflow = snapshot.bindings.find(link => link.taskDir === 'workflow')
    const claude = candidates.items.find(item => item.sessionId === f.claudeId)
    snapshot = await service.bind(f.root, 'workflow', claude.id)
    check(snapshot.bindings.find(link => link.taskDir === 'workflow' && link.primary).conversation.source === 'claude-code', 'manual primary survives repeated history import')
    await service.unbind(f.root, 'workflow', workflow.id)
    snapshot = await service.list(f.root)
    check(!snapshot.bindings.some(link => link.id === workflow.id), 'unlink suppression survives repeated historical evidence')
    service.close(); service = new Service(f.options); snapshot = await service.list(f.root)
    check(!snapshot.bindings.some(link => link.taskDir === 'workflow' && link.conversation.source === 'codex'), 'unlink suppression survives restart and fresh history scan')
    service.close()
    const read = nativeReader(f.options, f.launch)
    let result = await read(f.root)
    check(!result.evidence.some(hint => hint.sessionId === f.codexOther || hint.sessionId === foreignHeaderId), 'native session metadata must match both indexed ID and exact project cwd')
    result = await read(f.root)
    check(result.historyProgress.bytesRead === 0 && !result.indexing, 'completed history uses cached progress without rereading bytes')
    f.task('zcode-rewrite')
    zjson.messages.push(zmessage('zcode-rewrite'))
    writeFileSync(zfile, JSON.stringify(zjson)); result = await read(f.root)
    check(result.evidence.some(hint => hint.source === 'zcode' && hint.taskDir.endsWith('/zcode-rewrite')), 'growing ZCode snapshot rewrites restart structural parsing')
    check(result.historyProgress.bytesRead > 0, 'changed snapshot reads fresh bounded content')
    zjson.meta.acpSessionId = randomUUID(); writeFileSync(zfile, JSON.stringify(zjson)); result = await read(f.root)
    check(!result.runtimeAliases.length && !result.evidence.some(hint => hint.source === 'zcode'), 'mismatched ZCode provider metadata cannot prove alias or task evidence')
    for (const flag of ['-X utf8', '-Xutf8', '-u', '-3']) check(taskCommands(f.root, taskCommand('workflow', flag), f.root).length === 1, `literal interpreter flag ${flag}`)
    check(taskCommands(f.root, `echo ${JSON.stringify(receipt('workflow', f.codexId))}`, f.root).length === 0, 'echo examples are not task commands')
    check(taskCommands(f.root, `${taskCommand('workflow')}; echo 'Source: session:codex_${f.codexId}'`, f.root).length === 0, 'mixed shell cannot manufacture source receipts')
    check(nestedShellInputs(`// tools.exec_command({cmd:'fake'})\ntext('tools.exec_command({cmd: fake})');`).length === 0, 'comments and quoted JS examples do not count as invocations')
    check(nestedShellInputs(`text(await tools.exec_command({cmd:${JSON.stringify(taskCommand('workflow'))},workdir:unknownDirectory}));`).length === 0, 'unknown JavaScript workdir cannot silently become the native cwd')
    check(nestedShellInputs(`text(await tools.exec_command({cmd:${JSON.stringify(taskCommand('workflow'))}+suffix}));`).length === 0, 'computed JavaScript command is refused instead of truncating at its first literal')
    const g = prepare(join(directory, 'incremental'))
    g.task('middle'); g.task('partial')
    const padding = jsonl([{ type: 'response_item', payload: { type: 'message', content: 'x'.repeat(32768) } }]).repeat(80)
    writeFileSync(g.log, jsonl([g.head]) + padding + jsonl(codexPair(taskCommand('middle'), receipt('middle', g.codexId), { raw: true })) + padding)
    const incremental = nativeReader(g.options, g.launch)
    let batches = 0, totalRead = 0
    do {
      result = await incremental(g.root); totalRead += result.historyProgress.bytesRead; batches++
      check(result.historyProgress.bytesRead <= HISTORY_LIMITS.passBytes, 'each pass obeys global byte budget')
      if (batches === 1) check(result.indexing && !result.evidence.length, 'head-only pass neither pretends completion nor invents middle evidence')
    } while (result.indexing && batches < 20)
    check(batches > 1 && !result.indexing && result.evidence.some(hint => hint.taskDir.endsWith('/middle')), 'bounded passes find the middle of a multi-megabyte native log')
    check(totalRead === readFileSync(g.log).length + readFileSync(g.claudeFile).length, 'incremental scan reads each history byte once')
    const partial = jsonl(codexPair(taskCommand('partial'), receipt('partial', g.codexId)))
    appendFileSync(g.log, partial.slice(0, -25)); result = await incremental(g.root)
    check(!result.evidence.some(hint => hint.taskDir.endsWith('/partial')) && !result.indexing, 'partial final record waits for append without endless indexing')
    appendFileSync(g.log, partial.slice(-25)); result = await incremental(g.root)
    check(result.evidence.some(hint => hint.taskDir.endsWith('/partial')), 'call/result pairing survives split append at EOF')
    appendFileSync(g.log, 'x'.repeat(2 * 1024 * 1024 + 20) + '\n{bad-json}\n'); do { result = await incremental(g.root) } while (result.indexing)
    check(result.sources.find(source => source.source === 'codex').detail.includes('上限'), 'oversized/malformed records have an honest permanent-limit diagnostic')
    result = await incremental(g.root); check(result.historyProgress.bytesRead === 0 && !result.indexing, 'completed/limited scan stops reading and indexing')
    truncateSync(g.log, HISTORY_LIMITS.fileBytes + 1)
    result = await incremental(g.root)
    check(!result.indexing && !result.evidence.length && result.sources.find(source => source.source === 'codex').detail.includes('上限'), 'permanently oversized file is refused without endless indexing or stale evidence')
    const old = prepare(join(directory, 'old-requested'))
    old.task('old-current')
    writeFileSync(old.log, jsonl([old.head]))
    database(old.codexFile, null, db => {
      const insert = db.prepare('INSERT INTO threads(id,cwd,title,updated_at_ms,thread_source) VALUES(?,?,?,?,?)')
      for (let n = 0; n < 505; n++) insert.run(randomUUID(), old.root, 'newer', 1900000000000 + n, 'user')
    })
    old.runtimeRecord('old-current.json', { platform: 'codex', session_id: old.codexId, current_task: 'tasks\\old-current', cwd: old.root })
    old.task('old-zcode')
    const oldProvider = randomUUID()
    database(old.zcodeFile, 'ALTER TABLE tasks ADD COLUMN workspace_key TEXT', db => {
      db.prepare('UPDATE tasks SET workspace_key=?,acp_session_id=? WHERE task_id=?').run('old-workspace', oldProvider, old.zcodeId)
      const insert = db.prepare('INSERT INTO tasks(task_id,workspace_path,title,updated_at,deleted) VALUES(?,?,?,?,0)')
      for (let n = 0; n < 505; n++) insert.run(randomUUID(), old.root, 'newer desktop task', 1900000000000 + n)
    })
    mkdirSync(join(old.roots.zcode, 'sessions', 'old-workspace'), { recursive: true })
    writeFileSync(join(old.roots.zcode, 'sessions', 'old-workspace', `${old.zcodeId}.json`), JSON.stringify({ meta: { taskId: old.zcodeId, workspacePath: old.root, acpSessionId: oldProvider }, messages: [] }))
    old.runtimeRecord('old-provider.json', { platform: 'claude-code', session_id: oldProvider, current_task: '.trellis/tasks/old-zcode', cwd: old.root })
    service = new Service(old.options); snapshot = await service.list(old.root)
    check(snapshot.bindings.some(link => link.taskDir === 'old-current' && link.conversation.sessionId === old.codexId), 'old runtime native ID is requested before the default 500-item page')
    check(snapshot.bindings.some(link => link.taskDir === 'old-zcode' && link.conversation.sessionId === old.zcodeId), 'old ZCode provider alias is queried beyond 500 rows and still saves its verified desktop ID')
    await assert.rejects(service.bind(old.root, 'tasks\\old-current', snapshot.bindings[0].conversation.id), error => error.code === 'E_INVALID_ARG'); checks++
    service.close()
  }
  console.log(JSON.stringify({ ok: true, checks, scope: process.argv.includes('--commands-only')
    ? 'static JavaScript/shell evidence ownership against in-memory tools; no native commands'
    : 'actual native history formats, incremental bounded scanner and isolated durable import; no native launches' }))
} finally { rmSync(directory, { recursive: true, force: true }) }
