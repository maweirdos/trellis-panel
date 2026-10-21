/** Official Trellis session-pointer binding; no task lifecycle status is rewritten. */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { taskMaterialPath } from '../acp/materials'

export type NativeTaskBinding = {
  status: 'bound' | 'unavailable' | 'conflict'; contextKey: string | null;
  taskPath: string | null; hookInjection: 'unobserved'; reason: string
}
export type NativeTaskBindingInput = {
  projectRoot: string; taskDir: string; platform: 'codex' | 'claude' | 'dsh';
  nativeSessionId: string | undefined; pythonExecutable?: string; allowBinding: boolean
}

const OFFICIAL_BIND = `import json,os,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'.trellis'/'scripts'))
from common.active_task import resolve_context_key,resolve_active_task,set_active_task
platform,native,task,allow=sys.argv[2:]
data={'session_id':native}
key=resolve_context_key(data,platform,allow_environment_context=False)
active=resolve_active_task(root,data,platform,allow_environment_context=False)
target='.trellis/tasks/'+task
status='bound' if active.task_path==target and not active.stale else 'conflict' if active.task_path else 'unavailable'
if status=='unavailable' and allow=='yes' and key:
 os.environ['TRELLIS_CONTEXT_ID']=key
 result=set_active_task(target,root,data,platform)
 active=resolve_active_task(root,data,platform,allow_environment_context=False)
 status='bound' if result and active.task_path==target and not active.stale else 'unavailable'
print(json.dumps({'status':status,'contextKey':key,'taskPath':active.task_path}))`

export function bindNativeTrellisTask(input: NativeTaskBindingInput): Promise<NativeTaskBinding> {
  const unavailable = (reason: string): NativeTaskBinding => ({ status: 'unavailable', contextKey: null, taskPath: null, hookInjection: 'unobserved', reason })
  if (!isAbsolute(input.projectRoot) || !taskMaterialPath(input.projectRoot, input.taskDir, `.trellis/tasks/${input.taskDir}/task.json`)) return Promise.resolve(unavailable('The selected task is not a verified active Trellis task in this workspace'))
  if (!input.nativeSessionId || input.nativeSessionId.length > 1024) return Promise.resolve(unavailable('The engine did not expose a usable native vendor session identity; wire/app IDs are not substituted'))
  if (!existsSync(join(input.projectRoot, '.trellis', 'scripts', 'common', 'active_task.py'))) return Promise.resolve(unavailable('This workspace has no supported official Trellis active-task API'))
  const native = input.nativeSessionId
  return new Promise((resolvePromise) => execFile(input.pythonExecutable ?? 'python', ['-c', OFFICIAL_BIND, input.projectRoot, input.platform, native, input.taskDir, input.allowBinding ? 'yes' : 'no'], {
    cwd: input.projectRoot, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', TRELLIS_CONTEXT_ID: '' }
  }, (error, stdout) => {
    if (error) { resolvePromise(unavailable('Official Trellis context binding did not acknowledge; no task lifecycle approval is inferred')); return }
    try {
      const value: unknown = JSON.parse(stdout)
      if (!value || typeof value !== 'object' || !('status' in value) || !['bound', 'unavailable', 'conflict'].includes(String(value.status))) throw new Error('Invalid official reply')
      const record = value as { status: NativeTaskBinding['status']; contextKey?: unknown; taskPath?: unknown }
      resolvePromise({ status: record.status, contextKey: typeof record.contextKey === 'string' ? record.contextKey : null, taskPath: typeof record.taskPath === 'string' ? record.taskPath : null,
        hookInjection: 'unobserved', reason: record.status === 'bound' ? 'Official session pointer matches the selected task; actual hook injection remains independently observed' : record.status === 'conflict' ? 'This native session already belongs to another task; its pointer was preserved' : 'No verified native task binding was established' })
    } catch { resolvePromise(unavailable('Official Trellis context response could not be verified')) }
  }))
}
