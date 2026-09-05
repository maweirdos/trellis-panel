import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, User, NotebookPen, FileText } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { fmtBytes, relTime } from '../utils/format'
import type { JSX } from 'react'
import type { JournalFile } from '../../../shared/types'

export function WorkspacePage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const { developers, sharedWorkspaceFiles } = snapshot
  const [openDev, setOpenDev] = useState<string | null>(developers[0]?.name ?? null)
  const [file, setFile] = useState<JournalFile | null>(null)
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: false })

  useEffect(() => {
    if (!developers.length) return
    if (!developers.some((d) => d.name === openDev)) setOpenDev(developers[0].name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.meta.root])

  const load = (f: JournalFile): void => {
    setFile(f)
    setState({ loading: true })
    api.readTextFile(f.path).then((res) => {
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    })
  }

  return (
    <div className="flex h-full animate-fade-in">
      <div className="w-80 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-850/40 p-3">
        <div className="px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist-500">
          .trellis/workspace
        </div>

        {developers.length === 0 && (
          <div className="px-1 py-6 text-[11px] text-mist-500">尚无开发者工作区</div>
        )}

        {developers.map((dev) => {
          const open = openDev === dev.name
          const all = [...dev.journals, ...dev.otherFiles]
          return (
            <div key={dev.name} className="mb-1.5">
              <button
                onClick={() => setOpenDev(open ? null : dev.name)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                  open ? 'bg-ink-750/70' : 'hover:bg-ink-700/40'
                )}
              >
                {open ? <ChevronDown size={13} className="text-mist-500" /> : <ChevronRight size={13} className="text-mist-500" />}
                <span className="grid h-6 w-6 place-items-center rounded-full bg-leaf-deep/60 text-leaf">
                  <User size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-mist-100">{dev.name}</span>
                  <span className="block text-[10px] text-mist-500">
                    {dev.journals.length} 篇日志 · {dev.lastActive ? relTime(dev.lastActive) : '无记录'}
                  </span>
                </span>
              </button>
              {open && (
                <div className="mt-0.5 space-y-0.5 pl-4">
                  {all.length === 0 && <div className="px-2 py-1.5 text-[11px] text-mist-500">空工作区</div>}
                  {all.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => load(f)}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[11.5px] transition-colors',
                        file?.path === f.path
                          ? 'bg-leaf-dim/15 text-leaf-soft'
                          : 'text-mist-300 hover:bg-ink-700/40 hover:text-mist-100'
                      )}
                    >
                      {dev.journals.some((j) => j.path === f.path) ? (
                        <NotebookPen size={12} className="shrink-0 text-mist-500" />
                      ) : (
                        <FileText size={12} className="shrink-0 text-mist-500" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="shrink-0 text-[10px] text-mist-500">{fmtBytes(f.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {sharedWorkspaceFiles.length > 0 && (
          <>
            <div className="mt-4 px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist-500">
              共享索引
            </div>
            {sharedWorkspaceFiles.map((f) => (
              <button
                key={f.path}
                onClick={() => load(f)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[11.5px] transition-colors',
                  file?.path === f.path
                    ? 'bg-leaf-dim/15 text-leaf-soft'
                    : 'text-mist-300 hover:bg-ink-700/40 hover:text-mist-100'
                )}
              >
                <FileText size={12} className="shrink-0 text-mist-500" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {file ? (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-700 bg-ink-900/90 px-5 py-2.5 backdrop-blur">
              <NotebookPen size={13} className="text-leaf" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-300">{file.name}</span>
              <span className="text-[10.5px] text-mist-500">{relTime(file.mtime)}</span>
            </div>
            <div className="mx-auto max-w-3xl px-6 py-5">
              {state.loading && <div className="text-xs text-mist-500">加载中…</div>}
              {state.error && <div className="text-xs text-rose-300">{state.error}</div>}
              {!state.loading && !state.error && <MarkdownView content={state.content ?? ''} />}
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center text-xs text-mist-500">
            选择左侧日志文件查看开发记录
          </div>
        )}
      </div>
    </div>
  )
}
