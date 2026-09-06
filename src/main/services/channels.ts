import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
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

/** Project bucket slug as computed by trellis CLI: each separator char -> '-' (no collapsing). */
export function projectBucket(root: string): string {
  return root.replace(/[:\\/]/g, '-')
}

function parseEvents(file: string, max = 80): ChannelEvent[] {
  try {
    const lines = readFileSync(file, 'utf-8').trim().split(/\r?\n/).filter(Boolean)
    return lines.slice(-max).map((l) => {
      const o = JSON.parse(l)
      return { kind: String(o.kind ?? 'event'), by: String(o.by ?? '?'), text: o.text ? String(o.text) : undefined, seq: Number(o.seq ?? 0), ts: String(o.ts ?? '') }
    })
  } catch {
    return []
  }
}

export function listChannels(projectRoot: string): { ok: boolean; error?: string; channels?: ChannelSummary[] } {
  const base = channelsRoot()
  if (!existsSync(base)) return { ok: true, channels: [] }
  const out: ChannelSummary[] = []
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
          type: (createEv as unknown as { type?: string })?.type ?? 'chat',
          eventCount: events.length,
          lastEventAt: last?.ts ?? new Date(mtime).toISOString(),
          lastKind: last?.kind ?? null,
          participants,
          events: events.slice(-40).reverse()
        })
      }
    }
    const own = projectBucket(projectRoot)
    out.sort((a, b) => {
      const ownA = a.bucket === own ? 0 : 1
      const ownB = b.bucket === own ? 0 : 1
      if (ownA !== ownB) return ownA - ownB
      return (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '')
    })
    return { ok: true, channels: out }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '读取 channels 失败' }
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
