import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { NATIVE_READ_LIMITS, NATIVE_JSON_LIMITS, nativeConversationIdentity } from "./native-read-model.mjs";
import { validateNativeRetainedDocument, nativeRetentionHash, nativeRetainedMergePlan } from "./native-retention-contract.mjs";
import { nativeObservationReference, nativeSegmentedRowKey, nativeCallKey, nativeSourceId,
    NATIVE_SEGMENTED_LIMITS, segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { stageNativeSegmentedTree } from "./native-segmented-stage.mjs";

function checked(assertCurrent, signal) {
    if (signal?.aborted) fail("adoption-cancelled");
    const result = assertCurrent();
    if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        fail("asynchronous-authority-check");
    }
    if (result !== undefined && result !== true) fail("adoption-revoked");
}

// Only the already-bounded legacy document is indexed. No v2 history is assembled here.
export async function* nativeV1SegmentedRows(document, { assertCurrent, signal } = {}) {
    if (typeof assertCurrent !== "function") fail("adoption-binding-required");
    checked(assertCurrent, signal);
    validateNativeRetainedDocument(document);
    yield* indexedRows(document, { assertCurrent, signal }, NATIVE_JSON_LIMITS.nodes);
}

async function* indexedRows(document, { assertCurrent, signal }, indexBound, mapRow) {
    let variants = 0, provenance = 0, memberships = 0;
    for (const observation of document.observations) {
        variants += observation.variants.length;
        for (const variant of observation.variants) {
            provenance += variant.provenance.length;
            memberships += 1 + variant.content.identity.callIds.length;
        }
    }
    if ([variants, provenance, memberships, document.captures.length, document.observations.length]
        .some(count => !Number.isSafeInteger(count) || count > indexBound)) fail("adoption-index-bound");
    const variantRefs = new Uint32Array(variants * 2), provenanceRefs = new Uint32Array(provenance * 2);
    const memberRefs = new Uint32Array(memberships * 2), starts = new Uint32Array(document.observations.length);
    const captureValues = new Map(document.captures.map(item => [item.key, item.value])), witnesses = new Map();
    let ordinal = 0, p = 0, m = 0;
    for (let o = 0; o < document.observations.length; o++) {
        starts[o] = ordinal;
        const observation = document.observations[o];
        for (let v = 0; v < observation.variants.length; v++, ordinal++) {
            const variant = observation.variants[v];
            variantRefs[ordinal * 2] = o; variantRefs[ordinal * 2 + 1] = v;
            for (let index = 0; index < variant.provenance.length; index++, p++) {
                provenanceRefs[p * 2] = ordinal; provenanceRefs[p * 2 + 1] = index;
                const captureKey = variant.provenance[index].captureKey;
                if (!witnesses.has(captureKey)) witnesses.set(captureKey, p);
            }
            for (let unit = 0; unit <= variant.content.identity.callIds.length; unit++, m++) {
                memberRefs[m * 2] = ordinal; memberRefs[m * 2 + 1] = unit;
            }
            if (ordinal % NATIVE_SEGMENTED_LIMITS.segmentEntries === 0) {
                await setImmediate(); checked(assertCurrent, signal);
            }
        }
    }
    function variantAt(index) {
        const observation = document.observations[variantRefs[index * 2]];
        return { observation, variant: observation.variants[variantRefs[index * 2 + 1]],
            observationRef: nativeObservationReference(observation.key) };
    }
    function rawRow(kind, index) {
        if (kind === "capture") {
            const item = document.captures[index];
            if (!witnesses.has(item.key)) fail("capture-unreferenced");
            const witness = row("provenance", witnesses.get(item.key));
            return { kind, captureKey: item.key, capture: item.value, witness: {
                observationRef: witness.observationRef, contentHash: witness.contentHash,
                provenanceHash: nativeRetentionHash(witness.provenance),
            } };
        }
        if (kind === "observation") {
            const item = document.observations[index];
            return { kind, identity: item.key, firstOrdinal: starts[index], lastOrdinal: starts[index] + item.variants.length - 1,
                currentVariant: item.currentVariant };
        }
        if (kind === "provenance") {
            const { variant, observationRef } = variantAt(provenanceRefs[index * 2]);
            return { kind, observationRef, contentHash: variant.hash, provenance: variant.provenance[provenanceRefs[index * 2 + 1]] };
        }
        if (kind === "membership") {
            const inputOrdinal = memberRefs[index * 2], unit = memberRefs[index * 2 + 1];
            const { variant } = variantAt(inputOrdinal), content = variant.content;
            const conversationKey = nativeConversationIdentity(content.scope);
            return { kind, inputOrdinal, sourceId: nativeSourceId(content), conversationKey,
                unitKind: unit === 0 ? "conversation" : "call",
                unitKey: unit === 0 ? conversationKey : nativeCallKey(content.scope, content.identity.callIds[unit - 1]) };
        }
        const { variant, observationRef } = variantAt(index), contentHash = variant.hash;
        if (kind === "variant") return { kind, observationRef, contentHash, content: variant.content,
            seedProvenance: variant.provenance[0], seedCapture: captureValues.get(variant.provenance[0].captureKey) };
        if (kind === "variant-index") return { kind, observationRef, contentHash, inputOrdinal: index };
        if (kind === "record") return { kind, observationRef, contentHash, inputOrdinal: index,
            sourceId: nativeSourceId(variant.content), conversationKey: nativeConversationIdentity(variant.content.scope) };
        fail("row-kind-invalid");
    }
    function row(kind, index) {
        const value = rawRow(kind, index), mapped = mapRow ? mapRow(value) : value;
        if (mapped && typeof mapped.then === "function") {
            Promise.resolve(mapped).catch(() => {});
            fail("row-map-invalid");
        }
        if (!mapped || typeof mapped !== "object" || mapped.kind !== kind) fail("row-map-invalid");
        return mapped;
    }
    const keys = new Map();
    let keyBytes = 0;
    function keyFor(kind, index) {
        const token = `${kind}/${index}`;
        let value = keys.get(token);
        if (value !== undefined) { keys.delete(token); keys.set(token, value); return value; }
        value = nativeSegmentedRowKey(row(kind, index));
        const bytes = Buffer.byteLength(token) + Buffer.byteLength(value);
        while (keyBytes + bytes > NATIVE_SEGMENTED_LIMITS.cacheBytes && keys.size) {
            const first = keys.keys().next().value;
            keyBytes -= Buffer.byteLength(first) + Buffer.byteLength(keys.get(first)); keys.delete(first);
        }
        keys.set(token, value); keyBytes += bytes;
        return value;
    }
    function ordered(kind, count) {
        checked(assertCurrent, signal);
        return Uint32Array.from({ length: count }, (_, index) => index).sort((a, b) => {
            const left = keyFor(kind, a), right = keyFor(kind, b);
            return left < right ? -1 : left > right ? 1 : 0;
        });
    }
    const memberOrder = ordered("membership", memberships);
    const variantOrder = ordered("variant-index", variants);
    async function* emit(kind, order) {
        let emitted = 0;
        for (const index of order) {
            checked(assertCurrent, signal);
            yield row(kind, index);
            if (++emitted % NATIVE_SEGMENTED_LIMITS.segmentEntries === 0) await setImmediate();
        }
    }
    yield* emit("capture", ordered("capture", document.captures.length));
    yield* emit("variant-index", variantOrder);
    yield* emit("membership", memberOrder);
    yield* emit("observation", ordered("observation", document.observations.length));
    yield* emit("provenance", ordered("provenance", provenance));
    if (mapRow) yield* emit("record", ordered("record", variants));
    else {
        for (let index = 0; index < variants; index++) {
            checked(assertCurrent, signal);
            yield row("record", index);
            if (index % NATIVE_SEGMENTED_LIMITS.segmentEntries === 0) await setImmediate();
        }
    }
    let previousUnit = null, emittedUnits = 0;
    for (const index of memberOrder) {
        checked(assertCurrent, signal);
        const member = row("membership", index), { inputOrdinal, ...unit } = member;
        unit.kind = "unit"; unit.witnessOrdinal = inputOrdinal;
        const key = nativeSegmentedRowKey(unit);
        if (key !== previousUnit) { yield unit; previousUnit = key; }
        if (++emittedUnits % NATIVE_SEGMENTED_LIMITS.segmentEntries === 0) await setImmediate();
    }
    yield* emit("variant", variantOrder);
    checked(assertCurrent, signal);
}

