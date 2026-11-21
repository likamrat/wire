import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export const commitId = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const privateError = message => Object.assign(new Error(message), { code: "WIRE_LAUNCH" });
const uncertain = () => privateError("The previous WIRE child has not confirmed a clean close. Check the original launcher; no other writer was started.");

// EXCLUSIVE locking mode keeps the OS lock between commits, including on
// Windows. Process death releases the lock, but does not erase its last receipt.
function exclusive(file) {
    const db = new DatabaseSync(file);
    try {
        db.exec(`PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;
            BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); COMMIT`);
        return {
            get(key) {
                const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
                return row === undefined ? undefined : JSON.parse(row.value);
            },
            put(key, value) {
                db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)").run(key, JSON.stringify(value));
            },
            close() { db.close(); },
        };
    } catch (error) { db.close(); throw error; }
}

export async function stateDirectory(root, create) {
    // inspectInstallation accepts standalone clones only, never a shared
    // worktree/common-dir. Do not follow .git or wire-updates redirections.
    const git = path.join(root, ".git");
    const info = await lstat(git).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const directory = path.join(git, "wire-updates");
    if (create) await mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const existing = await lstat(directory).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (!existing) return null;
    if (!existing.isDirectory() || path.relative(await realpath(git), await realpath(directory)) !== "wire-updates") {
        throw privateError("The WIRE update directory is not owned by this installation.");
    }
    return directory;
}

export function openLauncherJournal(directory) {
    try { return exclusive(path.join(directory, "installation.sqlite")); }
    catch { throw privateError("This installation already has a launcher, or its update journal is unavailable. No runtime was started."); }
}

function childRecord(directory, run) {
    let db;
    try { db = exclusive(path.join(directory, "child.sqlite")); }
    catch { throw uncertain(); }
    try { return run(db); } finally { db.close(); }
}

export function armChild(directory) {
    return childRecord(directory, db => {
        const last = db.get("child");
        // A pending fork has not acquired store authority. Rotating its nonce
        // under lock prevents a late/stale fork from acquiring it later.
        if (last !== undefined && (!uuid(last.id) || !["pending", "closed", "startup-failed"].includes(last.state))) throw uncertain();
        const id = randomUUID();
        db.put("child", { id, state: "pending" });
        return id;
    });
}

export function assertChildClosed(directory, id) {
    return childRecord(directory, db => {
        const receipt = db.get("child");
        if (receipt?.id !== id || !["closed", "startup-failed"].includes(receipt.state)) throw uncertain();
        return receipt.state;
    });
}

// Called only in the fork, before it binds the port or opens the store.
export function claimChild(directory, id) {
    if (!directory || !uuid(id)) throw uncertain();
    const db = exclusive(path.join(directory, "child.sqlite"));
    try {
        const receipt = db.get("child");
        if (receipt?.id !== id || receipt.state !== "pending") throw uncertain();
        db.put("child", { id, state: "running" });
    } catch (error) { db.close(); throw error; }
    return state => {
        try { db.put("child", { id, state }); } finally { db.close(); }
    };
}

export function codePath(root, directory, ref, base) {
    if (!ref || !commitId(ref.commit) || (ref.slot === null ? ref.commit !== base : !uuid(ref.slot))) {
        throw privateError("The WIRE activation journal cannot identify its code. No runtime was started.");
    }
    return ref.slot === null ? root : path.join(directory, ref.slot);
}
