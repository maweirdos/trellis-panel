# Research: ACP planning convergence review

- Query: Are the current PRD, design and implementation plan concrete and internally consistent enough for final user review and later acceptance of both Codex and Claude Code?
- Scope: Internal planning review only; no new external research, tests, product changes or planning-artifact edits.
- Date: 2026-10-16
- Reviewed baseline: Current `prd.md`, `design.md`, `implement.md`, `research/backend-audit.md`, relevant frontend audit findings, and parent upstream digest.

## Findings

**Verdict: specific corrections before treating the planning baseline as approved.** Core coverage is strong and no product implementation has started. Resolve the four bounded items below in the planning artifacts/final summary; no new architectural investigation or expansion to OpenCode is needed.

### Coverage already concretely present

| Area | Planning evidence | Assessment |
| --- | --- | --- |
| Maintained SDK and vendor adapters | PRD R1; design sections 1/5; implement G0/G1 | Correct replacement boundary: SDK transport/schema reuse, retained ACP facade and app-owned supervision. Published-artifact inspection and exact pinning are explicit; draft source APIs are not assumed. |
| Session identity and strict protocol | Design 2/5; implement G1 gate | Local/remote/connection/turn IDs, inbound ID validation, strict initialize/new validation, Unicode and patch handling all address reproduced blockers. |
| Permission/lifecycle correctness | PRD R3/R4; design 4/5; implement G1/G2 gates | Single active turn, invalid-choice retry, late callbacks, process cleanup and stale approvals are covered. Exact timeout outcome still needs the clarification below. |
| Configuration/profile UX | PRD R2/R5/R6; design 3/8; implement G2-G4 | Runtime versus reusable profile versus live session is explicit. Actual capabilities/acknowledgement govern controls. IME, drafts, follow-scroll, narrow panes and failure feedback are present. |
| Legacy history/resume | PRD R4/AC6; design 6; implement G3 | Honest transcript-only migration, stale-state normalization, native capability gating, retained original history and no silent prompt replay are all explicit. |
| Project/task isolation | PRD R4/R7; design 2/7; implement G2/G3 | Strengthens mutation ownership while preserving current generation/early-event regressions; first-party events remain distinct from model results. |
| Real supported-vendor evidence | PRD R8/AC10; implement G5 | Both Codex and Claude Code independently require product-created sessions, multi-turn and actual tool evidence in an isolated repository. Blocked credentials/network rows cannot become mock passes. Conditional rows need the evidence rule below. |

### Corrections to make before approval

1. **Make adapter acquisition and production launch policy reviewable.** Design section 3 currently allows acquisition as an explicit “setup/start action”; PRD R2 requires explicit installation/setup, but no artifact chooses the installation location, whether Start can install, or how the required Node runtime is resolved outside the development shell. Implement G0/G2 can inspect compatibility, but cannot infer a product policy from package availability. State one first-delivery strategy: externally installed adapters with a complete guided setup path, or an app-managed versioned user-local cache with a separate visible setup action. Define how Node >= the adapter requirement is found/validated, whether any bundled runtime is supported, and how legacy custom commands remain user-managed. Do not silently make Start an installer unless that behavior is clearly included in the user-approved summary. This is a proposed policy gap, not evidence that a selected acquisition mechanism already fails.

   Add an explicit packaged/GUI-launch gate to implement G2/G5 (or explicitly limit delivery to development operation in the summary). `npm run build` and a native dev walkthrough do not exercise app.asar/resource paths, external Node lookup or GUI-inherited PATH. The backend audit already proves the mock script is absent from the declared package file set. Production presets must not inherit that failure mode. The diagnostic mock should be clearly development-only or packaged deliberately, with no unconditional availability claim.

2. **Specify directory lease lifetime and present its UX effect.** PRD R4 and design section 4 require one managed writer per effective directory, while design says a conflicting “start” fails. They do not say whether an idle ready connection holds the lease until stopped or only an active turn and its pending callbacks hold it. These policies differ materially: the former prevents two idle conversations/profiles in one repository; the latter needs careful coordination across prompts and client callbacks. Choose one, define acquisition/release including native resume and failures, and make any one-live-session restriction visible in the user summary. This is the remaining user-facing concurrency tradeoff; choosing it in the proposed summary and obtaining the single planning approval is sufficient. No separate scope-expanding question is necessary. Test directory aliases/case/junction normalization when implementing the chosen canonical identity.

