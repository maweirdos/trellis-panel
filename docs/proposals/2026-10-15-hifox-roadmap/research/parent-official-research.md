# HiFox reference research for trellis-panel

Research date: 2026-10-16. Purpose: inform a trellis-panel roadmap and PRD, not establish feature parity or reproduce HiFox's interface. Evidence is official public documentation, fetched read-only. This report does not claim live product UI verification. Documentation claims are not independently verified implementation guarantees. URLs are recorded per capability below. Broad coverage includes all 47 documentation pages linked from the welcome page plus the service terms and privacy policy. This synthesis preserves precise source URLs for review.

## Executive findings

HiFox positions itself as a team orchestration and work-management layer around existing coding tools. The task is its durable collaboration object, while agent configuration, execution runtime, and host computer are distinct concepts. Its central user problems are context scattered across chats and terminals, invisible execution, conflicting concurrent file edits, reusable expertise trapped with one developer, and handoffs that require repeated copying. The proposed adoption path is incremental: retain human workflow and existing systems, delegate one bounded step, then reuse agents, skills, crews, and automations. Source: https://help.hifox.com/docs/welcome

For trellis-panel, the strongest opportunities are trustworthy execution visibility, explicit human accountability, recoverable failure states, permission-aware context, and acceptance evidence. Copying every project-management and migration capability would be an unvalidated scope expansion. All recommendations in this document are proposals pending repository and roadmap reconciliation.

## Actors and conceptual model

Documented actors include organization Owner/Admin/Member/Guest, space administrators/members/visitors, human task assignees and reviewers, agent owner, runtime/computer owner, crew owner and agent leader, external source identities, integration administrators, and external chat participants. Organization Guest and space visitor are separate concepts. The last Owner cannot leave or be demoted without another Owner. Guest access is explicitly invited; organization administration does not itself grant private-space task access. Source: https://help.hifox.com/docs/space/members

Conceptual entity map (research interpretation, not a recovered database schema):
- Organization contains spaces, identities, reusable classifications and integrations.
- Space scopes work, membership, agent/crew eligibility, workflows and automation.
- Task carries requirements, human accountability, an independent agent-or-crew execution slot, discussions, related work, artifacts, and histories.
- Project groups a goal across potentially several spaces; iteration groups a time window within one space; saved view is a query/presentation configuration, not copied work.
- Agent is reusable work configuration; runtime is execution tooling; computer supplies actual files, credentials and resources; run is one execution attempt; conversation supplies a run context.
- Skill is reusable instruction material. Crew adds coordination rather than automatically launching every member.
- External identity preserves attribution without creating a licensed member or login identity.

## Coverage and source matrix / functional capability inventory

Each row is documented evidence. “Opportunity” entries later are separate proposals. Paths are full official URLs, not guessed app routes.

