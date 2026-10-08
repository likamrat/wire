import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BoardError } from "./store.mjs";

export const SOURCE_ADAPTER = "copilot-app-sqlite-v156";
const supportedSchemaVersions = [156, 166];
export const DISCOVERY_LIMITS = Object.freeze({ pageSize: 250, maxSessions: 10000, maxWorkspaces: 20000 });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const columns = {
    sessions: ["id", "title", "session_type", "archived_at", "execution_location"],
    workspaces: ["id", "session_id", "project_id", "name", "archived_at", "host_id", "workspace_type"],
    projects: ["id", "name"],
};

export function sourceDefaults(env = process.env) {
    const root = env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
    return { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
}

export function validateSourcePaths(config) {
    if (!path.isAbsolute(config?.appDbPath ?? "") || !path.isAbsolute(config?.sessionRoot ?? "")
        || path.basename(config.appDbPath).toLowerCase() !== "data.db"
        || path.basename(config.sessionRoot).toLowerCase() !== "session-state") {
        throw new BoardError("Choose the Copilot app's absolute data.db path and CLI session-state directory. No other file tree is scanned.", 422);
    }
}

export async function detectSource() {
    const candidate = sourceDefaults();
    try {
        validateSourcePaths(candidate);
        const [db, root] = await Promise.all([stat(candidate.appDbPath), stat(candidate.sessionRoot)]);
        if (!db.isFile() || !root.isDirectory()) throw new BoardError("The suggested local Copilot source is unavailable.", 422);
        return { ...candidate, available: true, basis: "COPILOT_HOME or documented default ~/.copilot; named app metadata only. Approval required before reading GitHub Copilot chats." };
    } catch (error) {
        return { ...candidate, available: false, error: error instanceof BoardError ? error.message : `Local source not found (${error.code ?? "SOURCE_UNAVAILABLE"}). Choose paths below.` };
    }
}

export function discoverSources(config) {
    validateSourcePaths(config);
    let db;
    try {
        db = new DatabaseSync(config.appDbPath, { readOnly: true, timeout: 1000 });
        db.exec("PRAGMA query_only=ON; BEGIN");
        const version = db.prepare("PRAGMA user_version").get().user_version;
        if (!supportedSchemaVersions.includes(version)) throw new BoardError(`Unsupported Copilot app metadata version ${version}. This read-only adapter supports versions ${supportedSchemaVersions.join(" and ")}; no history was replaced.`, 422);
        let creatorColumns = false;
        for (const [table, required] of Object.entries(columns)) {
            const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
            if (required.some(name => !actual.includes(name))) throw new BoardError(`Unsupported ${table} mapping in the local app database. No history was replaced.`, 422);
            if (table === "workspaces") creatorColumns = ["created_by", "creator_session_id"].every(name => actual.includes(name));
        }
        let pages = 0;
        function readPages(table, fields, limit) {
            const total = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
            const rows = [];
            let after = "";
            while (rows.length < Math.min(total, limit)) {
                const page = db.prepare(`SELECT ${fields} FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`).all(after, Math.min(DISCOVERY_LIMITS.pageSize, limit - rows.length));
                pages++;
                if (!page.length) break;
                rows.push(...page);
                after = page.at(-1).id;
            }
            return { total, rows };
        }
        const sessions = readPages("sessions", columns.sessions.join(","), DISCOVERY_LIMITS.maxSessions);
        const workspaces = readPages("workspaces", columns.workspaces.join(",") + (creatorColumns ? ",created_by,creator_session_id" : ""), DISCOVERY_LIMITS.maxWorkspaces);
        // An incomplete workspace map cannot establish that an apparently standalone session is active/local.
        if (workspaces.total > workspaces.rows.length) throw new BoardError("Workspace mapping exceeds the 20,000-row safety bound. Collection paused without replacing last good data.", 422);
        const mappings = new Map();
        for (const workspace of workspaces.rows) {
            const id = workspace.session_id;
            if (!mappings.has(id)) mappings.set(id, []);
            mappings.get(id).push(workspace);
        }
        const checkedAt = new Date().toISOString();
        const projectName = db.prepare("SELECT name FROM projects WHERE id=?");
        const roster = sessions.rows.map(session => {
            const mapped = mappings.get(session.id) ?? [];
            const active = mapped.filter(w => !w.archived_at);
            const workspace = active[0] ?? mapped[0];
            const row = {
                adapter: SOURCE_ADAPTER,
                sessionId: session.id, appId: workspace?.id ?? session.id, appUrl: null,
                name: workspace?.name ?? session.title ?? "Chat name not recorded",
                projectId: workspace?.project_id ?? null,
                projectType: workspace?.workspace_type === "folder" ? "folder" : ["worktree", "branch"].includes(workspace?.workspace_type) ? "repository" : null,
                project: workspace?.project_id ? projectName.get(workspace.project_id)?.name ?? null : null,
                checkedAt, archivedAt: session.archived_at ?? (mapped.length && !active.length ? workspace.archived_at : null),
                workspaceIds: mapped.map(w => w.id), activeWorkspaceIds: active.map(w => w.id),
                archiveEvidence: { sessionArchivedAt: session.archived_at, workspaces: mapped.map(w => ({ id: w.id, archivedAt: w.archived_at, hostId: w.host_id })) },
                promptCreation: active.length === 1 && workspace.created_by === "agent" && UUID.test(workspace.creator_session_id)
                    ? { actor: "agent", creatorSessionId: workspace.creator_session_id } : null,
                eligible: false, disposition: "eligible",
            };
            if (!UUID.test(session.id)) row.disposition = "unmapped-invalid-id";
            else if (row.archivedAt) row.disposition = "archived";
            else if (session.execution_location !== "local" || active.some(w => w.host_id !== "local" || w.workspace_type === "cloud")) row.disposition = "nonlocal-not-read";
            else if (new Set(active.map(w => w.project_id)).size > 1) row.disposition = "ambiguous-project-mapping";
            else if (!mapped.length && !["chat", "standalone", "general_chat", "side_chat", "cli_session", "workflow"].includes(session.session_type)) row.disposition = "unmapped-workspace-session";
            else row.eligible = true;
            return row;
        });
        const known = new Set(sessions.rows.map(s => s.id));
        const orphanWorkspaces = workspaces.rows.filter(w => !w.session_id || !known.has(w.session_id));
        const dispositions = {};
        for (const row of roster) dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
        return {
            adapter: SOURCE_ADAPTER, schemaVersion: version, checkedAt, roster,
            counts: {
                sessions: sessions.total, enumerated: roster.length, eligible: roster.filter(r => r.eligible).length,
                workspaces: workspaces.total, unmappedWorkspaces: orphanWorkspaces.length, pages,
                skippedByLimit: sessions.total - roster.length, dispositions,
            },
            unmappedWorkspaces: orphanWorkspaces.map(w => ({ appId: w.id, sessionId: w.session_id, disposition: "missing-or-out-of-bound-session-mapping" })),
            limits: DISCOVERY_LIMITS,
        };
    } catch (error) {
        if (error instanceof BoardError) throw error;
        throw new BoardError(`Local Copilot metadata is disconnected (${error.code ?? "READ_FAILED"}). Last good evidence is preserved.`, 503);
    } finally { db?.close(); }
}
