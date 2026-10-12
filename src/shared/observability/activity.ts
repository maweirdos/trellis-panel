/**
 * 活动投影（S0 G3 第二片，design §5.3；纯函数，无 Electron/IO 依赖）：
 * 任务原始 status（原值）、文件变化（watcher 事件经 task-identity）、
 * ACP/时间线事件（emitTrellisTimeline 轨道）、归档位置**分列**显示。
 *
 * 语义红线（PRD FR3 / design §5.3）：
 * - 不把回执升级为阶段完成：本投影不消费观测回执，也不从 task.status 或 mtime
 *   生成阶段完成链；只显示来源自带语义的事实。
 * - 无稳定事件 ID 的来源不强行合并为同一事实：条目键 = `<source>:<id>`，
 *   同一 id 出现在两个来源即两条独立条目。
 * - 任务路径无法确定的事件保留项目级/未归属（taskDir=null），不借当前 UI 选中
 *   任务补全归属；任务视图只显示能归属到该任务的事件。
 * - 时间为来源事件自带 Unix 毫秒；排序展示，不推导持续时间或顺序语义。
 */

export type ActivityEventSource = 'file' | 'timeline'

export interface ActivityEventInput {
  /** 来源内稳定事件 ID；来源没有稳定 ID 时由调用方生成来源内唯一键。 */
  id: string
  atMs: number
  source: ActivityEventSource
  text: string
  /** 任务归属（不可确定为 null：项目级/未归属，不猜）。 */
  taskDir: string | null
}

export interface ActivityTaskRecord {
  /** 任务记录原始状态（原值显示；空/未知为 null）。 */
  status: string | null
  updatedAtMs: number | null
}

export interface ActivityArchiveInfo {
  archived: boolean
  /** 仓库相对目录（如 .trellis/tasks/a-b 或 .trellis/tasks/archive/2026-10/a-b）。 */
  repoRelativeDir: string | null
}

export interface ActivityInput {
  taskRecord: ActivityTaskRecord | null
  events: readonly ActivityEventInput[]
  archive: ActivityArchiveInfo
  /** 当前查看的任务目录；null = 不按任务过滤（会话/项目视图）。 */
  taskDir: string | null
}

export interface ActivityEntryView {
  key: string
  atMs: number
  source: ActivityEventSource
  text: string
  /** 条目自身归属（会话视图里显示各条目属于哪个任务；null=未归属）。 */
  taskDir: string | null
}

export interface ActivityColumnView {
  key: 'task-record' | 'files' | 'timeline' | 'archive'
  label: string
  entries: ActivityEntryView[]
  /** 列级说明（如空态的诚实解释）；无则 null。 */
  note: string | null
}

export interface ActivityProjectionResult {
  columns: ActivityColumnView[]
}

const MAX_ENTRIES_PER_COLUMN = 30

function belongsTo(event: ActivityEventInput, taskDir: string | null): boolean {
  // 会话/项目视图：全部显示（未归属条目保留，不因无归属而消失）
  if (taskDir === null) return true
  // 任务视图：只显示能归属到该任务的事件；未归属不借当前选中任务补全
  if (event.taskDir === null) return false
  return event.taskDir === taskDir
}

/** 活动投影（纯函数）：分列、不合并、不升级阶段。 */
export function projectActivity(input: ActivityInput): ActivityProjectionResult {
  const byTimestamp = (a: ActivityEntryView, b: ActivityEntryView): number => b.atMs - a.atMs
  const take = (source: ActivityEventSource): ActivityEntryView[] =>
    input.events
      .filter((ev) => ev.source === source && belongsTo(ev, input.taskDir))
      .map((ev) => ({ key: `${source}:${ev.id}`, atMs: ev.atMs, source, text: ev.text, taskDir: ev.taskDir }))
      .sort(byTimestamp)
      .slice(0, MAX_ENTRIES_PER_COLUMN)

  const statusRaw = input.taskRecord?.status ?? null
  const taskRecordEntry: ActivityEntryView = {
    key: 'task-record:status',
    atMs: input.taskRecord?.updatedAtMs ?? 0,
    source: 'timeline',
    text: statusRaw !== null && statusRaw.length > 0 ? statusRaw : '未知（task.json 未提供状态）',
    taskDir: input.taskDir
  }

  const columns: ActivityColumnView[] = [
    {
      key: 'task-record',
      label: '任务记录',
      entries: input.taskRecord === null ? [] : [taskRecordEntry],
      note: '任务记录状态原值显示；不据此推导实施/检查等阶段已完成'
    },
    {
      key: 'files',
      label: '文件变化',
      entries: take('file'),
      note: '文件保存只说明文件变化，不代表检查通过或规范已遵守'
    },
    {
      key: 'timeline',
      label: 'ACP / 时间线',
      entries: take('timeline'),
      note: '按事件来源分列显示；不同来源不合并为同一事实'
    },
    {
      key: 'archive',
      label: '归档位置',
      entries:
        input.archive.repoRelativeDir === null
          ? []
          : [
              {
                key: `archive:${input.archive.repoRelativeDir}`,
                atMs: 0,
                source: 'timeline',
                text: input.archive.archived
                  ? `归档任务目录：${input.archive.repoRelativeDir}`
                  : `活跃任务目录：${input.archive.repoRelativeDir}`,
                taskDir: input.taskDir
              }
            ],
      note: '归档位置从实际目录读取；本地归档与外部系统状态独立展示'
    }
  ]
  return { columns }
}
