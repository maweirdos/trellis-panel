import { withDesktopTeamService } from '../../team-desktop'
import { cruxWorkspaceGeneration, cruxWorkspaceStatus } from '../connection-service'
import { CruxGovernanceService } from './service'

export { CruxGovernanceService } from './service'
export function createCruxGovernanceService(dataDir: string): CruxGovernanceService {
  return new CruxGovernanceService(dataDir, { workspaceStatus: cruxWorkspaceStatus, workspaceGeneration: cruxWorkspaceGeneration, withService: withDesktopTeamService })
}
