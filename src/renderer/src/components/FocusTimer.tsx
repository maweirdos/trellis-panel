import { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { api } from '../api'
import type { TaskInfo } from '../../../shared/types'
import type { JSX } from 'react'

/**
 * 专注计时：按任务累计专注分钟，停止时写入 task.json meta.focusMinutes。
 */
export function FocusTimer({ task }: { task: TaskInfo }): JSX.Element {
  const [running, setRunning] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const baseMinutes = Number(task.record?.meta?.focusMinutes ?? 0) || 0

  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [running])

  const stop = async (): Promise<void> => {
    setRunning(false)
    if (timerRef.current) clearInterval(timerRef.current)
    const mins = Math.round(seconds / 60)
    if (mins > 0) {
      const meta = { ...(task.record?.meta ?? {}), focusMinutes: baseMinutes + mins }
      await api.updateTask(task.path, { meta } as never)
    }
    setSeconds(0)
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  const showTotal = baseMinutes > 0 || seconds > 0

  return (
    <div className="flex items-center gap-1.5">
      {showTotal && (
        <span className={clsxChip(running)} title="本次 / 累计专注（分钟）">
          {mm}:{ss}
          {baseMinutes > 0 ? ` · ${baseMinutes}m` : ''}
        </span>
      )}
      {running ? (
        <button onClick={() => void stop()} className="btn-ghost justify-center px-1.5" title="停止并记录">
          <Square size={11} />
        </button>
      ) : (
        <button onClick={() => setRunning(true)} className="btn-ghost justify-center px-1.5" title="开始专注计时">
          <Play size={11} />
        </button>
      )}
    </div>
  )
}

function clsxChip(running: boolean): string {
  return `chip font-mono text-[10px] ${running ? 'bg-leaf-dim/20 text-leaf-soft' : 'bg-ink-750 text-mist-400'}`
}