export function nativeSegmentedCaptureSource(capture, { assertCurrent, signal } = {}) {
    if (typeof assertCurrent !== "function") fail("adoption-binding-required");
    checked(assertCurrent, signal);
    const plan = nativeRetainedMergePlan(null, capture);
    checked(assertCurrent, signal);
    return Object.freeze({ plan, iterate: mapRow => indexedRows(plan, { assertCurrent, signal }, NATIVE_JSON_LIMITS.nodes, mapRow) });
}

export async function stageNativeV1Segments({ bytes, expectedHash, account, writeBlock, readBlock, assertCurrent, signal } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > NATIVE_READ_LIMITS.bytes
        || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)
        || typeof assertCurrent !== "function") fail("adoption-binding-required");
    checked(assertCurrent, signal);
    const input = Buffer.from(bytes);
    if (createHash("sha256").update(input).digest("hex") !== expectedHash) fail("adoption-integrity");
    let document;
    try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); }
    catch { fail("adoption-json-invalid"); }
    validateNativeRetainedDocument(document);
    if (!account || nativeRetentionHash(document.account) !== nativeRetentionHash(account)) fail("account-mismatch");
    const candidate = await stageNativeSegmentedTree({ account, writeBlock, readBlock, assertCurrent, signal,
        rows: nativeV1SegmentedRows(document, { assertCurrent, signal }) });
    checked(assertCurrent, signal);
    return Object.freeze({ ...candidate, previousHash: expectedHash });
}

// A v1 adoption has at most two bounded inputs: the old v1 document and this capture.
// The merged plan is never a persisted document or a v2 whole-history reader.
export async function stageNativeV1Capture({ previous, capture, writeBlock, readBlock, assertCurrent, signal } = {}) {
    if (typeof assertCurrent !== "function") fail("adoption-binding-required");
    checked(assertCurrent, signal);
    const plan = nativeRetainedMergePlan(previous, capture);
    const candidate = await stageNativeSegmentedTree({ account: plan.account, writeBlock, readBlock, assertCurrent, signal,
        rows: indexedRows(plan, { assertCurrent, signal }, NATIVE_JSON_LIMITS.nodes * 2) });
    checked(assertCurrent, signal);
    return Object.freeze({ candidate, changes: Object.freeze(plan.changes) });
}
