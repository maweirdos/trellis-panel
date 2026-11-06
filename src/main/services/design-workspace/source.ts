import type { TimelineEvent } from '../../../shared/types'
import { designGenerationManifestSchema, designGenerationOutputSchema, DESIGN_GENERATION_MANIFEST_MAX_BYTES, DESIGN_GENERATION_PAGE_MAX_BYTES } from '../../../shared/design-generation'
import { designPagesSchema, type DesignPage } from '../../../shared/design-workspace'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { assertDesignHtmlSelfContained } from '../../../shared/design-html-policy'
import { hash, pathKey, readRegular } from '../private-conversations/files'
import { utf8 } from '../private-conversations/requirement-files'
import type { PrivateConversations } from '../private-conversations/service'
import { DesignWorkspaceError, type DesignOwner, type DesignSource } from './types'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export async function generationEvents(conversations: PrivateConversations, owner: DesignOwner, current: () => void, afterCursor?: string): Promise<{ events: TimelineEvent[]; afterCursor?: string }> {
  const conversation = owner.conversation
  if (!conversation.nativeRef || conversation.nativeRef.agentId !== 'pi') return { events: [] }
  const events: TimelineEvent[] = [], seen = new Set<string>()
  let before: string | undefined
  let after = afterCursor, nextAnchor = afterCursor
  let recoveredOldCursor = false
  const readPage = async (paging: { limit: number; before?: string; after?: string }) => {
    current(); owner.assertCurrent()
    const page = await conversations.events(conversation.id, paging)
    current(); owner.assertCurrent()
    if (page.ok && page.value && (page.value.session.sessionId !== conversation.nativeRef?.sessionId || page.value.session.engine !== 'pi' || pathKey(page.value.session.projectRoot) !== pathKey(conversation.workspace.root))) throw new DesignWorkspaceError('设计工具事件与原 Pi 会话不一致', IpcErrorCode.Denied)
    return page
  }
  const resetsCursor = (page: { code: string; resetRequired?: unknown }): boolean => page.code === IpcErrorCode.InvalidArg || page.code === IpcErrorCode.ResetRequired || page.code === IpcErrorCode.Conflict && page.resetRequired === true
  const done = async (): Promise<{ events: TimelineEvent[]; afterCursor?: string }> => {
    if (events.length) {
      // The newest page has no afterCursor at the end of history. Ask for the
      // preceding whole turn so the history service issues a real after cursor;
      // replay the newest turn on the next scan while it may still be growing.
      const latest = await readPage({ limit: 1 })
      if (!latest.ok && !resetsCursor(latest)) throw new DesignWorkspaceError(latest.error, latest.code)
      if (latest.ok && latest.value?.beforeCursor) {
        const preceding = await readPage({ limit: 1, before: latest.value.beforeCursor })
        if (!preceding.ok && !resetsCursor(preceding)) throw new DesignWorkspaceError(preceding.error, preceding.code)
        if (preceding.ok && preceding.value?.afterCursor) {
          const last = preceding.value.events.at(-1)
          // A new turn can arrive during the probe; do not advance past events
          // this scan has not actually returned to its caller.
          if (last && seen.has(last.id)) nextAnchor = preceding.value.afterCursor
        }
      }
    }
    return { events: events.sort((left, right) => (left.historySeq ?? 0) - (right.historySeq ?? 0) || left.ts - right.ts), afterCursor: nextAnchor }
  }
  for (let pageCount = 0; pageCount < 40; pageCount++) {
    const page = await readPage({ limit: 500, ...(after ? { after } : before ? { before } : {}) })
    if (!page.ok) {
      if (afterCursor && resetsCursor(page)) {
        // Earlier scans stored a before cursor as an after cursor. When it is
        // still valid in its original direction, replay from the preceding
        // turn instead of rescanning an arbitrarily long conversation.
        if (!recoveredOldCursor) {
          recoveredOldCursor = true
          const previous = await readPage({ limit: 1, before: afterCursor })
          if (!previous.ok && !resetsCursor(previous)) throw new DesignWorkspaceError(previous.error, previous.code)
          if (previous.ok && previous.value?.afterCursor && previous.value.afterCursor !== afterCursor) {
            events.length = 0; seen.clear(); before = undefined
            after = previous.value.afterCursor; nextAnchor = after; pageCount = -1
            continue
          }
        }
        return generationEvents(conversations, owner, current)
      }
      throw new DesignWorkspaceError(page.error, page.code)
    }
    const value = page.value
    if (!value) throw new DesignWorkspaceError('原会话事件暂不可用，请稍后重试', IpcErrorCode.Busy)
    for (const event of value.events) if (!seen.has(event.id)) { seen.add(event.id); events.push(event) }
    if (value.afterCursor && (after || !nextAnchor)) nextAnchor = value.afterCursor
    if (events.length > 20_000) throw new DesignWorkspaceError('会话设计事件超过读取上限', IpcErrorCode.Busy)
    if (after) {
      if (!value.hasLater) return done()
      if (!value.afterCursor || value.afterCursor === after) throw new DesignWorkspaceError('原会话事件游标未推进')
      after = value.afterCursor; continue
    }
    if (!value.hasEarlier) return done()
    if (!value.beforeCursor || value.beforeCursor === before) throw new DesignWorkspaceError('原会话事件游标未推进')
    before = value.beforeCursor
  }
  throw new DesignWorkspaceError('会话设计事件超过读取上限', IpcErrorCode.Busy)
}
export function readGeneration(owner: DesignOwner, event: TimelineEvent): { source: DesignSource; pages: DesignPage[]; baseRevision?: string; placeholderIdentity: boolean } | null {
  const payload = object(event.payload)
  if (event.source !== 'pi' || event.kind !== 'tool-call' || payload.title !== 'design_open' || payload.status !== 'completed' || payload.tag !== 'pi_tool_end') return null
  if (!event.sessionId || event.sessionId !== owner.conversation.nativeRef?.sessionId || pathKey(event.projectRoot) !== pathKey(owner.conversation.workspace.root) || !event.connectionGeneration || !event.turnId || typeof payload.toolCallId !== 'string') throw new DesignWorkspaceError('设计工具结果缺少原会话身份', IpcErrorCode.Denied)
  const raw = object(payload.rawOutput), details = object(raw.details), output = designGenerationOutputSchema.parse(details.designOutput)
  owner.assertCurrent()
  const root = owner.conversation.workspace.root, actual = readRegular(root, output.manifestPath, DESIGN_GENERATION_MANIFEST_MAX_BYTES)
  const manifest = designGenerationManifestSchema.parse(JSON.parse(utf8(actual.bytes)))
  if (manifest.documentId !== output.documentId || manifest.revisionId !== output.revisionId || manifest.toolCallId !== payload.toolCallId) throw new DesignWorkspaceError('设计清单与实际工具结果不一致', IpcErrorCode.Denied)
  const sources: DesignSource['pages'] = []
  const pages = manifest.pages.map(page => {
    const file = readRegular(root, page.path, DESIGN_GENERATION_PAGE_MAX_BYTES)
    if (hash(file.bytes) !== page.revision) throw new DesignWorkspaceError('生成页面已被外部修改；原稿未被覆盖')
    const html = utf8(file.bytes)
    assertPageHtml(html)
    sources.push({ path: page.path, revision: page.revision, identity: file.fileIdentity })
    return { id: page.id, title: page.title, html, width: page.width, height: page.height }
  })
  owner.assertCurrent()
  return {
    source: { eventId: event.id, sessionId: event.sessionId, connectionGeneration: event.connectionGeneration, turnId: event.turnId, toolCallId: payload.toolCallId, output, manifestRevision: hash(actual.bytes), manifestIdentity: actual.fileIdentity, pages: sources },
    pages: designPagesSchema.parse(pages), baseRevision: manifest.baseRevision, placeholderIdentity: details.placeholderIdentity === true
  }
}
export function assertPageHtml(html: string): void {
  if (html.includes('\0') || !/<html(?:\s|>)/i.test(html) || !/<head(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) throw new DesignWorkspaceError('设计页面不是完整 HTML', IpcErrorCode.InvalidArg)
  try { assertDesignHtmlSelfContained(html) }
  catch (error) { throw new DesignWorkspaceError(error instanceof Error ? error.message : '设计页面包含外部依赖', IpcErrorCode.InvalidArg) }
}
export function assertGenerationCurrent(owner: DesignOwner, source: DesignSource): void {
  owner.assertCurrent()
  if (owner.conversation.nativeRef?.sessionId !== source.sessionId || owner.conversation.nativeRef.agentId !== 'pi') throw new DesignWorkspaceError('原设计生成会话已变化', IpcErrorCode.Denied)
  const root = owner.conversation.workspace.root, manifest = readRegular(root, source.output.manifestPath, DESIGN_GENERATION_MANIFEST_MAX_BYTES)
  if (hash(manifest.bytes) !== source.manifestRevision || manifest.fileIdentity !== source.manifestIdentity) throw new DesignWorkspaceError('原设计清单已改变；停止读取和写入')
  for (const page of source.pages) {
    const actual = readRegular(root, page.path, DESIGN_GENERATION_PAGE_MAX_BYTES)
    if (hash(actual.bytes) !== page.revision || actual.fileIdentity !== page.identity) throw new DesignWorkspaceError('原设计页面已改变；停止读取和写入')
  }
  owner.assertCurrent()
}
