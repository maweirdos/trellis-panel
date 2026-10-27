import { constants, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import type { PiInitialize } from '../protocol'

export function isWithin(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

export function absoluteDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error('Pi directories must be absolute')
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error('Pi directory is not a directory')
  return canonical
}

const headerSchema = z.object({
  type: z.literal('session'), version: z.number().int().min(1).max(3).optional().default(1),
  id: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
  cwd: z.string().min(1), timestamp: z.string().refine(value => Number.isFinite(Date.parse(value)))
}).passthrough()
const entrySchema = z.object({ type: z.string().min(1) }).passthrough()
const treeEntrySchema = z.object({
  id: z.string().min(1), parentId: z.string().min(1).nullable(), timestamp: z.string().refine(value => Number.isFinite(Date.parse(value)))
}).passthrough()
const contentSchema = z.union([z.string(), z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal('toolCall'), id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).passthrough()
]))])
const usageSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(), cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }).passthrough() }).passthrough()
const messageSchema = z.object({ role: z.enum(['system', 'user', 'assistant', 'toolResult', 'custom', 'hookMessage', 'bashExecution']), timestamp: z.number() }).passthrough()
const payloadSchemas: Record<string, z.ZodType> = {
  thinking_level_change: z.object({ thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) }),
  model_change: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  usage: z.object({ kind: z.string(), provider: z.string(), model: z.string(), usage: usageSchema }),
  branch_summary: z.object({ fromId: z.string(), summary: z.string() }),
  custom: z.object({ customType: z.string() }),
  custom_message: z.object({ customType: z.string(), content: contentSchema, display: z.boolean() }),
  context_edit: z.object({ targetId: z.string().min(1), replacement: z.object({ content: contentSchema }).nullable() }),
  label: z.object({ targetId: z.string().min(1), label: z.string().optional() }),
  session_info: z.object({ name: z.string().optional() })
}

function validatePayload(entry: z.infer<typeof entrySchema>, version: number): void {
  if (entry.type === 'message') {
    const message = messageSchema.parse(entry.message)
    if (message.role === 'hookMessage' && version >= 3) throw new Error('Legacy message role in a v3 session')
    if (message.role === 'bashExecution') {
      z.object({ command: z.string(), output: z.string(), cancelled: z.boolean(), truncated: z.boolean(), exitCode: z.number().optional() }).parse(message)
      return
    }
    contentSchema.parse(message.content)
    if (message.role === 'assistant') {
      z.object({ content: z.array(z.unknown()), api: z.string(), model: z.string(), provider: z.string(), usage: usageSchema,
        stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']) }).parse(message)
    } else if (message.role === 'toolResult') {
      z.object({ toolCallId: z.string().min(1), toolName: z.string().min(1), isError: z.boolean() }).parse(message)
    } else if (message.role === 'custom' || message.role === 'hookMessage') {
      z.object({ customType: z.string(), display: z.boolean() }).parse(message)
    }
  } else if (entry.type === 'compaction') {
    z.object({ summary: z.string(), tokensBefore: z.number().nonnegative() }).parse(entry)
    if (version === 1 && entry.firstKeptEntryId === undefined) z.number().int().positive().parse(entry.firstKeptEntryIndex)
    else z.string().min(1).nullable().parse(entry.firstKeptEntryId)
  } else {
    const schema = Object.hasOwn(payloadSchemas, entry.type) ? payloadSchemas[entry.type] : undefined
    if (!schema) throw new Error('Unknown Pi session entry type')
    schema.parse(entry)
  }
}

/** Validate before open(): the SDK intentionally skips malformed JSONL on its own. */
export function openSession(input: PiInitialize): SessionManager {
  const sessionDir = absoluteDirectory(input.sessionDir)
  if (!input.sessionFile) return SessionManager.create(input.cwd, sessionDir)
  if (!isAbsolute(input.sessionFile)) throw new Error('Session file must be absolute')
  const file = realpathSync(input.sessionFile)
  if (!isWithin(sessionDir, file) || dirname(file) === file || !statSync(file).isFile()) {
    throw new Error('Session file is outside the supplied session directory')
  }
  if (statSync(file).size > 128 * 1024 * 1024) throw new Error('Session file exceeds 128 MiB')
  const bytes = readFileSync(file)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.endsWith('\n')) throw new Error('Pi session has an incomplete JSONL boundary; the original file is preserved')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!lines.length || lines.some(line => !line.trim())) throw new Error('Invalid session JSONL')
  const entries = lines.map(line => entrySchema.parse(JSON.parse(line)))
  const header = headerSchema.parse(entries[0])
  if (absoluteDirectory(header.cwd) !== input.cwd) throw new Error('Session cwd does not match the supplied cwd')
  const ids = new Set<string>()
  for (const entry of entries.slice(1)) {
    if (entry.type === 'session') throw new Error('Duplicate session header')
    if (header.version >= 2) {
      const tree = treeEntrySchema.parse(entry)
      if (ids.has(tree.id) || (tree.parentId !== null && !ids.has(tree.parentId))) {
        throw new Error('Invalid session entry ancestry')
      }
      ids.add(tree.id)
    }
    validatePayload(entry, header.version)
  }
  if (header.version < 3) {
    // COPYFILE_EXCL preserves the original snapshot when reopening the same old version.
    const backup = `${file}.v${header.version}.bak`
    try { copyFileSync(file, backup, constants.COPYFILE_EXCL) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (!readFileSync(backup).equals(bytes)) throw new Error('Existing migration backup differs from the session')
    }
  }
  if (!readFileSync(file).equals(bytes)) throw new Error('Session changed during resume validation')
  const manager = SessionManager.open(file, sessionDir)
  if (manager.getSessionId() !== header.id || manager.getHeader()?.version !== 3) {
    throw new Error('SDK did not restore the validated session')
  }
  return manager
}

export function prepareDirectories(input: PiInitialize): PiInitialize {
  const root = absoluteDirectory(input.root)
  const cwd = absoluteDirectory(input.cwd)
  if (!isWithin(root, cwd)) throw new Error('Pi cwd is outside the supplied project root')
  for (const path of [input.sessionDir, input.agentDir]) {
    if (!isAbsolute(path)) throw new Error('Pi directories must be absolute')
    mkdirSync(resolve(path), { recursive: true })
  }
  return { ...input, root, cwd, sessionDir: absoluteDirectory(input.sessionDir), agentDir: absoluteDirectory(input.agentDir) }
}
