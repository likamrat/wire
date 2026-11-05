import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { BOARD_ID } from "./evidence.mjs";
import { dataDirFor } from "./paths.mjs";
import { filterDeletedRecords, artifactDeletionKey, activityDeletionVersion } from "./deletion-identities.mjs";
import { validatePersonalEvaluation } from "./personal-evaluation.mjs";
import { validateNativeRetentionState, validateNativeReportState, validateNativeStorageState, validateNativeGlobalState } from "./native-retention-state.mjs";

export const WORKFLOW_STATES = ["captured", "reviewing", "ready_to_export", "exported"];
const queues = new Map();
const nativeIndexes = new Map();
const nativeIndex = state => ({ retention: state.nativeRetention === undefined ? null : structuredClone(state.nativeRetention),
    deletionVersion: activityDeletionVersion(state),
    deletionPending: Boolean(state.deletion?.pending && state.deletion.operations?.[state.deletion.pending]?.kind !== "artifact-deletion") });

export class BoardError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export function resolveDataDir(session) {
    return dataDirFor(session);
}

async function serialized(session, work) {
    const key = resolveDataDir(session);
    const previous = queues.get(key) ?? Promise.resolve();
    // A failed operation rejects its caller, but must not poison the next operation.
    const next = previous.then(work, work);
    queues.set(key, next);
    try {
        return await next;
    } finally {
        if (queues.get(key) === next) queues.delete(key);
    }
}

export async function writeExclusive(file, text) {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function preparePublicationCheck(check, preparePublication) {
    if (preparePublication) await preparePublication();
    try { check(); }
    catch (error) {
        if (!preparePublication) throw error;
        // The source owner may revalidate a known pre-write freshness race once.
        // No write is invoked here; every other failure must be rethrown by the owner.
        await preparePublication(error);
        check();
    }
}

async function saveState(session, state, required = {}, assertCurrent, preparePublication) {
    if (preparePublication !== undefined && (typeof preparePublication !== "function" || typeof assertCurrent !== "function")) {
        throw new BoardError("Publication preparation requires its synchronous guard.", 403);
    }
    const check = () => {
        if (assertCurrent === undefined) return;
        if (typeof assertCurrent !== "function") throw new BoardError("A synchronous publication guard is required.", 403);
        const result = assertCurrent();
        if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {});
            throw new BoardError("Asynchronous publication guards are not permitted.", 403);
        }
        if (result !== undefined && result !== true) throw new BoardError("Publication authority was revoked.", 403);
    };
    await preparePublicationCheck(check, preparePublication);
    if (required.reportPolicy !== undefined && state.nativeReportPolicy !== required.reportPolicy) {
        throw Object.assign(new TypeError("Committed native report policy cannot be removed or replaced."), { code: "NATIVE_REPORT_STATE_INVALID" });
    }
    if (required.retentionSchema === 2 && state.nativeRetention?.schemaVersion !== 2) {
        throw Object.assign(new TypeError("Committed segmented retention cannot be downgraded or removed."),
            { code: "NATIVE_RETENTION_STATE_INVALID" });
    }
    if (required.receiptArchive !== undefined
        && JSON.stringify(state.nativeRetention?.receiptArchive) !== JSON.stringify(required.receiptArchive)) {
        throw Object.assign(new TypeError("Committed native receipt recovery cannot be removed or replaced."),
            { code: "NATIVE_RETENTION_STATE_INVALID" });
    }
    if (required.hasBackfill && !Object.hasOwn(state.nativeRetention ?? {}, "backfill")) {
        throw Object.assign(new TypeError("Committed native history progress cannot be silently removed."),
            { code: "NATIVE_RETENTION_STATE_INVALID" });
    }
    if (required.hasGlobal !== undefined && (required.hasGlobal !== Object.hasOwn(state, "globalCollection")
        || required.hasGlobal && (state.globalCollection?.revision !== required.globalCollection.revision
            || state.globalCollection?.paused !== required.globalCollection.paused))) {
        throw Object.assign(new TypeError("Generic board writers must preserve the explicit global collection policy."),
            { code: "GLOBAL_COLLECTION_STATE_INVALID" });
    }
    state.stateVersion = Math.max(state.stateVersion ?? 2, required.version ?? 0);
    if (state.stateVersion === 5 && state.nativeReportPolicy === undefined) validateNativeReportState(state);
    if (state.nativeRetention !== undefined) {
        validateNativeRetentionState(state.nativeRetention);
        state.stateVersion = Math.max(state.stateVersion ?? 2, required.version ?? 0, state.nativeRetention.schemaVersion === 2 ? 7
            : state.nativeReportPolicy === undefined ? 4 : 5);
    }
    if (state.stateVersion === 7 && state.nativeRetention?.schemaVersion !== 2) {
        throw Object.assign(new TypeError("Segmented retention requires its explicit persisted state policy."),
            { code: "NATIVE_RETENTION_STATE_INVALID" });
    }
    validateNativeStorageState(state);
    const dir = resolveDataDir(session);
    const destination = path.join(dir, `${BOARD_ID}.state.json`);
    const temporary = path.join(dir, `.state-${randomUUID()}.tmp`);
    try {
        await writeExclusive(temporary, JSON.stringify(state, null, 2));
        await preparePublicationCheck(check, preparePublication);
        check();
        await rename(temporary, destination);
        nativeIndexes.set(dir, nativeIndex(state));
    } catch (error) {
        try {
            await unlink(temporary);
        } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "State update and temporary-file cleanup failed.");
        }
        throw error;
    }
}

