/** Metadata only. Captured content uses the existing immutable blob owner. */
export const TEAM_EXECUTION_INPUTS_SQL = `
CREATE TABLE IF NOT EXISTS team_task_execution_inputs(
 executionId TEXT PRIMARY KEY REFERENCES team_task_executions(executionId),
 recordJson TEXT NOT NULL
);
`
