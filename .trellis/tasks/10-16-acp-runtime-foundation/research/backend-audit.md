# Research: ACP backend runtime and protocol audit

- Query: Why are real ACP agents unusable, what does the current backend actually implement, and which foundations need repair or replacement?
- Scope: Internal source audit and isolated in-memory fixtures; upstream protocol/version research is owned by the parent session.
- Date: 2026-10-16
- Baseline: Existing working files, including uncommitted project-scope improvements. No product code or configuration was modified.
- Confirmed delivery scope from parent: First supported real-runtime acceptance pair is **Codex + Claude Code**. Both must be validated; OpenCode is not part of the required matrix.

## Findings

The current service is a handwritten NDJSON/JSON-RPC client with a small event projection and JSON transcript store. It is not an embedded OpenHands runtime. A standard agent can initialize and create a session, but the next prompt omits its required session identity. Fixing UI alone cannot make this chain work. The permissive mock conceals this defect and several other protocol gaps.

### Files found

| File | Responsibility |
| --- | --- |
| `src/main/services/acp.ts` | Agent presets/discovery, process creation, handwritten RPC, event normalization, permission decisions, session lifecycle and persistence. |
| `src/main/ipc/acp.ts` | Thin IPC wrappers; inject current project root for list/new only. |
| `src/shared/types.ts:1613` | Agent/session/permission/timeline interfaces; no negotiated runtime capability or agent-session identity model. |
| `src/preload/index.ts:120` | Public ACP invoke/subscription bridge. |
| `src/shared/ipc-channels.ts:246` | Registered ACP invocation/event channel names. |
| `scripts/smoke/acp.mjs` | Real service with mocked Electron and an external mock-agent process. |
| `scripts/smoke/acp-project-scope.mjs` | Current-project history, pending-permission projection, IPC list-root injection, and renderer async-generation regressions. |
| `scripts/smoke/acp-mock-agent.mjs` | Permissive protocol fixture and fixture self-test. |
| `electron-builder.yml:6` | Packaged files exclude the mock-agent source script. |

### Confirmed defects and gaps

Priority: P0 blocks the normal real-agent path; P1 breaks reliable operation or recovery; P2 affects compatibility, diagnostics, or scale. A gap can be confirmed from source even when no particular installed agent was exercised.