function defaultState() {
    return {
        boardId: BOARD_ID, stateVersion: 2, revision: 0, evidenceRevision: 0,
        continuation: "Your local evidence collection. Connect an approved local Copilot source to begin.",
        cards: {},
        exports: [],
        pseudonymKey: randomBytes(32).toString("hex"),
    };
}

async function readState(session, { readOnly = false } = {}) {
    const dir = resolveDataDir(session);
    if (!readOnly) await mkdir(path.join(dir, "exports"), { recursive: true });
    let state;
    try {
        state = JSON.parse(await readFile(path.join(dir, `${BOARD_ID}.state.json`), "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (readOnly) throw new BoardError("Existing private state is unavailable. Read-only access did not initialize it.", 404);
        state = defaultState();
        await saveState(session, state);
    }
    if (state.boardId !== BOARD_ID || !state.cards || !Array.isArray(state.exports)) throw new Error("Invalid persisted board state.");
    for (const id of Object.keys(state.cards)) {
        if (!state.cards[id] || !WORKFLOW_STATES.includes(state.cards[id].workflowState) || !Array.isArray(state.cards[id].history)) {
            throw new Error("Persisted review state contains an invalid card.");
        }
    }
    validateNativeGlobalState(state);
    if (state.stateVersion === undefined) {
        validateNativeReportState(state);
        if (readOnly) throw new BoardError("Existing private state requires migration. Read-only access did not change it.", 422);
        const at = new Date().toISOString();
        for (const card of Object.values(state.cards)) {
            if (card.workflowState === "exported") {
                card.workflowState = "reviewing";
                card.updatedAt = at;
                card.history.push({ state: "reviewing", at, note: "Prior export is not privacy-approved. Disclosure review is required." });
            }
        }
        state.exports = [];
        state.stateVersion = 2;
        state.revision = 0;
        state.pseudonymKey = randomBytes(32).toString("hex");
        state.continuation = "Migrated review state. Earlier unapproved bundles are not linked; disclosure review is required.";
        await saveState(session, state);
    }
    if (!Number.isSafeInteger(state.revision) || !/^[a-f0-9]{64}$/.test(state.pseudonymKey)) {
        throw new Error("Unsupported or invalid persisted board version.");
    }
    validateNativeStorageState(state);
    state.evidenceRevision ??= state.revision;
    if (!Number.isSafeInteger(state.evidenceRevision) || state.evidenceRevision < 0) throw new Error("Invalid evidence revision.");
    if (state.personalEvaluation !== undefined) validatePersonalEvaluation(state.personalEvaluation);
    if (state.artifactDeletion !== undefined) {
        const marker = state.artifactDeletion;
        if (!marker || marker.schemaVersion !== 1 || !Number.isSafeInteger(marker.revision) || marker.revision < 0
            || !Array.isArray(marker.identities) || marker.identities.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
            || new Set(marker.identities).size !== marker.identities.length
            || Object.keys(marker).some(key => !["schemaVersion", "revision", "identities"].includes(key))) throw new Error("Invalid saved-artifact deletion metadata.");
        const removed = new Set(marker.identities);
        state.exports = state.exports.filter(entry => !removed.has(artifactDeletionKey(entry.kind ?? "report", entry.bundleId)));
    }
    if (state.deletion) {
        const validHashes = values => Array.isArray(values) && values.every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
        if (state.deletion.schemaVersion !== 1 || !["identities", "events", "contextCalls"].every(key => validHashes(state.deletion[key]))
            || state.deletion.promptAuthorizations !== undefined && (!state.deletion.promptAuthorizations
                || Array.isArray(state.deletion.promptAuthorizations)
                || Object.entries(state.deletion.promptAuthorizations).some(([event, aliases]) => !/^[a-f0-9]{64}$/.test(event) || !validHashes(aliases)))
            || state.deletion.pending && !state.deletion.operations?.[state.deletion.pending]) {
            throw new Error("Invalid deletion metadata. Collection cannot safely continue.");
        }
    }
    if (state.evidenceFile) {
        if (!/^[a-f0-9]{64}\.json$/.test(state.evidenceFile)) throw new Error("Invalid private evidence pointer.");
        const evidenceBytes = await readFile(path.join(dir, "private-evidence", state.evidenceFile), "utf8");
        if (`${createHash("sha256").update(evidenceBytes).digest("hex")}.json` !== state.evidenceFile) throw new Error("Private evidence snapshot integrity check failed.");
        const evidence = JSON.parse(evidenceBytes);
        if (!Array.isArray(evidence.records) || evidence.records.some((record) => !state.cards[record.scenarioId])) {
            throw new Error("Private evidence records do not match persisted review state.");
        }
        Object.defineProperty(state, "evidence", { value: evidence.records, configurable: true });
        Object.defineProperty(state, "importCoverage", { value: evidence.importCoverage, configurable: true });
    }
    nativeIndexes.set(dir, nativeIndex(state));
    return state;
}

export function committedNativeRetentionIndex(session) {
    const key = resolveDataDir(session);
    if (!nativeIndexes.has(key)) throw new BoardError("Committed native retention metadata has not been loaded.", 503);
    return structuredClone(nativeIndexes.get(key));
}
export function loadBoardState(session, options) {
    const readOnly = options?.readOnly === true;
    return serialized(session, async () => {
        const state = await readState(session, { readOnly });
        assertDeletionComplete(state);
        return state;
    });
}

function assertDeletionComplete(state) {
    if (state.deletion?.pending && state.deletion.operations?.[state.deletion.pending]?.kind !== "artifact-deletion") throw new BoardError("Local deletion cleanup is incomplete. Activity and exports are unavailable until the runtime finishes the sealed cleanup; no new deletion was attempted.", 503);
}

export function exclusiveBoard(session, work, options) {
    const readOnly = options?.readOnly === true;
    return serialized(session, async () => {
        const state = await readState(session, { readOnly });
        let required = storageFloor(state), active = true, globalEligible = true, publicationFailed = false;
        const save = async (next, assertCurrent, preparePublication) => {
            if (readOnly || publicationFailed) throw new BoardError("This board admission cannot save changes.", 403);
            globalEligible = false;
            await saveState(session, next, required, assertCurrent, preparePublication);
            required = storageFloor(next);
        };
        const saveGlobalCollection = async (input, assertCurrent) => {
            if (readOnly || !active || !globalEligible) throw new BoardError("An unused active writable board admission is required.", 403);
            validateNativeGlobalState(state);
            if (!input || Object.keys(input).length !== 2 || !Object.hasOwn(input, "expectedRevision") || !Object.hasOwn(input, "paused")
                || input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
                || typeof input.paused !== "boolean" || typeof assertCurrent !== "function") {
                throw Object.assign(new BoardError("Invalid global collection publication.", 422), { code: "GLOBAL_COLLECTION_STATE_INVALID" });
            }
            const previous = required.hasGlobal ? required.globalCollection : null;
            if ((previous?.revision ?? null) !== input.expectedRevision
                || required.hasGlobal !== Object.hasOwn(state, "globalCollection")
                || previous && (state.globalCollection.revision !== previous.revision || state.globalCollection.paused !== previous.paused)) {
                throw Object.assign(new BoardError("Global collection policy changed.", 409), { code: "GLOBAL_COLLECTION_REVISION_CHANGED" });
            }
            const check = () => {
                if (!active) throw new BoardError("The board publication admission expired.", 403);
                return assertCurrent();
            };
            if (previous?.paused === input.paused) {
                const result = check();
                if (result && typeof result.then === "function") {
                    Promise.resolve(result).catch(() => {});
                    throw new BoardError("Asynchronous publication guards are not permitted.", 403);
                }
                if (result !== undefined && result !== true) throw new BoardError("Publication authority was revoked.", 403);
                return Object.freeze({ ...previous });
            }
            const pair = { revision: (previous?.revision ?? 0) + 1, paused: input.paused };
            const next = { ...state, globalCollection: pair, stateVersion: Math.max(state.stateVersion, 6), revision: state.revision + 1 };
            if (!Number.isSafeInteger(next.revision)) throw new BoardError("Invalid board revision for global collection publication.", 409);
            validateNativeGlobalState(next);
            globalEligible = false;
            try { await saveState(session, next, { ...required, hasGlobal: true, globalCollection: pair }, check); }
            catch (error) { publicationFailed = true; throw error; }
            state.globalCollection = pair; state.stateVersion = next.stateVersion; state.revision = next.revision;
            required = storageFloor(state);
            return Object.freeze({ ...pair });
        };
        try { return await work(state, save, saveGlobalCollection); }
        finally { active = false; }
    });
}

export function updateBoardState(session, update) {
    return serialized(session, async () => {
        const state = await readState(session);
        assertDeletionComplete(state);
        const required = storageFloor(state);
        const result = await update(state);
        state.revision += 1;
        await saveState(session, state, required);
        return { state, result };
    });
}

export async function moveCard(session, scenarioId, toState) {
    if (!WORKFLOW_STATES.includes(toState) || toState === "exported") {
        throw new BoardError("Choose captured, reviewing, or ready_to_export. Exported requires a confirmed local bundle.");
    }
    const { state } = await updateBoardState(session, (current) => {
        if (!mergeEvidenceWithState(current).some((s) => s.scenarioId === scenarioId)) throw new BoardError("Unknown scenario.");
        const card = current.cards[scenarioId];
        card.workflowState = toState;
        card.updatedAt = new Date().toISOString();
        card.history.push({ state: toState, at: card.updatedAt, note: "Manual review move; tool outcomes unchanged." });
    });
    return state;
}

export function mergeEvidenceWithState(state) {
    const current = state.importCoverage?.dynamic ? new Map(state.importCoverage.roster.map(row => [row.sessionId, row])) : null;
    return (state.evidence ?? []).map((ev) => ({
        ...ev,
        ...(current && ev.workloadKind === "recorded-history" ? {
            collectionInactive: current.get(ev.sourceSessionId)?.eligible !== true,
            currentSourceDisposition: current.get(ev.sourceSessionId)?.disposition ?? "not-in-current-metadata",
        } : {}),
        workflowState: state.cards[ev.scenarioId].workflowState,
        workflowUpdatedAt: state.cards[ev.scenarioId].updatedAt,
        workflowHistory: state.cards[ev.scenarioId].history,
    }));
}

export async function replaceEvidence(session, build) {
    return updateBoardState(session, async (state) => {
        const built = await build(state.evidence ?? [], state.importCoverage);
        return stageEvidenceSnapshot(session, state, built);
    });
}

function storageFloor(state) {
    return { version: state.stateVersion, reportPolicy: state.nativeReportPolicy, retentionSchema: state.nativeRetention?.schemaVersion,
        receiptArchive: state.nativeRetention?.receiptArchive === undefined ? undefined : structuredClone(state.nativeRetention.receiptArchive),
        hasBackfill: Object.hasOwn(state.nativeRetention ?? {}, "backfill"),
        hasGlobal: Object.hasOwn(state, "globalCollection"),
        ...(Object.hasOwn(state, "globalCollection") ? { globalCollection: structuredClone(state.globalCollection) } : {}) };
}

export async function readPrivateEvidenceBytes(session, file, { maxBytes } = {}) {
    if (!/^[a-f0-9]{64}\.json$/.test(file ?? "") || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new BoardError("A bounded content-addressed private read is required.", 500);
    }
    const handle = await open(path.join(resolveDataDir(session), "private-evidence", file), "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new BoardError("Private snapshot exceeds its read bound.", 500);
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesRead) throw new BoardError("Private snapshot changed during its read.", 500);
            offset += result.bytesRead;
        }
        const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
        if (extra.bytesRead || `${createHash("sha256").update(bytes).digest("hex")}.json` !== file) {
            throw Object.assign(new BoardError("Private snapshot integrity check failed.", 500), { code: "EVIDENCE_SNAPSHOT_INTEGRITY" });
        }
        return bytes;
    } finally { await handle.close(); }
}

