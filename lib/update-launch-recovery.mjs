import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { assertProcessExited, collectorHostIdentity, readJson, withReviewedCollectorClaims } from "./collector-io.mjs";
import { sessionStorage } from "./microsoft-session-state.mjs";
import { assertCopilotState } from "./release-policy.mjs";
import { loadBoardState } from "./store.mjs";
import { commitId, privateError, storeIdentity, uuid } from "./update-launch-state.mjs";

const exec = promisify(execFile);
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const incomplete = () => privateError("The original launcher, writer, child, store, leases and outstanding operations must be independently accounted for. Recovery was refused.");
const pending = () => privateError("An operation or saved-file result is unresolved. Check its original receipt; crash recovery did not resume it.");

export async function readRecovery(file, { root, installed, base, store, port }) {
    let record;
    try {
        const handle = await open(file, "r");
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 16384) throw incomplete();
            record = JSON.parse(await handle.readFile("utf8"));
        } finally { await handle.close(); }
    } catch { throw incomplete(); }
    const fields = ["version", "installation", "interruptedBuild", "targetBuild", "store", "port", "host",
        "launcherPid", "writerPid", "childId", "collectorToken", "sessionToken", "operationsReviewed"];
    if (!record || Object.keys(record).length !== fields.length || !fields.every(key => Object.hasOwn(record, key))
        || record.version !== 1 || record.installation !== root || !commitId(record.interruptedBuild)
        || ![record.interruptedBuild, installed].includes(base) || record.targetBuild !== installed
        || !/^[a-f0-9]{64}$/.test(store ?? "") || record.store !== store || !port || record.port !== port
        || ![record.launcherPid, record.writerPid].every(pid) || record.launcherPid === record.writerPid
        || ![record.childId, record.collectorToken, record.sessionToken].every(uuid) || record.collectorToken === record.sessionToken
        || !isDeepStrictEqual(record.host, await collectorHostIdentity()) || record.operationsReviewed !== true) throw incomplete();
    try {
        for (const id of [record.launcherPid, record.writerPid]) assertProcessExited(id);
    } catch { throw privateError("An original process is still present, its PID was reused, or its exit could not be verified."); }
    try {
        const git = async (...args) => (await exec("git", ["--no-replace-objects", ...args], { cwd: root, windowsHide: true, timeout: 30000 })).stdout.trim();
        await git("merge-base", "--is-ancestor", record.interruptedBuild, installed);
        const contract = ":lib/update-compatibility.json";
        if (await git("rev-parse", "--verify", record.interruptedBuild + contract) !== await git("rev-parse", "--verify", installed + contract)) throw incomplete();
    } catch { throw privateError("The original build and target do not have a verified compatible main history. No recovery was attempted."); }
    return record;
}

// Runs in the new child with the installation launcher and child SQLite
// locks held and the exact loopback port already reserved. No replay API.
export async function recoverLaunch(context, finish, initialize) {
    const r = finish.recovery, dir = context.dataDir;
    const owner = token => ({ pid: r.writerPid, token, host: r.host });
    let admitted = false;
    try {
        return await withReviewedCollectorClaims(reserve => reserve(dir, owner(r.collectorToken), () =>
            reserve(path.join(dir, "microsoft-session"), owner(r.sessionToken), async () => {
                if (await storeIdentity(dir) !== r.store) throw incomplete();
                const board = await loadBoardState(context, { readOnly: true });
                assertCopilotState(board);
                const access = await sessionStorage(context).read();
                const personal = board.personalEvaluation, model = personal?.modelEvaluation;
                const index = await readJson(path.join(dir, "collector", "index.json"));
                const exports = new Set(board.exports.map(entry => entry.bundleId));
                if (!access || access.owner || access.partition || access.partitions.length
                    || access.receipts.some(receipt => ["pending", "ambiguous"].includes(receipt.outcome))
                    || board.deletion?.pending || board.artifactDeletion?.pending || index?.completionReferenceMaintenance
                    || Object.values(personal?.mutations ?? {}).some(entry => entry.receipt.phase === "pending")
                    || model?.automatic?.receipts.some(entry => entry.phase === "pending")
                    || model?.runs.some(run => ["queued", "running", "uncertain"].includes(run.phase))
                    || (await readdir(path.join(dir, "exports"))).some(name => !exports.has(name))) throw pending();
                finish.admit();
                admitted = true;
                return initialize();
            })));
    } catch (error) {
        if (admitted || error.code === "WIRE_LAUNCH") throw error;
        throw privateError("The original writer leases, compatible store or operation journals could not be verified. Nothing was resumed.");
    }
}
