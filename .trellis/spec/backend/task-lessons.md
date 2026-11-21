# Completed task evidence in rule drafts

## 1. Scope / Trigger

Read when connecting fixed task results to governance rule drafts, changing
`lessonOrigin`, or validating the later adoption of a learned rule.
Reuse the existing execution, governance, journal and task-input owners.
Learning is optional and never a condition for business acceptance.

This path updates team rules. It does not edit repository Specs or establish
repository authorship, review or synchronization.

## 2. Signatures

`GovernanceLessonOrigin` in `shared/team-governance.ts` contains:

```ts
{
  task: TeamTaskRef
  artifact: ExecutionArtifactRef
  base: {
    packageId: string
    versionId: string
    bodyDigest: string
    revision: number
  }
}
```

The original governance `saveDraft` command accepts optional `lessonOrigin`;
the immutable `GovernanceVersion` retains it. Only rule content may carry it.
The existing governance command, receipt and version-read routes remain the
transport. No separate proposal store, publication operation or IPC is required.

## 3. Contracts

- Source task identity includes service instance, project, space, task ID and
  creation time. The artifact identifies execution, artifact, version and digest.
  A displayed task number or artifact title is insufficient.
- For an explicit new origin, validate the target grant, same project/space,
  current source access and original task incarnation in the governance mutation.
  The authoritative task status must be business-complete; a workflow task must
  also be at `done`. Native completion alone does not satisfy this condition.
- Use the existing execution owner to require a completed finalization containing
  the exact artifact reference and to resolve its verified bytes. A confirmed
  artifact absent from that finalization cannot be promoted from this path.
  The caller does not supply a substitute finalization or source body.
- The base must identify the exact current target draft and its digest.
  `base.revision` equals the package CAS `expectedRevision`, not a draft number
  or task-input revision. A conflict requires explicit comparison.
- Persist the source with the new immutable rule version. The edited rule text
  is a proposal based on evidence; source verification does not establish the
  proposal's correctness or its equivalence to the source.
- Omitting a new origin in a later ordinary edit retains the current draft's
  origin. Its historical base is not a new save precondition. Old records without
  an origin retain absent-field serialization.
- Submit, publish and later adoption remain separate explicit operations under
  existing grants and revision checks. Rule access does not grant access to its
  source artifact; resolve a source preview under the viewer's current rights.
- Preserve the original UUID, complete body, source and base through unknown
  replies. Receipt recovery does not reapply a source check as a new mutation
  or silently retry with a newer base. A rejected source-bound save cannot
  fall back to a source-free save.
- Later tasks explicitly adopt the published version. Capture and local package
  generation consume that fixed version; earlier execution inputs remain pinned.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Origin on workflow-template content | Schema rejection |
| Wrong source project or space | `GOVERNANCE_LESSON_SCOPE_CONFLICT` |
| Changed package CAS | `GOVERNANCE_REVISION_CONFLICT` |
| Wrong compared draft, digest or base revision | `GOVERNANCE_LESSON_BASE_CONFLICT` |
| Task not business-complete | `GOVERNANCE_LESSON_NOT_CLOSED` |
| Artifact absent from completed finalization | `GOVERNANCE_LESSON_OUTPUT_CONFLICT` |
| Wrong incarnation, denied source or corrupt bytes | Existing execution-owner rejection; no rule version |
| No useful lesson | No promotion; normal task acceptance remains available |

## 5. Good / Base / Bad Cases

Good: a maintainer compares a completed task's fixed implementation report with
rule draft A, saves a scoped revision B, and an authorized reviewer publishes B.
A later task explicitly adopts B while the earlier task retains A.

Base: an ordinary rule edit has no new origin and uses the original governance
workflow and command serialization.

Bad: use an arbitrary confirmed but undelivered artifact as closure evidence,
overwrite a changed draft, or interpret publication as proof of later use.

## 6. Tests Required

Keep validation programs and evidence in OS TEMP. Use actual governance and
execution owners to cover source ACL/incarnation, business completion,
finalization membership, exact base, independent review/publication, historical
origin retention and lost-ACK recovery of one original command/version.

Verify the later task's adopted version and fixed body digest in execution input,
local package and delivered native context. Inspect an observable output under
the new rule. Prepared context or an adoption receipt alone proves no actual
model use. Label controlled native callbacks separately from real provider runs.

## 7. Wrong vs Correct

Wrong: after a conflict, remove the origin and submit the same proposed text
against the latest rule without comparison.

Correct: retain the original outcome and draft, compare the current rule and
fixed source, then deliberately create a new command with that compared base.
