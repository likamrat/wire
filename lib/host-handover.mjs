import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BoardError, loadBoardState, resolveDataDir } from "./store.mjs";
import { assertCopilotState } from "./release-policy.mjs";
import { acquireCollectorLock, atomicJson, collectorHostIdentity, hash, readJson } from "./collector-io.mjs";
import { discoverSources } from "./source-discovery.mjs";
import { loadBackfillCheckpoint } from "./collector-backfill-store.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";
import { hostPaths } from "./host-paths.mjs";
import { HOST_MAPPING_FILE, sourceFingerprint, sourceStoreBinding, validateHostMapping, validateCommittedHostMapping } from "./source-host.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const error = (code, message) => Object.assign(new BoardError(message, 409), { code });
const refused = message => error("HOST_HANDOVER_REFUSED", message);
const paths = context => {
    const root = resolveDataDir(context), collector = path.join(root, "collector");
    return { root, mapping: path.join(collector, HOST_MAPPING_FILE) };
};
const membership = source => source ? hash(JSON.stringify([source.sessionId, source.appId, source.eligible,
    source.disposition, source.workspaceIds, source.projectId, source.projectType, source.archiveEvidence])) : "absent";
const numericIdentity = (value, startup) => `${value.dev}:${value.ino}:${value.birthtimeMs}:${startup}`;
const planDigest = plan => hash(JSON.stringify({ schemaVersion: plan.schemaVersion, policy: plan.policy,
    before: plan.before, mapping: plan.mapping, mappingHash: plan.mappingHash, writeSet: plan.writeSet }));
const sameHost = (left, right) => ["schemaVersion", "platform", "machine", "bootId", "pidNamespace"]
    .every(key => left?.[key] === right?.[key]);
const physical = value => ({ dev: value?.dev, ino: value?.ino, birthtimeMs: value?.birthtimeMs,
    inoExact: value?.inoExact, birthtimeNs: value?.birthtimeNs });

async function authorize(context, policy, gate, phase) {
    if (process.platform !== "win32" || !context?.dataDir || !path.win32.isAbsolute(context.dataDir)
        || policy?.kind !== "windows-to-wsl" || !uuid.test(policy.operationId ?? "")
        || Object.keys(policy).some(key => !["kind", "operationId", "windowsDataDir", "storeBinding", "sourceFingerprint", "targetHost"].includes(key))
        || !hostPaths.same(resolveDataDir(context), policy.windowsDataDir ?? "")
        || !/^[a-f0-9]{64}$/.test(policy.storeBinding ?? "")
        || !/^[a-f0-9]{64}$/.test(policy.sourceFingerprint ?? "")
        || policy.targetHost?.platform !== "linux" || !/^[a-f0-9]{64}$/.test(policy.targetHost.machine ?? "")
        || typeof gate !== "function" || await gate({ phase, policy, dataDir: resolveDataDir(context) }) !== true) {
        throw refused("This exact host handover has no operator authorization. Nothing was prepared or applied.");
    }
}

async function quiescent(context, work) {
    const { root } = paths(context);
    for (const directory of [root, path.join(root, "microsoft-session")]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw refused("The existing store cannot be verified.");
    }
    const releaseAccess = await acquireCollectorLock(path.join(root, "microsoft-session"));
    let releaseWriter;
    try {
        releaseWriter = await acquireCollectorLock(root);
        return await work();
    } finally {
        try { await releaseWriter?.(); }
        finally { await releaseAccess(); }
    }
}

async function snapshot(context) {
    const { root } = paths(context), files = [];
    async function walk(directory) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (["collector.lock", "collector.lock.recovery"].includes(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw refused("A linked store entry cannot be included in the handover.");
            if (entry.isDirectory()) { await walk(file); continue; }
            if (!entry.isFile()) throw refused("An unsupported store entry cannot be included in the handover.");
            const before = await lstat(file), digest = createHash("sha256");
            for await (const bytes of createReadStream(file)) digest.update(bytes);
            const after = await lstat(file);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
                throw refused("The store changed during verification. No mapping was applied.");
            }
            files.push({ path: path.relative(root, file), bytes: after.size, sha256: digest.digest("hex") });
        }
    }
    await walk(root);
    return files;
}

