/**
 * 阅读会话状态机（S0 G2，design §6.2）——渲染端纯逻辑，无 React/zustand/IPC 依赖。
 *
 * 语义（不变式，冒烟逐条断言）：
 * - 首次成功加载建立 baseRevision/baseText（本次基线）；displayedRevision 为当前展示版。
 * - 外部变化只更新 latestRevision 标记并提示——绝不自动切换 base/displayed。
 * - 「阅读新版」才替换 displayed，且不改变首次基线 base。
 * - 「以当前为本次基线」显式重置 base := displayed。
 * - 会话内快照随文档关闭丢弃（closeSession → 空态）；不跨重启持久化。
 */

export interface ReadingVersion {
  /** 内容 revision（sha256 前 16 hex）。 */
  revision: string
  /** 该版本全文（会话内内存快照，不持久化）。 */
  text: string
}

export interface ReadingSessionState {
  /** 本次打开（首次成功加载）建立的基线；null = 会话尚未建立。 */
  base: ReadingVersion | null
  /** 当前展示版本；null = 尚未成功加载（读取失败时保留旧值即保留此字段）。 */
  displayed: ReadingVersion | null
  /** 外部变化探测到的最新候选；null = 无新版提示。 */
  latest: ReadingVersion | null
}

export const EMPTY_READING_SESSION: ReadingSessionState = {
  base: null,
  displayed: null,
  latest: null
}

/** 文档打开/重开：首次成功加载建立基线，displayed 同版，无更新提示。 */
export function sessionOpened(_state: ReadingSessionState, firstLoad: ReadingVersion): ReadingSessionState {
  return { base: firstLoad, displayed: firstLoad, latest: null }
}

/**
 * 外部变化（watcher/重读）只更新 latest 标记：
 * 候选与当前展示同版时清除提示；base/displayed 永不被此函数触碰。
 */
export function externalChangeDetected(state: ReadingSessionState, candidate: ReadingVersion): ReadingSessionState {
  if (state.displayed !== null && candidate.revision === state.displayed.revision) {
    if (state.latest === null) return state
    return { ...state, latest: null }
  }
  return { ...state, latest: candidate }
}

/** 「阅读新版」：用最新候选替换 displayed；首次基线 base 不变；无候选为 no-op。 */
export function readNewVersion(state: ReadingSessionState): ReadingSessionState {
  if (state.latest === null) return state
  return { base: state.base, displayed: state.latest, latest: null }
}

/**
 * 「以当前为本次基线」：base := displayed（此后「与本次打开版本比较」以当前展示版为基准）。
 * 尚未成功加载（displayed=null）时为 no-op；latest 提示不受影响（仍可继续比较/阅读新版）。
 */
export function rebaseToCurrent(state: ReadingSessionState): ReadingSessionState {
  if (state.displayed === null) return state
  if (state.base !== null && state.base.revision === state.displayed.revision) return state
  return { ...state, base: state.displayed }
}

/** 文档关闭：会话快照丢弃（无跨重启草稿历史——design §6.2）。 */
export function closeSession(): ReadingSessionState {
  return EMPTY_READING_SESSION
}

/** 是否存在待处理的「发现新版本」提示。 */
export function hasPendingUpdate(state: ReadingSessionState): boolean {
  return (
    state.latest !== null && state.displayed !== null && state.latest.revision !== state.displayed.revision
  )
}

/** 「查看变化」的比较目标：当前展示版 vs 最新候选（无候选时调用方自行回退最近提交基线）。 */
export function compareTargets(state: ReadingSessionState): {
  current: ReadingVersion | null
  candidate: ReadingVersion | null
} {
  return { current: state.displayed, candidate: hasPendingUpdate(state) ? state.latest : null }
}

/** 会话键：workspaceId/taskRef/归一化路径三段，缓存作用域与 design §5.1 一致。 */
export function readingSessionKey(scope: { workspaceId: string; taskRef?: string }, relativePath: string): string {
  const norm = relativePath.split('\\').join('/')
  return `${scope.workspaceId}::${scope.taskRef ?? ''}::${norm}`
}
