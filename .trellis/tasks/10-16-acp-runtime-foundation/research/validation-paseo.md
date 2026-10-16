# Research: Bounded Paseo public API and daemon compatibility validation

Clean-room note (TPD-009): Independently authored probes used published package-root APIs, CLI help and public declarations. No upstream implementation/docs/patches were copied, no private module was imported, and no product, planning or dependency changes were made. No vendor/model/credential call occurred.

- Query: Does published Paseo 0.11.4 provide a concrete independent-daemon alternative through supported client APIs, especially exact permission actions, cancellation/configuration and timeline identity?
- Scope: Local public import/object inspection and one isolated loopback daemon startup; no full product adoption.
- Date: 2026-10-16

## Findings

**Verdict: the public client/server packages import and an isolated loopback daemon can start/connect on this Windows/Node installation. Exact permission actions are represented by the public SDK, but the current high-level agent handle lacks stop/cancel and live model/mode/config mutation APIs. The configured fake provider was not registered in the tested public factory path, so no ACP peer or permission round-trip was executed.** This is bounded reference evidence, not a selected production route. The user subsequently chose reusing acpx with a minimum fixed-version patch; further Paseo exploration was stopped.

### Exact packages and public boundaries

- Prepared external read-only installation: `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/paseo-validation/node_modules`.
- `@getpaseo/client`, `@getpaseo/cli`, `@getpaseo/server` and protocol package: **0.11.4**; Node **v24.12.0**, Windows.
- Public SDK root import exposes `createPaseoClient` and `createPaseoApi`. Its README explicitly treats `@getpaseo/client/internal/*` as unsupported; none were used.
- Public server root exports `createPaseoDaemon`, `resolveConfigFromPersisted`, configuration/logger helpers and daemon-control functions. The Node CLI script accepts documented `--home`, foreground `daemon run` and `daemon stop` operations; only CLI help was exercised.
- Package-root default entry URLs were taken directly from package.json exports. Internal declarations were read only when referenced by public types; no hidden class was instantiated to make the experiment pass.

