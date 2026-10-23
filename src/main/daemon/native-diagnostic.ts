import { z } from 'zod'

/** Safe native failure metadata. Never contains settings, paths or messages. */
export const nativeDiagnosticSchema = z.object({
  state: z.literal('unavailable'), operation: z.enum(['identity', 'secure-directory']),
  exception: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), hresult: z.number().int(),
  command: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/).nullable().optional(),
  line: z.number().int().nonnegative().optional()
}).strict()
