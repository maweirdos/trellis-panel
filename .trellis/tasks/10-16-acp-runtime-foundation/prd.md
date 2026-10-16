# ACP Agent usability and runtime foundation

## Goal

Make Codex and Claude Code genuinely usable from the existing Trellis desktop workspace. Repair the runtime/protocol foundation before completing the HiFox-inspired Agent configuration and conversation experience. Acceptance requires real supported agents; mocks, screenshots and successful builds alone cannot establish usability.

## Confirmed background and decisions

- On 2026-10-16 the user prioritized ACP over the earlier suggested human-review work, reported the current experience as unusable, supplied two HiFox interaction references, and emphasized the importance of a complete foundation.
- The user authorized investigation and planning, then selected **Codex + Claude Code** as the required first supported pair. OpenCode is not part of the required vendor acceptance matrix.
- This is a follow-up child of `10-09-acp-agent-console`. The parent referenced OpenHands architecture and the Zed Codex adapter but implemented its own ACP client; real-vendor E2E remained unchecked. Evidence: `research/provenance-and-upstream.md`.
- Existing uncommitted ACP and project-isolation work is part of the entry baseline. Preserve it and the existing shell, ordinary Chat, Trellis file authority, project isolation and explicit/manual execution behavior.
- The user requested mature-solution reuse, including Pi ecosystem research, and approved isolated runtime validation with “可以，那你开始做吧”. Executed comparisons and results are preserved under research; the earlier SDK-plus-new-supervisor proposal is superseded.
- After those experiments exposed remaining boundary gaps, the user explicitly chose **reuse acpx with minimum fixed-version patch maintenance** over a standalone service. Production targets exact acpx 0.19.5 plus the three bounded compatibility areas in R1. Paseo remains comparison evidence. The revised implementation summary, rather than the earlier superseded review, is the final approval baseline.

## Requirements

### R1 — Maintained ACP integration and correct identity

Integrate exact acpx 0.19.5 through its runtime/registry exports and retain its proven session/turn/process/store behavior. The user-approved compatibility patch must close initialize/new-session validation, inbound session ownership and exact permission-option selection. Do not reimplement its satisfied lifecycle behind a competing manager. Negotiate stable ACP v1, retain capabilities/authentication metadata and preserve separate panel, connection, agent-session and turn identities. All requests and inbound updates target the correct agent session. Executable presence or a local handle is not readiness. A changed/unpatched dependency must fail its build/start compatibility checks rather than silently lose these guards.

Verified blockers: missing agent session ID in prompts and incorrect ID in cancel (`services/acp.ts:534-538,559,575`); initialize result discarded; permissive mock masks identity errors. See backend research for the final source anchors and reproduction results.

### R2 — Runtime setup, diagnostics and execution scope

Provide usable Codex and Claude presets plus compatibility for existing custom ACP commands. Distinguish executable/adapter discovery, installation state, protocol compatibility, authentication, directory availability and ready session state. Explicit refresh must re-probe. Handle Windows npm shims, paths containing spaces, argument boundaries and GUI process environment differences.

Show the actual machine (local for this delivery), project, working directory and Runtime. Built-in adapters use an app-managed, pinned, versioned user-local installation under `userData/acp/runtimes/`, acquired only through a distinct visible Setup action. Start and discovery never install/download packages. Resolve and validate an external Node >=22.13.0 using an explicit saved path or discovery; provide a path picker/actionable setup if unavailable. Do not assume Electron's executable is Node. Custom launch commands remain user-managed. Default to the tools' existing local authentication/configuration; expose advertised authentication choices and actionable auth-required errors. Preserve user-configured launch commands through migration.

Verified dead ends: force-enable text conflicts with availability gates and probe cache cannot refresh (`Settings.tsx:1144`, `AcpConsole.tsx:340,356`, `services/acp.ts:51-75,464-465`).

### R3 — Complete turn, event and permission behavior

Support continuous multi-turn conversations, streaming text and reported thought summaries, tool creation and patch updates, tool outputs/diffs/locations, plans and reported command/configuration updates needed by the supported pair. Preserve unknown event metadata with a readable diagnostic fallback.