References: [published client manifest](https://unpkg.com/@getpaseo/client@0.11.4/package.json), [public SDK declarations](https://unpkg.com/@getpaseo/client@0.11.4/dist/index.d.ts), [published server manifest](https://unpkg.com/@getpaseo/server@0.11.4/package.json), [server public exports](https://unpkg.com/@getpaseo/server@0.11.4/dist/server/server/exports.d.ts).

### Verified SDK surface

| Requirement | Published public surface / observed object | Limit |
| --- | --- | --- |
| Permission response | `agent.respondToPermission({requestId,response})` exists on the actual root-created handle. Response accepts behavior allow/deny and optional `selectedActionId`. Requests contain actions with original IDs/labels/behavior. | Type/API evidence supports exact action selection, including choices sharing behavior; **no daemon-to-ACP round-trip was run**, so original ACP option mapping is not acceptance-tested here. |
| Pending approvals | Actual handle exposes pendingPermissions, activeTurn, lastError and runtimeInfo snapshots; initial unread snapshot returns null rather than fabricated state. | Refresh/subscription/snapshot ownership must be wired; capability existence is not proof of live approval handling. |
| Stop/cancel | Actual high-level handle has `stop === undefined`, `cancel === undefined`; agent action group has list/ref/create/subscribe only. | Documented CLI `paseo stop <id>` exists. Internal client methods are not a supported substitute under this experiment. No stop/cancel round-trip was attempted. |
| Model/mode/config | Agent creation accepts provider/model and configuration; provider discovery exposes models/modes/features; `client.config.get/patch` exists. | Actual handle has no setModel/setMode/setConfigOption methods. Daemon config patch is not a demonstrated acknowledged live-session control. |
| Timeline identity/history | Public timeline event shape carries agentId; replacement epochs and reconnect-restored notifications are defined; actual handle has subscribe/refetch/append methods. | Agent ID is Paseo's application identity, not proof that a foreign raw ACP session/update is rejected. That protocol gate was not exercised. |
| Connection lifetime | create/connect/close and reconnect options are public; a loopback connection was observed connected and closed. | Client close is not equivalent to stopping a daemon/agent. Those ownership actions remain distinct. |

Declaration anchors: client `dist/index.d.ts:201-205,217-256,258-316,349-388`; protocol `dist/agent-types.d.ts:399-429`. Runtime object observations are saved in the import probe result. [Protocol permission types](https://unpkg.com/@getpaseo/protocol@0.11.4/dist/agent-types.d.ts).

### Executed import/config probe

Original script: `research/validation/paseo/probe-public-api.mjs`.

Result: `research/validation/paseo/runs/2026-10-16T10-18-28-966Z/result.json`.

It imported the exact SDK/server packages through their public roots, constructed a client without connecting to a service, inspected a public agent ref, closed the client, and resolved owned configuration. Both imports succeeded despite dependency install scripts having been disabled; no native rebuild/install/download was needed for these observations.

Configuration resolution showed loopback `127.0.0.1:0`, relay false, plugins false, MCP/browser tools false, all speech provider enabled flags false, voice LLM null, web UI false and no agent clients. It did not start a daemon. These resolved values were saved; they are stronger than assuming an environment flag was honored.

### Executed bounded loopback daemon experiment

Original script: `research/validation/paseo/run-isolated-daemon.mjs`.

Evidence: `research/validation/paseo/daemon-runs/2026-10-16T10-19-39-379Z/result.json`, owned `paseo-home/config.json`, and `owned-cleanup.json`.

1. The script sanitized its own environment, assigned PASEO_HOME/home/appdata/temp beneath the owned run, removed ordinary PATH discovery, set standard telemetry opt-out environment flags and resolved explicit disabled relay/plugins/voice/MCP/browser/web-UI configuration. Built-in agent providers and metadata generation were disabled. No cloud pairing/onboarding/default/global daemon command was used.
2. Public `createPaseoDaemon` and `start` succeeded. The actual target was **127.0.0.1:49913**, an ephemeral loopback port. This ran inside the separately owned Node research process, PID 60392.
3. The public SDK connected and reported connected. This proves basic deployment/protocol compatibility for this exact package/Node/Windows combination.
4. An original strict peer was proposed via a custom public provider definition and explicit Node/script argv. However, resolved `agentClients` remained empty; `client.agents.create` rejected with **Provider research-strict is not configured**. The peer was never launched. This is an observed limit of this tested resolveConfig-to-public-factory path, not proof that the documented CLI cannot register generic ACP providers. It was not pursued after the user selected the acpx route.
5. Public SDK close and daemon stop both resolved and were recorded. The research Node process still retained event-loop handles after five seconds. Its command line was verified against this owned script, then **only PID 60392** was stopped. No unrelated process was touched. This liveness observation is not labeled a successful full shutdown/lifecycle gate. Future reruns explicitly exit the standalone harness after saving public cleanup outcomes so the research stays bounded.

No real provider, native coding agent, speech model, plugin or credential was invoked. Telemetry opt-out flags and disabled configuration were applied; no packet capture was performed, so this report does not claim a network audit beyond the observed loopback target/configuration.

### Implication for the selected implementation

Paseo has a concrete public daemon/client deployment boundary and a more expressive public permission-response shape than acpx's semantic-kind-only callback. It also introduces independent service lifecycle/state and has current high-level SDK gaps for the controls our UI needs. This review did not establish fake-peer registration, ACP identity enforcement, permission wire mapping, native resume or full cleanup.

These are reference tradeoffs, **not blockers to the now-selected acpx-with-minimum-patch route** and not a reason to switch candidates without user approval. Preserve the acpx stock failures and require regression evidence for its narrowly maintained handshake, inbound identity and exact permission-choice fixes. No Paseo product adoption is proposed by this report.

### Reproduction

```powershell
node .trellis/tasks/10-16-acp-runtime-foundation/research/validation/paseo/probe-public-api.mjs
node .trellis/tasks/10-16-acp-runtime-foundation/research/validation/paseo/run-isolated-daemon.mjs
```

Both scripts require the already prepared exact packages and never install anything. The second starts only an owned loopback instance, invokes public stop in finally, and currently records the custom-provider registration failure with exit 1. It should be rerun only if this alternate is deliberately reopened. Results/pointers stay in the owned Paseo research directory.

### Related specs

- `.trellis/spec/guides/decisions.md`, TPD-009: independent notes/fixtures and public dependency/API reuse.
- `.trellis/spec/backend/environment.md`: explicit daemon home/native deployment boundaries.
- `.trellis/spec/backend/ipc-conventions.md`: application identity, readiness and service/agent ownership must remain truthful.
- Task protocol/admission reports: the stock acpx failures remain unchanged; this alternate experiment does not close their gates.

## Caveats / Not Found

- No actual ACP fake-peer turn, permission selection or cancellation occurred through Paseo; public type support must not be reported as wire-level success.
- No native dependency blocker was encountered in import/basic startup. This does not prove all PTY/speech/provider binaries work; those features were disabled.
- No unsupported internal client import, native rebuild, dependency repair, broad process kill or automatic onboarding was used to bypass a blocker.
- No product/planning files, prior fixtures or task status were modified. Further alternate investigation stopped when the user chose the maintained acpx patch approach.
