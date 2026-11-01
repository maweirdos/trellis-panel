import { privateNativeOwnerSchema } from './private-conversations'
import { conversationConfigureSchema, conversationRecoverModelSchema } from './acp-configuration'

export const privateNativeConfigureSchema = privateNativeOwnerSchema.extend({ input: conversationConfigureSchema }).strict()
export const privateNativeRecoverModelSchema = privateNativeOwnerSchema.extend({ input: conversationRecoverModelSchema }).strict()
