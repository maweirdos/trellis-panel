import { useState, type JSX } from 'react'
import type { CruxAgent, CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { RUNTIME_KIND_OPTIONS, WORKDIR_MODE_OPTIONS } from '../local-execution-slot'
import { useCrux } from '../store'
import { Field, inputClass, Select, textareaClass } from '../ui'
import { AgentHubView } from './AgentHubView'

/** 空间内 Agents 页面：直接复用与 HiFox 一致的主从双栏 + 右侧 7 大配置卡抽屉。 */
export function AgentsPage(): JSX.Element | null {
  return <AgentHubView scope="space" />
}

/** 供跨模块（如小队/技能快捷跳转）复用的精简编辑弹层。 */
export function AgentEditor({
  agent,
  spaceId,
  onClose
}: {
  agent: CruxAgent | null
  spaceId: string
  onClose: () => void
}): JSX.Element | null {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [runtimeKind, setRuntimeKind] = useState<CruxRuntimeKind>(agent?.runtimeKind ?? 'codex')
  const [workingDirectory, setWorkingDirectory] = useState<CruxWorkingDirectoryMode>(agent?.workingDirectory ?? 'repo')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')

  const submit = async (): Promise<void> => {
    if (busy || !name.trim()) return
    const result = await run(agent ? '保存 Agent' : '创建 Agent', () =>
      api.crux.saveAgent({
        id: agent?.id,
        spaceId: agent?.spaceId ?? spaceId,
        name: name.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim(),
        skillIds: agent?.skillIds ?? [],
        repositories: agent?.repositories ?? [],
        runtimeKind,
        workingDirectory,
        enabled: agent?.enabled ?? true,
        archived: agent?.archived ?? false
      })
    )
    if (result?.ok) onClose()
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose() }} width={520} ariaLabel={agent ? '编辑 Agent' : '创建 Agent'}>
      <div className="flex flex-col gap-3 p-4">
        <h2 className="text-my-md font-semibold text-my-primary">{agent ? `编辑 ${agent.name}` : '创建 Agent'}</h2>
        <Field label="名称"><input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="描述"><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Runtime"><Select className="w-full" value={runtimeKind} onChange={(v) => setRuntimeKind(v as CruxRuntimeKind)} options={[...RUNTIME_KIND_OPTIONS]} /></Field>
          <Field label="工作目录"><Select className="w-full" value={workingDirectory} onChange={(v) => setWorkingDirectory(v as CruxWorkingDirectoryMode)} options={[...WORKDIR_MODE_OPTIONS]} /></Field>
        </div>
        <Field label="系统指令"><textarea className={`${textareaClass} font-mono text-my-xs`} rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>保存</Button>
        </div>
      </div>
    </Modal>
  )
}