async function storeScope(context, policy) {
    const { root } = paths(context);
    const state = await loadBoardState(context, { readOnly: true });
    assertCopilotState(state);
    const session = await readJson(path.join(root, "microsoft-session", "session.json"));
    const config = await readJson(path.join(root, "collector", "config.json"));
    const index = await readJson(path.join(root, "collector", "index.json"));
    if (session?.wire !== "signed-in" || config?.approved !== true
        || sourceStoreBinding(state) !== policy.storeBinding || sourceFingerprint(config) !== policy.sourceFingerprint
        || index?.fingerprint !== policy.sourceFingerprint || !index.sources) {
        throw refused("Store access, approved source identity or committed cursor scope changed.");
    }
    const discovery = discoverSources(config);
    if (discovery.counts.skippedByLimit !== 0) throw refused("The approved metadata population is incomplete.");
    const sources = new Map(discovery.roster.map(source => [source.sessionId, source]));
    const rows = [], unpositioned = [];
    for (const [sessionId, row] of Object.entries(index.sources).sort(([a], [b]) => a.localeCompare(b))) {
        if (!uuid.test(sessionId)) throw refused("An indexed source has an unverifiable identity.");
        const source = sources.get(sessionId);
        if (!row.cursor) { unpositioned.push({ sessionId, reason: "no-committed-read-position", membership: membership(source) }); continue; }
        const cursor = row.cursor;
        if (typeof cursor.identity !== "string" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
            || !/^[a-f0-9]{64}$/.test(cursor.anchor ?? "")) throw refused("A saved read position cannot be verified.");
        const checkpointPath = path.join(root, "collector", index.fingerprint, `${sessionId}.json`);
        const checkpoint = await readJson(checkpointPath);
        const committed = value => {
            if (!value) return null;
            const { partialBytes: _partial, logBytes: _length, backlogBytes: _backlog, ...position } = value;
            return position;
        };
        if (!checkpoint || JSON.stringify(committed(checkpoint.cursor)) !== JSON.stringify(committed(cursor))) {
            throw refused("An index and cached read position disagree. No position was repaired or reset.");
        }
        rows.push({ sessionId, disposition: source?.eligible ? "verified" : "retained-only",
            ...(source?.eligible ? {} : { reason: source?.disposition ?? "not-in-current-approved-roster" }),
            identity: cursor.identity, offset: cursor.offset, anchor: cursor.anchor,
            logicalFile: path.win32.join(config.sessionRoot, sessionId, "events.jsonl"),
            membership: membership(source) });
    }
    const byId = new Map(rows.map(row => [row.sessionId, row]));
    const backfill = await loadBackfillCheckpoint(path.join(root, "collector"));
    const currentBackfill = backfill?.checkpoint.backfill.fingerprint === index.fingerprint
        && backfill.checkpoint.backfill.deletionVersion === activityDeletionVersion(state);
    const backfillReferences = [];
    for (const reference of backfill?.checkpoint.backfill.sources ?? []) {
        const row = byId.get(reference.sessionId);
        const active = currentBackfill && ["pending", "reading"].includes(reference.phase);
        const applicable = currentBackfill && row?.disposition === "verified" && reference.identity === row.identity;
        if (active && row?.disposition === "verified" && !applicable) {
            throw refused("An active saved prefix belongs to a different source generation.");
        }
        backfillReferences.push({ ...reference, classification: !currentBackfill ? "preserved-stale-generation" : applicable ? "verified-range"
            : row?.disposition === "retained-only" ? "retained-only-ineligible"
                : active ? "outside-indexed-resume-scope" : "preserved-inactive-reference" });
        if (active && !row) throw refused("An active saved prefix is outside the indexed resume scope.");
        if (!applicable) continue;
        row.minimumLength = Math.max(row.minimumLength ?? row.offset, reference.endOffset);
        row.verificationRanges ??= [];
        if (reference.anchor !== null) row.verificationRanges.push({ offset: reference.endOffset, anchor: reference.anchor });
        if (backfill.checkpoint.backfillSource === row.sessionId && backfill.checkpoint.cursor.identity === row.identity) {
            row.verificationRanges.push({ offset: backfill.checkpoint.cursor.offset, anchor: backfill.checkpoint.cursor.anchor });
        }
    }
    for (const row of rows) if (row.verificationRanges) {
        row.verificationRanges = [...new Map(row.verificationRanges
            .filter(range => range.offset !== row.offset || range.anchor !== row.anchor)
            .map(range => [`${range.offset}:${range.anchor}`, range])).values()];
    }
    return { config, rows, unpositioned, backfillReferences };
}

