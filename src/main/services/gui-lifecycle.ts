import { app } from 'electron'
import { createConnection } from 'node:net'
import { existsSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { daemonIdentitySchema, processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import { createLifecycleControlContext, type DaemonContext } from '../daemon/context'
import { processIdentity, sameOwner } from '../daemon/native'
import { readBounded, writeAtomic } from '../daemon/files'
import { listenNativePipe } from '../daemon/transport'
import { encodeFrame } from '../daemon/framing'
import { prepareGuiTermination, verifyDevelopmentLauncher } from '../daemon/lifecycle-native'
import { currentDaemonBuild } from '../daemon/build-identity'
import { DaemonError } from '../daemon/errors'
import { readLifecycleAttempt, type LifecycleAttempt, type LifecycleConfirmation } from './daemon-client/lifecycle'
import { runDaemonLifecycleWithDialog } from './daemon-lifecycle-dialog'

const guiOwnerSchema = z.object({ version: z.literal(1), identity: daemonIdentitySchema, owner: processOwnerSchema }).strict()
const ownerFile = (context: DaemonContext): string => join(context.directory, 'gui-lifecycle-owner.json')
const pipe = (context: DaemonContext): string => `crux-gui-lifecycle-${context.identity.profileId}-${context.identity.installationId.slice(0, 16)}`

/** A protected file binds each message to the actual kernel-authenticated peer
 * and exact confirmed attempt. No window/deep-link or generic RPC controls this. */
export async function installGuiLifecycleEndpoint(stop: () => Promise<void>): Promise<() => Promise<void>> {
  const context = await createLifecycleControlContext()
  const record = guiOwnerSchema.parse({ version: 1, identity: context.identity, owner: context.owner })
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    const work = (async () => {
      await server.close()
      if (existsSync(ownerFile(context)) && readBounded(ownerFile(context), 8192) === JSON.stringify(record)) unlinkSync(ownerFile(context))
    })()
    disposal = work
    void work.catch(() => { if (disposal === work) disposal = undefined })
    return work
  }
  const server = await listenNativePipe(pipe(context), peer => {
    let accepted = false
    peer.onFrame = raw => {
      const input = z.object({ attemptId: z.string().uuid(), action: z.literal('shutdown') }).strict().safeParse(raw)
      if (!input.success || accepted || peer.owner.userId !== context.owner.userId) { peer.close(); return }
      try {
        const attempt = readLifecycleAttempt(context)
        if (!attempt || attempt.attemptId !== input.data.attemptId || attempt.phase !== 'stopping' ||
          !sameOwner(attempt.controller, peer.owner) || attempt.profileId !== context.identity.profileId ||
          attempt.installationId !== context.identity.installationId ||
          attempt.lease && !attempt.confirmed && !attempt.admitted) throw new DaemonError('E_DENIED', '无效的桌面退出交接。')
        accepted = true
        // stop closes intake before its first await. Reply is acceptance only;
        // the controller still verifies the GUI root and all captured children.
        const cleanup = stop()
        // Install completion before acknowledging: cleanup may already have
        // closed the endpoint, but losing this reply must not skip GUI exit.
        void cleanup.then(async () => {
          await dispose()
          app.exit(0)
        }).catch(() => { /* Native controller retains the deadline and witnesses. */ })
        try { peer.send({ accepted: true }) } catch { /* Scope verification remains authoritative. */ }
      } catch { peer.close() }
    }
  }, () => { /* Missing channel is not exit; the native controller verifies it. */ }, join(context.directory, 'native-cache'))
  writeAtomic(ownerFile(context), JSON.stringify(record))
  return dispose
}
export function capturedGuiLifecycleOwner(context: DaemonContext): ProcessOwner | null {
  if (!existsSync(ownerFile(context))) return null
  const record = guiOwnerSchema.parse(JSON.parse(readBounded(ownerFile(context), 8192)))
  if (record.identity.profileId !== context.identity.profileId || record.identity.installationId !== context.identity.installationId || record.owner.userId !== context.owner.userId) throw new DaemonError('E_DENIED', '桌面交接记录不属于目标安装。')
  return record.owner
}
export async function requestGuiLifecycleStop(context: DaemonContext, attempt: LifecycleAttempt, expected: ProcessOwner | null): Promise<void> {
  if (!existsSync(ownerFile(context))) return // Legacy GUI uses captured native scope.
  const descriptor = guiOwnerSchema.parse(JSON.parse(readBounded(ownerFile(context), 8192)))
  if (descriptor.identity.profileId !== context.identity.profileId || descriptor.identity.installationId !== context.identity.installationId ||
    descriptor.owner.userId !== context.owner.userId) throw new DaemonError('E_DENIED', '桌面交接记录不属于目标安装。')
  if (!expected || !sameOwner(descriptor.owner, expected)) throw new DaemonError('E_CONFLICT', '原桌面代次已改变；旧确认不能关闭新的桌面。')
  if (sameOwner(descriptor.owner, context.owner)) return
  const actual = await processIdentity(descriptor.owner.pid)
  if (!actual || !sameOwner(actual, descriptor.owner)) return
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(`\\\\.\\pipe\\${pipe(context)}`)
    const timer = setTimeout(() => { socket.destroy(); reject(new DaemonError('E_UNAVAILABLE', '原桌面未响应退出交接。')) }, 2000)
    socket.on('error', () => { clearTimeout(timer); reject(new DaemonError('E_UNAVAILABLE', '原桌面退出通道不可用。')) })
    socket.on('connect', () => { socket.write(encodeFrame({ attemptId: attempt.attemptId, action: 'shutdown' })) })
    socket.on('data', () => { clearTimeout(timer); socket.destroy(); resolve() })
    socket.on('close', () => { clearTimeout(timer); resolve() })
  })
}
export async function developmentLifecycle(confirm: (input: LifecycleConfirmation) => Promise<boolean>): Promise<void> {
  const id = process.env.CRUX_DEV_LAUNCH_ID
  if (!id || app.isPackaged) return
  if (!z.string().uuid().safeParse(id).success || !process.env.CRUX_DEV_LAUNCH_ROOT ||
    realpathSync(process.env.CRUX_DEV_LAUNCH_ROOT).toLowerCase() !== realpathSync(app.getAppPath()).toLowerCase()) {
    throw new DaemonError('E_DENIED', '开发重启入口不属于本工程。')
  }
  const launcher = await processIdentity(Number(process.env.CRUX_DEV_LAUNCH_PID))
  const context = await createLifecycleControlContext()
  if (!launcher || launcher.userId !== context.owner.userId) throw new DaemonError('E_DENIED', '原开发启动器身份已失效。')
  await verifyDevelopmentLauncher(launcher, app.getAppPath(), join(context.directory, 'native-cache'))
  let guiOwner: ProcessOwner | null = null
  await runDaemonLifecycleWithDialog(context, {
    reason: 'development', targetBuild: currentDaemonBuild().sha256, launch: { id, owner: launcher }, confirm,
    prepareAdditional: () => { guiOwner = capturedGuiLifecycleOwner(context); return prepareGuiTermination(context, { recoverExitedLegacy: true }) },
    stopAdditional: attempt => requestGuiLifecycleStop(context, attempt, guiOwner)
  })
}
