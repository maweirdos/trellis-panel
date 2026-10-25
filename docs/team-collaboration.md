# Local team collaboration

## Start the service

Use Node.js 24.12.0 or newer with npm. From the repository root:

```sh
npm run team:local
```

The launcher checks `packages/team-service` and `packages/team-web` independently.
When a declared dependency is missing, it runs `npm ci --include=dev --no-audit
--no-fund` against that package's lockfile. It then runs each package's own
`npm run build` and loads the actual `packages/team-service/dist/cli.mjs` in
Node.js. The compiled Web client is served by the same service.

Open [the local team service](http://127.0.0.1:5441). The default bind address is
`127.0.0.1:5441`. Stop it with Ctrl+C in its terminal. The launcher does not open
a browser or helper window. An occupied port causes a visible error and nonzero
exit; the launcher never stops another process.

Build without starting a service, or reuse the existing build:

```sh
npm run team:build
npm run team:local -- --no-build
node scripts/team-local.mjs --help
```

`--no-build` requires both packages' dependencies and build outputs to exist.
Run `team:build` after changing source or lockfiles; dependency presence alone
does not verify that an existing installation matches a changed lockfile.
The root desktop dependency installation is separate from these two packages.

## Accounts, invitations and desktop connection

On the Web sign-in page, choose **创建独立账号**, provide a username, display name
and password, then select **注册并登录**. Usernames contain 3–64 letters, digits,
dots, underscores or hyphens and are case insensitive. Passwords require at least
10 characters. Each registered account is ordinary; registration does not grant
platform administration. No accounts or passwords are seeded by the launcher.

In **团队与成员**, create a team, then a project in that team. The creator owns
the team. Choose **邀请加入团队和项目**, select the project and roles, and enter the
recipient's independent username. Give the generated invitation link to that
person. The recipient registers or logs in with the named account, checks the
team and project, and explicitly chooses **确认以当前账号加入**. Opening a link or
logging in alone does not grant project access.

Select the authorized project, then **项目协作**, to share tasks, comments,
versions, Agent configurations and squads. Assignment to an Agent or squad
records configuration and dispatch intent; actual execution requires a Runtime.

In the desktop **团队** module, open **选择本机或共享协作空间**. Enter
`http://127.0.0.1:5441` under **团队服务地址** and choose **连接并在浏览器登录**.
In the browser, sign in, select the authorized project, check the desktop name
and pairing code, and approve the connection. Return to the desktop, refresh
the connection state if needed, and choose **进入共享空间**.
Existing local workspace data is independent and is not automatically uploaded.
After restoring a backup, commands from the old service epoch retain their
original identity and cannot be replayed into the restored workspace. The
desktop preserves uncertain records under their original connection. Establish
a new device connection to continue fresh work after reviewing that history.

Two accounts on this computer can use separate browser profiles or private
windows. Both must use the same service address and accept the appropriate
project invitation. On another computer, `127.0.0.1` refers to that other computer;
use a separately configured intranet service address for shared access.

## Spaces, tasks and local projects

A collaboration space holds work such as product development, customer support,
operations or HR. Opening the desktop **团队** module does not require a code
directory. The selected team-service project is a shared authorization scope;
the developer's local Trellis project is a separate machine binding.

Capture a requirement with its description and acceptance criteria. Without a
version, it enters **分拣台**. Accept it now and schedule later, or use
**接纳并安排** to choose a colleague, squad or Agent and an optional version.
Design work can begin while the task remains unversioned. A pure-human squad
requires no Agent; choose a person as its leader. Agent assignment retains a
human handler and does not claim execution.

The same task carries design, implementation, test and acceptance records.
**转交** changes its current handler without resetting the stage. A test return
keeps the original task, version and development context. General work can submit
an artifact directly for acceptance without a code project.

For code work, **开始处理** prepares or resumes the corresponding local Trellis
planning task and opens the existing native reader. Select a machine project only
when no binding exists. Requirements and design context are transferred without
manual task linking. Preparation uses `--no-start`; it does not activate an agent
or bypass Trellis planning and execution checks. Existing developer edits remain
intact. Closing the native workspace returns to the original collaboration task.

Task type, status and label maintenance each have a separate entry under **配置**.
Space settings contain space metadata, access and members.

## Versions and delivery sources

Each version owns its explicitly planned task scope. Independent versions can
run in parallel; an optional predecessor expresses serial order. Closing a
version requires finishing or explicitly handling its remaining work and freezes
its task membership. Completion never moves tasks automatically.

In a target version, use **交付来源** to register code or artifact references from
another version. For example, registering incremental v15 and v16 deliveries
into v17 keeps v15's tasks in v15, v16's tasks in v16, and v17's task scope and
completion percentage unchanged. Sources may still be in progress. Registration
records evidence; it does not execute Git merges or change external tracker data.

## Persistent data

The launcher chooses a user data directory outside the Git checkout:

| Platform | Default directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\TrellisPanel\team-service` |
| macOS | `~/Library/Application Support/TrellisPanel/team-service` |
| Linux | `$XDG_DATA_HOME/TrellisPanel/team-service`, or `~/.local/share/TrellisPanel/team-service` |

On Windows without `LOCALAPPDATA`, the fallback is
`~/AppData/Local/TrellisPanel/team-service`. `TEAM_DATA_DIR` overrides the default
and must be an absolute path outside a repository/worktree, including resolved
junctions and symlinks. Reusing this directory preserves accounts, memberships,
invitations, command receipts and shared workspaces across restarts and worktrees.

`team.sqlite` and its associated blob directory belong to one service instance.
The service checks `service.lock`; the launcher never removes or bypasses it.
An ambiguous or live owner must be inspected before restarting. A confirmed dead
owner is handled by the service's stale-lock recovery. Restrict OS access to
the directory, including backups.

For backup/restore commands and artifact requirements, see
[the service README](../packages/team-service/README.md). Stop the service before
using its CLI backup or restore command. Restore into a new data directory and
point `TEAM_DATA_DIR` to the restored directory.

## Environment configuration

Supply variables in the shell that launches the service. Neither the launcher
nor the service automatically loads a `.env` file.

| Variable | Launcher default or requirement |
| --- | --- |
| `TEAM_HOST` | `127.0.0.1`; local mode accepts loopback addresses only |
| `TEAM_PORT` | `5441`; integer from 1 through 65535 |
| `TEAM_PUBLIC_ORIGIN` | `http://<TEAM_HOST>:<TEAM_PORT>`; exact origin used by clients |
| `TEAM_DATA_DIR` | Persistent directory listed above |
| `TEAM_WEB_DIR` | Absolute `packages/team-web/dist` from this checkout |
| `TEAM_DEPLOYMENT_MODE` | `local` or `intranet`; default `local` |
| `TEAM_ALLOW_SELF_REGISTRATION` | Local loopback default is enabled; `0` disables new registrations, `1` enables them. Intranet mode requires an explicit `0` or `1` |
| `TEAM_ALLOWED_INTRANET_HTTP_ORIGINS` | Comma-separated exact private IPv4 HTTP origins, including ports; otherwise non-loopback origins require HTTPS |

For a different local port in PowerShell:

```powershell
$env:TEAM_PORT = '5442'
$env:TEAM_PUBLIC_ORIGIN = 'http://127.0.0.1:5442'
npm run team:local -- --no-build
```

For a later intranet installation, use the service computer's actual address.
Browser collaboration writes use Web Crypto and require HTTPS, except loopback
addresses on the service computer. Configure an HTTPS reverse proxy for other
computers. The HTTP example below configures the explicitly allowed transport;
it does not make a private IP address a secure browser context.
For example, on a computer whose assigned address is `192.168.1.50`:

```powershell
$env:TEAM_DEPLOYMENT_MODE = 'intranet'
$env:TEAM_ALLOW_SELF_REGISTRATION = '1'
$env:TEAM_HOST = '192.168.1.50'
$env:TEAM_PORT = '5441'
$env:TEAM_PUBLIC_ORIGIN = 'http://192.168.1.50:5441'
$env:TEAM_ALLOWED_INTRANET_HTTP_ORIGINS = 'http://192.168.1.50:5441'
npm run team:local -- --no-build
```

The HTTP allowlist accepts exact RFC1918 IPv4 origins, not wildcard hosts or
neighboring ports. HTTP carries account passwords and session traffic without
TLS; use an HTTPS reverse proxy for a protected intranet endpoint and preserve
the configured public Host header. The service itself listens with HTTP; setting
an HTTPS public origin configures client identity and cookies, not a TLS listener.
The launcher does not configure proxies, firewall rules, SSH or public hosting.

## Optional GitLab login

Independent account registration and login require no GitLab instance, OAuth
application or GitLab credentials. GitLab is an additional login option when its
OIDC configuration is supplied:

| Variable | Meaning |
| --- | --- |
| `TEAM_OIDC_ISSUER` | Exact configured issuer URL |
| `TEAM_OIDC_CLIENT_ID` | Web OIDC application ID |
| `TEAM_OIDC_CLIENT_SECRET` | Optional confidential Web client secret, supplied through deployment secrets |
| `TEAM_GITLAB_BASE_URL` | Exact GitLab origin matching the OIDC issuer |
| `TEAM_GITLAB_NATIVE_CLIENT_ID` | Optional separate public native OAuth application ID for desktop GitLab integration |
| `TEAM_GITLAB_INTEGRATION_BASE_URL` | Optional native integration origin; defaults to `TEAM_GITLAB_BASE_URL` and must match the issuer |

Register the Web redirect URI as `<TEAM_PUBLIC_ORIGIN>/auth/callback`, with
authorization code flow, PKCE S256 and `openid profile` scopes. The native OAuth
application uses its own loopback callback and no client secret. A private HTTP
GitLab origin also requires its own exact entry in
`TEAM_ALLOWED_INTRANET_HTTP_ORIGINS`. See the
[service configuration](../packages/team-service/.env.example) and
[desktop integration guide](team-desktop.md).

Local usernames and external issuer subjects identify separate accounts. Matching
display names do not link them or transfer membership.

## Health and isolated verification

```powershell
Invoke-RestMethod http://127.0.0.1:5441/health
Invoke-RestMethod http://127.0.0.1:5441/ready
```

`/health` checks the service; `/ready` also queries its SQLite writer.
Authentication options are available at `GET /api/auth/options`. Independent
registration and login use `POST /auth/local/register` and
`POST /auth/local/login` with the sign-in CSRF challenge and exact Origin.
Signed-in changes use the current session's CSRF token. Invitation endpoints
are documented in [API.md](../packages/team-service/API.md).

For isolated validation, freeze the service and Web build outputs and use
temporary SQLite directories, accounts and browser profiles in OS TEMP. Verify
named invitations, actual HTTP permissions, workspace snapshots and CAS
commands with two independent accounts. Check task, comment, version, Agent and
squad synchronization, command replay, origin/account isolation, persistence
after restart and access revocation.

Exercise both authenticated browser sessions against the frozen builds and
compare the same shared task. Record build hashes with evidence outside the
repository. Do not connect these checks to the persistent team store. Validation
on one physical host does not establish separate-computer access, intranet
deployment, company GitLab login, installed desktop behavior or Runtime execution.
