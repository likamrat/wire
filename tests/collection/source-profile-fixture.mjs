import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";

export const profileWorkspaceId = "00000000-0000-4000-8000-000000000081";
export const profileProjectId = "00000000-0000-4000-8000-000000000082";
function syntheticAvatar() {
    const chunk = (type, bytes) => {
        const body = Buffer.concat([Buffer.from(type), bytes]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
        size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([size, body, checksum]);
    };
    const header = Buffer.alloc(13), rows = Buffer.alloc(32 * 97);
    header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const figure = (x - 16) ** 2 + (y - 11) ** 2 < 25 || y > 19 && (x - 16) ** 2 + (y - 30) ** 2 < 100;
        Buffer.from(figure ? [172, 223, 232] : [38, 91, 111]).copy(rows, y * 97 + 1 + x * 3);
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
export const profilePNG = syntheticAvatar();

export async function createProfileSource(root) {
    const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    await mkdir(sessionRoot, { recursive: true });
    const db = new DatabaseSync(appDbPath);
    db.exec(metadata174Schema + `
        PRAGMA user_version=207;
        ALTER TABLE projects ADD COLUMN github_account_id TEXT;
        CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
        CREATE TABLE accounts(id TEXT PRIMARY KEY,login TEXT,name TEXT,host TEXT,kind TEXT,is_default INTEGER,
            created_at TEXT,settings_json TEXT,access_token TEXT);
        CREATE TABLE project_account_hints(project_id TEXT PRIMARY KEY,account_login TEXT,account_host TEXT);
    `);
    const add = db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)");
    add.run("default", "riley_managed", "Riley Chen", "github.com", "github", 1, "2026-01-01",
        JSON.stringify({ avatarUrl: "https://avatars.githubusercontent.com/u/70001?v=4", privateUnrelatedSetting: "DO-NOT-PROJECT" }), "DO-NOT-READ");
    add.run("workspace", "synthetic-morgan", "Morgan Rivera", "github.com", "github", 0, "2026-01-02",
        JSON.stringify({ avatarUrl: "https://avatars.githubusercontent.com/u/70002?v=4" }), "DO-NOT-READ");
    add.run("microsoft", "unrelated@example.invalid", "Not the GitHub profile", "login.example.invalid", "microsoft", 0, "2025-01-01", "{}", "DO-NOT-READ");
    db.prepare("INSERT INTO projects(id,name,github_account_id) VALUES(?,?,?)").run(profileProjectId, "Invented project", "workspace");
    db.prepare("INSERT INTO workspaces(id,project_id,workspace_type,name) VALUES(?,?,?,?)")
        .run(profileWorkspaceId, profileProjectId, "worktree", "Invented workspace");
    db.prepare("INSERT INTO app_state(key,value) VALUES('activeWorkspaceId',?)").run(profileWorkspaceId);
    return { db, appDbPath, sessionRoot };
}
