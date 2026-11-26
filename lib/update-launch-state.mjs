import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";

export const commitId = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const privateError = message => Object.assign(new Error(message), { code: "WIRE_LAUNCH" });
const uncertain = () => privateError("The previous WIRE child has not confirmed a clean close. Check the original launcher; no other writer was started.");

// A first launch can select a store that doesn't exist yet. Resolve its
// existing ancestor without creating anything before the runtime reserves its port.
export async function canonicalStore(directory) {
    try { return await realpath(directory); }
    catch (error) {
        if (error.code !== "ENOENT" || path.dirname(directory) === directory) throw error;
        await lstat(directory).then(() => { throw privateError("The selected WIRE data directory is a broken link."); },
            e => { if (e.code !== "ENOENT") throw e; });
        return path.join(await canonicalStore(path.dirname(directory)), path.basename(directory));
    }
}
export async function storeIdentity(directory) {
    if (await realpath(directory) !== directory) throw privateError("The original WIRE data directory moved.");
    const metadata = await stat(directory, { bigint: true });
    if (!metadata.isDirectory()) throw privateError("The selected WIRE data directory is no longer available.");
    const { username, uid } = userInfo();
    return createHash("sha256").update(JSON.stringify([username, uid, directory, String(metadata.dev), String(metadata.ino)])).digest("hex");
}

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
            transaction(write) {
                db.exec("BEGIN EXCLUSIVE");
                try { write(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
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

export function armChild(directory, recovery) {
    return childRecord(directory, db => {
        const last = db.get("child");
        if (recovery) {
            if (last?.state !== "running" || !uuid(last.id) || Object.keys(last).length !== 2) throw uncertain();
            if (db.get(recovery.reviewKey) !== undefined) throw privateError("This reviewed recovery was already admitted. Nothing was restarted.");
            // No pending/clean child is published on this path. Even an old
            // launcher still refuses if the new fork never reaches admission.
            const id = randomUUID();
            db.put("recoveryFork", { id, recovery: { ...recovery, childId: last.id } });
            return id;
        }
        // A pending fork has not acquired store authority. Rotating its nonce
        // under lock prevents a late/stale fork from acquiring it later.
        if (last !== undefined && (!uuid(last.id) || !["pending", "closed", "refused-before-store"].includes(last.state))) throw uncertain();
        const id = randomUUID();
        db.put("child", { id, state: "pending" });
        return id;
    });
}

export function assertChildClosed(directory, id) {
    return childRecord(directory, db => {
        const receipt = db.get("child");
        if (receipt?.id !== id || !["closed", "refused-before-store"].includes(receipt.state)) throw uncertain();
        return receipt.state;
    });
}

// Called only in the fork, before it binds the port or opens the store.
export function claimChild(directory, id) {
    if (!directory || !uuid(id)) throw uncertain();
    const db = exclusive(path.join(directory, "child.sqlite"));
    let recovery;
    try {
        const receipt = db.get("child");
        if (receipt?.id === id && receipt.state === "pending") db.put("child", { id, state: "running" });
        else {
            const fork = db.get("recoveryFork");
            if (fork?.id !== id || !receipt || receipt.state !== "running" || receipt.id !== fork.recovery.childId) throw uncertain();
            recovery = fork.recovery;
            db.put("recoveryFork", null); // Even a rejected admission consumes this fork's ticket.
        }
    } catch (error) { db.close(); throw error; }
    let admitted = !recovery;
    const finish = state => {
        try { if (admitted) db.put("child", { id, state }); } finally { db.close(); }
    };
    if (recovery) Object.assign(finish, { recovery, admit() {
        if (admitted) throw uncertain();
        db.transaction(() => {
            db.put(`interrupted:${recovery.childId}`, { id: recovery.childId, state: "interrupted", successor: id,
                targetBuild: recovery.targetBuild, targetStore: recovery.store, port: recovery.port });
            db.put(recovery.reviewKey, { childId: recovery.childId, successor: id });
            db.put("child", { id, state: "running" });
        });
        admitted = true;
    } });
    return finish;
}

export function codePath(root, directory, ref, base) {
    if (!ref || !commitId(ref.commit) || (ref.slot === null ? ref.commit !== base : !uuid(ref.slot))) {
        throw privateError("The WIRE activation journal cannot identify its code. No runtime was started.");
    }
    return ref.slot === null ? root : path.join(directory, ref.slot);
}
