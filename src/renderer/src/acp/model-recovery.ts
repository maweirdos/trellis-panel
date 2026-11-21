import type { AcpSessionRecord } from '../../../shared/types'
import { modelIdWithinLimit } from '@shared/model-selection'

/** Saved engine choices are candidates only; recovery must validate their exact IDs. */
export function getModelRecovery(session: AcpSessionRecord, message?: string): {
  modelFailure: boolean
  models: { modelId: string; name: string }[]
  environmentRequired: boolean
  canRecoverModel: boolean
} {
  const error = message ?? session.error ?? ''
  const legacyModelFailure = /cannot replay saved(?: session)? model|saved model.*(?:unavailable|not advertised)|ACP_MODEL_UNSUPPORTED/i.test(error)
  const modelFailure = session.recovery?.kind === 'model-unavailable' || (!session.recovery && legacyModelFailure)
  const environmentRequired = /authentication required|AUTH_REQUIRED|not authenticated|not logged in|\b401\b|\b403\b|Forbidden|OpenCode.*free tier/i.test(error)
  const modelConfigs = (session.configOptions ?? []).filter((option) => option.category === 'model')
  const candidates = modelConfigs.length === 1
    ? modelConfigs[0].options.map((option) => ({ modelId: option.value, name: option.name }))
    : session.models ?? []
  const models = [...new Map(candidates.filter((model) => model.modelId.trim() && modelIdWithinLimit(model.modelId)).map((model) => [model.modelId, model])).values()]
  const offline = ['closed', 'disconnected', 'error'].includes(session.status)
  const canRecoverModel = Boolean(modelFailure && models.length > 0 && offline && session.connectionGeneration && session.canResume
    && session.archivedAt === undefined && session.historyKind !== 'transcript' && session.historyKind !== 'legacy' && !session.cleanupRequired && !environmentRequired)
  return { modelFailure, models, environmentRequired, canRecoverModel }
}
