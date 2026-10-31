import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { OnboardingOutcome, OnboardingStatus } from '../shared/onboarding'
import { readBounded, writeAtomic, writeExclusiveAtomic } from './daemon/files'

const stateSchema = z.object({ version: z.literal(1), state: z.enum(['pending', 'completed', 'skipped']) }).strict()
type StoredState = z.infer<typeof stateSchema>
type EarlyState = { profile: 'new' | 'existing' | 'unknown'; stored?: StoredState }
const earlyKey = Symbol.for('trellis.gui.onboarding.early')
const stateFile = (userData: string): string => join(userData, 'onboarding-v1.json')

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Capture before bootstrap creates session directories or GUI imports initialize stores. */
export function captureOnboarding(userData: string): void {
  let result: EarlyState
  try {
    try {
      const stored = stateSchema.parse(JSON.parse(readBounded(stateFile(userData), 4096)))
      result = { profile: 'existing', stored }
    } catch (error) {
      if (!missing(error)) throw error
      try { result = { profile: readdirSync(userData).length === 0 ? 'new' : 'existing' } }
      catch (directoryError) {
        if (!missing(directoryError)) throw directoryError
        result = { profile: 'new' }
      }
    }
  } catch { result = { profile: 'unknown' } }
  Reflect.set(process, earlyKey, result)
}

/** Call only after acquiring the GUI instance lock. */
export function createOnboarding(userData: string): {
  status(): OnboardingStatus
  complete(outcome: OnboardingOutcome): OnboardingStatus
} {
  const early = Reflect.get(process, earlyKey) as EarlyState | undefined
  const profile = early?.profile ?? 'unknown'
  let stored = early?.stored
  let available = profile !== 'unknown'
  const file = stateFile(userData)
  if (profile === 'new') {
    try {
      const initial: StoredState = { version: 1, state: 'pending' }
      writeExclusiveAtomic(file, JSON.stringify(initial))
      stored = initial
    } catch { available = false }
  }
  const status = (): OnboardingStatus => ({
    profile,
    state: available ? stored?.state ?? 'not-started' : 'unavailable',
    shouldShow: available && stored?.state === 'pending'
  })
  return {
    status,
    complete(outcome) {
      const next: StoredState = { version: 1, state: outcome }
      if (!available) {
        if (profile !== 'new' || stored) throw new Error('首启状态不可用，原文件已保留。')
        // The first publication may have failed transiently. Retry without
        // replacing a file that another process could have created meanwhile.
        writeExclusiveAtomic(file, JSON.stringify(next))
        stored = next
        available = true
        return status()
      }
      if (stored) {
        // Refuse to replace an externally changed, corrupt or unknown record.
        const current = stateSchema.parse(JSON.parse(readBounded(file, 4096)))
        if (current.state !== stored.state) throw new Error('首启状态已变化，请重新启动后重试。')
        writeAtomic(file, JSON.stringify(next))
      } else {
        writeExclusiveAtomic(file, JSON.stringify(next))
      }
      stored = next
      return status()
    }
  }
}