export async function inspectHostHistoryFile(file, expected, { windowsIdentity = false } = {}) {
    const canonical = await realpath(file);
    if (process.platform === "win32" ? path.resolve(canonical).toLowerCase() !== path.resolve(file).toLowerCase()
        : path.resolve(canonical) !== path.resolve(file)) throw refused("A source link cannot be verified for this handover.");
    const handle = await open(file, "r");
    try {
        const info = await handle.stat(), exact = await handle.stat({ bigint: true });
        let minimumLength = Math.max(expected.offset, expected.minimumLength ?? 0);
        if (!info.isFile() || info.size < minimumLength) throw refused("A required source file is missing or shorter than its saved position.");
        const prefix = Buffer.alloc(Math.min(info.size, 65536));
        let prefixBytes = 0, newline = -1;
        while (prefixBytes < prefix.length && newline < 0) {
            const read = await handle.read(prefix, prefixBytes, Math.min(256, prefix.length - prefixBytes), prefixBytes);
            if (!read.bytesRead) break;
            prefixBytes += read.bytesRead;
            newline = prefix.subarray(0, prefixBytes).indexOf(10);
        }
        if (newline < 0) throw refused("The bounded source start marker is unavailable.");
        let startup;
        try { startup = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(0, newline))); }
        catch { throw refused("The source start marker is invalid."); }
        if (startup.type !== "session.start" || startup.data?.version !== 1
            || startup.data.sessionId !== expected.sessionId || typeof startup.id !== "string" || !startup.id
            || windowsIdentity && numericIdentity(info, startup.id) !== expected.identity
            || !windowsIdentity && startup.id !== expected.startupEventId) {
            throw refused("The source start identity changed.");
        }
        const ranges = [{ offset: expected.offset, anchor: expected.anchor }, ...expected.verificationRanges ?? []];
        if (ranges.length > 20001) throw refused("The saved verification range budget was exceeded.");
        let verificationBytes = prefixBytes;
        for (const range of ranges) {
            if (!Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset > info.size
                || !/^[a-f0-9]{64}$/.test(range.anchor ?? "")) throw refused("A saved verification range is invalid.");
            minimumLength = Math.max(minimumLength, range.offset);
            const anchor = Buffer.alloc(Math.min(128, range.offset));
            const read = await handle.read(anchor, 0, anchor.length, range.offset - anchor.length);
            verificationBytes += read.bytesRead;
            if (read.bytesRead !== anchor.length || hash(anchor) !== range.anchor) throw refused("The saved source verification range changed.");
        }
        const current = await lstat(file, { bigint: true });
        if (current.isSymbolicLink() || current.ino !== exact.ino || current.dev !== exact.dev
            || current.birthtimeNs !== exact.birthtimeNs || current.size < BigInt(minimumLength)) {
            throw refused("The source changed during bounded verification.");
        }
        return { startupEventId: startup.id, physical: { dev: info.dev, ino: info.ino,
            birthtimeMs: info.birthtimeMs, inoExact: exact.ino.toString(), birthtimeNs: exact.birthtimeNs.toString() },
        verificationBytes };
    } finally { await handle.close(); }
}

