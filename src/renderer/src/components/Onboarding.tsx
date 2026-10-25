import { ArrowRight, ChevronDown, Clock, FolderOpen, Users } from 'lucide-react'
import { useApp } from '../store'
import { Button } from '../my/ui'
import { PageBody, PageContent, PageLayout } from '../my/layout/PageLayout'
import { BrandMark } from '../my/BrandMark'

export function Onboarding(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const openError = useApp((s) => s.openError)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const openProjectPath = useApp((s) => s.openProjectPath)
  const recents = settings?.recentProjects ?? []

  return <PageLayout variant="centered"><PageBody><PageContent>
    <div className="my-start"><div className="my-start-grid">
      <section className="min-w-0">
        <div className="mb-6 flex items-center gap-3 text-my-secondary"><BrandMark size={24} /><span className="text-my-sm font-medium">Trellis Panel</span></div>
        <h1 className="text-my-display font-semibold tracking-tight text-my-primary">工作台</h1>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="primary" size="lg" onClick={() => useApp.getState().setPage('hifox')}><Users size={17} />进入团队空间<ArrowRight size={15} /></Button>
          <Button variant="outline" size="lg" onClick={pickAndOpen}><FolderOpen size={17} />打开本机项目</Button>
        </div>
        {openError && <p role="alert" className="mt-3 rounded-my-md bg-my-danger-subtle p-3 text-my-sm text-my-danger-text">{openError}</p>}
      </section>

      <section className="my-start-projects">
        <h2 className="mb-4 flex items-center gap-2 text-my-sm font-semibold"><Clock size={16} />最近项目</h2>
        {recents.length ? <div className="space-y-1">{recents.slice(0, 6).map((path) => <button key={path} type="button" onClick={() => void openProjectPath(path)} className="my-start-project">
          <FolderOpen size={18} className="shrink-0 text-my-icon-secondary" /><span className="min-w-0 flex-1"><span className="block truncate text-my-sm font-medium">{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span><span className="mt-1 block truncate text-my-xs text-my-tertiary" title={path}>{path}</span></span><ArrowRight size={15} className="shrink-0 text-my-icon-tertiary" />
        </button>)}</div> : <div className="py-8 text-center"><FolderOpen size={28} className="mx-auto mb-3 text-my-icon-tertiary" /><p className="text-my-sm text-my-secondary">还没有打开过项目</p><p className="mt-2 text-my-xs text-my-tertiary">选择项目目录后，会在这里保留快捷入口。</p></div>}
        <details className="group mt-6 border-t border-my-line pt-4 text-my-xs leading-relaxed text-my-secondary"><summary className="flex cursor-pointer list-none items-center gap-2 text-my-primary"><ChevronDown size={14} className="transition-transform group-open:rotate-180" />本机项目准备</summary><p className="mt-3">安装 <code className="rounded-my-sm bg-my-layer-3 px-1 py-0.5 font-mono">npm i -g @mindfoldhq/trellis</code>，在项目目录执行 <code className="rounded-my-sm bg-my-layer-3 px-1 py-0.5 font-mono">trellis init</code>。</p></details>
      </section>
    </div></div>
  </PageContent></PageBody></PageLayout>
}
