# Trellis team service

An independent Node service for shared materials, project membership, collaboration
records and outbound desktop identities. Coding repositories, native Agent loops,
credentials and full conversation histories stay on developer machines.

This package is separate from the Electron dependency tree. The first data adapter
uses a single owned Node SQLite worker and immutable blobs. It is a portable
single-instance deployment baseline, not an assumed company database or scale SLA.

## Runtime and build

Node **24.12.0 or newer** is required. In this directory:

```sh
npm ci
npm run typecheck
npm run build
npm run licenses
```

Deploy `dist/`, `package.json`, `package-lock.json`, `THIRD-PARTY-LICENSES.txt` and
`dependency-notices.json`, then install runtime dependencies with
`npm ci --omit=dev --ignore-scripts`. The service uses the configured OIDC provider; it does not operate an identity
provider in production.
Installed dependencies and their original license files must remain available.

## Explicit deployment configuration

See `.env.example`. The service reads environment variables supplied by the
deployment process; it does not silently load or save a `.env` file.

Required: `TEAM_PUBLIC_ORIGIN`, `TEAM_OIDC_ISSUER`, `TEAM_OIDC_CLIENT_ID` and
`TEAM_BOOTSTRAP_SUBJECT`. Configure the issuer's exact redirect URI as
`<TEAM_PUBLIC_ORIGIN>/auth/callback`, authorization code flow and PKCE S256.
Confidential clients can supply `TEAM_OIDC_CLIENT_SECRET` using
`client_secret_basic`; a client without a secret uses the public-client `none`
authentication method. Request scopes are `openid profile`.

The bootstrap subject is the issuer's stable **sub**, not email, display name,
first visitor or a browser-provided role. A signed-in person can create their own
team; adding people/projects is an explicit current-role action. The platform
administrator can disable an account with a revision check. That deletes its
sessions and revokes active devices. Re-enabling an account requires a fresh login;
old device credentials do not reactivate. External SSO back-channel revocation is
not implemented or implied: company identity lifecycle integration is a deployment
gate, with the bounded local session lifetime documented below.

`TEAM_HOST` defaults to `127.0.0.1`; `TEAM_PORT` defaults to `5441`. Deploy behind
your configured HTTPS reverse proxy preserving the public Host header. The service
does not trust arbitrary forwarded headers. Public origin and all issuer metadata/
token endpoints require HTTPS. `TEAM_ALLOW_LOOPBACK_HTTP=1` permits **only** owned
loopback HTTP testing, not an arbitrary intranet HTTP downgrade. Session lifetime
defaults to eight hours and is bounded to at most 24 hours.

`TEAM_DATA_DIR` defaults to `./team-data`. Give this directory to one service
instance and restrict OS access. A live owner lock prevents another writer. A dead
process lock is retained as a stale evidence file before a new owner is admitted;
an ambiguous/live lock is not stolen. Corrupt/future databases are preserved and
rejected. Database schema3 preserves tested schema1/2 identities and publications.

Optional `TEAM_WEB_DIR` points to the Web owner's built bundle with `index.html`
and `assets/`. The same origin serves public static assets and authenticated JSON
APIs. API/auth paths never fall back to SPA HTML. Without a Web bundle, `/` returns
an explicit `web:not-configured` status. This is not a claim the full Web task is
complete.

Start with `npm start`. `GET /health` checks this process; `GET /ready` checks
the actual local storage worker. Neither claims company OIDC availability. Existing valid sessions and published reads do not need a live
developer computer or a fresh issuer discovery request. Issuer discovery is lazy;
failure requires a visible new login attempt and never creates a demo principal.

## API and client behavior

Shared schemas/types are in `src/shared/team-platform.ts` at the repository root.
The complete current route/response contract is in [API.md](API.md).
Responses use `{ok:true,value}` / `{ok:false,code,error}`. Browser mutations require
the exact public `Origin` and `X-CSRF-Token` from `GET /api/session`; the session
cookie is opaque, HttpOnly, SameSite=Lax and Secure on HTTPS. No permissive CORS.

