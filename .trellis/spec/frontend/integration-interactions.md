# External integration interactions

## Scope and reference boundary

Applies to `my/pages/integrations/**`, its settings navigation and shared layout. Follow the approved [Chinese design principles](./design-principles.md); native identity, redaction and grant contracts remain in [backend integration contracts](../backend/integrations.md).

The reference is the user's HiFox screenshots and fresh REA static analysis of its public frontend (SHA256 `4c8111c249751de3cc25711fa1c058e04789f1c02a59eabd6dcd72e1a4d19f16`). Static evidence establishes component/route/form behavior, not authenticated remote success. Independently implement supported interactions; never import reference bundle code, call private HiFox APIs or synthesize unsupported authorization/QR success.

## Composition and signatures

`IntegrationsPage` owns a local directory/detail selection, one selected connection and guarded connection/binding dialogs. `PROVIDER_WORKSPACE_EXTENSIONS` uses explicit imports; it is not a runtime plugin loader or a competing application router.

`ProviderWorkspaceProps` carries the captured entry/provider/root/connections/connection/bindings, availability flags, refresh/navigation and:

```ts
onConnect(): void
onEditConnection(): void
onBindProject(binding?: IntegrationBinding): void
onSelectConnection?(id: string): void
onFlowChange?(active: boolean): void
```

An extension may set `connectionMode: 'shared' | 'provider'` (default shared). Jira/GitLab Issues use one compact shared instance row. DingTalk owns its organization-app/group-bot distinction; no generic webhook panel is prepended. Generic repository, bot and knowledge capabilities remain real existing operations, not account/sync placeholders.

`onFlowChange` suppresses overview chrome during provider setup while keeping the same Content instance. Do not key the provider on this flag or on a binding-list refresh: that would lose the explicit association continuation, drafts and retained request identities. Actual root/connection/revision replacement still invalidates UI authority.

The integration route owns its visible directory/detail/setup headings. `PageFrame` retains an accessible route heading but omits its duplicate visible title/scope chip/notice for integrations only. Other routes keep their original chrome and scope semantics.

## Visual and interaction contract

- Directory: categorized compact cards, one/two columns by available container width, real local provider assets, concise product-value descriptions and an actual connection count when present. Preserve back scroll and return focus to the originating card.
- Detail: quiet Back, a horizontal 60px product tile/36px mark with title/value beside it, meaningful binding/account/sync/import sections. Do not restore the old expanded generic connection plus another dedicated provider-instance panel.
- Named canonical widths are `--my-integration-detail-width: 804px`, `--my-integration-setup-width: 768px`, `--my-integration-drawer-width: 800px`. These are semantic integration columns within PageContent, not an additional PageBody or page scroll owner. Existing Modal caps connection forms to 448px and the viewport; do not widen all dialogs globally.
- Cards use neutral surface roles; account management is a compact gray rounded row. Product typography, controls, themes, focus and spacing use the shared tokens/primitives. Optional configuration and raw root/revision/command facts are on demand; essential write/clear/rebind risk remains visible before commitment.
- Existing legacy connection labels such as internal compatibility names are replaced only in presentation by a safe HTTP(S) host/provider label. Normal user-defined names remain intact. Never display URL userinfo/query as an instance label or alter the stored immutable legacy name.
- Connect forms use labelled essential fields, meaningful defaults, a close action, cancellation and one submit action. Optional name/query/mapping/OAuth registration detail is progressive. New missing required fields disable submit; editing may keep an existing secret blank or explicitly clear it with the existing warning. Secret patches remain keep/replace/clear; a disabled reference auth choice does not become a saved capability.
- GitLab defaults to its actual PAT method. OAuth is selected/configured only when native support is available, with its real client registration and explicit scope consent. Do not imitate HiFox's managed OAuth app without such a service. Jira retains Server/basic support; Cloud/PAT/proxy controls remain honestly unavailable. No fake QR is generated for DingTalk.

## Provider flows and state ownership

### Jira

Use one parent-selected instance. Personal account, project sync and one-time import are separate concerns. New sync is a focused Project → Statuses → Members → Options → Confirm subview; edit uses Settings/Users/Statuses in a scoped drawer. Enter real source discovery only after the user selects the operation. A missing common project association has an explicit association detour and resumes setup after the actual binding exists. `projects`, `selectProject` and `discover` retain numeric identity and complete source tuples; no labels/defaults manufacture a source.

Inbound/paused defaults and explicit outbound approval reflect current native safety contracts. The history-evidence option is not bulk historical-Issue import: bulk import is a separate preview/start operation. Status mapping does not silently complete/archive Trellis tasks, and edited local PRDs keep their existing protections.

