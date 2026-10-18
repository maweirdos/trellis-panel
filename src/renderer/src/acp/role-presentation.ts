import type { AcpAgentProfile } from '../../../shared/types'

/** These existing records remain intact; only their presentation distinguishes starter roles. */
export function isStarterRole(profile: AcpAgentProfile): boolean {
  const originalName = profile.id === 'default-codex' ? 'Codex' : profile.id === 'default-claude' ? 'Claude Code' : null
  return originalName !== null && profile.name === originalName && !profile.description.trim() && !profile.instructions.trim()
}

export function rolesForDisplay(profiles: AcpAgentProfile[]): AcpAgentProfile[] {
  return [...profiles].sort((left, right) => Number(isStarterRole(left)) - Number(isStarterRole(right)))
}
