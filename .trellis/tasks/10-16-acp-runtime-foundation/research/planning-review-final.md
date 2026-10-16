# Research: Final converged ACP planning review

- Query: Are the revised PRD/design/execution plan consistent with the user's resolved acpx choice and the executed evidence, and ready for the final revised user review?
- Scope: internal planning convergence review; no implementation or test rerun
- Date: 2026-10-16
- Inputs: current `prd.md`, `design.md`, `implement.md`, `research/validation-summary.md`, `validation-protocol.md`, `validation-vendors.md`, and this researcher's completed lifecycle report/aggregate.

## Findings

### Verdict

**Ready for the revised user final review after two bounded wording corrections below.** No architectural reselection, further comparison research, or repeated approval of the already resolved acpx maintenance choice is needed. The revised whole-product summary still needs its final explicit approval before activation/implementation, as recorded in `implement.md:3,21-23`.

No contradiction was found that requires changing the selected architecture or expanding the approved three-boundary patch.

### Bounded corrections

1. **Align the startup requirement with observable public milestones.** `prd.md:40` currently lists initialize/authentication/session-preparation phases as required recorded phases, while `design.md:90` and `implement.md:53` correctly limit rendered timing to observations actually exposed by the runtime. The lifecycle experiment does not expose distinct successful handshake/new-session timing callbacks. Make R4 explicitly require truthful *available* launch/process/session/first-response observations; separately identifiable initialize/auth steps are recorded only when a supported observation exists. This avoids an implementation claiming invented substep times or widening the patch merely to satisfy an ambiguous sentence.

2. **Use the actual dependency minimum in setup language.** `prd.md:28` and `design.md:70` say external Node `>=22`, while `prd.md:90` records acpx's exact minimum as `>=22.13`. Tighten the setup/discovery validation requirement to **Node >=22.13.0**, subject to any stricter resolved adapter requirement. Otherwise a literal Node 22.0 probe could be accepted by the plan but rejected by the selected runtime. No new runtime-selection decision is involved.

### Consistency checks that passed

| Material concern | Converged contract and evidence |
| --- | --- |
| Reuse versus competing supervisor | `design.md:11,17,27,94` and `implement.md:7,38,44` delegate transport/session/turn/persistence/process cleanup to acpx. Trellis owns project authorization, profile/setup, approvals, material association, occupancy and presentation. The public lifecycle seam supports that split. |
| Patch scope | `design.md:31-39` and `implement.md:25-34` restrict maintained changes to handshake/readiness, raw inbound ownership and exact permission-option selection. Stock failed cases remain unchanged and must become patched regressions. No whole runtime fork, private hashed imports or monkey patch is proposed. |
| Raw and early/replay ordering | `design.md:36,60,116` and the G1 gate require checking the raw envelope before projection, bounded pending new/load handling, authoritative identity, replay boundaries, cancellation/generation tests and foreign traffic exclusion. A store/UI post-filter is not represented as sufficient. |
| Exact permission identity | `design.md:37,104` distinguishes original optionId from display kind. Invalid/stale GUI choices are rejected before resolving a live mediator; invalid direct library decisions fail closed. These are compatible responsibilities, not contradictory invalid-choice outcomes. |
| ACP ID versus optional native ID | `design.md:54-60,116` and `implement.md:39` correctly make backendSessionId/app acpSessionId the wire identity; native agentSessionId is optional. This agrees with `validation-vendors.md:11` and strict fixture evidence. |
| Setup and existing settings | `design.md:43,68-80` and `implement.md:42-43` separate visible installation from start/discovery, preserve custom commands and use an explicit external Node. Claude user-setting inheritance is a stable host policy established before runtime construction, not a per-session process.env toggle or child-only overlay. Credentials remain adapter-owned. |
| Real vendor/native acceptance | PRD AC8/AC10 and `implement.md:60-75` require product-created Codex and Claude sessions, actual sample-file/tool evidence, offered allow/deny, cancellation/history and packaged GUI launch with restricted PATH. Research greetings/builds/headless imports do not close these rows. |
| Still-failed Claude file read | `design.md:13,43-45`, `implement.md:62,68-75`, and `validation-vendors.md:39-43` preserve the failed file criterion and do not blame acpx exclusively: a direct SDK control also failed. No silent provider/model/credential substitution is authorized. |
| Exact dependency/patch preparation | `design.md:31-39` and G1 require exact acpx 0.19.5, recorded patch identity/notices, deterministic checked-in preparation, lockfile consistency, and clear build/start failure if preparation is absent or mismatched. Product imports stay on public exports. |
| Rollback and evidence preservation | `implement.md:9` and its rollback section preserve entry dirty work, custom commands, legacy/unknown records and failed stock evidence. Rollback cannot silently enable an incompatible unpatched dependency, overwrite newer records or replay uncertain prompts. |

### Evidence interpretation for the final user summary

- The 12 selected headless Windows lifecycle scenarios are decisive for their controlled launch/cancel/cleanup conditions. They do not establish packaged GUI, arbitrary detached processes or a supported vendor matrix.
- Codex's isolated sample read is positive evidence. Claude's inherited-settings conversations are positive chat evidence, while its sample-file/tool row remains failed. Keep these separate.
- `research/validation-summary.md` retains a **historical preselection** “Decision under review” section. Current PRD/design/plan explicitly supersede that stage. Do not present that older paragraph as a current request to choose again; preserve it as provenance rather than rewriting stock evidence.
- This review does not mark the task started, any patch implemented, the product usable, or vendor/native acceptance complete.

## Files Found / Related Specs

- `prd.md`: final product requirements, acceptance matrix and remaining evidence gaps.
- `design.md`: delegated ownership, bounded patch, raw identity/replay, settings/launch, persistence and UI contracts.
- `implement.md`: revised review gate, staged implementation/validation and rollback.
- `research/validation-{summary,protocol,vendors,lifecycle}.md`: executed positive/negative controls and their limits.
- `.trellis/workflow.md`: final reviewed complex-task artifacts and explicit activation gate.
- `.trellis/spec/guides/decisions.md` TPD-009: independent implementation and exact dependency/license provenance.
- `.trellis/spec/frontend/my-ui-module.md`: existing peer navigation, project generations and live-only permissions remain preserved.

## Caveats / Not Found

- Static convergence review only; no tests rerun and no product/planning/status files changed.
- The two corrections are contract wording/validation-boundary alignments. They do not reopen the resolved vendor or reuse choice.
- Implementation may still expose a new concrete API/adapter limitation. It must be recorded against the agreed gates rather than silently widening the maintained patch or lowering acceptance.
