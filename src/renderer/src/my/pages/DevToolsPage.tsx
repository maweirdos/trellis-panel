// 本机开发工具：项目只读 Git 查看与应用运行配置。
import type { JSX } from 'react'
import { useApp } from '../../store'
import { PageContent } from '../layout/PageLayout'
import { useMy } from '../store'
import { projectRootKey } from '../navigation'
import { ApplicationRuntimeView } from '../../applications/ApplicationPanel'
import { GitViewer } from '../git/GitViewer'

export function DevToolsPage(): JSX.Element {
  const root = useApp((state) => state.snapshot?.meta.root ?? null)
  const rootKey = projectRootKey(root)
  const toolView = useMy((state) => state.toolView)
  return (
    <PageContent key={rootKey ?? 'preview'} className="my-locked-canvas">
      <div className="my-locked-scroll">
        {toolView === 'run' ? <ApplicationRuntimeView /> : <GitViewer root={root} />}
      </div>
    </PageContent>
  )
}
