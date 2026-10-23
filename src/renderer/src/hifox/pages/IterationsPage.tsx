/**
 * 迭代：时间窗口内交付一组任务；结束时未完成项顺延（回 Backlog 或进下一迭代）（PRD 3.6）。
 */
import { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { api } from '../../api'
import { useHifox, statusOf } from '../store'
import { PageHeader, Field, inputClass, StatusBadge } from '../ui'
import { Button, EmptyState, Modal } from '../../my/ui'
import type { HifoxIteration } from '@shared/hifox'

function nextWeekRange(): { start: string; end: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const start = new Date()
  start.setDate(start.getDate() + (1 + 7 - start.getDay()) % 7 || 7)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return { start: fmt(start), end: fmt(end) }
}

export function IterationsPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const openTask = useHifox((s) => s.openTask)
  const setModule = useHifox((s) => s.setModule)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [range, setRange] = useState(nextWeekRange)
  const [confirmEnd, setConfirmEnd] = useState<HifoxIteration | null>(null)
  const [carryOver, setCarryOver] = useState<'backlog' | 'next'>('next')

  const iterations = snapshot.iterations
    .filter((it) => it.spaceId === currentSpaceId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))

  const submit = async (): Promise<void> => {
    if (!currentSpaceId) return
    const result = await run('创建迭代', () => api.hifox.createIteration({
      spaceId: currentSpaceId, name: name.trim(), goal: goal.trim() || undefined, startDate: range.start, endDate: range.end
    }))
    if (result?.ok) { setName(''); setGoal(''); setRange(nextWeekRange()); setCreateOpen(false) }
  }

  const endIteration = async (): Promise<void> => {
    if (!confirmEnd) return
    const result = await run('结束迭代', () => api.hifox.completeIteration({ id: confirmEnd.id, carryOver }))
    if (result?.ok) setConfirmEnd(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="迭代"
        description="把这一轮要交付的任务放进同一时间窗口；结束时未完成任务自动顺延"
        actions={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新建迭代</Button>}
      />
      {iterations.length === 0
        ? <EmptyState title="暂无迭代" description="创建第一个迭代，圈定本轮交付范围" />
        : (
          <div className="my-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {iterations.map((iteration) => {
              const tasks = iteration.taskIds
                .map((id) => snapshot.tasks.find((t) => t.id === id))
                .filter((t): t is NonNullable<typeof t> => Boolean(t))
              const done = tasks.filter((t) => ['done', 'cancelled'].includes(statusOf(snapshot, t.statusId)?.category ?? '')).length
              const percent = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)
              return (
                <section key={iteration.id} className="rounded-my-md border border-my-line bg-my-layer/40 p-3">
                  <header className="mb-2 flex flex-wrap items-center gap-2">
                    <ChevronRight size={14} className={`text-my-tertiary transition-transform ${iteration.status === 'active' ? 'rotate-90 text-emerald-500' : ''}`} />
                    <h2 className="text-sm font-medium text-my-primary">{iteration.name}</h2>
                    <span className={`rounded-my-sm px-1.5 py-0.5 text-[10px] ${iteration.status === 'active' ? 'bg-emerald-500/15 text-emerald-500' : iteration.status === 'pending' ? 'bg-sky-500/15 text-sky-400' : 'bg-my-layer text-my-tertiary'}`}>
                      {iteration.status === 'active' ? '进行中' : iteration.status === 'pending' ? '待开始' : '已结束'}
                    </span>
                    <span className="text-my-xs text-my-tertiary">{iteration.startDate} ~ {iteration.endDate}</span>
                    {iteration.goal && <span className="min-w-0 flex-1 truncate text-my-xs text-my-tertiary">· {iteration.goal}</span>}
                    <span className="ml-auto text-my-xs text-my-tertiary">{done}/{tasks.length} 完成</span>
                  </header>
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-my-layer-active">
                    <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${percent}%` }} />
                  </div>
                  <ul className="flex flex-wrap gap-1.5">
                    {tasks.map((task) => (
                      <li key={task.id}>
                        <button type="button" onClick={() => { openTask(task.id); setModule('tasks') }}
                          className="flex items-center gap-1.5 rounded-my-sm border border-my-line bg-my-canvas px-1.5 py-1 text-[11px] text-my-secondary hover:border-my-brand/50">
                          <span className="font-mono text-[10px] text-my-tertiary">{task.id}</span>
                          <span className="max-w-40 truncate">{task.title}</span>
                          <StatusBadge status={statusOf(snapshot, task.statusId)} />
                        </button>
                      </li>
                    ))}
                    {tasks.length === 0 && <li className="text-my-xs text-my-tertiary">迭代内暂无任务；在任务详情中可将任务排入本迭代</li>}
                  </ul>
                  {iteration.status !== 'completed' && (
                    <div className="mt-2 flex justify-end gap-1.5">
                      {iteration.status === 'pending' && (
                        <Button variant="ghost" size="sm" onClick={() => void run('开始迭代', () => api.hifox.updateIteration({ id: iteration.id, status: 'active' }))}>开始</Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => { setConfirmEnd(iteration); setCarryOver('next') }}>结束迭代…</Button>
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} width={440} ariaLabel="新建迭代">
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-semibold text-my-primary">新建迭代</h2>
          <Field label="名称">
            <input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：迭代 44（下下周）" />
          </Field>
          <Field label="目标（可选）">
            <input className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="本轮要交付什么" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="开始日期">
              <input type="date" className={inputClass} value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
            </Field>
            <Field label="结束日期">
              <input type="date" className={inputClass} value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" disabled={!name.trim() || range.end < range.start} onClick={() => void submit()}>创建</Button>
          </div>
        </div>
      </Modal>
      <Modal open={confirmEnd !== null} onClose={() => setConfirmEnd(null)} width={420} ariaLabel="结束迭代">
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-semibold text-my-primary">结束「{confirmEnd?.name}」</h2>
          <p className="text-my-xs leading-relaxed text-my-tertiary">未完成任务（Done/Cancelled 之外）将按下面的方式顺延。</p>
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" onClick={() => setCarryOver('next')}
              className={`rounded-my-md border px-2.5 py-2 text-left ${carryOver === 'next' ? 'border-indigo-400/60 bg-indigo-500/10' : 'border-my-line hover:bg-my-layer'}`}>
              <p className="text-my-xs font-medium text-my-primary">顺延到下一迭代</p>
              <p className="text-[10px] text-my-tertiary">没有待开始迭代时自动创建一个</p>
            </button>
            <button type="button" onClick={() => setCarryOver('backlog')}
              className={`rounded-my-md border px-2.5 py-2 text-left ${carryOver === 'backlog' ? 'border-indigo-400/60 bg-indigo-500/10' : 'border-my-line hover:bg-my-layer'}`}>
              <p className="text-my-xs font-medium text-my-primary">退回 Backlog</p>
              <p className="text-[10px] text-my-tertiary">从迭代移出，状态置为 Backlog</p>
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmEnd(null)}>取消</Button>
            <Button variant="primary" size="sm" onClick={() => void endIteration()}>确认结束</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

