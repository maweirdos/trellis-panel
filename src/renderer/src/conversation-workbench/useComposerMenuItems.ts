import { useMemo } from 'react'
import type { ConversationDriverSkill, ConversationDriverSkillSource } from '../../../shared/conversation/driverCatalog'
import type { ProjectWorkbenchFileEntry } from '../../../shared/conversation/project-workbench'
import { composerSearchScore, searchSlashCommandItems } from './composerSlashCommandSearch'
import { formatProviderSkillDisplayName, isCurrencyAmountQuery } from './inlineSkills'

export interface ComposerMentionableThread {
  readonly id: string
  readonly title: string
  readonly updatedAt?: string
}

export interface ComposerTrigger {
  readonly kind: 'slash-command' | 'skill' | 'path'
  readonly query: string
  readonly rangeStart: number
  readonly rangeEnd: number
}

export type ComposerMenuItem =
  | { type: 'model'; id: string; name: string; label: string; description?: string }
  | { type: 'side'; id: string; name: string; label: string; description?: string }
  | { type: 'attachment'; id: string; name: string; label: string; description?: string }
  | { type: 'skill'; id: string; name: string; label: string; description?: string; source?: ConversationDriverSkillSource }
  | { type: 'thread'; id: string; threadId: string; label: string; description?: string }
  | { type: 'file'; id: string; path: string; kind: ProjectWorkbenchFileEntry['kind']; label: string; description: string }

export function detectComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  const rangeEnd = Math.min(text.length, Math.max(0, caret))
  let rangeStart = rangeEnd
  while (rangeStart > 0 && !/\s/u.test(text[rangeStart - 1])) rangeStart--
  const token = text.slice(rangeStart, rangeEnd)
  if (token.startsWith('/')) {
    const currentWord = /^\S*/u.exec(text.slice(rangeStart + 1))?.[0] ?? ''
    if (/[/\\]/u.test(currentWord)) return null
    return { kind: 'slash-command', query: token.slice(1), rangeStart, rangeEnd }
  }
  if (token.startsWith('@')) return { kind: 'path', query: token.slice(1), rangeStart, rangeEnd }
  const sigil = /^\p{Sc}/u.exec(token)?.[0]
  if (!sigil) return null
  const query = token.slice(sigil.length)
  return isCurrencyAmountQuery(query) ? null : { kind: 'skill', query, rangeStart, rangeEnd }
}

const MAX_MENU_ITEMS = 12

export function useComposerMenuItems(
  trigger: ComposerTrigger | null,
  skills: readonly ConversationDriverSkill[],
  threads: readonly ComposerMentionableThread[],
  canAttach: boolean,
  sideChat: { readonly available: boolean; readonly disabledReason?: string } = { available: false },
  files?: { readonly entries: readonly ProjectWorkbenchFileEntry[]; readonly query: string },
): readonly ComposerMenuItem[] {
  return useMemo(() => {
    if (!trigger) return []
    if (trigger.kind === 'path') {
      const query = trigger.query.normalize('NFC').toLowerCase()
      const attach = canAttach && ['添加附件', 'file', 'attachment'].some(value => Number.isFinite(composerSearchScore(value, query)))
      const fileMatches = (files?.entries ?? []).map((entry, order) => ({ entry, order, score: composerSearchScore(entry.name, files?.query ?? '') }))
        .filter(match => Number.isFinite(match.score))
        .sort((left, right) => left.score - right.score || left.order - right.order)
        .slice(0, MAX_MENU_ITEMS)
        .map(({ entry }) => ({
          type: 'file' as const, id: `file:${entry.path}`, path: entry.path, kind: entry.kind, label: entry.name, description: entry.path,
        }))
      const matches = threads.map((thread, order) => ({ thread, order, score: composerSearchScore(thread.title, query) }))
        .filter(match => Number.isFinite(match.score))
        .sort((left, right) => left.score - right.score || left.order - right.order)
        .slice(0, attach ? MAX_MENU_ITEMS - 1 : MAX_MENU_ITEMS)
        .map(({ thread }) => ({ type: 'thread' as const, id: `thread:${thread.id}`, threadId: thread.id, label: thread.title, description: '引用此会话' }))
      const candidates: ComposerMenuItem[] = [...fileMatches, ...matches]
      if (attach) candidates.push({ type: 'attachment', id: 'attachment', name: 'attachment', label: '添加附件', description: '添加文件或图片' })
      return candidates.slice(0, MAX_MENU_ITEMS)
    }
    const skillItems = skills.map(skill => ({
      type: 'skill' as const, id: `skill:${skill.name}`, name: skill.name,
      label: trigger.kind === 'slash-command' ? `/skill:${skill.name}` : formatProviderSkillDisplayName(skill),
      description: skill.description,
      source: skill.source,
    }))
    const builtIn = [
      { type: 'model' as const, id: 'slash:model', name: 'model', label: '/model', description: '切换本会话的回复模型' },
      ...(sideChat.available ? [
        { type: 'side' as const, id: 'slash:side', name: 'side', label: '/side', description: sideChat.disabledReason ?? '在新的侧聊里问一个旁支问题' },
        { type: 'side' as const, id: 'slash:btw', name: 'btw', label: '/btw', description: sideChat.disabledReason ?? '同 /side' },
      ] : []),
    ] satisfies readonly ComposerMenuItem[]
    return searchSlashCommandItems(
      trigger.kind === 'slash-command' ? [...builtIn, ...skillItems] : skillItems, trigger.query)
      .slice(0, MAX_MENU_ITEMS)
  }, [canAttach, skills, threads, trigger, sideChat.available, sideChat.disabledReason, files?.entries, files?.query])
}
