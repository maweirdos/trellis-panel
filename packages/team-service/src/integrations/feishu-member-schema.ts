export const TEAM_FEISHU_MEMBERS_SQL = `
CREATE TABLE feishu_member_codes(
 codeHash TEXT PRIMARY KEY,
 projectId TEXT NOT NULL REFERENCES projects(projectId),
 spaceId TEXT NOT NULL,
 spaceCreatedAt TEXT NOT NULL,
 actorId TEXT NOT NULL REFERENCES people(userId),
 epoch TEXT NOT NULL,
 expiresAt INTEGER NOT NULL,
 UNIQUE(projectId,spaceId,actorId)
);
CREATE INDEX feishu_member_codes_expiry ON feishu_member_codes(expiresAt);
CREATE TABLE feishu_member_bindings(
 bindingId TEXT PRIMARY KEY,
 projectId TEXT NOT NULL REFERENCES projects(projectId),
 spaceId TEXT NOT NULL,
 spaceCreatedAt TEXT NOT NULL,
 appId TEXT NOT NULL,
 tenantKey TEXT NOT NULL,
 senderOpenId TEXT NOT NULL,
 actorId TEXT NOT NULL REFERENCES people(userId),
 ownerId TEXT NOT NULL REFERENCES people(userId),
 deviceId TEXT NOT NULL REFERENCES devices(deviceId),
 epoch TEXT NOT NULL,
 linkedAt INTEGER NOT NULL,
 revokedAt INTEGER
);
CREATE UNIQUE INDEX feishu_member_identity ON feishu_member_bindings(epoch,projectId,spaceId,appId,tenantKey,senderOpenId) WHERE revokedAt IS NULL;
CREATE UNIQUE INDEX feishu_member_actor_app ON feishu_member_bindings(epoch,projectId,spaceId,actorId,appId) WHERE revokedAt IS NULL;
CREATE UNIQUE INDEX feishu_member_command_event ON commands(commandId) WHERE kind='feishuTaskCommand';
`
