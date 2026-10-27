/** Private host/SDK-process boundary. Pi types never cross this protocol. */
import { z } from 'zod'

export const PI_VERSION = '1.4.0'
export const piModelSchema = z.object({
  selectionId: z.string().min(1), providerId: z.string().min(1), label: z.string(),
  api: z.enum(['openai', 'response', 'anthropic', 'ollama']), baseUrl: z.string().url(), apiKey: z.string(),
  endpoint: z.string().url().optional(),
  modelId: z.string().min(1), contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
  reasoning: z.boolean().default(true)
}).strict()
export type PiModel = z.infer<typeof piModelSchema>
export const piMcpSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]+$/), config: z.record(z.string(), z.unknown()) }).strict()
export const piInitializeSchema = z.object({
  root: z.string().min(1), cwd: z.string().min(1), sessionDir: z.string().min(1), sessionFile: z.string().optional(),
  agentDir: z.string().min(1), models: z.array(piModelSchema).min(1), modelId: z.string().min(1).optional(),
  recoveryModelId: z.string().min(1).optional(),
  proxy: z.object({ url: z.string().url() }).strict().optional(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  skillPaths: z.array(z.string()).max(32), instructions: z.string().max(128 * 1024),
  mcpServers: z.array(piMcpSchema).max(64)
}).strict().refine(value => value.sessionFile ? value.modelId === undefined : value.modelId !== undefined && value.recoveryModelId === undefined, 'Pi model defaults apply only to a new session')
export type PiInitialize = z.infer<typeof piInitializeSchema>
export const piStateSchema = z.object({
  sessionId: z.string().min(1), sessionFile: z.string().min(1), modelId: z.string().min(1),
  sessionVersion: z.literal(3), thinkingLevel: z.string(), contextWindow: z.number(), tools: z.array(z.string())
}).strict()
export type PiState = z.infer<typeof piStateSchema>
export const piPermissionSchema = z.object({ toolCallId: z.string().min(1), name: z.string().min(1), args: z.record(z.string(), z.unknown()), cwd: z.string().min(1), homeDir: z.string().min(1) }).strict()
export type PiPermission = z.infer<typeof piPermissionSchema>
/** A replace carries the complete block in text, including an empty string to clear it. */
export const piTextMetaSchema = z.object({
  version: z.literal(1), messageId: z.string().min(1), blockIndex: z.number().int().nonnegative(),
  blockType: z.enum(['text', 'thinking']), operation: z.enum(['append', 'replace']),
  providerMessageId: z.string().min(1).optional(), authority: z.enum(['block_end', 'message_end']).optional()
}).strict()
export type PiTextMeta = z.infer<typeof piTextMetaSchema>
export type PiTextPhase = 'commentary' | 'final_answer'
/** Normalized message activity, independent of Pi's event union and ACP wire frames. */
export type PiActivity =
  | { type: 'text_delta'; text: string; stream?: 'output' | 'thought'; messageId?: string; meta?: Record<string, unknown> }
  | { type: 'tool_call'; text: string; toolCallId: string; title?: string; status: string; tag?: string; rawInput?: unknown; rawOutput?: unknown; outputDelta?: string }
  | { type: 'status'; text: string; tag?: string; used?: number; size?: number; phase?: string; operationId?: string; messageId?: string }
  | { type: 'error'; message: string }
export type PiChildMessage =
  | { type: 'response'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'event'; event: PiActivity }
  | { type: 'permission'; id: string; request: PiPermission }
// Eight public image attachments can total 20 MiB before base64 and context framing.
export const PI_FRAME_BYTES = 40 * 1024 * 1024
