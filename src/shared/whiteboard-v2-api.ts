import { z } from 'zod'
import { creationCommandSchema, type CreationCommandReply } from './creations'
import { whiteboardV2ListInputSchema, whiteboardV2ViewInputSchema, type WhiteboardV2Capabilities, type WhiteboardV2List, type WhiteboardV2View } from './creation-whiteboard-v2'
import type { CreationReply } from './creation-api'

const workspaceKey = z.string().min(1).max(8192)
const id = z.string().uuid()
export const whiteboardV2CapabilityInputSchema = z.object({ workspaceKey }).strict()
export const whiteboardV2ClientListSchema = whiteboardV2ListInputSchema.extend({ workspaceKey }).strict()
export const whiteboardV2ClientGetSchema = whiteboardV2ViewInputSchema.extend({ workspaceKey, creationId: id }).strict()

// Renderer intent excludes all identity, authorization, source and unsupported fields.
export const whiteboardV2ClientCommandSchema = z.discriminatedUnion('action', [
  creationCommandSchema.options[0].omit({ expectedEpoch: true, kind: true, home: true, spaceId: true, editorIds: true, scenarios: true, privateNotes: true, privateSource: true }).strict(),
  creationCommandSchema.options[1].omit({ expectedEpoch: true, scenarios: true, privateNotes: true }).strict(),
  creationCommandSchema.options[2].omit({ expectedEpoch: true, reviewerIds: true, editorIds: true }).strict(),
  creationCommandSchema.options[3].omit({ expectedEpoch: true, target: true }).strict(),
  creationCommandSchema.options[4].omit({ expectedEpoch: true }).strict(),
  creationCommandSchema.options[5].omit({ expectedEpoch: true }).strict()
])
export const whiteboardV2ClientCommandInputSchema = z.object({ workspaceKey, command: whiteboardV2ClientCommandSchema }).strict()
export const whiteboardV2ClientRecoverSchema = z.union([
  whiteboardV2ClientCommandInputSchema,
  z.object({ workspaceKey, creationId: id, commandId: id }).strict()
])
export type WhiteboardV2ClientCommand = z.infer<typeof whiteboardV2ClientCommandSchema>

export type WhiteboardV2Api = {
  capabilities(input: z.input<typeof whiteboardV2CapabilityInputSchema>): Promise<CreationReply<WhiteboardV2Capabilities>>
  list(input: z.input<typeof whiteboardV2ClientListSchema>): Promise<CreationReply<WhiteboardV2List>>
  get(input: z.input<typeof whiteboardV2ClientGetSchema>): Promise<CreationReply<WhiteboardV2View | null>>
  command(input: z.input<typeof whiteboardV2ClientCommandInputSchema>): Promise<CreationReply<CreationCommandReply>>
  recover(input: z.input<typeof whiteboardV2ClientRecoverSchema>): Promise<CreationReply<CreationCommandReply | null>>
}
