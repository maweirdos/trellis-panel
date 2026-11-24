import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, renameSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { managedNodePath, resolveNodeRuntime } from '../acp/managed-node'
import { findExecutable } from '../acp/setup'
import { runSpeechJob } from './windows-job'

const MODEL = {
  id: 'handy-computer/whisper-tiny-gguf',
  revision: '6687f30c99641ee265df421e582354adbc8848fc',
  filename: 'whisper-tiny-Q8_0.gguf',
  bytes: 45_981_088,
  sha256: '325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834',
}

const modelPath = (): string => join(app.getPath('userData'), 'speech', 'models', MODEL.filename)
const speechResources = (): string => join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'speech')
const workerPath = (): string => join(speechResources(), 'worker.mjs')

export function speechRuntimeAvailable(): boolean {
  if (process.platform !== 'win32' || process.arch !== 'x64') return false
  const modules = app.isPackaged ? join(speechResources(), 'node_modules') : join(app.getAppPath(), 'node_modules')
  return [workerPath(), join(modules, 'transcribe-cpp', 'dist', 'index.js'),
    join(modules, '@transcribe-cpp', 'win32-x64-cpu-vulkan', 'transcribe.dll'),
    join(modules, 'koffi', 'package.json'),
    join(modules, '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'),
  ].every(file => statSync(file, { throwIfNoEntry: false })?.isFile() === true)
}

export function speechModelPresent(): boolean {
  const entry = statSync(modelPath(), { throwIfNoEntry: false })
  return entry?.isFile() === true && entry.size === MODEL.bytes
}

async function hashModel(stream: AsyncIterable<Uint8Array>, signal: AbortSignal, destination?: string): Promise<boolean> {
  const hash = createHash('sha256')
  let bytes = 0
  const append = (chunk: Uint8Array): void => {
    signal.throwIfAborted()
    bytes += chunk.length
    if (bytes > MODEL.bytes) throw new Error('Invalid speech model size')
    hash.update(chunk)
  }
  if (destination) {
    await pipeline(stream, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try { append(chunk); callback(null, chunk) }
        catch (error) { callback(error instanceof Error ? error : new Error('Invalid speech model')) }
      },
    }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
  } else {
    for await (const chunk of stream) append(chunk)
  }
  return bytes === MODEL.bytes && hash.digest('hex') === MODEL.sha256
}

function localModel(source: string, signal: AbortSignal): AsyncIterable<Uint8Array> | undefined {
  const entry = statSync(source, { throwIfNoEntry: false })
  if (!entry?.isFile() || entry.size !== MODEL.bytes) return undefined
  return createReadStream(source, { signal, end: MODEL.bytes })
}

async function installModel(source: AsyncIterable<Uint8Array>, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean> {
  const target = modelPath()
  const temporary = `${target}.${randomUUID()}.part`
  await mkdir(dirname(target), { recursive: true })
  try {
    if (!await hashModel(source, signal, temporary)) return false
    signal.throwIfAborted()
    if (!isCurrent()) return false
    renameSync(temporary, target)
    return true
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function importSpeechModel(source: string, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean> {
  const stream = localModel(source, signal)
  return stream ? installModel(stream, signal, isCurrent) : false
}

export async function downloadSpeechModel(signal: AbortSignal, isCurrent: () => boolean): Promise<boolean> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  let url = new URL(`https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/${MODEL.filename}`)
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(url, { signal: deadline, redirect: 'manual', credentials: 'omit' })
    if (response.status === 200 && response.body) {
      const contentLength = response.headers.get('content-length')
      if (contentLength === null || Number(contentLength) === MODEL.bytes) {
        return installModel(response.body, deadline, isCurrent)
      }
    }
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return false
    url = new URL(location, url)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        (url.hostname !== 'huggingface.co' && !url.hostname.endsWith('.hf.co'))) return false
  }
  return false
}

export class SpeechModelMissingError extends Error {}

export async function transcribeSpeech(pcm: Float32Array, signal: AbortSignal): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  const model = modelPath()
  const stream = localModel(model, deadline)
  if (!stream || !await hashModel(stream, deadline)) throw new SpeechModelMissingError()
  const node = app.isPackaged
    ? await managedNodePath(process.resourcesPath)
    : (await resolveNodeRuntime({ pathNode: findExecutable('node.exe') })).path
  if (!node) throw new Error('Speech Node runtime is unavailable')
  deadline.throwIfAborted()
  return runSpeechJob(node, workerPath(), model, pcm, deadline)
}
