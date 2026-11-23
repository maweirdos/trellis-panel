# T3 ACP integration

Runtime sessions and the connection probe use T3 Code's `packages/effect-acp` from commit `989d7ec882aa1b7e510cd44f93ab5fe61368058b`, vendored under `src/main/services/acp/t3-core`. The original MIT notice is packaged from `resources/licenses/T3-Code-MIT.txt`.

`runtime-model.ts` extracts T3's ACP content rendering and replay marker from `packages/provider-acp/src/server/runtimeModel.ts` and tool patch merging from `packages/shared/src/toolActivity.ts`. `session-config.ts` takes grouped choice flattening from `packages/provider-acp/src/server/sessionConfig.ts`.

`acp-session-start.ts` ports the `NotStarted` / `Starting` / `Started` transitions from `packages/provider-acp/src/server/AcpSessionRuntime.ts`. The Trellis adapter supplies exact request identity, Windows Job ownership, and durable session records. `keyed-lock.ts` carries `packages/shared/src/KeyedLock.ts`, which T3's `ProviderSessionManager` uses to serialize ownership changes. Trellis applies the lock per provider family and rechecks the current owner and protected work inside it.

The conversation read model follows T3's `ProviderEventIngestor` and `ProjectionStore` boundary. Committed history events enter the SQLite projection by source cursor. `wire-projection.ts` carries the UTF-8 bound from T3's `WireProjection.ts`. The shared renderer reducer uses T3 `ProjectionStore.ts`'s `upsertById` to apply successive item revisions.

`npm run check:acpx` verifies the locked and installed versions in `patches/acp-v2-sdk.json`, the ACP v2 SDK export, and CommonJS loading of Effect. Install, dev, build, typecheck, and packaging keep this gate. The app reads archived acpx history directly from disk.

The core uses the v2 request groups and notification schemas. The initialize decoder also reads the remote major version to report `E_INCOMPATIBLE` before session creation. A reply claiming v2 with an invalid capability tree yields `E_PROTOCOL`.

## Deviations

- `AcpPromptOptions.onInsertion` exposes the agent's insertion response. `acceptIdle` filters replayed or duplicate idle updates. The T3 deferred completes after insertion and a fresh terminal update in either order.
- Provider request capability checks live in `AcpV2Client.operation`. The vendored core dispatches provider RPCs after the adapter verifies the v2 initialize capability.
- The vendored transport omits the raw and decoded frame logger and its enablement options. Handler and decoder logs carry fixed messages without wire payloads or failure objects.
- RPC deadlines sit in the Trellis adapter. Initialize, create, or resume failure closes the same owner before returning. A stop that crosses an in-flight setup fences off that setup's late response.
- A foreground turn reaching its deadline sends `session/cancel`. If it has not settled after the 10-second grace period, the turn fails with `E_TIMEOUT` and the owner disconnects for cleanup.
