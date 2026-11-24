import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { protectDirectory } from '../../daemon/native'
import { createAcpJobOwner, type AcpJobOwner } from '../workcopy-use/acp-jobs'

let pendingCleanup: (() => Promise<void>) | undefined

export async function runSpeechJob(
  node: string, worker: string, model: string, pcm: Float32Array, signal: AbortSignal,
): Promise<string> {
  if (pendingCleanup) await pendingCleanup()
  signal.throwIfAborted()
  const root = await realpath(dirname(model))
  const parent = await realpath(join(app.getPath('userData'), 'speech'))
  const directory = await mkdtemp(join(parent, 'job-'))
  const removeJournal = async (): Promise<void> => {
    const entry = await lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return
    const actual = await realpath(directory)
    const child = relative(parent, actual)
    if (child === basename(directory) && /^job-[\w-]+$/.test(child) && isAbsolute(actual)) {
      await rm(actual, { recursive: true, force: true })
    }
  }
  let job: AcpJobOwner
  const sessionKey = randomUUID()
  try {
    await protectDirectory(directory)
    signal.throwIfAborted()
    job = await createAcpJobOwner(directory, root, { kind: 'agent', id: sessionKey, generation: randomUUID(), label: 'Crux 本地语音' })
  } catch (error) {
    await removeJournal().catch(() => {})
    throw error
  }
  const cleanup = async (): Promise<void> => {
    await job.cleanupAll()
    if (pendingCleanup === cleanup) pendingCleanup = undefined
    await removeJournal().catch(() => {})
  }
  pendingCleanup = cleanup
  try {
    signal.throwIfAborted()
    const launch = {
      launchId: randomUUID(), purpose: 'agent' as const,
      scope: { kind: 'runtime-session' as const, sessionKey },
      command: node, args: [worker, model], cwd: root,
    }
    const child = job.spawn(launch, {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP, TMP: process.env.TMP,
        PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : undefined,
        TRANSCRIBE_BACKENDS: 'cpu',
      },
    })
    let resolve!: (value: string) => void
    let reject!: (error: unknown) => void
    const completion = new Promise<string>((accept, refuse) => { resolve = accept; reject = refuse })
    void completion.catch(() => {})
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 512 * 1024) reject(new Error('Speech response exceeds its size limit'))
      else chunks.push(chunk)
    })
    child.stderr?.resume()
    child.stdin?.on('error', reject)
    child.stdout?.on('error', reject)
    child.stderr?.on('error', reject)
    child.once('error', reject)
    child.once('close', code => {
      try {
        if (code !== 0) throw new Error('Speech worker failed')
        const reply: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true ||
          !('text' in reply) || typeof reply.text !== 'string' || reply.text.length > 120_000) throw new Error('Invalid speech response')
        resolve(reply.text)
      } catch (error) { reject(error) }
    })
    try {
      if (!child.pid) throw new Error('Speech worker did not spawn')
      await job.spawned({ ...launch, pid: child.pid, startedAt: new Date().toISOString() })
      signal.throwIfAborted()
      child.stdin?.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      return await completion
    } finally {
      signal.removeEventListener('abort', abort)
    }
  } finally {
    await cleanup()
  }
}
