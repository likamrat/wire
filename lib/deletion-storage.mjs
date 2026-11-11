import { readFile, readdir, lstat, mkdir, rename, unlink, chmod, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { BoardError, writeExclusive } from "./store.mjs";
import { deletionHash, filterDeletedRecords, filterDeletedEvents, eventIdentity, callIdentity, recordUnits, artifactDeletionKey, activityDeletionVersion, LOCAL_DELETION_IDENTITY_VERSION, nativeObservationDeletionIdentity, nativeObservationDeletionAliases } from "./deletion-identities.mjs";
import { BOARD_ID } from "./evidence.mjs";
import { time } from "./time.mjs";
import { validateCaptureEnvelope } from "./personal-evaluation.mjs";
import { NATIVE_RETAINED_CONTRACT, nativeConversationIdentity } from "./native-read-model.mjs";
import { nativeRetainedInventory, filterNativeRetainedDocument, nativeRetainedObservationIdentity,
    restoreNativeRetainedObservation } from "./native-retention-contract.mjs";
import { NATIVE_SEGMENTED_CONTRACT, decodeNativeSegmentedBlock, encodeNativeSegmentedBlock,
    nativeSegmentedEnvelope } from "./native-segmented-codec.mjs";
import { DELETION_LIMITS } from "./deletion-limits.mjs";
import { assertCollectorLockOwned, contextFits, TAIL_LIMITS } from "./collector-io.mjs";
import { validateCollectorIndex } from "./collector-index.mjs";
import { validateNativeArtifactDeletionSeal } from "./native-retention-state.mjs";
import { validEventEnvelope, isHistoryGap } from "./prompt-linkage.mjs";
import { validateReferenceCheckpoint, hasCompletionReference } from "./checkpoint-references.mjs";
export { DELETION_LIMITS } from "./deletion-limits.mjs";

const snapshotName = /^[a-f0-9]{64}\.json$/;
const migrationName = /^migration-[a-f0-9-]{36}$/;
const stateNames = [`${BOARD_ID}.state.json`, "prior-state.snapshot.json", path.join("collector", "before-dynamic-state.json")];
const artifactPlans = new WeakMap();
const checkpointTemporaryName = /^([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;
function checkpointName(name) {
    if (/^[a-zA-Z0-9-]+\.json$/.test(name)) return { source: name.slice(0, -5), temporary: false };
    // Preserve atomicJson staging status while retaining the canonical source's tombstone identity.
    const temporary = checkpointTemporaryName.exec(name);
    return temporary ? { source: temporary[1], temporary: true } : null;
}
function validateCheckpoint(value, file, validateBackfillCheckpoint) {
    const invalid = () => { throw new BoardError("Unsupported collector checkpoint. Nothing deleted.", 409); };
    const object = item => item !== null && typeof item === "object" && !Array.isArray(item);
    const only = (item, keys) => object(item) && Object.keys(item).every(key => keys.includes(key));
    const count = item => Number.isSafeInteger(item) && item >= 0;
    if (!object(value) || ![1, 2].includes(value.schemaVersion) || !Array.isArray(value.events)) invalid();
    if (value.schemaVersion === 1 && (value.completionReferences !== undefined || value.events.some(hasCompletionReference))) invalid();
    if (value.schemaVersion === 2) {
        if (value.backfill !== undefined || value.backfillSource !== undefined || !contextFits(value.events)) invalid();
        return true;
    }
    const backfill = Object.hasOwn(value, "backfill") || Object.hasOwn(value, "backfillSource");
    const extendedPending = !backfill && value.cursor?.partialBytes > TAIL_LIMITS.maxLineBytes;
    if (backfill) {
        if (typeof validateBackfillCheckpoint !== "function") throw Object.assign(
            new BoardError("The retained backfill checkpoint validator is required for safe deletion.", 503),
            { code: "BACKFILL_DELETION_VALIDATOR_REQUIRED" });
        let validated;
        try { validated = validateBackfillCheckpoint(value); }
        catch (error) { if (error instanceof TypeError) invalid(); throw error; }
        if (validated && typeof validated.then === "function") {
            Promise.resolve(validated).catch(() => {}); invalid();
        }
        if (validated !== value || value.backfillSource !== file.source) invalid();
    }
    if (file.checkpointStaging || extendedPending) {
        if (!only(value, ["schemaVersion", "cursor", "events", "diagnostics", "backfillSource", "backfill"])
            || !contextFits(value.events) || value.events.some(event => !validEventEnvelope(event) && !isHistoryGap(event)
                || event.type === "session.start" && event.data?.sessionId !== file.source)
            || !only(value.diagnostics, ["credentialExclusions", "contextEvictions", "unsupportedPromptContents"])
            || !Object.values(value.diagnostics).every(count)) invalid();
        const cursor = value.cursor;
        if (!only(cursor, ["identity", "offset", "droppedBytes", "rotations", "malformedLines", "oversizedLines",
            "skipping", "skipReason", "partialBytes", "logBytes", "backlogBytes", "anchor"])
            || typeof cursor.identity !== "string" || !/^[A-Za-z0-9_.:-]{1,1024}$/.test(cursor.identity)
            || !/^[a-f0-9]{64}$/.test(cursor.anchor ?? "") || typeof cursor.skipping !== "boolean"
            || !["offset", "droppedBytes", "rotations", "malformedLines", "oversizedLines", "partialBytes", "logBytes", "backlogBytes"].every(key => count(cursor[key]))
            || cursor.offset > cursor.logBytes || cursor.backlogBytes !== cursor.logBytes - cursor.offset
            || (extendedPending ? cursor.partialBytes >= TAIL_LIMITS.chunkBytes : cursor.partialBytes > TAIL_LIMITS.maxLineBytes)
            || cursor.partialBytes > cursor.backlogBytes || cursor.skipping && cursor.partialBytes !== 0
            || extendedPending && (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(file.source ?? "")
                || cursor.skipReason !== undefined)
            || cursor.skipReason !== undefined && !["oversized-line", "initial-window", "unavailable"].includes(cursor.skipReason)) invalid();
    }
    return extendedPending;
}

export async function safeDeletionFile(root, relative) {
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new BoardError("Unsafe local deletion path.", 422);
    const full = path.join(root, relative);
    for (let current = full; ; current = path.dirname(current)) {
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new BoardError("Deletion refuses linked private files or directories.", 409);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (path.dirname(current) === current) break;
    }
    return full;
}

function areaRoot(root, area) {
    if (area === "data") return root;
    if (!migrationName.test(area)) throw new BoardError("Invalid managed recovery area.", 409);
    return path.join(path.dirname(root), "backups", area);
}
const location = (root, file) => safeDeletionFile(areaRoot(root, file.area), file.relative);
async function readExtendedPendingIndex(root, area) {
    const file = await safeDeletionFile(areaRoot(root, area), path.join("collector", "index.json"));
    let info;
    try { info = await lstat(file); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw new BoardError("Extended pending checkpoint metadata requires its own committed collector index2 barrier.", 409);
    }
    if (!info.isFile() || info.size > DELETION_LIMITS.fileBytes) throw new BoardError("Collector index exceeds the safe deletion input limit.", 413);
    const handle = await open(file, "r");
    let bytes;
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink > 1 || opened.size !== info.size || opened.ino !== info.ino) {
            throw new BoardError("Collector index changed while opening it. Nothing deleted.", 409);
        }
        bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesRead) throw new BoardError("Collector index changed during deletion preparation.", 409);
            offset += result.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new BoardError("Collector index grew during deletion preparation.", 409);
    } finally { await handle.close(); }
    let value;
    try { value = JSON.parse(bytes); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("The pending checkpoint collector index is invalid. Nothing deleted.", 409);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![2, 3, 4].includes(value.schemaVersion) || value.boundedHistoryVersion !== 1) {
        throw new BoardError("Extended pending checkpoint metadata requires a bounded collector index barrier.", 409);
    }
    try { validateCollectorIndex(value); }
    catch { throw new BoardError("The pending checkpoint collector owner or version is invalid. Nothing deleted.", 409); }
    return { hash: deletionHash(bytes), bytes: bytes.length, referenceIndex: {
        schemaVersion: value.schemaVersion, completionReferenceVersion: value.completionReferenceVersion,
        completionReferenceStore: value.completionReferenceStore, completionReferenceSources: value.completionReferenceSources,
    } };
}
async function assertCheckpointIndex(root, file) {
    if (!/^[a-f0-9]{64}$/.test(file.checkpointIndexHash ?? "")) throw new BoardError("Pending checkpoint index qualification is missing.", 409);
    const index = await readExtendedPendingIndex(root, file.area);
    if (index.hash !== file.checkpointIndexHash) throw new BoardError("Pending checkpoint collector index changed. Preview again.", 409);
    return index.referenceIndex;
}
async function optional(file) {
    try { return await readFile(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function entries(root, relative) {
    try { return (await readdir(await safeDeletionFile(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function managedAreas(root) {
    const areas = ["data"];
    const manifest = await optional(await safeDeletionFile(root, "migration-manifest.json"));
    if (manifest) {
        const backup = JSON.parse(manifest).backup;
        if (backup) {
            const name = path.basename(backup);
            if (!migrationName.test(name) || path.resolve(backup) !== areaRoot(root, name)) throw new BoardError("Migration backup is outside the managed recovery area. Deletion cannot safely cover it.", 409);
            if (!await optional(await safeDeletionFile(areaRoot(root, name), "migration-manifest.json"))) throw new BoardError("Managed migration backup manifest is missing.", 409);
            areas.push(name);
        }
    }
    return areas;
}

export async function deletionInventory(root, { includeActivity = true, includeNativeSegments = false, validateBackfillCheckpoint } = {}) {
    await safeDeletionFile(root, stateNames[0]);
    const areas = await managedAreas(root);
    const files = [], recordsByHash = new Map(), checkpointIndexes = new Map();
    let bytesRead = 0, uniqueRecordBytes = 0, metadataBytes = 0;
    async function add(area, relative, kind, extra = {}) {
        const file = { area, relative, kind, ...extra };
        const source = await location(root, file);
        let size;
        try { size = (await lstat(source)).size; }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        if (size > DELETION_LIMITS.fileBytes) throw new BoardError("A local deletion input exceeds the 16 MiB per-file limit. Nothing deleted.", 413);
        if (files.length + checkpointIndexes.size >= DELETION_LIMITS.files || bytesRead + size > DELETION_LIMITS.totalBytes) throw new BoardError("Deletion preview exceeds the bounded local storage scan. Nothing deleted.", 413);
        const bytes = await optional(source);
        if (!bytes) return;
        bytesRead += bytes.length;
        if (bytes.length > DELETION_LIMITS.fileBytes || bytesRead > DELETION_LIMITS.totalBytes) throw new BoardError("Local deletion inputs grew beyond the safe scan limits. Nothing deleted.", 413);
        let value = kind === "staging" ? null : JSON.parse(bytes);
        if (kind === "snapshot" && `${deletionHash(bytes)}.json` !== path.basename(relative)) throw new BoardError("Private evidence integrity check failed.", 409);
        if (kind === "snapshot" && value.contractVersion === NATIVE_SEGMENTED_CONTRACT) {
            if (!includeNativeSegments) throw Object.assign(
                new BoardError("Segmented retained blocks require qualified local activity deletion. Nothing deleted.", 503),
                { code: "NATIVE_SEGMENTED_DELETION_REQUIRED" });
            const block = decodeNativeSegmentedBlock(bytes, deletionHash(bytes)), records = [];
            for (const row of block.kind === "segment" ? block.entries : []) {
                if (row.kind === "variant") {
                    const record = restoreNativeRetainedObservation(row.content, row.seedProvenance, row.seedCapture);
                    records.push({ recordKind: "native-retained-observation",
                        nativeObservationKey: nativeRetainedObservationIdentity(record, block.account),
                        scenarioId: nativeConversationIdentity(record.scope), capturedAt: null });
                } else if (row.kind === "observation") records.push({
                    recordKind: "native-retained-observation", nativeObservationKey: row.identity, capturedAt: null,
                });
                else if (row.observationRef || row.kind === "capture") records.push({
                    recordKind: "native-retained-observation-reference",
                    nativeObservationRef: row.observationRef ?? row.witness.observationRef, capturedAt: null,
                    ...(row.kind === "record" ? { scenarioId: row.conversationKey } : {}),
                });
            }
            kind = "native-segment";
            value = { blockKind: block.kind, account: block.account, records };
        }
        if (kind === "snapshot" && value.contractVersion === NATIVE_RETAINED_CONTRACT) {
            kind = "native-snapshot";
            value = { records: nativeRetainedInventory(value) };
        }
        if (kind === "snapshot" && !Array.isArray(value.records)) throw new BoardError("Invalid private evidence snapshot.", 409);
        if (kind === "http" && (typeof value.recordId !== "string" || !value.recordId || value.recordId.length > 1000)) throw new BoardError("Invalid HTTP record identity. Nothing deleted.", 409);
        if (kind === "capture") {
            if (`${deletionHash(bytes)}.json` !== path.basename(relative)) throw new BoardError("Captured evidence integrity check failed. Nothing deleted.", 409);
            validateCaptureEnvelope(value);
            const { text, ...envelope } = value;
            value = { envelope, payloadBytes: Buffer.byteLength(text) };
        }
        if (kind === "snapshot") {
            // Roster/coverage copies dominate retained storage. Read them one file at a
            // time, and intern repeated record versions instead of retaining every copy.
            value = { records: value.records.map(record => {
                const text = JSON.stringify(record), id = deletionHash(text);
                if (!recordsByHash.has(id)) {
                    uniqueRecordBytes += Buffer.byteLength(text);
                    if (uniqueRecordBytes > DELETION_LIMITS.uniqueRecordBytes) throw new BoardError("Unique retained record versions exceed the 64 MiB deletion memory budget. Nothing deleted.", 413);
                    recordsByHash.set(id, record);
                }
                return recordsByHash.get(id);
            }) };
        } else if (kind === "checkpoint") {
            if (validateCheckpoint(value, file, validateBackfillCheckpoint)) {
                if (!checkpointIndexes.has(area)) {
                    if (files.length + checkpointIndexes.size + 1 >= DELETION_LIMITS.files) throw new BoardError("Deletion input file limit exceeded.", 413);
                    const index = await readExtendedPendingIndex(root, area);
                    bytesRead += index.bytes;
                    if (bytesRead > DELETION_LIMITS.totalBytes) throw new BoardError("Deletion input byte limit exceeded.", 413);
                    checkpointIndexes.set(area, index);
                }
                file.checkpointIndexHash = checkpointIndexes.get(area).hash;
                if (value.schemaVersion === 2) validateReferenceCheckpoint(value, {
                    index: checkpointIndexes.get(area).referenceIndex, sourceSessionId: file.source,
                    fingerprint: path.basename(path.dirname(file.relative)),
                });
                metadataBytes += Buffer.byteLength(JSON.stringify({ checkpointIndexHash: file.checkpointIndexHash }));
            }
            value = { events: (value.events ?? []).map(event => ({
                id: event.id, type: event.type, timestamp: event.timestamp, data: { toolCallId: event.data?.toolCallId,
                    ...(Array.isArray(event.data?.wireToolRequestIds) ? { wireToolRequestIds: event.data.wireToolRequestIds } : {}) },
            })) };
        } else if (kind === "http") {
            value = { recordId: value.recordId, startedAt: value.startedAt };
        }
        if (kind !== "snapshot") {
            metadataBytes += Buffer.byteLength(JSON.stringify(value));
            if (metadataBytes > DELETION_LIMITS.metadataBytes) throw new BoardError("Retained deletion metadata exceeds the 32 MiB scan memory budget. Nothing deleted.", 413);
        }
        files.push({ ...file, kind, hash: deletionHash(bytes), value });
    }
    for (const area of areas) {
        const base = areaRoot(root, area);
        for (const entry of includeActivity ? await entries(base, "private-evidence") : []) {
            if (!snapshotName.test(entry.name) || !entry.isFile()) throw new BoardError("Unrecognized private evidence file. Nothing deleted.", 409);
            await add(area, path.join("private-evidence", entry.name), "snapshot");
        }
        for (const relative of stateNames) {
            if (area === "data" && relative === stateNames[0]) continue;
            await add(area, relative, "state");
        }
        for (const entry of includeActivity ? await entries(base, "http-records") : []) {
            if (!entry.isFile() || !/^[a-zA-Z0-9-]+\.json$/.test(entry.name)) throw new BoardError("Unrecognized HTTP record file. Nothing deleted.", 409);
            await add(area, path.join("http-records", entry.name), "http");
        }
        for (const entry of await entries(base, "assessment-evidence")) {
            if (!entry.isFile() || !snapshotName.test(entry.name)) throw new BoardError("Unrecognized captured-evidence file. Nothing deleted.", 409);
            await add(area, path.join("assessment-evidence", entry.name), "capture");
        }
    }
    for (const area of includeActivity ? areas : []) for (const directory of await entries(areaRoot(root, area), "collector")) {
        if (!/^[a-f0-9]{64}$/.test(directory.name)) continue;
        if (!directory.isDirectory()) throw new BoardError("Linked collector directory is not deletable.", 409);
        for (const entry of await entries(areaRoot(root, area), path.join("collector", directory.name))) {
            const identity = checkpointName(entry.name);
            if (!entry.isFile() || !identity) throw new BoardError("Unrecognized collector checkpoint. Nothing deleted.", 409);
            await add(area, path.join("collector", directory.name, entry.name), "checkpoint", {
                source: identity.source, ...(identity.temporary ? { checkpointStaging: true } : {}),
            });
        }
    }
    for (const entry of includeActivity ? await entries(root, "recorder-attempts") : []) {
        if (!entry.isFile() || !/^\d{13}-[a-f0-9-]{36}\.(attempt|result)\.json$/.test(entry.name)) throw new BoardError("Unrecognized recorder receipt. Nothing deleted.", 409);
        await add("data", path.join("recorder-attempts", entry.name), "attempt");
    }
    // Interrupted pre-commit state writes can contain old review material too.
    for (const area of areas) {
        const base = areaRoot(root, area);
        for (const entry of await readdir(base, { withFileTypes: true })) {
            if (/^\.state-[a-f0-9-]{36}\.tmp$/.test(entry.name)) await add(area, entry.name, "state");
        }
        for (const directory of await entries(base, "deletion-staging")) {
            if (!/^[a-f0-9-]{36}$/.test(directory.name) || !directory.isDirectory()) throw new BoardError("Unrecognized deletion staging area.", 409);
            for (const entry of await entries(base, path.join("deletion-staging", directory.name))) {
                if (!/^\d+\.json$/.test(entry.name) || !entry.isFile()) throw new BoardError("Unrecognized deletion staging file.", 409);
                await add(area, path.join("deletion-staging", directory.name, entry.name), "staging");
            }
        }
    }
    for (const [area, index] of checkpointIndexes) await assertCheckpointIndex(root, { area, checkpointIndexHash: index.hash });
    return files;
}

export function captureRevocationMaterializations(files, state, revokedConsentRevision, selectCleanup) {
    const linked = linkedEvaluationPlan(files, state.personalEvaluation, state.evidence ?? [], new Map(), {}, {
        scope: "capture-revocation", revokedConsentRevision,
    }, selectCleanup);
    const actions = [...linked.actions];
    for (const file of files) {
        if (file.kind === "state") {
            const next = { ...file.value,
                ...(linked.updates.has(file) ? { personalEvaluation: linked.updates.get(file) } : {}),
                deletion: { schemaVersion: 1, identities: [], events: [], contextCalls: [], ...file.value.deletion,
                    epoch: Math.max(activityDeletionVersion(file.value), activityDeletionVersion(state) + 1) },
            };
            actions.push({ ...file, text: JSON.stringify(next), destination: file.relative });
        } else if (file.kind === "staging") actions.push({ ...file, text: null, destination: file.relative });
    }
    return { personalEvaluation: linked.next, linkedInsights: linked.counts, actions: actions.map(({ value, ...action }) => action) };
}

export function inventoryRecords(files) {
    return [...new Set(files.flatMap(file => ["snapshot", "native-snapshot", "native-segment"].includes(file.kind) ? file.value.records : file.kind === "http" ? [{
        scenarioId: `graph-${file.value.correlation?.scenarioId ?? file.value.recordId}`,
        sourceSessionId: file.value.correlation?.sessionId, httpRecords: [file.value],
    }] : []))];
}

async function replacementContent(root, file, recipe, validateBackfillCheckpoint) {
    const source = await location(root, file);
    if ((await lstat(source)).size > DELETION_LIMITS.fileBytes) throw new BoardError("A snapshot grew beyond the safe per-file limit.", 409);
    const bytes = await readFile(source);
    if (bytes.length > DELETION_LIMITS.fileBytes || deletionHash(bytes) !== file.hash) throw new BoardError("A retained snapshot changed during deletion preparation. Preview again.", 409);
    const value = JSON.parse(bytes);
    if (recipe.nativeObservationKeys) {
        const keep = new Set(recipe.nativeObservationKeys);
        const original = new Set(value.observations.map(item => item.key));
        if ([...keep].some(key => !original.has(key))) throw new BoardError("Native deletion membership changed. Preview again.", 409);
        const identities = value.observations.filter(item => !keep.has(item.key)).map(item => nativeObservationDeletionIdentity(item.key));
        return JSON.stringify(filterNativeRetainedDocument(value, { identities }));
    }
    if (recipe.snapshotRecords) return JSON.stringify({ ...value, records: recipe.snapshotRecords });
    if (validateCheckpoint(value, file, validateBackfillCheckpoint)) {
        const index = await assertCheckpointIndex(root, file);
        if (value.schemaVersion === 2) validateReferenceCheckpoint(value, { index, sourceSessionId: file.source,
            fingerprint: path.basename(path.dirname(file.relative)) });
    }
    const redacted = new Set(recipe.checkpointEvents.redact);
    return JSON.stringify({ ...value, events: recipe.checkpointEvents.keep.map(index => {
        const event = value.events[index];
        if (redacted.has(index)) return { id: event.id, type: event.type, timestamp: event.timestamp, data: { content: null } };
        const requests = recipe.checkpointEvents.toolRequestIndices?.[index];
        return requests ? { ...event, data: { ...event.data, wireToolRequestIds: requests.map(position => event.data.wireToolRequestIds[position]) } } : event;
    }) });
}

function linkedEvaluationPlan(files, personalEvaluation, remaining, remainingBySnapshot, markers, scope, selectCleanup) {
    const captures = files.filter(file => file.kind === "capture");
    const removed = new Set([...(markers.identities ?? []), ...(markers.events ?? []), ...(markers.contextCalls ?? [])]);
    const revoked = scope.revokedConsentRevision ?? null;
    const selected = captures.filter(file => scope.scope === "all"
        || file.value.envelope.dependencies.deletionKeys.some(key => removed.has(key))
        || file.value.envelope.captureKeys.some(key => removed.has(key.eventHash))
        || revoked !== null && file.value.envelope.consentRevision <= revoked);
    const descriptors = [...new Map(selected.map(file => [path.basename(file.relative), {
        payloadFile: path.basename(file.relative), ...file.value,
    }])).values()];
    const headers = new Map(captures.map(file => [path.basename(file.relative), file.value.envelope]));
    const hasLinked = value => value?.captures?.length || value?.feedback?.records?.length
        || Object.values(value?.mutations ?? {}).some(mutation => mutation.dependencies);
    if (typeof selectCleanup !== "function" && (selected.length || hasLinked(personalEvaluation) || files.some(file => file.kind === "state" && hasLinked(file.value.personalEvaluation)))) {
        throw new BoardError("Linked insight cleanup is not connected. Nothing deleted.", 503);
    }
    const interactions = new Set(), captureRefs = new Set(descriptors.map(item => item.envelope.observationRef)), feedbackRefs = new Set(), payloadFiles = new Set(descriptors.map(item => item.payloadFile));
    const updates = new Map();
    function apply(value, records) {
        if (typeof selectCleanup !== "function" || !value && !descriptors.length) return value;
        for (const capture of value?.captures ?? []) {
            const envelope = headers.get(capture.payloadFile);
            if (envelope && (envelope.observationRef !== capture.observation.observationRef
                || envelope.interactionRef !== capture.observation.interactionRef
                || JSON.stringify([...envelope.dependencies.deletionKeys].sort()) !== JSON.stringify([...capture.dependencies.deletionKeys].sort()))) {
                throw new BoardError("Captured evidence does not match its owning index. Nothing deleted.", 409);
            }
        }
        const result = selectCleanup(value, {
            removedIdentities: [...markers.identities ?? []], removedEvents: [...markers.events ?? []], removedContextCalls: [...markers.contextCalls ?? []],
            remainingRecords: records, removedCapturePayloads: descriptors, revokedConsentRevision: revoked, allCollectedActivity: scope.scope === "all",
        });
        if (!result?.next || !Array.isArray(result.payloadFiles) || result.payloadFiles.some(name => !snapshotName.test(name))
            || !Array.isArray(result.affectedInteractionRefs)) throw new BoardError("Invalid linked cleanup result. Nothing deleted.", 500);
        result.payloadFiles.forEach(name => payloadFiles.add(name));
        result.affectedInteractionRefs.forEach(ref => interactions.add(ref));
        const keptCaptures = new Set(result.next.captures.map(item => item.observation.observationRef));
        for (const item of value?.captures ?? []) if (!keptCaptures.has(item.observation.observationRef)) captureRefs.add(item.observation.observationRef);
        const keptFeedback = new Set(result.next.feedback.records.map(item => item.assessment.assessmentRef));
        for (const item of value?.feedback?.records ?? []) if (!keptFeedback.has(item.assessment.assessmentRef)) feedbackRefs.add(item.assessment.assessmentRef);
        if (revoked !== null && personalEvaluation) result.next.consent = structuredClone(personalEvaluation.consent);
        return result.next;
    }
    const next = apply(personalEvaluation, remaining);
    for (const file of files.filter(file => file.kind === "state")) {
        const value = apply(file.value.personalEvaluation, remainingBySnapshot.get(`${file.area}:${file.value.evidenceFile}`) ?? []);
        if (JSON.stringify(value) !== JSON.stringify(file.value.personalEvaluation)) updates.set(file, value);
    }
    const actions = captures.filter(file => payloadFiles.has(path.basename(file.relative)))
        .map(({ value, ...file }) => ({ ...file, text: null, destination: file.relative }));
    return { next, updates, actions, counts: { interactions: interactions.size, capturedItems: captureRefs.size, feedbackRevisions: feedbackRefs.size } };
}

export async function deletionMaterializations(root, files, markers, scope, remaining, options = {}) {
    const eventIds = new Set(markers.events ?? []), contextCalls = new Set(markers.contextCalls ?? []);
    const snapshotRecords = inventoryRecords(files.filter(file => file.kind === "snapshot"));
    const units = snapshotRecords.flatMap(recordUnits);
    const blocked = new Set(markers.identities);
    const retainedCopies = filterDeletedRecords(snapshotRecords, markers);
    const keptPrompts = new Set([...remaining, ...retainedCopies].flatMap(record => [record.userPrompt, ...(record.followUpPrompts ?? [])].filter(prompt => prompt?.sourceEventId).map(prompt => eventIdentity(record.sourceSessionId, prompt.sourceEventId))));
    const keptModelEvents = new Set([...remaining, ...retainedCopies].flatMap(record =>
        (record.originalModelEvidence?.responses ?? []).map(response => eventIdentity(record.sourceSessionId, response.eventId))));
    for (const unit of units) if (unit.aliases.some(id => blocked.has(id))) {
        if (unit.item.toolCallId) contextCalls.add(callIdentity(unit.record.sourceSessionId, unit.item.toolCallId));
        if (unit.item.startEventId) eventIds.add(eventIdentity(unit.record.sourceSessionId, unit.item.startEventId));
        if (unit.item.completionEventId) eventIds.add(eventIdentity(unit.record.sourceSessionId, unit.item.completionEventId));
        for (const response of unit.record.originalModelEvidence?.responses ?? []) {
            const id = eventIdentity(unit.record.sourceSessionId, response.eventId);
            if (!keptModelEvents.has(id)) eventIds.add(id);
        }
        for (const prompt of [unit.record.userPrompt, ...(unit.record.followUpPrompts ?? [])]) if (prompt?.sourceEventId) {
            const id = eventIdentity(unit.record.sourceSessionId, prompt.sourceEventId);
            if (!keptPrompts.has(id)) eventIds.add(id);
        }
    }
    if (scope.scope === "all") for (const file of files) if (file.kind === "checkpoint") for (const event of file.value.events ?? []) {
        eventIds.add(eventIdentity(file.source, event.id));
        if (event.data?.toolCallId) contextCalls.add(callIdentity(file.source, event.data.toolCallId));
    }
    const deletion = { ...markers, events: [...eventIds].sort(), contextCalls: [...contextCalls].sort() };
    const actions = [], pointers = new Map(), retainedBySnapshot = new Map(), remainingBySnapshot = new Map(), removedScenarios = new Set();
    for (const file of files.filter(file => file.kind === "snapshot")) {
        const records = filterDeletedRecords(file.value.records, deletion);
        const ids = new Set(records.map(record => record.scenarioId));
        retainedBySnapshot.set(`${file.area}:${path.basename(file.relative)}`, ids);
        remainingBySnapshot.set(`${file.area}:${path.basename(file.relative)}`, records);
        file.value.records.filter(record => !ids.has(record.scenarioId)).forEach(record => removedScenarios.add(record.scenarioId));
        if (JSON.stringify(records) === JSON.stringify(file.value.records)) continue;
        const afterHash = deletionHash(await replacementContent(root, file, { snapshotRecords: records }));
        const next = `${afterHash}.json`;
        pointers.set(`${file.area}:${path.basename(file.relative)}`, next);
        actions.push({ ...file, snapshotRecords: records, afterHash, destination: path.join("private-evidence", next) });
    }
    const nativePointers = [];
    for (const file of files.filter(file => file.kind === "native-snapshot")) {
        const keep = file.value.records.filter(record => !nativeObservationDeletionAliases(record.nativeObservationKey).some(key => blocked.has(key)));
        if (keep.length === file.value.records.length) continue;
        const nativeObservationKeys = keep.map(record => record.nativeObservationKey);
        const afterHash = deletionHash(await replacementContent(root, file, { nativeObservationKeys }));
        const next = `${afterHash}.json`;
        pointers.set(`${file.area}:${path.basename(file.relative)}`, next);
        if (file.area === "data") nativePointers.push({ before: path.basename(file.relative), after: next });
        actions.push({ ...file, nativeObservationKeys, afterHash, destination: path.join("private-evidence", next) });
    }
    const replacements = new Map();
    for (const file of files.filter(file => file.kind === "native-segment")) {
        if (scope.scope !== "all") throw Object.assign(new BoardError("Segmented activity currently requires an explicit all-activity deletion.", 422),
            { code: "NATIVE_SEGMENTED_RANGE_DELETION_UNAVAILABLE" });
        if (file.value.blockKind === "root") {
            const encoded = encodeNativeSegmentedBlock(nativeSegmentedEnvelope(file.value.account, "root", { tree: null }));
            const next = `${encoded.hash}.json`;
            pointers.set(`${file.area}:${path.basename(file.relative)}`, next);
            if (file.area === "data" && path.basename(file.relative) !== next) nativePointers.push({ before: path.basename(file.relative), after: next });
            const key = `${file.area}:${next}`;
            if (path.basename(file.relative) !== next && !replacements.has(key)) {
                replacements.set(key, true);
                actions.push({ ...file, text: encoded.json, afterHash: encoded.hash, destination: path.join("private-evidence", next) });
            } else if (path.basename(file.relative) !== next) actions.push({ ...file, text: null, destination: file.relative });
        } else actions.push({ ...file, text: null, destination: file.relative });
    }
    const matches = at => {
        if (scope.scope === "all") return true;
        // Record timestamps are validated by the same strict contract as canonical units.
        try { time.instant(at); } catch { return false; }
        return Date.parse(at) >= Date.parse(scope.bounds.from) && Date.parse(at) < Date.parse(scope.bounds.to);
    };
    const linked = linkedEvaluationPlan(files, options.personalEvaluation, remaining, remainingBySnapshot, deletion, scope, options.selectPersonalEvaluationCleanup);
    for (const file of files) {
        let next = file.value;
        if (file.kind === "staging") {
            actions.push({ ...file, text: null, destination: file.relative });
            continue;
        }
        if (file.kind === "state") {
            const retained = retainedBySnapshot.get(`${file.area}:${next.evidenceFile}`) ?? new Set();
            if (next.evidenceFile && pointers.has(`${file.area}:${next.evidenceFile}`) || Object.keys(next.cards ?? {}).some(id => removedScenarios.has(id)) || scope.scope === "all") {
                next = { ...next, evidenceFile: pointers.get(`${file.area}:${next.evidenceFile}`) ?? next.evidenceFile,
                    ...(pointers.has(`${file.area}:${next.evidenceFile}`) ? { evidenceRevision: (next.evidenceRevision ?? next.revision ?? 0) + 1 } : {}),
                    cards: scope.scope === "all" ? {} : Object.fromEntries(Object.entries(next.cards ?? {}).filter(([id]) => !removedScenarios.has(id) || retained.has(id))),
                    deletion: { ...next.deletion, ...deletion, epoch: Math.max(activityDeletionVersion(next), deletion.epoch ?? 0) } };
            }
            if (linked.updates.has(file)) next = { ...next, personalEvaluation: linked.updates.get(file) };
            if (next.nativeRetention) {
                next = { ...next, nativeRetention: { ...next.nativeRetention,
                    ...(scope.scope === "all" && Object.hasOwn(next.nativeRetention, "backfill") ? { backfill: [] } : {}),
                    partitions: next.nativeRetention.partitions.map(item => ({ ...item,
                        file: pointers.get(`${file.area}:${item.file}`) ?? item.file })) } };
            }
        } else if (file.kind === "checkpoint") {
            const keep = [], redact = [], toolRequestIndices = {};
            if (scope.scope !== "all") (next.events ?? []).forEach((event, index) => {
                const retained = filterDeletedEvents([event], file.source, deletion);
                if (retained.length) {
                    keep.push(index);
                    if (retained[0].type === "user.message" && retained[0].data.content === null) redact.push(index);
                    if (Array.isArray(event.data?.wireToolRequestIds)
                        && retained[0].data?.wireToolRequestIds?.length !== event.data.wireToolRequestIds.length) {
                        const allowed = new Set(retained[0].data?.wireToolRequestIds ?? []);
                        toolRequestIndices[index] = event.data.wireToolRequestIds.flatMap((id, position) => allowed.has(id) ? [position] : []);
                    }
                }
            });
            if (keep.length !== next.events.length || redact.length || Object.keys(toolRequestIndices).length) {
                const checkpointEvents = { keep, redact, ...(Object.keys(toolRequestIndices).length ? { toolRequestIndices } : {}) };
                const afterHash = deletionHash(await replacementContent(root, file, { checkpointEvents }, options.validateBackfillCheckpoint));
                actions.push({ ...file, checkpointEvents, afterHash, destination: file.relative });
            }
            continue;
        } else if (file.kind === "http") {
            if (recordUnits(inventoryRecords([file])[0]).some(unit => unit.aliases.some(id => blocked.has(id)))) next = null;
        } else if (file.kind === "attempt" && matches(next.startedAt)) next = null;
        if (!["snapshot", "native-snapshot", "native-segment"].includes(file.kind) && JSON.stringify(next) !== JSON.stringify(file.value)) actions.push({ ...file, text: next === null ? null : JSON.stringify(next), destination: file.relative });
    }
    actions.push(...linked.actions);
    return { deletion, actions: actions.map(({ value, ...action }) => action), personalEvaluation: linked.next, linkedInsights: linked.counts, nativePointers };
}

function authorized(file) {
    return file.relative.startsWith(`private-evidence${path.sep}`) && snapshotName.test(path.basename(file.relative))
        || stateNames.includes(file.relative) || /^\.state-[a-f0-9-]{36}\.tmp$/.test(file.relative)
        || /^http-records[\\/][a-zA-Z0-9-]+\.json$/.test(file.relative)
        || /^collector[\\/][a-f0-9]{64}[\\/][^\\/]+$/.test(file.relative) && checkpointName(file.relative.split(/[\\/]/).at(-1)) !== null
        || /^recorder-attempts[\\/]\d{13}-[a-f0-9-]{36}\.(attempt|result)\.json$/.test(file.relative)
        || /^assessment-evidence[\\/][a-f0-9]{64}\.json$/.test(file.relative)
        || file.asset === true && artifactPath(file.relative)
        || /^deletion-staging[\\/][a-f0-9-]{36}[\\/]\d+\.json$/.test(file.relative);
}

const artifactIdPattern = /^export-[a-f0-9-]{36}$/;
const safeArtifactName = value => typeof value === "string" && /^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/.test(value) && ![".", ".."].includes(value);
function artifactPath(relative, bundleId) {
    const parts = relative.split(/[\\/]/);
    if (parts[0] !== "exports") return false;
    const id = parts[1]?.startsWith(".pending-") ? parts[1].slice(9) : parts[1];
    if (!artifactIdPattern.test(id ?? "") || bundleId && id !== bundleId) return false;
    return parts.length === 3 && safeArtifactName(parts[2]) || parts.length === 4 && parts[2] === "files" && safeArtifactName(parts[3]);
}

async function artifactFileHash(file, missingAllowed = false) {
    let before;
    try { before = await lstat(file); }
    catch (error) { if (missingAllowed && error.code === "ENOENT") return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new BoardError("Saved artifact file ownership is invalid.", 409);
    const hash = createHash("sha256");
    if (before.size) for await (const bytes of createReadStream(file, { end: before.size - 1 })) hash.update(bytes);
    const after = await lstat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new BoardError("A saved artifact changed while reading. Preview again.", 409);
    return hash.digest("hex");
}

export function artifactDeletionState(value, key) {
    if (value && (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.identities) || value.identities.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw new BoardError("Invalid artifact deletion metadata.", 409);
    return { schemaVersion: 1, revision: (value?.revision ?? 0) + 1, identities: [...new Set([...(value?.identities ?? []), ...[key].flat()])] };
}

export async function artifactDeletionPlan(root, state, input, { ignoreStagingOperation } = {}) {
    if (ignoreStagingOperation !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ignoreStagingOperation)) {
        throw new BoardError("Invalid current artifact staging operation.", 422);
    }
    const bulk = Array.isArray(input), descriptors = bulk ? input : [input];
    if (!descriptors.length || new Set(descriptors.map(item => item?.bundleId)).size !== descriptors.length) {
        throw new BoardError("No distinct saved reports are available for deletion.", 422);
    }
    const ids = new Set(), keys = [], indexed = [];
    for (const descriptor of descriptors) {
        if (!descriptor || !artifactIdPattern.test(descriptor.bundleId ?? "") || !["report", "comparison"].includes(descriptor.kind)
            || bulk && descriptor.kind !== "report"
            || !["files", "bundle-root"].includes(descriptor.layout) || !Array.isArray(descriptor.files) || !descriptor.files.length
            || descriptor.files.length > 1000 || descriptor.files.some(file => !safeArtifactName(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256))
            || new Set(descriptor.files.map(file => file.name.toLowerCase())).size !== descriptor.files.length
            || !Array.isArray(descriptor.dependentComparisons) || descriptor.dependentComparisons.some(item => !artifactIdPattern.test(item.bundleId ?? ""))) {
            throw new BoardError("Invalid saved artifact deletion inventory.", 422);
        }
        const matches = state.exports.filter(entry => entry.bundleId === descriptor.bundleId);
        if (matches.length !== 1 || (matches[0].kind ?? "report") !== descriptor.kind) throw new BoardError("Saved artifact identity changed. Preview again.", 409);
        const key = artifactDeletionKey(descriptor.kind, descriptor.bundleId);
        if (state.artifactDeletion?.identities?.includes(key)) throw new BoardError("This saved artifact was already deleted.", 404);
        ids.add(descriptor.bundleId); keys.push(key); indexed.push(matches[0]);
    }
    const marker = artifactDeletionState(state.artifactDeletion, keys);
    const areas = await managedAreas(root), actions = [], assets = [];
    let copies = 0;
    for (const area of areas) {
        const base = areaRoot(root, area);
        for (const descriptor of descriptors) {
            const expected = new Map(descriptor.files.map(file => [file.name, file.sha256]));
            const folder = path.join("exports", descriptor.bundleId, ...(descriptor.layout === "files" ? ["files"] : []));
            const bundleRoot = path.join("exports", descriptor.bundleId);
            for (const relative of [bundleRoot, path.join(bundleRoot, "files"), path.join("exports", `.pending-${descriptor.bundleId}`)]) {
                const discovered = await entries(base, relative);
                const listed = relative === bundleRoot ? discovered.filter(entry => {
                    if (entry.name !== "files") return true;
                    if (!entry.isDirectory()) throw new BoardError("Invalid managed artifact files directory.", 409);
                    return false;
                }) : discovered;
                const primary = area === "data" && relative === folder;
                if (primary && (listed.length !== expected.size || listed.some(entry => !expected.has(entry.name)))) {
                    throw new BoardError("The saved artifact inventory changed. Preview again.", 409);
                }
                if (!listed.length) continue;
                copies++;
                for (const entry of listed) {
                    if (!entry.isFile() || !expected.has(entry.name)) throw new BoardError("Unrecognized file in a managed artifact copy. Nothing deleted.", 409);
                    const file = { area, relative: path.join(relative, entry.name), asset: true, text: null };
                    file.hash = await artifactFileHash(await location(root, file));
                    if (primary && file.hash !== expected.get(entry.name)) throw new BoardError("Saved artifact bytes changed. Preview again.", 409);
                    assets.push(file);
                }
            }
        }
        const states = [...stateNames];
        for (const entry of await readdir(base)) if (/^\.state-[a-f0-9-]{36}\.tmp$/.test(entry)) states.push(entry);
        for (const directory of await entries(base, "deletion-staging")) {
            if (!/^[a-f0-9-]{36}$/.test(directory.name) || !directory.isDirectory()) throw new BoardError("Unrecognized artifact recovery staging area.", 409);
            if (area === "data" && directory.name === ignoreStagingOperation) continue;
            for (const entry of await entries(base, path.join("deletion-staging", directory.name))) {
                if (!/^\d+\.json$/.test(entry.name) || !entry.isFile()) throw new BoardError("Unrecognized artifact recovery staging file.", 409);
                states.push(path.join("deletion-staging", directory.name, entry.name));
            }
        }
        for (const relative of states) {
            if (area === "data" && relative === stateNames[0]) continue;
            const file = { area, relative, kind: "state" };
            const source = await location(root, file);
            let info;
            try { info = await lstat(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
            if (info.size > DELETION_LIMITS.fileBytes) throw new BoardError("A recovery index exceeds the safe deletion limit.", 413);
            const bytes = await readFile(source), value = JSON.parse(bytes);
            if (relative.startsWith(`deletion-staging${path.sep}`) && value.boardId !== BOARD_ID) continue;
            if (value.boardId !== BOARD_ID || !Array.isArray(value.exports)) throw new BoardError("Unrecognized saved-artifact recovery index.", 409);
            const next = { ...value, exports: value.exports.filter(entry => !ids.has(entry.bundleId)),
                artifactDeletion: artifactDeletionState(value.artifactDeletion, keys) };
            actions.push({ ...file, hash: deletionHash(bytes), destination: relative, text: JSON.stringify(next) });
        }
    }
    actions.push(...assets);
    const artifacts = descriptors.map(descriptor => ({ artifactId: descriptor.bundleId, artifactKind: descriptor.kind }));
    const plan = {
        descriptors, indexHash: deletionHash(JSON.stringify(indexed)), artifactDeletion: marker, actions,
        ...(bulk ? { scope: "all-reports", artifacts } : { artifact: artifacts[0] }),
        counts: { managedFiles: assets.length, managedCopies: copies,
            savedDependentComparisons: new Set(descriptors.flatMap(item => item.dependentComparisons.map(source => source.bundleId))).size,
            ...(bulk ? { reports: artifacts.length, savedComparisons: state.exports.filter(entry => entry.kind === "comparison").length } : {}) },
    };
    artifactPlans.set(plan, { root: path.resolve(root), state, ignoreStagingOperation, fingerprint: deletionHash(JSON.stringify(plan)) });
    return plan;
}

export function assertArtifactDeletionPlan(plan, root, state) {
    const held = artifactPlans.get(plan);
    if (!held || held.ignoreStagingOperation !== undefined || held.root !== path.resolve(root)
        || held.state !== state || held.fingerprint !== deletionHash(JSON.stringify(plan))) {
        throw new BoardError("The saved-artifact inventory is not the exact prepared managed plan.", 409);
    }
}

export async function revalidateArtifactDeletionPlan(plan, root, state, operationId) {
    assertArtifactDeletionPlan(plan, root, state);
    const current = await artifactDeletionPlan(root, state,
        plan.scope === "all-reports" ? plan.descriptors : plan.descriptors[0], { ignoreStagingOperation: operationId });
    if (deletionHash(JSON.stringify(current)) !== deletionHash(JSON.stringify(plan))) {
        throw new BoardError("Saved artifact inventory or managed recovery copies changed before publication.", 409);
    }
}

export async function stageDeletion(root, operationId, actions, { validateBackfillCheckpoint } = {}) {
    const journal = [];
    for (const [index, action] of actions.entries()) {
        if (!authorized(action) || action.area === "data" && action.relative === stateNames[0]) throw new BoardError("Deletion cannot target this file.", 409);
        const file = { area: action.area, relative: action.relative, hash: action.hash, ...(action.asset ? { asset: true } : {}),
            ...(action.checkpointIndexHash ? { checkpointIndexHash: action.checkpointIndexHash } : {}) };
        const text = action.snapshotRecords || action.nativeObservationKeys || action.checkpointEvents
            ? await replacementContent(root, action, action, validateBackfillCheckpoint) : action.text;
        if (text !== null) {
            const afterHash = deletionHash(text);
            if (action.afterHash && action.afterHash !== afterHash) throw new BoardError("Deletion replacement changed after preview.", 409);
            const staged = path.join("deletion-staging", operationId, `${index}.json`);
            await mkdir(path.dirname(await safeDeletionFile(root, staged)), { recursive: true });
            await writeExclusive(await safeDeletionFile(root, staged), text);
            Object.assign(file, { staged, afterHash, destination: action.destination });
        }
        journal.push(file);
    }
    return journal;
}

export async function finishDeletionFiles(root, operation) {
    if (operation.nativeArtifactAdmission) validateNativeArtifactDeletionSeal(operation);
    if ((operation.kind === undefined || operation.kind === "activity-deletion") && operation.localIdentityVersion !== LOCAL_DELETION_IDENTITY_VERSION) {
        throw new BoardError("Legacy pending activity deletion needs manual recovery review: its sealed plan predates stable local identities. No further files were deleted. The pending receipt, markers and remaining recovery files are preserved; automatic repair is unavailable.", 409);
    }
    for (const file of operation.cleanup) {
        if (operation.localActivityAdmission || operation.nativeArtifactAdmission) await assertCollectorLockOwned(root);
        if (!authorized(file) || file.area === "data" && file.relative === stateNames[0]) throw new BoardError("Invalid sealed deletion target.", 409);
        if (Object.hasOwn(file, "checkpointIndexHash")) {
            if (!/^collector[\\/][a-f0-9]{64}[\\/][^\\/]+$/.test(file.relative)) throw new BoardError("Pending checkpoint index binding has an invalid target.", 409);
            await assertCheckpointIndex(root, file);
        }
        if (file.asset) {
            const artifacts = operation.scope === "all-reports" ? operation.artifacts : [operation.artifact];
            if (operation.kind !== "artifact-deletion" || !Array.isArray(artifacts) || !artifacts.length
                || artifacts.some(item => !artifactIdPattern.test(item?.artifactId ?? "") || operation.scope === "all-reports" && item.artifactKind !== "report")
                || !artifacts.some(item => artifactPath(file.relative, item.artifactId))) throw new BoardError("Saved-artifact cleanup escaped its sealed object.", 409);
            const target = await location(root, file), hash = await artifactFileHash(target, true);
            if (hash !== null) {
                if (hash !== file.hash) throw new BoardError("Saved artifact changed after confirmation. Cleanup is incomplete.", 409);
                if (file.area !== "data") await chmod(target, 0o600);
                await unlink(await location(root, file));
            }
            continue;
        }
        const target = await location(root, file), bytes = await optional(target);
        if (file.staged) {
            if (!new RegExp(`^deletion-staging[\\\\/]${operation.operationId}[\\\\/]\\d+\\.json$`).test(file.staged)
                || !authorized({ ...file, relative: file.destination })) throw new BoardError("Invalid sealed deletion replacement.", 409);
            const destination = await location(root, { ...file, relative: file.destination });
            const existing = await optional(destination);
            if (!existing || deletionHash(existing) !== file.afterHash) {
                if (!bytes || deletionHash(bytes) !== file.hash) throw new BoardError("Cleanup file changed. The sealed deletion cannot safely continue.", 409);
                const staged = await safeDeletionFile(root, file.staged);
                const content = await readFile(staged);
                if (deletionHash(content) !== file.afterHash) throw new BoardError("Deletion replacement integrity check failed.", 409);
                if (file.area !== "data") await chmod(target, 0o600);
                await rename(staged, destination);
            }
            if (destination === target) continue;
        }
        if (bytes) {
            if (deletionHash(bytes) !== file.hash) throw new BoardError("Cleanup file changed. The sealed deletion cannot safely continue.", 409);
            if (file.area !== "data") await chmod(target, 0o600);
            await unlink(await location(root, file));
        }
    }
    for (const file of operation.cleanup) if (file.staged) {
        if (operation.localActivityAdmission || operation.nativeArtifactAdmission) await assertCollectorLockOwned(root);
        try { await unlink(await safeDeletionFile(root, file.staged)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
