// 新建工作项弹窗：项目下拉 + 名称（回车提交）+ 优先级 + 描述；创建后关闭并打开 peek。
// 创建合同：普通创建固定生成 planning 状态的 task.json（Trellis 生命周期收归工作流），
// 不提供状态选择，避免“创建即改状态”的假通道。
import { useState, type JSX } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { useMy } from '../../store'
import { Button, Dropdown, DropdownItem, Modal } from '../../ui'
import { WorkspaceMark, PriorityIcon } from '../../icons'
import type { Priority } from '../../types'

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  none: '无'
}

/** 属性触发框（弹窗内） */
const BOX =
  'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-my-md border border-my-line bg-my-layer-2 px-2 text-my-sm text-my-secondary hover:border-my-line-strong'

function CreateIssueForm(): JSX.Element {
  const store = useMy()
  const { data, createIssue, setCreateIssueOpen, openIssue } = store
  const defaultProject = data.projects[0]
  const [name, setName] = useState('')
  const [priority, setPriority] = useState<Priority>('none')
  const [description, setDescription] = useState('')

  const submit = (): void => {
    const n = name.trim()
    if (!n) return
    void createIssue({ name: n, priority, description: description.trim() }).then((id) => {
      if (!id) return
      setCreateIssueOpen(false)
      openIssue(id)
    })
  }

  return (
    <Modal open onClose={() => setCreateIssueOpen(false)} width={560}>
      <div className="flex flex-col">
        {/* 标题行 */}
        <div className="flex h-my-header shrink-0 items-center justify-between border-b border-my-line px-4">
          <span className="text-my-lg font-semibold text-my-primary">新建工作项</span>
          <button
            type="button"
            title="关闭"
            onClick={() => setCreateIssueOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
          >
            <X size={15} />
          </button>
        </div>
        {/* 表单 */}
        <div className="flex flex-col gap-3 px-4 py-4">
          <div>
            <div className="mb-1 text-my-xs font-medium text-my-tertiary">项目</div>
            <Dropdown
              width={280}
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle} className={BOX}>
                  <WorkspaceMark color={defaultProject.color} letter={defaultProject.icon} size={16} />
                  <span className="min-w-0 flex-1 truncate text-left">{defaultProject.name}</span>
                  <ChevronDown size={12} className="shrink-0 text-my-icon-tertiary" />
                </button>
              )}
            >
              {(close) => (
                <DropdownItem selected icon={<WorkspaceMark color={defaultProject.color} letter={defaultProject.icon} size={14} />} onClick={close}>
                  {defaultProject.name}
                </DropdownItem>
              )}
            </Dropdown>
          </div>
          <div>
            <div className="mb-1 text-my-xs font-medium text-my-tertiary">名称</div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="工作项名称"
              className="my-input"
            />
          </div>
          <div>
            <div className="mb-1 text-my-xs font-medium text-my-tertiary">优先级</div>
            <Dropdown
              width={180}
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle} className={BOX}>
                  <PriorityIcon priority={priority} size={13} />
                  <span className="min-w-0 flex-1 truncate text-left">{PRIORITY_LABELS[priority]}</span>
                  <ChevronDown size={12} className="shrink-0 text-my-icon-tertiary" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {PRIORITIES.map((pr) => (
                    <DropdownItem
                      key={pr}
                      selected={pr === priority}
                      icon={<PriorityIcon priority={pr} size={13} />}
                      onClick={() => {
                        setPriority(pr)
                        close()
                      }}
                    >
                      {PRIORITY_LABELS[pr]}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>
            <div className="mt-1 text-my-xs text-my-tertiary">新任务固定为「规划中」，进入开发请用 task.py start。</div>
          </div>
          <div>
            <div className="mb-1 text-my-xs font-medium text-my-tertiary">描述</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="添加描述…"
              className="min-h-[90px] w-full resize-none rounded-my-md border border-my-line bg-my-layer-2 p-2 text-my-md leading-5 text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
            />
          </div>
        </div>
        {/* 底部操作 */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-my-line px-4 py-3">
          <Button variant="neutral" onClick={() => setCreateIssueOpen(false)}>
            取消
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            创建
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** 创建弹窗入口：未打开时不渲染（卸载态，重新打开即重置表单） */
export function CreateIssueModal(): JSX.Element | null {
  const open = useMy((s) => s.createIssueOpen)
  if (!open) return null
  return <CreateIssueForm />
}
