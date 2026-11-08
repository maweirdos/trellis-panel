export const TEAM_JIRA_BUSINESS_HOOKS_SQL = `
CREATE TABLE IF NOT EXISTS jira_business_task_mappings(
 projectId TEXT NOT NULL REFERENCES projects(projectId),
 mappingId TEXT PRIMARY KEY,
 instanceId TEXT NOT NULL,
 issueId TEXT NOT NULL,
 recordJson TEXT NOT NULL CHECK(length(recordJson)<=65536),
 createdAt INTEGER NOT NULL,
 updatedAt INTEGER NOT NULL,
 UNIQUE(projectId,instanceId,issueId)
);
CREATE INDEX IF NOT EXISTS jira_business_task_mappings_task ON jira_business_task_mappings(projectId,json_extract(recordJson,'$.task.taskId'),json_extract(recordJson,'$.task.spaceId'),json_extract(recordJson,'$.task.taskCreatedAt'));
CREATE TABLE IF NOT EXISTS jira_business_effects(
 projectId TEXT NOT NULL REFERENCES projects(projectId),
 effectId TEXT NOT NULL,
 requestDigest TEXT NOT NULL CHECK(length(requestDigest)=64),
 recordJson TEXT NOT NULL CHECK(length(recordJson)<=65536),
 createdAt INTEGER NOT NULL,
 PRIMARY KEY(projectId,effectId)
);
CREATE INDEX IF NOT EXISTS jira_business_effects_task ON jira_business_effects(projectId,json_extract(recordJson,'$.task.taskId'),json_extract(recordJson,'$.task.spaceId'),json_extract(recordJson,'$.task.taskCreatedAt'));
CREATE TABLE IF NOT EXISTS jira_business_routes(
 projectId TEXT NOT NULL REFERENCES projects(projectId), routeId TEXT NOT NULL,
 recordJson TEXT NOT NULL CHECK(length(recordJson)<=65536), PRIMARY KEY(projectId,routeId)
);
CREATE TABLE IF NOT EXISTS jira_business_dispatches(
 projectId TEXT NOT NULL REFERENCES projects(projectId), effectId TEXT NOT NULL, routeId TEXT NOT NULL,
 recordJson TEXT NOT NULL CHECK(length(recordJson)<=65536), createdAt INTEGER NOT NULL,
 PRIMARY KEY(projectId,effectId)
);
CREATE INDEX IF NOT EXISTS jira_business_dispatches_worker ON jira_business_dispatches(projectId,routeId,createdAt);
`
