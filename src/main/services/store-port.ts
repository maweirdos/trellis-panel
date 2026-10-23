import type { Settings } from '../../shared/types'

/** Native settings authority. GUI and daemon must never own separate writable whole-file caches. */
export interface SettingsPersistencePort {
  read(): Settings
  write(patch: Partial<Settings>, strict: boolean): Settings
}
let persistence: SettingsPersistencePort | undefined
export function settingsPersistence(): SettingsPersistencePort | undefined { return persistence }
export function installSettingsPersistence(port: SettingsPersistencePort): () => void {
  if (persistence && persistence !== port) throw new Error('A settings persistence authority is already installed')
  persistence = port
  return () => { if (persistence === port) persistence = undefined }
}
