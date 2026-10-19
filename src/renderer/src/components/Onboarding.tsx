import { ArrowRight, BookOpen, Clock, FolderOpen, Leaf, ListTodo, MessagesSquare } from 'lucide-react'
import { useApp } from '../store'
import { Button } from '../my/ui'
import { PageBody, PageContent, PageLayout } from '../my/layout/PageLayout'

export function Onboarding(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const openError = useApp((s) => s.openError)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const openProjectPath = useApp((s) => s.openProjectPath)
  const recents = settings?.recentProjects ?? []

  return <PageLayout variant="centered"><PageBody><PageContent>
    <div className="my-start"><div className="my-start-grid">
      <section className="min-w-0">
        <div className="mb-6 flex items-center gap-3 text-my-secondary"><Leaf size={24} /><span className="text-my-sm font-medium">Trellis Panel</span></div>
        <h1 className="text-my-display font-semibold tracking-tight text-my-primary">打开项目，<br />回到你的工作节奏。</h1>
        <p className="mt-4 text-my-md leading-relaxed text-my-secondary">在个人工作台关注任务进度，把项目资料、规范和 AI 对话放在一起。</p>
        <Button variant="primary" size="lg" onClick={pickAndOpen} className="mt-6"><FolderOpen size={16} />打开 Trellis 项目</Button>
        {openError && <p role="alert" className="mt-3 rounded-my-md bg-my-danger-subtle p-3 text-my-sm text-my-danger-text">{openError}</p>}
        <div className="mt-8 space-y-4">{[
          { icon: ListTodo, title: '个人工作台', text: '任务看板、优先关注与待办收件箱' },
          { icon: BookOpen, title: '知识与规范', text: '项目资料与知识库，共享统一阅读体验' },
          { icon: MessagesSquare, title: '工作对话', text: '在任务上下文中与 AI 一起推进工作' }
        ].map(({ icon: Icon, title, text }) => <div key={title} className="flex items-start gap-3"><Icon size={17} className="mt-0.5 shrink-0 text-my-icon-secondary" /><div><h2 className="text-my-sm font-medium">{title}</h2><p className="mt-1 text-my-xs text-my-secondary">{text}</p></div></div>)}</div>
      </section>

      <section className="my-start-projects">
        <h2 className="mb-4 flex items-center gap-2 text-my-sm font-semibold"><Clock size={16} />最近项目</h2>
        {recents.length ? <div className="space-y-1">{recents.slice(0, 6).map((path) => <button key={path} type="button" onClick={() => void openProjectPath(path)} className="my-start-project">
          <FolderOpen size={18} className="shrink-0 text-my-icon-secondary" /><span className="min-w-0 flex-1"><span className="block truncate text-my-sm font-medium">{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span><span className="mt-1 block truncate text-my-xs text-my-tertiary" title={path}>{path}</span></span><ArrowRight size={15} className="shrink-0 text-my-icon-tertiary" />
        </button>)}</div> : <div className="py-8 text-center"><FolderOpen size={28} className="mx-auto mb-3 text-my-icon-tertiary" /><p className="text-my-sm text-my-secondary">还没有打开过项目</p><p className="mt-2 text-my-xs text-my-tertiary">选择项目目录后，会在这里保留快捷入口。</p></div>}
        <div className="mt-6 border-t border-my-line pt-4 text-my-xs leading-relaxed text-my-secondary"><p className="mb-2 font-medium text-my-primary">第一次使用 Trellis？</p><p>安装 <code className="rounded-my-sm bg-my-layer-3 px-1 py-0.5 font-mono">npm i -g @mindfoldhq/trellis</code>，再在项目目录执行 <code className="rounded-my-sm bg-my-layer-3 px-1 py-0.5 font-mono">trellis init</code>。</p></div>
      </section>
    </div></div>
  </PageContent></PageBody></PageLayout>
}
