import { withDesktopTeamService } from '../../team-desktop'
import { hifoxWorkspaceGeneration, hifoxWorkspaceStatus } from '../connection-service'
import { HifoxGovernanceService } from './service'

export { HifoxGovernanceService } from './service'
export function createHifoxGovernanceService(dataDir: string): HifoxGovernanceService {
  return new HifoxGovernanceService(dataDir, { workspaceStatus: hifoxWorkspaceStatus, workspaceGeneration: hifoxWorkspaceGeneration, withService: withDesktopTeamService })
}
