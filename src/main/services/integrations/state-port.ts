import type { IntegrationState } from './stored-schema'

/** Native-only Repository port; mutations must publish atomically under the actual writer. */
export interface IntegrationStatePort {
  read(): IntegrationState
  update<T>(change: (state: IntegrationState) => T): T
}
let statePort: IntegrationStatePort | undefined
export function integrationStatePort(): IntegrationStatePort | undefined { return statePort }
export function installIntegrationStatePort(port: IntegrationStatePort): () => void {
  if (statePort && statePort !== port) throw new Error('An integration state authority is already installed')
  statePort = port
  return () => { if (statePort === port) statePort = undefined }
}
