import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { createNativeBackfill, attachNativeBackfill, NATIVE_BACKFILL_LIMIT } from "./native-backfill-state.mjs";
import { nativeHistoryActivity, nativeHistoryWindow } from "./microsoft-chat-capture.mjs";
import { adaptCoworkSourceRecordsWithResultFacts, COWORK_MATCHED_RESULT_ADAPTER_VERSION } from "./cowork-source-adapter.mjs";
import { NATIVE_READ_LIMITS } from "./native-read-model.mjs";
import { UUID } from "./microsoft-session-state.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Called with a genuine current collection lease and the owned browser bridge.
// The existing runtime owns begin/commit/compare; this function owns no writer.
export async function acquireCoworkClient({ lifecycle, transport, lease, collection, reader,
    previousBackfill, recordFailure, counts, limits = NATIVE_READ_LIMITS, now = Date.now() }) {
    if (!collection.surfaces.includes("cowork")) {
        fail("NATIVE_COWORK_CLIENT_SOURCE_SCOPE");
    }
    if (["bytes", "records"].some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0
        || limits[key] > NATIVE_READ_LIMITS[key])) fail("NATIVE_COWORK_CLIENT_LIMITS");
    if (![reader.instanceId, reader.documentId, reader.operationId]
        .every(value => typeof value === "string" && UUID.test(value))) fail("NATIVE_COWORK_CLIENT_ASSOCIATION");
    await lifecycle.assertLease(lease);
    const account = transport.accountFor(lease).account;
    const progress = createNativeBackfill(lease.partition, collection.settings.windowDays, collection.surfaces,
        collection.privacyRevision, previousBackfill, now, previousBackfill?.deletionVersion ?? 0);
    const source = progress.sources.find(row => row.surface === "cowork"), liveWindow = nativeHistoryWindow({ windowDays: collection.settings.windowDays, now });
    source.startQualified = false;
    source.controlObserved = false;
    source.initial = "absent";
    source.exhausted = false;
    source.chain = null;
    source.chainPages = 0;
    if (!source.stops.includes("membership-unqualified")) source.stops.push("membership-unqualified");
    const stop = name => { if (!source.stops.includes(name)) source.stops.push(name); };
    const result = [], tasks = new Map();
    let currentHistory = null, resultBytes = 2, resultParts = 0;
    const read = async (method, args) => {
        await lifecycle.assertLease(lease);
        const value = await reader.read(method, args);
        await lifecycle.assertLease(lease);
        if (!value || value.kind !== "native-client-return" || value.schemaVersion !== 1
            || value.instanceId !== reader.instanceId || value.method !== method
            || value.documentId !== reader.documentId || value.operationId !== reader.operationId
            || JSON.stringify(value.arguments) !== JSON.stringify(args)
            || typeof value.invocationId !== "string" || !UUID.test(value.invocationId)
            || !Number.isFinite(Date.parse(value.observedAt))) fail("NATIVE_COWORK_CLIENT_ASSOCIATION");
        return value;
    };
    try {
        let cursor;
        for (let page = 0; page < 16; page++) {
            const response = await read("listTasks", { pageSize: 200, ...(cursor ? { cursor } : {}) });
            const value = response.value;
            if (!Array.isArray(value?.tasks) || !value.tasks.length
                || !(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0)) {
                fail("NATIVE_COWORK_CLIENT_NORMALIZED_EMPTY");
            }
            for (const row of value.tasks) {
                if (typeof row.sessionId !== "string" || !row.sessionId || typeof row.ic3ThreadId !== "string" || !row.ic3ThreadId) {
                    fail("NATIVE_COWORK_CLIENT_RESPONSE_INVALID");
                }
                const activity = Number.isSafeInteger(row.lastActivity) && row.lastActivity > 0 ? row.lastActivity : null;
                tasks.set(row.sessionId, { id: row.sessionId, activity });
                if (tasks.size > NATIVE_BACKFILL_LIMIT) fail("NATIVE_COWORK_CLIENT_HISTORY_LIMIT");
            }
            const pageKey = hash([value.tasks.map(row => [row.sessionId, row.ic3ThreadId, row.lastActivity]), value.nextCursor]);
            if (!source.pages.includes(pageKey)) source.pages.push(pageKey);
            if (source.pages.length > NATIVE_BACKFILL_LIMIT) fail("NATIVE_COWORK_CLIENT_HISTORY_LIMIT");
            source.chain = hash([source.chain, pageKey]);
            source.chainPages++;
            if (value.nextCursor === null) break;
            cursor = value.nextCursor;
            if (page === 15) stop("page-budget");
        }
        const ordered = [...tasks.values()].sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
        const after = source.coworkCursor?.referenceAfter;
        const split = after ? ordered.findIndex(row => hash(row.id) > after) : 0;
        const rotated = split > 0 ? [...ordered.slice(split), ...ordered.slice(0, split)] : ordered;
        const selected = rotated.slice(0, 8);
        if (rotated.length > selected.length) stop("history-budget");
        for (const task of selected) {
            const key = hash(["cowork", task.id]);
            currentHistory = source.histories.find(row => row.key === key) ?? null;
            if (!currentHistory && source.histories.length === NATIVE_BACKFILL_LIMIT) {
                stop("membership-budget");
                break;
            }
            let cursor, latestActivity = null;
            const checkpointHistory = () => {
                if (latestActivity !== null) {
                    const activity = Math.max(task.activity ?? 0, latestActivity, currentHistory?.activity ?? 0);
                    if (!currentHistory) {
                        currentHistory = { key, activity, handledActivity: null, handledThrough: null, state: "pending" };
                        source.histories.push(currentHistory);
                    }
                    currentHistory.activity = activity;
                }
                if (currentHistory) {
                    // Native listMessages normalizes a missing cursor to null.
                    // Ending its chain cannot attest to a fully handled history.
                    currentHistory.handledActivity = null;
                    currentHistory.handledThrough = null;
                    currentHistory.state = "pending";
                }
                source.coworkCursor = { parentAfter: source.coworkCursor?.parentAfter ?? null, referenceAfter: hash(task.id) };
            };
            for (let page = 0; page < 16; page++) {
                const response = await read("listMessages", { sessionId: task.id, pageSize: 200, ...(cursor ? { cursor } : {}) });
                const value = response.value;
                if (!Array.isArray(value?.events) || value.events.length === 0
                    || !(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0)) {
                    fail("NATIVE_COWORK_CLIENT_NORMALIZED_EMPTY");
                }
                const bodyDigest = hash(value);
                for (let index = 0; index < value.events.length; index++) {
                    const record = value.events[index];
                    if (typeof record.id !== "string" || !record.id || typeof record.event !== "string" || !record.event) {
                        fail("NATIVE_COWORK_CLIENT_RESPONSE_INVALID");
                    }
                    let activity = nativeHistoryActivity(record, "cowork", progress.window, "epoch-ms");
                    if (activity.state === "outside") activity = nativeHistoryActivity(record, "cowork", liveWindow, "epoch-ms");
                    if (activity.state === "unqualified") {
                        if (counts) counts.unqualified++;
                        fail("NATIVE_NO_QUALIFIED_WINDOW_ACTIVITY");
                    }
                    if (activity.state !== "in-window") {
                        if (counts) counts.outside++;
                        continue;
                    }
                    latestActivity = Math.max(latestActivity ?? 0, Date.parse(activity.calendarInstant));
                    const location = { sourceDocument: response.invocationId, pointer: `/events/${index}` };
                    const observations = adaptCoworkSourceRecordsWithResultFacts([{
                        record, source: location, ordering: { pageOrdinal: page, recordOrdinal: index, completeness: "response-only" },
                    }], {
                        scope: { harness: "microsoft-365-copilot", surface: "cowork", account, conversationId: task.id },
                        capture: { captureId: response.invocationId, capturedAt: response.observedAt, generation: lease.generation,
                            parserVersion: COWORK_MATCHED_RESULT_ADAPTER_VERSION, sourceSchema: "cowork-native-client-return-v1",
                            operation: "history-read", origin: reader.origin, bodyDigest },
                    });
                    for (const observation of observations) {
                        observation.record.data.ts = record.data.ts;
                        observation.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
                            unit: "epoch-ms", basis: "cowork.data.ts", value: record.data.ts };
                        observation.evidenceReferences.observationTime = { ...location, pointer: location.pointer + "/data/ts",
                            nativeEventId: record.id };
                        observation.coverage.push({ kind: "native-client-invocation", subject: response.instanceId,
                            meaning: "Returned by the current account-bound native listMessages call, not an observed HTTP/UI response. Native normalization, complete history and terminal cursor semantics remain unqualified." });
                        observation.coverage.push({ kind: "native-client-document", subject: response.documentId,
                            meaning: "Local owned-document identity checked before and after native invocation; not a server request identifier." });
                        observation.coverage.push({ kind: "native-client-operation", subject: response.operationId,
                            meaning: "Registered local collection operation owning this invocation and its committed-source comparison." });
                    }
                    const addedBytes = Buffer.byteLength(JSON.stringify(observations), "utf8") + 1;
                    const addedParts = observations.reduce((count, row) =>
                        count + (row.qualifiedFields.message ? 1 : 0) + (row.messageParts?.length ?? 0), 0);
                    if (result.length + observations.length > limits.records
                        || resultParts + addedParts > limits.records
                        || resultBytes + addedBytes > limits.bytes) {
                        stop(resultBytes + addedBytes > limits.bytes ? "byte-budget" : "record-budget");
                        checkpointHistory();
                        await lifecycle.assertLease(lease);
                        await reader.assertCurrent();
                        return attachNativeBackfill(result, progress);
                    }
                    resultBytes += addedBytes;
                    resultParts += addedParts;
                    if (counts) counts.eligible += observations.length;
                    result.push(...observations);
                    if (index % 16 === 0) { await setImmediate(); await lifecycle.assertLease(lease); }
                }
                if (value.nextCursor === null) break;
                cursor = value.nextCursor;
                if (page === 15) stop("page-budget");
            }
            // Rotation acknowledges bounded work, not complete source history.
            checkpointHistory();
            currentHistory = null;
        }
        await lifecycle.assertLease(lease);
        await reader.assertCurrent();
        return attachNativeBackfill(result, progress);
    } catch (error) {
        if (currentHistory) currentHistory.state = "unreadable";
        stop("unreadable-history");
        await recordFailure?.(error, attachNativeBackfill([], progress));
        throw error;
    }
}