| ID | Capability / documented behavior | Boundary or acceptance-relevant detail | Source |
|---|---|---|---|
| H01 | Progressive onboarding: connect computer, configure bounded agent, assign small task. | Existing coding subscriptions/API usage remain relevant; HiFox is not the coding runtime itself. | https://help.hifox.com/docs/quickstart |
| H02 | Agent configuration combines instructions, space/visibility, runtime/computer, skills, repositories, environment and concurrency/time limits. | Private/shared and same-space eligibility; design-creative type unavailable. Agent archive cancels running work while retaining history. | https://help.hifox.com/docs/agent-and-computer/agents |
| H03 | Execution collects task context and dispatches via local service; queued, starting, processing, completed, failed, cancelled states and transcripts. | Queue reasons distinguish host/agent limits and directory locks. Trigger identity affects permission; completion of a run is not completion of the task. | https://help.hifox.com/docs/agent-and-computer/agent-task-execution |
| H04 | Temporary or existing working directory; Git worktree isolation or direct execution. | Direct execution serializes one task per directory; non-Git directories require direct mode. Worktree mode accepts one source directory. | https://help.hifox.com/docs/agent-and-computer/working-directory |
| H05 | Bind repositories to space or agent; agent-specific configuration takes precedence. | Git authentication and executable tools must work on the actual computer. Hosted Git integration alone does not authorize clone. | https://help.hifox.com/docs/agent-and-computer/repositories |
| H06 | Activity/comments, replies, resolved threads, mentions, attachments, quick replies, sharing. | Plain comments do not trigger assigned agents. Mention creates a conversation; continuing requires replying in that conversation. Snapshot sharing has public-link or organization scope and revocation. | https://help.hifox.com/docs/agent-and-computer/comments-and-replies |
| H07 | Personal Inbox aggregates task notifications, importance, read/unread, clear/restore, snooze, search/space filtering. | Reading does not resolve work or change importance. Bulk actions respect current filters. Conversation handoffs are primarily in Conversations; see conflicts below. | https://help.hifox.com/docs/agent-and-computer/inbox |
| H08 | Private standalone chat, task-scoped chats, crew chat, quick commands, file output and share snapshots. | Chat does not automatically become a task or public comment. Archived/unavailable agents preserve history but constrain new messages. | https://help.hifox.com/docs/agent-and-computer/chat-with-agent |
| H09 | Computer registration, heartbeat, runtime discovery/install/configuration/testing, service start/stop/restart, local/remote/Docker. | Online host differs from available runtime. One-time install tokens; manual model IDs fail explicitly rather than silently switching models. Restart/stop can interrupt work. | https://help.hifox.com/docs/agent-and-computer/computers |
| H10 | Skills from space, manual creation, file/folder/archive, URL, or discovered runtime; bind to agents. | Imported material becomes a managed copy, not live source sync. Offline installs queue. Unsafe paths/archive entries and unsupported binary content are rejected. | https://help.hifox.com/docs/agent-and-computer/skills |
| H11 | Crew with human owner, agent leader, human/agent members and instructions; task or chat use. | Leader starts first and decides delegation. Same-space membership; crew-exclusive agents cannot be separately assigned. Access loss preserves prior user's chat history read-only. | https://help.hifox.com/docs/agent-and-computer/crews |
| H12 | Spaces configure work purpose, unique identifier, access, workflows, repositories and optional modules. | Duplicate names possible; IDs distinguish them. Private-space content is membership restricted. Disabled spaces become read-only; copying configuration does not copy members. | https://help.hifox.com/docs/space/spaces |
| H13 | Tasks capture title, description, type, status, priority, labels, project, human owners, execution slot, activity, subtasks and relations. | Human and agent responsibility coexist. Requirements and acceptance should be explicit; ordinary creation and external triage have different defaults. | https://help.hifox.com/docs/space/tasks |
| H14 | Organization and space role management, email/link invitations, guest collaboration. | Copying an inactive invite link activates it; link invitations cannot directly invite Admin. Role names at the two scopes have different semantics. | https://help.hifox.com/docs/space/members |
| H15 | Projects group goal, owner, status, priority, progress, tasks and timeline across spaces. | Adding tasks from an unassociated space prompts association/removal. Project deletion normally preserves tasks. | https://help.hifox.com/docs/space/projects |
| H16 | Board/list/table, filters, sorting, grouping, batch edits, saved personal/shared views; personal board preferences and team defaults. | Personal → team → system precedence. Hiding columns does not alter tasks; at least one visible column. Multiple assignees can show a task in multiple groups while total is deduplicated. | https://help.hifox.com/docs/space/views |
| H17 | Optional iterations, automatic cadence or manual mode, future cycles, cooldown, carryover, capacity/completion/burn-up. | Manual mode permits parallel active cycles. Auto-enrollment is based on changes within the applicable time window, not all historical matching tasks. | https://help.hifox.com/docs/space/iterations |
| H18 | Optional space triage: accept, reject, duplicate, snooze; owner notification/assignment; ordered routing rules. | Priority can be mandatory before acceptance/iteration entry. Rules can overwrite earlier conflicting fields. Disabling migrates pending work to backlog and fails if a valid destination is absent. | https://help.hifox.com/docs/space/triage |
| H19 | Automation executes instructions through same-space agent/crew; schedule, status transition, comment keyword, secret webhook; multiple triggers. | Run history/health and final-result recipients. No implicit task per run; no promised automatic retry. Pause/archive stop scheduling. | https://help.hifox.com/docs/space/automations |
| H20 | Task types govern enabled space types, workflow, custom fields, ordering and defaults. | Field types include text/number/select/multi-select/boolean/date/member/URL/rich text. Disable retains values; unbind/type conversion may destroy values and require confirmation. | https://help.hifox.com/docs/task/task-types |
| H21 | Followers, auto-follow on creation/assignment/comment/member fields; mentions and assignment are separate. | Following does not assign accountability or guarantee all notifications. Auto-follow is idempotent; field clearing does not forcibly remove manual following. | https://help.hifox.com/docs/task/follow-tasks |
| H22 | Organization/space labels, mutually exclusive groups, bulk operations, archive, merge. | Same-group selection replaces prior label; cross-space moves may remove source-space labels. Archive preserves historical labels. | https://help.hifox.com/docs/task/task-labels |
| H23 | Stable status categories underpin configurable names and per-type workflows. | Terminal states cannot be defaults; deleting used status requires migration. Backlog suppresses auto-start; explicit follow-up may still invoke agents on completed tasks. | https://help.hifox.com/docs/task/task-statuses |
| H24 | Directed blocker/clone/duplicate and symmetric related links; subtasks separate; custom relation types. | Same organization, cross-space possible. Relations do not automatically transition status. Used custom relationship types cannot simply be deleted. | https://help.hifox.com/docs/task/task-relations |
| H25 | Platform concept mapping explicitly distinguishes spaces/projects/types/iterations/hierarchy. | Jira Epic maps to project, while similarly named TAPD story types and ZenTao business requirements do not. Unsupported outbound fields retain local edits unless remote field itself changes. | https://help.hifox.com/docs/integration/concept-mapping |
| H26 | Jira API/CSV historical import, preview, issue scope, status/user mapping, progress, rollback; ongoing project-space sync separately. | History not automatically replayed on connection. External identities preserve authorship. Sync warnings distinguish mapping, credentials, required fields, webhook and conflict issues. | https://help.hifox.com/docs/integration/jira |
| H27 | Jira-compatible REST v2/v3 subset for tasks/comments/search/transitions with PAT identity and ordinary side effects. | 600 requests/minute/source; max page 100. No agile boards, attachments, worklogs, watchers, webhooks or custom-field mapping. Numeric task IDs rejected in favor of keys. | https://help.hifox.com/docs/integration/jira-api |
| H28 | ZenTao product/project import and ongoing sync; intranet proxy computer route. | Domestic HiFox only; REST v1 minimum versions documented. Connection, link and callback are distinct setup stages. Unsupported writebacks cannot be fixed by retry. | https://help.hifox.com/docs/integration/zentao |
| H29 | TAPD import/API or exported Excel; mappings, historical backfill, sync, field degradation warnings. | Paid API account supports bidirectional realtime; personal token does not. Custom fields/start dates/iterations do not write back. Rate-limit wait is distinguished from failure. | https://help.hifox.com/docs/integration/tapd |
| H30 | PingCode import and periodic incremental sync, explicit comment publishing, writeback, source-key deduplication and rollback. | Polling rather than realtime; tokens approximately 30 days without automatic renewal. Field losses/degradation surfaced individually. | https://help.hifox.com/docs/integration/pingcode |
| H31 | Teambition application + personal authorization, import wizard or exported CSV, user/status mapping, webhook/poll fallback. | Gradual availability; bidirectional writes gated on remote capability validation. Enterprise setup needed for API application. Remote deletion events do not directly delete local tasks. | https://help.hifox.com/docs/integration/teambition |
| H32 | GitHub App repository authorization, PR/commit associations, new-Issue sync, individual identity and backlinks. | No historical Issue import; one bidirectional repository per space. PR merge does not close tasks. Public backlinks default off; exporting private work to public repository requires explicit warning. | https://help.hifox.com/docs/integration/github |
| H33 | CNB token + repository pairing + .cnb.yml events; MR/commit/issue association and backlinks. | Token validation/encrypted storage documented. Missing default-branch configuration may silently prevent events. Disconnect preserves records. | https://help.hifox.com/docs/integration/cnb |
| H34 | GitLab.com OAuth and self-hosted PAT separately; issues, MR/commit association, webhook and identity mapping. | Self-hosted intranet proxy supported; organization PAT account requires relevant API/project privileges; personal identity can fall back to integration account. | https://help.hifox.com/docs/integration/gitlab |
| H35 | Feishu/Lark task assistant, agent bot, outbound resource connector and organization preview/notification assistant. | Four distinct directions/authorization scopes. Lark and Feishu are separate clouds. Thread context and explicit bindings matter; external users preserved as external identities. | https://help.hifox.com/docs/integration/feishu |
| H36 | WeCom task assistant and agent bot; direct/group-mention conversation, files and /new. | No Feishu/Slack-style reaction or all-message triggers. Agent bot conversation does not automatically create tasks. | https://help.hifox.com/docs/integration/wecom |
| H37 | DingTalk task assistant and agent bot; QR/manual configuration; direct/group mentions and /new. | No reaction/all-message triggers documented; one DingTalk entry per agent. Disconnect preserves prior records. | https://help.hifox.com/docs/integration/dingtalk |
| H38 | WeChat QR connection for agent conversation, files and new-session command. | One WeChat account cannot bind multiple agents; conversation does not implicitly become tracked task. | https://help.hifox.com/docs/integration/wechat |
| H39 | Slack workspace task creation/update/link previews/notifications, agent bots, task assistants and thread bindings. | Workspace and personal identity connections differ. Fields remain permission constrained; explicit external reply composer differs from internal comment. | https://help.hifox.com/docs/integration/slack |
| H40 | Discord agent bot and task assistant, DMs/mentions/threads, optional reaction/message triggers, files, /new. | Message Content Intent and channel permissions affect coverage. Default ordinary channel messages do not trigger; disconnect preserves history. | https://help.hifox.com/docs/integration/discord |
| H41 | Feishu support workflow converts conversation evidence into a task and returns progress to original topic. | Example workflow, not proof of unrestricted synchronization across every integration. | https://help.hifox.com/docs/best-practices/feishu-group-to-task |
| H42 | Documentation pipeline identifies published changes, proposes update plan, human review, then document changes/preview. | Human approval remains an explicit stage; publication discovery does not imply automatic public release. | https://help.hifox.com/docs/best-practices/documentation-automation-pipeline |
| H43 | Testing workflow separates preflight, version checking, requirements-to-cases and browser/desktop execution. | Human test planning, ambiguity handling and final acceptance remain. Runtime/environment availability must be validated. | https://help.hifox.com/docs/best-practices/full-flow-automated-testing |
| H44 | Product workflow: capture → investigate/clarify → human scope/acceptance → decompose → parallel execution → human validation. | Guidance illustrates orchestration, not a fixed mandatory workflow for trellis-panel. | https://help.hifox.com/docs/best-practices/product-development-workflow |
| H45 | CLI covers authentication, computer operations and work-management automation. | CLI and coding-runtime authentication are different. Inspect current command help/version rather than assuming every runtime shares parameters. | https://help.hifox.com/docs/cli/cli |
| H46 | Personal access tokens identify the user; expiry, one-time display, usage prefix/time, revocation. | No creation-time scopes. Logout removes local credential only; server revocation is separate and may disconnect associated computers. | https://help.hifox.com/docs/cli/access-tokens |
| H47 | Service terms describe processing/third-party/runtime responsibilities and user review obligations. | They are not security certification or a technical enforcement guarantee; runtime behavior is not fully controlled/warranted by the orchestration layer. | https://help.hifox.com/legal/terms-of-service |

