import { app } from 'electron'
import { join } from 'path'
import { atomicWriteText } from '../local-task/prd'

export const ACCESS_ENDPOINT_FILE = 'access-endpoint.json'

export function accessEndpointPath(): string {
  return join(app.getPath('userData'), ACCESS_ENDPOINT_FILE)
}

/** Discovery contains no credentials; the installed client reads the sibling token file. */
export function writeAccessEndpoint(running: boolean, port: number | null, enabled: boolean): void {
  atomicWriteText(accessEndpointPath(), JSON.stringify({
    version: 1,
    enabled,
    running,
    endpoint: running && port ? `http://127.0.0.1:${port}/tpap/v1` : null,
    updatedAt: Date.now()
  }))
}
