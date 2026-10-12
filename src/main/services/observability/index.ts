/**
 * 观测服务入口（S0 G3 第一片）：worker 生命周期、查询/订阅、绑定身份接线。
 * 详见 service.ts / identity.ts / store-core.ts / observation-worker.ts 头注与 design.md §3/§4/§5。
 */
export {
  OBSERVATION_POLL_MS_ENV,
  OBSERVATION_OP_TIMEOUT_MS_ENV,
  OBSERVATION_UNAVAILABLE_EPOCH,
  OBSERVATION_WORKER_FILE_ENV,
  cleanupObservationRetention,
  closeObservationForProject,
  enableObservation,
  initObservationForRoot,
  noteTaskDir,
  observationHealth,
  onObservationEvents,
  queryObservations,
  refreshTaskAliases,
  setObservationCollectionEnabled,
  stopObservationWorker,
  subscribeObservations,
  unsubscribeObservations,
  type ObservationInitResult,
  type ObservationPushEnvelope,
  type ObservationServiceOverrides
} from './service'
export {
  createOrVerifyBinding,
  ensureInstallationIdentity,
  ensureRuntimeDir,
  readBinding,
  readInstallationIdentity,
  setCollectionEnabled,
  type BindingVerification,
  type GitBindingFacts,
  type InstallationIdentity,
  type PanelBinding
} from './identity'
export type { ControlDbState, StoreBindingContext, StoreDbState, StoreLimits, TaskAliasRecord, VerifyAliasesInput, VerifyAliasesResult } from './store-core'
// 注意：不要从本入口 re-export observation-worker 的运行时值——它是独立 esbuild 入口
// （与 diff-worker 同理：进入主 bundle 依赖图会让 worker 产物 require 主 bundle，
// worker 线程内加载 electron 即崩）。冒烟/类型引用直接从 observation-worker.ts 取。
