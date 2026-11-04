import { open, readFile, stat } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { BoardError, loadBoardState, resolveDataDir } from "./store.mjs";
import { assertCopilotState } from "./release-policy.mjs";
import { collectorHostIdentity, hash, readTail } from "./collector-io.mjs";
import { hostPaths } from "./host-paths.mjs";

export const HOST_MAPPING_FILE = "host-handover.json";
export const sourceFingerprint = config => hash(JSON.stringify([config.appDbPath, config.sessionRoot, config.windowDays]));
export const sourceStoreBinding = state => hash(JSON.stringify([state.boardId, state.pseudonymKey]));
const bindings = new WeakMap();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const failed = (code, message) => Object.assign(new BoardError(message, 409), { code });
const required = () => failed("source_host_mapping_required",
    "This source needs a reviewed host handover before collection can resume. Retained evidence is available; no history was reread.");
const changed = () => failed("source_host_mapping_stale",
    "This source no longer matches its reviewed host handover. Prior evidence and read positions were retained; no history was replayed.");
const historyOptions = options => {
    if (options === undefined) return options;
    const { hostLookup: _lookup, ...readOptions } = options;
    return readOptions;
};

export function validateHostMapping(mapping) {
    if (!mapping || mapping.schemaVersion !== 1 || mapping.kind !== "windows-to-wsl"
        || !uuid.test(mapping.operationId ?? "") || !/^[a-f0-9]{64}$/.test(mapping.storeBinding ?? "")
        || !/^[a-f0-9]{64}$/.test(mapping.sourceFingerprint ?? "")
        || typeof mapping.windowsDataDir !== "string" || !path.win32.isAbsolute(mapping.windowsDataDir)
        || mapping.originalHost?.platform !== "win32" || mapping.targetHost?.platform !== "linux"
        || !/^[a-f0-9]{64}$/.test(mapping.originalHost.machine ?? "")
        || !/^[a-f0-9]{64}$/.test(mapping.targetHost.machine ?? "")
        || !Array.isArray(mapping.rows) || mapping.rows.length > 10000
        || !Array.isArray(mapping.unpositioned) || mapping.unpositioned.length > 10000
        || mapping.unpositioned.some(row => !uuid.test(row?.sessionId ?? "") || typeof row.reason !== "string")
        || new Set(mapping.unpositioned.map(row => row.sessionId)).size !== mapping.unpositioned.length
        || new Set(mapping.rows.map(row => row?.sessionId)).size !== mapping.rows.length) throw changed();
    for (const row of mapping.rows) {
        if (!row || !uuid.test(row.sessionId ?? "") || !["verified", "retained-only"].includes(row.disposition)
            || typeof row.identity !== "string" || !Number.isSafeInteger(row.offset) || row.offset < 0
            || !/^[a-f0-9]{64}$/.test(row.anchor ?? "")) throw changed();
        if (row.disposition === "retained-only") {
            if (typeof row.reason !== "string" || !row.reason) throw changed();
            continue;
        }
        if (typeof row.startupEventId !== "string" || !row.startupEventId
            || ![row.windows?.dev, row.windows?.ino, row.windows?.birthtimeMs].every(Number.isFinite)
            || !/^\d+$/.test(row.windows?.inoExact ?? "") || !/^\d+$/.test(row.windows?.birthtimeNs ?? "")
            || !/^\d+$/.test(row.linux?.inoExact ?? "") || !/^\d+$/.test(row.linux?.birthtimeNs ?? "")
            || row.identity !== `${row.windows.dev}:${row.windows.ino}:${row.windows.birthtimeMs}:${row.startupEventId}`) throw changed();
    }
    return mapping;
}

export function validateCommittedHostMapping(record) {
    if (!record || record.outcome !== "applied" || !/^[a-f0-9]{64}$/.test(record.planHash ?? "")
        || Object.keys(record).some(key => !["outcome", "planHash", "mapping", "seal"].includes(key))
        || record.seal !== hash(JSON.stringify({ outcome: record.outcome, planHash: record.planHash, mapping: record.mapping }))) throw changed();
    validateHostMapping(record.mapping);
    return record;
}

function nativeAccess(config) {
    const qualified = !hostPaths.describe(config.appDbPath).foreignWindows
        && !hostPaths.describe(config.sessionRoot).foreignWindows;
    const available = () => { if (!qualified) throw required(); };
    const historyFile = id => { available(); return path.join(hostPaths.local(config.sessionRoot), id, "events.jsonl"); };
    return {
        qualified, assertCurrent: available,
        databaseFile() { available(); return hostPaths.local(config.appDbPath); },
        historyRoot() { available(); return hostPaths.local(config.sessionRoot); },
        historyFile,
        statHistory: id => stat(historyFile(id)),
        statHistorySync: id => statSync(historyFile(id)),
        statHandle: (_id, handle) => handle.stat(),
        identity: (_id, value, startupEventId) => `${value.dev}:${value.ino}:${value.birthtimeMs}:${startupEventId}`,
        readHistory: (id, previous, budget, options, reader = readTail) => reader(historyFile(id), id, previous, budget, historyOptions(options)),
    };
}

export function sourceHost(config) {
    const binding = bindings.get(config);
    if (binding) {
        if (sourceFingerprint(config) !== binding.fingerprint) throw changed();
        return binding.access;
    }
    return nativeAccess(config);
}

export function shareSourceHost(from, to) {
    const binding = bindings.get(from);
    if (binding && sourceFingerprint(to) === binding.fingerprint) bindings.set(to, binding);
}