Enforce one active prompt per session. Preserve rejected/unsent drafts and allow drafting while busy without promising unsupported steer or automatic send. Preserve original permission labels, IDs and all allow/reject kinds. Invalid/stale choices cannot consume a live request; cancellation, timeout and disconnect settle requests predictably. Never turn a remembered rejection into an allowance. A task outcome is separate from a model turn ending.

### R4 — Lifecycle, cleanup, concurrency and persistence

Record only available truthful observations for discovery, launch/process start, confirmed session readiness and first response. Show a separate initialize/auth substep only when a supported observation establishes it; otherwise leave its timing unknown. Measure session preparation and first-response durations separately rather than inferring hidden phases.

Cancellation targets the active agent turn and remains cancelling until acknowledged or explicitly escalated. Startup failure, prompt timeout, process error/exit, kill, app exit and late callbacks must settle pending work once and release resources. Multiple idle conversations may remain open for one directory, but mutable turns run serially. Acquire the directory lease before a turn or mutating restore/callback and retain it through pending approvals, cancellation and known background work; if its completion cannot be established, retain ownership until the process ends. Explain occupancy and allow explicit stopping/retry. No silent switch to another directory or Runtime.

Persist stable session/profile/version identities and usable history without recording credentials. Normalize stale active states on app restart. Distinguish transcript viewing, supported native resume/load, and creating a new conversation. Preserve old local-only history as viewable legacy records; do not fabricate a remote session ID or silently replay old prompts. Project ownership is checked at the IPC/service boundary for every action, not only filtered in the UI.

### R5 — Capability-backed configuration and client callbacks

Model/mode/configuration controls use the selected published adapter's reported options; unsupported or startup-fixed controls explain their state. Changes must be acknowledged by the Runtime before shown as effective. Native restore uses advertised capabilities and gives explicit unsupported/failure behavior.

Filesystem, terminal and interactive input callbacks required by the supported adapters must have tested implementations and appropriate directory/session ownership, or remain unadvertised with accurate compatibility diagnostics. Do not keep an artificial no-filesystem/no-terminal constraint solely because the old mock tolerated it. Existing tool and MCP configuration may be inherited from the Runtime; this delivery does not invent a new connector authorization platform. Task materials and profile instructions are explicitly assembled with visible provenance, distinct from proof that the model followed them.

### R6 — Agent profile and conversation UX

Retain the current project-root header, fixed peer navigation, design tokens and shared components. Within the existing conversation module, provide discoverable Agent profiles, their Runtime health, recent sessions and a configuration/detail view. Distinguish the reusable Agent role (name/description/instructions/default Runtime and directory) from the executable adapter and from one conversation.

Reference the supplied HiFox screenshots for the list/detail pattern, actionable profile settings and expandable startup/activity groups. Keep the main conversation readable with Markdown/code/tool details, per-session drafts, Chinese IME-safe submission, stable follow-scroll and a return-to-latest control. Side panels yield at narrow widths. Errors and stop/retry actions must show acceptance/failure feedback. No fictional metrics, unsupported model selectors or inert integration buttons.

### R7 — Trellis integration and truthful result association

Preserve the existing manual Jira/task path and task/material navigation. Task-bound events must match that task and project; project-wide events are labeled separately. Explicitly starting a task-linked conversation identifies the material/profile snapshot sent. Ordinary assignment, profile editing, project switching, reading and comments do not implicitly start coding. Agent completion does not approve a Trellis phase, business acceptance, Jira transition, commit or release.

### R8 — Evidence, compatibility and regression

Keep deterministic adversarial protocol/lifecycle tests and a vendor acceptance matrix. Use an isolated temporary fixture repository for real-tool validation. Test both supported vendors beyond greeting: multi-turn, project/file context, a controlled tool action, actual approval behavior where offered, cancellation and supported history restoration. Report credential/network/tool availability blockers separately from application failures. Do not close an unexercised real-vendor criterion using mock evidence.

## Acceptance criteria

