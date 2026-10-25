/** Installed independently for existing workspaces by the team writer's v8 migration. */
export const TEAM_HIFOX_WORKSPACE_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS hifox_workspace_project_member_insert AFTER INSERT ON project_members BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId=NEW.projectId;
END;
CREATE TRIGGER IF NOT EXISTS hifox_workspace_project_member_update AFTER UPDATE OF active,rolesJson ON project_members WHEN NEW.active<>OLD.active OR NEW.rolesJson<>OLD.rolesJson BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId=NEW.projectId;
END;
CREATE TRIGGER IF NOT EXISTS hifox_workspace_project_member_delete AFTER DELETE ON project_members BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId=OLD.projectId;
END;
CREATE TRIGGER IF NOT EXISTS hifox_workspace_team_member_insert AFTER INSERT ON team_members BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT pm.projectId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId WHERE pm.userId=NEW.userId AND p.teamId=NEW.teamId);
END;
CREATE TRIGGER IF NOT EXISTS hifox_workspace_team_member_update AFTER UPDATE OF active ON team_members WHEN NEW.active<>OLD.active BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT pm.projectId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId WHERE pm.userId=NEW.userId AND p.teamId=NEW.teamId);
END;
CREATE TRIGGER IF NOT EXISTS hifox_workspace_team_member_delete AFTER DELETE ON team_members BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT pm.projectId FROM project_members pm JOIN projects p ON p.projectId=pm.projectId WHERE pm.userId=OLD.userId AND p.teamId=OLD.teamId);
END;
CREATE TRIGGER IF NOT EXISTS hifox_workspace_person_update AFTER UPDATE OF active,displayName ON people WHEN NEW.active<>OLD.active OR NEW.displayName<>OLD.displayName BEGIN
 UPDATE hifox_workspaces SET revision=revision+1,updatedAt=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE projectId IN (SELECT projectId FROM project_members WHERE userId=NEW.userId);
END;
`

export const TEAM_HIFOX_WORKSPACE_SQL = `
CREATE TABLE hifox_workspaces(projectId TEXT PRIMARY KEY REFERENCES projects(projectId),revision INTEGER NOT NULL CHECK(revision>=0),snapshotJson TEXT NOT NULL,updatedAt INTEGER NOT NULL);
CREATE TABLE hifox_inbox_preferences(projectId TEXT NOT NULL REFERENCES projects(projectId),userId TEXT NOT NULL REFERENCES people(userId),inboxId TEXT NOT NULL,read INTEGER NOT NULL CHECK(read IN (0,1)),cleared INTEGER NOT NULL CHECK(cleared IN (0,1)),snoozedUntil TEXT,PRIMARY KEY(projectId,userId,inboxId));
${TEAM_HIFOX_WORKSPACE_TRIGGERS_SQL}
`
