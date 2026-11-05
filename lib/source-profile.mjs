import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const SOURCE_PROFILE_ADAPTER = "copilot-app-display-v207";
export const SOURCE_PROFILE_MAX_BYTES = 16384;
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export const validSourceProfileLogin = value => text(value, 100) && /^[a-z\d][a-z\d_-]*$/i.test(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const githubKinds = "(kind IS NULL OR kind IN ('github','github_enterprise_server'))";

export function unavailableSourceProfile(reason) {
    return { adapter: SOURCE_PROFILE_ADAPTER, state: "unavailable", reason, selection: null, account: null, revision: digest(reason) };
}

export function validateSourceProfile(value) {
    const invalid = () => Object.assign(new Error("The app profile projection is invalid."), { code: "source_metadata_invalid", status: 503 });
    if (value?.adapter !== SOURCE_PROFILE_ADAPTER || !/^[a-f0-9]{64}$/.test(value.revision ?? "")
        || !["available", "unavailable"].includes(value.state)) throw invalid();
    if (value.state === "unavailable") {
        if (!/^[a-z][a-z-]{0,80}$/.test(value.reason ?? "") || value.account !== null || value.selection !== null) throw invalid();
    } else {
        const account = value.account;
        if (value.reason !== null || !["workspace", "default", "first-github"].includes(value.selection)
            || !account || !text(account.id, 1024) || !validSourceProfileLogin(account.login) || account.host !== "github.com"
            || account.name !== null && !text(account.name, 200)
            || account.avatarUrl !== null && !text(account.avatarUrl, 2048)) throw invalid();
    }
    if (Buffer.byteLength(JSON.stringify(value)) > SOURCE_PROFILE_MAX_BYTES) throw invalid();
    return value;
}

// The desktop resolves its recorded active workspace's linked GitHub account,
// then the default GitHub account, then the first GitHub account in creation order.
export function readSourceProfileProjection(file) {
    let db;
    try {
        db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
        db.exec("PRAGMA query_only=ON; BEGIN");
        const version = db.prepare("PRAGMA user_version").get().user_version;
        const mappings = {
            accounts: { id: "TEXT", login: "TEXT", name: "TEXT", host: "TEXT", kind: "TEXT", is_default: "INTEGER", created_at: "TEXT", settings_json: "TEXT" },
            app_state: { key: "TEXT", value: "TEXT" },
            workspaces: { id: "TEXT", project_id: "TEXT" },
            projects: { id: "TEXT", github_account_id: "TEXT" },
            project_account_hints: { project_id: "TEXT" },
        };
        if (!Number.isSafeInteger(version) || version < 207) return unavailableSourceProfile("app-profile-schema-unsupported");
        for (const [table, fields] of Object.entries(mappings)) {
            if (db.prepare(`PRAGMA main.table_list(${table})`).get()?.type !== "table") return unavailableSourceProfile("app-profile-schema-unsupported");
            const columns = new Map(db.prepare(`PRAGMA main.table_xinfo(${table})`).all().map(column => [column.name, column]));
            if (Object.entries(fields).some(([name, type]) => columns.get(name)?.type.toUpperCase() !== type || columns.get(name)?.hidden !== 0)
                || columns.get(table === "app_state" ? "key" : table === "project_account_hints" ? "project_id" : "id")?.pk !== 1) {
                return unavailableSourceProfile("app-profile-schema-unsupported");
            }
        }
        const active = db.prepare("SELECT value FROM app_state WHERE key='activeWorkspaceId'").get()?.value ?? null;
        if (active !== null && !text(active, 1024)) return unavailableSourceProfile("app-profile-context-invalid");
        const project = active ? db.prepare(
            "SELECT p.id,p.github_account_id FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(active) : null;
        let id = project?.github_account_id ?? null, selection = "workspace";
        if (id !== null && !text(id, 1024)) return unavailableSourceProfile("app-profile-context-invalid");
        if (!id && project && db.prepare("SELECT 1 FROM project_account_hints WHERE project_id=?").get(project.id)) {
            return unavailableSourceProfile("app-account-relink-required");
        }
        if (id && !db.prepare(`SELECT 1 FROM accounts WHERE id=? AND ${githubKinds}`).get(id)) {
            return unavailableSourceProfile("app-account-relink-required");
        }
        if (!id) {
            const defaults = db.prepare(`SELECT id FROM accounts WHERE ${githubKinds} AND is_default=1 LIMIT 2`).all();
            if (defaults.length > 1) return unavailableSourceProfile("app-profile-selection-ambiguous");
            if (defaults.length) { id = defaults[0].id; selection = "default"; }
            else {
                const first = db.prepare(`SELECT id,created_at FROM accounts WHERE ${githubKinds} ORDER BY created_at ASC LIMIT 2`).all();
                if (!first.length) return unavailableSourceProfile("app-profile-signed-out");
                if (!text(first[0].created_at, 80) || first[1]?.created_at === first[0].created_at) {
                    return unavailableSourceProfile("app-profile-selection-ambiguous");
                }
                id = first[0].id; selection = "first-github";
            }
        }
        const account = db.prepare(`SELECT id,login,name,host,
            CASE WHEN length(settings_json)<=65536 AND json_valid(settings_json)
                THEN json_extract(settings_json,'$.avatarUrl') ELSE NULL END AS avatarUrl
            FROM accounts WHERE id=?`).get(id);
        if (account?.host !== "github.com") return unavailableSourceProfile("app-profile-host-unsupported");
        if (typeof account.name === "string") account.name = account.name.trim() || null;
        if (account.avatarUrl === "") account.avatarUrl = null;
        return validateSourceProfile({ adapter: SOURCE_PROFILE_ADAPTER, state: "available", reason: null, selection,
            account: { ...account }, revision: digest([selection, account]) });
    } catch (error) {
        if (error.code === "source_metadata_invalid") throw error;
        throw Object.assign(new Error("The approved Copilot app profile could not be read."), { code: "source_metadata_unavailable", status: 503 });
    } finally { db?.close(); }
}
