/** Execution history and command receipts survive latest-progress invalidation. */
export const TEAM_TASK_EXECUTIONS_SQL = `
CREATE TABLE team_task_execution_heads(
 projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=0),
 activeExecutionId TEXT,PRIMARY KEY(projectId,taskId)
);
CREATE TABLE team_task_executions(
 executionId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,
 authority TEXT NOT NULL CHECK(authority IN ('active','released','revoked')),ownerKey TEXT NOT NULL,actorJson TEXT NOT NULL,
 fence TEXT NOT NULL,recordJson TEXT NOT NULL
);
CREATE UNIQUE INDEX team_task_execution_writer ON team_task_executions(projectId,taskId) WHERE authority='active';
CREATE INDEX team_task_execution_history ON team_task_executions(projectId,taskId,executionId);
`

/** Retained v18 rows remain unknown; current inputs cannot reconstruct their original business boundary. */
export const TEAM_TASK_EXECUTION_BOUNDARY_SQL = 'ALTER TABLE team_task_executions ADD COLUMN businessBoundaryJson TEXT;'
