# Published team collaboration UI

## 1. Scope / Trigger

Read when changing `renderer/src/team`, shared publication entry points, native
document publishing or the supplemental Web integration. `Team.tsx` composes the
collaboration entry; it does not replace the existing task/member/report views.
Desktop executes local work; published materials have their own remote owner.

## 2. Signatures

```tsx
<TeamCollaborationEntry root={snapshot.meta.root} />
<PublishWorkflowVersionButton expectedRoot={root} source={source} title={title} />
```

`source` is exactly one of `task-run` with taskDir/run/ref, `recovery` with run/ref,
or `fixed-document` with the selected registered token. Main resolves the original
body/owner. The renderer uses the structured `api.teamDesktop` bridge only; it
does not supply credentials, trusted material bodies or machine execution adapters.

## 3. Contracts

- A pairing chooses an actual authorized project in the service Web page. Pending
  identity has no project grant. Show real code/state and current server context;
  network loss leaves explicitly labelled last-observed metadata. Reconnection
  revalidates the original person/project and roles without replacing the reader.
- A version is selected explicitly. Passive events, directory refresh, publication
  B, auth refresh and theme/layout updates preserve verified body A, selection,
  scroll, drafts and fixed origin. Explicit next-version selection replaces A.
  A server-access denial locks shared content; ordinary network failure may show
  the verified offline cache with its last-observed authority.
- A cached directory snapshot and committed-receipt clues differ. Receipt clues
  are an incomplete local index, never the full currently authorized catalogue.
  An empty filtered page with hasMore is not end-of-list. Event backlog is separate
  from snapshot completeness.
- Personal visibility is the publication default. A new version selects an
  actually observed owned family and CAS version. Never silently publish a local
  file's newest text or retarget an outbox to a replacement account/device.
- Create and retain one operation UUID/digest before enqueue. After lost reply or
  reload, keep its original source/body binding. A missing local receipt at a read
  point is not proof of absence; retry preserves payload/UUID. Browser storage
  contains bounded metadata only, not full publication bodies or credentials.
- Suspending feedback UI during an admitted save releases its visual busy state
  when the original promise completes. Returning and retrying preserves original
  body/UUID. Do not abandon its identity because the view was temporarily hidden.
- Revoked/disconnected connections retain readonly original outbox history;
  shared bodies and send/retry actions are locked. A standalone publication dialog
  listens to authority changes. A late response cannot reactivate an invalidated
  form or erase a retained unknown command.
- Quotes/ranges refer to raw source UTF-16, including surrogate-pair boundaries.
  Repeated text remains ambiguous without a real selection; rendered Markdown
  offsets do not establish an original-source anchor. Recorded feedback is not
  claimed applied. Later handling/execution is a separate domain.
- Sanitize published Markdown: no raw HTML execution, automatic image fetching,
  or opening local paths in the current repository. Remote/local images remain
  placeholders until an explicit supported asset adapter exists. Explicit HTTPS
  navigation uses the existing main opener. Remote native document windows remain
  unsupported until their own original-source adapter is implemented.
- Fixed native reader publication uses the currently displayed token and main's
  sender-bound source-active result. Physical root aliases must not look like a
  project switch. Genuine inactivity stays disabled until explicit reopen; a
  transient unknown state can be retried without replacing body/selection.

## 4. Validation & Error Matrix

| Observation | Required display/action |
| --- | --- |
| Offline enqueue accepted | Saved in original local queue; not yet server-published |
| Unknown acknowledgement | Original identity retained; reconcile before retry |
| Revocation during publication | Form locked; late reply cannot restore old authority |
| Passive version B arrives | Notice/metadata may update; reader stays on A |
| Cached role after reconnect | Revalidate actual context; label old information until then |
| Recorded feedback | Recorded only; no applied or QA-success claim |
| Local image in published text | Placeholder, no implicit current-workspace read |

## 5. Good / Base / Bad Cases

Good: product reads published A while the developer's desktop is offline and
records a quote. The desktop restarts with cached A and original queued operations;
on reconnect, original receipts arrive and neither reader silently adopts B.

Base: collaboration is unopened and a local task needs no team account.

Bad: use a newly paired account to send another person's unknown write, turn a
timer into an online indicator, or label a submitted comment as implemented.

## 6. Tests Required

Exercise actual React/shared Modal/InteractionScope/Chromium behavior with wrapped
IPC fixtures for navigation/late replies/reload/retained versions/quotes/ACL loss,
keyboard focus, light/dark, narrow and zoom layouts. Label these fixture boundaries.
Use actual production desktop/service/OIDC/Web connections for
cross-process offline/restart and real selected-native-source publication. Capture
fully repainted frames; a hidden-window compositor blank is not a usable screenshot.
Do not infer company, separate-machine, package or human acceptance from either.

## 7. Wrong vs Correct

Wrong: “The response was missing, so start a new publication and clear the draft.”

Correct: preserve the original command and exact payload; reconcile its real local
and remote state under the original binding before any deliberate retry.
