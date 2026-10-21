# External Application Connectors

The desktop app's **Tools and Settings → External application integrations** directory manages Jira, GitHub, GitLab, Gitee, DingTalk, Feishu, and WeKnora connections. Connection secrets are stored on this machine; project bindings select a Jira default query, repository, group-notification destination, or default knowledge collections. WeChat/WeCom is deferred.

## Project knowledge and WeKnora

Add/test the WeKnora connection in Integrations, then bind its default collections
to the selected project. A saved connection alone does not enable knowledge for
every project. The Knowledge page and existing Agent conversation use the same
project scope; a per-use adjustment is visible and temporary, and resets on
application restart. No binding or an empty selection never means all libraries.

Requirements intake can seed an editable, unsent draft in the existing native
Agent conversation. The user discusses normally, then asks the same Agent to
organize the requirements. Native tools let it actually save a complete document
under `.trellis/notes/`, without copying an answer into a form. Compact real
lookup/source and document results appear in the turn. Attachment, discovery and
actual calls remain separate observed states.

When requested, the Agent can hand the saved version to an existing task with
revision checks, or create a new planning task and its developer PRD. This never
starts implementation or changes Jira state. Saving a conversational document
records its origin and unresolved questions, not formal business approval.

On an explicit conversational publication request, the Agent publishes the exact
saved version to the unique eligible project library, or asks which destination
when ambiguous. Manual management previews are still available but are not
required for this path. A create acknowledgement retains the remote document ID, not a claim of
completed indexing. Lost responses stay uncertain across restart and are not
automatically reposted. Publication history loads older pages explicitly so an
older unresolved result can still be checked and resolved. Local saving does not
publish. Legacy opt-in spec sync stays
in a separate compatibility area; automatic archive deposition remains disabled.

Existing WeKnora settings can be explicitly imported and optionally bound only to
the selected project. Integration storage v1 is backed up before v2 migration.
Private source evidence and publication receipts stay in application data;
project Markdown may be shared with the repository. A full application restart
is required when the loaded main/preload lacks the new knowledge API.

The MCP server uses exact dependency `@modelcontextprotocol/sdk` 1.32.1 (MIT).
Its license notice is retained in `resources/licenses/modelcontextprotocol-sdk.txt`
and the dependency's own license must remain in packaged distributions. Controlled
core/MCP/ReactDOM checks are not proof of deployed WeKnora response compatibility,
real model behavior, corporate proxy/CA or packaged-app acceptance. Separate
synthetic real Codex checks verify discussion synthesis and actual local
document/planning outputs; they do not verify production WeKnora publication.
The host scopes its own tools, not other globally installed native MCP plugins.
Shared instructions require project knowledge lookup through the project bridge;
they are model guidance rather than an external-plugin ACL.

## Supported workflows

- Jira Server 8.1 / REST v2: query paged issues, create/open an associated local task, refresh source results, and explicitly comment or transition linked issues. Existing local task descriptions and historical source identities remain intact.
- Repository providers: read authorized repositories and PRs/MRs; associate remote objects from a work item or the directory. Source links and their association-time snapshots remain available after a connection is disabled.
- DingTalk/Feishu: configure an official group robot URL and optional signing secret; bind it to a project. Select a work item, preview its summary and destination, then explicitly send. Saving or inspecting configuration never sends a message.

Existing Jira/GitLab settings appear as labeled compatibility entries. New connections can be added independently. The old GitLab MR creation workflow remains available through its legacy configuration; the new common repository interface is read-only.

GitLab browser login: add a connection, choose browser authorization, enter the
instance URL and its OAuth Application ID, then save. The connection card's browser
login button opens the system browser; complete GitLab login/consent there. The
application needs to be registered once on that GitLab instance with Confidential
unchecked, scopes `read_api` and `read_user`, and exact redirect URI
`http://127.0.0.1:17654/oauth/callback/gitlab`. Setup instructions and an application
settings link are included in the editor. Authorization can be cancelled and
expires after five minutes; leaving its source page cancels the pending flow.
Tokens are encrypted locally and refresh automatically. Existing PAT connections
stay PAT until explicitly changed; legacy username/password settings remain valid.

Connection configuration, authentication verification, and real business capability are distinct states. Repository reads page at most 30 rows at a time. A failed/uncertain notification is not retried automatically; inspect the target group before creating a new send intent.

## Extension guide

The integration subsystem is a modular desktop service using capability ports and adapters (TPD-025). It does not load arbitrary third-party executables.

1. Add a provider identity and its manifest/fields/capabilities in `src/shared/integrations.ts`.
2. Implement the relevant `TaskSourcePort`, `RepositoryPort`, `NotificationPort`, or `KnowledgePort` in `src/main/services/integrations/providers/`.
3. Register the adapter in `providers/index.ts`. Supply provider validation for special auth/URL requirements. Declare a stable instance URL for fixed-host providers.
4. Use factory/transport injection and the app's bounded `integrationFetch`; do not put SDKs, decrypted secrets, or vendor HTTP branches in renderer components.
5. The directory renders the manifest. New specialized business views can consume the typed integration API. Ship new connector code in an application release; users can enable/disable its connection and project bindings at runtime.

Connection storage and source references are separate. Project ownership uses canonical roots plus binding/connection revisions; external identity includes source instance and stable remote IDs. Keep the Jira legacy namespace algorithm unchanged when adding another source adapter.

## Reused dependencies and licenses

| Package | Pinned version | License | Responsibility |
| --- | --- | --- | --- |
| `@octokit/rest` | 22.0.1 | MIT | GitHub REST resources and paging |
| `@gitbeaker/rest` | 43.8.0 | MIT | GitLab typed REST resources |
| `@gitbeaker/requester-utils` | 43.8.0 | MIT | Public requester/options formatter for app transport injection |
| `oauth4webapi` | 3.8.8 | MIT | OAuth PKCE/state validation, authorization-code exchange and token refresh |

The packaged `resources/licenses/integration-connectors.txt` preserves the locally installed SDK dependency closure's license notices; update it alongside SDK upgrades. Also retain packages' own LICENSE files. Architecture references are [Backstage](https://backstage.io/docs/backend-system/architecture/modules/) and [Activepieces](https://www.activepieces.com/docs/build-pieces/piece-reference/authentication); their implementations are not copied or embedded. Jira reuses this project's existing service because current `jira.js` Server support does not cover the company's 8.1 installation. Gitee and group bots use narrow official-API adapters rather than a full workflow platform or a library requiring different credentials.

## Verification status

The user requested implementation without tests/builds. No lint, typecheck, smoke,
production build, packaging, SDK probe, authenticated Jira query, remote repository
write, or real group delivery was executed. Static review is recorded in the task.
The user later explicitly permitted the development compilation/restart necessary
for GitLab OAuth and its application registration. The GitLab application was
registered with read_api/read_user, and the real desktop editor saved its public
client metadata. The user completed browser consent, and the desktop app loaded a
read-only GitLab membership-repository page. Refresh-token rotation was not
exercised. Anonymous Jira serverInfo established Server 8.1.0 metadata only.

During an authorized desktop startup repair, the actual directory and Jira editor
were opened without entering or saving credentials. Shared modal coverage was
observed across the title bar and page. The development runtime was restored using
electron-vite `dev --rendererOnly`, which reuses existing main/preload files and
skips their builds. This narrow UI observation does not establish provider access
or a successful fresh main/preload compilation.

For development restarts, exit the app from its system-tray menu before starting
another instance. Closing the main window leaves the tray process running. Keep
the electron-vite dev controller for hot updates; directly launching `electron .`
loads existing renderer output instead of restoring the development server.