Import separates API/CSV data, mapping and preview/confirmation. Show actual scope/sample/total/warnings and bounded CSV limits. History uses real workspace cursor pages filtered to the selected instance; do not invent a per-instance total or claim another page cannot contain matching jobs. Keep original cancel/resume/rollback/conflict/reconcile operations and their exact identities.

### GitLab

Hosted/self-managed Issues and repository roles reuse actual provider connections; UI role selection does not create a second credential store. Repository browsing/association and native Issue sync bindings remain distinct capabilities/identities.

New sync uses Project → Statuses → Members → Options → Confirm; edit uses a focused drawer. Keep project/member pagination, actual Issues/access flags, mapping validation, OAuth `api` consent and hook/receiver availability. Existing comment history is not automatic bulk Issue import. Import explicitly previews/imports the native page; do not claim CSV/rollback or reproduce an inert reference reimport callback as a working feature.

Dirty-leave confirmation is tied to the exact editor session/owner/signal. Ordinary read refresh or confirmation dismissal cannot cancel an accepted discard; stale confirmation cannot close a replacement editor. Native command guards stay independent of this editor-session token.

### DingTalk

Organization apps, personal identity, project assistants, personal notifications and outgoing group bots are distinct. A saved webhook is not an organization assistant or account. Real app verification, Stream lifecycle, execution policy/approvals, sender/group allowlists and preview/send are retained.

Keep the account controller above volatile snapshot rendering. A polling error shows read failure/retry and disables begin/claim/unlink, but does not discard the original request ID, authorization ID or expiry. Retained display data is not authorization; actual owner/app/revision replacement still invalidates it. Default callback/QR/link-preview absence is explained in the selected operation without fake success.

A group-bot picker calls the parent selected-connection callback; never locally substitute another connection while Edit/Bind still target the old one. Filter destinations by actual connection and canonical current root; changing the selection clears scoped previews and does not send. Keep notification configuration details separately discoverable from delivery receipt details. Delivery accepted/unknown is not verified delivery.

### Existing generic integrations

GitHub/Gitee/GitLab repositories retain repository/PR/MR reads and explicit work-item association. Feishu/group bots retain destination setup and explicit notification preview/send. WeKnora retains project knowledge scope and protected legacy import. Its legacy-import entry must be reachable with a current project even without a new saved connection; distinguish available form, confirmed absence, read failure and missing native bridge rather than displaying an empty dialog. Opening a form is never migration consent.

## Validation and error matrix

| Condition | Required outcome |
| --- | --- |
| Equivalent Windows root spellings | Compare with `projectRootKey`; retain original captured expectedRoot and binding/connection CAS in requests |
| Foreign root or owner generation | Reject/close stale UI; never retarget a completed callback |
| Same binding list refreshed during setup | Preserve provider instance/draft and explicit association continuation |
| Missing native/authorization/receiver | Honest unavailable state at the relevant operation; no fabricated empty success or enabled unsupported action |
| New required field missing / stored secret blank | New submit disabled; saved secret can remain keep, explicit clear retains warning |
| Import pending/unknown then dialog closes | Mounted provider workspace retains original preview/digest/command/source; reopening cannot create a new submission |
| History page empty or read failed | Not proof that the original unknown command did not execute; recovery remains locked to original evidence |
| Authorization polling read failed | Same pending account controller; original authorization facts retained, actions gated until ready |
| Dirty editor discarded / replaced | Confirmed current editor closes; stale settlement cannot close a new editor |
| Back/Escape | Close the top owned dialog first; detail Back restores directory scroll and originating-card focus |

Retained unknown import recovery is scoped to the still-mounted workspace. Match original command, preview/digest and source tuple before using job/reconciliation evidence. Do not claim frontend persistence across application restarts or native effect resolution from local UI state; durable native history remains authoritative.

## Acceptance and wrong/correct examples

Exercise real components with isolated ports: directory; unbound/bound details; essential connection form and stored-secret keep; canonical-root existing-binding edit; all setup stages and dirty cancel; API/CSV preview; close/reopen after an unknown import; account polling failure/recovery; notification config disclosure; WeKnora unbound legacy import; dialog Escape/focus; dark/compact layouts. Compare the supplied reference and actual screenshots at matched/normalized sizes, explicitly separating static source, synthetic UI, native and authenticated-provider evidence.

Wrong: preserve a command UUID only inside the modal, then permit a new preview after closing an unknown submission. Correct: retain the exact submission above the modal and offer original-job history/reconciliation until authoritative evidence resolves it.

Wrong: hide all setup/diagnostic data while removing prose, or render generic compatibility cards alongside the provider overview. Correct: one clear overview, focused supported setup, discoverable original diagnostics and real recovery actions.

No broad native/vendor/performance acceptance follows from frontend-only fixtures. Full build/typecheck/suites, actual credentials, provider writes/messages and real desktop/daemon lifecycle require their existing authorization boundary.
