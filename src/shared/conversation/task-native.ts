import { z } from 'zod'
import { taskProgressPinSchema } from '../crux-task-progress-native'
import { conversationTaskLocatorSchema } from './task-scope'

export const nativeConversationTaskSchema = z.object({
  locator: conversationTaskLocatorSchema,
  pin: taskProgressPinSchema,
  selectionIdentity: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type NativeConversationTask = z.infer<typeof nativeConversationTaskSchema>
