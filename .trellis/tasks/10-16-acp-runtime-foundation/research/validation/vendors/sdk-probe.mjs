// Clean-room diagnostic: isolates the official Claude SDK from ACP/acpx.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
const [adapterRoot, cwdArg, executable, outputArg] = process.argv.slice(2)
const requireAdapter = createRequire(join(resolve(adapterRoot), 'package.json'))
const { query } = await import(pathToFileURL(requireAdapter.resolve('@anthropic-ai/claude-agent-sdk')).href)
const report = { probe: 'official-sdk-with-existing-cli', completed: false, expectedMatched: false, types: [], errors: [], result: null }
report.explicitEnvironment = process.env.ACP_VALIDATION_SDK_FULL_ENV === '1'
report.readFixture = process.env.ACP_VALIDATION_SDK_READ_FIXTURE === '1'
report.toolCalls = []
report.toolDecisions = []
report.toolErrors = []
report.toolResults = []
report.toolCatalog = []
report.lastAssistantText = ''
const fixtureText = report.readFixture ? await readFile(join(resolve(cwdArg), 'README.md'), 'utf8') : ''
const expectedToken = report.readFixture ? fixtureText.match(/Evidence token:\s*(\S+)/)?.[1] : 'CLAUDE_VALIDATION_READY'
const redact = (s) => String(s).replace(/(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[redacted-key]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 45_000)
let conversation
try {
  conversation = query({
    prompt: report.readFixture ? 'Use the Read tool to read README.md in the current working directory. Reply with the Evidence token in that file. Do not read other files, use subagents, or access external resources.' : 'Reply exactly CLAUDE_VALIDATION_READY. Do not use tools or external resources.',
    options: { cwd: resolve(cwdArg), settingSources: ['user', 'project', 'local'], pathToClaudeCodeExecutable: resolve(executable), maxTurns: report.readFixture ? 3 : 1, abortController: controller, permissionMode: 'default', tools: report.readFixture ? ['Read'] : [], canUseTool: async (name, input) => {
      const requested = typeof input.file_path === 'string' ? resolve(cwdArg, input.file_path) : ''
      const allowed = name === 'Read' && requested.toLowerCase() === join(resolve(cwdArg), 'README.md').toLowerCase()
      report.toolDecisions.push({ name, inputKeys: Object.keys(input), requestedPath: requested, allowed })
      return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Outside isolated Read fixture scope' }
    }, ...(report.explicitEnvironment ? { env: { ...process.env } } : {}) },
  })
  for await (const message of conversation) {
    report.types.push(message.type)
    if (message.type === 'system' && message.subtype === 'init') report.toolCatalog = Array.isArray(message.tools) ? message.tools : []
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) if (block.type === 'tool_use') report.toolCalls.push({ name: block.name, inputKeys: Object.keys(block.input ?? {}), requestedPath: block.input?.file_path })
      if (message.error) report.errors.push(redact(message.error))
      const text = (message.message?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('')
      if (text) report.lastAssistantText = redact(text).slice(0, 600)
      report.expectedMatched ||= Boolean(expectedToken) && text.includes(expectedToken)
    }
    if (message.type === 'user') for (const block of message.message?.content ?? []) if (block.type === 'tool_result') {
      const content = redact(typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
      report.toolResults.push({ id: block.tool_use_id, isError: block.is_error, expectedMatched: Boolean(expectedToken) && content.includes(expectedToken), content: content.slice(0, 800) })
      if (block.is_error) report.toolErrors.push(content.slice(0, 300))
    }
    if (message.type === 'result') {
      report.completed = true
      report.result = { subtype: message.subtype, is_error: message.is_error, errors: message.errors?.map(redact), summary: message.is_error ? redact(message.result ?? '').slice(0, 300) : null }
      report.expectedMatched ||= Boolean(expectedToken) && String(message.result ?? '').includes(expectedToken)
    }
  }
} catch (error) { report.errors.push(redact(error?.message ?? error)) }
finally {
  clearTimeout(timer)
  conversation?.close?.()
  await writeFile(resolve(outputArg), JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(report) + '\n')
}
