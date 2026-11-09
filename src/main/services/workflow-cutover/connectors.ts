import { z } from 'zod'
import { NATIVE_PROVIDER_HOOK_PATH, NATIVE_PROVIDER_HOOK_PYTHON, nativeProviderSettings, isNativeProviderHookSource, requiredProviderSources, convertNativeProviderSettings, validNativeAccessDescriptor } from './provider-hooks'
import { teamTaskIdentity, teamTaskRefSchema, type TeamTaskRef } from '../../../shared/team-task-execution'
import { fileDigest, validateRelativePath } from './files'
import { CUTOVER_FILE_LIMITS, CutoverInstallerError, type CutoverFileChange } from './types'

export const NATIVE_WORKFLOW_CONNECTOR_VERSION = 1 as const
export const NATIVE_WORKFLOW_CONNECTOR_PATHS = Object.freeze({ guard: '.crux/workflow/v1/guard.py', config: '.crux/workflow/v1/connector.json', skill: '.crux/workflow/v1/SKILL.md', hooks: '.crux/workflow/v1/hooks.json', providerHook: NATIVE_PROVIDER_HOOK_PATH })
export interface CutoverConnectorOriginal { relativePath: string; bytes: Uint8Array | null }
export interface CutoverDispatchSurface {
  sourceId: string
  relativePath: string
  digest: string
  kind: 'workflow' | 'root-instruction' | 'command' | 'skill' | 'agent' | 'hook' | 'embedded-prompt' | 'script'
  /** Inventory explicitly scopes this source to the managed span; outside dispatch must be separate sources. */
  managedBlockOnly?: boolean
}
export interface CutoverReviewedRemoval { sourceId: string; originalBytes: Uint8Array }
export interface NativeWorkflowConnectorRequest {
  operationId: string
  tasks: readonly TeamTaskRef[]
  /** Complete bounded C/source inventory; selected imported server materials are insufficient. */
  sourceInventory: readonly CutoverDispatchSurface[]
  inventoryComplete: boolean
  originals: readonly CutoverConnectorOriginal[]
  instructionFiles: readonly ('AGENTS.md' | 'CLAUDE.md')[]
  /** Explicitly reviewed obsolete command/Skill/Agent entrypoints, never arbitrary project scripts. */
  reviewedRemovals?: readonly CutoverReviewedRemoval[]
  /** Exact native-recognized provider registrations/scripts with explicit review. */
  reviewedProviderHooks?: readonly CutoverReviewedRemoval[]
  /** Supplied by the native profile owner, never by a proposal caller. Contains no credential. */
  accessDescriptorPath?: string
  /** Exact known baseline bytes and explicit retirement/rewrite review; never a caller template catalogue. */
  reviewedBaseline?: { version: 1; files: readonly CutoverReviewedRemoval[] }
}
export interface NativeWorkflowConnectorPlan {
  version: typeof NATIVE_WORKFLOW_CONNECTOR_VERSION
  files: CutoverFileChange[]
  coveredSourceIds: string[]
  blockers: Array<{ sourceId: string | null; code: string; message: string }>
  capabilities: readonly string[]
  integrationRequirements: readonly string[]
  nativeCompatibility: 'unverified'
}
/** Exact reviewed repository baseline and @mindfoldhq/trellis 0.6.17 template bytes, LF/CRLF only.
 * Recognition authorizes a reviewed retirement, not provider behavior equivalence. */
