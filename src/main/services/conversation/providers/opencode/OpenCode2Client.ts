import type { OpenCodeClient } from '@opencode/client/effect'
import type { OpenCodeEvent } from '@opencode/protocol/groups/event'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Sse from 'effect/encoding/Sse'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { DaemonError } from '../../../../daemon/errors'

export type OpenCodeNativeEvent = typeof OpenCodeEvent.Type
type UnreadableExecution = { readonly type: 'unreadable-execution'; readonly sessionId: string }
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  type: Schema.String,
  data: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
})))

export function openCodeAuthorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`
}

export async function makeOpenCodeClient(baseUrl: string, password: string): Promise<OpenCodeClient> {
  const { OpenCode } = await import('@opencode/client/effect')
  return Effect.runPromise(HttpClient.HttpClient.pipe(
    Effect.flatMap(http => OpenCode.make({ baseUrl }).pipe(Effect.provideService(HttpClient.HttpClient,
      HttpClient.mapRequest(http, HttpClientRequest.setHeader('Authorization', openCodeAuthorization(password))).pipe(HttpClient.timeout('30 seconds')),
    ))),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
  ))
}

export async function subscribeOpenCode(
  baseUrl: string,
  password: string,
  signal: AbortSignal,
): Promise<Stream.Stream<OpenCodeNativeEvent | UnreadableExecution, unknown>> {
  const { OpenCodeEvent } = await import('@opencode/protocol/groups/event')
  const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(OpenCodeEvent))
  const connection = new AbortController()
  const forwardAbort = () => connection.abort(signal.reason)
  signal.addEventListener('abort', forwardAbort, { once: true })
  if (signal.aborted) forwardAbort()
  const timeout = setTimeout(() => connection.abort(), 10_000)
  try {
    const response = await fetch(`${baseUrl}/api/event`, {
      headers: { accept: 'text/event-stream', authorization: openCodeAuthorization(password) },
      redirect: 'error', signal: connection.signal,
    })
    const body = response.body
    if (!response.ok || !body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await body?.cancel()
      throw new DaemonError('E_UNAVAILABLE', `OpenCode v2 事件订阅失败（HTTP ${response.status}）。`)
    }
    return Stream.fromReadableStream({ evaluate: () => body, onError: error => error }).pipe(
      Stream.timeoutOrElse({ duration: '45 seconds', orElse: () => Stream.fail(new Error('OpenCode v2 事件流没有心跳。')) }),
      Stream.decodeText,
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.filterMap(frame => {
        const decoded = decodeEvent(frame.data)
        if (Result.isSuccess(decoded)) return Result.succeed<OpenCodeNativeEvent | UnreadableExecution>(decoded.success)
        const envelope = decodeEnvelope(frame.data)
        if (envelope._tag === 'Some' && envelope.value.type.startsWith('session.execution.') && envelope.value.data?.sessionID) {
          return Result.succeed<OpenCodeNativeEvent | UnreadableExecution>({ type: 'unreadable-execution', sessionId: envelope.value.data.sessionID })
        }
        return Result.failVoid
      }),
      Stream.ensuring(Effect.sync(() => { signal.removeEventListener('abort', forwardAbort); connection.abort() })),
    )
  } catch (error) {
    signal.removeEventListener('abort', forwardAbort)
    connection.abort()
    throw error
  } finally { clearTimeout(timeout) }
}