3. **Write the exact permission settlement contract.** Design section 5 says cancellation/timeout/disconnect “settle once”, which leaves the reproduced `-32000 permission timeout` response technically compatible with its wording. Add the wire-level rule: a user denial returns selected with the original reject optionId; turn cancellation and locally expired approval resolve with the protocol cancelled outcome while the stream is writable. If the transport is already gone, settle local ownership once and record that no reply was deliverable. No automatic allow, no generic transport error masquerading as a deny, no pending resolver or actionable history after settlement. Add assertions for these exact outcomes to G1/G2. No user decision is required for this protocol correction.

4. **Close conditional real-evidence loopholes.** G5 uses “where the Runtime offers it” for approval and “if advertised” for resume. These are appropriate compatibility conditions, but absence of an observed prompt/control is not evidence of unsupported capability. Define matrix statuses explicitly: passed, demonstrated unsupported/not applicable with published-version/negotiation evidence, blocked, or failed. For a permission-capable adapter, configure a session-local safe fixture that actually triggers allow and deny when possible, preserving global user settings. If the path cannot be exercised, retain the gap rather than calling it not applicable. For native resume and model/mode controls, record the actual advertised options/operation and continuity/acknowledgement result, or the supported-version reason for omission. Codex success cannot close Claude rows. This tightens acceptance; it does not mandate unsupported features or another vendor.

### Remaining user-owned decisions

- Required vendor pair is already resolved: Codex + Claude Code. Do not ask again or add OpenCode/Gemini requirements.
- SDK adoption, local-only machine scope, capability-gated controls, transcript-only legacy history and HiFox-inspired page-owned UX are proposed decisions ready for the final summary.
- Installation/acquisition behavior and the practical directory-concurrency restriction should be included in that summary after the coordinator chooses a concrete proposal. Their approval can be part of the same final planning gate.
- Exact dependency versions, callback implementation details and test harness organization are engineering decisions after published-artifact inspection, provided they do not change approved setup behavior or support claims.

### Files and related specs

- Task `prd.md`: Requirements R1-R8 and AC1-AC10; product scope and acceptance authority.
- Task `design.md`: Technical contracts, migration and ownership boundaries.
- Task `implement.md`: Ordered G0-G6 validation and approval gates.
- `research/backend-audit.md`: Proven missing session identity, false readiness, permission, cleanup, encoding, mutation ownership and packaging gaps.
- `research/frontend-audit.md`: Capability-backed profile/composer and native interaction requirements.
- `research/provenance-and-upstream.md`: Parent-owned upstream/adapter snapshot; no new version claims made here.
- `.trellis/workflow.md`: Fresh final planning-summary approval precedes implementation.
- `.trellis/spec/backend/ipc-conventions.md`: Structured ownership-aware IPC and event contracts.
- `.trellis/spec/backend/environment.md`: Production/runtime path verification and environment separation.
- `.trellis/spec/shared/code-quality.md`: Truthful validation and surfaced failure behavior.

## Caveats / Not Found

- This review identifies planning ambiguity and acceptance risk; it adds no newly reproduced product defects beyond the backend audit.
- The current plan correctly preserves blockers instead of declaring real-vendor success. Neither adapter installation nor credential/model access has been validated by this review.
- No new external research or tests were needed. Only this research file was written; the coordinator owns any PRD/design/plan corrections and final approval request.

## Resolution review — 2026-10-16

**Updated verdict: ready for user review.** This supersedes the initial corrections-required verdict. The four material items are now concrete and consistent across the planning set:

- Setup is separate from Start and uses a pinned versioned userData cache, explicit/discovered external Node >=22, user-managed custom commands, and a packaged Windows GUI/restricted-PATH gate (`prd.md:27,80`; `design.md:41-43`; `implement.md:37,42,81`).
- Idle conversations coexist; active mutable turns/restores/callbacks and known background work hold the directory lease, with uncertain completion retaining ownership until process exit (`prd.md:41`; `design.md:67`; `implement.md:42`).
- Selected reject, cancelled and undeliverable-disconnect outcomes are explicit; startup, approval and cancellation deadlines are separated (`design.md:75-77`; `implement.md:42`).
- Vendor matrix statuses require actual version/negotiation evidence for unsupported rows; permission-capable runtimes must exercise session-local allow/deny, and both vendors repeat core packaged execution (`prd.md:80`; `implement.md:81`).

One non-blocking factual wording correction: `design.md:77` calls the old prompt deadline 120 seconds, but audited `services/acp.ts:559` uses `30 * 60_000` (30 minutes); 120 seconds is the old approval timeout. Remove that historical number or correct it. The proposed new independent deadlines remain clear.

Fresh user approval of the final summary is still required before implementation. This review ran no new tests, changed no product/planning artifact, and makes no real-vendor success claim.