const BASELINE_DIGESTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ".trellis/scripts/__init__.py": Object.freeze(["1242be5b972094c2e141aecbe81a4efd478f6534e3d5e28306374e6a18fcf46c","4371cb0cdd6d3efac5822d54a230f5d4fe7b6d45785aa3d73a9d0d4664f15c46"]),
  ".trellis/scripts/add_session.py": Object.freeze(["281b651b4c00369f603acb36ddf499512084e8b8952ad064e22d2ea1b9eb4652","bf426a5325227513050184a81dbb23f5f49528339ec3c356e53d932f0b57d2d6","e2f46af58a6c8f651d45347467182bf622f0fd8c6cac9e0f36744393055ebb96","f61a452ec5f7eece8d7e0f0dd56ce5851166cbc83ca4822e30acbb36eeb5896f"]),
  ".trellis/scripts/common/__init__.py": Object.freeze(["04cfb43cb26744328766340c6edbe8fc5746e47b71dd9245f0f771399b1fcd96","f258cd873681dc5a4d71db0dd71d10fd78656de55bec96418d6702503c16e87d"]),
  ".trellis/scripts/common/active_task.py": Object.freeze(["63d5bc308ac4939fde8923775ced2a76125a4dbbd868b23b6c2857bfbace3bbf","fe42584224a7f1281832338e4164aa6330c191eb55fd152948acf8f0e731aae1"]),
  ".trellis/scripts/common/cli_adapter.py": Object.freeze(["5d6bd9d6f5c631e7e792db7dd343351317f9643bc87b73a9a98abd51cefb4307","c0aad912322f5f11a87c09fa1e84ab4b76e62f3904f860477e521a7f71ea691c"]),
  ".trellis/scripts/common/config.py": Object.freeze(["9308097c4f236f88ebb205efa248417bbc06696a1182c4f5b22978fef322cf2d","9a042d6f0e25a33a567510760e87c1e389af14a41faf1daeb1190a00f3df7f5e"]),
  ".trellis/scripts/common/developer.py": Object.freeze(["2b7b700076a856d633d268217a1a85de218db85c205c4be264c48c93a12f359a","a0f61bb58063e2f4cb357bcb2c22fd5a6f1241286398beaa7130b2a8994a4afa","be6c0a37e80684441607f39bab0e8acbbd1e18da5f0849cf7e49beca309adc57","f0e217f24fbc602eb4f93b5ff42c11d4a0c3986dc8c6d20dfbdbe5404f7ef49f"]),
  ".trellis/scripts/common/git.py": Object.freeze(["5605b71662e524b47632030d9db9245121a5cba85b5521eeb524ed464d840ff5","b89c74c3a6e4ea816298f1c7c8dbe4a97db6e020d0e0523a8ed8b79503fd2390"]),
  ".trellis/scripts/common/git_context.py": Object.freeze(["2d38cf945bc3b929b34c854e869945057a32054055ccc00e4f538e679070868d","fa30ced454f1a91ffc9f8b2abeb32225e3447cbdc90bad783797374eba07265d"]),
  ".trellis/scripts/common/io.py": Object.freeze(["00ad166d49fde1a6cfbcc397cc21698127cb0df4a896185e93a61636e53d1180","2025040d8a866aad62384c5c91d35cdac937efc783716d14bf54c7139b9d3151","5dd8b9e297125ff58543a9bd4790c03ae1aca1d37b9e2ca60c4ffb47601c1cbb","67753940b5b0e55f21ed005f2d82f9d214a069ee952b2c1b7e8722d340d592a6"]),
  ".trellis/scripts/common/log.py": Object.freeze(["471df6895cfac80f995edebbf9974f6b7440634b7a688f28b8331c868bc0f3cf","6bc674c028d51a3f0bcce11dc19b25cf905398688ca12416fe5adc6cc75b1041"]),
  ".trellis/scripts/common/packages_context.py": Object.freeze(["4eb92e4f5ba229b1162ea83326b3968f719f318166e30d120ebc1cf32f39ea2f","efe158d7c99c2268851d0216fbb08de22836e418a8dbeb73575b8cc249eed7b7"]),
  ".trellis/scripts/common/paths.py": Object.freeze(["b122956b9babb6142fb35cec9374e6c8f89a9a8ad35c4f4e6978ce85e22d2785","d8586d4d3f9bb2dd46b7f11b0f038b5340d283f41b6fa2c76bb8235c13bbb0b7"]),
  ".trellis/scripts/common/safe_commit.py": Object.freeze(["262ad740552279fe6ec6a2a9865b2965ce2448577cf973a4d702dfe2f5f91f04","a2ba3eb3ee0d6a0ee2311ad584377c14642de6b4812c814937d9bc0803e7ecf4"]),
  ".trellis/scripts/common/session_context.py": Object.freeze(["3379ef1766e4e5ca77cbb7c040dbba3883fcca2548580299e3b38dbf22f4f7d5","5b9ca62172eaa8cef21c6c45eda75c061a619ce7581886b7f9e55d6e02c6adb7","905dd44c6b393f1a3dfb76495817b37cbc1ffca7f5b5f0c527070557f2ab6ce8","a6550aa11cb543f7195f66a1ab1f09572d1cf94be5505cfb23edd928ff2ba836"]),
  ".trellis/scripts/common/task_authority.py": Object.freeze(["628f0592c34a7a6a9516a509098a725b924a8be781b5c4bfa25b5e664e7ae8c8","9bb9ad9d00f6c4ee3fe1bc276c92aeefbc900d1ba48af1c6a0bf9a5b9be79ba0"]),
  ".trellis/scripts/common/task_context.py": Object.freeze(["245e654713e6030f9e7b5cee474efc06343ecc0d7f66f6455098874239355ce3","405d67a1426dfa91b2a2fd58ec48735e8729f5e5bfeb05e3ceea0094f4c90735","9a21e75ea952b62496b474de2881cd8e0d3b133695a61ccdfb0cad12b131c348","9a2c9f81a2c57b0bb6bb15065a44970a33a18f55411a32dc6a7634b83ad46e56"]),
  ".trellis/scripts/common/task_queue.py": Object.freeze(["0be61f713462b1fe4574927c82fc4704e678afe72dcb9813543aedf2f9e9e0c5","68a047c88a281c6933b2c039abaebba141f3a97245567f0b79fddaaffca9730e"]),
  ".trellis/scripts/common/task_store.py": Object.freeze(["0032b01bf1f42b1bdee62117bcd7511451951ba610d0e1d3bd3324342a5e3c59","adc2e421b0406ad697905ed1879d4f62f849753cb046efebefff0e00df3c1119","dccee32e23dd3b2f3352eb5cd05e5ac6dfdd811cba3b95ac423d3742df0525d4","e0c08cb52789233d2774275c4632f68b1811ade25c2a211b56ef5fc6095e1605"]),
  ".trellis/scripts/common/task_utils.py": Object.freeze(["1643d9ebe833a7d2a72eb15afcc383f2f7f8e934cd59da7a814eb74b5b657442","35f544317a95e98d05fe089794071482175739e8c1f3b3b0228dae48602ffe90","7a386b676843d95b82cd5880460e8afa7ad5d829a75f8ba803d9d0b4259e4b3a","8a99113f8595d200e7e9e834b27579f4355df4604ed9347b4c76543acbe93865"]),
  ".trellis/scripts/common/tasks.py": Object.freeze(["87aca6b73ec4524450cfff8e2ae561b1f2e53bd62a185f036a7a2d484d90c8a2","cf25af8c0118fa9d98ef4ba378f72a572926095dcb1286719297c5242e3ca7f4"]),
  ".trellis/scripts/common/trellis_config.py": Object.freeze(["0951732b07716a3b89efde5a8f97037969daf1de36e323c49796df357512cedf","f1fc705ec463b0b9c163672dc9e50f10d29da967775a1900429205f7c4fcb51c"]),
  ".trellis/scripts/common/types.py": Object.freeze(["9962081cc2608fb9d1deb32c6880e336f62cdca6b338e7ae813304701e155ee9","ba596ac3ee9f56a4411d6be507a9bf6ab4063828b7678efa910e243e23fcd182"]),
  ".trellis/scripts/common/workflow_phase.py": Object.freeze(["146b69c1ec0e628aeb720d3e34d8333f16050225037fe4233da9bbc4d4ac99c1","5a6e11281fd8b97e8a6b4f4268d881f3b7ec0c2dfecd29cbe6b7ac7d159c636c"]),
  ".trellis/scripts/get_context.py": Object.freeze(["9d2cc3fa1ff5b42eb03758a560af657567b026452c72803858719a7dbef35838","a41e97de2a456be978f39032870fa20ddaf029e4f8a9e2506708ecdfc2cb6e4a","af3ea7cd563a453227cf2cb4ab04d667390046b7febfac2217348d0892781f4b","ca5bf9e90bdb1d75d3de182b95f820f9d108ab28793d29097b24fd71315adcf5"]),
  ".trellis/scripts/get_developer.py": Object.freeze(["748b6102c30647fe2c93caeef632239c1414f066a3cd38f1aa5d7ba7ff16c5eb","84c27076323c3e0f2c9c8ed16e8aa865e225d902a187c37e20ee1a46e7142d8f"]),
  ".trellis/scripts/hooks/linear_sync.py": Object.freeze(["2e0d9909665777d352454ec27904de8accc1378c786969f01c351fc4cbd805c6","a93a8d26de0d6e41f3319c40decb8f2c896d25dcbcc774fbd137e7033b38f877","e09cc4ce4699aada908808718698f33f705a3edf55c4dcf8f777ad892f80ca79","f3dd02412bc95b9ef6a81eb5fec37bd880245d1d19a736ffeea482405eace063"]),
  ".trellis/scripts/init_developer.py": Object.freeze(["0943f1c240993649ab89b91a2c5b379e84daa8c53b35f0490774bff05a552873","2a2a338b50c44d1ae42bd0520de09e0dc1bf186bc955d93f8abf65df90233993","55e57e4c1b4ef15bb84614868b19886c445b9a438ab932cfd67d947141e124a2","f9e6c0d882406e81c8cd6b1c5abb204b0befc0069ff89cf650cd536a80f8c60e"]),
  ".trellis/scripts/task.py": Object.freeze(["1cb2973c2d92c235390af497a04e9ed9acc6fb58551768dfd3ede10fc5b0b1d1","b415e0a2dbc9e8cba1ada0c7997999aaaaea0eec96d3419db640830e88e84cfe","b82ffac8af2f14ab483c409f91481181a61619eb2ef4d0c6a04506c9d1b2426a","ca0a7c161665dc98ee55818fceb5df462c731cc8cef96171803f098aa8ed5a94"]),
  ".trellis/workflow.md": Object.freeze(["31e86b9b0a188efbdbcc4c82810bb5addf98bc5b2221272c8770e5cdfdb6fad2","6d5a695867fa77fb061f628d8b70384dea289521bcb1d502f2629fa86306455e","eb4508a4f6792f3d53705c1f9e7d21807dabd774543bd7b01f56372a704f6ad0","f71793ae568480eb30d80914af1924fdd7b356fc90f0be8280a1cc317021cfd8"]),
})
export function getNativeBaselineConversion(relativePath: string, originalBytes: Uint8Array): 'platform-workflow-v1' | 'removed-dispatch-v1' | null {
  if (originalBytes.length > CUTOVER_FILE_LIMITS.fileBytes || !Object.hasOwn(BASELINE_DIGESTS, relativePath) || !BASELINE_DIGESTS[relativePath].includes(fileDigest(originalBytes))) return null
  return relativePath === '.trellis/workflow.md' ? 'platform-workflow-v1' : 'removed-dispatch-v1'
}

