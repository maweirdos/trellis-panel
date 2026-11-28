import { useState, type JSX } from 'react'
import { Bot, Check, Plug, Plus, ShoppingBag, Wrench, X } from 'lucide-react'
import { api } from '../../api'
import { Button, EmptyState, SearchInput, Tabs, Tooltip } from '../../my/ui'
import {
  AGENT_MARKET_TEMPLATES,
  SKILL_MARKET_PRESETS,
  useCollaborationPlatform,
  type AgentMarketTemplate,
  type SkillMarketPreset
} from '../collaboration-platform-store'
import { identityTone } from '../identity-tone'
import { runtimeKindLabel } from '../local-execution-slot'
import { useCrux } from '../store'
import { Field, PageHeader, Select } from '../ui'

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
 * 能力市场（Agent 岗位模板 · 技能手册 Skills · MCP 连接器）：
 * 共享分类 Tabs + 卡片网格 + 响应式右侧详情与一键启用面板。
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

  const matchingTemplates = AGENT_MARKET_TEMPLATES.filter((t) => `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(q))
  const matchingSkills = SKILL_MARKET_PRESETS.filter((s) => `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(q))
  const matchingConnectors = CONNECTOR_PRESETS.filter((c) => `${c.name} ${c.category} ${c.description}`.toLowerCase().includes(q))

  const templates = tab === 'all' || tab === 'templates' ? matchingTemplates : []
  const skills = tab === 'all' || tab === 'skills' ? matchingSkills : []
  const connectors = tab === 'all' || tab === 'connectors' ? matchingConnectors : []

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

  const templateInstallDisabledReason = !effectiveSpaceId ? '请先创建或加入一个非归档空间' : null
  const connectorAttachDisabledReason = spaceAgents.length === 0 ? '请先在目标空间创建至少一个 Agent' : null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-[var(--my-page-inset)] lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <PageHeader
          title="市场"
          description="发现并一键启用 Agent 岗位模板、可复用技能规范（Skills）与外部 MCP 连接器。"
          actions={
            <SearchInput
              size="sm"
              value={keyword}
              onChange={setKeyword}
              placeholder="搜索模板、技能或连接器"
              ariaLabel="搜索市场"
              className="w-60"
            />
          }
        />

        <div className="shrink-0">
          <Tabs
            tabs={[
              { id: 'all' as MarketTab, label: '全部', count: matchingTemplates.length + matchingSkills.length + matchingConnectors.length },
              { id: 'templates' as MarketTab, label: 'Agent 模板', count: matchingTemplates.length },
              { id: 'skills' as MarketTab, label: '技能 Skills', count: matchingSkills.length },
              { id: 'connectors' as MarketTab, label: '连接器 MCP', count: matchingConnectors.length }
            ]}
            active={tab}
            onChange={setTab}
            ariaLabel="市场分类"
          />
        </div>

        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {templates.length === 0 && skills.length === 0 && connectors.length === 0 ? (
            <EmptyState
              icon={<ShoppingBag size={28} />}
              title="没有匹配的市场内容"
              description="尝试更换搜索关键词或切换上方分类标签。"
            />
          ) : (
            <div key={tab} className="my-subview-stage flex flex-col gap-6">
              {templates.length > 0 && (
                <section className="space-y-2.5">
                  <h2 className="pl-0.5 text-my-xs font-normal text-my-secondary">Agent 岗位模板</h2>
                  <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                    {templates.map((tpl) => {
                      const active = selected?.kind === 'template' && selected.item.id === tpl.id
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => setSelected({ kind: 'template', item: tpl })}
                          className={`my-card flex items-start gap-3 p-3.5 text-left transition-[transform,background-color,border-color] duration-150 ease-out active:translate-y-[var(--my-tactile-press-y)] active:scale-[var(--my-tactile-press-scale)] ${
                            active ? 'border-my-accent bg-my-layer-2' : 'hover:border-my-line-strong hover:bg-my-layer-1'
                          }`}
                        >
                          <span className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-full" data-tone={identityTone(tpl.name)}>
                            <Bot size={19} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="my-item-title truncate text-my-sm font-medium text-my-primary">{tpl.name}</span>
                              <span className="my-chip shrink-0">{tpl.category}</span>
                            </span>
                            <span className="mt-1 line-clamp-2 text-my-xs text-my-secondary">{tpl.description}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              {skills.length > 0 && (
                <section className="space-y-2.5">
                  <h2 className="pl-0.5 text-my-xs font-normal text-my-secondary">技能手册 (Skills)</h2>
                  <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                    {skills.map((sk) => {
                      const active = selected?.kind === 'skill' && selected.item.id === sk.id
                      return (
                        <button
                          key={sk.id}
                          type="button"
                          onClick={() => setSelected({ kind: 'skill', item: sk })}
                          className={`my-card flex items-start gap-3 p-3.5 text-left transition-[transform,background-color,border-color] duration-150 ease-out active:translate-y-[var(--my-tactile-press-y)] active:scale-[var(--my-tactile-press-scale)] ${
                            active ? 'border-my-accent bg-my-layer-2' : 'hover:border-my-line-strong hover:bg-my-layer-1'
                          }`}
                        >
                          <span className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-my-base" data-tone="indigo">
                            <Wrench size={18} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="my-item-title truncate text-my-sm font-medium text-my-primary">{sk.name}</span>
                              <span className="my-chip shrink-0">{sk.category}</span>
                            </span>
                            <span className="mt-1 line-clamp-2 text-my-xs text-my-secondary">{sk.description}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              {connectors.length > 0 && (
                <section className="space-y-2.5">
                  <h2 className="pl-0.5 text-my-xs font-normal text-my-secondary">MCP 与外部连接器</h2>
                  <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                    {connectors.map((conn) => {
                      const active = selected?.kind === 'connector' && selected.item.id === conn.id
                      return (
                        <button
                          key={conn.id}
                          type="button"
                          onClick={() => setSelected({ kind: 'connector', item: conn })}
                          className={`my-card flex items-start gap-3 p-3.5 text-left transition-[transform,background-color,border-color] duration-150 ease-out active:translate-y-[var(--my-tactile-press-y)] active:scale-[var(--my-tactile-press-scale)] ${
                            active ? 'border-my-accent bg-my-layer-2' : 'hover:border-my-line-strong hover:bg-my-layer-1'
                          }`}
                        >
                          <span className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-my-base" data-tone="purple">
                            <Plug size={18} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="my-item-title truncate text-my-sm font-medium text-my-primary">{conn.name}</span>
                              <span className="my-chip shrink-0">{conn.category}</span>
                            </span>
                            <span className="mt-1 line-clamp-2 text-my-xs text-my-secondary">{conn.description}</span>
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
      </div>

      {selected && (
        <aside className="my-card flex max-h-[52vh] w-full shrink-0 flex-col overflow-hidden lg:h-full lg:max-h-none lg:w-[400px]">
          <header className="flex shrink-0 items-center justify-between border-b border-my-line px-4 py-2.5">
            <span className="text-my-xs text-my-secondary">
              {selected.kind === 'template' ? 'Agent 模板详情' : selected.kind === 'skill' ? '技能详情' : '连接器详情'}
            </span>
            <Button size="sm" variant="ghost" aria-label="关闭详情" onClick={() => setSelected(null)}>
              <X size={15} />
            </Button>
          </header>

          <div className="my-scrollbar my-fade-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-my-md font-medium text-my-primary">{selected.item.name}</h2>
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
                  <div className="mb-1.5 pl-0.5 text-my-xs text-my-secondary">内置系统指令预览</div>
                  <pre className="whitespace-pre-wrap rounded-my-base border border-my-line bg-my-layer-1 p-3 font-mono text-my-2xs leading-relaxed text-my-secondary">
                    {selected.item.instructions}
                  </pre>
                </div>
                <div className="flex items-center gap-2">
                  {templateInstallDisabledReason ? (
                    <Tooltip label={templateInstallDisabledReason} wrap>
                      <span className="flex flex-1">
                        <Button size="sm" variant="primary" className="w-full justify-center" disabled>
                          <Plus size={14} />
                          <span>使用此模板创建 Agent</span>
                        </Button>
                      </span>
                    </Tooltip>
                  ) : (
                    <Button size="sm" variant="primary" className="flex-1 justify-center" disabled={busy} onClick={() => void installTemplate(selected.item)}>
                      {justInstalledId === selected.item.id ? <><Check size={14} /><span>已创建到空间</span></> : <><Plus size={14} /><span>使用此模板创建 Agent</span></>}
                    </Button>
                  )}
                  {justInstalledId === selected.item.id && (
                    <Button size="sm" variant="outline" onClick={() => setModule('all-agents')}>去查看</Button>
                  )}
                </div>
              </>
            )}

            {selected.kind === 'skill' && (
              <>
                <div>
                  <div className="mb-1.5 pl-0.5 text-my-xs text-my-secondary">SKILL.md 指令内容</div>
                  <pre className="whitespace-pre-wrap rounded-my-base border border-my-line bg-my-layer-1 p-3 font-mono text-my-2xs leading-relaxed text-my-secondary">
                    {selected.item.content}
                  </pre>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" className="flex-1 justify-center" disabled={busy} onClick={() => void installSkill(selected.item)}>
                    {justInstalledId === selected.item.id ? <><Check size={14} /><span>已添加到技能库</span></> : <><Plus size={14} /><span>安装到空间技能库</span></>}
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
                  <div className="mb-1.5 pl-0.5 text-my-xs text-my-secondary">MCP 启动命令</div>
                  <code className="block break-all rounded-my-base border border-my-line bg-my-layer-1 p-3 font-mono text-my-2xs text-my-secondary">
                    {selected.item.commandOrUrl}
                  </code>
                </div>
                {connectorAttachDisabledReason ? (
                  <Tooltip label={connectorAttachDisabledReason} wrap>
                    <span className="flex w-full">
                      <Button size="sm" variant="primary" className="w-full justify-center" disabled>
                        <Plus size={14} />
                        <span>一键挂载到 Agent</span>
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Button size="sm" variant="primary" className="w-full justify-center" onClick={() => attachConnector(selected.item)}>
                    {justInstalledId === selected.item.id ? <><Check size={14} /><span>已挂载到 Agent</span></> : <><Plus size={14} /><span>一键挂载到 Agent</span></>}
                  </Button>
                )}
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