export async function verifyBoardStatePublication(session, state, assertCurrent) {
    if (typeof assertCurrent !== "function") throw new BoardError("A current board publication guard is required.", 403);
    const expected = Buffer.from(JSON.stringify(state, null, 2));
    const expectedHash = createHash("sha256").update(expected).digest("hex");
    assertCurrent();
    const handle = await open(path.join(resolveDataDir(session), `${BOARD_ID}.state.json`), "r");
    try {
        assertCurrent();
        const stat = await handle.stat();
        assertCurrent();
        if (!stat.isFile() || stat.size !== expected.length) throw new BoardError("The saved board publication could not be confirmed.", 500);
        const hash = createHash("sha256"), buffer = Buffer.alloc(Math.min(65536, Math.max(1, stat.size)));
        let offset = 0;
        while (offset < stat.size) {
            const result = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            assertCurrent();
            if (!result.bytesRead) throw new BoardError("The saved board publication changed during readback.", 500);
            hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
        }
        const extra = await handle.read(buffer, 0, 1, offset);
        assertCurrent();
        if (extra.bytesRead || hash.digest("hex") !== expectedHash) throw new BoardError("The saved board publication could not be confirmed.", 500);
    } finally { await handle.close(); }
    assertCurrent();
}

export async function stagePrivateEvidence(session, content, { maxBytes } = {}) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(content) > maxBytes)) {
        throw new BoardError("Private snapshot exceeds its write bound.", 500);
    }
    const file = `${createHash("sha256").update(content).digest("hex")}.json`;
    const directory = path.join(resolveDataDir(session), "private-evidence");
    await mkdir(directory, { recursive: true });
    try { await writeExclusive(path.join(directory, file), content); }
    catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = maxBytes === undefined ? await readFile(path.join(directory, file))
            : await readPrivateEvidenceBytes(session, file, { maxBytes });
        if (!existing.equals(Buffer.from(content, "utf8"))) {
            throw Object.assign(new BoardError("Existing private snapshot bytes do not match their content address; no pointer was committed.", 500),
                { code: "EVIDENCE_SNAPSHOT_INTEGRITY" });
        }
    }
    return file;
}