const MANAGED_START = '<!-- TRELLIS:START -->'
const MANAGED_END = '<!-- TRELLIS:END -->'
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Only the one verified managed span is replaced; bytes outside it retain their exact encoding/newlines. */
export function replaceTrellisManagedBlock(original: Uint8Array, nativeBlock: string): Buffer {
  if (original.length > CUTOVER_FILE_LIMITS.fileBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Root instructions exceed the bounded conversion limit')
  const text = textDecoder.decode(original)
  if (text.split(MANAGED_START).length !== 2 || text.split(MANAGED_END).length !== 2 || nativeBlock.includes(MANAGED_START) || nativeBlock.includes(MANAGED_END)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Root instructions have missing, duplicate or ambiguous managed markers')
  const start = text.indexOf(MANAGED_START), end = text.indexOf(MANAGED_END)
  if (end <= start || (start > 0 && text[start - 1] !== '\n' && !(start === 1 && text.charCodeAt(0) === 0xfeff)) || (text.slice(start + MANAGED_START.length, start + MANAGED_START.length + 2) !== '\r\n' && text[start + MANAGED_START.length] !== '\n') || (end > 0 && text[end - 1] !== '\n') || !/^(?:\r?\n|$)/.test(text.slice(end + MANAGED_END.length))) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Managed markers must be unambiguous standalone lines')
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return Buffer.from(text.slice(0, start) + MANAGED_START + newline + nativeBlock.replace(/\r?\n/g, newline) + newline + MANAGED_END + text.slice(end + MANAGED_END.length), 'utf8')
}

const NATIVE_INSTRUCTIONS = `# Crux native workflow connector v1

Read .crux/workflow/v1/SKILL.md before working on an activated imported task.
Use the current desktop profile's protected MCP connection and the fixed task identities in .crux/workflow/v1/connector.json.
Native task preparation and team_task_claim enforce fresh cutover admission at their platform boundaries. Missing tooling, unavailable service, drift or unresolved required conversion blocks fresh preparation and claims. Use team_cutover_check only for read-only cutover diagnostics; its result does not grant writer admission or enforce provider events.
Before automatic provider context is available, explicitly select the team connection/task, claim and capture its reviewed input, then call team_editor_session_bind with the native provider/session identity, original execution/input pins and explicit root/role nodes. A missing binding returns setup guidance only. A task switch requires the current local binding revision. Never infer a task from cwd or a current-task file.
Read team_task_context and team_task_execution_read using the fixed portable task identity. Claim through team_task_claim, then use team_task_capture_input to retain the original fixed selections. Read team_task_execution_input with the returned executionId, and optional selectionId from the original captured input. Retain original command UUIDs, and reconcile uncertain writes through team_task_command_reconcile.
Report progress and confirmed artifacts through team_task_progress and team_task_save_artifact. Submit delivery and checkpoint with team_task_seal_delivery and team_task_checkpoint; finalize with team_task_complete. Business transitions use team_task_transition and its existing server rules.
Source-required context injection, stop checks, tool interception and custom Hook, Skill, Agent or business behavior require supported native registration or an explicit equivalent platform owner. Unresolved required behavior blocks conversion. Do not invoke legacy task commands or infer task identity from a directory or display name.
`
const NATIVE_BASELINE_WORKFLOW = `# Crux native task workflow v1

Read .crux/workflow/v1/SKILL.md and select the original portable task from .crux/workflow/v1/connector.json.
The whole affected workcopy shares one installation and admission boundary across every mapped task.

Native task preparation and team_task_claim enforce fresh cutover admission at their platform boundaries. team_cutover_check provides read-only diagnostics and does not grant writer admission. Read team_task_context and team_task_execution_read, then claim through team_task_claim with the current authorized handler. Capture the reviewed fixed input using team_task_capture_input; read team_task_execution_input with its returned executionId and original selectionId when applicable.

Keep command UUIDs and reconcile uncertain writes through team_task_command_reconcile. Report phase progress through team_task_progress, store confirmed output with team_task_save_artifact, seal delivery through team_task_seal_delivery and record a checkpoint through team_task_checkpoint before team_task_complete. Business transitions use team_task_transition and the existing platform authorization and configured business mappings.

Keep source task, workspace, spec, journal and private records for history. Task metadata, adopted resources and new execution facts use the current platform interfaces. The retired local task/bootstrap/context/journal scripts are not entrypoints for migrated tasks; no CLI aliases are installed. Source-required provider context injection, stop checks, tool interception and custom behavior require supported native registration or an explicit equivalent platform owner; unresolved required behavior blocks conversion. A generated probe descriptor does not prove provider registration or event execution.
`

/** Installer guard for the only permitted changes to legacy baseline files. */
export function isNativeBaselineFileChange(file: CutoverFileChange): boolean {
  if (!Object.hasOwn(BASELINE_DIGESTS, file.relativePath) || !BASELINE_DIGESTS[file.relativePath].includes(file.expectedBeforeDigest ?? '')) return false
  if (file.relativePath !== '.trellis/workflow.md') return file.afterBytes === null && file.afterDigest === null
  return file.afterBytes !== null && Buffer.from(file.afterBytes).equals(Buffer.from(NATIVE_BASELINE_WORKFLOW)) && file.afterDigest === fileDigest(NATIVE_BASELINE_WORKFLOW)
}

const NATIVE_SKILL = `---
name: crux-native-workflow-v1
description: Work on a fixed activated Crux team task through the current protected desktop MCP profile.
---

${NATIVE_INSTRUCTIONS}
The Python guard calls team_cutover_check for read-only cutover diagnostics using the fixed portable configuration. A successful probe does not admit preparation, claim a writer, enforce provider events, finish an execution or confirm a business effect. Fresh preparation and claim admission remain owned by their platform gates.
Retain the complete original command body and UUID before each mutation; an uncertain response must reconcile the same command. Cleanup of an old native execution stays with its original owner.
`

/** Fixed read-only MCP client; no shell, arbitrary tool selector, team token, redirects or network during installation. */
export const NATIVE_WORKFLOW_GUARD_PYTHON = `import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request

LIMIT = 1048576
PROTOCOL = "2025-11-25"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("redirect refused")

def run():
    config_path = pathlib.Path(__file__).with_name("connector.json")
    if config_path.is_symlink() or not config_path.is_file():
        raise RuntimeError("configuration unavailable")
    with config_path.open("rb") as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise RuntimeError("configuration limit")
    config = json.loads(raw.decode("utf-8"))
    if config.get("version") != 1 or not isinstance(config.get("tasks"), list) or not 1 <= len(config["tasks"]) <= 64:
        raise RuntimeError("configuration invalid")
    url = os.environ.get("CRUX_WORKFLOW_MCP_URL", "")
    token = os.environ.get("CRUX_WORKFLOW_MCP_TOKEN", "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1") or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/tpap/v1/mcp" or not token or "\\r" in token or "\\n" in token:
        raise RuntimeError("protected loopback profile unavailable")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    session_id = None
    request_id = 0
    def rpc(method, params, notification=False):
        nonlocal session_id, request_id
        request_id += 1
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            payload["id"] = request_id
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        request = urllib.request.Request(url, data=json.dumps(payload, separators=(",", ":")).encode("utf-8"), headers=headers, method="POST")
        with opener.open(request, timeout=5) as response:
            body = response.read(LIMIT + 1)
            if len(body) > LIMIT:
                raise RuntimeError("response limit")
            candidate_session = response.headers.get("Mcp-Session-Id")
            if candidate_session:
                if session_id and session_id != candidate_session:
                    raise RuntimeError("MCP session changed")
                session_id = candidate_session
            if notification and response.status in (200, 202, 204):
                return None
            if response.headers.get_content_type() != "application/json":
                raise RuntimeError("JSON MCP response required")
        result = json.loads(body.decode("utf-8"))
        if result.get("jsonrpc") != "2.0" or result.get("id") != request_id or "error" in result:
            raise RuntimeError("MCP request rejected")
        return result["result"]
    initialized = rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "crux-workflow-guard", "version": "1.0.0"}})
    if initialized.get("protocolVersion") != PROTOCOL:
        raise RuntimeError("MCP protocol mismatch")
    rpc("notifications/initialized", {}, notification=True)
    for task in config["tasks"]:
        args = {key: task[key] for key in ("taskId", "spaceId", "taskCreatedAt")}
        result = rpc("tools/call", {"name": "team_cutover_check", "arguments": args})
        if result.get("isError"):
            raise RuntimeError("cutover admission rejected")
        value = result.get("structuredContent")
        if value is None:
            content = result.get("content", [])
            if len(content) != 1 or content[0].get("type") != "text":
                raise RuntimeError("cutover result unavailable")
            value = json.loads(content[0]["text"])
        binding = value.get("binding", {})
        if binding.get("instanceId") != task["instanceId"] or binding.get("projectId") != task["projectId"]:
            raise RuntimeError("desktop task binding changed")
        admission = value.get("admission", {})
        if admission.get("admitted") is not True or admission.get("operationId") != config["operationId"] or admission.get("task") != task:
            raise RuntimeError("original cutover is not admitted")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(run())
    except Exception:
        # Never print response bodies, tokens, environment values or exception representations.
        sys.stderr.write("Crux workflow admission blocked; inspect the original operation in the desktop.\\n")
        sys.exit(2)
`

export function buildNativeWorkflowConnector(request: NativeWorkflowConnectorRequest): NativeWorkflowConnectorPlan {
  z.string().uuid().parse(request.operationId)
  if (new Set(request.instructionFiles).size !== request.instructionFiles.length) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Root instruction entrypoints must be unique')
  if (request.tasks.length < 1 || request.tasks.length > 64 || request.sourceInventory.length > 2500 || request.originals.length > CUTOVER_FILE_LIMITS.files || request.instructionFiles.length > 2) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Native connector input exceeds its bounded inventory limits')
  const tasks = request.tasks.map(task => teamTaskRefSchema.parse(task)), taskIds = tasks.map(teamTaskIdentity)
  if (new Set(taskIds).size !== taskIds.length || tasks.some(task => task.instanceId !== tasks[0].instanceId || task.projectId !== tasks[0].projectId)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'The whole-workcopy task set must have distinct fixed identities in one desktop project')
  const originals = new Map<string, Buffer | null>()
  let originalBytes = 0
  for (const original of request.originals) {
    validateRelativePath(original.relativePath)
    if (originals.has(original.relativePath.toLowerCase())) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Duplicate original connector path')
    const bytes = original.bytes === null ? null : Buffer.from(original.bytes)
    if (bytes && bytes.length > CUTOVER_FILE_LIMITS.fileBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Original connector bytes exceed the file budget')
    originalBytes += bytes?.length ?? 0
    if (originalBytes > CUTOVER_FILE_LIMITS.totalBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Original connector bytes exceed the aggregate budget')
    originals.set(original.relativePath.toLowerCase(), bytes)
  }
  const result: NativeWorkflowConnectorPlan = {
    version: NATIVE_WORKFLOW_CONNECTOR_VERSION, files: [], coveredSourceIds: [], blockers: [], nativeCompatibility: 'unverified',
    capabilities: ['fixed-portable-task-identities', 'managed-root-instruction-span', 'read-only-mcp-admission-probe', 'explicit-reviewed-command-skill-agent-removal', 'known-baseline-workflow-replacement', 'known-baseline-script-retirement', 'reviewed-claude-codex-context-hooks'],
    integrationRequirements: ['Read-only guard diagnostics use CRUX_WORKFLOW_MCP_URL/CRUX_WORKFLOW_MCP_TOKEN. Converted provider Hooks discover the native-fixed profile endpoint and sibling token locally; no credential is stored in the workcopy.', 'team_cutover_check reports the current whole-workcopy binding and admission {admitted, operationId, task} for read-only diagnostics; its result does not grant writer admission.', 'Native task preparation and team_task_claim enforce fresh cutover admission at their platform boundaries. Source-required context injection, stop checks, tool interception and custom behavior need supported native registration or an explicit equivalent platform owner; unresolved required behavior blocks conversion. Generated hooks.json describes a read-only probe and does not prove provider registration or event execution.', 'Existing protected Jira and database delivery operations retain their native owners and receipts; custom Hook/business prompt conversion remains unavailable.', 'Reviewed baseline retirement removes old task/bootstrap/context/journal and Linear CLI scripts; it does not assert provider automation equivalence or delete historical task/workspace/spec records.']
  }
  if (!request.inventoryComplete) result.blockers.push({ sourceId: null, code: 'CUTOVER_SOURCE_INVENTORY_INCOMPLETE', message: 'Full dispatch-surface inventory is required before activation' })
  const add = (path: string, after: Buffer | null): void => {
    if (!originals.has(path.toLowerCase())) { result.blockers.push({ sourceId: null, code: 'CUTOVER_ORIGINAL_REQUIRED', message: `Original bytes or verified absence required for ${path}` }); return }
    const before = originals.get(path.toLowerCase()) ?? null, expectedBeforeDigest = before === null ? null : fileDigest(before), afterDigest = after === null ? null : fileDigest(after)
    if (expectedBeforeDigest !== afterDigest) result.files.push({ relativePath: path, expectedBeforeDigest, afterDigest, afterBytes: after })
  }
  const providerReviews = new Map<string, CutoverReviewedRemoval>()
  for (const review of request.reviewedProviderHooks ?? []) {
    const source = request.sourceInventory.find(item => item.sourceId === review.sourceId)
    const before = source && originals.get(source.relativePath.toLowerCase())
    if (!source || source.kind !== 'hook' || providerReviews.has(source.relativePath) || !before || fileDigest(before) !== source.digest || !Buffer.from(review.originalBytes).equals(before) || !nativeProviderSettings(source.relativePath, before) && !isNativeProviderHookSource(source.relativePath, before)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Provider conversion requires an explicitly reviewed known source and original bytes')
    providerReviews.set(source.relativePath, review)
  }
  const providerCovered = new Set<string>()
  const registrations = new Set<string>()
  for (const [path, review] of providerReviews) {
    const settings = nativeProviderSettings(path, review.originalBytes)
    if (!settings) continue
    if (!request.accessDescriptorPath || !validNativeAccessDescriptor(request.accessDescriptorPath)) { result.blockers.push({ sourceId: review.sourceId, code: 'CUTOVER_NATIVE_PROFILE_REQUIRED', message: 'Provider Hooks require the current native profile discovery path' }); continue }
    const required = requiredProviderSources(settings.provider)
    if (registrations.has(settings.provider) || required.some(target => !providerReviews.has(target))) { result.blockers.push({ sourceId: review.sourceId, code: 'CUTOVER_PROVIDER_SOURCES_REQUIRED', message: 'Provider registration needs one unambiguous registration and every reviewed standard Hook source' }); continue }
    const converted = convertNativeProviderSettings(path, review.originalBytes)
    if (!converted) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Reviewed provider registration could not be converted')
    registrations.add(settings.provider); add(path, converted); providerCovered.add(review.sourceId)
    for (const target of required) {
      const script = providerReviews.get(target)
      if (!script) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Reviewed provider source disappeared')
      add(target, null); providerCovered.add(script.sourceId)
    }
  }
  if (registrations.size) add(NATIVE_WORKFLOW_CONNECTOR_PATHS.providerHook, Buffer.from(NATIVE_PROVIDER_HOOK_PYTHON))
  const config = Buffer.from(JSON.stringify({ version: 1, operationId: request.operationId, tasks, ...(registrations.size ? { accessDescriptorPath: request.accessDescriptorPath } : {}) }, null, 2) + '\n')
  add(NATIVE_WORKFLOW_CONNECTOR_PATHS.config, config)
  add(NATIVE_WORKFLOW_CONNECTOR_PATHS.guard, Buffer.from(NATIVE_WORKFLOW_GUARD_PYTHON))
  add(NATIVE_WORKFLOW_CONNECTOR_PATHS.skill, Buffer.from(NATIVE_SKILL))
  add(NATIVE_WORKFLOW_CONNECTOR_PATHS.hooks, Buffer.from(JSON.stringify({ version: 1, kind: 'native-admission-probe', python: NATIVE_WORKFLOW_CONNECTOR_PATHS.guard, config: NATIVE_WORKFLOW_CONNECTOR_PATHS.config, tool: 'team_cutover_check', enforcedBy: 'none-read-only-probe' }, null, 2) + '\n'))
  const coveredPaths = new Set<string>()
  for (const path of request.instructionFiles) {
    if (path !== 'AGENTS.md' && path !== 'CLAUDE.md') throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Only fixed root instruction files support managed-span conversion')
    const original = originals.get(path.toLowerCase())
    if (!originals.has(path.toLowerCase())) { result.blockers.push({ sourceId: null, code: 'CUTOVER_ORIGINAL_REQUIRED', message: `Verified root instruction bytes required for ${path}` }); continue }
    try {
      add(path, original === null ? Buffer.from(`${MANAGED_START}\n${NATIVE_INSTRUCTIONS}\n${MANAGED_END}\n`) : replaceTrellisManagedBlock(original ?? new Uint8Array(), NATIVE_INSTRUCTIONS))
      coveredPaths.add(path.toLowerCase())
    } catch { result.blockers.push({ sourceId: null, code: 'CUTOVER_MANAGED_SPAN_UNAVAILABLE', message: `Managed instruction markers are missing or ambiguous in ${path}` }) }
  }
  const sources = new Map<string, CutoverDispatchSurface>()
  for (const source of request.sourceInventory) {
    validateRelativePath(source.relativePath); z.string().regex(/^[a-f0-9]{64}$/).parse(source.digest)
    if (!source.sourceId || source.sourceId.length > 200 || sources.has(source.sourceId)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Dispatch sources require unique stable IDs')
    sources.set(source.sourceId, source)
  }
  const baseline = new Map<string, CutoverReviewedRemoval>()
  if (request.reviewedBaseline && (request.reviewedBaseline.version !== 1 || request.reviewedBaseline.files.length > CUTOVER_FILE_LIMITS.files)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Unsupported reviewed baseline version or size')
  for (const review of request.reviewedBaseline?.files ?? []) {
    const source = sources.get(review.sourceId)
    const before = source && originals.get(source.relativePath.toLowerCase())
    if (!source || baseline.has(review.sourceId) || !before || fileDigest(before) !== source.digest || !Buffer.from(review.originalBytes).equals(before) || !getNativeBaselineConversion(source.relativePath, before)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Reviewed baseline differs from a known fixed source and captured original')
    const expectedKind = source.relativePath === '.trellis/workflow.md' ? ['workflow', 'embedded-prompt'] : ['script']
    if (!expectedKind.includes(source.kind)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Reviewed baseline has a conflicting dispatch kind')
    baseline.set(review.sourceId, review)
  }
  const removals = new Map<string, CutoverReviewedRemoval>()
  for (const removal of request.reviewedRemovals ?? []) {
    const source = sources.get(removal.sourceId)
    if (!source || removals.has(removal.sourceId) || removal.originalBytes.length > CUTOVER_FILE_LIMITS.fileBytes || fileDigest(removal.originalBytes) !== source.digest || !['command', 'skill', 'agent'].includes(source.kind) || !/^\.(?:claude|codex|agents)\/(?:commands|skills|agents)\/[A-Za-z0-9_./-]+$/.test(source.relativePath)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Reviewed removal does not identify a supported obsolete dispatch entrypoint')
    const before = originals.get(source.relativePath.toLowerCase())
    if (!before || fileDigest(before) !== source.digest) throw new CutoverInstallerError('CUTOVER_FILE_CONFLICT', 'Reviewed source removal differs from captured original bytes')
    removals.set(removal.sourceId, removal)
  }
  for (const source of request.sourceInventory) {
    const before = originals.get(source.relativePath.toLowerCase())
    const isManaged = source.kind === 'root-instruction' && source.managedBlockOnly === true && coveredPaths.has(source.relativePath.toLowerCase()) && before && fileDigest(before) === source.digest
    if (isManaged || providerCovered.has(source.sourceId) || removals.has(source.sourceId) || baseline.has(source.sourceId)) {
      if (baseline.has(source.sourceId)) add(source.relativePath, source.relativePath === '.trellis/workflow.md' ? Buffer.from(NATIVE_BASELINE_WORKFLOW) : null)
      else if (removals.has(source.sourceId)) add(source.relativePath, null)
      result.coveredSourceIds.push(source.sourceId)
    } else result.blockers.push({ sourceId: source.sourceId, code: 'CUTOVER_SOURCE_CONVERSION_UNAVAILABLE', message: `Dispatch source ${source.relativePath} requires a supported conversion of its actual entrypoint` })
  }
  if (!request.instructionFiles.length) result.blockers.push({ sourceId: null, code: 'CUTOVER_NATIVE_ENTRYPOINT_REQUIRED', message: 'A verified root instruction entrypoint is required' })
  if (new Set(result.files.map(file => file.relativePath.toLowerCase())).size !== result.files.length) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'One dispatch path has conflicting conversion changes')
  return result
}
