# Retained sources and interaction suspension

## 1. Scope / Trigger

Read before retaining a source page behind Settings, task expansion or another surface. Retaining its data/reader does not permit hidden Escape handlers, portals or asynchronous focus/confirmations to act on the destination page.

## 2. Signatures

- `InteractionScope({active:boolean,children:ReactNode})` in `utils/interaction-scope.tsx`; nested activity is parent-active AND local-active. Outside a provider, activity defaults to true.
- `useInteractionActive():boolean` gates rendering/registration.
- `useInteractionSignal():AbortSignal|undefined` scopes an owned transient request.
- `useInteractionGuard():()=>boolean` reads current interaction activity/liveness for delayed UI work. It does not replace project/session/request authorization.
- `confirmDialog(opts:ConfirmDialogOptions,signal?:AbortSignal):Promise<boolean>`; abort settles only that request as false. Existing callers without a signal retain their behavior.
- `PageBody()` owns one bounded ACP source slot and independent Suspense branches. `data-acp-source-owner` identifies its mounted owner for actual-host regression evidence, not persistence or business identity.

## 3. Contracts

The same canonical-root ACP owner remains mounted across contiguous ACP, Settings and Knowledge visits. On Knowledge, the discussion pane reuses that owner; opening it must not create a session or send a message. Preserve its controller, document target, inspector/expansion, actual reader DOM/reading-session key, displayed/base/latest bytes, pending candidate, drafts/references and viewport. Key its interaction scope to that bounded owner too: replacing active A with active B must abort A's scoped transients even though activity never becomes false. Do not serialize document bytes/baselines into preferences or open a second reader to imitate continuity. Settings remains the actual Settings route and uses shared appearance controls.

An ordinary material snapshot/mtime update is not a source replacement. Root changes invalidate the owner through the synchronous store subscription so batched A→B→A cannot resurrect old A. Other module navigation ends retention. The real `sessionSlice.openProjectPath` resets to dashboard and clears reading sessions even for a same-canonical-root reopen; use that actual product lifecycle rather than inventing a snapshot-object epoch.

The hidden source is hidden, aria-hidden and inert. Its interaction scope suspends descendant Escape layers, Dropdown/Modal/hover portals and focus work while its reader/data/watch ownership remains alive. Track the last connected focusin inside the ACP source: the real outside opener receives focus before its click changes route, so sampling only activeElement during the store transition loses the source target. Capture source scroll before the transition and restore only connected source targets on return. Closing the Knowledge discussion pane returns focus to its still-connected opener when focus was inside the pane. Inspector reactivation must honor restored source focus rather than overwrite it with heading autofocus; initial open and actual tab changes retain their normal focus behavior. Respect a suspended outer source scope during task expansion. Source and destination loading/error boundaries remain independent.

ACP-owned imperative confirmations pass the scope signal and recheck activity before applying delayed UI effects. Cancelling a current/queued scoped request removes only that request, releases its abort listener and does not settle/promote unrelated requests twice. Aborting a UI confirmation is not a Runtime permission decision: leave the actual permission mediator, original option IDs, timeouts and ownership guards unchanged. The activity guard never authorizes a stale project/session/read completion.

DialogHost's Escape registration belongs to the current request ID, not the permanently mounted host. Dispatch consumes a registration; replacing request A with queued B while `active` stays true must register a fresh B layer. A constant host ID/dependency can leave B without Escape even though it is visible. Keep settlement guarded by exact current-request identity.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| ACP → Settings → ACP | Same reader DOM/owner; A/baseA and pending B, draft/ref, expansion and viewport retained |
| ACP ↔ Knowledge discussion | Same ACP owner and session; opening or closing the pane does not send or create a session |
| Knowledge discussion hidden | Pending permissions remain runtime-owned; hidden controls and portals cannot act |
| New file candidate while Settings active | Candidate updates without replacing displayed A or stealing destination focus |
| Settings Escape/menu/modal | Hidden ACP does not consume the event or render a portal; Settings controls remain active |
| Return with a connected source focus target | Restore that target without a later inspector effect stealing focus |
| Scoped current/queued confirm loses activity | Resolve false for that request; unrelated global confirm survives |
| Dialog A settles and queued B becomes current | B receives its own Escape registration and can close independently |
| Direct Settings visit | No speculative ACP owner/page cache |
| ACP lazy chunk pending while Settings opens | Suppress the inactive source fallback; Settings loading/content remain independent |
| Other module or same-root explicit project open | Release the old exact watch once; do not retain an orphan reader |
| Batched A→B→A | Old owner invalidated despite matching final canonical root |
| StrictMode setup/cleanup replay | Do not prematurely abort the live scope; final replacement/unmount cancels owned transients |

## 5. Good / Base / Bad Cases

Good: expanded A stays mounted while Settings receives B and changes font; return restores A plus its pending candidate and draft. Base: ordinary pages outside a scope remain active. Bad: storing Markdown snapshots in localStorage, remounting a second reader on return, or letting a hidden source close its document when Settings receives Escape.

## 6. Validation

Run `npm run typecheck`, `npm run build` and static `npm run check:ui`. Verify the same DOM/read owner and watch counts across Settings detours, including displayed A, pending B, draft, viewport, fonts, menus and modals. Check hidden aria/inert/portal/focus isolation, late confirmations and cleanup after real route/root changes. Native connected round-trip acceptance is separate; temporary scripted checks belong in OS TEMP.

## 7. Wrong vs Correct

Wrong: key the retained page to every snapshot, hide only its visual DOM while leaving global Escape/confirmations active, or use activity as an IPC authorization check.

Correct: retain one bounded source owner, suspend its interaction surfaces separately, and keep existing root/session/read/watch authority and cleanup intact.
