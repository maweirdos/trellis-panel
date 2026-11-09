/** Writer admission only; retained operations never undo committed task state. */
export const TEAM_CUTOVERS_SQL = `
CREATE TABLE team_cutover_operations(operationId TEXT PRIMARY KEY,namespaceId TEXT NOT NULL REFERENCES import_namespaces(namespaceId),workcopyDigest TEXT NOT NULL,recordJson TEXT NOT NULL);
CREATE INDEX team_cutover_scope ON team_cutover_operations(namespaceId,workcopyDigest);
CREATE TABLE team_cutover_heads(namespaceId TEXT NOT NULL REFERENCES import_namespaces(namespaceId),workcopyDigest TEXT NOT NULL,operationId TEXT NOT NULL REFERENCES team_cutover_operations(operationId),revision INTEGER NOT NULL CHECK(revision>0),PRIMARY KEY(namespaceId,workcopyDigest));
CREATE TABLE team_cutover_task_fences(projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,spaceId TEXT NOT NULL,taskCreatedAt TEXT NOT NULL,operationId TEXT NOT NULL REFERENCES team_cutover_operations(operationId),PRIMARY KEY(projectId,taskId,spaceId,taskCreatedAt));
CREATE TABLE team_cutover_commands(commandId TEXT PRIMARY KEY,operationId TEXT NOT NULL REFERENCES team_cutover_operations(operationId),bodyJson TEXT NOT NULL,receiptJson TEXT NOT NULL);
CREATE INDEX team_cutover_commands_operation ON team_cutover_commands(operationId);
`
