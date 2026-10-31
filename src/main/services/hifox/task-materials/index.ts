import { withDesktopTeamService } from '../../team-desktop'
import { hifoxWorkspaceGeneration, hifoxWorkspaceStatus } from '../connection-service'
import { HifoxTaskMaterialsService } from './procedures/service'

export function createHifoxTaskMaterialsService(dataDir: string): HifoxTaskMaterialsService {
  return new HifoxTaskMaterialsService(dataDir, { workspaceStatus: hifoxWorkspaceStatus, workspaceGeneration: hifoxWorkspaceGeneration, withService: withDesktopTeamService })
}
