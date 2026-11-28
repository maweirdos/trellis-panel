// 新建工作项弹窗：项目下拉 + 名称（回车提交）+ 优先级 + 描述；创建后关闭并打开 peek。
// 创建合同：普通创建固定生成 planning 状态的 task.json（Trellis 生命周期收归工作流），
// 不提供状态选择，避免“创建即改状态”的假通道。
import { useRef, useState, type JSX } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { useMy } from '../../store'
import { Button, Dropdown, DropdownItem, Modal, Tooltip } from '../../ui'
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
  'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-my-base border border-my-line bg-my-layer-2 px-2 text-my-sm text-my-secondary transition-colors duration-100 hover:border-my-line-strong'

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

  const submitButton = (
    <Button variant="primary" disabled={!name.trim()} onClick={submit}>
      创建
    </Button>
  )

  return (
    <div className="flex flex-col">
      {/* 标题行 */}
      <div className="flex shrink-0 items-center justify-between border-b border-my-line px-6 pt-5 pb-3">
        <span className="text-my-md font-medium text-my-primary">新建工作项</span>
        <button
          type="button"
          title="关闭"
          aria-label="关闭新建工作项弹窗"
          onClick={() => setCreateIssueOpen(false)}
          className="my-icon-control"
        >
          <X size={15} />
        </button>
      </div>
      {/* 表单 */}
      <div className="flex flex-col gap-3 px-6 py-4">
        <div>
          <div className="my-item-title mb-1">项目</div>
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
          <div className="my-item-title mb-1">名称</div>
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
          <div className="my-item-title mb-1">优先级</div>
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
          <div className="my-item-description mt-1">新任务固定为「规划中」，进入开发请用 task.py start。</div>
        </div>
        <div>
          <div className="my-item-title mb-1">描述</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="添加描述…"
            className="my-input min-h-[90px] resize-none p-2 text-my-md leading-5"
          />
        </div>
      </div>
      {/* 底部操作 */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-my-line px-6 py-4">
        <Button variant="neutral" onClick={() => setCreateIssueOpen(false)}>
          取消
        </Button>
        {!name.trim() ? <Tooltip label="请输入工作项名称">{submitButton}</Tooltip> : submitButton}
      </div>
    </div>
  )
}

/** 创建弹窗入口：保持 Modal 挂载以承载 115ms 关闭退场，仅在打开瞬间刷新表单会话。 */
export function CreateIssueModal(): JSX.Element {
  const open = useMy((s) => s.createIssueOpen)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const prevOpen = useRef(false)
  const session = useRef(0)
  if (open && !prevOpen.current) session.current += 1
  prevOpen.current = open
  return (
    <Modal open={open} onClose={() => setCreateIssueOpen(false)} width={560} placement="center" ariaLabel="新建工作项">
      {open && <CreateIssueForm key={session.current} />}
    </Modal>
  )
}