export async function bindSourceHost(context, config) {
    if (!config) return;
    const directory = path.join(resolveDataDir(context), "collector");
    const file = path.join(directory, HOST_MAPPING_FILE), bytes = await readFile(file).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (!bytes) return;
    const { mapping } = validateCommittedHostMapping(JSON.parse(bytes)), fingerprint = sourceFingerprint(config);
    const state = await loadBoardState(context, { readOnly: true });
    assertCopilotState(state);
    if (mapping.storeBinding !== sourceStoreBinding(state) || mapping.sourceFingerprint !== fingerprint
        || !hostPaths.same(resolveDataDir(context), mapping.windowsDataDir)) throw changed();
    const mappingHash = hash(bytes);
    const host = await collectorHostIdentity();
    const origin = host.platform === "win32" && host.machine === mapping.originalHost.machine;
    const target = host.platform === "linux" && host.machine === mapping.targetHost.machine
        && hostPaths.describe(config.sessionRoot).foreignWindows;
    if (!origin && !target) throw changed();
    const rows = new Map(mapping.rows.map(row => [row.sessionId, row]));
    const unpositioned = new Set(mapping.unpositioned.map(row => row.sessionId));
    let roots;
    const nativeRoots = () => {
        roots ??= { database: hostPaths.local(config.appDbPath), history: hostPaths.local(config.sessionRoot) };
        for (const value of Object.values(roots)) {
            const actual = realpathSync(value);
            if (process.platform === "win32" ? path.resolve(actual).toLowerCase() !== path.resolve(value).toLowerCase()
                : path.resolve(actual) !== path.resolve(value)) throw changed();
        }
        return roots;
    };
    const checkedFile = id => {
        if (!uuid.test(id)) throw changed();
        if (unpositioned.has(id)) throw required();
        const row = rows.get(id);
        if (row?.disposition === "retained-only") throw required();
        const file = path.join(nativeRoots().history, id, "events.jsonl");
        const actual = realpathSync(file);
        if (process.platform === "win32" ? path.resolve(actual).toLowerCase() !== path.resolve(file).toLowerCase()
            : path.resolve(actual) !== path.resolve(file)) throw changed();
        return file;
    };
    const checkCursor = (id, previous, options = {}) => {
        if (unpositioned.has(id)) throw required();
        const row = rows.get(id);
        if (row?.disposition === "retained-only") throw required();
        if (row && previous && (previous.identity !== row.identity
            || !options.fence && !options.startAtBeginning && !options.hostLookup && previous.offset < row.offset)) throw changed();
        if (row && !previous && !options.fence && !options.startAtBeginning && !options.hostLookup) throw required();
        if (!row && previous && (previous.host?.platform !== host.platform || previous.host?.machine !== host.machine)) throw required();
    };
    const normalize = (id, value, exact) => {
        const row = rows.get(id);
        if (!row) return value;
        const proof = origin ? row.windows : row.linux;
        if (exact.ino.toString() !== proof.inoExact || exact.birthtimeNs.toString() !== proof.birthtimeNs
            || Number(exact.ino) !== value.ino || origin && value.dev !== row.windows.dev) throw changed();
        if (origin) return value;
        // DrvFS device/inode/birth values are not the Windows producer's identity.
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
            dev: row.windows.dev, ino: row.windows.ino, birthtimeMs: row.windows.birthtimeMs,
            birthtime: new Date(row.windows.birthtimeMs),
        });
    };
    const statHistory = async (id, previous, options = {}) => {
        checkCursor(id, previous, options);
        const file = checkedFile(id), handle = await open(file, "r");
        try { return normalize(id, await handle.stat(), await handle.stat({ bigint: true })); }
        finally { await handle.close(); }
    };
    const access = {
        qualified: true,
        assertCurrent() {
            if (hash(readFileSync(file)) !== mappingHash
                || hostPaths.local(config.appDbPath) !== nativeRoots().database
                || hostPaths.local(config.sessionRoot) !== nativeRoots().history) throw changed();
        },
        databaseFile: () => nativeRoots().database,
        historyRoot: () => nativeRoots().history,
        historyFile: checkedFile,
        statHistory,
        async statHandle(id, handle, previous, options = {}) {
            checkCursor(id, previous, options);
            return normalize(id, await handle.stat(), await handle.stat({ bigint: true }));
        },
        identity(id, value, startupEventId) {
            const row = rows.get(id);
            if (row) {
                if (row.disposition !== "verified" || startupEventId !== row.startupEventId) throw changed();
                return row.identity;
            }
            return `${value.dev}:${value.ino}:${value.birthtimeMs}:${startupEventId}`;
        },
        statHistorySync(id, previous) {
            checkCursor(id, previous);
            const handle = openSync(checkedFile(id), "r");
            try { return normalize(id, fstatSync(handle), fstatSync(handle, { bigint: true })); }
            finally { closeSync(handle); }
        },
        async readHistory(id, previous, budget, options = {}, reader = readTail) {
            checkCursor(id, previous, options);
            const file = checkedFile(id), row = rows.get(id);
            return reader(file, id, previous, budget, {
                ...historyOptions(options), strictIdentity: true,
                ...(row ? {
                    statAdapter: async (value, handle) => handle
                        ? normalize(id, value, await handle.stat({ bigint: true })) : statHistory(id, previous, options),
                    identityFor: (_value, startup) => {
                        if (startup.id !== row.startupEventId) throw changed();
                        return row.identity;
                    },
                } : { cursorHost: { platform: host.platform, machine: host.machine } }),
            });
        },
    };
    bindings.set(config, { fingerprint, access });
}
