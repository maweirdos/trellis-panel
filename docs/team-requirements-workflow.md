# Shared requirements and task handoff

## Start and membership

The Web modules are **工作台**, **资料**, **成员与设置** and **设备**.
An account without an authorized workspace can create a team/workspace or open
an invitation from its first screen. Creating a team continues into workspace
creation. An empty workspace offers the space creation form directly.

An invitation grants the displayed team and workspace roles only after the
specified account explicitly accepts it. Registration and sign-in preserve the
pending invitation. Acceptance selects the invited workspace and removes the
consumed URL token. A member without a joined space can join an available public
space or ask an authorized manager for private-space access.

Space membership selects existing, active workspace accounts. It neither creates
accounts nor changes their workspace roles. The active space owner remains a
member. Authenticated `projectRoles` provide responsibility suggestions; a display
name or job title does not grant permissions. An explicit recipient choice is
retained when a suggestion changes.

## Team model setup

A team administrator configures the compatible model endpoint, model identifier
and API key once. Members use that shared capability. The requirements window
offers administrators an inline configuration form and retains the entered
customer text and selected sources. Ordinary members see availability and a
recheck action instead of credential fields.

The endpoint must be an exact HTTPS `chat/completions` URL. Plain HTTP requires
the service operator's explicit origin allowlist. Provider keys are not stored
in browser drafts or returned by configuration reads. Generation uses the
configuration revision captured for that request.

The local launcher provisions a private, stable external encryption-key file
when starting a new unconfigured local store without an explicitly supplied
key. Existing encrypted stores require their original key. Intranet deployment
continues to require operator-managed credential protection.

## Draft requirements

In a shared space, **新建任务** opens **从客户诉求整理需求**. Manual entry remains
available. Describe the customer problem, attach supported text files, and
optionally select immutable versions from the workspace's published materials.

**保存素材并开始讨论** saves the original request as a visible triage task before
submitting the generation request. Further answers update a candidate for that
same task. They do not create another task. The source panel identifies the
captured task, explicit text, selected published material versions and applicable
published team rules.

Rules use the same task-type applicability, priority, conflict and withdrawal
authority as fixed task inputs. A required conflict prevents generation. A later
publication does not replace a captured rule version. Providing a rule body is
not proof that a model read or followed it. This entry does not inspect Git
source or verify deployed behavior.

The candidate contains the business goal, evidence, scope, main and exceptional
flows, fields, page states, acceptance criteria and remaining questions. Missing
facts remain questions. Acceptance lists and tables are converted into task
criteria without treating table headings or separators as checks.

**保存需求草稿** saves a PRD draft and updates the original task's title and
criteria. The task description retains the original request and attachments.
It does not submit a review, approve a document or advance the task.
**采用并提交评审** requires an explicitly selected space colleague and sends the
fixed PRD version for review. An authorized owner can add an existing workspace
colleague from the same requirements window and return to the retained draft.

The first adoption freezes the body, sources, reviewer and save mode. An
unconfirmed save must be reconciled under its original command UUID. It cannot
switch between draft and review modes or overwrite a colleague's changed body.
Formal task criteria remain protected after initial triage or workflow history.

## Review and stage work

The actual reviewer receives a fixed-version request in **收件箱**. Reading the
request opens the original task. Approval or rejection notifies the submitter;
a rejection retains its reason. Draft editing cannot replace the submitted
version. Revoked or resolved reviews do not remain actionable requests.

The task workbench shows the current phase, responsible colleague, execution
configuration, required input, expected output and available next action. PRD
review status identifies the version, reviewers and decision. Confirmed material
writes refresh the input candidates without replacing an unsaved selection.

Approved documents still require an explicit fixed-input adoption. **核对任务输入**
opens that comparison. **接纳并安排** selects the next phase and responsible
colleague. Selecting **直接开发** suggests a colleague with the authenticated
developer responsibility when no recipient has been explicitly chosen.

Starting manual design opens the shared design editor. Design handoff can select
a real shared fixed version rather than requiring an external URL. Material
approval and responsibility transfer remain distinct confirmed operations.

Agent configuration can be created in the current handoff and selected without
discarding that handoff draft. It describes execution; the responsible colleague
remains a person. Saving or assigning an Agent does not run a local model, produce
a design or complete a business phase.

## Desktop and recovery

Browser **在桌面继续开发** exposes the original task and its source. The responsible
colleague can open the same task from the matching account/workspace's desktop
inbox. Directory binding, Git checks, local execution and service startup remain
explicit desktop operations. Returning to collaboration does not stop or move a
running service.

Web task URLs contain the authorized project, task number and creation time.
Refresh restores only that current visible task. A missing, inaccessible or
recreated identity does not fall back to a different task or repository. URL
parameters never grant access or local execution authority.

A failed generation retains the original material and previous candidate. An
unknown outcome is reconciled instead of resent as a new request. A cancellation
does not turn a late response into an adoptable candidate; actual usage remains
accounted for. If first task creation is unconfirmed, resolve the workspace's
original operation before opening the saved task; the intake does not guess an
identity or create a duplicate.

Requirements intake currently starts new work. Changes to an existing formal
task use shared document revisions and its existing workflow controls; generation
does not silently replace agreed acceptance criteria. Automated repository
analysis, Figma import, high-fidelity design generation, scheduling and unattended
execution across every phase are outside this entry.
