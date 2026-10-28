import { z } from 'zod'
const project = z.object({ expectedRoot: z.string().min(1).max(4096), sessionId: z.string().min(1).max(256).optional() })
const request = project.extend({ requestId: z.string().uuid() })
export const knowledgeRuntimeInputs = {
  rebindSource: project.extend({ sessionId: z.string().min(1).max(200), sourceId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), expectedConnectionGeneration: z.string().min(1).max(200), expectedProjectGeneration: z.number().int().nonnegative() }),
  context: project,
  collections: project.extend({ connectionId: z.string().max(256).optional(), connectionRevision: z.number().int().positive().optional() }),
  updateScope: project.extend({ collectionIds: z.array(z.string().min(1).max(256)).max(20).nullable() }),
  search: request.extend({ query: z.string().max(2000), limit: z.number().int().min(1).max(30).optional() }),
  documents: project.extend({ collectionId: z.string().min(1).max(256), page: z.number().int().min(1).max(1000000).optional(), folderPath: z.string().max(4096).optional() }),
  folders: project.extend({ collectionId: z.string().min(1).max(256) }),
  read: request.extend({ sourceHandle: z.string().min(1).max(512) }),
  source: project.extend({ sourceId: z.string().min(1).max(256) }), sources: project,
  cancel: project.extend({ requestId: z.string().uuid() }),
  importLegacy: project.extend({ bindProject: z.boolean() }),
  saveArtifact: project.extend({ id: z.string().max(256).optional(), expectedRevision: z.string().max(128).nullable().optional(), title: z.string().trim().min(1).max(200), body: z.string().max(200_000), kind: z.enum(['product-requirements', 'confirmed-note']), sourceIds: z.array(z.string().max(256)).max(100).optional(), turnId: z.string().max(256).optional() }),
  artifacts: project, artifact: project.extend({ artifactId: z.string().max(256), revision: z.string().max(128) }),
  taskPrd: project.extend({ taskDir: z.string().min(1).max(4096) }),
  handoff: project.extend({ artifactId: z.string().max(256), revision: z.string().max(128), taskDir: z.string().min(1).max(4096), developerBody: z.string().max(200_000), expectedPrdRevision: z.string().max(128).nullable() }),
  previewPublication: project.extend({ artifactId: z.string().max(256), revision: z.string().max(128), collectionId: z.string().max(256), requestId: z.string().uuid() }),
  confirmPublication: project.extend({ requestId: z.string().uuid() }), publications: project,
  publicationPage: project.extend({ cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }),
  resolvePublication: project.extend({ requestId: z.string().uuid(), outcome: z.enum(['verified_absent', 'verified_published']), remoteDocumentId: z.string().max(256).optional(), acknowledgeDuplicateRisk: z.boolean() }),
  clearHistory: project
} as const
export type KnowledgeRuntimeOperation = keyof typeof knowledgeRuntimeInputs
export const knowledgeRuntimeBody = z.object({ operation: z.enum(Object.keys(knowledgeRuntimeInputs) as [KnowledgeRuntimeOperation, ...KnowledgeRuntimeOperation[]]), readerId: z.string().uuid(), input: z.unknown() }).strict()
export const KNOWLEDGE_MUTATIONS: readonly KnowledgeRuntimeOperation[] = ['rebindSource', 'updateScope', 'search', 'documents', 'read', 'importLegacy', 'saveArtifact', 'handoff', 'previewPublication', 'confirmPublication', 'resolvePublication', 'clearHistory']