| ID | Requirement | Observable result |
| --- | --- | --- |
| AC1 | R1/R3 | Strict agent validates remote IDs and negotiated version; supported vendors complete at least two coherent turns; foreign updates are rejected or quarantined. |
| AC2 | R2 | Clean missing-adapter state has a working setup path; explicit re-probe sees a corrected command; quoted paths/npm shims work on Windows; auth-required is distinct from install/protocol failure. |
| AC3 | R3 | Tool patch notifications update the original card, split UTF-8 text is intact, unknown events remain inspectable, and failures do not appear completed. |
| AC4 | R3/R4 | All four permission kinds, original option IDs, invalid/stale options, cancel, timeout and disconnect have deterministic results; pending UI cannot resurrect historical approvals. |
| AC5 | R4 | Cancel during startup/turn/approval, process crash, failed handshake, duplicate submission, timeout and app exit release owned resources with one terminal result; directory contention is explicit. |
| AC6 | R4/R5 | Reloaded history is readable; true supported resume continues the same remote conversation; legacy history is clearly distinguished; every action rejects foreign-project ownership. |
| AC7 | R5/R6 | Profile/default configuration survives restart, model/mode changes follow real options and acknowledgement, and no unimplemented callback is advertised. |
| AC8 | R6 | Native UI can create/select a profile, diagnose/start the selected Runtime, converse, approve/deny, stop, reopen history and recover errors; Chinese IME, stream following, per-session drafts, narrow width and themes are checked. |
| AC9 | R7 | Task/material links remain functional and scoped; source/decision/runtime events remain distinct; no implicit Trellis/Jira/commit action occurs. |
| AC10 | R8 | Typecheck/build and relevant existing/new tests pass. A real Codex + Claude acceptance matrix records actual versions, inputs, outcomes and artifacts, keeping all skipped/blocked rows explicit. |

AC2/AC5/AC10 include a Windows packaged application launched from the GUI with a restricted PATH; dev-server and build results cannot replace this evidence. Acceptance statuses are passed, demonstrated unsupported/not applicable with exact version/capability evidence, blocked, or failed. For permission-capable adapters, failure to exercise allow/deny remains an acceptance gap; merely not seeing a prompt is not proof it is unsupported.

## Out of scope

OpenCode/Gemini as required supported vendors, ACP v2 and unnegotiated vendor extensions, cloud/remote-machine orchestration, automatic squads/dispatch, IM/external-connector authorization infrastructure, new team sharing/identity services, a code editor/debugger, and automatic Jira/commit/publish actions. Generic custom ACP registration remains possible without claiming the same tested support as the chosen pair.

## Risks and deferred items

- Entry PATH contained Codex 0.159.2, Claude Code 2.1.296 and OpenCode 1.17.1 but no standalone ACP adapter. Pinned adapters now exist only in the isolated validation directory; product dependencies/setup have not been changed.
- Tested dependencies are acpx 0.19.5, resolved protocol SDK 1.8.0, Codex adapter 2.2.2 and Claude adapter 0.91.0. acpx requires external Node >=22.13; local Node is 24.12, and Electron44.4.3's headless import succeeded on its Node24.21. Product packaging remains unverified.
- Directory occupancy and ownership integration remain Trellis policy; process/session cleanup is delegated and must be exercised through the actual app lifecycle.
- Legacy records lack remote identity and cannot safely be converted into resumable conversations.
- Actual credentials/network can prevent a vendor E2E; preserve the acceptance gap and supply an actionable path, without substituting a mock pass.

## Artifact status

The user reviewed the validated implementation summary, confirmed the package-plus-minimum-patch approach and future source-migration boundary, then explicitly instructed “那现在开始任务吧” on 2026-10-16. Final implementation approval is received. Stock negative evidence remains unchanged and must become passing patched regressions; Claude sample-file/tool evidence remains an implementation acceptance gap. Activate through task.py start and execute the approved plan without reopening resolved scope decisions.

## Implementation checkpoint (2026-10-17)

The approved package-plus-bounded-patch implementation is complete and checked. Both required vendors pass core product-created acceptance, including user-selected glm-5.3-flash tool reads/edits/decisions/cancel/native restore; all failed stock/configuration/cached-context trials remain distinguishable. Final desktop system-IME/profile/draft-switch and last visual checks remain pending after two physical-Escape stops. See validation.md for exact evidence; task remains in_progress and no commit/archive is authorized by this checkpoint alone.
