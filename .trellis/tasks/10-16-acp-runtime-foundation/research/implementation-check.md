# ACP foundation implementation check

Date: 2026-10-16. Scope: the complete dependency/preparation boundary, application
facade/setup/profile/history, shared IPC/preload, ACP workspace/Settings and smoke
fixtures. This is a code/fixture review; native, real-vendor and packaged acceptance
remain the coordinator's separate evidence. No files were staged or committed.

## Findings fixed

1. **Restore admission and lifecycle — `src/main/services/acp.ts`.** Concurrent
   restores could pass the pre-await checks, overwrite one session-map owner and
   bypass the managed connection cap. Restore now reserves its ID/capacity before
   asynchronous discovery, exposes its preparation to canonical stop, and checks
   closing ownership before applying results. Cleanup targets the actual local
   owner rather than a later map entry. A stopped restore cannot publish a late
   disconnected/ready state.
2. **Idle crash recovery — same file.** An existing disconnected/error entry made
   restore return success without enabling any usable send path. Explicit restore
   now stops the stale owner through the public runtime and reloads the same stored
   remote identity. Busy/closing operations reject conflicting restoration.
3. **Frozen launch semantics — `acp/setup.ts`, shared config/snapshot.** Managed
   detection depended on current Settings overrides, so editing a preset could
   reinterpret older conversations. Optional `launchKind` records managed/custom
   provenance; Settings overrides are always custom. Only an exact generated
   package/version definition qualifies for conservative older-snapshot recovery.
   A changed managed version fails explicitly rather than selecting another one.
4. **Profile compatibility and directory truth — `acp/metadata.ts`, `types.ts`,
   service and `ProfileEditor.tsx`.** Read/save stripped unknown compatible fields
   and replaced the envelope. Compatible existing fields are retained; unsupported
   profile versions reject writes. Explicit relative working directories are
   rejected with guidance; absolute paths containing spaces remain valid. The UI
   correctly explains the approved explicit alternate-directory behavior.
5. **Negotiated metadata — dependency owner plus application mapping.** The public
   runtime previously discarded Agent identity/authentication display metadata
   and mode choices. The coordinator authorized a bounded readiness/persistence
   correction, implemented by the dependency owner, with public typed record
   fields. The facade now maps those fields into actual diagnostics and mode
   controls. Store/native-load retention and secret-like extension exclusion are
   covered by library tests; product tests verify effective/rejected mode changes.
6. **SDK preparation drift — dependency owner.** The guard originally checked
   acpx/patch bytes but not the actual SDK. Manifest and checks now require both
   the exact override and resolved SDK 1.8.0, with mismatched-install regressions.
7. **Failed cleanup recovery — facade and workspace.** A failed stop was memoized
   forever, preventing subsequent stop/app-quit cleanup retries; error-state live
   sessions also hid their End action. Failure now retains ownership while allowing
   another explicit cleanup attempt, and the UI keeps End available for live
   owners in an error state. A controlled one-shot public-runtime shutdown failure
   verifies the second stop succeeds and the record closes.
8. **Ambiguous permission IDs — facade.** Duplicate original IDs were accepted by
   the GUI mediator before the library rejected them. The mediator now requires
   exactly one matching original ID, leaving a legitimate pending request intact
   on invalid/ambiguous input. An owned peer offers conflicting duplicate IDs to
   exercise rejection followed by cancellation.
9. **New failed attempts versus legacy records — metadata reader.** Missing wire
   identity incorrectly labeled new schema-2 failed/cancelled startup records as
   legacy. Schema-2 records remain closed/error/transcript as applicable; resume
   requires an actual nonempty string wire ID. Old schema records stay read-only.
10. **Native presentation follow-up — original frontend owner.** Repeated generic
    status rows now form one collapsed Chinese activity group per turn, retaining
    raw public payloads and visible errors. Generic normalized tool-update labels
    no longer overwrite meaningful earlier tool names; genuine non-generic title
    updates still apply. The normalizer's explicit literal `tool call` and omitted
    title remain indistinguishable; this is a known public-normalization limit.

11. **Admission-scoped diagnostics — facade.** Constructing a local runtime emitted
    a session diagnostic before its directory admission succeeded. The diagnostic
    now follows successful session-map admission, so a rejected directory start
    cannot publish orphan session output. The product service regression checks it.
12. **Long draft restoration — renderer view-state.** Draft writes could contain
    up to the facade's accepted 200k input, while a fresh reader silently cut them
    to 20k. The restore bound now matches 200k; a fresh-module/localStorage test
    round-trips a 54k-character draft. Existing write/storage size did not increase.
