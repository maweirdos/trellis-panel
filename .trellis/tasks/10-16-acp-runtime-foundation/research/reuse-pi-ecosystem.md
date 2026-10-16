# Research: Pi ecosystem reuse for a Codex and Claude ACP host

> Clean-room research notes. The findings below are independently written observations about package boundaries, protocol behavior, and compatibility evidence. No upstream source, documentation passage, or patch has been copied into this repository.

- Query: Can Pi provide a mature reusable ACP integration foundation for Trellis while retaining Codex CLI and Claude Code as the actual agents?
- Scope: mixed; primary upstream docs, manifests, selected source/tests, live npm metadata, and local historical reference records
- Date: 2026-10-16
- Constraints: Research only; no installs, credentials, real prompts, runtime launches, copied implementations, or changes outside this research file.

## Findings

### 1. Decision summary

Pi is relevant, but its projects solve three different integration directions:

| Project | Direction and reusable unit | Fit for Trellis hosting Codex + Claude |
| --- | --- | --- |
| Mario Zechner's Pi / `earendil-works/pi` | An agent engine; published SDK and Pi-specific subprocess RPC client | Useful if Trellis intentionally adds Pi as another engine. Embedding it gives Pi's tool/session/model loop; it does not itself preserve Codex CLI or Claude Code as the active runtime. |
| `aadishv/pi-acp` | ACP agent server that bridges to `pi --mode rpc` | Useful ACP behavior/reference or an optional Pi agent. It is not an external-agent host library. Its manifest points to another upstream/package identity, so source and npm version must not be equated. |
| `harms-haus/pi-acp` | ACP agent server embedding the Pi SDK | Same agent-side direction. Source contains broad method scaffolding, but several claims are incomplete; the documented npm package was not found in the live registry query. |
| `buihongduc132/pi-acp-agents` | Pi extension acting as an ACP client; published `./api` export and adapter factory | The closest architectural fit. Some runtime classes can be consumed separately from Pi's UI extension, but current permission/lifecycle/config/Windows concerns make it a proof-of-integration candidate/reference, not a verified drop-in core. |

The common protocol dependency in all three ACP projects is the published `@agentclientprotocol/sdk`. Reusing that transport/schema layer is a narrower dependency boundary than importing the entire Pi orchestration extension. The final comparison with the independently researched `acpx/runtime` candidate belongs to the parent design decision.

### 2. Pi core: what its SDK/RPC actually controls