export async function inspectWslHostRows(request) {
    if (process.platform !== "linux" || request?.kind !== "windows-to-wsl"
        || !uuid.test(request.operationId ?? "") || !Array.isArray(request.rows) || request.rows.length > 10000
        || !hostPaths.describe(request.config?.sessionRoot ?? "").foreignWindows
        || !/^[a-f0-9]{64}$/.test(request.storeBinding ?? "")
        || typeof request.windowsDataDir !== "string") {
        throw refused("A bounded Windows-to-WSL verification request is required.");
    }
    const dataDir = hostPaths.local(request.windowsDataDir);
    const state = JSON.parse(await readFile(path.join(dataDir, "workiq-evidence-board-v1.state.json"), "utf8"));
    assertCopilotState(state);
    if (!/^[a-f0-9]{64}$/.test(state.pseudonymKey ?? "")
        || sourceStoreBinding(state) !== request.storeBinding) throw refused("WSL reached a different retained store.");
    hostPaths.local(request.config.appDbPath);
    hostPaths.local(request.config.sessionRoot);
    const host = await collectorHostIdentity(), rows = [];
    for (const row of request.rows) {
        if (!uuid.test(row.sessionId ?? "") || row.logicalFile !== path.win32.join(request.config.sessionRoot, row.sessionId, "events.jsonl")) {
            throw refused("A verification row is outside the approved logical source root.");
        }
        const observed = await inspectHostHistoryFile(hostPaths.local(row.logicalFile), row);
        rows.push({ sessionId: row.sessionId, ...observed });
    }
    return { host, rows };
}

async function verifiedRows(context, policy, observeWsl) {
    if (typeof observeWsl !== "function") throw refused("The native WSL verifier is required.");
    const scope = await storeScope(context, policy), active = [];
    for (const row of scope.rows.filter(row => row.disposition === "verified")) {
        const observed = await inspectHostHistoryFile(row.logicalFile, row, { windowsIdentity: true });
        active.push({ ...row, startupEventId: observed.startupEventId, windows: observed.physical });
    }
    const native = await observeWsl(structuredClone({ kind: policy.kind, operationId: policy.operationId,
        windowsDataDir: paths(context).root, storeBinding: policy.storeBinding,
        config: { appDbPath: scope.config.appDbPath, sessionRoot: scope.config.sessionRoot }, rows: active }));
    if (native?.host?.platform !== "linux" || !sameHost(native.host, policy.targetHost)
        || native.rows?.length !== active.length) throw refused("Native WSL verification is incomplete or targets another host.");
    const targets = new Map(native.rows.map(row => [row.sessionId, row]));
    if (targets.size !== active.length) throw refused("Native WSL verification contains duplicate sources.");
    const rows = [];
    for (const row of scope.rows) {
        if (row.disposition !== "verified") { rows.push(row); continue; }
        const before = active.find(value => value.sessionId === row.sessionId), target = targets.get(row.sessionId);
        const again = await inspectHostHistoryFile(row.logicalFile, row, { windowsIdentity: true });
        if (!target || target.startupEventId !== before.startupEventId
            || JSON.stringify(again.physical) !== JSON.stringify(before.windows)) throw refused("A required source changed between hosts.");
        rows.push({ ...row, startupEventId: before.startupEventId, windows: physical(before.windows), linux: physical(target.physical) });
    }
    const current = await storeScope(context, policy);
    if (JSON.stringify(current.rows) !== JSON.stringify(scope.rows)
        || JSON.stringify(current.unpositioned) !== JSON.stringify(scope.unpositioned)
        || JSON.stringify(current.backfillReferences) !== JSON.stringify(scope.backfillReferences)) throw refused("The sealed source population changed.");
    return { ...scope, rows, targetHost: native.host };
}

