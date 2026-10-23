import { protectedStorage as safeStorage } from '../../daemon/protected-storage'
import { IntegrationError } from './types'

export function protectSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new IntegrationError('系统凭据加密不可用，无法保存新凭证', 'denied')
  return safeStorage.encryptString(value).toString('base64')
}
export function revealSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new IntegrationError('当前系统无法解密此连接的凭证', 'denied')
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
  catch { throw new IntegrationError('凭证解密失败，请重新填写此连接的凭证', 'denied') }
}
export function legacySecret(value: string, encrypted?: boolean): string {
  return encrypted && value ? revealSecret(value) : value
}
