export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128
export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576
export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1_048_576

export function isThreadReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES
}

export type ThreadResumePlan =
  | { readonly mode: 'replay'; readonly afterSequence: number; readonly throughSequence: number }
  | { readonly mode: 'snapshot' }

export function decideThreadResume(input: {
  readonly afterSequence: number
  readonly highWater: number
  readonly replayEventCount: number
  readonly replayEncodedBytes: number
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: 'snapshot' }
  }
  return {
    mode: 'replay',
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  }
}