export async function prepareHostHandover(context, policy, { authorize: gate, observeWsl } = {}) {
    context = Object.freeze({ dataDir: resolveDataDir(context) });
    policy = structuredClone(policy);
    await authorize(context, policy, gate, "prepare");
    return quiescent(context, async () => {
        const location = paths(context);
        if (await readJson(location.mapping)) {
            throw refused("A host handover already has state. Read its committed mapping; do not prepare another operation.");
        }
        const before = await snapshot(context), verified = await verifiedRows(context, policy, observeWsl);
        if (JSON.stringify(await snapshot(context)) !== JSON.stringify(before)) throw refused("The store changed during preparation.");
        const mapping = validateHostMapping({ schemaVersion: 1, kind: policy.kind, operationId: policy.operationId,
            windowsDataDir: location.root, storeBinding: policy.storeBinding, sourceFingerprint: policy.sourceFingerprint,
            originalHost: await collectorHostIdentity(), targetHost: verified.targetHost,
            rows: verified.rows, unpositioned: verified.unpositioned, backfillReferences: verified.backfillReferences });
        const plan = { schemaVersion: 1, policy, before, mapping, mappingHash: hash(JSON.stringify(mapping)),
            writeSet: [path.join("collector", HOST_MAPPING_FILE)] };
        return { ...plan, planHash: planDigest(plan) };
    });
}

export async function applyHostHandover(context, plan, { authorize: gate, observeWsl, reviewedPlanHash, afterMappingWrite } = {}) {
    if (afterMappingWrite !== undefined && typeof afterMappingWrite !== "function") throw new TypeError("Invalid handover publication observer.");
    context = Object.freeze({ dataDir: resolveDataDir(context) });
    plan = structuredClone(plan);
    await authorize(context, plan?.policy, gate, "apply");
    if (!/^[a-f0-9]{64}$/.test(reviewedPlanHash ?? "") || planDigest(plan) !== reviewedPlanHash
        || plan.schemaVersion !== 1 || hash(JSON.stringify(validateHostMapping(plan.mapping))) !== plan.mappingHash
        || plan.mapping.operationId !== plan.policy.operationId) throw refused("The reviewed handover plan changed.");
    return quiescent(context, async () => {
        const location = paths(context);
        if (await readJson(location.mapping)) {
            throw refused("This operation may already have applied. Read its committed mapping; no write was repeated.");
        }
        if (JSON.stringify(await snapshot(context)) !== JSON.stringify(plan.before)) throw refused("The reviewed store snapshot changed.");
        const verified = await verifiedRows(context, plan.policy, observeWsl);
        if (JSON.stringify(verified.rows) !== JSON.stringify(plan.mapping.rows)
            || JSON.stringify(verified.unpositioned) !== JSON.stringify(plan.mapping.unpositioned)
            || JSON.stringify(verified.backfillReferences) !== JSON.stringify(plan.mapping.backfillReferences)
            || verified.targetHost.machine !== plan.mapping.targetHost.machine) throw refused("The reviewed host bindings changed.");
        if (JSON.stringify(await snapshot(context)) !== JSON.stringify(plan.before)) throw refused("The store changed before mapping publication.");
        const committed = { outcome: "applied", planHash: reviewedPlanHash, mapping: plan.mapping };
        const record = validateCommittedHostMapping({ ...committed, seal: hash(JSON.stringify(committed)) });
        try {
            await atomicJson(location.mapping, record);
            await afterMappingWrite?.();
        }
        catch (cause) {
            throw Object.assign(error("HOST_HANDOVER_OUTCOME_UNKNOWN",
                "The mapping may have committed. Read this original operation's committed mapping; do not repeat Apply."), { cause });
        }
        return { outcome: "applied", operationId: plan.policy.operationId, planHash: reviewedPlanHash };
    });
}

export async function hostHandoverStatus(context, plan) {
    if (planDigest(plan) !== plan.planHash || !hostPaths.same(resolveDataDir(context), plan.policy.windowsDataDir)) throw refused("The original handover belongs to another plan or store.");
    const record = await readJson(paths(context).mapping);
    if (!record) return { outcome: "not-applied" };
    const { mapping } = validateCommittedHostMapping(record);
    if (record.planHash === plan.planHash && hash(JSON.stringify(mapping)) === plan.mappingHash
        && mapping.operationId === plan.policy.operationId) {
        return { outcome: "applied", operationId: plan.policy.operationId, planHash: record.planHash };
    }
    return { outcome: "unknown", operationId: plan.policy.operationId };
}
