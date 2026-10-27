import { z } from 'zod'
import type { IpcFail } from './ipc-errors'

export const piWebPreviewArtifactSchema = z.object({
  path: z.string().min(1).max(8192),
  title: z.string().min(1).max(160),
  revision: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()
export type PiWebPreviewArtifact = z.infer<typeof piWebPreviewArtifactSchema>
export function readPiWebPreviewArtifact(value: unknown): PiWebPreviewArtifact | null {
  const parsed = piWebPreviewArtifactSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export const piWebPreviewOpenSchema = z.object({
  expectedRoot: z.string().min(1).max(8192),
  sessionId: z.string().min(1).max(256),
  connectionGeneration: z.string().min(1).max(256).optional(),
  artifact: piWebPreviewArtifactSchema
}).strict()
export type PiWebPreviewOpenInput = z.infer<typeof piWebPreviewOpenSchema>
export interface PiWebPreviewLease { id: string; url: string; path: string; revision: string }
export type PiWebPreviewOpenResult = { ok: true; preview: PiWebPreviewLease } | IpcFail
export type PiWebPreviewStatusResult = { ok: true; revision: string } | IpcFail
