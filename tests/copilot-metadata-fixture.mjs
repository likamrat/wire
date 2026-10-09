// Minimal projection of the inspected 174 mapping, not a copy of an app database.
// Unconsumed columns are omitted; all rows supplied by tests are invented.
export const metadata174Schema = `
    PRAGMA user_version=174;
    CREATE TABLE sessions(
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT,
        session_type TEXT NOT NULL DEFAULT 'workspace',
        execution_location TEXT NOT NULL DEFAULT 'local',
        archived_at TEXT,
        lifecycle_generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE projects(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE workspaces(
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_type TEXT NOT NULL CHECK(workspace_type IN ('worktree', 'branch', 'folder', 'cloud')),
        name TEXT NOT NULL,
        created_by TEXT CHECK(created_by IN ('agent', 'user')),
        creator_session_id TEXT,
        archived_at TEXT,
        session_id TEXT,
        host_id TEXT NOT NULL DEFAULT 'local'
    );
    CREATE UNIQUE INDEX idx_workspaces_session ON workspaces(session_id) WHERE session_id IS NOT NULL;
`;
