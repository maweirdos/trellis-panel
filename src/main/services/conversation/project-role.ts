import { createHash } from 'node:crypto'
import { conversationRoleRevisionText, type ConversationProjectRoleSelection } from '../../../shared/conversation/project-role'
import { DaemonError } from '../../daemon/errors'
import { readProfiles } from '../acp/metadata'

export function readProjectRoleInstructions(root: string, selection: ConversationProjectRoleSelection): string {
  let profile: ReturnType<typeof readProfiles>[number] | undefined
  try {
    profile = readProfiles(root).find(item => item.id === selection.id)
  } catch {
    throw new DaemonError('E_IO', '无法读取当前工程的角色配置。')
  }
  if (!profile) throw new DaemonError('E_DENIED', '当前工程没有这个角色，请重新选择。')
  const revision = createHash('sha256').update(conversationRoleRevisionText(profile)).digest('hex')
  if (revision !== selection.revision) throw new DaemonError('E_CONFLICT', '角色已更新，请重新选择角色。原输入已保留。')
  return profile.instructions
}
