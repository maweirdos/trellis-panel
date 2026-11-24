import { z } from 'zod'

export const conversationProjectRoleSelectionSchema = z.strictObject({
  id: z.string().min(1).max(200).regex(/^[\w.-]+$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
})

export const conversationProjectRoleSchema = conversationProjectRoleSelectionSchema.extend({
  name: z.string().trim().min(1).max(100),
})

export type ConversationProjectRoleSelection = Readonly<z.infer<typeof conversationProjectRoleSelectionSchema>>
export type ConversationProjectRole = Readonly<z.infer<typeof conversationProjectRoleSchema>>

export function conversationRoleRevisionText(role: { readonly name: string; readonly instructions: string }): string {
  return JSON.stringify([role.name, role.instructions])
}
