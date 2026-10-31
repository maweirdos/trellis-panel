export const TEAM_CONTENT_SQL = `
CREATE TABLE team_content_configs(
  teamId TEXT PRIMARY KEY REFERENCES teams(teamId),revision INTEGER NOT NULL,
  publicJson TEXT NOT NULL,credentialJson TEXT NOT NULL
);
CREATE TABLE team_content_jobs(
  jobId TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES people(userId),commandId TEXT NOT NULL,
  teamId TEXT NOT NULL REFERENCES teams(teamId),projectId TEXT REFERENCES projects(projectId),
  taskId TEXT,spaceId TEXT,taskCreatedAt TEXT,epoch TEXT NOT NULL,ownerKey TEXT NOT NULL,
  day TEXT NOT NULL,state TEXT NOT NULL,slotHeld INTEGER NOT NULL,reservation TEXT NOT NULL,
  reservedTokens INTEGER NOT NULL,inputTokens INTEGER,outputTokens INTEGER,cachedInputTokens INTEGER,
  recordJson TEXT NOT NULL,privateJson TEXT NOT NULL,dispatchHash TEXT NOT NULL,createdAt INTEGER NOT NULL,
  UNIQUE(userId,commandId)
);
CREATE INDEX team_content_jobs_budget ON team_content_jobs(teamId,day,userId);
CREATE INDEX team_content_jobs_slots ON team_content_jobs(teamId,slotHeld);
CREATE TABLE team_content_commands(
  userId TEXT NOT NULL REFERENCES people(userId),commandId TEXT NOT NULL,kind TEXT NOT NULL,
  requestHash TEXT NOT NULL,ownerKey TEXT NOT NULL,epoch TEXT NOT NULL,
  teamId TEXT NOT NULL REFERENCES teams(teamId),jobId TEXT REFERENCES team_content_jobs(jobId),resultJson TEXT NOT NULL,
  PRIMARY KEY(userId,commandId)
);
`