## Data movement and permission boundaries

1. Task/agent configuration → dispatch service → computer-local service → coding runtime → model/service and local files → logs/results/artifacts back to task. Repo credentials are an execution-host concern, separate from PR/Issue integrations. Worktree isolation protects against accidental shared edits; it is not evidence of filesystem, network or credential sandboxing. Sources H03–H05, H09.
2. Human-triggered run identity is documented as the initiating human's authority, capped by the agent owner's authority; removed organization users are denied rather than falling back. External-channel or system-triggered runs use the agent owner's permissions. This asymmetry is material to a threat model. Source H03. Do not extrapolate that every downstream CLI enforces the same resource boundaries.
3. Import reads a bounded external snapshot into local entities. Sync is a persistent directional relationship with mapping, provenance, identity and conflict implications. Disconnect, rollback, remote deletion and local deletion must be independent concepts. Sources H25–H34.
4. Internal collaboration and outbound replies are distinct publishing destinations. GitHub's own task comment composer is internal; its source-specific reply composer publishes. Slack/Feishu topic bindings have their own thread direction rules. Sources H32, H35, H39.
5. Private task access, shared-view visibility, agent availability, computer sharing and credential selection are separate authorizations. A saved view cannot broaden resource access. Private-space administrator metadata access is not permission to read content. Sources H12, H14, H16.
6. Public conversation/comment snapshots are explicit exports. Later edits do not change them; revocation is separate. Imported third-party material may be ineligible for sharing. Sources H06, H08.
7. PATs currently inherit account privileges without narrower scope selection. Credential lifecycle and exact destination matter; masking is not permission isolation. Source H46. Jira/CNB docs make specific encrypted-storage claims, not a blanket assertion about all data. Sources H26, H33.

