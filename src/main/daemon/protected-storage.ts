import { safeStorage as electronStorage } from 'electron'

export interface ProtectedStoragePort {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
let port: ProtectedStoragePort | undefined
export function installProtectedStorage(value: ProtectedStoragePort): void {
  if (port && port !== value) throw new Error('Native protection authority is already installed')
  port = value
}
/** Existing services retain their synchronous native credential interface. New
 * ciphertext is profile-key protected; old Electron ciphertext remains readable. */
export const protectedStorage = {
  isEncryptionAvailable(): boolean { return port ? port.available() : electronStorage.isEncryptionAvailable() },
  encryptString(value: string): Buffer { return port ? port.encrypt(value) : electronStorage.encryptString(value) },
  decryptString(value: Buffer): string {
    if (!port) return electronStorage.decryptString(value)
    // Native preparation loads the exact historical key before synchronous
    // services are installed. Never silently switch back to a role-local key.
    return port.decrypt(value)
  }
}
