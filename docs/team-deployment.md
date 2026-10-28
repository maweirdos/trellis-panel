# Docker team service

## Runtime and storage

Run one team-service instance with the compiled team-web client at the same
origin. The image builds both packages from their independent lockfiles using
[Node.js 24 LTS](https://nodejs.org/en/about/previous-releases) and the
[official `node:24-bookworm-slim` image](https://hub.docker.com/_/node).
The packages require Node.js >=24.12.0, including `node:sqlite`.

The supported database is single-instance SQLite with immutable material blobs.
PostgreSQL, MySQL, distributed writers and multiple service replicas are not
implemented. Local Git repositories, desktop credentials, model credentials and
Agent/ACP execution remain on desktop machines. Do not mount their directories
or a Docker socket into this service.

The runtime runs as `node` (UID/GID 1000), with a read-only image filesystem,
an ephemeral `/tmp` and one writable named volume. Its process listens on
`0.0.0.0:5441` inside the container. Compose publishes `127.0.0.1:5441` on the
host by default. `SIGTERM` closes HTTP and the owned SQLite worker; Compose
allows 30 seconds before forced termination. `/health` checks the process and
`/ready` checks the actual storage worker. These checks do not verify an OIDC
provider or desktop execution.

## Build and start

Use Docker Engine with Linux containers and Docker Compose v2 or newer. Run
commands from the repository root. The examples below use a POSIX shell. On
Windows, create the configuration file with an editor and pass its absolute
path to the same `docker compose --env-file` commands.

Create a private configuration file outside the checkout:

```sh
mkdir -p "$HOME/.config/trellis-team"
chmod 700 "$HOME/.config/trellis-team"
umask 077
cat > "$HOME/.config/trellis-team/config.env" <<'EOF'
TEAM_PUBLIC_ORIGIN=http://127.0.0.1:5441
TEAM_DEPLOYMENT_MODE=local
TEAM_ALLOW_SELF_REGISTRATION=1
EOF

docker compose --env-file "$HOME/.config/trellis-team/config.env" config --quiet
docker compose --env-file "$HOME/.config/trellis-team/config.env" build --pull
docker compose --env-file "$HOME/.config/trellis-team/config.env" up -d --wait
docker compose --env-file "$HOME/.config/trellis-team/config.env" ps
```

Open `http://127.0.0.1:5441`. No username, password, signing key or existing
session is bundled. Registration policy must be explicitly supplied to Compose.
An occupied host port fails without stopping its owner. To use another port,
set both `TEAM_PUBLISH_PORT` and the matching `TEAM_PUBLIC_ORIGIN`, then recreate
the service. `localhost` and `127.0.0.1` are different origins; use the configured
one consistently.

Read logs or stop the service without deleting its data:

```sh
docker compose --env-file "$HOME/.config/trellis-team/config.env" logs --tail=100 team
docker compose --env-file "$HOME/.config/trellis-team/config.env" stop team
```

## Accounts, teams and desktop pairing

On the Web sign-in page select **创建独立账号**, enter your own username, display
name and password, then choose **注册并登录**. Usernames contain 3–64 letters,
digits, dots, underscores or hyphens; passwords require at least 10 characters.
Local registration creates an ordinary account. It does not grant platform
administration, and the first visitor has no special privileges.

In **团队与成员**, create a team and then a shared workspace. The team creator owns that
team. Choose **邀请加入团队和工作区**, select the workspace and roles and specify the
recipient's independent username. The recipient opens the invitation, signs in
as that account and chooses **确认以当前账号加入**. Opening the link alone grants
no membership. Registration can be closed with `TEAM_ALLOW_SELF_REGISTRATION=0`
and a Compose `up -d`; existing accounts can still log in. New local users must
register while registration is enabled. Password recovery and email delivery
are not configured.

On each desktop, open **团队** → **选择本机或共享协作空间**, enter the same external
origin under **团队服务地址**, and choose **连接并在浏览器登录**. In the browser,
sign in, select an authorized workspace, verify the desktop name and pairing code,
then approve. Return to the desktop, refresh the connection if needed, and select
**进入团队工作区**. A pending pairing expires after five minutes by default; start
again when expired. Device credentials remain in the desktop's protected store.

For a different computer use the server's HTTPS origin, not `127.0.0.1`.
Shared workspace membership is separate from a developer's local repository
binding. Existing local workspaces are not uploaded automatically. Agent/squad
assignment records shared intent; local execution still requires an available
desktop Runtime. The container is not an execution worker.

## HTTPS and external access

Configure DNS and a valid TLS certificate for an origin such as
`https://team.example.com`. Update the private configuration file:

```dotenv
TEAM_PUBLIC_ORIGIN=https://team.example.com
TEAM_DEPLOYMENT_MODE=intranet
TEAM_ALLOW_SELF_REGISTRATION=1
```

Choose registration `0` or `1` according to your account policy. Recreate with
`docker compose --env-file "$HOME/.config/trellis-team/config.env" up -d --wait`.
Keep the host publication on loopback when the reverse proxy runs on this host.
For example, use this Nginx server configuration with your actual certificate
files:

```nginx
server {
    listen 80;
    server_name team.example.com;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name team.example.com;
    ssl_certificate /etc/ssl/team/fullchain.pem;
    ssl_certificate_key /etc/ssl/team/privkey.pem;

    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:5441;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
}
```

Preserve the public Host including a nonstandard port, browser Origin, cookies
and `X-CSRF-Token`. Proxy `/`, `/assets/`, `/api/`, `/auth/`, `/health` and `/ready`
to this service without a subpath or authentication-response cache. The service
checks the configured Host and exact Origin and does not trust forwarded headers;
`X-Forwarded-Proto` does not replace `TEAM_PUBLIC_ORIGIN`. HTTPS origin configuration
controls secure cookies. Rate limits see the proxy address, so requests through
one proxy share its IP limits.

If a proxy runs in another container, attach it to this Compose network and
proxy to `team:5441`. Its `127.0.0.1` points to itself. If a proxy runs on a
different host, bind `TEAM_PUBLISH_HOST` to the server's private interface and
restrict that port to the proxy in the firewall.

Plain HTTP on a private LAN requires an explicit exact RFC1918 IPv4 origin in
`TEAM_ALLOWED_INTRANET_HTTP_ORIGINS`, plus `TEAM_DEPLOYMENT_MODE=intranet`, the
matching `TEAM_PUBLIC_ORIGIN` and an appropriate `TEAM_PUBLISH_HOST`. This sends
credentials and content without TLS. Prefer HTTPS. Do not use the container's
`0.0.0.0` bind address as a browser or desktop URL.

## Optional OIDC

Local accounts work without an identity provider. To also offer OIDC login, set
`TEAM_OIDC_ISSUER` and `TEAM_OIDC_CLIENT_ID` in the private configuration file.
Register exactly `<TEAM_PUBLIC_ORIGIN>/auth/callback` at the issuer, using
authorization code flow with PKCE S256 and scopes `openid profile`. A confidential
client can supply `TEAM_OIDC_CLIENT_SECRET` for `client_secret_basic`; omit it for
a public client. Protect the environment file and Docker daemon access; container
environment values are visible to Docker operators. The service does not support
an OIDC secret-file variable.

Optional `TEAM_BOOTSTRAP_SUBJECT` names an exact stable OIDC `sub` under that
issuer. It is not an email, local username or first-login rule. The matching
signed-in identity can administer accounts. Company SSO lifecycle integration
and back-channel revocation are not provided. For the GitLab-specific variables,
see [service configuration](../packages/team-service/README.md#explicit-deployment-configuration).

## Data location and ownership

By default the Docker-managed volume is `trellis-team-data`, mounted at
`/var/lib/trellis-team`. The service uses its `data/` child for `team.sqlite`,
`blobs/` and `service.lock`. Docker manages the host-side location; inspect it
with `docker volume inspect trellis-team-data`. It is separate from the local
launcher's OS user data directory described in
[local collaboration](team-collaboration.md#persistent-data).

`TEAM_VOLUME_NAME` selects another volume. `TEAM_DATA_SUBDIR` selects a child
directory, initially `data`; keep it within this volume. Preserve both settings
across upgrades. A fresh named volume inherits the image directory's UID/GID
1000 ownership. A replacement bind mount or imported volume must be writable
by UID/GID 1000 and private to the operator. Do not share the volume with another
service instance or a network filesystem writer.

`docker compose down` retains the named volume. `down -v`, volume removal and
volume pruning can delete the service's data. Backups contain private records,
password hashes and session metadata and require equivalent protection.

## Backup

Stop the service before opening the backup CLI, which acquires the same writer
lock. Use a new directory name for every backup, outside the active data child.
For example, after creating a private host backup directory:

```sh
mkdir -p "$HOME/trellis-team-backups"
chmod 700 "$HOME/trellis-team-backups"
docker compose --env-file "$HOME/.config/trellis-team/config.env" stop team
docker compose --env-file "$HOME/.config/trellis-team/config.env" run --rm --no-deps team node dist/backup.mjs create /var/lib/trellis-team/backup-20261028
docker compose --env-file "$HOME/.config/trellis-team/config.env" cp team:/var/lib/trellis-team/backup-20261028 "$HOME/trellis-team-backups/"
docker compose --env-file "$HOME/.config/trellis-team/config.env" up -d --wait
```

Proceed to the copy only after the backup command succeeds. The stopped `team`
container must still exist for `compose cp`. Keep the complete `backup.json`,
`team.sqlite` and `blobs/` together, copy them off the Docker host and verify a
restore separately. A copy left only inside the data volume is not protection
against losing that volume. Do not copy only a running database file.

## Restore

Restore with the service stopped, into a new directory whose parent exists. The
CLI refuses to overwrite an existing directory. For a backup still in the volume:

```sh
docker compose --env-file "$HOME/.config/trellis-team/config.env" stop team
docker compose --env-file "$HOME/.config/trellis-team/config.env" run --rm --no-deps team node dist/backup.mjs restore /var/lib/trellis-team/restored-20261028 /var/lib/trellis-team/backup-20261028
```

Only after success, set `TEAM_DATA_SUBDIR=restored-20261028` in the private
configuration file and run Compose `up -d --wait`. The original data child stays
available. Restore verifies database and blob digests, SQLite integrity, schema
and stored identities. It preserves instance identity and rotates the epoch,
cursor secret and authorization revision. Existing cursors and desktop commands
pinned to the old epoch need reconciliation; reconnect desktop devices for new
work and retain uncertain command history.

To recover from an off-host backup into a fresh installation, configure a new
`TEAM_VOLUME_NAME`, build the image and create a stopped container. Copy the backup
into that container:

```sh
docker compose --env-file "$HOME/.config/trellis-team/config.env" build --pull
docker compose --env-file "$HOME/.config/trellis-team/config.env" create team
docker compose --env-file "$HOME/.config/trellis-team/config.env" cp "$HOME/trellis-team-backups/backup-20261028" team:/var/lib/trellis-team/
docker compose --env-file "$HOME/.config/trellis-team/config.env" run --rm --no-deps --user 0 --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint chown team -R 1000:1000 /var/lib/trellis-team/backup-20261028
```

The root maintenance command temporarily grants ownership-change and directory
access capabilities to change only the copied backup's ownership.
Then run the restore command above and select the restored child before starting
the service. Do not start a second writer against the original volume.

## Upgrade and recovery

Back up first. Record the old image ID with `docker compose ... images -q team`
and keep that image under a distinct tag. Set `TEAM_IMAGE` to a new release tag,
build with `build --pull`, then run `up -d --wait`. Keep the same volume, data
child and public origin. The service applies its supported schema migrations on
open and rejects future schemas. Rolling back an image after migration may
require restoring the pre-upgrade backup into a new data child; do not run an
older image over a newer schema.

`TEAM_NODE_IMAGE` can pin a tested official Node 24 image by patch tag or digest
for repeatable builds. Without a pin, `build --pull` updates the supported Node
24 base. A running container does not update itself.

For unhealthy startup, inspect `compose logs` and `/ready`. A Host mismatch
returns 421; check the exact external host/port and proxy configuration. A lock
error means the owner needs investigation. After a crash, container PID reuse
can make a previous owner look live. Stop every container/process with this
volume, establish exclusive offline ownership and preserve the lock as evidence
before operator recovery. Do not automatically delete or bypass the lock on
restart. Graceful `compose stop` is the normal shutdown path.
