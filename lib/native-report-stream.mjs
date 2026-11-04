import { createHash } from "node:crypto";
import { BoardError } from "./store.mjs";
import { createArrayPrivacyScan, scanTree } from "./privacy.mjs";
import { NATIVE_READ_LIMITS, NATIVE_RETAINED_CONTRACT, nativeConversationIdentity, validateNativeRetainedObservation } from "./native-read-model.mjs";
import { NATIVE_SEGMENTED_LIMITS, NATIVE_SEGMENTED_SOURCES, nativeSourceId, nativeCallKeys } from "./native-segmented-codec.mjs";
import { updateNativeSelectionDigest } from "./native-segmented-read.mjs";
import { nativeRetentionJson, nativeRetentionHash } from "./native-retention-contract.mjs";
import { projectRetainedNativeEntries } from "./retained-population.mjs";
import { assertNativeReportSelection, nativeReportSelectionExpectations } from "./native-report-selection.mjs";

const invalid = (message = "Native report stream is inconsistent or incomplete.", status = 422) => {
    throw new BoardError(`${message} Nothing was prepared.`, status);
};
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
    && keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => nativeRetentionHash(a) === nativeRetentionHash(b);
function freeze(value, seen = new WeakSet()) {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        Object.values(value).forEach(item => freeze(item, seen));
        Object.freeze(value);
    }
    return value;
}
const totalKeys = ["conversations", "variants", "provenanceEntries", "calls", "callMemberships", "entriesDigest"];

export async function readNativePeriodView(services, input, work) {
    if (typeof services.nativeReportViewResolver !== "function" || !services.nativeReportSource
        || !services.nativeReportAdmission || !hash(input.nativeViewId)) invalid("An original Microsoft source view is required.", 503);
    const source = services.nativeReportSource, admission = services.nativeReportAdmission;
    const resolve = services.nativeReportViewResolver({ viewId: input.nativeViewId, nativeIds: [] });
    const refined = input.nativeViewKind === "current", kind = refined ? "periods" : "all";
    const view = await resolve({ kind, revision: input.expectedRevision,
        ...(refined ? { options: input.options, periods: input.periods, datePolicy: "replace-original-dates" } : {}) });
    if (!exact(view, ["kind", "revision", "sourceRevision", "definitions", "frame", ...(refined ? ["membership"] : [])]) || view.kind !== kind
        || view.revision !== input.expectedRevision || !hash(view.sourceRevision)
        || view.frame !== null && (view.frame.source?.sourceRevisionRef !== view.sourceRevision
            || !same(view.frame.source.definitions, view.definitions))) invalid("The original Microsoft period source changed.", 409);
    if (view.frame === null) invalid("The original Microsoft period view has no authoritative source dependency.", 503);
    return source.iterateSelection(view.frame, admission, async (events, assertCurrent, state) => {
        if (state.revision !== input.expectedRevision) invalid("The original period revision changed.", 409);
        const assembled = await assembleNativeReportSelection(events, { selection: view.frame.selection,
            expectations: view.frame.originalViewExpectations, definitions: view.definitions, key: state.pseudonymKey });
        assertCurrent();
        const result = await work({ state, frame: view.frame, projection: { records: assembled.records, source: view.frame.source },
            ...(refined ? { membership: view.membership } : {}) });
        assertCurrent(); return result;
    });
}
function checkTotals(value) {
    if (!exact(value, totalKeys) || totalKeys.slice(0, -1).some(key => !integer(value[key]))
        || !hash(value.entriesDigest) || value.conversations > value.variants
        || value.provenanceEntries < value.variants || value.calls > value.callMemberships) invalid();
}

