import type { ConversationDriverSkill } from '../../../shared/conversation/driverCatalog'

export function formatProviderSkillDisplayName(skill: ConversationDriverSkill): string {
  return skill.displayName?.trim() || skill.name
}

export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query)
}
