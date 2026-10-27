import { useEffect, useRef, useState, type JSX } from 'react'
import { api, hasIpc } from '../../api'
import { useApp } from '../../store'
import { Button } from '../../my/ui'
import { PreferenceRow, PreferenceSection } from './PreferenceSection'

export function EngineToolSettings(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const root = useApp((state) => state.snapshot?.meta.root)
  const saveSettings = useApp((state) => state.saveSettings)
  const [cli, setCli] = useState(settings?.cliCommand ?? 'trellis')
  const [model, setModel] = useState(settings?.dispatch?.codexModel ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const live = useRef(false)
  const lock = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const run = async (task: () => Promise<string>): Promise<void> => {
    if (!hasIpc || !live.current || lock.current) return
    lock.current = true; setBusy(true); setMessage(null)
    try {
      const text = await task()
      if (live.current) setMessage({ error: false, text })
    } catch (error) {
      if (live.current) setMessage({ error: true, text: error instanceof Error ? error.message : String(error) })
    } finally { lock.current = false; if (live.current) setBusy(false) }
  }
  return <PreferenceSection id="engine-project-access" title="高级">
    <details className="preference-disclosure">
      <summary>命令与项目接入</summary>
      <PreferenceRow label="Trellis 命令" htmlFor="engine-trellis-command">
        <input id="engine-trellis-command" className="my-input font-mono" value={cli} disabled={busy} onChange={(event) => setCli(event.target.value)} />
      </PreferenceRow>
      <PreferenceRow label="Codex 派单模型" htmlFor="engine-dispatch-model" hint="留空使用 CLI 默认模型。">
        <input id="engine-dispatch-model" className="my-input font-mono" value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} />
      </PreferenceRow>
      <div className="preference-actions"><Button size="sm" variant="primary" disabled={busy || !hasIpc} onClick={() => void run(async () => {
        await saveSettings({ cliCommand: cli.trim() || 'trellis', dispatch: { codexModel: model.trim() } })
        return '命令配置已保存'
      })}>保存命令配置</Button></div>
      <PreferenceRow label="tpanel 通知命令">
        <Button size="sm" variant="outline" disabled={busy || !hasIpc} onClick={() => void run(async () => {
          const result = await api.installTpanel()
          if (!result.ok) throw new Error(result.error ?? '安装失败')
          return `tpanel 已安装${result.path ? `：${result.path}` : ''}`
        })}>安装 / 更新</Button>
      </PreferenceRow>
      <PreferenceRow label="当前项目任务 hooks">
        <Button size="sm" variant="outline" disabled={busy || !hasIpc || !root} onClick={() => void run(async () => {
          const result = await api.installTrellisHooks()
          if (!result.ok) throw new Error(result.error ?? '写入失败')
          return result.message ?? '任务 hooks 已配置'
        })}>写入 hooks</Button>
      </PreferenceRow>
      {message && <p role={message.error ? 'alert' : 'status'} className={`pb-4 break-words text-my-sm ${message.error ? 'text-my-danger-text' : 'text-my-secondary'}`}>{message.text}</p>}
    </details>
  </PreferenceSection>
}
