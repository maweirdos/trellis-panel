import type { JSX } from 'react'
import { ListChecks, MessageSquarePlus, Plus, Trash2 } from 'lucide-react'
import type { CreationScenario } from '@shared/creations'
import { Button } from '../my/ui'

export function ScenarioEditor({ scenarios, editable, onChange, onAnnotate }: {
  scenarios: CreationScenario[]
  editable: boolean
  onChange: (scenarios: CreationScenario[]) => void
  onAnnotate?: (scenarioId: string) => void
}): JSX.Element {
  const update = (id: string, patch: Partial<CreationScenario>): void => onChange(scenarios.map((scenario) => scenario.id === id ? { ...scenario, ...patch } : scenario))
  return <section className="creation-scenarios" aria-label="交互场景">
    <div className="creation-section-heading"><h2><ListChecks size={16} />交互场景 <span className="creation-meta">{scenarios.length}</span></h2>
      {editable && <Button size="sm" variant="ghost" disabled={scenarios.length >= 40} onClick={() => onChange([...scenarios, { id: crypto.randomUUID(), title: '', preconditions: [], steps: [''], expectedResult: '' }])}><Plus size={14} />添加场景</Button>}
    </div>
    {scenarios.length === 0 && <p className="creation-meta">暂无场景</p>}
    {scenarios.map((scenario, index) => <article className="creation-scenario" key={scenario.id}>
      <div className="creation-row"><span className="creation-meta">{index + 1}</span>
        {editable ? <input className="my-input creation-grow" aria-label={`场景 ${index + 1} 标题`} placeholder="场景标题" value={scenario.title} maxLength={200} onChange={(event) => update(scenario.id, { title: event.target.value })} /> : <h3 className="creation-grow">{scenario.title}</h3>}
        {editable ? <Button size="sm" variant="ghost" aria-label={`移除场景 ${index + 1}`} onClick={() => onChange(scenarios.filter((entry) => entry.id !== scenario.id))}><Trash2 size={14} /></Button>
          : onAnnotate && <Button size="sm" variant="ghost" aria-label={`批注场景 ${index + 1}`} onClick={() => onAnnotate(scenario.id)}><MessageSquarePlus size={14} /></Button>}
      </div>
      {editable ? <div className="creation-form-grid">
        <label>前置条件<textarea className="my-input" value={scenario.preconditions.join('\n')} rows={2} placeholder="每行一项" onChange={(event) => update(scenario.id, { preconditions: event.target.value.split('\n') })} /></label>
        <label>操作步骤<textarea className="my-input" value={scenario.steps.join('\n')} rows={3} placeholder="每行一步" onChange={(event) => update(scenario.id, { steps: event.target.value.split('\n') })} /></label>
        <label>预期结果<textarea className="my-input" value={scenario.expectedResult} maxLength={2000} rows={2} onChange={(event) => update(scenario.id, { expectedResult: event.target.value })} /></label>
      </div> : <dl className="creation-scenario-details">
        {scenario.preconditions.length > 0 && <><dt>前置条件</dt><dd>{scenario.preconditions.join('；')}</dd></>}
        <dt>步骤</dt><dd><ol>{scenario.steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ol></dd>
        <dt>预期结果</dt><dd>{scenario.expectedResult}</dd>
      </dl>}
    </article>)}
  </section>
}