// Pure bounded assembly, never source authority. The caller must retain its genuine
// producer frame and validate it before publication or commit. Expectations and
// definitions must come from the original accepted view, not this stream's copies.
export async function assembleNativeReportSelection(stream, { selection, expectations, definitions, key, signal } = {}) {
    if (typeof stream?.[Symbol.asyncIterator] !== "function") invalid();
    const iterator = stream[Symbol.asyncIterator]();
    let exhausted = false;
    try {
        if (!iterator || typeof iterator.next !== "function") invalid();
        if (!Array.isArray(expectations) || expectations.length > NATIVE_READ_LIMITS.records
            || expectations.some(item => !item || typeof item.scenarioId !== "string" || !item.scenarioId)) invalid();
        nativeReportSelectionExpectations([], definitions, key);
        scanTree(definitions);
        if (!exact(selection, ["schemaVersion", "kind", "rootHash", "selectionRef", "sources", "expected"])
            || selection.schemaVersion !== 1 || selection.kind !== "native-selected-record-stream"
            || !hash(selection.rootHash) || !hash(selection.selectionRef)
            || !Array.isArray(selection.sources) || !selection.sources.length || selection.sources.length > 2
            || new Set(selection.sources).size !== selection.sources.length
            || selection.sources.some(source => !NATIVE_SEGMENTED_SOURCES.includes(source))) invalid();
        checkTotals(selection.expected);
        if (selection.expected.variants > NATIVE_READ_LIMITS.records) invalid("Native report selection exceeds the supported record limit. Narrow the selection.");
        if (expectations.length !== selection.expected.conversations) invalid("Native selection no longer matches the accepted view.", 409);
        const accepted = structuredClone({ selection, expectations, definitions });
        const selectedIds = new Set(accepted.expectations.map(item => item.scenarioId));
        const conversations = new Set(), ordinals = new Set(), calls = new Set(), entries = [];
        const scan = createArrayPrivacyScan();
        const digest = createHash("sha256").update("wire-native-selected-entries-v2\0");
        let started = false, ended = false, partCount = 0, callMemberships = 0;
        let bytes = Buffer.byteLength(nativeRetentionJson({ contractVersion: NATIVE_RETAINED_CONTRACT, entries: [] }));
        let currentConversation = null, lastOrdinal = -1;
        for (;;) {
            signal?.throwIfAborted();
            const step = await iterator.next();
            signal?.throwIfAborted();
            if (!step || typeof step.done !== "boolean") invalid();
            if (step.done === true) { exhausted = true; break; }
            const event = step.value;
            if (ended || !event || event.schemaVersion !== 1 || event.rootHash !== accepted.selection.rootHash
                || event.selectionRef !== accepted.selection.selectionRef) invalid();
            if (!started) {
                if (!exact(event, ["schemaVersion", "kind", "rootHash", "selectionRef", "expected"])
                    || event.kind !== "selection-start") invalid();
                checkTotals(event.expected);
                if (!same(event.expected, accepted.selection.expected)) invalid();
                started = true;
                continue;
            }
            if (event.kind === "selection-end") {
                if (!exact(event, ["schemaVersion", "kind", "rootHash", "selectionRef", "parts", "observed"])
                    || event.parts !== partCount) invalid();
                checkTotals(event.observed);
                if (!same(event.observed, accepted.selection.expected)
                    || entries.length !== event.observed.variants || conversations.size !== event.observed.conversations
                    || calls.size !== event.observed.calls || callMemberships !== event.observed.callMemberships
                    || digest.digest("hex") !== event.observed.entriesDigest) invalid();
                // Complete provenance totals are the producer's graph-validated seal,
                // not an inferred count of captures or executions from these records.
                ended = true;
                continue;
            }
            if (!exact(event, ["schemaVersion", "kind", "rootHash", "selectionRef", "sourceId", "conversationKey", "partIndex", "entries"])
                || event.kind !== "conversation-part" || event.partIndex !== partCount
                || !accepted.selection.sources.includes(event.sourceId) || !selectedIds.has(event.conversationKey)
                || !Array.isArray(event.entries) || !event.entries.length
                || event.entries.length > NATIVE_SEGMENTED_LIMITS.resultEntries) invalid();
            if (event.conversationKey !== currentConversation) {
                if (conversations.has(event.conversationKey)) invalid();
                conversations.add(event.conversationKey);
                currentConversation = event.conversationKey;
                lastOrdinal = -1;
            }
            let partBytes = Buffer.byteLength(nativeRetentionJson({ ...event, entries: [] }));
            for (const [index, supplied] of event.entries.entries()) {
                if (!exact(supplied, ["inputOrdinal", "record"]) || !integer(supplied.inputOrdinal)
                    || supplied.inputOrdinal <= lastOrdinal || ordinals.has(supplied.inputOrdinal)
                    || entries.length >= accepted.selection.expected.variants) invalid();
                scan.append(supplied);
                const entry = structuredClone(supplied);
                validateNativeRetainedObservation(entry.record);
                if (!entry.record.retention || nativeSourceId(entry.record) !== event.sourceId
                    || nativeConversationIdentity(entry.record.scope) !== event.conversationKey) invalid();
                const size = Buffer.byteLength(nativeRetentionJson(entry));
                partBytes += size + (index ? 1 : 0);
                bytes += size + (entries.length ? 1 : 0);
                if (partBytes > NATIVE_SEGMENTED_LIMITS.bytes || bytes > NATIVE_READ_LIMITS.bytes) {
                    invalid("Native report selection exceeds its supported byte limit. Narrow the selection.");
                }
                updateNativeSelectionDigest(digest, entry);
                for (const call of nativeCallKeys(entry.record)) calls.add(call);
                callMemberships += entry.record.identity.callIds.length;
                if (calls.size > accepted.selection.expected.calls || callMemberships > accepted.selection.expected.callMemberships) invalid();
                ordinals.add(entry.inputOrdinal);
                lastOrdinal = entry.inputOrdinal;
                entries.push(entry);
            }
            partCount++;
        }
        if (!started || !ended) invalid("Native report selection ended without its complete membership proof.", 409);
        signal?.throwIfAborted();
        const sourceScan = scan.finish();
        const projection = projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries });
        assertNativeReportSelection(accepted.expectations, projection.records, accepted.definitions, key);
        signal?.throwIfAborted();
        return freeze({ records: projection.records, sourceScan });
    } finally {
        if (!exhausted && typeof iterator?.return === "function") await iterator.return();
    }
}
