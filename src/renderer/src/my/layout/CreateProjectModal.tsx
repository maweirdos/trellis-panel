// 新建项目弹窗（演示：仅内存新增，回到项目列表可见）。
import { useState, type JSX } from 'react'
import { useMy } from '../store'
import { Button, Modal } from '../ui'

const COLORS = ['#006399', '#7e22ce', '#c2410c', '#15803d', '#b91c1c', '#0f766e', '#a16207']

export function CreateProjectModal(): JSX.Element {
  const open = useMy((s) => s.createProjectOpen)
  const setOpen = useMy((s) => s.setCreateProjectOpen)
  const navigateProject = useMy((s) => s.navigateProject)
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0])

  const create = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    const ds = useMy.getState().data
    const id = `p-new-${Date.now()}`
    useMy.setState({
      data: {
        ...ds,
        projects: [
          ...ds.projects,
          {
            id,
            name: trimmed,
            icon: trimmed.slice(0, 1),
            color,
            description: '',
            cycleEnabled: true,
            moduleEnabled: true,
            pagesEnabled: true,
            intakeEnabled: true,
            memberIds: ['me'],
            leadId: 'me',
            favorite: false,
            createdAt: new Date().toISOString().slice(0, 10)
          }
        ]
      }
    })
    setName('')
    setOpen(false)
    navigateProject(id)
  }

  return (
    <Modal open={open} onClose={() => setOpen(false)} width={440}>
      <div className="flex items-center justify-between border-b border-my-line px-4 py-3">
        <span className="text-[13px] font-semibold text-my-primary">新建项目</span>
        <button type="button" onClick={() => setOpen(false)} className="text-my-icon-tertiary hover:text-my-secondary">
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-my-secondary">项目名称</span>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            placeholder="例如：小程序端"
            className="my-input"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-my-secondary">图标颜色</span>
          <div className="flex gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                style={{ background: c }}
                className={`h-5 w-5 rounded-md ${color === c ? 'ring-2 ring-offset-1 ring-my-line-strong ring-offset-p-layer-2' : ''}`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-my-line px-4 py-3">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
        <Button variant="primary" onClick={create} disabled={!name.trim()}>
          创建项目
        </Button>
      </div>
    </Modal>
  )
}
