import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalWorkflowJson } from '../../shared/workflow'
import type { ProcessOwner } from '../../shared/daemon'

export function authenticationProof(secret: string, challenge: unknown, client: ProcessOwner): string {
  return createHmac('sha256', secret).update(canonicalWorkflowJson({ purpose: 'native-client', challenge, client })).digest('hex')
}
export function serverProof(secret: string, proof: string): string { return createHmac('sha256', secret).update(`native-server\0${proof}`).digest('hex') }
export function equalProof(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex')
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b)
}
