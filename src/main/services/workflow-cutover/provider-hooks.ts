import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { taskInputCanonical } from '../../../shared/team-canonical'
import { fileDigest } from './files'

export const NATIVE_PROVIDER_HOOK_PATH = '.crux/workflow/v1/provider-hook.py'
export type WorkflowEditorProvider = 'claude' | 'codex'
const settingsSchema = z.object({ hooks: z.record(z.string(), z.unknown()) }).passthrough()
const scripts = {
  'session-start.py': ['c399c59cfeb88f1fc2b962cbeaf288f2a89f99ec627fc7e7974586ebe918a35f', 'd6731216da0b490f4e142607b7b83dda0a6c0a2ff6c18fb8c595a750b15fecca'],
  'inject-subagent-context.py': ['022d41a9b6f5dba45bc284a466206fbefedf93f2504a6fe30141ec91c3fbc1ae', '4c06b94fbb2e4c5a485740624131cba5e0bcbb10592408283df6858dbdb2f54a'],
  'inject-workflow-state.py': ['71ef1aa1ed1051a697cae3c9ebffa518958a3bbd4d147434f382348829915f8c', '4fd136d1890410bab641132ba2ca4d7e21e81ce0405d316e4a457a83a97c7fdf']
} as const
const decoder = new TextDecoder('utf-8', { fatal: true })
const command = (text: string, timeout: number) => ({ type: 'command', command: text, timeout })
function baselineHooks(provider: WorkflowEditorProvider, python: string): Record<string, unknown> {
  if (provider === 'codex') return {
    UserPromptSubmit: [{ hooks: [command(python + ' -X utf8 .codex/hooks/inject-workflow-state.py', 15)] }],
    SubagentStart: [{ matcher: '^(?:trellis-implement|trellis-check|trellis-research)$', hooks: [command(python + ' -X utf8 .codex/hooks/inject-subagent-context.py', 15)] }]
  }
  return {
    SessionStart: ['startup', 'clear', 'compact'].map(matcher => ({ matcher, hooks: [command(python + ' .claude/hooks/session-start.py', 30)] })),
    PreToolUse: ['Task', 'Agent'].map(matcher => ({ matcher, hooks: [command(python + ' .claude/hooks/inject-subagent-context.py', 30)] })),
    UserPromptSubmit: [{ hooks: [command(python + ' .claude/hooks/inject-workflow-state.py', 15)] }]
  }
}
export function nativeProviderSettings(relativePath: string, bytes: Uint8Array): { provider: WorkflowEditorProvider; python: string; settings: z.infer<typeof settingsSchema> } | null {
  const provider = relativePath === '.codex/hooks.json' ? 'codex' : relativePath === '.claude/settings.json' || relativePath === '.claude/settings.local.json' ? 'claude' : null
  if (!provider || bytes.length > 1024 * 1024) return null
  try {
    const settings = settingsSchema.parse(JSON.parse(decoder.decode(bytes)))
    for (const python of ['python', 'python3', 'python.exe', 'python3.exe']) if (taskInputCanonical(settings.hooks) === taskInputCanonical(baselineHooks(provider, python))) return { provider, python, settings }
  } catch { /* Unknown configuration remains a conversion blocker. */ }
  return null
}
/** Exact reviewed Trellis 0.6.17 hook sources, including LF/CRLF. No source execution. */
export function isNativeProviderHookSource(relativePath: string, bytes: Uint8Array): boolean {
  const match = /^\.(claude|codex)\/hooks\/(session-start\.py|inject-subagent-context\.py|inject-workflow-state\.py)$/.exec(relativePath)
  if (!match || bytes.length > 1024 * 1024 || match[1] === 'codex' && match[2] === 'session-start.py') return false
  const sha = fileDigest(bytes)
  for (const [name, digests] of Object.entries(scripts)) if (name === match[2] && digests.some(value => value === sha)) return true
  return false
}
export function requiredProviderSources(provider: WorkflowEditorProvider): string[] {
  return (provider === 'claude' ? ['session-start.py', 'inject-subagent-context.py', 'inject-workflow-state.py'] : ['inject-subagent-context.py', 'inject-workflow-state.py']).map(name => '.' + provider + '/hooks/' + name)
}
export function convertNativeProviderSettings(relativePath: string, bytes: Uint8Array): Buffer | null {
  const reviewed = nativeProviderSettings(relativePath, bytes)
  if (!reviewed) return null
  const invocation = reviewed.python + ' -X utf8 ' + NATIVE_PROVIDER_HOOK_PATH + ' ' + reviewed.provider
  const run = (event: string, timeout: number) => [reviewed.provider === 'codex' ? { ...command(invocation + ' ' + event, timeout), additionalContextLimit: 0 } : command(invocation + ' ' + event, timeout)]
  const hooks = reviewed.provider === 'codex' ? {
    UserPromptSubmit: [{ hooks: run('UserPromptSubmit', 15) }],
    PreToolUse: [{ matcher: '^(?:spawn_agent|Agent)$', hooks: run('PreToolUse', 15) }],
    SubagentStart: [{ matcher: '^(?:trellis-implement|trellis-check|trellis-research)$', hooks: run('SubagentStart', 15) }]
  } : {
    SessionStart: ['startup', 'clear', 'compact'].map(matcher => ({ matcher, hooks: run('SessionStart', 30) })),
    PreToolUse: ['Task', 'Agent'].map(matcher => ({ matcher, hooks: run('PreToolUse', 30) })),
    UserPromptSubmit: [{ hooks: run('UserPromptSubmit', 15) }]
  }
  return Buffer.from(JSON.stringify({ ...reviewed.settings, hooks }, null, 2) + '\n')
}
export function validNativeAccessDescriptor(value: string): boolean {
  return isAbsolute(value) && !value.includes('\0') && value.length <= 4096
}
/** Finite provider adapter: no project source execution, caller-selected tool, redirects or proxy. */
export const NATIVE_PROVIDER_HOOK_PYTHON = String.raw`import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

LIMIT = 1048576
PROTOCOL = "2025-11-25"
ROLES = {"trellis-implement": "implement", "trellis-check": "check", "trellis-research": "research"}
TASK_KEYS = ("instanceId", "projectId", "spaceId", "taskId", "taskCreatedAt")
current_event = None

class HookError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HookError("LOCAL_REDIRECT_REFUSED")

def read_small(path, limit):
    if path.is_symlink() or not path.is_file():
        raise HookError("LOCAL_FILE_UNAVAILABLE")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise HookError("LOCAL_FILE_LIMIT")
    return data

def task_key(task):
    if not isinstance(task, dict) or any(key not in task for key in TASK_KEYS):
        raise HookError("TASK_IDENTITY_INVALID")
    return tuple(task[key] for key in TASK_KEYS)

def emit(event, context, updated=None):
    output = {"hookEventName": event, "additionalContext": context}
    if updated is not None:
        # Keep normal provider permission evaluation; never grant an automatic allow.
        output["updatedInput"] = updated
    print(json.dumps({"hookSpecificOutput": output}, ensure_ascii=False))

def invoke(config, arguments):
    descriptor_path = pathlib.Path(config.get("accessDescriptorPath", ""))
    if not descriptor_path.is_absolute():
        raise HookError("LOCAL_PROFILE_UNAVAILABLE")
    descriptor = json.loads(read_small(descriptor_path, 4096).decode("utf-8"))
    if descriptor.get("version") != 1 or descriptor.get("enabled") is not True or descriptor.get("running") is not True:
        raise HookError("LOCAL_ACCESS_UNAVAILABLE")
    parsed = urllib.parse.urlsplit(descriptor.get("endpoint", ""))
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/tpap/v1":
        raise HookError("LOCAL_ENDPOINT_INVALID")
    token = read_small(descriptor_path.with_name("access-token"), 256).decode("ascii").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        raise HookError("LOCAL_CREDENTIAL_UNAVAILABLE")
    url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/tpap/v1/mcp", "", ""))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    counter = 0
    def rpc(method, params, notification=False):
        nonlocal counter
        counter += 1
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            body["id"] = counter
        request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        with opener.open(request, timeout=3) as response:
            data = response.read(LIMIT + 1)
            session = response.headers.get("mcp-session-id")
            if session:
                if not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", session):
                    raise HookError("LOCAL_SESSION_INVALID")
                headers["Mcp-Session-Id"] = session
            if len(data) > LIMIT:
                raise HookError("LOCAL_RESPONSE_LIMIT")
        if notification:
            return None
        reply = json.loads(data.decode("utf-8"))
        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0" or reply.get("id") != counter or "error" in reply or not isinstance(reply.get("result"), dict):
            raise HookError("LOCAL_PROTOCOL_INVALID")
        return reply["result"]
    rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "crux-provider-hook", "version": "1"}})
    headers["MCP-Protocol-Version"] = PROTOCOL
    rpc("notifications/initialized", {}, True)
    result = rpc("tools/call", {"name": "team_editor_hook_context", "arguments": arguments})
    content = result.get("structuredContent")
    if not isinstance(content, dict):
        raise HookError("LOCAL_CONTEXT_INVALID")
    if result.get("isError") is True or content.get("status") != "ready":
        code = content.get("code")
        raise HookError(code if isinstance(code, str) and re.fullmatch(r"SESSION_[A-Z_]{1,64}", code) else "LOCAL_CONTEXT_UNAVAILABLE")
    if content.get("provider") != arguments["provider"] or content.get("nativeSessionId") != arguments["nativeSessionId"] or task_key(content.get("task")) not in [task_key(task) for task in config["tasks"]]:
        raise HookError("SESSION_TASK_MISMATCH")
    context = content.get("additionalContext")
    if not isinstance(context, str) or not context.strip() or len(context) > 8192:
        raise HookError("LOCAL_CONTEXT_LIMIT")
    return context

def run():
    global current_event
    if len(sys.argv) != 3 or sys.argv[1] not in ("claude", "codex"):
        raise HookError("PROVIDER_INVALID")
    provider = sys.argv[1]
    allowed = ("SessionStart", "UserPromptSubmit", "PreToolUse") if provider == "claude" else ("UserPromptSubmit", "PreToolUse", "SubagentStart")
    if sys.argv[2] not in allowed:
        raise HookError("EVENT_UNSUPPORTED")
    current_event = sys.argv[2]
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise HookError("EVENT_LIMIT")
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise HookError("EVENT_INVALID")
    event = data.get("hook_event_name")
    if event != current_event:
        raise HookError("EVENT_MISMATCH")
    session = data.get("session_id")
    if not isinstance(session, str) or not session or session != session.strip() or len(session) > 512 or re.search(r"[\x00-\x1f\x7f]", session):
        raise HookError("SESSION_IDENTITY_REQUIRED")
    arguments = {"provider": provider, "nativeSessionId": session, "event": event}
    updated = None
    if event in ("PreToolUse", "SubagentStart"):
        if event == "SubagentStart":
            agent = data.get("agent_type")
        else:
            expected_tools = ("Task", "Agent") if provider == "claude" else ("spawn_agent", "Agent")
            if data.get("tool_name") not in expected_tools or not isinstance(data.get("tool_input"), dict):
                raise HookError("TOOL_EVENT_INVALID")
            tool_input = data["tool_input"]
            agent = tool_input.get("subagent_type") if provider == "claude" else tool_input.get("agent_type")
        role = ROLES.get(agent) if isinstance(agent, str) else None
        if not role:
            if event == "PreToolUse":
                return 0
            raise HookError("ROLE_UNAVAILABLE")
        if provider == "claude":
            prompt = tool_input.get("prompt")
            if not isinstance(prompt, str):
                raise HookError("PROMPT_INVALID")
            if role == "check" and "[finish]" in prompt.lower():
                role = "finish"
            updated = dict(tool_input)
        arguments["role"] = role
    config = json.loads(read_small(pathlib.Path(__file__).with_name("connector.json"), LIMIT).decode("utf-8"))
    if config.get("version") != 1 or not isinstance(config.get("tasks"), list) or not 1 <= len(config["tasks"]) <= 64:
        raise HookError("LOCAL_CONFIGURATION_INVALID")
    try:
        context = invoke(config, arguments)
    except HookError as error:
        if str(error) == "SESSION_UNBOUND" and event in ("SessionStart", "UserPromptSubmit"):
            # No task/resource fallback. The model can now explicitly claim/capture/bind.
            context = "Crux session is unbound. Native provider/session: " + json.dumps({"provider": provider, "nativeSessionId": session}, ensure_ascii=False) + ". Select the explicit team connection and complete task identity through MCP, claim and capture the reviewed execution input, then call team_editor_session_bind with those exact pins and expectedRevision=0. No task resources have been admitted. Do not infer a task from cwd or a current-task file."
            emit(event, context)
            return 0
        raise
    if updated is not None:
        updated["prompt"] = context + "\n\n" + updated["prompt"]
    emit(event, context, updated)
    return 0

try:
    sys.exit(run())
except Exception as error:
    code = str(error) if isinstance(error, HookError) else "LOCAL_HOOK_UNAVAILABLE"
    # Native Codex requires an explicit pre-tool denial; exit 2 alone may
    # still admit spawn_agent. Successful hooks never grant permission.
    reason = "Crux workflow context unavailable: " + code + ". Rebind the explicit session after checking current task authority."
    if sys.argv[1:2] == ["codex"] and current_event == "PreToolUse":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}, ensure_ascii=False))
        sys.exit(0)
    # Provider errors and credentials are never echoed.
    print(reason, file=sys.stderr)
    sys.exit(2)
`