| Priority | Finding and verified source anchors | Consequence and repair direction |
| --- | --- | --- |
| P0 | `acp.ts:534-538` only prints the `session/new` result ID. `ActiveSession` at `109-123` and shared metadata at `types.ts:1631-1643` have no agent-session identity. `acp.ts:559` sends only `prompt`; `575` sends the local panel ID in cancel. | Strict agent fixture rejects prompt with `sessionId required or invalid`. Keep panel conversation ID and protocol session ID separately; use the protocol ID in every session operation and validate incoming IDs. Never infer equivalence. |
| P0/P1 | Initialize input lacks `clientCapabilities` (`acp.ts:528-533`); the result is discarded, including protocol version, authentication methods and capabilities. There is no `authenticate` implementation or IPC surface. `session/new {}` still becomes ready (`534-538`). | Fixture accepts protocol `999` and missing new-session ID as ready. Agents validating initialize input or requiring authentication can fail before prompting. Validate/retain initialization and session results, negotiate protocol/capabilities, and expose authentication-required with a defined retry/login path. An already authenticated CLI may not require authenticate; do not force it for all runtimes. |
| P1 | Startup/handshake failure calls `teardown` (`539-540`); `teardown` clears maps and deletes tracking but never terminates the child (`448-458`). Process error, close, and async handshake catch all call teardown (`519-540`). | Fixture shows failed initialize leaves a live untracked process. Killing during initialize emits `closed -> error` because the rejected handshake tears down again. Implement idempotent terminal transitions, child ownership until confirmed exit, and bounded cleanup on all startup failures. |
| P1 | `promptAcpSession` allows both ready and busy (`551`), starts another RPC each time, and any completion can set ready (`559-567`). | Two simultaneous prompts are transmitted. A first completion can show ready while a second turn is still running. Enforce one active turn per protocol session, or implement an explicit queue with turn IDs. |
| P1 | Cancel only writes a notification and returns success (`572-576`). It does not settle pending permissions or wait for prompt stop. Permission timeout sends JSON-RPC error `-32000` (`373-377`). | Wrong-ID cancellation cannot stop the real agent; even with identity fixed, approvals remain actionable after cancel. Fixture confirms both. Mark cancellation in progress, send the correct session ID, resolve pending approvals with cancelled outcomes, observe the original prompt completion, and provide a bounded stop/kill fallback. |
| P1 | Permission option normalization drops `reject_always`, coercing unknown kinds into `allow_once` (`354-359`, `types.ts:1651-1655`). Remembered approval picks the first option other than reject_once (`363-369`). `respondAcpPermission` removes pending/timer before validating the selected ID (`590-593`). | Fixture converts reject_always to allow_once, then selects its original reject option automatically after prior remembered approval. This proves incorrect classification/selection, **not** that the agent grants a rejected option. Invalid choice destroys the request and prevents valid retry. Preserve all kinds and original option IDs, validate before consuming, and keep approval policy explicit rather than equating a kind/title label with an identical action. |
| P1 | Updates accept any `params.sessionId` (`394-395`); permissions also ignore their protocol session ID (`346-392`). | Fixture accepts foreign-session text and permissions onto the current conversation. Validate ownership against the stored agent-session ID before processing. |
| P1 | Only the initial `tool_call` is handled (`408-422`); `tool_call_update` is ignored. Content arrays/raw structured outputs are discarded, while plan looks for `steps` (`423-427`). | Fixture shows a standard `tool_call_update` completion creates no event. Tool cards can remain pending forever. Normalize initial and incremental updates by toolCallId, preserve supported structured content, and map official plan entries. |
| P1 | Each raw stdout Buffer is decoded independently (`501-502`). | Splitting the UTF-8 bytes of `你好` across two chunks produces `���好` in the real service. Use a streaming UTF-8 decoder or stream encoding, then NDJSON framing. |
| P1 | List/new inject project root (`ipc/acp.ts:22-31`), while prompt/cancel/kill/respond accept global IDs without root or ownership checks (`34-40`, service `548-599`). | IPC fixture with project B current still dispatches project A IDs. Existing renderer safeguards and root-filtered history are valuable, but do not establish backend ownership. Inject the current root into all mutations and compare the stored owner; include root in status/permission envelopes. Preserve intentionally running background sessions across switches unless product requirements say otherwise. |
| P1 | Persistence stores a local transcript, not resumable agent state (`139-179`, `types.ts:1645-1648`). There is no load/resume path in service, IPC, preload or types. Stale persisted statuses are returned verbatim. | A record persisted as busy/ready can be displayed after restart while `sessions.get(id)` fails. Fixture returns stale busy with no live process. Separate historical transcript from live connection status; persist agent-session ID and runtime identity; expose capability-gated native load/resume, and label unsupported history as read-only. |
| P2 | Discovery only checks command head via synchronous `where/which` (`54-75`), caches forever, and removes quotes before constructing the probe shell command (`65`). Launch uses the entire shell command (`491-496`). Config only has id/name/command/enabled (`types.ts:1616-1622`). | Available means only head found, not ACP flag/version/auth readiness. Installing/fixing a CLI can leave cached false until app restart. A quoted executable path with spaces becomes an unquoted probe. Use an explicit executable + argv launch specification, Windows .cmd/.exe resolution policy, refreshable staged discovery, and actionable errors. `shell:true` currently does support shell/npm wrappers; it is not itself proof that every Windows launch fails. |
| P2 | Mock is unconditionally available (`83`), requires `node` and `scripts/smoke/acp-mock-agent.mjs` (`46-48`), but packaged `files` include only out and package.json (`electron-builder.yml:6-9`). | Packaged mock cannot be assumed runnable. Either package a deliberate diagnostic runtime correctly or keep this development fixture out of the normal agent catalog. Packaged artifact execution was not performed in this audit. |
| P2 | NDJSON parser swallows parse and handler exceptions (`508-512`); unbounded partial line buffer (`502-506`); RPC reduces errors to message only (`336`); write ignores writable state/backpressure (`297-300`). | Invalid/mismatched protocol appears as a long timeout, and auth/error codes are lost. Use the maintained transport/schema layer, preserve safe structured error codes, bound buffers, and handle writes/stream closure explicitly. |
| P2 | Events truncate at 800 and persist whenever length % 20 == 0 (`200-202`). Once capped, length is always 800. Persistence failures are silent (`139-147`); Trellis events are not persisted immediately (`235-239`). | Every subsequent token event after the cap synchronously rewrites the whole record; early conversation is truncated. Use chunk coalescing and a debounced/append-oriented durable store, with visible storage failure and flush at lifecycle boundaries. Decide explicit retention separately from protocol resume. |
| P2 | Prompt/cancel/kill/permission failures return `{ok:false,error}` without a stable IPC code (`550-553`, `567-568`, `574`, `581`, `593-599`); inputs are TypeScript assertions rather than runtime schemas. | Violates project IPC conventions and prevents consistent retry/recovery UI. Validate at the boundary and return structured error codes and launch/handshake/auth/session/prompt stage information. |

