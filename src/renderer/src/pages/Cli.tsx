import { useEffect, useRef, useState } from 'react'
import { Play, Square, Trash2, Info } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

const PRESETS: Array<{ label: string; args: string[]; hint: string }> = [
  { label: 'platforms --json', args: ['platforms', '--json'], hint: '查看已配置的 AI 平台' },
  { label: 'workflow --list', args: ['workflow', '--list'], hint: '列出可用工作流模板' },
  { label: '--version', args: ['--version'], hint: 'CLI 版本' },
  { label: 'update --help', args: ['update', '--help'], hint: '查看 update 用法' },
  { label: 'mem help', args: ['mem', 'help'], hint: 'AI 会话检索子命令' }
]

/** 执行历史（模块级：页面切换后仍保留） */
const history: string[] = []
let historyIdx = -1

export function CliPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const settings = useApp((s) => s.settings)
  const pushToast = useApp((s) => s.pushToast)
  const [input, setInput] = useState('')
  const [lines, setLines] = useState<Array<{ text: string; err: boolean }>>([])
  const [runningId, setRunningId] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const bufferRef = useRef<Array<{ text: string; err: boolean }>>([])
  const runningIdRef = useRef<number | null>(null)

  useEffect(() => {
    const offOut = api.onCliOutput(({ runId, stream, data }) => {
      if (runId !== runningIdRef.current) return
      const err = stream === 'stderr'
      bufferRef.current.push({ text: data.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), err })
    })
    const offDone = api.onCliDone(({ runId, code, aborted }) => {
      if (runId !== runningIdRef.current) return
      bufferRef.current.push({
        text: aborted ? '\n[已中止]' : `\n[退出码 ${code ?? '?'}]`,
        err: false
      })
      runningIdRef.current = null
      setRunningId(null)
    })
    return () => {
      offOut()
      offDone()
    }
  }, [])

  // Flush the buffer to state at ~10fps to keep long outputs smooth.
  useEffect(() => {
    const t = setInterval(() => {
      if (bufferRef.current.length > 0) {
        setLines((prev) => {
          const next = [...prev, ...bufferRef.current]
          bufferRef.current = []
          return next.length > 4000 ? next.slice(next.length - 4000) : next
        })
      }
    }, 100)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [lines])

  const run = async (args: string[]): Promise<void> => {
    if (runningIdRef.current !== null) return
    setLines((prev) => [...prev, { text: `$ ${settings?.cliCommand ?? 'trellis'} ${args.join(' ')}`, err: false }])
    const id = await api.runCli(args)
    if (id === -1) {
      // 未打开项目等场景：主进程拒绝执行，UI 不能卡在"运行中"
      pushToast({ kind: 'error', title: '命令未执行', body: '未打开项目或窗口不可用' })
      return
    }
    runningIdRef.current = id
    setRunningId(id)
  }

  const submit = (): void => {
    const raw = input.trim()
    if (!raw) return
    setInput('')
    history.unshift(raw)
    history.splice(20)
    historyIdx = -1
    // split respecting simple quotes
    const args = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [raw]
    void run(args)
  }

  const historyNav = (dir: 1 | -1): void => {
    if (history.length === 0) return
    let idx = historyIdx + dir
    if (idx < -1) idx = -1
    if (idx >= history.length) idx = history.length - 1
    historyIdx = idx
    setInput(idx === -1 ? '' : history[idx])
  }

  const abort = async (): Promise<void> => {
    if (runningIdRef.current !== null) await api.abortCli(runningIdRef.current)
  }

  const clear = (): void => {
    if (runningIdRef.current === null) setLines([])
  }

  return (
    <div className="flex h-full animate-fade-in flex-col p-5">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-base font-semibold text-mist-50">CLI 终端</h1>
        <span className="chip bg-ink-750 font-mono text-mist-400">{settings?.cliCommand ?? 'trellis'}</span>
        <span className="text-[11px] text-mist-500">工作目录：{snapshot.meta.name}</span>
        <div className="ml-auto flex gap-1.5">
          {runningId !== null ? (
            <button onClick={() => void abort()} className="btn bg-rose-500/15 text-rose-300 hover:bg-rose-500/25">
              <Square size={12} /> 停止
            </button>
          ) : (
            <button onClick={clear} className="btn-ghost">
              <Trash2 size={12} /> 清空
            </button>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Info size={12} className="text-mist-500" />
        <span className="text-[11px] text-mist-500">快捷命令：</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            disabled={runningId !== null}
            title={p.hint}
            onClick={() => void run(p.args)}
            className="chip border border-ink-500 font-mono text-mist-300 transition-colors hover:border-leaf-dim/50 hover:text-leaf-soft disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              historyNav(-1)
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              historyNav(1)
            }
          }}
          disabled={runningId !== null}
          placeholder="输入 trellis 命令参数（↑/↓ 翻历史；交互式命令请加 -y / --yes）"
          className="field flex-1 font-mono"
        />
        <button onClick={submit} disabled={runningId !== null} className="btn-primary disabled:opacity-50">
          <Play size={13} /> 运行
        </button>
      </div>

      <div
        ref={boxRef}
        className="mt-3 flex-1 overflow-auto rounded-xl border border-ink-700 bg-ink-950 p-3.5 font-mono text-[11.5px] leading-[1.55]"
      >
        {lines.length === 0 && (
          <div className="text-mist-600">
            输出会显示在这里。注意：交互式命令（如不带参数的 init）会挂起，请使用 -y 等非交互参数。
          </div>
        )}
        {lines.map((l, i) => (
          <span key={i} className={clsx('whitespace-pre-wrap break-words', l.err ? 'text-rose-300/90' : 'text-mist-300')}>
            {l.text}
          </span>
        ))}
      </div>
    </div>
  )
}