## Useful interaction patterns (analysis/proposals)

- One task detail workspace with stable context and adjacent run/conversation drawer; don't force navigation away to understand execution.
- Separate lifecycle badge and execution badge. Every queued or blocked state exposes its cause, owner, next action and whether recovery is automatic.
- Empty and unavailable states explain the next setup action. Distinguish offline, not installed, detection failed, unavailable to this space, starting and upgrading.
- Preserve draft edits and navigation context. Save success determines persistence; reloading must never repeat an execution command.
- Personal preferences override team defaults without silently changing other users' boards. “Reset” has explicit scope.
- Treat an action-required Inbox as a routing problem, with deduplication, importance, sender/recipient identity and deep links to relevant evidence.
- Import wizards show preview, cardinalities, mappings, skipped fields and terminal outcomes before the user trusts “success.” Source-system warnings are actionable and preserve raw diagnostics without leaking credentials.
- Confirmation at true consequence boundaries: publish externally, expand access, destructive field migration, terminate running work. Avoid a generic confirmation on every harmless click.
- Resource-specific permissions and historical read-only access deserve explicit tests; hiding UI alone is not enforcement.

## Documentation ambiguity / limits requiring live verification

| Issue | Evidence | PRD treatment |
|---|---|---|
| Same agent/task parallelism | Execution page says independent conversations can run simultaneously except shared-directory cases; comments page says repeated same-agent runs on one task serialize. | Define scheduling key precisely; verify conversation/run/directory ownership and locking before adopting. |
| Inbox vs Conversations | Execution/Inbox pages move reply/review handoffs to Conversations; follow/comments pages retain older Inbox phrasing. | Use one explicit notification routing table, with recipient, channel, dedup key, read behavior and retention. |
| TAPD polling | TAPD page says “immediate check” is on-demand rather than continual polling, later describes scheduled shared checks for personal-token connections. | Treat cadence as unresolved; do not promise realtime or constant polling. |
| Jira direction label | “Jira → HiFox” still permits some updates to already linked remote items. | Specify allowed outbound field operations rather than relying on arrow labels. |
| Runtime model override | Agent page describes fixed --model cases; computer page says runtime --model supplies a default without locking explicit selections. | Validate precedence per runtime and show effective values. |
| Attachments | Comment page distinguishes body removal from deletion, then states saving removal from comment body permanently deletes the file. | Require surface-specific deletion semantics, recovery policy and confirmation; verify rather than copying ambiguous behavior. |
| Permissions | Several pages qualify capabilities as online-version-dependent, especially public-space visitor behavior. | Build a tested action/resource role matrix; mark unresolved cases. |
| Feature availability | Creative agent type unavailable; Teambition gradual rollout; exact runtime support follows live product matrix. | Separate shipped, documented, gated, planned and unknown capabilities. |

