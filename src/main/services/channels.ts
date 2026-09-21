import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { errorText } from '../../shared/errors'
import { join } from 'path'
import { spawn } from 'child_process'
import type { ChannelEvent, ChannelSummary } from '../../shared/types'

/**
 * Trellis channel runtime reader.
 * Storage: ~/.trellis/channels/<project-slug>/<channel>/events.jsonl
 * Events are JSONL: {kind, by, text?, seq, ts}
 */

function channelsRoot(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return join(home, '.trellis', 'channels')
}

/** Project bucket slug as computed by trellis CLI: each of : \ / _ -> '-' (no collapsing). */
export function projectBucket(root: string): string {
  return root.replace(/[:\\/_]/g, '-')
}

function parseEvents(file: string, max = 80): ChannelEvent[] {
  try {
    const lines = readFileSync(file, 'utf-8').trim().split(/\r?\n/).filter(Boolean)
    return lines.slice(-max).map((l) => {
      const o = JSON.parse(l)
      return {
        kind: String(o.kind ?? 'event'),
        by: String(o.by ?? '?'),
        text: o.text ? String(o.text) : undefined,
        seq: Number(o.seq ?? 0),
        ts: String(o.ts ?? ''),
        thread: o.thread ? String(o.thread) : o.threadId ? String(o.threadId) : undefined,
        title: o.title ? String(o.title) : undefined,
        status: o.status ? String(o.status) : undefined
      }
    })
  } catch {
    return []
  }
}

export function listChannels(projectRoot: string): { ok: boolean; error?: string; channels?: ChannelSummary[] } {
  const base = channelsRoot()
  if (!existsSync(base)) return { ok: true, channels: [] }
  const out: ChannelSummary[] = []
  const own = projectBucket(projectRoot)
  try {
    const buckets = readdirSync(base)
    for (const bucket of buckets) {
      const bucketDir = join(base, bucket)
      let names: string[] = []
      try {
        names = readdirSync(bucketDir)
      } catch {
        continue
      }
      for (const name of names) {
        const eventsFile = join(bucketDir, name, 'events.jsonl')
        if (!existsSync(eventsFile)) continue
        const events = parseEvents(eventsFile)
        if (events.length === 0) continue
        const createEv = events.find((e) => e.kind === 'create')
        // prefer channels of this project bucket, but show others too (scoped label)
        const participants = [...new Set(events.map((e) => e.by))]
        const last = events[events.length - 1]
        let mtime = 0
        try {
          mtime = statSync(eventsFile).mtimeMs
        } catch {
          // ignore
        }
        out.push({
          name,
          bucket,
          scope: bucket === own ? 'project' : 'global',
          type: (createEv as unknown as { type?: string })?.type ?? 'chat',
          eventCount: events.length,
          lastEventAt: last?.ts ?? new Date(mtime).toISOString(),
          lastKind: last?.kind ?? null,
          participants,
          events: events.slice(-40).reverse()
        })
      }
    }
    out.sort((a, b) => {
      const ownA = a.bucket === own ? 0 : 1
      const ownB = b.bucket === own ? 0 : 1
      if (ownA !== ownB) return ownA - ownB
      return (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '')
    })
    return { ok: true, channels: out }
  } catch (e) {
    return { ok: false, error: errorText(e, '读取 channels 失败') }
  }
}

/** Send a message into a channel via the trellis CLI (as agent "panel-ui"). */
export function channelSend(projectRoot: string, cliCommand: string, name: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(`${cliCommand} channel send ${name} --as panel-ui ${JSON.stringify(text)}`, {
      cwd: projectRoot,
      shell: true,
      windowsHide: true
    })
    let err = ''
    const timer = setTimeout(() => child.kill(), 20_000)
    child.stderr?.on('data', (d) => (err += d.toString('utf-8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true } : { ok: false, error: err || `退出码 ${code}` })
    })
  })
}

/**
 * Run a trellis channel action (create/spawn/wait/interrupt/kill/rm …) and
 * capture its output. Long-running actions (spawn/wait) simply hit the
 * timeout — the channel keeps working on the CLI side, events stay in the
 * JSONL log for the panel to display.
 */
export function channelAction(
  projectRoot: string,
  cliCommand: string,
  args: string[],
  timeoutMs = 120_000
): Promise<{ ok: boolean; error?: string; output?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cliCommand, ['channel', ...args], {
      cwd: projectRoot,
      shell: process.platform === 'win32',
      windowsHide: true
    })
    let out = ''
    let err = ''
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      const text = (out + (err ? `\n${err}` : '')).trim()
      resolve({
        ok: code === 0 || code === null,
        error: code === 0 || code === null ? undefined : text.slice(-400) || `退出码 ${code}`,
        output: text.slice(-4000)
      })
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve({ ok: true, output: (out + (err ? `\n${err}` : '')).trim().slice(-4000) || '（超时截断——动作已在后台继续）' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += d.toString('utf-8')))
    child.stderr?.on('data', (d) => (err += d.toString('utf-8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      done = true
      resolve({ ok: false, error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code)
    })
  })
}
