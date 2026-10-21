import { createHash } from 'node:crypto'
import { publicationInputSchema, TEAM_MAX_DOCUMENT_BYTES, teamPublishedDocumentSchema, type TeamPublishedDocument } from '../../../shared/team-platform'
import { DesktopTeamError } from './types'

/** JSON wire semantics: absent undefined properties cannot change a retry hash. */
export function canonicalTeamJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => item === undefined ? 'null' : canonicalTeamJson(item)).join(',') + ']'
  return '{' + Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + canonicalTeamJson((value as Record<string, unknown>)[key])).join(',') + '}'
}
export function verifyTeamDocument(raw: unknown): TeamPublishedDocument {
  const document = teamPublishedDocumentSchema.parse(raw), bytes = Buffer.byteLength(document.text, 'utf8')
  if (bytes !== document.material.byteLength || bytes > TEAM_MAX_DOCUMENT_BYTES || createHash('sha256').update(document.text, 'utf8').digest('hex') !== document.material.bodyDigest) throw new DesktopTeamError('BODY_MISMATCH', '共享文档正文、长度与固定版本摘要不一致')
  publicationInputSchema.shape.text.parse(document.text)
  return document
}