Not established by this research: SOC 2/ISO certification, encryption coverage/algorithms, exact deployment-specific data residency, tenant isolation implementation, all-provider model-training exclusion, audit immutability/retention, backup/RPO/RTO, formal SLAs, all permission checks, webhook idempotency/retry guarantees, automatic merge safety, accessibility conformance or quantitative performance. These are verification questions, not accusations of absence. No pricing or contractual recommendations are made.

## Transferable opportunities and candidate measurable acceptance

These are original suggestions, not claims that trellis-panel already supports them. Map these to verified code and the existing roadmap before adoption.

| Opportunity | User value / risk addressed | Candidate acceptance evidence |
|---|---|---|
| Explicit run state machine | Users know whether to wait, act or retry. | Every persisted run reaches a documented terminal state or has a visible active reason; duplicate delivery does not create a second execution; stale heartbeat transitions are tested with controlled clock. |
| Human owner + execution worker | AI does not erase accountability. | Assign/unassign agent leaves human owner unchanged; all filters/counts reflect both independently. |
| Execution preflight | Prevent “online but unusable” confusion. | Read-only probe verifies host, runtime, cwd, repository and result channel; each failing dependency has a named remediation and no code is modified. |
| Secure resource provenance | Prevent owner-authority escalation and private-data leakage. | Tests cover cross-space denial, revoked initiator, credential scope, external trigger identity and confidential title leakage through references. |
| Durable context and artifact evidence | Reduces terminal/chat copying. | A reviewer can navigate goal → run → changed artifact → verification output; failed/skipped checks remain distinguishable from passes. |
| Idempotent event ingestion | Avoid duplicated tasks and loop storms. | Replaying identical event ID 10 times creates one logical outcome; outbound echo does not retrigger itself; retry exhaustion exposes reason. |
| Honest external sync | Prevent accidental publication and data loss. | Preview names destination and fields; unsupported fields appear individually; disconnect preserves records; deletion propagation requires explicit policy. |
| Action-required queue | Reduce noisy notification checking. | Same task/event family aggregates; snoozing does not alter task state; deep link highlights exact surviving target with safe fallback. |
| Configuration/version evidence | Reproducible agent runs and reviews. | Run records retain effective configuration version, trigger, environment, model and artifact references; secret values are redacted. |
| Safe multi-agent coordination | Prevent shared-workspace corruption. | Lock contention and cancellation tests show no concurrent direct writes; isolated runs use distinct directories; leader failure has defined recovery. |

