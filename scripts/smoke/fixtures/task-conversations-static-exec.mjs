import assert from 'node:assert/strict'

/** Fixed programs run only against in-memory shell/text stubs; no native command is executed. */
export async function checkStaticExec({ HistoryParser, nestedShellInputs, taskCommands }, check) {
  const root = 'D:/static-exec-fixture', sessionId = '00000000-0000-4000-8000-000000000001'
  const command = name => `python -X utf8 .trellis/scripts/task.py start .trellis/tasks/${name}`
  const current = 'python .trellis/scripts/task.py current --json'
  const receipt = name => `✓ Current task set to: .trellis/tasks/${name}\nSource: session:codex_${sessionId}\n`
  const currentReceipt = JSON.stringify({ current_task: { dir: '.trellis/tasks/printed-example', id: 'printed-example' }, source: `session:codex_${sessionId}`, stale: false })
  const call = name => `await tools.exec_command(${JSON.stringify({ cmd: command(name), workdir: root, max_output_tokens: 1000, yield_time_ms: 1000 })})`
  const conversation = { id: 'candidate', source: 'codex', sessionId, title: 'fixture', titleSource: 'native', cwd: root, updatedAt: 0, capability: 'session' }
  const parse = (input, output) => {
    const parser = new HistoryParser(root, { conversation, sourceRoot: root, file: 'unused.jsonl' })
    parser.line({ type: 'session_meta', payload: { id: sessionId, cwd: root, source: 'vscode' } })
    parser.line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'static-exec-fixture', name: 'exec', input } })
    parser.line({ type: 'response_item', timestamp: '2026-10-22T00:00:00Z', payload: { type: 'custom_tool_call_output', call_id: 'static-exec-fixture', output } })
    return parser.evidence()
  }
  const run = async (input, outputFor = options => receipt(options.cmd.split('/').at(-1))) => {
    let calls = 0
    const printed = []
    await new Function('tools', 'text', `return (async()=>{${input}\n})()`)(
      { exec_command: async options => { calls++; return { exit_code: 0, output: outputFor(options) } } },
      value => printed.push({ type: 'input_text', text: typeof value === 'string' ? value : JSON.stringify(value) })
    )
    return { calls, printed, evidence: parse(input, printed) }
  }
  for (const [name, input] of [
    ['direct awaited result', `text(${call('alpha')});`],
    ['bound structural result', `const r=${call('alpha')};text(r);`],
    ['bound raw output', `const r=${call('alpha')};text(r.output);`],
    ['comment and newline statement separation', `// @exec: fixture\nconst r=${call('alpha')}\n/* real source wrapper */ text(r.output)`],
    ['quoted option keys', `const r=await tools.exec_command(${JSON.stringify({ cmd: command('alpha'), workdir: root })});text(r.output)`]
  ]) {
    const result = await run(input)
    check(result.calls === 1 && result.evidence.length === 1 && result.evidence[0].taskDir.endsWith('/alpha'), name + ' preserves real task evidence')
  }
  const reversed = `const first=${call('alpha')};const second=${call('beta')};text(second.output);text(first);`
  const reversedResult = await run(reversed)
  check(reversedResult.calls === 2 && reversedResult.evidence.map(item => item.taskDir.split('/').at(-1)).join(',') === 'beta,alpha', 'output slots follow text order rather than shell invocation order')
  for (const outputs of ['text(read.output);text(task.output);', 'text(task.output);text(read.output);']) {
    const input = `const read=await tools.exec_command({cmd:'Get-Content sample.txt'});const task=${call('beta')};${outputs}`
    const result = await run(input, options => options.cmd.startsWith('Get-Content') ? receipt('alpha') : receipt('beta'))
    check(result.evidence.length === 1 && result.evidence[0].taskDir.endsWith('/beta'), 'non-task output slot cannot borrow evidence in ' + outputs)
  }
  const rawInput = `const r=${call('alpha')};text(r.output);`
  const raw = await run(rawInput)
  const header = { type: 'input_text', text: 'Script completed\nWall time: 0.3 seconds\nOutput:\n' }
  check(parse(rawInput, [header, ...raw.printed]).length === 1, 'actual r.output raw result with native wrapper header remains supported')
  check(parse(rawInput, [{ type: 'input_text', text: 'Script completed\nWall time 0.7 seconds\nOutput:\n' }, ...raw.printed]).length === 1, 'real Codex header without Wall time colon is metadata, not a second print')
  const nativeCreate = 'python ./.trellis/scripts/task.py create "治理基座Trellis工作流与技能统一整改" --description "统一调整工作流、团队规则、最小测试、SQL脚本上传与Trellis技能中文化" --assignee maweirdos --priority P2 --meta ticket=HONSKY-1111'
  const nativeInput = `const r=await tools.exec_command(${JSON.stringify({ cmd: nativeCreate, workdir: root, max_output_tokens: 4000 })}); text(r.output);`
  check(parse(nativeInput, [{ type: 'input_text', text: 'Script completed\nWall time 0.7 seconds\nOutput:\n' }, { type: 'input_text', text: `Activated task for this session: .trellis/tasks/native-create\nSource: session:codex_${sessionId}\nCreated task: native-create\n` }]).length === 1, 'real Chinese task creation command plus colon-free header preserves native evidence')
  check(parse(rawInput, [...raw.printed, { type: 'input_text', text: receipt('alpha') }]).length === 0, 'one proven text cannot consume multiple unrelated result blocks')
  const unprinted = await run(`const unused=${call('alpha')};text(await tools.exec_command({cmd:'Get-Content sample.txt'}));`, () => receipt('alpha'))
  check(unprinted.evidence.length === 0, 'unprinted task result cannot borrow printed file contents')
  for (const [name, input] of [
    ['exact original false-branch repro', `if(false){tools.exec_command({cmd:${JSON.stringify(current)}})}text(${JSON.stringify(currentReceipt)});`],
    ['uninvoked function helper', `function unused(){return tools.exec_command({cmd:${JSON.stringify(current)}})}text(${JSON.stringify(currentReceipt)});`],
    ['uninvoked arrow helper', `const unused=()=>tools.exec_command({cmd:${JSON.stringify(current)}});text(${JSON.stringify(currentReceipt)});`],
    ['short circuit', `false && ${call('alpha')};text(${JSON.stringify(currentReceipt)});`],
    ['ternary branch', `false ? ${call('alpha')} : null;text(${JSON.stringify(currentReceipt)});`]
  ]) {
    const result = await run(input)
    check(result.calls === 0 && result.evidence.length === 0, name + ' has zero calls and zero accepted evidence')
  }
  for (const [name, input] of [
    ['conditional executed branch', `if(true){text(${call('alpha')})}`],
    ['loop', `for(let i=0;i<1;i++){text(${call('alpha')})}`],
    ['independent literal receipt', `const r=${call('alpha')};text(${JSON.stringify(receipt('alpha'))});`],
    ['mutated result', `const r=${call('alpha')};r.output=${JSON.stringify(receipt('beta'))};text(r.output);`],
    ['short circuit after call', `const r=${call('alpha')};r && text(r.output);`],
    ['arbitrary helper script', `const r=await Promise.all([${call('alpha')}]);text(r);`],
    ['dynamic command', `text(await tools.exec_command({cmd:${JSON.stringify(current)}+suffix}));`],
    ['dynamic workdir', `text(await tools.exec_command({cmd:${JSON.stringify(current)},workdir:unknown}));`],
    ['object spread override', `text(await tools.exec_command({cmd:${JSON.stringify(current)},...options}));`],
    ['duplicate command option', `text(await tools.exec_command({cmd:${JSON.stringify(current)},cmd:'Get-Content sample.txt'}));`],
    ['non-awaited call', `const r=tools.exec_command({cmd:${JSON.stringify(current)}});text(r);`],
    ['binding shadows text', `const text=${call('alpha')};text(text);`],
    ['reserved binding cannot form a valid program', `const for=${call('alpha')};text(for);`],
    ['trailing unsupported program', `text(${call('alpha')});if(false){}`],
    ['unterminated comment suffix', `text(${call('alpha')});/*`],
    ['CR ends a comment before an unsupported suffix', `text(${call('alpha')}); // comment\rif(false){}`],
    ['Unicode separator ends a comment before an unsupported suffix', `text(${call('alpha')}); // comment\u2028if(false){}`],
    ['token budget cannot accept partial prefix', `text(${call('alpha')});${';'.repeat(16400)}`],
    ['interpolated template option', 'text(await tools.exec_command({cmd:`python ${unknown}`}));']
  ]) check(nestedShellInputs(input).length === 0 && parse(input, raw.printed).length === 0, name + ' rejects the whole unsupported program')
  const safe = command('alpha')
  for (const input of [safe, `PYTHONUTF8=1 ${safe}`, `env PYTHONIOENCODING=utf-8 PYTHONUTF8=1 ${safe}`]) {
    check(taskCommands(root, input, root).length === 1, 'single task call with optional encoding-only environment prefix remains valid')
  }
  for (const [name, input] of [
    ['short circuit and receipt file', `false && ${current}; cat receipt.json`],
    ['successful prefix cannot prove conditional task', `true || ${current}; cat receipt.json`],
    ['shell if branch', `if false; then ${current}; fi; cat receipt.json`],
    ['PowerShell if branch', `if ($false) { ${current} }; Get-Content receipt.json`],
    ['multiline shell script', `false\n${current}\ncat receipt.json`],
    ['second command', `${current}; cat receipt.json`],
    ['pipe', `${current} | cat receipt.json`],
    ['redirection', `${current} > receipt.json`],
    ['substitution', `${current} $(cat receipt.json)`],
    ['backtick substitution', `${current} \`cat receipt.json\``],
    ['dynamic interpreter environment', `PYTHONPATH=/untrusted ${current}`],
    ['unsafe env executable override', `env PATH=/untrusted ${current}`],
    ['PowerShell stop-parsing suffix', `${current} --% ; cat receipt.json`]
  ]) {
    const script = `text(await tools.exec_command(${JSON.stringify({ cmd: input, workdir: root })}));`
    check(taskCommands(root, input, root).length === 0 && parse(script, [{ type: 'input_text', text: currentReceipt }]).length === 0, name + ' cannot convert printed receipts into task evidence')
  }
  assert.deepEqual(nestedShellInputs(reversed).map(item => item.cmd), [command('beta'), command('alpha')])
}
