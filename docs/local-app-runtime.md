# Local application runtime

The named application selector and direct run controls in the ordinary window header, the bottom run dock and Tasks > Tools > Run show the same project applications. The panel starts foreground commands, displays their process and readiness states, and lets you stop or restart the instances it owns. Closing a conversation, output tab/dock or hiding the window to the tray leaves these applications running. See the [developer tools workbench](developer-tools-workbench.md) for toolbar, resizable output and manual Git interactions.

## Configure an application

Choose an application name, stable ID, working directory and launch mode. Paths in the working-directory field are relative to the project unless absolute. Environment-file paths are relative to that working directory unless absolute. Add expected TCP bind addresses/ports and, optionally, a local TCP or HTTP readiness check. Saving or importing a package script does not execute it.

Application configuration is local to the machine and project. It is stored under Electron userData, not committed to the repository or copied into global settings. Explicit environment overrides are write-only: existing values can be kept, replaced or cleared, but configuration reads expose only their names. Persistent overrides require system credential encryption; use an environment file if encryption is unavailable.

Use an executable plus separate argument entries for ordinary programs. The explicit script mode runs a complete command using shell semantics. Only use it for commands you intend the shell to interpret. The npm mode selects a script that actually exists in the chosen directory's `package.json`.

Examples below show the launch fields; use the configuration dialog to save them. Executables must exist on this machine or resolve through the effective application PATH.

| Application | Launch mode | Executable or command | Arguments |
| --- | --- | --- | --- |
| Java artifact | argv | `java` or a local JDK's `java.exe` | `-Xmx512m`, `-jar`, `target/service.jar` |
| Java development build | script | `mvn -pl service -am package -DskipTests && java -jar service/target/service.jar` | Part of the explicit command; adapt module/artifact names. |
| Node development | npm-script | Select the real `dev` script | The project owns the script body. |
| Python HTTP service | argv | `python` or the project's virtual-environment executable | `-m`, `uvicorn`, `app:app`, `--host`, `127.0.0.1`, `--port`, `8000` |

A restart reruns the saved entry point. If your Java entry point runs an existing JAR, the platform does not compile changed source for you. Put the necessary build in a project-owned foreground startup script or use your build tool's development command. The platform does not delete `target`, build caches, dependencies or business data before starting.

## Environment files

Each start and restart rereads the listed files. Precedence, from lowest to highest, is:

1. The platform process's inherited environment.
2. Environment files in listed order; later assignments replace earlier ones.
3. Explicit application overrides.

On Windows, variable names are compared case-insensitively, including `Path`/`PATH`. The platform does not modify its parent environment.

The supported UTF-8 subset includes blank lines, `#` comments, optional `export`, single-line `KEY=VALUE` assignments and single/double-quoted values. Duplicate keys use the last assignment. Unquoted inline comments follow whitespace. Quoted `#` characters remain values. Backslash and matching quote escapes are supported inside quotes; double quotes also support `\n`, `\r` and `\t`. Physical multiline values, unmatched quotes, invalid names and NUL are rejected before launch. `$NAME`, `${NAME}` and command substitutions remain literal text; nothing is evaluated by the environment parser.

```dotenv
# .env.local; keep secrets outside version control
APP_PORT=8080
SPRING_PROFILES_ACTIVE=local
DATABASE_URL="jdbc:postgresql://127.0.0.1:5432/demo"
export EXAMPLE_LITERAL='${NOT_EXPANDED}'
```

The initial limits are 12 referenced files, 256 KiB per file, 512 file/override keys, and 32 KiB per value. Errors identify the file and line without copying its value. Configuration and execution previews omit environment values. Known supplied values are redacted from retained output where practical, but applications can print transformed or unknown secrets; do not treat the console as a guaranteed secret-free sink.

Approving an application authorizes its referenced environment files as mutable local inputs. Changing a password/value in an existing file does not require a new command approval. Changing the executable, arguments, startup entry, environment references, override settings or other execution-relevant configuration requires a new review. This approval is a launch contract, not a sandbox against other programs running as the same OS user.

## Process state, readiness and ports

A running process is not automatically a ready service. Applications show separate process and readiness indicators. Without a configured probe, readiness remains unconfigured/unknown. A failed readiness check does not invent a process exit. TCP checks confirm a listener; HTTP checks validate a local HTTP response. Neither establishes every business dependency's health.

Declared ports are checked before launch. An occupied external port is reported with observed owner details when available, and the platform does not automatically stop that owner. Fix the configuration or resolve the external process deliberately, then retry. A successful preflight can still race another process; subsequent launch failures stay visible in the application output/status.

Applications are single-instance per project and ID, shared across conversations. Repeating start returns the existing instance. Stop and restart serialize. Restart waits for verified cleanup before launching again. Timeout or unverified descendants leave a cleanup-required/unknown state and block an unsafe replacement instance.

Use foreground commands that retain a traceable child tree. Detached daemons and commands that hand work to another service manager cannot be reliably owned by this runtime. The platform does not scan and adopt arbitrary terminal/IDE processes. A reused PID in an old record never grants permission to kill a new process.

Completely exiting the platform prompts when owned applications remain and waits for their cleanup. Cancellation keeps the platform available. After an abnormal exit, persisted process identity must be reconciled; unknown is shown when ownership cannot be verified. There is no automatic boot restore, independent daemon or crash relaunch.

## Use from an Agent editor

In Settings → Network services, install or update the `tpanel` command beside the local access protocol, then enable the local access service. Access remains opt-in and bound to `127.0.0.1`. The shim uses the platform's bundled Electron executable in Node mode; a global Node installation is not required.

Declare the application and approve its first execution through the panel. The CLI cannot create arbitrary launch commands or approve a changed command. An unapproved start returns `E_DENIED` with `APPROVAL_REQUIRED`, and the application panel shows the request.

```powershell
tpanel app list --project "D:\projects\demo"
tpanel app status backend --project "D:\projects\demo"
tpanel app start backend --project "D:\projects\demo" --request-id start-backend-1
tpanel app logs backend --project "D:\projects\demo"
tpanel app restart backend --project "D:\projects\demo" --request-id restart-backend-1
tpanel app stop backend --project "D:\projects\demo" --request-id stop-backend-1
```

Commands return one JSON result and a nonzero process exit code on failure. `--project` must be an absolute path to a known project; a delayed request never follows a project switch. `--timeout` accepts 100 through 60000 milliseconds (default 15000). `logs --cursor <offset>` requests output after a previous cursor; honor the returned run identity and truncation flag.

For a mutation retry after a lost response, reuse the same `--request-id`. Concurrent retries share the original operation; reusing that ID for a different action/project/application returns `E_CONFLICT`. If no ID is supplied, the CLI generates one for that invocation. On a timeout, first inspect status; a disconnected client does not establish that the server operation was cancelled.

The installed client discovers a local descriptor under the same userData as its installation and reads the sibling access token for each request. Tokens do not appear in command arguments, deep links, descriptor contents or CLI output. Token rotation takes effect on the next invocation. Disabled/unavailable access returns a setup-needed failure without enabling or launching the platform automatically. Existing `tpanel notify`, `open` and `task-event` commands remain available.

See [TPAP application endpoints](access-protocol.md#9-local-application-resources) for request details.

## Verification boundaries

Runtime fixture tests can verify process ownership, environment reload, protocol/CLI behavior, port conflict handling and panel interactions. They do not prove compatibility with a private microservice project's build scripts or a particular memory saving. Measure the real workload with IDEA closed before claiming an IDEA/JVM memory improvement.
