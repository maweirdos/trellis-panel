/**
 * IPC 错误码契约（决策 TPD-003）。
 *
 * 约定：所有 `{ ok: false }` 响应必须携带机器可读 `code`；`error` 仍是面向人的文案。
 * 渲染层只读 `error` 展示，可按 `code` 做分支；缺 `code` 的失败响应视为 legacy 数据，
 * 不应在新代码中出现。
 */

export const IpcErrorCode = {
  /** 未打开项目 */
  NoProject: 'E_NO_PROJECT',
  /** 目标资源不存在 */
  NotFound: 'E_NOT_FOUND',
  /** 并发修改冲突（mtime 不符等），应刷新后重试 */
  Conflict: 'E_CONFLICT',
  /** 参数缺失/非法/越界 */
  InvalidArg: 'E_INVALID_ARG',
  /** 未授权（token 缺失或不符） */
  Unauthorized: 'E_UNAUTHORIZED',
  /** 被安全策略/确认门槛拒绝 */
  Denied: 'E_DENIED',
  /** 超时熔断 */
  Timeout: 'E_TIMEOUT',
  /** 上游服务（Jira/GitLab/WeKnora/AI 等）失败 */
  Upstream: 'E_UPSTREAM',
  /** 本地文件系统/进程 IO 失败 */
  Io: 'E_IO',
  /** 未归类失败 */
  Unknown: 'E_UNKNOWN'
} as const

export type IpcErrorCode = (typeof IpcErrorCode)[keyof typeof IpcErrorCode]

/** 统一失败信封：code 必带，extra 用于按域附加字段（如 conflict、hits） */
export interface IpcFail {
  ok: false
  code: IpcErrorCode
  error: string
}

export function ipcFail(code: IpcErrorCode, error: string, extra?: Record<string, unknown>): IpcFail & Record<string, unknown> {
  return { ok: false, code, error, ...(extra ?? {}) }
}

/** 高频语义的直接构造器，避免调用点重复文案 */
export const noProject = (): IpcFail => ipcFail(IpcErrorCode.NoProject, '未打开项目')
export const notFound = (what: string): IpcFail => ipcFail(IpcErrorCode.NotFound, `任务不存在: ${what}`)
