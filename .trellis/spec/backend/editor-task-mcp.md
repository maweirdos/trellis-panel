# Editor Task MCP

## Scope

The editor task MCP endpoint is the existing loopback TPAP service at
`POST /tpap/v1/mcp`. It uses the TPAP Bearer credential and Streamable HTTP
JSON responses. It does not expose a second TCP listener, a team-service token,
an editor cloud login or a native Daemon credential.

The first authenticated MCP request captures the current team connection,
account, device, project, service instance, service epoch and authorization
revision. Subsequent requests use that binding. A changed GUI selection,
connection, account, device, project, service epoch or authorization revision
never retargets the editor session. The captured connection remains the only
allowed scope and is rejected when its account, device, project or service
authority is no longer valid.

## Tools

The endpoint exposes bounded tools for:

- task discovery and fixed T03 development context;
- execution read, history, immutable input capture and fixed selection reads;
- editor-owned claim, progress, confirmed artifact, delivery manifest and
  checkpoint and execution finalization commands;
- cooperative editor release and exact command reconciliation;
- business transition through the existing task execution command handler.

The editor retains the original command UUID and complete input body before
sending a mutation. Capture, completion and business transition expose that UUID
in their tool inputs. A transition also retains the execution ID, generation and
workspace revision read before its first submission; retries cannot reconstruct
them from a newer execution head. The service response must match the original
task, account, device, epoch, command kind and generation before it is returned.

`team_cutover_check` reads current imported-task admission through the captured desktop team connection. Its input contains the fixed task identity; a successful reply returns the current admitted operation UUID or null for an ordinary task. No caller-supplied directory or filesystem-verification flag is accepted. Converted workcopies require the original verified local installation; this read neither installs files nor grants remote native directory authority. See [workcopy cutover](./workflow-cutover.md).

After claim, `team_task_capture_input` uses the existing input-command transport
to fix adopted portable workflow, Agent summaries, roles and resource selections.
`team_task_execution_input` reads that capture and its immutable resource bodies.
Both bind task/account/device/epoch to the current MCP session. Input capture
does not grant native directory access.

`team_task_complete` submits the existing execution finalization contract after
confirmed artifacts, delivery manifest and checkpoint. Progress cannot substitute
for completion. The following business transition still runs the shared service
gate, including any adopted database-delivery rule.

## Native provider context

`team_editor_session_bind` creates a local read selection; it does not claim, capture input or grant an engineering directory. Require explicit `connectionId`, `provider`, `nativeSessionId`, full `task`, `executionId`, `generation`, captured `inputDigest`, `rootNodeId` and `roleNodeIds`. Supported roles are implement/check/research/finish. Use `expectedRevision: 0` for first bind and the current returned revision for a different binding. Exact original retries retain their result; stale or conflicting rebinding returns `SESSION_BINDING_CONFLICT`.

`team_editor_hook_context` takes `{ provider, nativeSessionId, event, role? }`. Claude supports SessionStart/UserPromptSubmit/PreToolUse; Codex supports UserPromptSubmit/PreToolUse/SubagentStart. PreToolUse/SubagentStart require an explicit mapped role; Codex uses the parent native session ID. Root events select the bound root node. Never infer a task from the engineering directory, a current-task file, agent role or the first task.

Every bind/context read rechecks the original desktop account/device/connection, authorization revision, instance/epoch, active execution with `ownership: 'editor-owned'`, current handler/device, execution generation, captured input and cutover admission. The existing T03 composer reads immutable resource bodies and returns an `executionContextManifest` plus at most 8192 characters. Required Agent-instruction bodies must be nonempty and complete within the admitted budget. Missing binding/role, old generation, revoked authority, incomplete required context or connector drift returns `isError: true` with `{ status: 'unavailable', reason, code, message }`. No task/context fallback is permitted.

Selections use a bounded 64-entry in-memory map shared by the bridge and clear on close. Reopen requires a new explicit bind; in-flight requests cannot recreate a closed bridge's binding. A role only chooses a node within the fixed task/execution input. Provider-specific generation, bootstrap and blocking limitations are defined in [workcopy cutover](./workflow-cutover.md).

## Ownership and recovery

Task discovery is an ACL-filtered team snapshot. Fixed development context is
read through `taskDevelopmentContext`; it does not adopt inputs or grant native
directory access. Claim uses `ownership: editor-owned` and the current handler's
fixed input bundle. Product-managed native execution remains a separate owner.

Cooperative release writes the existing execution `release` command and reports
the supplied native state. It does not stop or inspect an external editor
process. An uncertain response remains uncertain until the same command is
reconciled; a new UUID cannot replace it.

The GUI may close while the Daemon and TPAP process remain available. Connection
revocation, project changes, epoch changes and service unavailability reject
new reads and writes with an explicit error. No cached task snapshot creates a
new authority.

## Limits

The endpoint accepts at most 16 editor MCP bindings, a 1 MiB JSON body and the
existing team-service and execution-record limits. Tool inputs and outputs use
the shared Zod contracts. Credentials, private native paths and conversation
transcripts are not returned by the editor tools.

The endpoint does not schedule a whole workflow, create a native editor
process, provide a legacy command facade or present the product UI. UI
presentation remains owned by T10.

## Required verification

Use OS TEMP for MCP clients and state. Verify Codex and Claude MCP discovery,
fixed binding, claim competition, fixed context, progress, confirmed output,
cooperative release, command reconciliation, revocation, GUI closure and
uncertain response handling. Run root typecheck, build, `check:acpx` and
`check:ui` when the affected production checks are applicable.
