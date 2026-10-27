import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PI_VERSION } from './protocol'

export function piEngineEntry(): string {
  return app.isPackaged ? join(process.resourcesPath, 'pi-engine', 'engine.mjs') : join(app.getAppPath(), 'out', 'pi-engine', 'engine.mjs')
}
export const piEngineAvailable = (): boolean => existsSync(piEngineEntry())
export const piRuntimeDefinition = { id: 'pi', name: 'Pi 原生', command: `Pi SDK ${PI_VERSION}`, enabled: true, launchKind: 'sdk' as const }
