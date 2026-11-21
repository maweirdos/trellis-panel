import { TEAM_COLLABORATION_SQL } from './collaboration-schema'
import { TEAM_INVITATIONS_SQL } from './invitations-schema'
import { TEAM_CRUX_WORKSPACE_SQL } from './crux-workspace-schema'
import { TEAM_LOCAL_AUTH_SQL } from './local-auth-schema'
import { TEAM_CREATIONS_SQL } from './creations-schema'
import { TEAM_TASK_PROGRESS_SQL } from './task-progress-schema'
import { TEAM_CODE_RESOURCES_SQL } from './code-resources-schema'
import { TEAM_TASK_MATERIALS_SQL, TASK_SOURCE_PARTS_SQL } from './task-materials-schema'
import { TEAM_CONTENT_SQL } from './content-schema'
import { TEAM_GOVERNANCE_SQL } from './governance-schema'
import { TEAM_TASK_EXECUTIONS_SQL, TEAM_TASK_EXECUTION_BOUNDARY_SQL } from './task-executions-schema'
import { TEAM_IMPORTS_SQL } from './imports-schema'
import { TEAM_EXECUTION_INPUTS_SQL } from './execution-inputs-schema'
import { TEAM_JIRA_BUSINESS_HOOKS_SQL } from './jira-business-hooks-schema'
import { TEAM_CUTOVERS_SQL } from './cutovers-schema'
import { TEAM_FEISHU_MEMBERS_SQL } from './integrations/feishu-member-schema'
export const TEAM_SCHEMA_VERSION = 25
export const TEAM_INVITATION_SPACES_SQL = `CREATE TABLE IF NOT EXISTS invitation_spaces(invitationId TEXT PRIMARY KEY REFERENCES invitations(invitationId),spaceId TEXT NOT NULL,spaceName TEXT NOT NULL,workspaceRevision INTEGER NOT NULL,workspaceEpoch TEXT NOT NULL);`
export const TEAM_INVITATION_SPACE_IDENTITY_SQL = `
ALTER TABLE invitation_spaces ADD COLUMN spaceCreatedAt TEXT;
ALTER TABLE invitation_spaces ADD COLUMN accessRevoked INTEGER NOT NULL DEFAULT 0 CHECK(accessRevoked IN (0,1));
UPDATE invitation_spaces SET spaceCreatedAt = (
 SELECT json_extract(s.value,'$.createdAt') FROM invitations i JOIN crux_workspaces w ON w.projectId=i.projectId, json_each(CASE WHEN json_valid(w.snapshotJson) THEN w.snapshotJson ELSE '{}' END,'$.spaces') s
 WHERE i.invitationId=invitation_spaces.invitationId AND w.revision=invitation_spaces.workspaceRevision
 AND invitation_spaces.workspaceEpoch=(SELECT value FROM team_meta WHERE key='epoch')
 AND json_valid(w.snapshotJson) AND json_extract(s.value,'$.id')=invitation_spaces.spaceId
 GROUP BY i.invitationId HAVING COUNT(*)=1 AND typeof(json_extract(s.value,'$.createdAt'))='text'
);
CREATE INDEX IF NOT EXISTS invitations_project_pending ON invitations(projectId,status,invitationId);
CREATE TRIGGER IF NOT EXISTS invitation_space_access_revoked AFTER UPDATE OF snapshotJson ON crux_workspaces
WHEN json_valid(OLD.snapshotJson) AND json_valid(NEW.snapshotJson)
BEGIN
 UPDATE invitation_spaces SET accessRevoked=1 WHERE accessRevoked=0 AND spaceCreatedAt IS NOT NULL
 AND invitationId IN (SELECT invitationId FROM invitations WHERE projectId=NEW.projectId AND status='pending')
 AND (EXISTS (
   SELECT 1 FROM invitations i, json_each(OLD.snapshotJson,'$.spaces') oldSpace, json_each(oldSpace.value,'$.memberIds') oldMember
   WHERE i.invitationId=invitation_spaces.invitationId AND json_extract(oldSpace.value,'$.id')=invitation_spaces.spaceId
   AND json_extract(oldSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt
   AND (oldMember.value=i.createdBy OR EXISTS (
     SELECT 1 FROM people p WHERE p.userId=oldMember.value AND p.issuer=i.recipientIssuer AND
       ((json_extract(i.recipientJson,'$.kind')='person' AND p.userId=json_extract(i.recipientJson,'$.userId')) OR
        (json_extract(i.recipientJson,'$.kind')='local' AND p.subject=json_extract(i.recipientJson,'$.username')) OR
        (json_extract(i.recipientJson,'$.kind')='oidc-subject' AND p.subject=json_extract(i.recipientJson,'$.subject')))
   ))
   AND NOT EXISTS (SELECT 1 FROM json_each(NEW.snapshotJson,'$.spaces') newSpace, json_each(newSpace.value,'$.memberIds') newMember
     WHERE json_extract(newSpace.value,'$.id')=invitation_spaces.spaceId AND json_extract(newSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt AND newMember.value=oldMember.value)
 ) OR EXISTS (
   SELECT 1 FROM json_each(OLD.snapshotJson,'$.spaces') oldSpace
   WHERE json_extract(oldSpace.value,'$.id')=invitation_spaces.spaceId AND json_extract(oldSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt
   AND NOT EXISTS (SELECT 1 FROM json_each(NEW.snapshotJson,'$.spaces') newSpace WHERE json_extract(newSpace.value,'$.id')=invitation_spaces.spaceId
     AND json_extract(newSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt)
 ) OR EXISTS (
   SELECT 1 FROM invitations i, json_each(OLD.snapshotJson,'$.spaces') oldSpace
   WHERE i.invitationId=invitation_spaces.invitationId AND json_extract(oldSpace.value,'$.id')=invitation_spaces.spaceId
   AND json_extract(oldSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt AND json_extract(oldSpace.value,'$.ownerId')=i.createdBy
   AND NOT EXISTS (SELECT 1 FROM json_each(NEW.snapshotJson,'$.spaces') newSpace WHERE json_extract(newSpace.value,'$.id')=invitation_spaces.spaceId
     AND json_extract(newSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt AND json_extract(newSpace.value,'$.ownerId')=i.createdBy)
 ) OR EXISTS (
   SELECT 1 FROM invitations i, json_each(OLD.snapshotJson,'$.spaces') oldSpace, json_each(NEW.snapshotJson,'$.spaces') newSpace
   WHERE i.invitationId=invitation_spaces.invitationId AND json_extract(oldSpace.value,'$.id')=invitation_spaces.spaceId
   AND json_extract(oldSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt AND COALESCE(json_extract(oldSpace.value,'$.visibility'),'public')<>'private'
   AND json_extract(newSpace.value,'$.id')=invitation_spaces.spaceId AND json_extract(newSpace.value,'$.createdAt')=invitation_spaces.spaceCreatedAt
   AND json_extract(newSpace.value,'$.visibility')='private'
   AND NOT EXISTS (SELECT 1 FROM json_each(newSpace.value,'$.memberIds') member WHERE member.value=i.createdBy)
 ));
END;
`
export const TEAM_DEVICES_SQL = `CREATE TABLE devices(deviceId TEXT PRIMARY KEY,pairingId TEXT UNIQUE NOT NULL,credentialHash TEXT UNIQUE NOT NULL,projectId TEXT REFERENCES projects(projectId),ownerId TEXT REFERENCES people(userId),deviceName TEXT NOT NULL,capabilityClaimsJson TEXT NOT NULL,status TEXT NOT NULL,userCode TEXT NOT NULL,expiresAt INTEGER NOT NULL,lastSeenAt INTEGER,sequence INTEGER NOT NULL DEFAULT -1,createdAt INTEGER NOT NULL);`
export const TEAM_SCHEMA_SQL = `
CREATE TABLE team_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE people(userId TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,displayName TEXT NOT NULL,active INTEGER NOT NULL,isPlatformAdmin INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,createdAt INTEGER NOT NULL,UNIQUE(issuer,subject));
CREATE TABLE login_attempts(attemptHash TEXT PRIMARY KEY,state TEXT NOT NULL,nonce TEXT NOT NULL,verifier TEXT NOT NULL,returnTo TEXT NOT NULL,expiresAt INTEGER NOT NULL);
CREATE TABLE sessions(sessionHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES people(userId),csrfToken TEXT NOT NULL,expiresAt INTEGER NOT NULL,createdAt INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(userId);
CREATE TABLE teams(teamId TEXT PRIMARY KEY,name TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE team_members(teamId TEXT NOT NULL REFERENCES teams(teamId),userId TEXT NOT NULL REFERENCES people(userId),rolesJson TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(teamId,userId));
CREATE TABLE projects(projectId TEXT PRIMARY KEY,teamId TEXT NOT NULL REFERENCES teams(teamId),name TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE project_members(projectId TEXT NOT NULL REFERENCES projects(projectId),userId TEXT NOT NULL REFERENCES people(userId),rolesJson TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(projectId,userId));
CREATE TABLE materials(materialId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(projectId),teamId TEXT NOT NULL REFERENCES teams(teamId),ownerId TEXT NOT NULL REFERENCES people(userId),latestVersion INTEGER NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE blobs(bodyDigest TEXT PRIMARY KEY,byteLength INTEGER NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE material_versions(materialId TEXT NOT NULL REFERENCES materials(materialId),version INTEGER NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,visibility TEXT NOT NULL,bodyDigest TEXT NOT NULL REFERENCES blobs(bodyDigest),sourceJson TEXT NOT NULL,authorId TEXT NOT NULL REFERENCES people(userId),createdAt INTEGER NOT NULL,PRIMARY KEY(materialId,version));
CREATE TABLE feedback(feedbackId TEXT PRIMARY KEY,materialId TEXT NOT NULL,version INTEGER NOT NULL,authorId TEXT NOT NULL REFERENCES people(userId),body TEXT NOT NULL,quote TEXT,anchorJson TEXT,createdAt INTEGER NOT NULL,FOREIGN KEY(materialId,version) REFERENCES material_versions(materialId,version));
${TEAM_DEVICES_SQL}
CREATE TABLE commands(userId TEXT NOT NULL REFERENCES people(userId),commandId TEXT NOT NULL,kind TEXT NOT NULL,requestHash TEXT NOT NULL,resultJson TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(userId,commandId));
CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,eventId TEXT UNIQUE NOT NULL,type TEXT NOT NULL,audienceKind TEXT NOT NULL,audienceId TEXT NOT NULL,projectId TEXT,occurredAt INTEGER NOT NULL,payloadJson TEXT NOT NULL);
CREATE INDEX events_project ON events(projectId,sequence);
${TEAM_COLLABORATION_SQL}
${TEAM_INVITATIONS_SQL}
${TEAM_INVITATION_SPACES_SQL}
${TEAM_CRUX_WORKSPACE_SQL}
${TEAM_INVITATION_SPACE_IDENTITY_SQL}
${TEAM_LOCAL_AUTH_SQL}
${TEAM_CREATIONS_SQL}
${TEAM_TASK_PROGRESS_SQL}
${TEAM_CODE_RESOURCES_SQL}
${TEAM_TASK_MATERIALS_SQL}
${TASK_SOURCE_PARTS_SQL}
${TEAM_CONTENT_SQL}
${TEAM_GOVERNANCE_SQL}
${TEAM_TASK_EXECUTIONS_SQL}
${TEAM_TASK_EXECUTION_BOUNDARY_SQL}
${TEAM_IMPORTS_SQL}
${TEAM_EXECUTION_INPUTS_SQL}
${TEAM_JIRA_BUSINESS_HOOKS_SQL}
${TEAM_CUTOVERS_SQL}
${TEAM_FEISHU_MEMBERS_SQL}
`
