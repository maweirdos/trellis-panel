export const TEAM_INVITATIONS_SQL = `
CREATE TABLE IF NOT EXISTS invitations(
 invitationId TEXT PRIMARY KEY,teamId TEXT NOT NULL REFERENCES teams(teamId),projectId TEXT NOT NULL REFERENCES projects(projectId),
 tokenHash TEXT UNIQUE NOT NULL,recipientIssuer TEXT NOT NULL,recipientJson TEXT NOT NULL,teamRolesJson TEXT NOT NULL,projectRolesJson TEXT NOT NULL,
 expectedTeamRevision INTEGER,expectedProjectRevision INTEGER,createdBy TEXT NOT NULL REFERENCES people(userId),
 createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,status TEXT NOT NULL,acceptedBy TEXT REFERENCES people(userId),acceptedAt INTEGER
);
CREATE INDEX IF NOT EXISTS invitations_team ON invitations(teamId,invitationId);
`