Membership supports multiple product/PM/developer/tester/admin responsibilities.
Personal body access remains owner-only even for administrators. Project and team
publication is explicit; a new document version never overwrites an older body,
visibility or feedback anchor. Saving/publishing, checking an artifact, applying
feedback, Jira completion and QA approval are separate facts.

All lists return `{items,nextCursor,hasMore}` with a default50/max100 page. Cursors
bind instance, epoch, account/device, scope and authorization revision. Changed or
foreign list cursors return `CURSOR_CONFLICT`; event catch-up uses explicit
`resetRequired`. Load a new authorized snapshot and start a fresh cursor after a
reset. Do not fabricate a complete list from one page or cache access indefinitely.

Writes retain one UUID `commandId`, canonical request hash, domain mutation,
authoritative event and result. Retry the **same identity and payload** after a
lost acknowledgement. Conflicting payloads return conflict. Current authorization
is checked before retained results are replayed. `GET /api/commands/:commandId`
reads your own current-authorized committed receipt; it is historical evidence,
not the latest material, member or device state. A missing receipt describes that
read point, not proof an in-flight request can never commit later.

Material text must be well-formed Unicode and is limited to one MiB of actual
UTF-8. Invalid lone surrogates reject before publication instead of silently
changing the selected text. The HTTP/RPC JSON envelope
is limited to two MiB including escaping. Source metadata accepts scoped IDs and
explicit project-relative paths. Native task identities that contain path syntax
need a stable local-to-remote privacy-safe alias mapping; do not rewrite pinned
native identities. Feedback uses the exact selected version, quote and optional
UTF-16 start/end range. Returned feedback is `recorded`, `applied:false`; later
decision/boundary workflows are owned by R2-02.

## Desktop enrollment and liveness

The desktop starts `POST /api/device-pairings` with its name, declared capability
names and optional project. Persist the returned **pending** credential in the
existing protected main credential store before opening `verificationUri`.
Pending tokens can only inspect their pairing status. They cannot list projects,
read documents, heartbeat or execute anything.

The person signs in through OIDC, selects from their real authorized projects,
and supplies the code displayed on the desktop. An already targeted pairing must
match that project. Approval binds the project and person once; it never retargets
an active credential. Approval returns a historical decision receipt. The desktop
polls the actual status with its original candidate token; no second secret
delivery can be lost. This is platform enrollment, not an OAuth device-flow claim.

Only an actual authenticated heartbeat advances `lastSeenAt`. Device capability
names remain `device-declared`, not permission grants. Replayed heartbeat sequence
cannot keep an offline device online. Browser POSTs cannot impersonate device
heartbeats. Project/team/account revocation invalidates the credential; later
membership restoration does not reactivate it. There is no remote shell, model,
repository-mirroring or arbitrary local-command endpoint.

## Backup and restore

The owning service exposes `store.backup(newDirectory)` to a trusted operator
integration. It serializes the live SQLite backup and referenced verified blobs
through the writer. There is no HTTP destination-path or arbitrary-file endpoint.
The CLI requires stopping the service before opening its own writer:

```sh
npm run backup -- create /new/backup-directory
npm run backup -- restore /new/stopped-data-directory /existing/backup-directory
```

Backup targets must be new directories outside the active store. Restore verifies
database/body digests, supported schema, SQLite integrity, blob references and
instance/epoch before publishing a new directory. Existing stores/backups are
never overwritten. Failed restore staging data is retained for inspection.
Preserve the backup as private server data: it contains published/private records
and session metadata. Command results, stable identities and cursor epochs survive
restore. Hardware power-loss durability, installed server operations, company SSO
and multi-instance database compatibility require separate deployment acceptance.

## Local validation

Run `npm run typecheck` and `npm run build` in this package. Follow the root [local-only rule](../../AGENTS.md): temporary validation scripts, isolated OIDC accounts/keys, SQLite stores and results belong in OS TEMP and are not tracked or submitted.

Verify actual HTTP authorization, immutable versions, command replay after lost ACK, revocation, migration and backup/restore through the storage worker. Desktop protected pairing/outbox, supplemental Web, company SSO policy and multi-device deployment need their own integration acceptance.
