# Mature implementation reuse — revised direction

Date: 2026-10-16. Clean-room independent comparison; no upstream code/documents/patches copied. This is a researched recommendation and validation plan, not a production acceptance result or implementation approval.

## User requirement and correction to the first proposal

The user explicitly prefers a mature reusable solution when it can satisfy the task. The first proposal moved from a defective handwritten protocol client directly to SDK plus substantial locally owned supervision. That skipped evaluation of maintained ACP runtime implementations. The protocol SDK is one layer; prefer reusing a proven client/runtime boundary for lifecycle behavior as well.

Preserve required Codex + Claude Code, local execution, current Trellis task/material authority and HiFox-inspired UX. Do not swap in Pi's own model/tool loop and call that support for the existing vendor CLIs. No product changes, package installation or real-vendor requests were performed during this supplemental research.

## Candidate roles and practical reuse

| Candidate | Verified role / public boundary | Recommended position |
| --- | --- | --- |
| `acpx/runtime` | Published Node/TypeScript runtime API in the ACP client package, separate from its CLI; session/turn, permission callbacks, cancellation/configuration and persistence primitives | First bounded embedding validation. Best alignment with the current application and direct ACP requirement, subject to the gaps below. |
| Paseo | Published `@getpaseo/client` plus a local daemon, provider discovery, session lifecycle, permissions and timeline APIs | Complete daemon alternative. Determine native vendor providers versus ACP provider, ownership and API coverage explicitly. |
| Pi core SDK/RPC | Embeds or controls Pi's own agent harness | Useful if deliberately choosing Pi as an additional execution engine; not sufficient evidence of hosting the existing vendor CLI sessions. |
| Pi ACP agent adapters | Expose Pi as an ACP agent to another client | Future Pi integration and agent-side protocol examples. They address the opposite side of the current host-client problem. |
| `pi-acp-agents` | Pi extension with ACP-client functionality and a published API boundary | Relevant client reference/candidate, but Pi coupling, interactive permission behavior and Windows evidence need verification. Do not infer maturity from the Pi core's reputation. |
| AionUi / AionCore | Complete desktop host with backend/service boundaries | Valuable deployment/interaction/compatibility reference. Current architecture must be checked rather than assuming a reusable TypeScript ACP class. |
| OpenHands | Canonical SDK/Agent Server and ACP-backed agent plus a separate UI | Broader service-stack alternative; include deployment/model/API integration cost in the decision. |

Primary evidence and limitations are in `reuse-acpx-aionui.md`, `reuse-pi-ecosystem.md` and `reuse-paseo-openhands.md`. Their publication/source snapshots are not local integration tests.

## First candidate: embedded acpx runtime, not its shared-owner mode by default

Published `acpx` **0.19.5** declares a public `./runtime` export and Node **>=22.13**. The [tagged README](https://github.com/openclaw/acpx/blob/v0.19.5/README.md) documents embedding and explicitly identifies the project as pre-1.0 with evolving APIs. Pinning and an integration seam remain necessary; do not describe it as fully production-proven for Trellis.

The API offers an in-process runtime with per-turn permission/input callbacks, custom persistence/lifecycle hooks and an event stream. [Shared-session documentation](https://github.com/openclaw/acpx/blob/v0.19.5/docs/shared-sessions.md) explains that its shared owner has different ownership/serialization behavior: per-turn GUI callbacks are not supported there, and client shutdown detaches rather than stops accepted work. Prefer validating the in-process boundary for Trellis-owned GUI interaction first.

Known integration questions to prove before selection:

1. **Adapter launch policy:** override default `npx`/semver-range registry launch with explicit approved, pinned setup and absolute launch paths. Preserve the proposed rule that Start/discovery do not install packages.
2. **Permission fidelity:** the public callback's decision type may collapse selection to permission kinds. Verify multiple upstream options of the same kind and original option identity; do not silently approximate a human choice.
3. **Authentication:** demonstrate inherited vendor login/configuration and actionable auth-required recovery through a supported API. Do not reach into a private client just to claim the advertised auth surface is available.
4. **Lifecycle ownership:** measure actual Windows child/process cleanup for abort/handshake failure/shutdown, and distinguish UI detach from cancelling or terminating work.
5. **Storage and identity:** use the supported custom store/metadata boundary for Trellis scope, preserve local versus provider IDs, and verify native-only resume without creating replacement sessions silently.
6. **Events/capabilities:** confirm actual tool patches, model/mode/config acknowledgements, first-party event separation and unknown-event behavior against the chosen published adapters.

Use upstream-supported API or a narrowly documented missing integration seam where possible. A required feature accessible only through unstable private imports, or a need to maintain a broad fork, materially changes the cost and should trigger comparison with the daemon alternative.

## Application responsibilities after reuse

Trellis continues to own task/material/profile association, explicit start UX, current project/action authorization, presentation/drafts/scroll, setup policy and acceptance evidence. The chosen runtime should own the protocol/session/turn/process behavior it actually supplies. Maintain a responsibility matrix with `delegated`, `Trellis integration`, and `unsupported/gap`; this prevents building a second supervisor and transcript authority around a reusable implementation.

## Bounded validation before product implementation

Validate the same small scenarios in a scratch fixture, without replacing product modules first:

- Import only the public published runtime API with the Electron/Node build constraints.
- Use a strict deterministic ACP fixture for remote IDs, tool patches, malformed initialize, foreign IDs, all permission choices, duplicate-kind choices, cancellation and late/closed streams.
- Verify exact local adapter launch with no hidden download and a restricted Windows GUI PATH.
- Verify custom store isolation, restart/native restore semantics, crash/kill cleanup and directory ownership boundaries.
- After selecting the seam and approval of the revised implementation plan, run real Codex and Claude separately against the isolated repository and record all blocked/failed rows.

If this candidate clears the required cases with a thin integration, revise the product design around it. If it cannot, evaluate Paseo's public client/local-daemon path using the same matrix and its additional daemon-lifecycle checks. SDK-only reconstruction is the documented fallback when concrete candidate gaps justify it.

## Current decision status

The reuse-first strategy is established from the user's steering. **acpx/runtime first validation** is the current engineering recommendation. A final production runtime has not been selected or tested. Earlier SDK/supervisor design is superseded as the default and remains a fallback contract reference. Product implementation still requires a revised converged plan and the repository's final review gate.
