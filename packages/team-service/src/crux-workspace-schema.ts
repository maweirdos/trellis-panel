/** Installed independently for existing workspaces by the team writer's v8 migration. */
export const TEAM_CRUX_WORKSPACE_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS crux_workspace_project_member_insert AFTER INSERT ON project_members BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId=NEW.projectId;
END;
CREATE TRIGGER IF NOT EXISTS crux_workspace_project_member_update AFTER UPDATE OF active,rolesJson ON project_members WHEN NEW.active<>OLD.active OR NEW.rolesJson<>OLD.rolesJson BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId=NEW.projectId;
END;
CREATE TRIGGER IF NOT EXISTS crux_workspace_project_member_delete AFTER DELETE ON project_members BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId=OLD.projectId;
END;
CREATE TRIGGER IF NOT EXISTS crux_workspace_team_member_insert AFTER INSERT ON team_members BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT pm.projectId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId WHERE pm.userId=NEW.userId AND p.teamId=NEW.teamId);
END;
CREATE TRIGGER IF NOT EXISTS crux_workspace_team_member_update AFTER UPDATE OF active ON team_members WHEN NEW.active<>OLD.active BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT pm.projectId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId WHERE pm.userId=NEW.userId AND p.teamId=NEW.teamId);
END;
CREATE TRIGGER IF NOT EXISTS crux_workspace_team_member_delete AFTER DELETE ON team_members BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT pm.projectId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId WHERE pm.userId=OLD.userId AND p.teamId=OLD.teamId);
END;
CREATE TRIGGER IF NOT EXISTS crux_workspace_person_update AFTER UPDATE OF active,displayName ON people WHEN NEW.active<>OLD.active OR NEW.displayName<>OLD.displayName BEGIN
 UPDATE crux_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT projectId FROM project_members WHERE userId=NEW.userId);
END;
`

export const TEAM_CRUX_WORKSPACE_LEGACY_TRIGGERS = [
  'hifox_workspace_project_member_insert',
  'hifox_workspace_project_member_update',
  'hifox_workspace_project_member_delete',
  'hifox_workspace_team_member_insert',
  'hifox_workspace_team_member_update',
  'hifox_workspace_team_member_delete',
  'hifox_workspace_person_update',
] as const

export const TEAM_CRUX_WORKSPACE_SQL = `
CREATE TABLE crux_workspaces(projectId TEXT PRIMARY KEY REFERENCES projects(projectId),revision INTEGER NOT NULL CHECK(revision>=0),snapshotJson TEXT NOT NULL,updatedAt INTEGER NOT NULL);
CREATE TABLE crux_inbox_preferences(projectId TEXT NOT NULL REFERENCES projects(projectId),userId TEXT NOT NULL REFERENCES people(userId),inboxId TEXT NOT NULL,read INTEGER NOT NULL CHECK(read IN (0,1)),cleared INTEGER NOT NULL CHECK(cleared IN (0,1)),snoozedUntil TEXT,PRIMARY KEY(projectId,userId,inboxId));
${TEAM_CRUX_WORKSPACE_TRIGGERS_SQL}
`