### Capability boundary

- Agent-to-client requests other than permission return method-not-found (`acp.ts:349-352`). No fs/read_text_file, fs/write_text_file or terminal methods are implemented. This is an actual capability gap, but it does **not** prove every agent needs those client services: some execute tools in their own runtime. Advertise only implemented capabilities and test each selected runtime against that declaration.
- No negotiated agent info, model/mode choices, commands, load capability or config options are retained (`528-538`; `428` explicitly ignores other updates). Prompt content is text only (`559`). Do not expose model/mode controls until their operation is supported and round-trips against the chosen adapter.
- Child environment is inherited process environment plus color flags (`495`); there is no per-runtime environment/cwd/argument configuration. Do not assume the panel's separate AI-provider configuration authenticates an external ACP adapter.
- MAX_ACTIVE=4 is global to the process (`125-127`, `462`). Prompt errors can leave a child retained in error state (`567`), while handshake errors remove ownership without killing. Capacity must count actual owned processes, not whichever entries happen to remain in a map.
- Windows kill uses taskkill /T /F (`437-439`); POSIX kills only the immediate process (`441`). Windows process-tree shutdown and packaged paths need real runtime validation; mock EventEmitters cannot prove OS cleanup.

### Existing test coverage and why it misses real failures

- `acp-mock-agent.mjs:47` discards notifications, including session/cancel. It hardcodes session ID `mock-s1` (`54`, `58`) and never validates prompt sessionId (`59`). Its initialize response lacks capabilities (`50`). It completes tools on a fixed 120ms timer regardless of permission answer (`94-100`), uses a second `tool_call` rather than `tool_call_update` (`96`), and sends content as a string rather than standard content arrays. Its alleged denial scenario bypasses the permission request based on prompt text (`60-68`). Thus successful smoke demonstrates the panel's own simplified dialect, not ACP conformance.
- `acp.mjs:65-89` covers the happy mock path and first permission response; `91-125` covers transcript writing, Trellis signal routing, and explicit kill. No strict protocol identity, malformed initialization, authentication, cancel completion, concurrent prompts, UTF-8 split, real permission rejection, or actual adapter is exercised. Its finally block removes temp files without unconditional shutdown (`134-136`), so failure-path test cleanup also needs care.
- `acp-project-scope.mjs:47-108` usefully covers active/history root filtering, canonical root variants, restoration of only live approvals, stale/timeout approvals, and another project remaining alive. `130-136` verifies current-root injection only for list, not mutations. `236-296` validates renderer async ordering in a hook harness, not the native app or real adapter. Preserve these regressions while extending ownership and lifecycle coverage.
- Package scripts provide build/typecheck only; ACP smokes are manual (`package.json:9-16`). No ACP SDK dependency is present in the inspected package manifest.

### Executed safe fixtures

Two one-shot `node --input-type=module` runs bundled the actual service (and, separately, actual IPC wrappers) with `esbuild.build({write:false})`, imported the in-memory bundle, and substituted EventEmitter children, in-memory fs, Electron, store and broadcasts. Fixture responses/notifications were injected as NDJSON Buffers. No external agent was launched, project files changed, credentials read, or model prompt executed. Both fixture runs exited 0; they verify defects rather than constitute passing acceptance tests.

Observed outputs:

```text
initialize.clientCapabilities absent: true
strict prompt: {ok:false,error:"sessionId required or invalid"}
prompt params: {prompt:[{type:"text",text:"fixture only"}]}
cancel uses local ID: true
unsupported protocol=999 accepted as ready: ready
session/new {} accepted as ready: ready
handshake failure leaves child alive after losing tracking: true
busy permits concurrent transmitted prompts: 2
tool_call_update ignored: true
foreign-session update accepted: true
UTF-8 split output: ���好
reject_always normalized to: allow_once
invalid permission choice followed by valid retry: request no longer exists
persisted busy with no live process: busy
kill during initialize statuses: closed -> error
cancel leaves approval actionable: true
permission timeout response: error -32000 / permission timeout
project B current: prompt/cancel/kill/permission for A forwarded without owner context
```

