/** Additive v12: resources belong to an authorization project, never to a local path. */
export const TEAM_CODE_RESOURCES_SQL = `
CREATE TABLE team_code_resources(
 projectId TEXT NOT NULL REFERENCES projects(projectId),resourceId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 recordJson TEXT NOT NULL,PRIMARY KEY(projectId,resourceId)
);
CREATE TABLE team_space_resources(
 projectId TEXT NOT NULL REFERENCES projects(projectId),spaceId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 defaultResourceId TEXT,PRIMARY KEY(projectId,spaceId),
 FOREIGN KEY(projectId,defaultResourceId) REFERENCES team_code_resources(projectId,resourceId)
);
CREATE TABLE team_space_resource_links(
 projectId TEXT NOT NULL,spaceId TEXT NOT NULL,resourceId TEXT NOT NULL,PRIMARY KEY(projectId,spaceId,resourceId),
 FOREIGN KEY(projectId,spaceId) REFERENCES team_space_resources(projectId,spaceId) ON DELETE CASCADE,
 FOREIGN KEY(projectId,resourceId) REFERENCES team_code_resources(projectId,resourceId)
);
CREATE INDEX team_space_resource_lookup ON team_space_resource_links(projectId,resourceId,spaceId);
CREATE TABLE team_task_code_resources(
 projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,spaceId TEXT NOT NULL,taskCreatedAt TEXT NOT NULL,
 recordJson TEXT NOT NULL,PRIMARY KEY(projectId,taskId)
);
CREATE TRIGGER team_resource_workspace_cleanup AFTER UPDATE OF snapshotJson ON hifox_workspaces BEGIN
 DELETE FROM team_task_code_resources WHERE projectId=NEW.projectId AND NOT EXISTS(
  SELECT 1 FROM json_each(NEW.snapshotJson,'$.tasks') t WHERE json_extract(t.value,'$.id')=team_task_code_resources.taskId
  AND json_extract(t.value,'$.createdAt')=team_task_code_resources.taskCreatedAt AND json_extract(t.value,'$.spaceId')=team_task_code_resources.spaceId
 );
 DELETE FROM team_space_resources WHERE projectId=NEW.projectId AND NOT EXISTS(
  SELECT 1 FROM json_each(NEW.snapshotJson,'$.spaces') s WHERE json_extract(s.value,'$.id')=team_space_resources.spaceId
 );
END;
`
