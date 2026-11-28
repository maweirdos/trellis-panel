import { useState } from 'react'
import { ArrowRight, ChevronRight, Clock, FolderOpen, Users } from 'lucide-react'
import { useApp } from '../store'
import { Button, DisclosureGrid } from '../my/ui'
import { PageBody, PageContent, PageLayout } from '../my/layout/PageLayout'
import { BrandMark } from '../my/BrandMark'
import { BrandWordmark } from '../my/BrandWordmark'

export function Onboarding(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const openError = useApp((s) => s.openError)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const openProjectPath = useApp((s) => s.openProjectPath)
  const recents = settings?.recentProjects ?? []
  const [prepOpen, setPrepOpen] = useState(false)

  return <PageLayout variant="centered"><PageBody><PageContent>
    <div className="my-start"><div className="my-start-grid">
      <section className="min-w-0">
        <div className="mb-6 flex items-center gap-3 text-my-primary" role="img" aria-label="Crux"><BrandMark size={28} /><BrandWordmark width={88} /></div>
        <h1 className="text-my-display font-medium tracking-tight text-my-primary">工作台</h1>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="primary" size="lg" onClick={() => useApp.getState().setPage('crux')}><Users size={17} />进入团队空间<ArrowRight size={15} /></Button>
          <Button variant="outline" size="lg" onClick={() => void pickAndOpen()}><FolderOpen size={17} />打开本机项目</Button>
        </div>
        {openError && <p role="alert" className="mt-3 rounded-my-base bg-my-danger-subtle p-3 text-my-sm text-my-danger-text">{openError}</p>}
      </section>

      <section className="my-start-projects">
        <h2 className="mb-4 flex items-center gap-2 text-my-sm font-medium"><Clock size={16} />最近项目</h2>
        {recents.length ? <div className="space-y-1">{recents.slice(0, 6).map((path) => <button key={path} type="button" onClick={() => void openProjectPath(path)} className="my-start-project">
          <FolderOpen size={18} className="shrink-0 text-my-icon-secondary" /><span className="min-w-0 flex-1"><span className="my-item-title block truncate">{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span><span className="my-item-description mt-1 block truncate" title={path}>{path}</span></span><ArrowRight size={15} className="shrink-0 text-my-icon-tertiary" />
        </button>)}</div> : <div className="py-8 text-center"><FolderOpen size={28} className="mx-auto mb-3 text-my-icon-tertiary" /><p className="text-my-sm text-my-secondary">还没有打开过项目</p><p className="mt-2 text-my-xs text-my-tertiary">选择项目目录后，会在这里保留快捷入口。</p></div>}
        <div className="mt-6 border-t border-my-line pt-4 text-my-xs leading-relaxed text-my-secondary">
          <button type="button" aria-expanded={prepOpen} onClick={() => setPrepOpen((v) => !v)} className="flex cursor-pointer items-center gap-2 text-left text-my-primary transition-colors hover:text-my-primary">
            <ChevronRight size={14} className={`shrink-0 transition-transform duration-150 ${prepOpen ? 'rotate-90' : ''}`} />本机项目准备
          </button>
          <DisclosureGrid open={prepOpen}><p className="mt-3">安装 <code className="rounded-my-base bg-my-layer-3 px-1 py-0.5 font-mono">npm i -g @mindfoldhq/trellis</code>，在项目目录执行 <code className="rounded-my-base bg-my-layer-3 px-1 py-0.5 font-mono">trellis init</code>。</p></DisclosureGrid>
        </div>
      </section>
    </div></div>
  </PageContent></PageBody></PageLayout>
}
