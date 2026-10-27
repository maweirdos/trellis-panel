import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import { asObject } from './timeline'

/** Project only a native Pi write/edit whose start and successful result agree. */
export function piGeneratedDocument(events: TimelineEvent[], origin: TimelineEvent | undefined, session: AcpSessionRecord | undefined): string | null {
  if (!origin || !session || session.engine !== 'pi' || origin.source !== 'pi' || origin.kind !== 'tool-call' ||
    !origin.turnId || !origin.connectionGeneration || origin.sessionId !== session.sessionId ||
    projectRootKey(origin.projectRoot) !== projectRootKey(session.projectRoot)) return null

  const start = origin.payload
  const name = start?.title
  const id = start?.toolCallId
  const path = asObject(start?.rawInput)?.path
  if (start?.tag !== 'pi_tool_start' || (name !== 'write' && name !== 'edit') || typeof id !== 'string' || !id ||
    typeof path !== 'string' || !/\.(?:html?|svg)$/i.test(path) || path.includes('[redacted]')) return null

  const originIndex = events.indexOf(origin)
  if (originIndex < 0) return null
  const end = events.slice(originIndex + 1).find(event => event.source === origin.source && event.kind === 'tool-call' &&
    event.sessionId === origin.sessionId && projectRootKey(event.projectRoot) === projectRootKey(origin.projectRoot) &&
    event.turnId === origin.turnId && event.connectionGeneration === origin.connectionGeneration &&
    event.payload?.toolCallId === id && event.payload?.tag === 'pi_tool_end' && event.payload?.title === name)
  if (end?.payload?.status !== 'completed') return null
  const result = asObject(end.payload.rawOutput)
  if (!Array.isArray(result?.content)) return null
  const messages = result.content.map(asObject).filter(block => block?.type === 'text' && typeof block.text === 'string')
  const succeeded = messages.some(block => name === 'write'
    ? block?.text === `Successfully wrote to ${path}`
    : typeof block?.text === 'string' && /^Successfully replaced [1-9]\d* block\(s\) in ([\s\S]*)\.$/.exec(block.text)?.[1] === path)
  return succeeded ? path : null
}
