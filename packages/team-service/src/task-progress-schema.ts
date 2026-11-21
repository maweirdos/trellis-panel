/** Immutable, body-free command identities live until their owning task is removed. */
export const TEAM_TASK_PROGRESS_IDENTITIES_SQL = `
CREATE TABLE IF NOT EXISTS crux_task_progress_commands(
 projectId TEXT NOT NULL,taskId TEXT NOT NULL,commandId TEXT NOT NULL,userId TEXT NOT NULL REFERENCES people(userId),
 ownerKey TEXT NOT NULL,requestHash TEXT NOT NULL,PRIMARY KEY(userId,commandId),
 FOREIGN KEY(projectId,taskId) REFERENCES crux_task_progress(projectId,taskId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS crux_task_progress_commands_scope ON crux_task_progress_commands(projectId,taskId);
`

export const TEAM_TASK_PROGRESS_RECEIPTS_INDEX_SQL = 'CREATE INDEX crux_task_progress_receipts_bound ON crux_task_progress_receipts(projectId,taskId,createdAt);'

export const TEAM_TASK_PROGRESS_SQL = `
CREATE TABLE crux_task_progress(
 projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,spaceId TEXT NOT NULL,
 epoch TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=0),fence TEXT NOT NULL,
 bindingJson TEXT,progressJson TEXT,ownerKey TEXT,PRIMARY KEY(projectId,taskId)
);
CREATE TABLE crux_task_progress_receipts(
 projectId TEXT NOT NULL,taskId TEXT NOT NULL,commandId TEXT NOT NULL,userId TEXT NOT NULL REFERENCES people(userId),
 ownerKey TEXT NOT NULL,requestHash TEXT NOT NULL,receiptJson TEXT NOT NULL,createdAt INTEGER NOT NULL,
 PRIMARY KEY(userId,commandId),
 FOREIGN KEY(projectId,taskId) REFERENCES crux_task_progress(projectId,taskId) ON DELETE CASCADE
);
${TEAM_TASK_PROGRESS_RECEIPTS_INDEX_SQL}
${TEAM_TASK_PROGRESS_IDENTITIES_SQL}
`