// The caller owns the board writer queue and atomically saves the returned pointer
// together with any lifecycle authorization/receipt changes.
export async function stageEvidenceSnapshot(session, state, built) {
        const snapshot = { ...built, records: filterDeletedRecords(built.records, state.deletion) };
        if (new Set(snapshot.records.map((s) => s.scenarioId)).size !== snapshot.records.length) throw new Error("Duplicate scenario IDs in evidence snapshot.");
        const content = JSON.stringify(snapshot);
        if (JSON.stringify(snapshot.records) !== JSON.stringify(state.evidence ?? [])) state.evidenceRevision++;
        const file = await stagePrivateEvidence(session, content);
        const at = new Date().toISOString();
        for (const scenario of snapshot.records) if (!state.cards[scenario.scenarioId]) state.cards[scenario.scenarioId] = {
            workflowState: "captured", updatedAt: at, history: [{ state: "captured", at, note: "Captured from bounded import or opt-in HTTP recorder." }],
        };
        state.stateVersion = state.nativeRetention ? 4 : 3;
        state.evidenceFile = file;
        state.continuation = snapshot.importCoverage?.dynamic
            ? "Dynamic approved local GitHub Copilot chat collection. Preserved evidence, review labels and saved reports remain intact."
            : "Bounded active-chat import and opt-in owned Graph recording. Earlier evidence and review history remain separate from imported-chat coverage.";
        Object.defineProperty(state, "evidence", { value: snapshot.records, configurable: true });
        Object.defineProperty(state, "importCoverage", { value: snapshot.importCoverage, configurable: true });
        return { scenarioCount: snapshot.records.length };
}
