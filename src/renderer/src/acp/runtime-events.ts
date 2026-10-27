import type { TimelineEvent } from '../../../shared/types'

/** Both engines publish the same app-facing conversation facts. */
export function isConversationRuntimeEvent(event: Pick<TimelineEvent, 'source'>): boolean {
  return event.source === 'acp' || event.source === 'pi'
}
