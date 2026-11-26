import { lazy, Suspense, useEffect, useState, type JSX } from 'react'
import { BookOpen, Building2, Layers, SlidersHorizontal } from 'lucide-react'
import { resolveSpaceModules } from '@shared/crux-space-presets'
import { api } from '../api'
import { useCrux } from '../crux/store'
import { useApp } from '../store'
import { Select } from '../components/Select'
import { Button, Tabs } from '../my/ui'
import { PageLoading } from '../my/layout/PageLoading'
import { TeamPublishedKnowledge } from './TeamPublishedKnowledge'
import './space-knowledge.css'

const CreationWorkspace = lazy(() =>
  import('../creations/CreationWorkspace').then((module) => ({ default: module.CreationWorkspace }))
)

type SpaceDocsTab = 'creations' | 'published'

export function SpaceKnowledgeHub({
  host = 'desktop',
  showSpaceSwitcher = true
}: {
  host?: 'desktop' | 'web'
  showSpaceSwitcher?: boolean
}): JSX.Element {
  const snapshot = useCrux((state) => state.snapshot)
  const bootstrap = useCrux((state) => state.bootstrap)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const setCurrentSpace = useCrux((state) => state.setCurrentSpace)
  const setModule = useCrux((state) => state.setModule)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const workspaceContext = useCrux((state) => state.workspaceContext)
  const setPage = useApp((state) => state.setPage)
  const [tab, setTab] = useState<SpaceDocsTab>('creations')

  useEffect(() => {
    if (!snapshot) void bootstrap()
  }, [snapshot, bootstrap])

  const actorId =
    workspaceContext.actorId ??
    (workspaceContext.state === 'local'
      ? snapshot?.members.find((member) => member.role === 'owner')?.id ?? null
      : null)

  const accessibleSpaces =
    snapshot?.spaces.filter(
      (space) => !space.archived && (!actorId || space.memberIds.includes(actorId))
    ) ?? []

  const activeSpace =
    accessibleSpaces.find((space) => space.id === currentSpaceId) ?? accessibleSpaces[0] ?? null

  useEffect(() => {
    if (activeSpace && activeSpace.id !== currentSpaceId) {
      setCurrentSpace(activeSpace.id)
    }
  }, [activeSpace, currentSpaceId, setCurrentSpace])

  const enabledModules = resolveSpaceModules(activeSpace ?? undefined)
  const docsDisabled = Boolean(activeSpace && !enabledModules.docs)
  const showPublishedTab = host === 'desktop'
  const effectiveTab: SpaceDocsTab = showPublishedTab ? tab : 'creations'

  const enableDocsModule = (): void => {
    if (!activeSpace) return
    void run('开启文档库模块', () =>
      api.crux.updateSpace({
        id: activeSpace.id,
        enabledModules: { ...enabledModules, docs: true }
      })
    )
  }

  return (
    <div className="space-kb-shell">
      <div className="space-kb-bar">
        <div className="space-kb-context">
          <span className="space-kb-org-pill">
            <Building2 size={13} aria-hidden="true" />
            <span>
              {workspaceContext.state === 'local'
                ? '本机模式'
                : workspaceContext.projectName ?? '团队组织'}
            </span>
          </span>

          {showSpaceSwitcher && accessibleSpaces.length > 0 ? (
            <div className="space-kb-space-picker">
              <Layers size={13} className="text-my-tertiary shrink-0" aria-hidden="true" />
              <Select
                size="sm"
                ariaLabel="切换当前空间"
                value={activeSpace?.id ?? ''}
                onChange={(nextSpaceId) => {
                  if (nextSpaceId) setCurrentSpace(nextSpaceId)
                }}
                options={accessibleSpaces.map((space) => ({
                  value: space.id,
                  label: `${space.name} (${space.key})`
                }))}
              />
            </div>
          ) : activeSpace ? (
            <span className="space-kb-space-badge">
              <BookOpen size={13} aria-hidden="true" />
              <span className="truncate">{activeSpace.name}</span>
              <span className="text-my-tertiary">{activeSpace.key}</span>
            </span>
          ) : null}
        </div>

        {showPublishedTab && (
          <div className="space-kb-tabs">
            <Tabs<SpaceDocsTab>
              ariaLabel="空间文档库视图"
              active={effectiveTab}
              onChange={setTab}
              tabs={[
                { id: 'creations', label: '空间文档与产物' },
                { id: 'published', label: '组织固定版发布' }
              ]}
            />
          </div>
        )}
      </div>

      {docsDisabled && activeSpace && (
        <div className="space-kb-disabled-banner" role="status">
          <span>
            空间「{activeSpace.name}」当前未启用「文档库」模块，侧栏已隐藏快捷入口；你仍可查看既有文档或立即重新开启。
          </span>
          <div className="space-kb-disabled-actions">
            {workspaceContext.canManage && workspaceContext.state !== 'access-revoked' && (
              <Button size="sm" variant="primary" disabled={busy} onClick={enableDocsModule}>
                开启文档库模块
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCurrentSpace(activeSpace.id)
                setModule('spaces')
                setPage('crux')
              }}
            >
              <SlidersHorizontal size={13} />
              空间设置
            </Button>
          </div>
        </div>
      )}

      <div className="space-kb-body">
        {effectiveTab === 'creations' ? (
          <Suspense fallback={<PageLoading />}>
            <CreationWorkspace scope="team" embedded />
          </Suspense>
        ) : (
          <TeamPublishedKnowledge embedded />
        )}
      </div>
    </div>
  )
}
