import { useEffect, useRef, useState, type JSX } from 'react'
import { parse } from 'csv-parse/browser/esm/sync'
import { X } from 'lucide-react'
import type { ConversationFile } from '@shared/private-conversations'
import { Button } from '../my/ui'
import './conversation-table-preview.css'

const MAX_ROWS = 100
const MAX_COLUMNS = 20
const MAX_CELL_LENGTH = 2000

type Table = { rows: string[][]; columns: number; rowsTruncated: boolean; columnsTruncated: boolean; cellsTruncated: boolean }
type State = { kind: 'loading' } | { kind: 'ready'; table: Table } | { kind: 'read-error' | 'source-changed' | 'parse-error'; message: string }

function parseTable(body: string, delimiter: string): Table {
  let count = 0, columns = 0, columnsTruncated = false, cellsTruncated = false
  const rows = parse(body, {
    delimiter, bom: true, relax_column_count: true,
    on_record: (record: string[]) => {
      count += 1
      if (record.length > MAX_COLUMNS) columnsTruncated = true
      if (count > MAX_ROWS) return null
      columns = Math.max(columns, Math.min(record.length, MAX_COLUMNS))
      return record.slice(0, MAX_COLUMNS).map(cell => {
        if (cell.length <= MAX_CELL_LENGTH) return cell
        cellsTruncated = true
        return `${cell.slice(0, MAX_CELL_LENGTH)}…`
      })
    }
  })
  return { rows, columns, rowsTruncated: count > MAX_ROWS, columnsTruncated, cellsTruncated }
}

/** Reads only after the user opens this panel; the caller validates the original source. */
export function ConversationTablePreview({ file, load, onClose }: {
  file: ConversationFile; load: (current: () => boolean) => Promise<string>; onClose: () => void
}): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    heading.current?.focus()
  }, [])

  useEffect(() => {
    let current = true
    setState({ kind: 'loading' })
    void (async () => {
      let body: string
      try {
        body = await loadRef.current(() => current)
      } catch (cause) {
        if (!current) return
        const message = cause instanceof Error ? cause.message : '无法读取所选文件。'
        setState({ kind: /来源|已变化|已修改|已归档|已移除/.test(message) ? 'source-changed' : 'read-error', message })
        return
      }
      if (!current) return
      try {
        const table = parseTable(body, /\.tsv$/i.test(file.name) ? '\t' : ',')
        if (current) setState({ kind: 'ready', table })
      } catch {
        if (current) setState({ kind: 'parse-error', message: '文件不是有效的 CSV 或 TSV，无法解析。' })
      }
    })()
    return () => { current = false }
  }, [file.id, file.name, file.revision, file.sourceIdentity, attempt])

  const close = (): void => {
    onClose()
    if (opener.current?.isConnected) opener.current.focus()
  }
  return <section className="conversation-table-preview" aria-labelledby="conversation-table-preview-heading">
    <div className="flex flex-wrap items-center gap-2">
      <h2 ref={heading} id="conversation-table-preview-heading" tabIndex={-1} className="my-item-title min-w-0 flex-1 break-all">{file.name}</h2>
      <Button size="sm" variant="ghost" onClick={close} aria-label="关闭表格预览"><X size={14} />关闭</Button>
    </div>
    <p className="my-item-description">只读预览 · UTF-8 · 不计算公式</p>
    {state.kind === 'loading' && <p className="my-item-description" role="status">正在读取表格…</p>}
    {(state.kind === 'read-error' || state.kind === 'source-changed' || state.kind === 'parse-error') && <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text">
      <span>{state.kind === 'source-changed' ? '来源已变化：' : state.kind === 'read-error' ? '读取失败：' : '解析失败：'}{state.message}</span>
      <Button size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button>
    </div>}
    {state.kind === 'ready' && <>
      {(state.table.rowsTruncated || state.table.columnsTruncated || state.table.cellsTruncated) && <p className="my-item-description" role="status">
        预览已截断：{[state.table.rowsTruncated && `仅显示前 ${MAX_ROWS} 行`, state.table.columnsTruncated && `仅显示前 ${MAX_COLUMNS} 列`, state.table.cellsTruncated && `单元格最多显示 ${MAX_CELL_LENGTH} 个字符`].filter(Boolean).join('；')}。
      </p>}
      {state.table.rows.length === 0 ? <p className="my-item-description">表格为空。</p> : <div className="conversation-table-scroll my-scrollbar" tabIndex={0} role="region" aria-label="表格内容，可滚动">
        <table><caption className="sr-only">{file.name} 的只读表格预览</caption><thead><tr><th scope="col">行</th>{Array.from({ length: state.table.columns }, (_, column) => <th key={column} scope="col">{column + 1}</th>)}</tr></thead>
          <tbody>{state.table.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>{Array.from({ length: state.table.columns }, (_, column) => <td key={column}>{row[column] ?? ''}</td>)}</tr>)}</tbody>
        </table>
      </div>}
    </>}
  </section>
}
