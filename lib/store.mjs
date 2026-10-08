import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { BOARD_ID } from "./evidence.mjs";
import { dataDirFor } from "./paths.mjs";
import { filterDeletedRecords, artifactDeletionKey } from "./deletion-identities.mjs";
import { validatePersonalEvaluation } from "./personal-evaluation.mjs";

export const WORKFLOW_STATES = ["captured", "reviewing", "ready_to_export", "exported"];
const queues = new Map();

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

async function saveState(session, state) {
    const dir = resolveDataDir(session);
    const destination = path.join(dir, `${BOARD_ID}.state.json`);
    const temporary = path.join(dir, `.state-${randomUUID()}.tmp`);
    try {
        await writeExclusive(temporary, JSON.stringify(state, null, 2));
        await rename(temporary, destination);
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

async function readState(session) {
    const dir = resolveDataDir(session);
    await mkdir(path.join(dir, "exports"), { recursive: true });
    let state;
    try {
        state = JSON.parse(await readFile(path.join(dir, `${BOARD_ID}.state.json`), "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = defaultState();
        await saveState(session, state);
    }
    if (state.boardId !== BOARD_ID || !state.cards || !Array.isArray(state.exports)) throw new Error("Invalid persisted board state.");
    for (const id of Object.keys(state.cards)) {
        if (!state.cards[id] || !WORKFLOW_STATES.includes(state.cards[id].workflowState) || !Array.isArray(state.cards[id].history)) {
            throw new Error("Persisted review state contains an invalid card.");
        }
    }
    if (state.stateVersion === undefined) {
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
    if (![2, 3].includes(state.stateVersion) || !Number.isSafeInteger(state.revision) || !/^[a-f0-9]{64}$/.test(state.pseudonymKey)) {
        throw new Error("Unsupported or invalid persisted board version.");
    }
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
    return state;
}

export function loadBoardState(session) {
    return serialized(session, async () => {
        const state = await readState(session);
        assertDeletionComplete(state);
        return state;
    });
}

function assertDeletionComplete(state) {
    if (state.deletion?.pending && state.deletion.operations?.[state.deletion.pending]?.kind !== "artifact-deletion") throw new BoardError("Local deletion cleanup is incomplete. Activity and exports are unavailable until the runtime finishes the sealed cleanup; no new deletion was attempted.", 503);
}

export function exclusiveBoard(session, work) {
    return serialized(session, async () => work(await readState(session), state => saveState(session, state)));
}

export function updateBoardState(session, update) {
    return serialized(session, async () => {
        const state = await readState(session);
        assertDeletionComplete(state);
        const result = await update(state);
        state.revision += 1;
        await saveState(session, state);
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

// The caller owns the board writer queue and atomically saves the returned pointer
// together with any lifecycle authorization/receipt changes.
export async function stageEvidenceSnapshot(session, state, built) {
        const snapshot = { ...built, records: filterDeletedRecords(built.records, state.deletion) };
        if (new Set(snapshot.records.map((s) => s.scenarioId)).size !== snapshot.records.length) throw new Error("Duplicate scenario IDs in evidence snapshot.");
        const content = JSON.stringify(snapshot);
        if (JSON.stringify(snapshot.records) !== JSON.stringify(state.evidence ?? [])) state.evidenceRevision++;
        const file = `${createHash("sha256").update(content).digest("hex")}.json`;
        const directory = path.join(resolveDataDir(session), "private-evidence");
        await mkdir(directory, { recursive: true });
        try { await writeExclusive(path.join(directory, file), content); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        const at = new Date().toISOString();
        for (const scenario of snapshot.records) if (!state.cards[scenario.scenarioId]) state.cards[scenario.scenarioId] = {
            workflowState: "captured", updatedAt: at, history: [{ state: "captured", at, note: "Captured from bounded import or opt-in HTTP recorder." }],
        };
        state.stateVersion = 3;
        state.evidenceFile = file;
        state.continuation = snapshot.importCoverage?.dynamic
            ? "Dynamic approved local GitHub Copilot chat collection. Preserved evidence, review labels and saved reports remain intact."
            : "Bounded active-chat import and opt-in owned Graph recording. Earlier evidence and review history remain separate from imported-chat coverage.";
        Object.defineProperty(state, "evidence", { value: snapshot.records, configurable: true });
        Object.defineProperty(state, "importCoverage", { value: snapshot.importCoverage, configurable: true });
        return { scenarioCount: snapshot.records.length };
}
