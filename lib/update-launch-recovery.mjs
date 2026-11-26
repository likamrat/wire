import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertProcessExited, readJson, withReviewedCollectorClaims } from "./collector-io.mjs";
import { artifactDeletionKey } from "./deletion-identities.mjs";
import { sessionStorage } from "./microsoft-session-state.mjs";
import { assertCopilotState } from "./release-policy.mjs";
import { loadBoardState } from "./store.mjs";
import { commitId, privateError, storeIdentity } from "./update-launch-state.mjs";

const exec = promisify(execFile);
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const incomplete = () => privateError("The reviewed installation, builds, port, store and original process identities do not match. Recovery was refused.");
const pending = () => privateError("An operation or saved-file result is unresolved. Check its original receipt; crash recovery did not resume it.");

async function checkExportDirectories(dir, board) {
    const root = path.join(dir, "exports");
    if (await realpath(root) !== root) throw pending();
    const saved = new Set(board.exports.map(entry => entry.bundleId));
    const deleted = new Set(), markers = new Set(board.artifactDeletion?.identities ?? []);
    for (const op of Object.values(board.deletion?.operations ?? {})) {
        if (op.kind !== "artifact-deletion" || op.phase !== "complete" || op.cleanup !== undefined) continue;
        for (const item of op.artifacts ?? [op.artifact]) {
            if (["report", "comparison"].includes(item?.artifactKind) && /^export-[a-f0-9-]{36}$/.test(item.artifactId)
                && markers.has(artifactDeletionKey(item.artifactKind, item.artifactId))) deleted.add(item.artifactId);
        }
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const folder = path.join(root, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(folder) !== folder) throw pending();
        if (saved.delete(entry.name)) continue;
        if (!deleted.has(entry.name)) throw pending();
        const contents = await readdir(folder, { withFileTypes: true });
        if (!contents.length) continue;
        const files = path.join(folder, "files");
        if (contents.length !== 1 || contents[0].name !== "files" || !contents[0].isDirectory()
            || contents[0].isSymbolicLink() || await realpath(files) !== files || (await readdir(files)).length) throw pending();
    }
    if (saved.size) throw pending();
}

export async function readRecovery(file, { root, installed, base, store, port, active }) {
    let record;
    try {
        const handle = await open(file, "r");
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 16384) throw incomplete();
            record = JSON.parse(await handle.readFile("utf8"));
        } finally { await handle.close(); }
    } catch { throw incomplete(); }
    const fields = ["version", "installation", "interruptedBuild", "targetBuild", "store", "port", "launcherPid", "writerPid"];
    if (active) fields.push("baseBuild", "slot");
    if (!record || Object.keys(record).length !== fields.length || !fields.every(key => Object.hasOwn(record, key))
        || record.installation !== root || !commitId(record.interruptedBuild)
        || (active ? record.version !== 2 || record.baseBuild !== base || base !== installed || record.slot !== active.slot
            || record.interruptedBuild !== active.commit || record.targetBuild !== active.commit
            : record.version !== 1 || ![record.interruptedBuild, installed].includes(base) || record.targetBuild !== installed)
        || !/^[a-f0-9]{64}$/.test(store ?? "") || record.store !== store || !port || record.port !== port
        || ![record.launcherPid, record.writerPid].every(pid) || record.launcherPid === record.writerPid) throw incomplete();
    try {
        for (const id of [record.launcherPid, record.writerPid]) assertProcessExited(id);
    } catch { throw privateError("An original process is still present, its PID was reused, or its exit could not be verified."); }
    try {
        const git = async (...args) => (await exec("git", ["--no-replace-objects", ...args], { cwd: root, windowsHide: true, timeout: 30000 })).stdout.trim();
        const from = active ? base : record.interruptedBuild;
        await git("merge-base", "--is-ancestor", from, record.targetBuild);
        const contract = ":lib/update-compatibility.json";
        if (await git("rev-parse", "--verify", from + contract) !== await git("rev-parse", "--verify", record.targetBuild + contract)) throw incomplete();
    } catch { throw privateError("The original build and target do not have a verified compatible main history. No recovery was attempted."); }
    return { ...record, reviewKey: "review:" + createHash("sha256").update(JSON.stringify(fields.map(key => record[key]))).digest("hex") };
}

// Runs in the new child with the installation launcher and child SQLite
// locks held and the exact loopback port already reserved. No replay API.
export async function recoverLaunch(context, finish, initialize, stillOwned) {
    const r = finish.recovery, dir = context.dataDir;
    let admitted = false;
    try {
        return await withReviewedCollectorClaims(reserve => reserve(dir, r.writerPid, collector =>
            reserve(path.join(dir, "microsoft-session"), r.writerPid, async session => {
                if (collector.token === session.token || await storeIdentity(dir) !== r.store) throw incomplete();
                const board = await loadBoardState(context, { readOnly: true });
                assertCopilotState(board);
                const access = await sessionStorage(context).read();
                const personal = board.personalEvaluation, model = personal?.modelEvaluation;
                const index = await readJson(path.join(dir, "collector", "index.json"));
                if (!access || access.owner || access.partition || access.partitions.length
                    || access.receipts.some(receipt => receipt.outcome === "pending"
                        || receipt.outcome === "ambiguous" && receipt.action.startsWith("microsoft-"))
                    || board.deletion?.pending || board.artifactDeletion?.pending || index?.completionReferenceMaintenance
                    || Object.values(personal?.mutations ?? {}).some(entry => entry.receipt.phase === "pending")
                    || model?.automatic?.receipts.some(entry => entry.phase === "pending")
                    || model?.runs.some(run => ["queued", "running", "uncertain"].includes(run.phase))) throw pending();
                await checkExportDirectories(dir, board);
                if (!stillOwned()) throw privateError("The original launcher disconnected before crash recovery was admitted.");
                finish.admit();
                admitted = true;
                return initialize();
            })));
    } catch (error) {
        if (admitted || error.code === "WIRE_LAUNCH") throw error;
        throw privateError("The original writer leases, compatible store or operation journals could not be verified. Nothing was resumed.");
    }
}