The existing disk-writing smoke scripts were inspected, not executed in this research pass. These fixtures do not prove real CLI startup/authentication, OS process teardown, packaged execution or browser UX.

### Recommended repair versus replacement boundary

1. Keep the public IPC domain, project ownership concept, Trellis first-party event rail, existing transcripts, and current project-scope regression intent. Preserve uncommitted edits and migrate old records tolerantly.
2. Replace the handwritten low-level protocol transport/validation with the maintained official TypeScript SDK after pinning and testing a compatible version. Parent research establishes that the old "no official client SDK" premise is obsolete. SDK adoption does not solve process launch, runtime authentication UX, session ownership, state transitions or persistence by itself.
3. Put process launch/discovery, negotiated protocol connection, conversation/turn lifecycle, and durable event projection behind separate testable boundaries. Maintain panel ID, agent-session ID, process/connection identity, and turn identity explicitly. A new runtime type must not silently reinterpret old command records.
4. First delivery gate for **both Codex and Claude Code**: real adapter launches on Windows; initialize/auth/new validates; two sequential turns succeed; actual tool progress and selected/rejected/cancelled permission outcomes appear; cancel settles; exit kills the tree; failures retain a reason and cleanup. Strict fixtures must be mandatory before UI redesign is accepted. Do not substitute one runtime's success for the other or extend the required matrix to OpenCode.
5. Second delivery gate: recover/reconnect based on advertised capabilities; honest historical/read-only fallback; capability-backed models/modes and any required fs/terminal services; multi-project mutation isolation; packaged runtime-path validation. These are required for a complete foundation, even if sequenced after first real usability.

### External references and versions

- Parent-owned `research/provenance-and-upstream.md` contains the authoritative upstream/provenance investigation and package checks; no duplicate external research was performed here.
- Parent verified [official permission contract](https://agentclientprotocol.com/protocol/v1/tool-calls): all four kinds, including reject_always, are UI hints; selected outcomes preserve the original optionId; prompt cancellation must cancel pending permission requests. This confirms the permission shape/cleanup gaps above, but the fixture does not establish any permission bypass.
- Parent verified [official TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) and maintained [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp); reported registry checks on 2026-10-16: SDK 1.8.0, Codex adapter 2.2.2, Claude adapter 0.91.0. Final lockfile/version decision belongs to design/implementation.
- Inspected manifest: Electron `^44.4.3`, TypeScript `^5.7.2`, Zod `^4.6.5`; no ACP SDK dependency. Manifest ranges are not proof of installed versions.

### Related specs

- `.trellis/workflow.md`: research persists under the active task; planning precedes implementation; real acceptance remains distinct from mock validation.
- `.trellis/spec/backend/ipc-conventions.md`: registered channels, thin wrappers, structured ipcFail codes, correlated event streams.
- `.trellis/spec/backend/type-safety.md` and `.trellis/spec/shared/code-quality.md`: runtime-schema-driven contracts, explicit types, no silent failures.
- `.trellis/spec/backend/error-handling.md`: critical dependency failures must surface; do not swallow failure causes.
- `.trellis/spec/backend/environment.md`: runtime/package path behavior and environment isolation need explicit verification.
- `.trellis/spec/frontend/my-ui-module.md:104-109`: project identity and root-injected session-list contract. Preserve current filtering and async-generation protections while strengthening mutation ownership.

## Caveats / Not Found

- No real installed adapter was started or authenticated. Source/fixture defects are proven; the exact first failure observed by this user remains to be reproduced in the native app with their selected runtime.
- No packaged artifact was launched. The omitted mock script is established from package configuration; real packaged behavior still needs an acceptance probe.
- No account credentials, user settings values, or external conversations were read. Runtime environment/authentication conclusions are capability/configuration gaps, not claims about this user's secrets or login state.
- Native session resume, modes/models, and fs/terminal availability vary by runtime. Capability detection and tested support must decide behavior; absence of client-hosted tools does not automatically invalidate an agent that runs its own tools.
- SDK migration is recommended for transport/schema upkeep, not wholesale replacement of the app or its task model. It must retain project isolation and explicitly cover startup/cleanup/permissions; simply importing the SDK cannot close those defects.
