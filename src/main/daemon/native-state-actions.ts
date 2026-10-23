import { createHash } from 'node:crypto'
import type { Settings } from '../../shared/types'
import { canonicalWorkflowJson } from '../../shared/workflow'
import { nativeStateRequests, type NativeStateInput } from '../../shared/native-state'
import { defaultSettings } from '../services/store'
import type { DaemonContext } from './context'
import { DaemonError } from './errors'
import { DaemonNativeState } from './native-state'
import type { ProtectedSettingsOwner } from './settings-owner'

export function createNativeStateActions(context: DaemonContext, owner: ProtectedSettingsOwner, state: DaemonNativeState) {
  return {
    snapshot() {
      const phase = owner.authority()
      return { phase, revision: phase === 'daemon' ? owner.read().revision : null, profileId: context.identity.profileId }
    },
    write(raw: NativeStateInput<'native.settings.write'>, commandId: string | undefined) {
      if (!commandId) throw new DaemonError('E_INVALID_ARG', 'A native settings change requires its original command ID.')
      const input = nativeStateRequests['native.settings.write'].parse(raw)
      const allowed = new Set([...Object.keys(defaultSettings()), 'acp'])
      if (Object.keys(input.patch).some((key) => !allowed.has(key))) throw new DaemonError('E_INVALID_ARG', 'The native settings field is not declared for this application.')
      if (Buffer.byteLength(JSON.stringify(input.patch)) > 2 * 1024 * 1024) throw new DaemonError('E_BUSY', 'The native settings patch exceeds its bounded capacity.')
      const digest = createHash('sha256').update(canonicalWorkflowJson({ method: 'native.settings.write', profileId: context.identity.profileId, ...input })).digest('hex')
      return state.writeCommand(input.expectedRevision, commandId, digest, input.patch as Partial<Settings>)
    }
  }
}
export type NativeStateActions = ReturnType<typeof createNativeStateActions>
