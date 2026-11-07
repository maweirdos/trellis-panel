/** Additive v9 migration; creation bodies never enter crux_workspaces. */
export const TEAM_CREATIONS_SQL = `
CREATE TABLE IF NOT EXISTS creations(
 creationId TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(projectId), ownerId TEXT NOT NULL REFERENCES people(userId),
 home TEXT NOT NULL CHECK(home IN ('personal','team')), spaceId TEXT, title TEXT NOT NULL, editorIdsJson TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), published INTEGER NOT NULL CHECK(published IN (0,1)),
 summaryJson TEXT NOT NULL, recordJson TEXT NOT NULL, byteLength INTEGER NOT NULL CHECK(byteLength>0 AND byteLength<=16777216),
 createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS creations_project ON creations(projectId,creationId);
CREATE INDEX IF NOT EXISTS creations_owner ON creations(projectId,ownerId,creationId);
CREATE INDEX IF NOT EXISTS creations_space ON creations(projectId,spaceId,creationId);
CREATE TABLE IF NOT EXISTS creation_task_references(
 creationId TEXT NOT NULL REFERENCES creations(creationId), projectId TEXT NOT NULL REFERENCES projects(projectId), taskId TEXT NOT NULL,
 PRIMARY KEY(creationId,taskId)
);
CREATE INDEX IF NOT EXISTS creation_task_lookup ON creation_task_references(projectId,taskId,creationId);
`
