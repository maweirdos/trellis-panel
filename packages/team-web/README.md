# Trellis supplemental Web

An independent static React application over the team service. Chinese interfaces
use the existing desktop `my` visual tokens and transport-neutral business schemas.
The desktop remains the local Agent/development workspace. This browser application
does not connect to native ACP, run shell commands or mirror repositories.

## Develop and build

Use Node24.12+ in the repository. From this package:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm run licenses
```

The source imports the repository's existing `src/shared/team-platform.ts` and
`src/renderer/src/my/my-tokens.css`. There is no copied contract or second palette.
Exact versions, integrity hashes and notices are retained by the package lock and
license output. No dependency was added to the Electron/root package. Lint is not
configured. Validate connected behavior against the built sibling team-service
using an explicitly configured isolated account.

## Serve in production

Build, retain the generated runtime dependency notices and deploy the contents of
`dist/` as the team-service `TEAM_WEB_DIR`. The team service serves the static files
and authenticated API on the same origin, with its existing CSP, session cookies,
CSRF, Host and authorization checks. No client secret is compiled into Web assets.
Supply the service's real OIDC/reverse-proxy/TLS configuration separately; see the
sibling service README. This package does not start a production identity server.

For local development, `npm run dev` uses http://127.0.0.1:5442 and proxies `/api`,
`/auth`, `/health` and `/ready` to `TEAM_API_UPSTREAM` (default5441). Configure the
service `TEAM_PUBLIC_ORIGIN=http://127.0.0.1:5442`, matching identity callback and
explicit owned-loopback HTTP allowance. The proxy preserves the public Host and
Origin (`changeOrigin:false`). The default http test setup is not an intranet TLS
downgrade. Never place access tokens, OIDC secrets or device tokens in Vite env.

## Delivered flows

- Login redirects to the configured real OIDC provider and preserves safe relative
  return paths, including `/?pairing=<UUID>`. There is no fake/demo login fallback.
- Project/role lists come from authorized paged APIs. Team creation, project
  creation, team/project multi-role assignment and platform account status use the
  actual server revision/CAS contracts. New people must sign in before assignment;
  their own profile shows their server person ID. No unsolicited invitation send.
- Documents open exact immutable versions, verify body SHA256/UTF8 length and retain
  the selected version while another is published. The source disclosure shows
  original publication metadata. A new version is explicitly adopted. Markdown
  never executes raw HTML. Images/local files are not silently uploaded/fetched;
  explicit published attachment support belongs to its later owning adapter.
- Product/developer readers can choose exact original text to quote. Feedback pins
  selected material/version, UTF16 offsets and matching quote. It is recorded and
  visibly **not yet applied**. Structured decision/application is R2-02 work.
- Text publication is a secondary management action: choose title/type/visibility,
  review exact body digest and publish via current-version CAS. Personal visibility
  is the default. It does not replace AI-authored documents in desktop conversations.
- Desktop enrollment opens this Web page; the browser chooses from actual projects
  and confirms the desktop code. An approval receipt does not mean an online
  desktop. Own devices show the server's observed heartbeat snapshot and timestamp;
  refresh to recheck, revoke explicitly. There is no arbitrary remote execution.
- Event cursors use bounded catch-up with visible pending/reset/offline states.
  They do not stand in for current Jira, native task execution or test success.

## Unknown write results and privacy

Before POST, retain one UUID and request digest scoped to the current account and
project. The browser uses tab `sessionStorage` **only for these operation references**,
never session/CSRF/device credentials, material bodies, quotes or private chat.
Browser cookies are the service's HttpOnly authentication boundary.

A lost response retains its exact operation identity. Use “核对原操作” to query the
server receipt. While the original page is open its immutable in-memory payload
can retry under the same UUID. A page reload retains only the reference: it can
inspect receipts, but cannot guess/rebuild/resend the missing body. A missing receipt
is a read-point fact, not proof an in-flight write cannot later commit. Current
authorization is rechecked by the server even for an old receipt. Switching users
does not retarget old commands. Corrupt/unavailable journal storage refuses new
writes before dispatch rather than losing their recovery reference.
Late replies after an account change retain the original account's unresolved
reference. A later rejected retry does not erase an earlier unknown outcome or
unlock a new command identity. Oversized replies are cancelled rather than left
downloading; concurrent retries of one identity share the same in-flight guard.

This is not the durable desktop offline outbox. It does not store all documents
for service-offline reading, maintain a second credential store or silently share
personal materials. Developer-offline published reading works through the live
team service. Explicit authorization rejection clears protected browser content;
network outages are labelled stale/unavailable.

## Local validation and acceptance

Run `npm run typecheck` and `npm run build` in this package. Follow the root [local-only rule](../../AGENTS.md); temporary scripts, browser profiles, accounts and captures belong in OS TEMP rather than Git.

Verify exact UTF8/digest checks, response bounds and one command identity through ACK loss, retry, account/project changes and missing receipts. In the actual built Web/service flow, verify login, immutable selected versions, personal access, quote feedback, publication CAS, membership revisions and device pairing/revocation. Inspect responsive layouts, zoom, native Tab/Escape focus and current authorization removal.

Fault injection must be labelled separately from service-produced behavior. Company SSO, production deployment, installed desktop pairing/outbox and separate-machine acceptance require their actual environments; controlled accounts do not establish those results.
