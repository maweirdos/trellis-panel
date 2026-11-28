import type { JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '../../../../ui'

export const JIRA_SYNC_STEPS = ['项目', '状态', '成员', '选项', '确认'] as const
export function JiraFlowHeader({ step, onBack }: { step: number; onBack: () => void }): JSX.Element {
  return <div className="space-y-5">
    <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={14} />返回 Jira</Button>
    <h2 className="text-my-xl font-medium">新建项目同步</h2>
    <ol aria-label="同步设置步骤" className="flex flex-wrap gap-x-5 gap-y-2 border-b border-my-line pb-4 tabular-nums">{JIRA_SYNC_STEPS.map((label, index) => <li key={label} aria-current={index + 1 === step ? 'step' : undefined} className={`flex items-center gap-2 text-my-sm ${index + 1 === step ? 'font-medium text-my-primary' : 'text-my-tertiary'}`}><span className="text-my-xs">{index + 1}</span>{label}</li>)}</ol>
  </div>
}