Priority recommendation: preserve existing trellis-panel scope. First prove one end-to-end work item → execution → evidence → human review path with reliable state and access controls. Then add reusable workflows and multi-agent coordination only when supported by validated user needs and architectural readiness. Broad migration integrations and enterprise portfolio features should remain optional until justified.

## Professional PRD / requirements guidance

Primary sources checked:
- ISO/IEC/IEEE 29148:2018 public scope page: https://www.iso.org/standard/72089.html . It describes lifecycle requirements engineering, required information items/content and formatting guidance. The public listing indicates confirmed in 2024 and a revision under development. This research did not purchase/read the complete standard and does not establish compliance.
- NASA requirements management: https://www.nasa.gov/reference/6-2-requirements-management/ . Supports bidirectional traceability, controlled baselines, ownership, impact analysis, and linking requirements to design/test evidence. Derived requirements should be identified rather than disguised as stakeholder demands.
- NASA handbook appendices: https://www.nasa.gov/reference/system-engineering-handbook-appendix/ . Public requirements-writing and verification-matrix guidance is a practical checklist, not a mandate to copy aerospace governance into a software product.

Recommended PRD record (original tailoring): ID; stakeholder/problem; source/evidence; requirement statement; rationale; in/out scope; priority and release; prerequisites; actor/permissions; normal/alternative/error flows; data model/API effects; acceptance criteria; verification method/test IDs; telemetry; dependency; risk; owner; status; unresolved decision. Record baseline date/version and change rationale.

