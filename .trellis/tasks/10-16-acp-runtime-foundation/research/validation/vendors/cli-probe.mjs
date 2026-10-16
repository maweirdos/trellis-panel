// Clean-room diagnostic: invokes the user's existing CLI; never reads auth secrets.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const [globalModules, cwdArg, resultPathArg] = process.argv.slice(2)
const cwd = resolve(cwdArg)
const resultPath = resolve(resultPathArg)
const manifestRoot = join(globalModules, '@anthropic-ai', 'claude-code')
const manifest = JSON.parse(await readFile(join(manifestRoot, 'package.json'), 'utf8'))
const entry = resolve(manifestRoot, typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0])
const nativeExecutable = /\.exe$/i.test(entry)
const report = { probe: 'existing-claude-cli', version: manifest.version, cwd, exitCode: null, json: false, expectedMatched: false, authError: false, errorSummary: null }
report.readFixture = process.env.ACP_VALIDATION_CLI_READ_FIXTURE === '1'
const fixtureText = report.readFixture ? await readFile(join(cwd, 'README.md'), 'utf8') : ''
const expected = report.readFixture ? fixtureText.match(/Evidence token:\s*(\S+)/)?.[1] : 'CLAUDE_VALIDATION_READY'
const redact = (s) => String(s).replace(/(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[redacted-key]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
try {
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', ...(report.readFixture ? ['--tools','Read','--allowedTools','Read','--max-turns','3'] : []), report.readFixture ? 'Use the Read tool to read README.md from the current directory and reply with its Evidence token. Do not read unrelated files, use subagents, or access external resources.' : 'Reply exactly CLAUDE_VALIDATION_READY. Do not use tools or external resources.']
  const result = await promisify(execFile)(nativeExecutable ? entry : process.execPath, nativeExecutable ? args : [entry, ...args], { cwd, timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true })
  report.exitCode = 0
  try {
    const parsed = JSON.parse(result.stdout)
    report.json = true
    report.isError = parsed.is_error
    report.subtype = parsed.subtype
    report.expectedMatched = Boolean(expected) && String(parsed.result).includes(expected)
    report.authError = /auth|log\s?in|credential/i.test(String(parsed.result))
    if (parsed.is_error) report.errorSummary = redact(String(parsed.result)).slice(0, 300)
  } catch {
    report.expectedMatched = Boolean(expected) && result.stdout.includes(expected)
    report.authError = /auth|log\s?in|credential/i.test(result.stdout + result.stderr)
    report.errorSummary = 'Successful process did not return parseable JSON; raw output withheld.'
  }
} catch (error) {
  report.exitCode = error.code
  const output = String(error.stdout ?? '') + '\n' + String(error.stderr ?? '')
  report.authError = /auth|log\s?in|credential/i.test(output)
  try {
    const parsed = JSON.parse(String(error.stdout))
    report.json = true
    report.isError = parsed.is_error
    report.subtype = parsed.subtype
    report.errorSummary = redact(String(parsed.result ?? parsed.error ?? 'CLI returned an error')).slice(0, 300)
  } catch { report.errorSummary = redact(output.trim()).slice(0, 300) }
}
await mkdir(resolve(resultPath, '..'), { recursive: true })
await writeFile(resultPath, JSON.stringify(report, null, 2), 'utf8')
process.stdout.write(JSON.stringify(report) + '\n')
