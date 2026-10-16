# Mature runtime reuse: Paseo and OpenHands

Date: 2026-10-16. Clean-room architecture notes: independent summaries of primary documentation/manifests, no source code, patches or upstream prose copied into the project. This research did not install/run either runtime, access credentials, or issue model prompts.

## Evaluation goal

The user asks to prefer mature ACP integration solutions over rebuilding lifecycle behavior around the official protocol SDK. Required vendors remain Codex and Claude Code. Evaluate an actual maintained package/API boundary, Windows deployment, interactive permissions, session/turn control, durable history, event projection and task association. A project claiming support is not proof the selected version meets our acceptance criteria.

## Paseo

### Verified public integration boundary

- [Official TypeScript SDK overview](https://paseo.sh/docs/sdk): `@getpaseo/client` drives a separate Paseo daemon. The daemon owns agent launch/liveness while an application can create and monitor agents. This is an actual published integration path rather than copying app-internal classes.
- [SDK API reference](https://paseo.sh/docs/sdk/reference): agent handles expose lifecycle/capability/runtime metadata, pending permissions, prompt acceptance, turn waiting, permission responses and paginated/live timeline access. Provider discovery exposes availability, diagnostics, models and modes. Connection reconnection and timeline demand recovery are documented separately; missed history requires explicit refetch. Closing the client does not stop agents.
- [SDK quickstart](https://paseo.sh/docs/sdk/quickstart) and [agent guide](https://paseo.sh/docs/sdk/agents): create accepts a session before its initial prompt finishes; waiting can return idle, permission, error or timeout. A wait timeout is not execution cancellation. Existing agent IDs support subsequent follow-up access. Do not infer a complete stop/cancel contract from this guide; public SDK versus lower-level control needs verification in the pinned package.
- [Provider options](https://paseo.sh/docs/sdk/provider-options): provider-specific settings and modes are separate from general session configuration. The Codex/Claude native provider route and the ACP provider route are different mechanisms. Reusing Paseo can satisfy our user goal without necessarily using ACP as the inner transport for both native providers; this choice must be visible in the revised architecture, not silently conflated.
- [Workspace API](https://paseo.sh/docs/sdk/workspaces): durable workspace identity and directory placement can be managed through public handles. Trellis should retain its task authority and store only external workspace/agent IDs; adopting the package must not create a second authoritative task system.

### Deployment and maintenance evidence

[Getting started](https://paseo.sh/docs) describes a separate daemon/CLI and a desktop package bundling the daemon. [Downloads](https://paseo.sh/download) lists Windows x64/ARM64 as well as other platforms. This establishes a published Windows path, not that embedding or packaging it inside Trellis is already verified.

Registry queries on this date returned `@getpaseo/client` **0.11.4** and `@getpaseo/cli` **0.11.4**. The inspected source-main package manifests identified **0.11.2**, and the download page showed a different release snapshot. Pin a mutually compatible published client/daemon pair; do not treat mixed web/source snapshots as one tested version.

The [repository license](https://github.com/getpaseo/paseo/blob/main/LICENSE) identifies Apache-2.0. `packages/server/package.json` declares public subpath exports for server configuration/process/daemon control as well as the root; those are additional potential reuse boundaries, but the documented client + daemon path is better established than directly embedding undocumented server internals. Exact package licenses/dependencies still need checking at the selected published version.

### Fit and unresolved engineering questions

This candidate can remove more application-owned supervision than a direct ACP SDK connection. Its daemon and API also introduce a lifecycle/configuration boundary which Trellis must integrate: local process discovery/ownership, protocol version compatibility, credentials/configuration scope, explicit stop behavior, background work and daemon persistence after UI exit. Verify that permissions can be answered entirely in Trellis and that model/mode/cancel operations use supported public APIs. Do not require the user to operate the Paseo UI for a required action without explicitly selecting that UX.

Use it as the principal complete-daemon candidate, especially if future multi-device/native-provider management becomes a concrete requirement. Do not enable relay, cloud, mobile, scheduling or multi-agent automation merely because the upstream offers them.

## OpenHands

### Verified reuse boundary

- [Agent Canvas README](https://github.com/OpenHands/OpenHands): the UI/control center is separate from the canonical SDK/Agent Server.
- [Software Agent SDK](https://github.com/OpenHands/software-agent-sdk): canonical Python execution implementation and Agent Server expose conversation/workspace/events APIs and typed TypeScript client access. The boundary can be reused as a service; it is more than an ACP protocol sample.
- [Official ACPAgent guide](https://docs.openhands.dev/sdk/guides/agent-acp): an ACP-backed agent delegates coding work to an ACP server subprocess instead of running a new model/tool loop in Trellis. Examine per-turn callbacks, error handling and provider features in a pinned version before selecting it.

### Fit

This is a viable service-layer candidate if Trellis chooses a broader backend/conversation/workspace service. It introduces the Python/Agent Server deployment and API model, which must be weighed against the existing Electron/Node application and the bounded Codex + Claude target. Prior planning excluded a whole OpenHands server too early; retain it in the comparison, but do not equate upstream feature breadth with the least integration work for this task.

No Windows-native installation or packaged-Trellis compatibility was established in this research. Do not claim either failure or full support from that absence of evidence. A local validation stage must establish the actual runtime/dependency requirements if shortlisted.

## Recommendation from this topic

Compare a direct embeddable ACP runtime (the peer research covers `acpx/runtime`) against Paseo's public client + local daemon. Keep OpenHands as the service-stack alternative if either fails essential requirements or if the user deliberately selects its broader backend. The official ACP SDK becomes a protocol dependency/reference and fallback building block, rather than an automatic reason to recreate every lifecycle component.

Before product implementation, use the same isolated validation matrix for the shortlisted boundary: two real vendors, streaming and tool patch events, GUI permission response, cancellation and actual process exit, reconnect/history, current task/root association and packaged Windows launch. Record exactly which responsibilities remain Trellis-owned and why.
