import { chmod, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BOARD_ID } from "./evidence.mjs";
import { writeExclusive } from "./store.mjs";
import { buildAnalytics } from "./analytics.mjs";
import { dataDirFor } from "./paths.mjs";

const stateName = `${BOARD_ID}.state.json`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function contained(root, file) {
    const relative = path.relative(root, path.resolve(file));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error("Migration file escapes the expected private directory.");
    }
    return relative;
}

async function inventory(root) {
    const files = [];
    let bytes = 0;
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error("Migration refuses symbolic links in private storage.");
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) {
                const content = await readFile(file);
                bytes += content.length;
                if (files.length >= 10000 || bytes > 512 * 1024 * 1024) throw new Error("Private migration exceeds its bounded file/size limit.");
                files.push({ path: contained(root, file), bytes: content.length, sha256: hash(content) });
            } else throw new Error("Unsupported private migration file type.");
        }
    }
    await walk(root);
    return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function copyVerified(source, destination, files, immutable = false) {
    for (const file of files) {
        const content = await readFile(path.join(source, file.path));
        if (hash(content) !== file.sha256) throw new Error("Source changed during migration; no destination activated.");
        const target = path.join(destination, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeExclusive(target, content);
        if (hash(await readFile(target)) !== file.sha256) throw new Error("Private copy integrity check failed.");
        if (immutable) await chmod(target, 0o400);
    }
}

async function inspectSnapshot(root) {
    const state = JSON.parse(await readFile(path.join(root, stateName), "utf8"));
    if (state.boardId !== BOARD_ID || state.stateVersion !== 3 || !Number.isSafeInteger(state.revision)
        || !/^[a-f0-9]{64}$/.test(state.pseudonymKey) || !/^[a-f0-9]{64}\.json$/.test(state.evidenceFile)
        || !state.cards || !Array.isArray(state.exports)) throw new Error("Migration requires a complete version 3 evidence state.");
    const content = await readFile(path.join(root, "private-evidence", state.evidenceFile));
    if (`${hash(content)}.json` !== state.evidenceFile) throw new Error("Evidence pointer integrity check failed.");
    const evidence = JSON.parse(content);
    if (!Array.isArray(evidence.records) || new Set(evidence.records.map((r) => r.scenarioId)).size !== evidence.records.length
        || evidence.records.some((record) => !state.cards[record.scenarioId])) throw new Error("Evidence/review inventory mismatch.");
    const calls = buildAnalytics(evidence.records);
    const api = buildAnalytics(evidence.records, { layer: "reported-api" });
    const http = buildAnalytics(evidence.records, { layer: "http" });
    return {
        state,
        counts: {
            evidenceRecords: evidence.records.length, reviewCards: Object.keys(state.cards).length,
            exports: state.exports.length, sessions: calls.coverage.sessionCount, workIqCalls: calls.totals.count,
            success: calls.totals.success, failure: calls.totals.failure, unknown: calls.totals.unknown,
            numericApiResults: api.apiCoverage.selectedResultUnitsWithNumericStatus,
            callsWithNumericStatus: api.apiCoverage.callsWithNumericStatus,
            callsWithoutNumericStatus: api.apiCoverage.callsWithoutNumericStatus,
            observedHttpRecords: http.httpCoverage.observedResponseCount,
        },
    };
}

export async function migratePrivateData({ source, destination, importFiles, sessionRoot, appDbPath }) {
    for (const value of [source, destination, importFiles, sessionRoot, appDbPath]) {
        if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Migration paths must be explicit and absolute.");
    }
    source = path.resolve(source);
    destination = dataDirFor({ dataDir: destination });
    if (source === destination || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) {
        throw new Error("Source and destination must be separate private directories.");
    }
    try {
        await stat(destination);
        throw new Error("Destination already exists. Migration never overwrites existing user data.");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const original = await inspectSnapshot(source);
    const files = await inventory(source);
    const id = `migration-${randomUUID()}`;
    const parent = path.dirname(destination);
    const backup = path.join(parent, "backups", id);
    const staging = path.join(parent, `.${id}.staging`);
    await mkdir(path.dirname(backup), { recursive: true });
    await mkdir(backup);
    await copyVerified(source, backup, files, true);
    const backupManifest = { schemaVersion: 1, source, capturedAt: new Date().toISOString(), counts: original.counts, files };
    await writeExclusive(path.join(backup, "migration-manifest.json"), JSON.stringify(backupManifest, null, 2));
    await chmod(path.join(backup, "migration-manifest.json"), 0o400);
    await mkdir(staging);
    await copyVerified(backup, staging, files);
    const imports = path.join(staging, "import");
    await mkdir(imports, { recursive: true });
    const rosterBytes = await readFile(path.join(importFiles, "app-inventory.json"));
    const roster = JSON.parse(rosterBytes.toString("utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(roster) || roster.length > 500) throw new Error("Approved import inventory is invalid or exceeds 500 entries.");
    await writeExclusive(path.join(imports, "app-inventory.json"), rosterBytes);
    const config = JSON.parse(await readFile(path.join(importFiles, "history-window.json"), "utf8"));
    await writeExclusive(path.join(imports, "history-window.json"), JSON.stringify({ ...config, sessionRoot, appDbPath }, null, 2));

    const state = original.state;
    for (const bundle of state.exports) {
        const bundleRelative = contained(source, bundle.bundleDir);
        if (!bundleRelative.startsWith(`exports${path.sep}`)) throw new Error("Export reference is outside the private export inventory.");
        bundle.bundleDir = path.join(destination, bundleRelative);
        for (const [name, value] of Object.entries(bundle.files)) {
            const relative = contained(source, value);
            if (!relative.startsWith(bundleRelative + path.sep) || !files.some((file) => file.path === relative)) {
                throw new Error("Export file reference is missing from the preserved inventory.");
            }
            bundle.files[name] = path.join(destination, relative);
        }
    }
    state.continuation = "Private evidence and review history migrated to maintained local storage. Earlier evidence remains separate from the current history window.";
    state.revision++;
    const updatedState = path.join(staging, `${stateName}.migrated`);
    await writeExclusive(updatedState, JSON.stringify(state, null, 2));
    await rename(updatedState, path.join(staging, stateName));
    const migrated = await inspectSnapshot(staging);
    if (JSON.stringify(original.counts) !== JSON.stringify(migrated.counts)) throw new Error("Migration changed evidence counts; destination not activated.");
    if (JSON.stringify(await inventory(source)) !== JSON.stringify(files)) throw new Error("Frozen source changed during migration; destination not activated.");
    const finalFiles = await inventory(staging);
    const result = { schemaVersion: 1, destination, backup, completedAt: new Date().toISOString(), counts: migrated.counts, files: finalFiles };
    await writeExclusive(path.join(staging, "migration-manifest.json"), JSON.stringify(result, null, 2));
    await rename(staging, destination);
    return { destination, backup, counts: migrated.counts };
}
