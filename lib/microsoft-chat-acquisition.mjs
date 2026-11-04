import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { createNativeBackfill, attachNativeBackfill, NATIVE_BACKFILL_LIMIT } from "./native-backfill-state.mjs";
import { nativeHistoryActivity, nativeHistoryWindow } from "./microsoft-chat-capture.mjs";
import { nativeHistoryProducer } from "./microsoft-native-bootstrap.mjs";
import { decodeNativeChatObservation, CHAT_SOURCE_PARSER_VERSION } from "./native-chat-source.mjs";
import { retainNativeChatSourceObservations, NATIVE_READ_LIMITS } from "./native-read-model.mjs";
import { UUID } from "./microsoft-session-state.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };

export async function acquireChatClient({ lifecycle, transport, lease, collection, reader, previousBackfill,
    recordFailure, counts, limits = NATIVE_READ_LIMITS, now = Date.now() }) {
    if (!collection.surfaces.includes("chat")) fail("NATIVE_CHAT_CLIENT_SOURCE_SCOPE");
    if (["bytes", "records"].some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0
        || limits[key] > NATIVE_READ_LIMITS[key])) fail("NATIVE_CHAT_CLIENT_LIMITS");
    if (![reader.instanceId, reader.documentId, reader.operationId]
        .every(value => typeof value === "string" && UUID.test(value))) fail("NATIVE_CHAT_CLIENT_ASSOCIATION");
    await lifecycle.assertLease(lease);
    const account = transport.accountFor(lease).account;
    const progress = createNativeBackfill(lease.partition, collection.settings.windowDays, collection.surfaces,
        collection.privacyRevision, previousBackfill, now, previousBackfill?.deletionVersion ?? 0);
    const source = progress.sources.find(row => row.surface === "chat");
    const liveWindow = nativeHistoryWindow({ windowDays: collection.settings.windowDays, now });
    Object.assign(source, { startQualified: false, controlObserved: false, initial: "absent", exhausted: false, chain: null, chainPages: 0 });
    const stop = reason => { if (!source.stops.includes(reason)) source.stops.push(reason); };
    stop("membership-unqualified");
    const result = [], histories = new Set();
    let resultBytes = 2, resultParts = 0, currentHistory = null;
    const read = async (method, args) => {
        await lifecycle.assertLease(lease);
        const value = await reader.read(method, args);
        await lifecycle.assertLease(lease);
        if (!value || value.kind !== "native-client-return" || value.schemaVersion !== 1
            || value.instanceId !== reader.instanceId || value.documentId !== reader.documentId
            || value.operationId !== reader.operationId || value.method !== method
            || JSON.stringify(value.arguments) !== JSON.stringify(args)
            || typeof value.invocationId !== "string" || !UUID.test(value.invocationId)
            || !Number.isFinite(Date.parse(value.observedAt))) fail("NATIVE_CHAT_CLIENT_ASSOCIATION");
        return value;
    };
    const finish = async () => {
        await lifecycle.assertLease(lease);
        await reader.assertCurrent();
        return attachNativeBackfill(result, progress);
    };
    try {
        let cursor;
        for (let page = 0; page < 16; page++) {
            const { value } = await read("listChats", cursor === undefined ? {} : { cursor });
            if (!Array.isArray(value?.chats) || typeof value.syncState !== "string"
                || !(value.pinned === null || Array.isArray(value.pinned))
                || !value.chats.length && !value.pinned?.length || value.complete !== false) fail("NATIVE_CHAT_CLIENT_MEMBERSHIP_INVALID");
            for (const row of [...value.chats, ...(value.pinned ?? [])]) {
                if (typeof row.conversationId !== "string" || !row.conversationId) fail("NATIVE_CHAT_CLIENT_MEMBERSHIP_INVALID");
                histories.add(row.conversationId);
                if (histories.size > NATIVE_BACKFILL_LIMIT) fail("NATIVE_CHAT_CLIENT_HISTORY_LIMIT");
            }
            if (page === 0) source.initial = value.chats.length ? "present" : "empty";
            const pageKey = hash(value);
            if (!source.pages.includes(pageKey)) source.pages.push(pageKey);
            if (source.pages.length > NATIVE_BACKFILL_LIMIT) fail("NATIVE_CHAT_CLIENT_HISTORY_LIMIT");
            source.chain = hash([source.chain, pageKey]); source.chainPages++;
            if (value.syncState === "") break;
            cursor = value.syncState;
            if (page === 15) stop("page-budget");
        }
        const ordered = [...histories].sort((a, b) => hash(a).localeCompare(hash(b)));
        const after = source.chatCursor?.referenceAfter, split = after ? ordered.findIndex(id => hash(id) > after) : 0;
        const rotated = split > 0 ? [...ordered.slice(split), ...ordered.slice(0, split)] : ordered;
        if (rotated.length > 8) stop("history-budget");
        for (const id of rotated.slice(0, 8)) {
            const key = hash(["chat", id]);
            currentHistory = source.histories.find(row => row.key === key) ?? null;
            if (!currentHistory && source.histories.length >= NATIVE_BACKFILL_LIMIT) { stop("membership-budget"); break; }
            const response = await read("readConversation", { conversationId: id });
            const body = response.value, conversation = body?.conversation;
            if (conversation?.conversationId !== id || !Array.isArray(conversation.messages) || !conversation.messages.length
                || !["not-returned", "unqualified"].includes(body.connectedContext)) {
                fail("NATIVE_CHAT_CLIENT_CONVERSATION_UNQUALIFIED");
            }
            const bodyDigest = hash(body);
            let latest = null;
            const checkpoint = () => {
                if (latest !== null) {
                    if (!currentHistory) {
                        currentHistory = { key, activity: latest, handledActivity: null, handledThrough: null, state: "pending" };
                        source.histories.push(currentHistory);
                    }
                    currentHistory.activity = Math.max(currentHistory.activity, latest);
                    currentHistory.state = "pending";
                    currentHistory.handledActivity = null;
                    currentHistory.handledThrough = null;
                }
                source.chatCursor = { referenceAfter: hash(id) };
            };
            for (let index = 0; index < conversation.messages.length; index++) {
                const record = conversation.messages[index];
                let activity = nativeHistoryActivity(record, "chat", progress.window, nativeHistoryProducer.chatTimeUnit);
                if (activity.state === "outside") activity = nativeHistoryActivity(record, "chat", liveWindow, nativeHistoryProducer.chatTimeUnit);
                if (activity.state !== "in-window") {
                    if (counts) counts[activity.state === "outside" ? "outside" : "unqualified"]++;
                    if (activity.state !== "outside") fail("NATIVE_NO_QUALIFIED_WINDOW_ACTIVITY");
                    continue;
                }
                latest = Math.max(latest ?? 0, Date.parse(activity.value));
                const pointer = `/conversation/messages/${index}`, sourceDocument = response.invocationId;
                const observations = retainNativeChatSourceObservations(decodeNativeChatObservation({
                    scope: { harness: "microsoft-365-copilot", surface: "chat", account, conversationId: id },
                    capture: { captureId: sourceDocument, capturedAt: response.observedAt, generation: lease.generation,
                        parserVersion: CHAT_SOURCE_PARSER_VERSION, sourceSchema: "chat-native-client-return-v1",
                        operation: "history-read", origin: reader.origin, bodyDigest },
                    ordering: { pageOrdinal: 0, recordOrdinal: index, completeness: "response-only" },
                    source: { sourceDocument, pointer, responsePointer: "/conversation" },
                    ...(Object.hasOwn(conversation, "requestId") ? { responseRequestId: conversation.requestId } : {}), record,
                }));
                for (const observation of observations) {
                    observation.record.createdAt = activity.value;
                    observation.qualifiedFields.messageCreatedAt = { availability: "recorded", scope: "message", value: activity.value };
                    observation.evidenceReferences.messageCreatedAt = { sourceDocument, pointer: pointer + "/createdAt",
                        nativeEventId: observation.record.messageId };
                    observation.coverage.push(
                        { kind: "native-client-invocation", subject: response.instanceId,
                            meaning: "Projected return of the current native conversation server function, not an original UI/HTTP capture. Detail tails and complete account membership remain unqualified." },
                        { kind: "native-client-document", subject: response.documentId, meaning: "Current local owned document, not a server request ID." },
                        { kind: "native-client-operation", subject: response.operationId, meaning: "Registered collection operation and committed-source comparison." });
                    if (body.connectedContext === "unqualified") observation.coverage.push({
                        kind: "native-connected-context", subject: "unqualified",
                        meaning: "The native return also contained connected-conversation context. Its relationship/identity is not qualified by this primary-conversation reader and its content was not admitted.",
                    });
                }
                const addedBytes = Buffer.byteLength(JSON.stringify(observations)) + 1;
                const addedParts = observations.reduce((sum, row) => sum + (row.qualifiedFields.message ? 1 : 0) + (row.messageParts?.length ?? 0), 0);
                if (result.length + observations.length > limits.records || resultParts + addedParts > limits.records
                    || resultBytes + addedBytes > limits.bytes) {
                    stop(resultBytes + addedBytes > limits.bytes ? "byte-budget" : "record-budget");
                    checkpoint();
                    return await finish();
                }
                result.push(...observations); resultBytes += addedBytes; resultParts += addedParts;
                if (counts) counts.eligible += observations.length;
                if (index % 16 === 0) { await setImmediate(); await lifecycle.assertLease(lease); }
            }
            checkpoint();
            currentHistory = null;
        }
        return await finish();
    } catch (error) {
        if (currentHistory) currentHistory.state = "unreadable";
        stop("unreadable-history");
        await recordFailure?.(error, attachNativeBackfill([], progress));
        throw error;
    }
}
