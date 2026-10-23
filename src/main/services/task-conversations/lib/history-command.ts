import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { nativeTaskDir } from './identity'
import { pathKey, ordinaryPath } from './paths'

export type TaskCommand = { action: 'create' | 'start' | 'current'; target?: string }
type Token = { value: string; literal: boolean; lineBreak: boolean }
type ShellInput = { cmd: string; workdir?: string }
const RESERVED_RESULT_NAMES = new Set((
  'tools text arguments eval await async break case catch class const continue debugger default delete do else enum export extends false '
  + 'finally for function if import in instanceof interface implements let new null package private protected public return static super switch this throw true try typeof var void while with yield'
).split(' '))

/** A small literal-only lexer, not a JavaScript interpreter. Interpolated values are refused. */
function javascriptTokens(text: string): Token[] | null {
  const tokens: Token[] = []
  let lineBreak = false
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (/\s/.test(ch)) { lineBreak ||= /[\r\n\u2028\u2029]/.test(ch); i++; continue }
    if (text.startsWith('//', i)) {
      const end = text.slice(i).search(/[\r\n\u2028\u2029]/)
      if (end < 0) break
      i += end; lineBreak = true; continue
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return null
      lineBreak ||= /[\r\n\u2028\u2029]/.test(text.slice(i, end + 2)); i = end + 2; continue
    }
    if (tokens.length >= 16384) return null
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let value = '', valid = true, closed = false
      for (i++; i < text.length; i++) {
        const next = text[i]
        if (next === quote) { i++; closed = true; break }
        if (quote === '`' && text.startsWith('${', i)) valid = false
        if (quote !== '`' && /[\r\n]/.test(next)) valid = false
        if (next !== '\\') { value += next; continue }
        const escaped = text[++i]
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
        if (escaped === 'u' || escaped === 'x') {
          const count = escaped === 'u' ? 4 : 2, hex = text.slice(i + 1, i + 1 + count)
          if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) { valid = false; continue }
          value += String.fromCharCode(parseInt(hex, 16)); i += count
        } else if (/[1-9]/.test(escaped || '') || escaped === '0' && /\d/.test(text[i + 1] || '')) valid = false
        else if (escaped === '\r' && text[i + 1] === '\n') i++
        else if (escaped !== '\n' && escaped !== '\r') value += escapes[escaped] ?? escaped
      }
      if (!valid || !closed) return null
      tokens.push({ value, literal: true, lineBreak })
    } else {
      const word = text.slice(i).match(/^[A-Za-z_$][\w$]*|^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0]
      tokens.push({ value: word || ch, literal: false, lineBreak }); i += word?.length || 1
    }
    lineBreak = false
  }
  return tokens
}

