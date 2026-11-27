import { useState, type JSX } from 'react'
import { Bot, Check, Plug, Plus, Search, Wrench, X } from 'lucide-react'
import { api } from '../../api'
import { Button, EmptyState } from '../../my/ui'
import {
  AGENT_MARKET_TEMPLATES,
  SKILL_MARKET_PRESETS,
  useCollaborationPlatform,
  type AgentMarketTemplate,
  type SkillMarketPreset
} from '../collaboration-platform-store'
import { runtimeKindLabel } from '../local-execution-slot'
import { identityTone } from '../identity-tone'
import { useCrux } from '../store'
import { Field, inputClass, Select } from '../ui'

type MarketTab = 'all' | 'templates' | 'skills' | 'connectors'

interface ConnectorPreset {
  id: string
  name: string
  category: string
  description: string
  commandOrUrl: string
}

const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [
  {
    id: 'conn-github',
    name: 'GitHub MCP 连接器',
    category: '代码与研发',
    description: '让 Agent 直接读取 PR、Issue、Commit Diff 并自动回写审查结论。',
    commandOrUrl: 'npx -y @modelcontextprotocol/server-github'
  },
  {
    id: 'conn-gitlab',
    name: 'GitLab MCP 连接器',
    category: '代码与研发',
    description: '接入企业自建 GitLab 仓库、Merge Request 与流水线状态。',
    commandOrUrl: 'npx -y @modelcontextprotocol/server-gitlab'
  },
  {
    id: 'conn-postgres',
    name: 'PostgreSQL 只读分析器',
    category: '数据与诊断',
    description: '供排障与数据分析 Agent 执行受控只读 SQL 查询与表结构核查。',
    commandOrUrl: 'npx -y @modelcontextprotocol/server-postgres'
  },
  {
    id: 'conn-playwright',
    name: 'Playwright 浏览器验收器',
    category: '测试验证',
    description: '支持前端与 QA Agent 自动打开本地页面、验证交互并截图取证。',
    commandOrUrl: 'npx -y @playwright/mcp@latest'
  }
]

type SelectedMarketItem =
  | { kind: 'template'; item: AgentMarketTemplate }
  | { kind: 'skill'; item: SkillMarketPreset }
  | { kind: 'connector'; item: ConnectorPreset }
  | null

/**
 * 1:1 对标 HiFox 侧边栏「市场（技能 · Agent 模板 · 连接器）」：
 * 胶囊分区筛选 + 卡片网格 + 右侧平滑预览与一键安装抽屉。
 */
