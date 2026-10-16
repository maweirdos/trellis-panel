# Runtime reuse validation — current selection evidence

Date: 2026-10-16. The user approved the bounded reuse validation after the comparison summary. This report is planning/selection evidence; the application implementation has not started and its dependency manifest remains unchanged.

## What was actually executed

Exact external scratch dependencies were installed and used, rather than evaluating only READMEs. Original fixtures exercised the published public acpx runtime/registry APIs on native Windows with Node 24.12.0. Two official vendor adapters were separately installed at exact versions; real requests targeted only new sample directories. Credentials/configuration were not edited or printed. Stock-package evidence was kept intact; no upstream patch or private import was introduced.

| Area | Executed evidence | Current result |
| --- | --- | --- |
| Core ACP flow | Strict peer, correct outbound remote IDs, two turns, Unicode framing, tool patch/content updates, acknowledged model/mode/config controls | Passed for the recorded scenarios |
| Permissions | Four original kinds/IDs, rejection action counters, cancellation during pending approval | Passed with one supplied option per kind |
| Exact duplicate-kind choice | Two different choices sharing allow_once | Public callback cannot express the second original option; not satisfied |
| Inbound identity | Foreign session/update during a normal turn | Failed: projected into the current normalized stream |
| Initialize validation | String protocol version and unsupported integer version | Failed: stock runtime sent session/new and completed prompts |
| Session readiness | session/new without remote ID | Failed: stock ensure returned an unusable handle; later prompt was blocked |
| Native restore behavior | Controlled provider restart/load; rejected stored session | Same-session continuity passed; rejected load did not create/replay another conversation |
| Windows lifecycle | 12 selected scenarios: spaced executable/script, argv, restricted PATH, hooks, initialize error, cancellation/shutdown, .cmd and owned grandchild | Passed recorded assertions; excludes GUI/packaging/general process trees |
| Real Codex | Three turns including sample file evidence token, tool events and adapter shutdown | Passed this isolated happy path |
| Real Claude | User-setting inheritance control, two coherent turns | Passed conversation after explicit host flag; default isolation initially produced AUTH_REQUIRED |
| Real Claude file read | Default and native client-tool controls | Not passed; turn completion/tool events did not produce the actual sample token |
| Packaged/native UI | No product integration performed | Not run |

Details and exact evidence are in `validation-protocol.md`, `validation-admission.md`, `validation-lifecycle.md` and `validation-vendors.md`. Independent positive/negative controls are not substitutes for each other.

## Public adaptations that were tested

The existing API allows small readiness guards:

- Rejecting a custom-store save whose public record.protocolVersion is not 1 blocked prompts and cleaned the fixture process. It happened after session/new, so it does not implement strict pre-session initialize validation.
- Rejecting a returned handle without backendSessionId and using public runtime.close blocked prompts and cleaned that process.
- A store cannot filter foreign notifications before delivery: the marker was normalized at sequence 43 and only appeared in the projected save at sequence 46. Its raw foreign session ID was never exposed in the public saved record. Deliberately failing that save was an ordering probe, not a proposed production content filter.

The normal event stream also omits the raw session ID, so a UI filter cannot reconstruct the missing boundary. Exact duplicate-kind choice similarly needs an upstream-supported API or a deliberate maintained adaptation. Do not claim a store/handle wrapper closes those gaps.

## Claude configuration discovery

The existing CLI, direct official Claude SDK and direct official ACP-client greeting controls succeeded. The initial acpx AUTH_REQUIRED result therefore was not sufficient evidence of missing user login. acpx intentionally excludes user settings unless the host sets its documented `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1`; enabling it restored the configured service and multi-turn replies without copying credentials.

This is a required setup-policy choice for an integration using the user's existing configuration. It is separate from the still-failing sample-file/tool evidence and the strict protocol gaps. A successful greeting must not be represented as a functioning coding agent.

## Decision under review

Unmodified acpx 0.19.5 is **not ready for direct product adoption under the current acceptance contract**. Its reusable session/turn/process core is demonstrated, and the concrete residual work is much clearer than in the initial SDK-only proposal.

The user explicitly selected **fixed-version acpx with minimum compatibility maintenance** for handshake/session/permission boundaries. Paseo's bounded public SDK/daemon comparison is complete and preserved in `validation-paseo.md`; it is not the selected runtime. The patch has not yet been implemented or acceptance-tested.

CommonJS import of the public acpx runtime was also exercised in system Node24.12 and Electron44.4.3/Node24.21 with ELECTRON_RUN_AS_NODE. The Electron result was written by that actual process to `acpx-validation/electron-import.json`. This supports the main-process embedding plan but is not GUI/asar/packaged acceptance.

Keep the original acceptance bar, separate delegated runtime responsibilities from Trellis integration, and obtain review of the revised converged implementation plan. Do not mark the parent ACP task, this child, or real-vendor acceptance complete from these experiments.
