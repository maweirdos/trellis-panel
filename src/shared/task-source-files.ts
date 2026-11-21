import { z } from 'zod'

export const SOURCE_PART_BYTES = 512 * 1024
export const SOURCE_FILE_BYTES = 16 * 1024 * 1024
export const sourceDigest = z.string().regex(/^[a-f0-9]{64}$/)
export const taskSourceFile = z.object({
  name: z.string().min(1).max(500).regex(/^[^/\\\x00-\x1f]+$/),
  revision: sourceDigest, bytes: z.number().int().nonnegative().max(SOURCE_FILE_BYTES),
  parts: z.array(sourceDigest).min(1).max(32)
}).strict().refine(file => file.parts.length === Math.max(1, Math.ceil(file.bytes / SOURCE_PART_BYTES)), '文件分片数量不匹配')
export const taskSourceFiles = z.array(taskSourceFile).max(8).refine(files =>
  files.reduce((sum, file) => sum + file.bytes, 0) <= 32 * 1024 * 1024, '共享文件总计超过 32 MiB')
export type TaskSourceFile = z.infer<typeof taskSourceFile>
export const sourcePartQuery = z.object({ sourceId: z.string().uuid(), revision: sourceDigest, part: z.coerce.number().int().min(0).max(31) }).strict()
export const sourcePartData = z.string().max(4 * Math.ceil(SOURCE_PART_BYTES / 3))
export const sourcePartReply = z.object({
  authorizationRevision: z.number().int().nonnegative(), instanceId: z.string().uuid(), epoch: z.string().uuid(), projectId: z.string().uuid(),
  spaceId: z.string(), taskId: z.string(), taskCreatedAt: z.string(), ...sourcePartQuery.shape,
  digest: sourceDigest, data: sourcePartData.optional()
}).strict()