13. **Unfinished native tools — facade.** Final policy tracing found that a model
    turn ending released the lease even if a reported tool remained pending or in
    progress. The coordinator approved conservative per-tool tracking: status-less
    and unknown partials preserve state, only explicit completed/failed updates
    settle a tool, and unresolved work at turn end keeps directory ownership with
    a visible stop instruction while its process lives. A real owned peer leaves
    a tool in progress, ends its model turn, and verifies an otherwise-idle second
    session conflicts until canonical first-session stop. Completed ordinary tools
    still release normally. The protocol/library model result is not assumed to
    establish tool completion.
14. **Modern categorized configuration — facade, shared DTO and SessionDetails.**
    Actual packaged Codex acknowledged `read-only` in its categorized config while
    the retained legacy mode remained `agent`. Explicit unique category `mode` or
    `model` now supplies the effective value/choices, with legacy metadata as the
    fallback; arbitrary option IDs are not guessed. Category survives the DTO and
    duplicate generic controls are hidden when the dedicated control is available.
    A mixed legacy/categorized peer deliberately leaves legacy mode stale, verifies
    acknowledged model/mode changes and rejected selections, and includes an
    unrelated uncategorized `id=mode` that must not override effective state.
15. **Permission-label clipping — original frontend owner.** Narrow native layout
    required wrapping original long permission labels. Only presentation classes
    changed; IDs/labels/actions remain original. The new CSS-class-mirroring test
    was removed under the developer's low-impact-test rule; actual native layout
    evidence belongs to the coordinator. Existing functional permission tests and
    the meaningful categorized-selector regression remain.

## Initially open findings resolved during the final gate

- **Delegated callbacks.** Initially `fs:true` / `terminal:true` were advertised
  while the underlying deny-all policy prevented their use. The coordinator chose
  the supported adapters' native-tool profile: all current profiles now explicitly
  set `fs:false` / `terminal:false`, with visible compatibility diagnostics. Native
  tool requests retain the exact per-turn permission mediator; no blanket automatic
  approval was introduced. The owned peer asserts callbacks are not advertised.
  This does not claim general compatibility with custom agents requiring them.
- **Unknown protocol updates.** Stock acpx dropped unknown structured events.
  The coordinator authorized a bounded passive fallback at the existing owned
  admission boundary. SDK-delivered unrecognized updates now produce public
  status diagnostics with sanitized `rawUpdate`; no readiness, permission or
  completion semantics are inferred. Depth 4, 128 nodes, 16 keys/object, 8 array
  entries and a conservative 6144-byte serialized raw budget apply. String/key/tag
  inputs are bounded before redaction to 256/64/128 UTF-16 units; redaction can
  expand short markers within the overall raw byte budget. Secret-like keys and
  common Bearer/sk/credential-assignment/PEM values are redacted. For future tags
  rejected by SDK 1.8's closed public schema, the original payload is omitted and
  raw-error logging suppressed: only an owned tag diagnostic with explicit
  `payloadUnavailable:true` survives. Validation is not bypassed and no private
  import/observer or unsupported feature was added. Foreign traffic, fake terminal
  claims, early/replay updates and clean child stdio have focused regression evidence.
- **Ordinary Chat fixture.** The first review run timed out. An owned diagnostic
  copy observed only `chat:permission`: unchanged HEAD
  `chat-store.ts` creates new sessions with `agent: true`, whereas the old first
  plain-chat send did not pass `agent:false`. The coordinator authorized fixture-only
  corrections: explicit plain-chat mode and migration from removed `db_list_tables`
  to the registered read-only `trellis_list_specs` tool in an isolated fixture
  project. Permissions, actual gateway execution, truncation and recovery checks
  remain exercised. Product Chat was not changed. The complete smoke now passes.

## Findings not fixed / review limitations

- **Literal placeholder title.** The published normalizer makes an explicitly
  supplied literal `tool call` indistinguishable from an omitted tool-update title.
  The documented narrow renderer preservation rule remains; non-generic explicit
  title changes are applied. Expanding another protocol contract was not justified.
- **Native/vendor/package evidence is separate.** No mock, hook harness,
  production build, or dependency process exit observation substitutes for actual
  Codex/Claude approvals, controlled writes, cancellation/restoration, native IME
  and layout, or the GUI-launched packaged restricted-PATH gate. The coordinator
  owns their actual matrix and outcomes; this reviewer does not claim those passes.

## Verification

- Lint: **not configured**; no lint script exists. No lint pass is claimed.
- `npm run typecheck`: **passed**, main and renderer, with compatibility precheck.
- `npm run build`: **passed**. The CommonJS main retains external public
  `require('acpx/runtime')` / `require('acpx/agent-registry')`, using Node/Electron
  `require(ESM)` support. acpx publishes an ESM runtime, not a separate CommonJS
  runtime build; keeping it external preserves package-relative `import.meta`.
  Existing module-type/dynamic-import
  warnings remain; no build-stack/tooling changes were made.
