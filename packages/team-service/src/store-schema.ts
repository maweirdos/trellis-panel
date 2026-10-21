import { TEAM_COLLABORATION_SQL } from './collaboration-schema'
export const TEAM_SCHEMA_VERSION = 4
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
`