export function MarketplacePage(): JSX.Element | null {
  const { snapshot, currentSpaceId, busy, run, setCurrentSpace, setModule } = useCrux()
  const { updateAgentMeta, recordAgentInstructionVersion, getAgentMeta } = useCollaborationPlatform()
  const [tab, setTab] = useState<MarketTab>('all')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<SelectedMarketItem>(() => ({ kind: 'template', item: AGENT_MARKET_TEMPLATES[0] }))
  const [targetSpaceId, setTargetSpaceId] = useState<string>(() => currentSpaceId ?? '')
  const [targetAgentId, setTargetAgentId] = useState<string>('')
  const [justInstalledId, setJustInstalledId] = useState<string | null>(null)

  if (!snapshot) return null
  const activeSpaces = snapshot.spaces.filter((s) => !s.archived)
  const effectiveSpaceId = targetSpaceId || currentSpaceId || activeSpaces[0]?.id || ''
  const spaceAgents = snapshot.agents.filter((a) => !a.archived && a.spaceId === effectiveSpaceId)
  const q = keyword.trim().toLowerCase()

  const templates = AGENT_MARKET_TEMPLATES.filter((t) =>
    (tab === 'all' || tab === 'templates') && `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(q)
  )
  const skills = SKILL_MARKET_PRESETS.filter((s) =>
    (tab === 'all' || tab === 'skills') && `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(q)
  )
  const connectors = CONNECTOR_PRESETS.filter((c) =>
    (tab === 'all' || tab === 'connectors') && `${c.name} ${c.category} ${c.description}`.toLowerCase().includes(q)
  )

  const installTemplate = async (tpl: AgentMarketTemplate): Promise<void> => {
    if (!effectiveSpaceId || busy) return
    const res = await run(`从市场创建 ${tpl.name}`, () => api.crux.saveAgent({
      spaceId: effectiveSpaceId,
      name: tpl.name,
      description: tpl.description,
      instructions: tpl.instructions,
      skillIds: [],
      repositories: [],
      runtimeKind: tpl.runtimeKind,
      workingDirectory: tpl.workingDirectory,
      enabled: true,
      archived: false
    }))
    if (res?.ok) {
      const created = [...res.data.agents].reverse().find((a) => a.spaceId === effectiveSpaceId && a.name === tpl.name)
      if (created) {
        updateAgentMeta(created.id, {
          isolationMode: tpl.isolationMode,
          quickReplies: tpl.quickReplies.map((qr, i) => ({ id: `qr-${Date.now()}-${i}`, ...qr }))
        })
        recordAgentInstructionVersion(created.id, tpl.instructions, '来自市场模板')
      }
      setJustInstalledId(tpl.id)
      setCurrentSpace(effectiveSpaceId)
    }
  }

  const installSkill = async (preset: SkillMarketPreset): Promise<void> => {
    if (busy) return
    const res = await run(`安装技能 ${preset.name}`, () => api.crux.saveSkill({
      spaceId: effectiveSpaceId || undefined,
      name: preset.name,
      description: preset.description,
      content: preset.content
    }))
    if (res?.ok) setJustInstalledId(preset.id)
  }

  const attachConnector = (conn: ConnectorPreset): void => {
    const agentId = targetAgentId || spaceAgents[0]?.id
    if (!agentId) return
    const meta = getAgentMeta(agentId)
    if (!meta.mcpEndpoints.some((ep) => ep.commandOrUrl === conn.commandOrUrl)) {
      updateAgentMeta(agentId, {
        mcpEndpoints: [...meta.mcpEndpoints, { id: `mcp-${Date.now()}`, name: conn.name, commandOrUrl: conn.commandOrUrl, enabled: true }]
      })
    }
    setJustInstalledId(conn.id)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="collab-canvas-surface my-scrollbar flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5" style={{ scrollbarGutter: 'stable' }}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-my-lg font-semibold text-my-primary">市场</h1>
            <p className="mt-0.5 text-my-xs text-my-tertiary">发现并一键启用 Agent 岗位模板、可复用技能规范（Skills）与外部 MCP 连接器。</p>
          </div>
          <div className="relative w-64 max-w-full">
            <Search size={14} className="pointer-events-none absolute top-2.5 left-3 text-my-icon-tertiary" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索模板、技能或连接器…"
              aria-label="搜索市场"
              className={`${inputClass} pl-8`}
            />
          </div>
        </header>

        <div className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-full bg-my-layer-2 p-0.5" role="tablist" aria-label="市场分类">
          {([
            ['all', '全部'],
            ['templates', `Agent 模板 (${AGENT_MARKET_TEMPLATES.length})`],
            ['skills', `技能 Skills (${SKILL_MARKET_PRESETS.length})`],
            ['connectors', `连接器 MCP (${CONNECTOR_PRESETS.length})`]
          ] as const).map(([id, label]) => {
            const active = tab === id
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(id)}
                className="collab-filter-pill"
              >
                {label}
              </button>
            )
          })}
        </div>

        {templates.length === 0 && skills.length === 0 && connectors.length === 0 ? (
          <EmptyState title="没有匹配的市场内容" description="尝试更换搜索关键词或切换分类胶囊。" />
        ) : (
          <div className="flex flex-col gap-6">
            {templates.length > 0 && (
              <section className="space-y-2.5">
                <h2 className="text-my-xs font-medium text-my-secondary">Agent 岗位模板</h2>
                <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                  {templates.map((tpl) => {
                    const active = selected?.kind === 'template' && selected.item.id === tpl.id
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        data-selected={active || undefined}
                        onClick={() => setSelected({ kind: 'template', item: tpl })}
                        className="collab-elevated-card flex items-start gap-3 rounded-my-base p-3.5 text-left"
                      >
                        <span className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-full" data-tone={identityTone(tpl.name)}><Bot size={19} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-my-sm font-semibold text-my-primary">{tpl.name}</span>
                            <span className="my-chip">{tpl.category}</span>
                          </span>
                          <span className="mt-1 line-clamp-2 block text-my-xs text-my-secondary">{tpl.description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            {skills.length > 0 && (
              <section className="space-y-2.5">
                <h2 className="text-my-xs font-medium text-my-secondary">技能手册 (Skills)</h2>
                <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                  {skills.map((sk) => {
                    const active = selected?.kind === 'skill' && selected.item.id === sk.id
                    return (
                      <button
                        key={sk.id}
                        type="button"
                        data-selected={active || undefined}
                        onClick={() => setSelected({ kind: 'skill', item: sk })}
                        className="collab-elevated-card flex items-start gap-3 rounded-my-base p-3.5 text-left"
                      >
                        <span className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-my-base" data-tone="indigo"><Wrench size={18} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-my-sm font-semibold text-my-primary">{sk.name}</span>
                            <span className="my-chip">{sk.category}</span>
                          </span>
                          <span className="mt-1 line-clamp-2 block text-my-xs text-my-secondary">{sk.description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            {connectors.length > 0 && (
              <section className="space-y-2.5">
                <h2 className="text-my-xs font-medium text-my-secondary">MCP 与外部连接器</h2>
                <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                  {connectors.map((conn) => {
                    const active = selected?.kind === 'connector' && selected.item.id === conn.id
                    return (
                      <button
                        key={conn.id}
                        type="button"
                        data-selected={active || undefined}
                        onClick={() => setSelected({ kind: 'connector', item: conn })}
                        className="collab-elevated-card flex items-start gap-3 rounded-my-base p-3.5 text-left"
                      >
                        <span className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-my-base" data-tone="purple"><Plug size={18} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-my-sm font-semibold text-my-primary">{conn.name}</span>
                            <span className="my-chip">{conn.category}</span>
                          </span>
                          <span className="mt-1 line-clamp-2 block text-my-xs text-my-secondary">{conn.description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* 右侧详情与一键安装抽屉 */}
      {selected && (
        <aside className="flex h-full w-[400px] max-w-full shrink-0 flex-col border-l border-my-line bg-my-panel">
          <header className="flex items-center justify-between border-b border-my-line px-4 py-2.5">
            <span className="text-my-xs font-medium text-my-secondary">
              {selected.kind === 'template' ? 'Agent 模板详情' : selected.kind === 'skill' ? '技能详情' : '连接器详情'}
            </span>
            <button type="button" onClick={() => setSelected(null)} className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1"><X size={15} /></button>
          </header>

          <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-my-md font-semibold text-my-primary">{selected.item.name}</h2>
                <span className="my-chip">{selected.item.category}</span>
              </div>
              <p className="mt-1.5 text-my-xs leading-relaxed text-my-secondary">{selected.item.description}</p>
            </div>

            {activeSpaces.length > 0 && (
              <Field label="安装到空间">
                <Select
                  className="w-full"
                  value={effectiveSpaceId}
                  onChange={setTargetSpaceId}
                  options={activeSpaces.map((s) => ({ value: s.id, label: `${s.name} (${s.key})` }))}
                />
              </Field>
            )}

            {selected.kind === 'template' && (
              <>
                <div className="flex flex-wrap gap-1.5 text-my-2xs text-my-tertiary">
                  <span className="my-chip">推荐引擎：{runtimeKindLabel(selected.item.runtimeKind)}</span>
                  <span className="my-chip">目录：{selected.item.isolationMode}</span>
                </div>
                <div>
                  <div className="mb-1.5 text-my-xs font-medium text-my-primary">内置系统指令预览</div>
                  <pre className="whitespace-pre-wrap rounded-my-base border border-my-line bg-my-panel p-3 font-mono text-my-2xs leading-relaxed text-my-secondary">
                    {selected.item.instructions}
                  </pre>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" className="flex-1 justify-center" disabled={!effectiveSpaceId || busy} onClick={() => void installTemplate(selected.item)}>
                    {justInstalledId === selected.item.id ? <><Check size={14} />已创建到空间</> : <><Plus size={14} />使用此模板创建 Agent</>}
                  </Button>
                  {justInstalledId === selected.item.id && (
                    <Button size="sm" variant="outline" onClick={() => setModule('all-agents')}>去查看</Button>
                  )}
                </div>
              </>
            )}

            {selected.kind === 'skill' && (
              <>
                <div>
                  <div className="mb-1.5 text-my-xs font-medium text-my-primary">SKILL.md 指令内容</div>
                  <pre className="whitespace-pre-wrap rounded-my-base border border-my-line bg-my-panel p-3 font-mono text-my-2xs leading-relaxed text-my-secondary">
                    {selected.item.content}
                  </pre>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" className="flex-1 justify-center" disabled={busy} onClick={() => void installSkill(selected.item)}>
                    {justInstalledId === selected.item.id ? <><Check size={14} />已添加到技能库</> : <><Plus size={14} />安装到空间技能库</>}
                  </Button>
                  {justInstalledId === selected.item.id && (
                    <Button size="sm" variant="outline" onClick={() => setModule('skills')}>去查看</Button>
                  )}
                </div>
              </>
            )}

            {selected.kind === 'connector' && (
              <>
                <Field label="绑定到目标 Agent">
                  <Select
                    className="w-full"
                    value={targetAgentId || spaceAgents[0]?.id || ''}
                    onChange={setTargetAgentId}
                    options={
                      spaceAgents.length > 0
                        ? spaceAgents.map((a) => ({ value: a.id, label: a.name }))
                        : [{ value: '', label: '请先在当前空间创建 Agent' }]
                    }
                  />
                </Field>
                <div>
                  <div className="mb-1.5 text-my-xs font-medium text-my-primary">MCP 启动命令</div>
                  <code className="block rounded-my-base border border-my-line bg-my-panel p-3 font-mono text-my-2xs text-my-secondary">
                    {selected.item.commandOrUrl}
                  </code>
                </div>
                <Button size="sm" variant="primary" className="w-full justify-center" disabled={spaceAgents.length === 0} onClick={() => attachConnector(selected.item)}>
                  {justInstalledId === selected.item.id ? <><Check size={14} />已挂载到 Agent</> : <><Plus size={14} />一键挂载到 Agent</>}
                </Button>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
