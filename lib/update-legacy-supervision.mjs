import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { assertProcessExited } from "./collector-io.mjs";
import { canonicalStore, privateError, storeIdentity } from "./update-launch-state.mjs";

const original = "0529f452449f7eba74548905097f96733587b8e6"; // v0.1.1
const serving = "4d700dbf0d5efd16f4f1a78de0d4bc6c47d893da"; // v0.1.2
const published = "a34036404d7dcc6e6041fc6e4abfb30a6f2faea6"; // v0.1.3
const refuse = () => privateError("The reviewed legacy installation, stopped owners, store, port or release did not match. Nothing was started.");

// This is an ordinary service start by its original operator. The record pins
// the independently observed startup configuration; it is NOT install consent.
export async function readLegacyStart(file, port, dataDir) {
    let r;
    try {
        if (!path.isAbsolute(file) || await realpath(file) !== file) throw refuse();
        const handle = await open(file, "r");
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 16384) throw refuse();
            r = JSON.parse(await handle.readFile("utf8"));
        } finally { await handle.close(); }
        const fields = ["version","installation","channel","baseBuild","slot","activeBuild","targetTag","targetBuild","port","store","launcherPid","writerPid","closedChildId"];
        if (!r || Object.keys(r).length !== fields.length || !fields.every(k => Object.hasOwn(r,k))
            || r.version !== 1 || r.baseBuild !== original || r.activeBuild !== serving || r.targetBuild !== published
            || r.targetTag !== "v0.1.3" || r.channel !== "release"
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.slot) || !path.isAbsolute(r.installation)
            || await realpath(process.cwd()) !== r.installation || r.port !== port || !port
            || !/^[a-f0-9]{64}$/.test(r.store) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.closedChildId)
            || r.launcherPid === r.writerPid) throw refuse();
        assertProcessExited(r.launcherPid); assertProcessExited(r.writerPid);
        const directory = await canonicalStore(dataDir);
        if (await storeIdentity(directory) !== r.store) throw refuse();
        for (const dir of [directory, path.join(directory, "microsoft-session")]) {
            for (const name of ["collector.lock", "collector.lock.recovery"]) {
                try { await lstat(path.join(dir,name)); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
                throw refuse();
            }
        }
    } catch { throw refuse(); }
    return r;
}

export function assertLegacySelection(review, state, prefs, inspected) {
    if (inspected?.installed !== original || state?.version !== 1 || state.base !== original || state.transition !== null
        || state.active?.slot !== review.slot || state.active.commit !== serving || state.active.release?.tag !== "v0.1.2"
        || state.active.release.commit !== serving || typeof prefs?.automatic !== "boolean"
        || prefs.checked?.channel !== "release" || prefs.checked.installed !== serving) throw refuse();
}

export function assertReviewedOffer(review, info) {
    if (info.channel !== "release" || info.installed !== serving || info.candidate !== review.targetBuild
        || info.release?.tag !== review.targetTag || info.release.commit !== review.targetBuild)
        throw privateError("GitHub Latest no longer matches the release reviewed for this maintenance start. Nothing was installed.");
}