/** Recognize a small straight-line grammar; never interpret arbitrary JavaScript. */
class StaticExec {
  private cursor = 0
  private calls = 0
  private readonly bindings = new Map<string, ShellInput>()
  constructor(private readonly tokens: Token[]) {}
  private is(value: string): boolean { const token = this.tokens[this.cursor]; return token?.literal === false && token.value === value }
  private take(value: string): void {
    if (!this.is(value)) throw new Error('Unsupported exec syntax')
    this.cursor++
  }
  private identifier(): string {
    const token = this.tokens[this.cursor++]
    if (!token || token.literal || !/^[A-Za-z_$][\w$]*$/.test(token.value)) throw new Error('Unsupported exec identifier')
    return token.value
  }
  private value(array = false): unknown {
    const token = this.tokens[this.cursor++]
    if (!token) throw new Error('Missing literal')
    if (token.literal) return token.value
    if (/^(true|false|null)$/.test(token.value)) return token.value === 'null' ? null : token.value === 'true'
    const number = token.value === '-' ? `-${this.tokens[this.cursor++]?.value}` : token.value
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number) && Number.isFinite(Number(number))) return Number(number)
    if (token.value !== '[' || array) throw new Error('Nonliteral exec option')
    const values: unknown[] = []
    while (!this.is(']')) {
      values.push(this.value(true))
      if (this.is(']')) break
      this.take(',')
    }
    this.take(']')
    return values
  }
  private call(): ShellInput {
    for (const word of ['await', 'tools', '.', 'exec_command', '(', '{']) this.take(word)
    const options = new Map<string, unknown>()
    while (!this.is('}')) {
      const token = this.tokens[this.cursor]
      const key = token?.literal ? (this.cursor++, token.value) : this.identifier()
      if (options.has(key)) throw new Error('Duplicate exec option')
      this.take(':'); options.set(key, this.value())
      if (this.is('}')) break
      this.take(',')
    }
    this.take('}'); this.take(')')
    const cmd = options.get('cmd'), workdir = options.get('workdir')
    if (typeof cmd !== 'string' || options.has('workdir') && typeof workdir !== 'string' || ++this.calls > 64) throw new Error('Unsupported shell call')
    return { cmd, ...(typeof workdir === 'string' ? { workdir } : {}) }
  }
  outputs(): ShellInput[] {
    const result: ShellInput[] = []
    while (this.cursor < this.tokens.length) {
      if (this.is(';')) { this.cursor++; continue }
      if (this.is('const')) {
        this.cursor++
        const name = this.identifier()
        if (RESERVED_RESULT_NAMES.has(name) || this.bindings.has(name)) throw new Error('Unsupported result binding')
        this.take('='); this.bindings.set(name, this.call())
      } else {
        this.take('text'); this.take('(')
        let shell: ShellInput | undefined
        if (this.is('await')) shell = this.call()
        else {
          shell = this.bindings.get(this.identifier())
          if (this.is('.')) { this.cursor++; this.take('output') }
        }
        if (!shell || result.length >= 64) throw new Error('Unowned exec output')
        this.take(')'); result.push(shell)
      }
      if (this.cursor < this.tokens.length && !this.is(';') && !this.tokens[this.cursor].lineBreak) throw new Error('Unsupported statement continuation')
    }
    return result
  }
}

/** Slots follow text() order, retaining non-task calls so their output cannot be borrowed. */
export function nestedShellInputs(script: string): ShellInput[] {
  if (script.length > 512 * 1024) return []
  const tokens = javascriptTokens(script)
  if (!tokens) return []
  try { return new StaticExec(tokens).outputs() } catch { return [] }
}

