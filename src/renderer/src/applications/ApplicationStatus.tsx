import { CircleCheck, CircleHelp, CircleX, Loader2, Terminal, TriangleAlert } from 'lucide-react'
import type { ApplicationProcessState, ApplicationReadinessState, ApplicationSummary } from '@shared/app-runtime'

const PROCESS_LABELS: Record<ApplicationProcessState, string> = {
  stopped: '未启动', starting: '正在启动', running: '进程运行中', stopping: '正在停止',
  exited: '已退出', failed: '运行失败', unknown: '进程状态未知', 'cleanup-required': '停止未完成'
}
const READINESS_LABELS: Record<ApplicationReadinessState['state'], string> = {
  'not-configured': '未配置就绪检查', checking: '等待服务就绪', ready: '服务已就绪', unhealthy: '服务未就绪', unknown: '服务状态未知'
}

export function ProcessStatus({ app }: { app: Pick<ApplicationSummary, 'processState'> }): JSX.Element {
  const working = app.processState === 'starting' || app.processState === 'stopping'
  const failure = app.processState === 'failed' || app.processState === 'cleanup-required'
  const Icon = working ? Loader2 : failure ? CircleX : app.processState === 'unknown' ? CircleHelp : Terminal
  return <span className={`inline-flex items-center gap-1.5 ${failure ? 'text-my-danger-text' : app.processState === 'unknown' ? 'text-my-warning-text' : 'text-my-secondary'}`} data-process-state={app.processState}>
    <Icon size={13} aria-hidden="true" className={working ? 'animate-spin' : undefined} />{PROCESS_LABELS[app.processState]}
  </span>
}

export function ReadinessStatus({ readiness }: { readiness: ApplicationReadinessState }): JSX.Element {
  const Icon = readiness.state === 'ready' ? CircleCheck : readiness.state === 'unhealthy' ? TriangleAlert : readiness.state === 'checking' ? Loader2 : CircleHelp
  return <span title={readiness.message} className={`inline-flex items-center gap-1.5 ${readiness.state === 'ready' ? 'text-my-success-text' : readiness.state === 'unhealthy' ? 'text-my-warning-text' : 'text-my-tertiary'}`} data-readiness-state={readiness.state}>
    <Icon size={13} aria-hidden="true" className={readiness.state === 'checking' ? 'animate-spin' : undefined} />{READINESS_LABELS[readiness.state]}
  </span>
}
