import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'

type AcpStartState<Request, Result> =
  | { readonly _tag: 'NotStarted' }
  | {
      readonly _tag: 'Starting'
      readonly request: Request
      readonly deferred: Deferred.Deferred<Result, unknown>
    }
  | { readonly _tag: 'Started'; readonly result: Result }

export function makeSessionStart<Request, Result>(
  startOnce: (request: Request) => Promise<Result>,
  sameRequest: (left: Request, right: Request) => boolean,
  mismatchedRequest: () => Error,
) {
  const stateRef = Effect.runSync(Ref.make<AcpStartState<Request, Result>>({ _tag: 'NotStarted' }))

  const start = Effect.fn('AcpSessionRuntime.start')(function* (request: Request) {
    const deferred = yield* Deferred.make<Result, unknown>()
    const effect = yield* Ref.modify(stateRef, (state) => {
      switch (state._tag) {
        case 'Started':
          return [Effect.succeed(state.result), state] as const
        case 'Starting':
          return [sameRequest(state.request, request) ? Deferred.await(state.deferred) : Effect.fail(mismatchedRequest()), state] as const
        case 'NotStarted':
          return [
            Effect.tryPromise({ try: () => startOnce(request), catch: error => error }).pipe(
              Effect.tap(result => Ref.set(stateRef, { _tag: 'Started', result }).pipe(
                Effect.andThen(Deferred.succeed(deferred, result)),
              )),
              Effect.onError(cause => Deferred.failCause(deferred, cause).pipe(
                Effect.andThen(Ref.set(stateRef, { _tag: 'NotStarted' })),
              )),
            ),
            { _tag: 'Starting', request, deferred } satisfies AcpStartState<Request, Result>,
          ] as const
      }
    })
    return yield* effect
  })

  return {
    start: (request: Request) => Effect.runPromise(start(request)),
    starting: () => {
      const state = Effect.runSync(Ref.get(stateRef))
      return state._tag === 'Starting' ? state.request : undefined
    },
  }
}