The [old `badlogic/pi-mono` URL](https://github.com/badlogic/pi-mono) redirects to [earendil-works/pi](https://github.com/earendil-works/pi). This is Mario Zechner's agent toolkit. Its root describes packages for provider access, the agent runtime, coding CLI, durable state, telemetry, and terminal UI; it also explicitly says that core Pi has no built-in filesystem/process/network permission enforcement. That is a boundary to implement in a host or extension, not evidence of Trellis-style approvals already being available. [Primary repository](https://github.com/earendil-works/pi)

The [SDK document](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) describes embedding `AgentSession` in Node/Bun. The session owns its conversation, tools, model, queue, compaction, and extensions. It supports persistent/in-memory history, cwd selection, explicit steer/follow-up behavior while active, abort/wait-for-idle, subscriptions, and disposal. Runtime session replacements require rebinding subscriptions. These are valuable lifecycle patterns. They operate on Pi's own runtime; using an Anthropic/OpenAI provider through Pi remains a different integration from controlling an already-running vendor CLI. The latter conclusion is an inference from that ownership boundary, not a claim that the ecosystem cannot add adapters.

The [RPC document](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) describes Pi-specific JSONL commands rather than ACP JSON-RPC methods. Its exported `RpcClient` handles Pi subprocess correlation and typed commands. It distinguishes accepted/queued/handled prompts from eventual completion, and recommends waiting for `agent_settled` rather than interpreting a lower-level `agent_end` as final idle. It also documents LF framing, CRLF compatibility, backpressure, stderr separation, child errors/deadlines, and orderly stdin-close shutdown. These are useful independent protocol/lifecycle design lessons, but importing `RpcClient` would add a Pi protocol implementation, not generic ACP hosting.

Live [npm metadata](https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/latest) reports `@earendil-works/pi-coding-agent` **1.3.0**, MIT, Node **>=22.19.0**, root ESM/types exports plus `./rpc-entry`, and a `pi` CLI. The [source manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) agrees with that version and package identity. No generic ACP host export was identified in the [coding-agent public index](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/index.ts) inspected here.

Windows support exists at the Pi runtime level: the [Windows guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md) documents native Windows and WSL, Git Bash discovery, and optional PowerShell tooling. This does not establish Windows compatibility of community ACP adapters or Trellis's launch/packaging path.

### 3. `aadishv/pi-acp`: agent-side Pi RPC bridge

The [README](https://github.com/aadishv/pi-acp/blob/main/README.md) describes a Zed-oriented MVP adapter: an ACP client launches this server, which launches `pi --mode rpc`. Reported capabilities include model/thinking config, tool updates/diffs, persisted session mapping, list/load, prompts/skills, and terminal-auth discovery. Its limitation section says MCP input is retained without forwarding, thought is not separately streamed, and fs/terminal delegation is unavailable. Source has evolved beyond portions of that limitation list, so the README is useful for direction and intent, not a complete current capability contract.

Concrete boundaries inspected:

| Source module | Independent observation |
| --- | --- |
| [`src/acp/agent.ts`](https://github.com/aadishv/pi-acp/blob/main/src/acp/agent.ts) | ACP agent methods, session listing/loading, model/config state and Pi process setup. List filters by explicit cwd; load opens a Pi history file and replays conversation. Pi errors are currently mapped to a normal ACP end-turn unless cancellation is known; this is a compatibility caveat for error presentation. |
| [`src/acp/session.ts`](https://github.com/aadishv/pi-acp/blob/main/src/acp/session.ts) | Per-session prompt queue and event translation. It is Pi-session ownership, not a generic Codex/Claude connection abstraction. |
| [`src/pi-rpc/process.ts`](https://github.com/aadishv/pi-acp/blob/main/src/pi-rpc/process.ts) | Pi subprocess, pending response correlation, early process errors, stderr/prelude handling, and injected fs/bash bridge extension. Current source includes more delegation scaffolding than the README limitation list suggests. |
| [`src/pi-rpc/command.ts`](https://github.com/aadishv/pi-acp/blob/main/src/pi-rpc/command.ts) | Windows uses `pi.cmd` by default and selectively enables shell launch for `.cmd`/`.bat`. This is implementation awareness, not Windows execution evidence. |
| [`test/component/session-queue-cancel.test.ts`](https://github.com/aadishv/pi-acp/blob/main/test/component/session-queue-cancel.test.ts) | Inspected test uses fake Pi process/ACP connection; it verifies abort plus cancellation of queued prompts. It does not prove real Pi, vendor, or Windows execution. |

The [aadishv source manifest](https://github.com/aadishv/pi-acp/blob/main/package.json) reports `pi-acp` **0.0.24**, MIT, CLI/main at `dist/index.js`, SDK `^0.18.0`, but repository/bugs/homepage refer to **`svkozak/pi-acp`**. Live [npm `pi-acp` metadata](https://registry.npmjs.org/pi-acp/latest) instead reports **0.0.34**, repository `svkozak/pi-acp`, SDK `^0.26.0`, and `cross-spawn`. Therefore an `npm install pi-acp` does not establish that the aadishv code inspected is what gets installed. This audit did not install or compare that release tarball.

Reuse assessment: valuable clean-room examples for queue cancellation, cwd-scoped history, replay and process readiness. A CLI entrypoint designed to expose Pi is not the published generic client library Trellis needs for Codex + Claude.

### 4. `harms-haus/pi-acp`: agent-side Pi SDK wrapper

The [README](https://github.com/harms-haus/pi-acp/blob/main/README.md) describes a standalone ACP server around `createAgentSession`, with per-session registry, event translator, protocol methods, and local filesystem/terminal fallback. It lists baseline new/prompt/cancel, optional history/config/mode methods, and explicit unstable stubs including model/provider/logout features. A broad method list is not evidence every operation has an effective runtime implementation.

The [manifest](https://github.com/harms-haus/pi-acp/blob/main/package.json) is **0.1.0**, MIT, depends on SDK `^0.21.0` and Pi coding-agent `*`, exposes a CLI/main, and declares Node >=20. Pi 1.3.0 itself requires >=22.19; the effective runtime minimum must follow the resolved dependency. Live [npm latest lookup](https://registry.npmjs.org/%40harms-haus%2Fpi-acp/latest) returned **404**, so the README's npm installation recipe is not verified package availability at this audit time.

Selected source findings:

- [`session-prompt.ts`](https://github.com/harms-haus/pi-acp/blob/main/src/acp/methods/session-prompt.ts) subscribes to Pi events, calls the Pi session prompt, and derives stop reason from cancellation flags/error text. The inspected handler has no actual permission request; its comment alone does not establish an approval gate.
- [`acp-extension.ts`](https://github.com/harms-haus/pi-acp/blob/main/src/pi/acp-extension.ts) declares a pending-permission map and cancellation helper, but its tool hook is a no-op, described as a future integration point. No human approval path was established from this source.
- [`session-set-config.ts`](https://github.com/harms-haus/pi-acp/blob/main/src/acp/methods/session-set-config.ts) updates a session-local config-options map and returns it; the inspected path does not call Pi's thinking/model setters. A control can acknowledge a new displayed value without changing the running agent.
- [`session-cancel.ts`](https://github.com/harms-haus/pi-acp/blob/main/src/acp/methods/session-cancel.ts) marks the target session as cancelling and aborts it, but invokes a module-global pending-permission cancellation helper. Multi-session permission scope needs scrutiny if that queue becomes active.
- [`session-load.ts`](https://github.com/harms-haus/pi-acp/blob/main/src/acp/methods/session-load.ts) contains session reconstruction/history replay. This is relevant design material, not evidence of external vendor resume.

The inspected [CI workflow](https://github.com/harms-haus/pi-acp/blob/main/.github/workflows/ci.yml) runs checks/tests on Ubuntu with Node 20/22. No Windows runner or successful run was inspected. No author-reported “fully compliant” description is treated as reproduced compatibility evidence.

Reuse assessment: an instructive contrast between advertised protocol surface and actual effects. It is not a mature replacement for a host client, and it would intentionally run Pi rather than the user's Codex/Claude runtimes.

### 5. `buihongduc132/pi-acp-agents`: the relevant client direction

The [README](https://github.com/buihongduc132/pi-acp-agents/blob/main/README.md) describes Pi tools for spawning/coordinating ACP agents. Its reported **2081 passed** test count was not run or independently verified here. The same README says streaming/tool forwarding and Claude/Codex adapters are planned, while current code contains raw update callbacks, a Codex adapter, and an acpx adapter. That source/doc drift prevents treating its feature/status table as authoritative current compatibility evidence.

#### Published reusable boundary

Live [npm metadata](https://registry.npmjs.org/%40buihongduc132%2Fpi-acp-agents/latest) and [source manifest](https://github.com/buihongduc132/pi-acp-agents/blob/main/package.json) both report **0.5.1**, MIT, Node >=22, dependencies on ACP SDK `^0.21.0` and `pi-acp-types`. The root entry is a Pi extension TypeScript file. A separate **`./api` export** targets `src/public-api.ts`. The package ships TypeScript sources rather than an independently compiled headless service. A bundler/runtime compatibility spike is needed for Electron consumption; version equality does not prove current main matches the published tarball.

The [public API](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/public-api.ts) exports configuration helpers, runtime paths, session manager, health/circuit-breaker classes, `createAdapter`, coordinator and stores. This is a real separable entrypoint, not merely an internal source path. However its contract is framed for extension packages; the public entry still includes Pi-specific management abstractions. Directly importing the root package would activate a large Pi extension integration instead of exposing a Trellis-owned host API.

#### Concrete client/adapter boundaries

| Module | What was verified |
| --- | --- |
| [`src/adapter-factory.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/adapter-factory.ts) | Factory routes direct ACP adapters by name and allows generic custom commands; an alternate mode selects an acpx CLI adapter. It accepts activity/raw session-update callbacks. |
| [`src/adapters/base.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/adapters/base.ts) | External-agent lifecycle surface wraps connect/initialize/new/prompt/cancel/load/model/mode/dispose over its ACP client. This is the direction Trellis needs. |
| [`src/adapters/custom.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/adapters/custom.ts) | Thin generic adapter over that base; a configured Claude ACP command can use this path. This audit did not validate a Claude run. |
| [`src/adapters/codex.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/adapters/codex.ts) | Defaults to a `codex-acp` executable and implements executable/version probing. A comment names `cola-io/codex-acp`; executable name alone does not identify the adapter build. Its probe uses Unix `which`. |
| [`src/core/session-manager.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/core/session-manager.ts) | In-memory handle registry, idempotent removal/disposal, stale pruning. It is distinct from persistent remote history discovery/replay. |
| [`index.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/index.ts) | Pi-specific extension setup, UI, tools, session stores and hooks; orchestration ties lifetime to Pi host events and auto-closes some single-shot work. Keep this policy outside a Trellis dependency boundary. |

#### Source-level concerns that block assuming a drop-in core

The inspected [`src/core/client.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/core/client.ts) directly passes its permission callback into SDK `ClientSideConnection`. That callback returns an `approved` outcome via a type cast, without choosing an advertised permission option or awaiting a UI decision. This is a **source-level wire compatibility and approval-integration concern**; no execution bypass or real-agent behavior was reproduced. The same module automatically tries the first advertised auth method and logs/ignores authentication failure, accumulates thought and answer chunks into one result string, and normalizes most quick-prompt stop reasons to end-turn. It does correctly retain the remote session ID for prompt/cancel/load and exposes raw updates through a callback. It advertises empty client capabilities. These observations are about inspected main source, not a tested release contract.

The alternate [`src/adapters/acpx.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/adapters/acpx.ts) uses synchronous subprocess calls, requests approve-all behavior for prompts, returns a final text response, and implements model/mode setters as no-ops. Its load method only changes local state. It is a convenience orchestration path, not evidence that the actual acpx runtime library lacks streaming, approval, config, or history capabilities. The parent team's direct `acpx/runtime` investigation is the appropriate source for those capabilities.

The inspected [`src/config/config.ts`](https://github.com/buihongduc132/pi-acp-agents/blob/main/src/config/config.ts) defaults to Pi-oriented locations, uses Unix `which` in runtime presets, can migrate configuration during load, and silently logs some save errors. A host must not let those helpers unexpectedly become Trellis's settings/error policy. The factory itself can accept an explicit launch configuration without adopting those defaults.

Windows awareness appears in the client and acpx adapter through shell launch branches; this is not Windows acceptance evidence. The inspected [CI workflow](https://github.com/buihongduc132/pi-acp-agents/blob/main/.github/workflows/ci.yml) runs Ubuntu jobs with Node 22/24 and package-content checks. No Windows runner or successful run was inspected. Unix discovery remains a concrete compatibility concern for the user's native Windows environment.

Reuse assessment: preserve as a concrete ACP client reference and possible `./api` spike. Before adopting it, verify the published entry loads under the chosen Electron bundler, human permission callback can be supplied without patching upstream, auth failure is observable, update/stop reasons remain lossless, and Windows launch/cancel/tree cleanup are reliable. If those require a fork, its whole-extension dependency and maintenance burden may outweigh direct use of the official SDK or a narrower runtime package.

### 6. Historical PI-Desktop reference is a separate project

Local evidence:

- `.trellis/workspace/maweirdos/journal-1.md:34-46` records the 2026-09-21 architectural hardening task and a PI-Desktop clean-room discussion.
- `.trellis/tasks/archive/2026-09/09-21-arch-hardening/design.md:3-5` identifies that reference as LGPL-3.0 and explicitly avoids copying implementation.
- `.trellis/spec/guides/decisions.md:110-119` is TPD-009: independently write notes/implementation, do not copy source/documents/patches, and check each dependency's own license before adding it.

No URL was found in those local historical artifacts. The publicly discoverable [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) matches the name, LGPL license and desktop architecture description, so it is a plausible historical match, **not proven identity** without the original discussion. Its current README says it is a desktop workspace built on Pi's runtime packages and can import sessions from Codex/Claude/OpenCode/Pi. Importing local transcripts is different from actively controlling those vendor agents. Do not conflate this desktop project, Mario Pi core, or a generic ACP client merely because they share “Pi”. No source from this desktop project was copied or proposed as a dependency.

### 7. Recommendation for this task

1. Keep the requirement explicit: Trellis hosts **Codex CLI and Claude Code through their ACP adapters**, with each vendor retaining actual runtime ownership. Adding Pi as another selectable engine is an independent capability.
2. Prefer a small proof against a published headless runtime or official ACP SDK over adopting an entire Pi engine/extension for architectural convenience. Compare the parent's acpx runtime candidate using the same lifecycle and approval acceptance criteria.
3. Use Pi's independent design lessons: accepted versus finished work, explicit queue behavior, per-session subscriptions, disposal/late-event guards, cwd-scoped history, real config effects, and documented runtime prerequisites.
4. Keep `pi-acp-agents ./api` on the shortlist only if it can expose Trellis-owned streaming/permission/auth/config behavior without source patches. Root import and its auto-orchestration policies are not the intended integration boundary.
5. Validate actual Codex and Claude adapters on native Windows: initialize/new, remote ID, streamed text/thought/tool patches, human approval allow/reject/cancel, interrupted session recovery, supported config changes, process shutdown, and project isolation. Neither repository size nor author-reported test count substitutes for that evidence.

## Files Found / Related Specs

- This report's public links identify the exact upstream modules/manifests/tests inspected; they are primary sources.
- `.trellis/spec/guides/decisions.md:110-119`: TPD-009 clean-room and dependency-license requirement.
- `.trellis/spec/frontend/my-ui-module.md:159-165`: preserve project-scoped ACP records/events and only live actionable permissions.
- `.trellis/spec/frontend/ipc-electron.md`: privileged child-process/native behavior stays behind typed IPC.
- `.trellis/spec/shared/code-quality.md`: retain structured error visibility rather than swallowed failures.

## Caveats / Not Found

- No package was installed, no vendor prompt executed, no CI job run verified, and no published tarball imported. Source/test inspection is not execution evidence.
- Versions above are live npm metadata or explicitly identified source-manifest versions as of this date. Mutable main branches can differ from release artifacts. `aadishv/pi-acp` and npm `pi-acp` demonstrably name different repository/version snapshots; `@harms-haus/pi-acp` latest lookup returned 404.
- GitHub unauthenticated tree API was rate-limited. Raw primary files were still inspected. An in-memory archive listing for aadishv confirmed module/test paths; no archive was extracted or saved, and later archive requests failed. There is no claim of exhaustive test/source review.
- The `pi-acp-agents` permission callback concern is observed directly at the SDK client callback boundary, but actual agent response acceptance/rejection was not reproduced. The published 0.5.1 tarball was not compared to main.
- Upstream SDK/package choices are not approved changes. TPD-009 still requires the eventual selected dependency's exact license/version to be checked before introduction.
