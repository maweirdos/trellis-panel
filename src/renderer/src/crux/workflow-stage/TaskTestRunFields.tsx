import type { JSX } from 'react'
import type { TaskDelivery, TaskTestRunInput } from '@shared/task-delivery'
import { Select } from '../../components/Select'
import { Field, textareaClass } from '../ui'

type Result = TaskTestRunInput['results'][number]['steps'][number]
type Outcome = Result['outcome']
export type TestRunDraft = Record<string, Pick<Result, 'outcome' | 'actualResult'>>
const outcomes = { passed: '通过', failed: '失败', blocked: '受阻', skipped: '跳过' } satisfies Record<Outcome, string>
const stepKey = (caseId: string, stepId: string): string => JSON.stringify([caseId, stepId])

export function buildTaskTestRun(delivery: TaskDelivery, summary: string, draft: TestRunDraft): TaskTestRunInput | null {
  if (!delivery.environment || !delivery.testPackage || !summary.trim()) return null
  const results = delivery.testPackage.cases.map(testCase => ({
    caseId: testCase.id,
    steps: testCase.steps.flatMap(step => {
      const recorded = draft[stepKey(testCase.id, step.id)]
      return recorded?.actualResult.trim() ? [{ stepId: step.id, ...recorded, actualResult: recorded.actualResult.trim(), evidence: [] }] : []
    }),
  }))
  if (results.some((item, index) => item.steps.length !== delivery.testPackage!.cases[index].steps.length)) return null
  return { deliveryId: delivery.id, baselineId: delivery.baselineId, environment: delivery.environment, summary: summary.trim(), results }
}

export function TaskTestRunFields({ delivery, value, onChange }: {
  delivery: TaskDelivery
  value: TestRunDraft
  onChange: (next: TestRunDraft) => void
}): JSX.Element {
  return <div className="min-w-0 space-y-3">
    <p className="my-item-description break-words">交付 v{delivery.number} · 部署版本 {delivery.environment?.deployedRevision}</p>
    {delivery.testPackage?.cases.map(testCase => <section key={testCase.id} className="space-y-2">
      <h3 className="my-item-title">{testCase.title}</h3>
      {testCase.steps.map(step => {
        const key = stepKey(testCase.id, step.id)
        const current = value[key]
        return <div key={step.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="my-item-title min-w-0 flex-1">{step.instruction}</span>
            <Select aria-label={`${step.instruction}的结果`} value={current?.outcome ?? ''} options={[
              { value: '', label: '选择结果', disabled: true },
              ...Object.entries(outcomes).map(([id, label]) => ({ value: id, label })),
            ]} onChange={outcome => {
              if (Object.hasOwn(outcomes, outcome)) onChange({ ...value, [key]: { outcome: outcome as Outcome, actualResult: current?.actualResult ?? '' } })
            }} />
          </div>
          <p className="my-item-description">预期结果 {step.expectedResult}</p>
          {current && <Field label="实际结果"><textarea className={textareaClass} maxLength={4000} rows={2}
            value={current.actualResult} onChange={event => onChange({ ...value, [key]: { ...current, actualResult: event.target.value } })} /></Field>}
        </div>
      })}
    </section>)}
  </div>
}
