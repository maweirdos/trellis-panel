import type { ApplicationRun, ApplicationRunSnapshot, ApplicationEnvironmentCheck, ApplicationTaskServiceUse } from '@shared/app-runtime'

export function ApplicationRunFacts({ run, configChanged, serviceUses = [], environmentCheck, runEnvironmentCheck }: { run: ApplicationRun; configChanged: boolean | null; serviceUses?: ApplicationTaskServiceUse[]; environmentCheck?: ApplicationEnvironmentCheck; runEnvironmentCheck?: ApplicationEnvironmentCheck }): JSX.Element {
  const snapshot = run.snapshot
  const checkedAtLaunch = snapshot.status === 'known' && snapshot.environment.check?.status === 'verified'
  const stillChecked = runEnvironmentCheck?.status === 'verified' && snapshot.status === 'known' && runEnvironmentCheck.configRevision === snapshot.configRevision
  return <div className="mt-2 min-w-0 text-my-xs text-my-secondary">
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span className={stillChecked ? 'text-my-secondary' : 'text-my-warning-text'}>{stillChecked ? '环境已人工核对' : checkedAtLaunch ? '启动时已核对 · 当前待复核' : '环境待核实'}</span><span>{serviceUses.length ? `任务引用 ${serviceUses.length} 项 · ${serviceUses.map(use => use.taskLabel).join('、')}` : '独立运行 · 未登记任务引用'}</span>
      {configChanged === true && <span className="text-my-warning-text">有配置变更 · 原实例未更新</span>}
      {configChanged === null && <span>启动版本未知</span>}
      {serviceUses.some(use => use.coordination !== 'ready') && <span className="text-my-warning-text">任务使用范围待核对</span>}
      <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>
    </div>
    <details className="mt-2">
      <summary className="cursor-pointer text-my-secondary">启动快照</summary>
      <dl className="mt-2 grid min-w-0 gap-2 break-words">
        <div><dt className="text-my-tertiary">实例</dt><dd className="select-text break-all font-mono">{run.id}</dd></div>
        {run.pid !== null && <div><dt className="text-my-tertiary">{run.pidRole === 'supervisor' ? '原生容器监督进程' : '前台进程'}</dt><dd>{run.pid}</dd></div>}
        <ApplicationSnapshotFacts snapshot={snapshot} />
        {stillChecked && !checkedAtLaunch && <div><dt className="text-my-tertiary">运行后环境核对</dt><dd>人工核对 · {runEnvironmentCheck.checkedBy} · {runEnvironmentCheck.checkedAt ? new Date(runEnvironmentCheck.checkedAt).toLocaleString() : '时间未知'}<br />{runEnvironmentCheck.targets.map(target => `${target.key}：${target.endpoint ?? '未知'}`).join('；') || '已核对无外部依赖'}</dd></div>}
      </dl>
    </details>
  </div>
}

export function ApplicationSnapshotFacts({ snapshot }: { snapshot: ApplicationRunSnapshot }): JSX.Element {
  return <>{snapshot.status === 'known' ? <>
          <div><dt className="text-my-tertiary">名称 / 配置修订</dt><dd>{snapshot.name} · {snapshot.configRevision}</dd></div>
          <div><dt className="text-my-tertiary">工作副本 / 实际目录</dt><dd className="break-all">{snapshot.root}<br />{snapshot.cwd}</dd></div>
          <div><dt className="text-my-tertiary">分支 / HEAD / 未提交</dt><dd className="break-all">{snapshot.workcopy?.branch ?? '未知或游离'} · {snapshot.workcopy?.head ?? '未知'} · {snapshot.workcopy?.dirty === true ? '有未提交内容' : snapshot.workcopy?.dirty === false ? '干净' : '未核实'}</dd></div>
          <div><dt className="text-my-tertiary">副本使用</dt><dd>{snapshot.workcopy?.access === 'consumer' ? '只读消费源码' : snapshot.workcopy?.access === 'writer' ? '可能写入源码或配置' : '未知'}</dd></div>
          <div><dt className="text-my-tertiary">入口</dt><dd className="break-all">{snapshot.entry.executable}{snapshot.entry.file && <><br />{snapshot.entry.file}</>}{snapshot.entry.npmScript && <> · npm {snapshot.entry.npmScript}</>}</dd></div>
          <div><dt className="text-my-tertiary">构建 / 源码</dt><dd>{snapshot.entry.build === 'existing-artifact' ? '运行现有产物，不自动编译' : '构建行为未知'} · 源码版本未核实</dd></div>
          {snapshot.entry.artifact && <div><dt className="text-my-tertiary">产物</dt><dd>{snapshot.entry.artifact.size} 字节 · {new Date(snapshot.entry.artifact.modifiedAt).toLocaleString()}</dd></div>}
          <div><dt className="text-my-tertiary">环境文件（依次加载）</dt><dd className="break-all">{snapshot.environment.envFiles.join(' → ') || '无环境文件'}；继承系统环境{snapshot.environment.overrideKeys.length > 0 && `；覆盖变量：${snapshot.environment.overrideKeys.join('、')}`}</dd></div>
          {snapshot.environment.check && <div><dt className="text-my-tertiary">环境核对</dt><dd className="break-all">{{ unknown: '待核实', local: '本地', test: '测试', other: '其他' }[snapshot.environment.check.selection]} · {snapshot.environment.check.method === 'manual' ? '人工核对' : snapshot.environment.check.method === 'adapter' ? '适配器核对' : '待核实'}{snapshot.environment.check.checkedAt && <> · {new Date(snapshot.environment.check.checkedAt).toLocaleString()}</>}{snapshot.environment.check.checkedBy && <> · {snapshot.environment.check.checkedBy}</>}<br />{snapshot.environment.check.targets.map(target => `${target.key}：${target.endpoint ?? '未知'}`).join('；') || '未列外部目标'}</dd></div>}
          <div><dt className="text-my-tertiary">就绪探针</dt><dd className="break-all">{snapshot.readiness.kind === 'none' ? '未配置' : `${snapshot.readiness.kind.toUpperCase()} ${snapshot.readiness.target ?? ''}`}</dd></div>
          <div><dt className="text-my-tertiary">声明端口</dt><dd className="break-all">{snapshot.ports.map(port => `${port.host}:${port.port}`).join('、') || '未声明'}</dd></div>
        </> : <div><dt className="text-my-tertiary">输入记录</dt><dd>启动目录、入口和环境快照未知</dd></div>}</>
}
