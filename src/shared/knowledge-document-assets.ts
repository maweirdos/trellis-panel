/** Saved body identity; main resolves its own current project and artifact path. */
export interface KnowledgeDocumentContext {
  expectedRoot: string
  sessionId: string
  artifactId: string
  revision: string
}

export const KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION = 8192
export const KNOWLEDGE_DOCUMENT_IMAGE_MAX_PIXELS = 16 * 1024 * 1024
export const KNOWLEDGE_DOCUMENT_IMAGE_MAX_CONCURRENT = 3
export const KNOWLEDGE_DOCUMENT_IMAGE_MAX_COUNT = 8
export const KNOWLEDGE_DOCUMENT_IMAGES_MAX_BYTES = 20 * 1024 * 1024
export const KNOWLEDGE_DOCUMENT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type KnowledgeDocumentImageMime = typeof KNOWLEDGE_DOCUMENT_IMAGE_MIME_TYPES[number]

export interface KnowledgeArtifactImageInput extends KnowledgeDocumentContext { src: string }
export interface KnowledgeArtifactImage {
  dataUrl: string
  mimeType: KnowledgeDocumentImageMime
  byteLength: number
  contentHash: string
  width: number
  height: number
  relativePath: string
  /** The body is versioned; these separately resolved image bytes are not an archive. */
  resource: 'current-local'
}
export interface KnowledgeArtifactOpenLocalInput extends KnowledgeDocumentContext { acknowledgeChangedFile?: boolean }
export interface KnowledgeArtifactOpenLocalResult {
  opened: true
  currentRevision: string
  differsFromPreview: boolean
}