Example trace: user pain → roadmap outcome → requirement TP-RUN-001 → state-machine design → implementation modules → test cases → release evidence. A requirement should identify one observable obligation and avoid subjective words such as “seamless,” “fast,” or “secure” without a measure. Quantitative thresholds must be stakeholder-approved or explicitly proposed, with load, platform, observation interval and failure conditions. Avoid inventing numeric SLAs from competitor documentation.

Coverage checklist for the final trellis-panel PRD:
1. Product problem, target users, exclusions, measurable outcomes and assumptions.
2. Verified existing capability baseline with code/UI evidence and known technical debt.
3. Information architecture, actors, permissions, entity relationships and state machines.
4. Prioritized functional requirements with complete exception/cancellation/retry behavior.
5. Integration contracts, provenance, identity, data direction, consistency and lifecycle.
6. Non-functional requirements: security/privacy, reliability/recovery, performance, accessibility, localization, observability, operability and compatibility.
7. UX states: empty/loading/error/partial/stale/offline/denied/success; keyboard/focus and responsive behavior.
8. Release dependencies, migration/backward compatibility, rollout/rollback and support documentation.
9. Acceptance and test strategy, evidence matrix, open decisions with owner/deadline.
10. Separate reference inspiration, proposed requirement, implementation evidence and verified completion.

## Mapping to the existing trellis-panel roadmap (provisional)

The existing roadmap is reported as R0 trusted foundation, R1 human collaboration, R2 daily team work, R3 Agent integration, R4 delivery evidence, R5 automation, with multi-project launch, logs and read-only Git side tracks. This is context supplied during research, not independently verified in this report.

- R0: entity/state identity, persistence, permissions, predictable failures, explicit destructive-operation semantics.
- R1: accountability, comments/threads, permission-aware sharing, collaboration history; avoid conflating chat with task records.
- R2: reliable filtering/views, triage only if needed, notification routing and task relationships; projects/iterations need demonstrated demand.
- R3: runtime/computer readiness, preflight, run state, locking, cancellation and trigger identity before crews or broad connector expansion.
- R4: goal-to-artifact-to-test traceability, immutable evidence references, review decisions and acceptance outcomes; successful run alone is insufficient.
- R5: bounded triggers, idempotency, loop prevention, run health and pause/recovery controls; require all prior lifecycle semantics to be stable.
- Side tracks: keep multi-project context unambiguous; preserve diagnostic logs with redaction; keep read-only Git visibly read-only until a separately approved write workflow exists.

## Additional privacy-policy evidence

The privacy policy states that nonpublic enterprise/organization content is not used by HiFox to train foundation models offered to other customers or the public, unless separately authorized/agreed. This is a qualified first-party statement, not an assertion about every independently configured third-party runtime/provider. It describes China storage for personal information collected/generated there, with legal/contractual exceptions and possible cross-border processing. It describes access controls, authentication, encryption or masking, audit, monitoring and backup measures without implementation detail or certification. Deletion may be delayed in backups and organization contributions may persist for continuity. Source: https://help.hifox.com/legal/privacy-policy . These are documented policy claims, not audited guarantees or legal advice.
