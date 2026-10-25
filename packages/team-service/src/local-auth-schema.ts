export const TEAM_LOCAL_AUTH_SQL = `
CREATE TABLE IF NOT EXISTS local_credentials(userId TEXT PRIMARY KEY REFERENCES people(userId),username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,passwordHash TEXT NOT NULL,algorithm TEXT NOT NULL,createdAt INTEGER NOT NULL);
`
