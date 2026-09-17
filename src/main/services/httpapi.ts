import { createServer, type Server } from 'http'
import type { ProjectSnapshot } from '../../shared/types'

/**
 * Local HTTP surface for the panel:
 *   GET  / | /board   read-only web board (auto-refresh, shareable on LAN)
 */

let server: Server | null = null
let actualPort: number | null = null

type SnapshotGetter = () => ProjectSnapshot | null
let getSnap: SnapshotGetter = () => null

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ---------------- Web board ---------------- */

function renderBoard(snap: ProjectSnapshot): string {
  const cols: Array<{ key: string; label: string; color: string }> = [
    { key: 'planning', label: '规划中', color: '#38bdf8' },
    { key: 'in_progress', label: '进行中', color: '#fbbf24' },
    { key: 'review', label: '评审中', color: '#a78bfa' },
    { key: 'completed', label: '已完成', color: '#34d399' }
  ]
  const match = (t: ProjectSnapshot['tasks'][number], key: string): boolean =>
    t.record?.status === key || (key === 'completed' && t.record?.status === 'done')

  const colsHtml = cols
    .map((c) => {
      const items = snap.tasks.filter((t) => match(t, c.key))
      const cards = items
        .map(
          (t) => `<div class="card">
            <div class="row"><span class="pri">${esc(t.record?.priority ?? '')}</span><span class="date">${esc(t.dirName.slice(0, 5))}</span>${t.jiraKey ? `<span class="jira">${esc(t.jiraKey)}</span>` : ''}</div>
            <div class="title">${esc(t.record?.title ?? t.dirName)}</div>
            <div class="row"><span class="assignee">${esc(t.record?.assignee || '未分配')}</span><span class="branch">${esc(t.record?.branch ?? '')}</span></div>
          </div>`
        )
        .join('')
      return `<div class="col"><div class="col-head"><span class="dot" style="background:${c.color}"></span>${c.label}<span class="count">${items.length}</span></div>${cards || '<div class="empty">—</div>'}</div>`
    })
    .join('')

  const platforms = snap.meta.platforms.filter((p) => p.detected).map((p) => p.name).join(' · ')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>Trellis Panel — ${esc(snap.meta.name)}（只读看板）</title>
<style>
  body{margin:0;background:#0f1115;color:#e6eaf2;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:13px}
  header{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid #202633;background:#12151c}
  h1{font-size:15px;margin:0} .meta{color:#6b7691;font-size:11px}
  .board{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:16px 20px}
  .col{background:#12151c;border:1px solid #202633;border-radius:12px;min-height:60vh}
  .col-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #202633;font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%}
  .count{margin-left:auto;background:#1a1f2a;border-radius:6px;padding:0 7px;font-family:Consolas,monospace;font-size:11px;color:#9aa5bd}
  .card{margin:8px;padding:10px;border:1px solid #202633;border-radius:8px;background:#161a22}
  .title{margin:6px 0;line-height:1.5}
  .row{display:flex;gap:8px;align-items:center;color:#6b7691;font-size:11px}
  .pri{border:1px solid #2a3242;border-radius:5px;padding:0 5px;font-family:Consolas,monospace;color:#c9d1e0}
  .jira{border:1px solid #3b82f655;background:#3b82f622;color:#93c5fd;border-radius:5px;padding:0 5px;font-family:Consolas,monospace}
  .empty{text-align:center;color:#3a4356;padding:30px 0}
  .assignee{margin-right:auto}
  .branch{font-family:Consolas,monospace}
</style></head><body>
<header><h1>🍃 Trellis Panel — ${esc(snap.meta.name)} <span class="meta">只读看板 · 每 30 秒刷新</span></h1>
<span class="meta">Trellis ${esc(snap.meta.version ?? '')} · 开发者 ${esc(snap.meta.developer ?? '—')}${platforms ? ` · ${esc(platforms)}` : ''}</span></header>
<div class="board">${colsHtml}</div></body></html>`
}

/* ---------------- server lifecycle ---------------- */

export function startHttpApi(
  port: number,
  lanAccess: boolean,
  snapshotGetter: SnapshotGetter
): Promise<{ ok: boolean; error?: string; port?: number }> {
  return new Promise((resolve) => {
    stopHttpApi()
    getSnap = snapshotGetter
    server = createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]
      try {
        if (req.method === 'GET' && (url === '/' || url === '/board')) {
          const snap = getSnap()
          if (!snap) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body style="background:#0f1115;color:#6b7691;font-family:sans-serif"><p>面板未打开项目。</p></body></html>')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderBoard(snap))
          return
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e?.message ?? e) }))
      }
    })
    server.once('error', (e: NodeJS.ErrnoException) => {
      server = null
      actualPort = null
      resolve({ ok: false, error: e.code === 'EADDRINUSE' ? `端口 ${port} 被占用` : e.message })
    })
    server.listen(port, lanAccess ? undefined : '127.0.0.1', () => {
      actualPort = port
      resolve({ ok: true, port })
    })
  })
}

export function stopHttpApi(): void {
  if (server) {
    server.close()
    server = null
    actualPort = null
  }
}

export function httpApiStatus(): { running: boolean; port: number | null } {
  return { running: server !== null, port: actualPort }
}