/** One literal command only: no control flow, substitutions, redirects or second command. */
function shellWords(text: string): string[] {
  if (/[`$\r\n]/.test(text)) return []
  const words: string[] = []
  let word = '', quote = '', started = false
  const flush = (): void => { if (started) words.push(word); word = ''; started = false }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) { word += quote; i++ } else quote = ''
      } else word += ch
    } else if (ch === '"' || ch === "'") { quote = ch; started = true }
    else if (/[;&|<>(){}#]/.test(ch)) return []
    else if (/\s/.test(ch)) flush()
    else { word += ch; started = true }
  }
  if (quote) return []
  flush()
  return words
}

export function taskCommands(root: string, command: string, cwd: string, workdir?: string): TaskCommand[] {
  if (command.length > 256 * 1024 || /Activated task for this session:|Current task set to:|Source:\s*session:/.test(command)) return []
  const directory = workdir ? (isAbsolute(ordinaryPath(workdir)) ? ordinaryPath(workdir) : resolve(cwd, workdir)) : cwd
  if (pathKey(directory) !== pathKey(root)) return []
  const words = shellWords(command.trim())
  // These encoding-only prefixes cannot change cwd, executable lookup or task identity.
  if (words[0] === 'env') words.shift()
  while (/^(?:PYTHONUTF8=1|PYTHONIOENCODING=utf-8)$/i.test(words[0] || '')) words.shift()
  if (!/^(?:.*[\\/])?(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i.test(words[0] || '')) return []
  let index = 1
  while (index < words.length) {
    if (/^-(?:u|B|E|I|s|S|3(?:\.\d+)?|Xutf8)$/.test(words[index])) { index++; continue }
    if (words[index] === '-X' && words[index + 1] === 'utf8') { index += 2; continue }
    break
  }
  const script = words[index]?.replace(/\\/g, '/')
  if (!script || pathKey(resolve(directory, script)) !== pathKey(resolve(root, '.trellis/scripts/task.py'))) return []
  const action = words[index + 1]
  if (action === 'start') {
    const target = nativeTaskDir(root, words[index + 2] || '')
    return target ? [{ action, target }] : []
  }
  if (action === 'create' && !words.includes('--no-start')) return [{ action }]
  if (action === 'current' && words.includes('--json')) return [{ action }]
  return []
}

const blockSchema = z.array(z.object({ type: z.string(), text: z.string().optional() })).max(256)
const envelopeSchema = z.object({
  exit_code: z.number().optional(), output: z.string().optional(),
  metadata: z.object({ exit_code: z.number().optional() }).optional()
})
export function outputParts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  const parsed = blockSchema.safeParse(value)
  return parsed.success ? parsed.data.filter(block => block.type === 'input_text' || block.type === 'text').map(block => block.text || '') : []
}
export function failedOutput(part: string): boolean {
  let raw: unknown
  try { raw = JSON.parse(part) } catch { /* Plain result. */ }
  const parsed = envelopeSchema.safeParse(raw)
  const code = parsed.success ? parsed.data.exit_code ?? parsed.data.metadata?.exit_code : undefined
  return code !== undefined && code !== 0 || /(?:^|\n)(?:Error:|Traceback\b|Script failed\b|Process exited with code[: ]+[1-9]|Exit code:\s*[1-9])/i.test(part)
}
/** Decode documented result envelopes only; arbitrary nested text is never searched recursively. */
export function successfulOutputs(value: unknown, nativeSuccess = false, taskReceipt = false): string[] {
  return outputParts(value).flatMap(part => {
    let json: unknown
    try { json = JSON.parse(part) } catch { /* Plain native Bash/exec output. */ }
    const parsed = envelopeSchema.safeParse(json)
    if (parsed.success && parsed.data.output !== undefined) {
      return (parsed.data.exit_code ?? parsed.data.metadata?.exit_code) === 0 ? [parsed.data.output] : []
    }
    // Standard exec_command textual response, also used by the older Codex shell tool.
    const standard = part.match(/(?:^|\n)(?:Process exited with code|Exit code:)\s*0\r?\n(?:Final output:|Output:)\r?\n([\s\S]*)$/)
    if (standard) return [standard[1]]
    // Printing r.output loses the shell envelope. Only task-specific activation/current receipts
    // are considered later by commandEvidence, after exact native source + call correlation.
    if (taskReceipt && !failedOutput(part)) return [part]
    return nativeSuccess ? [part] : []
  })
}

const currentSchema = z.object({
  current_task: z.object({ dir: z.string().min(1).max(4096), id: z.string().min(1).max(256) }),
  source: z.string(), stale: z.literal(false), error: z.unknown().optional()
})
export function commandEvidence(root: string, commands: TaskCommand[], output: string, acceptsSource: (source: string) => boolean): { taskDir: string; trellisId: string | null }[] {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n')
  const result: { taskDir: string; trellisId: string | null }[] = []
  if (commands.some(command => command.action === 'current')) {
    // current --json is one explicit structured result, not JSON embedded in prose or file dumps.
    for (const line of text.split('\n')) {
      let raw: unknown
      try { raw = JSON.parse(line) } catch { continue }
      const parsed = currentSchema.safeParse(raw)
      if (!parsed.success || parsed.data.error !== undefined || !acceptsSource(parsed.data.source)) continue
      const taskDir = nativeTaskDir(root, parsed.data.current_task.dir)
      if (taskDir) result.push({ taskDir, trellisId: parsed.data.current_task.id })
    }
  }
  const activation = /^(Activated task for this session:|✓ Current task set to:) ([^\n]+)\nSource: (session:[^\n]+)\s*$/gm
  for (const match of text.matchAll(activation)) {
    const taskDir = nativeTaskDir(root, match[2])
    if (!taskDir || !acceptsSource(match[3].trim())) continue
    if (commands.some(command => match[1].startsWith('Activated') ? command.action === 'create' : command.action === 'start' && command.target === taskDir)) result.push({ taskDir, trellisId: null })
  }
  return result
}
