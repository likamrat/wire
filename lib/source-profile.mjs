import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const SOURCE_PROFILE_ADAPTER = "copilot-app-display-v207";
export const SOURCE_PROFILE_MAX_BYTES = 16384;
export const SOURCE_CATALOG_MAX_BYTES = 128 * 1024;
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

const catalogText = (value, limit) => text(value, limit) && !/[\u202a-\u202e\u2066-\u2069]/u.test(value);
function catalog(accountId, entries = []) {
    return { entries, revision:digest([accountId, entries]) };
}
export function validateSourceModelCatalog(value) {
    if (!value || Object.keys(value).length !== 2 || !/^[a-f0-9]{64}$/.test(value.revision ?? "")
        || !Array.isArray(value.entries) || value.entries.length > 256 || !value.entries.every(row => Array.isArray(row)
            && row.length === 2 && catalogText(row[0],256) && catalogText(row[1],160))
        || new Set(value.entries.map(row => row[0])).size !== value.entries.length || Buffer.byteLength(JSON.stringify(value)) > SOURCE_CATALOG_MAX_BYTES) {
        throw Object.assign(new Error("Invalid app model catalog projection."),{code:"source_metadata_invalid",status:503});
    }
    return value;
}
function selectedCatalog(db, id) {
    const key = "copilot-available-models-v2";
    const valid = db.prepare(`SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=524288
        THEN json_valid(value) ELSE 0 END AS ok FROM app_state WHERE key=?`).get(key);
    if (!valid?.ok || !validSourceProfileLogin(db.prepare("SELECT login FROM accounts WHERE id=? AND host='github.com'").get(id)?.login)) return catalog(id);
    const root = db.prepare(`SELECT j.key, j.type FROM app_state a,json_each(a.value) j
        WHERE a.key=? AND j.key IN ('scopedModels','models','accountId')`).all(key);
    if (new Set(root.map(row => row.key)).size !== root.length) return catalog(id);
    const fields = new Map(root.map(row => [row.key,row.type]));
    if (fields.has("scopedModels") && fields.get("scopedModels") !== "object") return catalog(id);
    const scoped = db.prepare(`SELECT j.type FROM app_state a,json_each(a.value,'$.scopedModels') j WHERE a.key=? AND j.key=? LIMIT 2`).all(key,id);
    if (scoped.length && (scoped.length !== 1 || scoped[0].type !== "array")) return catalog(id);
    if (!scoped.length && (fields.get("models") !== "array" || fields.get("accountId") !== "text"
        || !db.prepare("SELECT 1 FROM app_state WHERE key=? AND json_extract(value,'$.accountId')=?").get(key,id))) return catalog(id);
    const list = scoped.length ? "SELECT j.value FROM app_state a,json_each(a.value,'$.scopedModels') j WHERE a.key=? AND j.key=?"
        : "SELECT json_extract(value,'$.models') FROM app_state WHERE key=?";
    const field = key => `CASE WHEN m.type='object' THEN (SELECT CASE WHEN count(*)=1 AND min(type)='text' THEN min(atom) END
        FROM json_each(m.value) WHERE key='${key}') END`;
    const rows = db.prepare(`SELECT ${field("id")} AS id, ${field("name")} AS name
        FROM json_each((${list})) m LIMIT 257`).all(...(scoped.length ? [key,id] : [key]));
    if (rows.length > 256) return catalog(id);
    const names = new Map();
    for (const row of rows) {
        if (!catalogText(row.id,256)) continue;
        const label = catalogText(row.name,160) ? row.name : null;
        names.set(row.id, !names.has(row.id) || names.get(row.id) === label ? label : null);
    }
    const result = catalog(id,[...names].filter(([,name]) => name !== null));
    return Buffer.byteLength(JSON.stringify(result)) <= SOURCE_CATALOG_MAX_BYTES ? result : catalog(id);
}
export const readSourceProfileProjection = file => readDisplayProjection(file, false);
export const readSourceModelCatalog = file => readDisplayProjection(file, true);

// Resolve the same selected GitHub account inside each display read transaction.
function readDisplayProjection(file, models) {
    const unavailable = models ? () => catalog(null) : unavailableSourceProfile;
    let db;
    try {
        db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
        db.exec("PRAGMA query_only=ON; BEGIN");
        const version = db.prepare("PRAGMA user_version").get().user_version;
        const mappings = {
            accounts: { id: "TEXT", login:"TEXT", host: "TEXT", kind: "TEXT", is_default: "INTEGER", created_at: "TEXT",
                ...(!models ? { name:"TEXT", settings_json:"TEXT" } : {}) },
            app_state: { key: "TEXT", value: "TEXT" },
            workspaces: { id: "TEXT", project_id: "TEXT" },
            projects: { id: "TEXT", github_account_id: "TEXT" },
            project_account_hints: { project_id: "TEXT" },
        };
        if (!Number.isSafeInteger(version) || version < 207) return unavailable("app-profile-schema-unsupported");
        for (const [table, fields] of Object.entries(mappings)) {
            if (db.prepare(`PRAGMA main.table_list(${table})`).get()?.type !== "table") return unavailable("app-profile-schema-unsupported");
            const columns = new Map(db.prepare(`PRAGMA main.table_xinfo(${table})`).all().map(column => [column.name, column]));
            if (Object.entries(fields).some(([name, type]) => columns.get(name)?.type.toUpperCase() !== type || columns.get(name)?.hidden !== 0)
                || columns.get(table === "app_state" ? "key" : table === "project_account_hints" ? "project_id" : "id")?.pk !== 1) {
                return unavailable("app-profile-schema-unsupported");
            }
        }
        const active = db.prepare("SELECT value FROM app_state WHERE key='activeWorkspaceId'").get()?.value ?? null;
        if (active !== null && !text(active, 1024)) return unavailable("app-profile-context-invalid");
        const project = active ? db.prepare(
            "SELECT p.id,p.github_account_id FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(active) : null;
        let id = project?.github_account_id ?? null, selection = "workspace";
        if (id !== null && !text(id, 1024)) return unavailable("app-profile-context-invalid");
        if (!id && project && db.prepare("SELECT 1 FROM project_account_hints WHERE project_id=?").get(project.id)) {
            return unavailable("app-account-relink-required");
        }
        if (id && !db.prepare(`SELECT 1 FROM accounts WHERE id=? AND ${githubKinds}`).get(id)) {
            return unavailable("app-account-relink-required");
        }
        if (!id) {
            const defaults = db.prepare(`SELECT id FROM accounts WHERE ${githubKinds} AND is_default=1 LIMIT 2`).all();
            if (defaults.length > 1) return unavailable("app-profile-selection-ambiguous");
            if (defaults.length) { id = defaults[0].id; selection = "default"; }
            else {
                const first = db.prepare(`SELECT id,created_at FROM accounts WHERE ${githubKinds} ORDER BY created_at ASC LIMIT 2`).all();
                if (!first.length) return unavailable("app-profile-signed-out");
                if (!text(first[0].created_at, 80) || first[1]?.created_at === first[0].created_at) {
                    return unavailable("app-profile-selection-ambiguous");
                }
                id = first[0].id; selection = "first-github";
            }
        }
        if (models) return selectedCatalog(db,id);
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
