import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { NativeHistoryFile, NativeRuntimeAlias, NativeTaskEvidence } from '../types'
import type { TaskConversationSource } from '../../../../shared/task-conversations'
import { ownedPath, pathKey } from './paths'
import { HistoryParser } from './history-parser'
import { JsonLineStream, ZcodeJsonStream } from './history-stream'

// Each list advances a bounded slice and yields between 64 KiB reads. No full-history rescan.
export const HISTORY_LIMITS = { files: 128, fileBytes: 512 * 1024 * 1024, passBytes: 8 * 1024 * 1024,
  filePassBytes: 2 * 1024 * 1024, passLines: 32768, chunkBytes: 64 * 1024 } as const
type Progress = { bytesRead: number; totalBytes: number; scannedBytes: number; files: number; completedFiles: number }
type Result = { evidence: NativeTaskEvidence[]; runtimeAliases: NativeRuntimeAlias[]; indexing: boolean; limited: Set<TaskConversationSource>; progress: Progress }
type State = {
  offset: number; size: number; mtime: number; signature: string; parser: HistoryParser
  stream: JsonLineStream | ZcodeJsonStream; failed: boolean
}

/** Per-reader memory only. Cached data contains task facts and bounded incomplete records, no durable transcript. */
export class NativeHistoryScanner {
  private readonly states = new Map<string, State>()
  private rootKey = ''
  private cursor = 0
  async scan(root: string, descriptors: NativeHistoryFile[]): Promise<Result> {
    if (this.rootKey !== pathKey(root)) { this.states.clear(); this.rootKey = pathKey(root); this.cursor = 0 }
    const result: Result = { evidence: [], runtimeAliases: [], indexing: false, limited: new Set(),
      progress: { bytesRead: 0, totalBytes: 0, scannedBytes: 0, files: 0, completedFiles: 0 } }
    for (const descriptor of descriptors.slice(HISTORY_LIMITS.files)) result.limited.add(descriptor.conversation.source)
    const files = descriptors.slice(0, HISTORY_LIMITS.files)
    const active = new Set(files.map(descriptor => this.key(descriptor)))
    for (const key of this.states.keys()) if (!active.has(key)) this.states.delete(key)
    let lines = 0
    for (let n = 0; n < files.length; n++) {
      const index = (n + this.cursor) % files.length, descriptor = files[index], key = this.key(descriptor)
      let state = this.states.get(key)
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const file = ownedPath(descriptor.sourceRoot, isAbsolute(descriptor.file) ? descriptor.file : resolve(descriptor.sourceRoot, descriptor.file))
        handle = await open(file, 'r')
        const info = await handle.stat()
        if (!info.isFile() || info.size > HISTORY_LIMITS.fileBytes) throw new Error('history-file-limit')
        const signature = `${info.dev}:${info.ino}:${info.birthtimeMs}`
        if (!state || signature !== state.signature || info.size < state.offset
          || descriptor.conversation.source === 'zcode' && (info.size !== state.size || info.mtimeMs !== state.mtime)
          || info.size === state.size && info.mtimeMs !== state.mtime) {
          const parser = new HistoryParser(root, descriptor)
          state = { offset: 0, size: info.size, mtime: info.mtimeMs, signature, parser, failed: false,
            stream: descriptor.conversation.source === 'zcode' ? new ZcodeJsonStream((kind, value) => parser.zcode(kind, value)) : new JsonLineStream(value => parser.line(value)) }
          this.states.set(key, state)
        }
        state.size = info.size; state.mtime = info.mtimeMs
        let remaining = HISTORY_LIMITS.filePassBytes as number
        while (!state.failed && state.offset < info.size && remaining > 0 && result.progress.bytesRead < HISTORY_LIMITS.passBytes && lines < HISTORY_LIMITS.passLines) {
          const size = Math.min(HISTORY_LIMITS.chunkBytes, remaining, info.size - state.offset, HISTORY_LIMITS.passBytes - result.progress.bytesRead)
          const buffer = Buffer.alloc(size)
          const { bytesRead } = await handle.read(buffer, 0, size, state.offset)
          if (!bytesRead) { state.failed = true; break }
          let take = bytesRead
          for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10 && ++lines >= HISTORY_LIMITS.passLines) { take = i + 1; break }
          state.stream.feed(buffer.subarray(0, take))
          state.offset += take; remaining -= take; result.progress.bytesRead += take
          await setImmediate()
        }
        if (state.offset === info.size && state.stream instanceof JsonLineStream) state.stream.eof()
        if (state.failed || state.parser.limited || state.stream.limited) result.limited.add(descriptor.conversation.source)
        result.progress.totalBytes += info.size
        result.progress.scannedBytes += state.offset
        result.progress.files++
        if (state.offset === info.size || state.failed) result.progress.completedFiles++
        else result.indexing = true
        result.evidence.push(...state.parser.evidence())
        result.runtimeAliases.push(...state.parser.aliases())
      } catch {
        // Unreadable/skipped files must not keep a visible page polling forever.
        result.limited.add(descriptor.conversation.source)
        this.states.delete(key)
      } finally { await handle?.close() }
    }
    this.cursor = files.length ? (this.cursor + 1) % files.length : 0
    return result
  }
  private key(descriptor: NativeHistoryFile): string {
    return JSON.stringify([descriptor.conversation.source, descriptor.conversation.sessionId, pathKey(descriptor.conversation.cwd), descriptor.file, descriptor.providerId])
  }
}
