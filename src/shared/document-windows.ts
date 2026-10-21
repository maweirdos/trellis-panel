/** Clean-room fixed-source reader contracts. Tokens never grant arbitrary path access. */
import { z } from 'zod'
import type { DocumentDiffOutcome, DocumentReadOutcome, DocumentReadScope, DocumentReadSuccess, DocumentWatchOutcome } from './documents'
import type { IpcFail } from './ipc-errors'

export const fixedDocumentTokenSchema = z.string().regex(/^rd-[0-9a-f]{64}$/)
export const readerOriginSchema = z.object({
  sessionId: z.string().min(1).max(512).optional(),
  taskDir: z.string().min(1).max(2048).optional(),
  connectionGeneration: z.string().min(1).max(512).optional()
}).strict()
export type ReaderOrigin = z.infer<typeof readerOriginSchema>
export type DocumentMaterialKind = 'product-requirement' | 'trellis-prd' | 'design' | 'spec' | 'code' | 'feedback' | 'other'
export interface FixedDocumentVersion {
  token: string
  title: string
  relativePath: string
  revision: string
  digest: string
  kind: DocumentMaterialKind
  capturedAt: number
}
export interface DocumentVersionCatalog {
  ok: true
  versions: FixedDocumentVersion[]
  candidates: Array<{ relativePath: string; title: string }>
  nextCursor: string | null
  hasMore: boolean
}
export interface FixedDocumentComparison {
  ok: true
  left: FixedDocumentVersion
  right: FixedDocumentVersion
  outcome: DocumentDiffOutcome
}
export interface DocumentWindowBootstrap {
  ok: true
  viewId: string
  projectRoot: string
  version: FixedDocumentVersion
  document: DocumentReadSuccess
  origin: ReaderOrigin | null
  sourceActive: boolean
  pinned: boolean
}
export interface DocumentOriginReturn extends ReaderOrigin { projectRoot: string }
export interface DocumentWindowApi {
  documentVersions: (anchorToken?: string, cursor?: string) => Promise<DocumentVersionCatalog | IpcFail>
  documentCaptureVersion: (relativePath: string) => Promise<{ ok: true; version: FixedDocumentVersion } | IpcFail>
  documentCompareVersions: (input: { left: string; right: string; requestId: string }) => Promise<FixedDocumentComparison | IpcFail>
  documentOpenWindow: (input: { token: string; origin?: ReaderOrigin }) => Promise<{ ok: true; viewId: string } | IpcFail>
  documentWindowBootstrap: () => Promise<DocumentWindowBootstrap | IpcFail>
  documentWindowSourceState: () => Promise<{ ok: true; sourceActive: boolean } | IpcFail>
  documentWindowRead: (scope: DocumentReadScope, input: { relativePath: string; requestId: string }) => Promise<DocumentReadOutcome>
  documentWindowWatch: (scope: DocumentReadScope, input: { relativePath: string; knownRevision: string | null }) => Promise<DocumentWatchOutcome>
  documentWindowUnwatch: (canonicalPath: string, watchId: string) => Promise<void>
  documentWindowDiff: (scope: DocumentReadScope, input: unknown) => Promise<DocumentDiffOutcome>
  documentWindowReturn: () => Promise<{ ok: true } | IpcFail>
  onDocumentOriginReturn: (callback: (origin: DocumentOriginReturn) => void) => () => void
}
