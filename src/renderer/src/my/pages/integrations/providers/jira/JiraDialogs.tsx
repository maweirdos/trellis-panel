import { useRef, useState, type JSX } from 'react'
import type { IntegrationSource } from '@shared/integration-work'
import { JIRA_LIMITS, type JiraData, type JiraIntegrationApi, type JiraMapping } from '@shared/jira-integration'
import { Button, Checkbox, Modal } from '../../../../ui'
import { useIntegrationAction } from '../../hooks'
import { JiraMappingFields } from './JiraMappingFields'
import { useJiraReads } from './use-jira-reads'
import { jiraImportSettled, type JiraImportSubmissions } from './use-jira-import-submissions'

type Scope = { expectedRoot: string; workspaceId: string }
const defaultColumns = { issueId: 'Issue id', key: 'Issue key', title: 'Summary', description: 'Description', priority: '', status: '', assignee: '', labels: '', type: '', updated: '' }
const columnLabels: Record<keyof typeof defaultColumns, string> = { issueId: 'Issue 数字 ID', key: 'Issue key', title: '标题', description: '描述', priority: '优先级', status: '状态', assignee: '负责人', labels: '标签', type: '类型', updated: '更新时间' }

export function JiraImportDialog({ api, scope, source, metadata, mapping, submissions, canUseSource = true, onClose, onCheckHistory, onReconcile, reconciliationBusy = false, onNewImport, onStarted }: {
  api: JiraIntegrationApi; scope: Scope; source: IntegrationSource; metadata: JiraData<'discover'> | null; mapping: JiraMapping; submissions: JiraImportSubmissions; canUseSource?: boolean; onClose: () => void; onCheckHistory: () => void; onReconcile?: () => void; reconciliationBusy?: boolean; onNewImport: () => void; onStarted: () => void
}): JSX.Element {
  const submission = submissions.get(scope, source)
  const preview = submission?.preview ?? null
  const submitting = submission?.state === 'pending'
  const uncertain = submission?.state === 'unknown'
  const retained = Boolean(submission && submission.state !== 'previewed')
  const [stage, setStage] = useState<'source' | 'mapping'>('source')
  const [format, setFormat] = useState<'api' | 'csv'>(preview?.format ?? 'api')
  const [jql, setJql] = useState('')
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')
  const [columns, setColumns] = useState(defaultColumns)
  const [map, setMap] = useState(preview?.mapping ?? mapping)
  const [includeHistory, setIncludeHistory] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState('')
  const [mappingValid, setMappingValid] = useState(true)
  const fileRead = useRef(0)
  const action = useIntegrationAction(`${scope.expectedRoot}:${source.bindingId}:${source.bindingRevision}:${source.connectionRevision}`)
  const read = useJiraReads(api, scope)
  const inspect = (): void => {
    if (retained || !canUseSource) return
    setError('')
    void action.run(() => read((requestId) => format === 'api' ? api.previewApi({ ...scope, source, requestId, jql, mapping: map, includeHistory, maxItems: 50 }) : api.previewCsv({ ...scope, source, requestId, csv, columns, mapping: map, includeHistory: false }))).then((data) => { if (data && submissions.prepare(scope, source, data)) setAcknowledged(false) })
  }
  const submit = (): void => {
    if (!preview || retained || !canUseSource || !acknowledged) return
    void submissions.submit(scope, source, acknowledged).then((job) => { if (job && action.current()) onStarted() })
  }
  const close = (): void => { if (retained) onCheckHistory(); else onClose() }
  return <Modal open ariaLabel="导入 Jira Issue" onClose={close}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col">
      <div className="shrink-0 space-y-2 border-b border-my-line p-5"><h2 className="text-my-lg font-semibold">导入 Issue 数据</h2><p className="text-my-xs text-my-tertiary">{preview ? '3 / 3 · 预览与确认' : stage === 'mapping' ? '2 / 3 · 字段映射' : '1 / 3 · 选择数据'}</p></div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 my-scrollbar" style={{ scrollbarGutter: 'stable' }}>
        {!preview && stage === 'source' && <>
          <fieldset disabled={action.busy} className="space-y-2"><legend className="my-item-title mb-2">导入方式</legend><div className="my-segmented integration-auth-methods">{(['api', 'csv'] as const).map((option) => <button key={option} type="button" aria-pressed={format === option} className={`my-segment ${format === option ? 'is-active' : ''}`} onClick={() => { setFormat(option); setError('') }}>{option === 'api' ? '从 Jira 导入' : 'CSV 文件'}</button>)}</div></fieldset>
          {format === 'api' ? <><p className="text-my-sm text-my-secondary">导入选定项目的 Issue，提交前核对预览。</p><details className="space-y-3 text-my-sm"><summary className="cursor-pointer">筛选与历史</summary><label className="block space-y-2"><span className="my-item-title">JQL 筛选条件</span><textarea className="my-input w-full" value={jql} onChange={(event) => setJql(event.target.value)} placeholder="留空导入所选项目；不含 ORDER BY" /></label><label className="flex items-start gap-2"><Checkbox checked={includeHistory} onChange={setIncludeHistory} />读取可用的评论和历史证据</label><p className="text-my-xs text-my-tertiary">Server 8.1 的部分历史会明确标注。</p></details></> : <>
            <label className="block space-y-3"><span className="my-item-title">CSV 文件</span><input type="file" accept=".csv,text/csv" disabled={action.busy} onChange={(event) => {
              const file = event.target.files?.[0]
              const ticket = ++fileRead.current
              setCsv(''); setFilename(''); setError('')
              if (!file) return
              if (file.size > JIRA_LIMITS.csvBytes) { setError('CSV 超过容量限制'); return }
              void file.text().then((text) => { if (ticket === fileRead.current && action.current()) { setCsv(text); setFilename(file.name) } }).catch(() => { if (ticket === fileRead.current && action.current()) setError('无法读取此 CSV 文件。') })
            }} /><span className="my-item-description block">UTF-8 · 最多 {JIRA_LIMITS.csvBytes / 1024} KiB / 500 行{filename ? ` · ${filename}` : ''}</span></label>
            <details className="space-y-4 text-my-sm"><summary className="cursor-pointer">CSV 列对应关系</summary><p className="text-my-xs text-my-tertiary">数字 Issue ID、Issue key 和标题必填，列名需与表头一致。</p><div className="grid gap-3 sm:grid-cols-2">{(Object.keys(columns) as Array<keyof typeof columns>).map((column) => <label key={column} className="block space-y-2"><span className="my-item-title">{columnLabels[column]}{['issueId', 'key', 'title'].includes(column) ? ' *' : ''}</span><input className="my-input w-full" value={columns[column]} onChange={(event) => setColumns({ ...columns, [column]: event.target.value })} /></label>)}</div></details>
          </>}
        </>}<div hidden={Boolean(preview) || stage !== 'mapping'} className="space-y-4"><p className="my-item-description">默认导入标题与描述，可按需调整其他字段。</p><JiraMappingFields value={map} onChange={setMap} metadata={metadata} disabled={action.busy} onValidityChange={setMappingValid} showTransitions={false} /></div>{preview && <>
          <p className="text-my-sm font-medium">预览 {preview.count} 条 · 来源总量 {preview.total ?? '未知'}</p><p className="text-my-sm text-my-secondary">{preview.scope === 'full-query' ? '将逐页导入整个选定查询；此处仅展示预览样本。' : '将导入此 CSV 文件的所有记录。'}</p>
          {preview.sample.map((issue) => <div key={issue.issueId} className="border-t border-my-line pt-3 text-my-sm"><span className="text-my-tertiary">{issue.key}</span><span className="ml-3">{issue.fields.title}</span></div>)}
          {preview.warnings.map((warning, index) => <p key={index} className="break-words text-my-xs text-my-warning-text">{warning}</p>)}
          <details className="text-my-xs text-my-tertiary"><summary className="cursor-pointer">查询与预览范围</summary><p className="mt-2 break-words">{preview.query}</p><p className="mt-2">{preview.complete ? '预览范围读取完成' : '预览仅覆盖部分范围'} · 有效至 {new Date(preview.expiresAt).toLocaleString()}</p></details>
          {!retained && <label className="flex items-start gap-2 text-my-sm"><Checkbox checked={acknowledged} onChange={setAcknowledged} />已核对实例、项目、字段映射与覆盖说明</label>}
          {retained && submission && <div className="space-y-3 rounded-my-md border border-my-line p-3"><p className="text-my-sm font-medium">{submitting ? '原提交正在等待回复' : uncertain ? '原提交结果待核实' : '已找到原提交作业'}</p><p className="break-all text-my-xs text-my-secondary">提交标识：{submission.commandId}</p>{submission.job && <p className="break-all text-my-xs text-my-secondary">原作业：{submission.job.id} · {submission.job.state}</p>}<p className="text-my-xs text-my-tertiary">{uncertain ? '返回历史核实原作业。未读到记录或读取失败，均不能证明没有执行。' : '关闭和重开此窗口保留原提交；不会重新提交。'}</p></div>}
        </>}
        {(error || action.error || submission?.detail) && <p role="alert" className="break-words text-my-sm text-my-danger-text">{error || action.error || submission?.detail}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-my-line p-4">{retained && submission?.job?.state === 'unknown' && onReconcile && <Button disabled={reconciliationBusy} onClick={onReconcile}>核实原作业</Button>}<Button onClick={close}>{retained ? '返回历史核实' : '取消'}</Button>{retained ? submission && jiraImportSettled(submission) && <Button disabled={!canUseSource} onClick={() => { if (submissions.discard(scope, source)) onNewImport() }}>新建另一笔导入</Button> : preview ? <><Button disabled={action.busy || !canUseSource} onClick={() => { if (submissions.discard(scope, source)) setAcknowledged(false) }}>上一步</Button><Button variant="primary" disabled={action.busy || !acknowledged || !canUseSource} onClick={submit}>开始导入</Button></> : stage === 'source' ? <Button variant="primary" disabled={action.busy || !canUseSource || format === 'csv' && !csv} onClick={() => setStage('mapping')}>下一步</Button> : <><Button disabled={action.busy} onClick={() => setStage('source')}>上一步</Button><Button variant="primary" disabled={action.busy || !mappingValid || !canUseSource} onClick={inspect}>{action.busy ? '正在预览…' : '验证并预览'}</Button></>}</div>
    </div>
  </Modal>
}
