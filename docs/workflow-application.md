# Desktop workflow application

The application composes the existing control worker, immutable material store
and ACP driver. It is not another model loop, transcript store or task/Jira
status authority. Source: src/main/services/workflow-application/ and desktop
composition: src/main/services/workflow-desktop.ts, src/main/ipc/workflow.ts.

## Admission and execution fences

Resolve a trusted canonical root and exact local task, verify originating native
session/task/connection, prepare immutable materials and preview before start.
The main resolver returns ResolvedApplicationDefinition with two distinct guards:

- assertCurrent():void|Promise<void> verifies source/origin freshness before
  preview/start. A changed source makes an unadmitted preview stale.
- assertExecutionCurrent():void is a REQUIRED synchronous main-owned launch
  configuration/permission fence. It must not depend on a mutable Flow draft or
  an unrelated originating conversation staying natively ready. Application uses
  it during stage resolution, prompt guards and preset handoff. Actual pinned
  runtime/profile drift still refuses launch.

readLocalApplicationDefinition supplies these guards; its assertExecutor option
is synchronous. The admitted definition remains fixed when the source draft is
edited. Structural changes still require the separate R1-05 adoption protocol.
Each preset stage has its own immutable material context/execution revision,
under stable runId/definition/node identity and explicit predecessor. This is
ordinary preset handoff, not structural adoption or product approval.

## Recovery and stopping

Start/stop identities come from persisted command semantics. A repeated stop
reads its exact stop outbox outcome. A failed/verified run is not a shutdown
receipt. Native creation in flight and missing stop acknowledgement remain
unconfirmed until actual evidence is recorded.

Main protects mutable origin and stage composers both with live controllers and
retained active/uncertain task heads after reopen. It lazily opens an existing
workflow-marker root; untouched ordinary projects create no control database
just to look for a managed session. Root/task changes never retarget an old
command. Switching a project releases the view subscription, not execution.

A terminal head commits before the controller finishes releasing ownership.
close() drains the actual execute promises and rechecks state before closing its
writer. Quit rejects unconfirmed outcomes and retains the controller for review.
No arbitrary native processes are killed by application recovery.

## Version and provenance limits

Desktop private configuration/output assets use content-derived version IDs, so
changed content cannot reuse an assetId/version with a different digest. Native
engine executable version remains unknown where unobserved. Workflow execution
sessions begin with native defaults and may be reused within the same task and
pinned executor. Temporary origin model/mode/reasoning selections are not silently
inherited; preview discloses this and actual stage configuration is recorded at
readiness. It does not imply native memory or internal child visibility.

Artifact reads require run membership and preserve known storage/corruption
errors. Main registers the verified immutable bytes with the existing document
reader. Opening selected A never substitutes the current file B. Raw chat text
stays in the existing history archive. Task/Jira/QA completion is separate from
checking declared nonempty output artifacts.

## Verification and current capability decision

workflow-application.mjs: actual SQLite/worker/application/driver/material groups
with an explicitly owned native transport fixture. workflow-desktop-host.mjs:
actual desktop composition with application/ACP boundary fixtures.
workflow-desktop-ipc.mjs: actual handlers/registry/preload with isolated
application/OS boundaries. No model/vendor, OS restart, packaged UI or human
acceptance is inferred from these checks.

Explicit native maxRounds is rejected during preview: this adapter cannot
bound the native engine's internal round/tool loop, and maxRepairTurns only
bounds declared output repair. Enabled completion notify/saveNote effects also
reject until actual adapters exist. False/absent completion effects are accepted
as intentional no-ops. These rejections happen before native creation/dispatch
and do not stop a healthy admitted run. Full R4/R6 capabilities remain owned by
those tasks; unsupported semantics are not silently dropped. Enforced Flow tool
sets and native tool nodes reject before dispatch. R1-05 adds a deterministic
artifact-content gate, bounded recorded branching, explicit revision preview/
adoption and retained-owner recovery inspection; see [workflow-revisions.md](./workflow-revisions.md).

Independent application13/host4 and the focused unsupported-option
probe pass with full typecheck/build. The final application/desktop review passed;
this does not close renderer/native/packaged/team/Jira or parent acceptance.
The desktop IPC suite now includes revision and path-free readonly recovery
routes (10 groups at this integration checkpoint). Recovery inspection does not
confirm native cleanup or authorize replay after restart.
