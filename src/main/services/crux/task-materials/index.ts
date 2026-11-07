import { withDesktopTeamService } from '../../team-desktop'
import { cruxWorkspaceGeneration, cruxWorkspaceStatus } from '../connection-service'
import { CruxTaskMaterialsService } from './procedures/service'

export function createCruxTaskMaterialsService(dataDir: string): CruxTaskMaterialsService {
  return new CruxTaskMaterialsService(dataDir, { workspaceStatus: cruxWorkspaceStatus, workspaceGeneration: cruxWorkspaceGeneration, withService: withDesktopTeamService })
}