- `node scripts/smoke/acp.mjs`: **passed** actual product facade/owned peer,
  permissions/cancel/task rail/persistence/lazy native restore.
- `node scripts/smoke/acp-project-scope.mjs`: **passed** scope/IPC injection,
  case-normalized roots, invalid/stale/timed-out permissions and task boundaries.
- `node scripts/smoke/acp-ui.mjs`: **38 checks passed**; actual component hook/event
  handlers and projection, not a mounted/native browser layout test.
- `node scripts/smoke/acp-mock-agent.mjs`: **passed** remote IDs and exact allow/deny.
- `node scripts/smoke/acpx-runtime.mjs`: checker full strict fixture pass before
  the subsequent extensions; dependency owner's complete post-R3 **23/23** pass at
  `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-Z5k8r4/results.json`.
- `node scripts/smoke/acpx-preparation.mjs`: **6/6 passed**; dependency owner's
  final clean locked production install **7/7** pass at
  `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-preparation-83Z77W/results.json`.
- `node scripts/smoke/ipc-registry.mjs`: **passed**, all 161 invokes registered.
- `node scripts/smoke/navigation.mjs`, `uiux-wiring.mjs`, `render-contract.mjs`:
  **passed**.
- `node scripts/smoke/chat.mjs`: **passed** after the authorized fixture-only
  correction above. The original failed run remains part of this review chronology.
- `git diff --check`: **passed**, with existing Windows line-ending notices only.
- `scripts/smoke/acp-foundation.mjs`: final review regression run/result is recorded
  below; includes frozen launch/profile/mode/permission behavior,
  cleanup retry, real owned PID idle crash recovery, restore/stop races, immediate
  startup cancellation, and pending restore capacity admission.

Final foundation run: **13/13 named checks passed**, process exit 0, including the
last unfinished-tool and mixed categorized/legacy configuration regressions. The
final main/renderer typecheck and production build passed after those product
edits; UI hook suite passed 38/38.
Syntax checks for the new review suite and diagnostic peer, compatibility guard,
and final whitespace verification also passed. An earlier startup-cancel assertion
correctly exposed the schema-2/legacy classification defect; it was fixed and the
whole foundation suite rerun successfully, rather than dropping that assertion.

The final application batch ran all twelve commands independently with recorded
exit codes: typecheck, build, ACP service/scope/foundation/UI/peer, ordinary Chat,
IPC registry, navigation, UIUX and render contract. **All twelve exited 0** after
the stable callback/unknown-update decisions and final production fixes. Full logs
are under
`C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acp-final-check/`.
The dependency owner's complete post-R3 runs finished **23/23 strict runtime** and
**7/7 clean production preparation**, with no failures and owned exits accounted,
at the final paths listed above. The focused unknown-update pair additionally
passes with clean child stdio at
`C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-MKi5Qs/results.json`.

After findings 13–15, only affected checks were rerun: foundation, UI, service,
scope, independent typecheck and build, plus whitespace/syntax. All passed. Chat,
IPC/navigation/UIUX/render product paths and the dependency bytes were unchanged;
their existing final passes remain applicable. No blocking code finding remains.

## Spec handoff

The coordinator owns final spec/task reporting. Capture frozen launch provenance,
restore reservations and interrupted/legacy distinctions, cleanup retry ownership,
unique permission-ID validation, exact SDK/patch preparation, negotiated public
metadata, absolute explicit cwd, callback policy and the actual unknown-event
preservation limit. Preserve original stock failure evidence and keep all pending
real vendor/native/package rows explicit.

## Approved commit checkpoint (2026-10-17)

The user confirmed the two scoped work commits with “继续”. Feature commit: `f265a1db29db9fd4ed72ce5605c01a480f18a2a5`. Final staged-file audit found one cosmetic extra EOF blank in setup.ts, fixed without behavior changes. The patch container has185 Git indentation diagnostics caused only by its required unified-diff context SPACE before original TAB indentation. All247 actual inner added code lines have zero whitespace violations; patch syntax, patched JavaScript syntax and pinned compatibility guard pass. The patch/manifest bytes were preserved. Source whitespace excluding only this valid diff container passes. Unrelated working files remain excluded. Task remains in_progress for the documented native acceptance gaps.

The staged research audit also excluded an incidental generated PowerShell StartupProfileData binary cache. The file remains preserved locally under an explicit ignore rule; authored fixtures and recorded failure evidence are unchanged.
