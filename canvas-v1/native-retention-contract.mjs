import { createHash } from "node:crypto";
import { NATIVE_RETAINED_CONTRACT, NativeReadModelError, nativeValueHasCredentials,
    normalizeNativeSourceObservations, validateNativeRetainedObservation, nativeConversationIdentity } from "./native-read-model.mjs";
import { NATIVE_RETENTION_POLICY_ID } from "./native-retention-state.mjs";
import { nativeObservationDeletionAliases } from "./deletion-identities.mjs";

export const NATIVE_RETENTION_POLICY = NATIVE_RETENTION_POLICY_ID;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const encoded = value => JSON.stringify(stable(value));
export const nativeRetentionJson = encoded;
export const nativeRetentionHash = value => createHash("sha256").update(encoded(value)).digest("hex");
const fail = code => { throw new NativeReadModelError(code, "$retained"); };
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => encoded(a) === encoded(b);
const safeKeys = path => Array.isArray(path) && path.length > 0 && path.length <= 64
    && path.every(key => typeof key === "string" && !["__proto__", "constructor", "prototype", "value"].includes(key));
const validatedDocuments = new WeakMap();
const validatedRecords = new WeakSet();
export const isValidatedNativeRetainedRecord = record => validatedRecords.has(record);
function freeze(value, seen = new WeakSet()) {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        Object.values(value).forEach(item => freeze(item, seen));
        Object.freeze(value);
    }
    return value;
}

export function validateNativeRetainedAccount(account) {
    if (!exact(account, ["partition", "issuer", "tenantId", "subjectId"]) || !hash(account.partition)
        || ["tenantId", "subjectId"].some(name => typeof account[name] !== "string" || !account[name].trim() || account[name].length > 1024)) {
        fail("native-retained-account-invalid");
    }
    let issuer;
    try { issuer = new URL(account.issuer); } catch { fail("native-retained-account-invalid"); }
    if (issuer.protocol !== "https:" || issuer.origin !== account.issuer || issuer.username || issuer.password
        || nativeValueHasCredentials(account)) fail("native-retained-account-invalid");
    return account;
}

function intrinsicIdentity(record, account) {
    return JSON.stringify(["native-source-observation-v1", account.issuer, account.tenantId, account.subjectId,
        record.scope.harness, record.scope.surface, record.scope.conversationId,
        record.identity.namespace, record.identity.id, record.fields.message?.value?.representation ?? null]);
}
function orderingMeaning(ordering) {
    return Object.fromEntries(Object.entries(ordering).filter(([name]) => !["pageOrdinal", "frameOrdinal", "recordOrdinal"].includes(name)));
}
function splitObservation(record) {
    const references = [], sourceDocuments = new Set();
    function collect(value) {
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (!object(value)) return;
        if (typeof value.sourceDocument === "string" && typeof value.pointer === "string") sourceDocuments.add(value.sourceDocument);
        for (const [name, child] of Object.entries(value)) if (name !== "value") collect(child);
    }
    collect(record);
    function strip(value, path = []) {
        if (Array.isArray(value)) return value.map((child, index) => strip(child, [...path, String(index)]));
        if (!object(value)) return value;
        const result = {};
        for (const [name, child] of Object.entries(value)) {
            const reference = name === "evidence" || name === "source" && object(child)
                && typeof child.sourceDocument === "string" && typeof child.pointer === "string"
                || path[0] === "coverage" && (name === "path" || name === "subject" && sourceDocuments.has(child));
            if (reference) references.push({ path: [...path, name], value: child });
            else result[name] = name === "value" ? structuredClone(child) : strip(child, [...path, name]);
        }
        return result;
    }
    const { capture, ordering, ...facts } = record;
    return {
        content: { ...strip(facts), interpretation: { parserVersion: capture.parserVersion, sourceSchema: capture.sourceSchema },
            sourceOrdering: orderingMeaning(ordering) },
        capture,
        provenance: { ordering, references },
    };
}
function restoreObservation(content, provenance, capture) {
    if (!object(content) || !exact(content.interpretation, ["parserVersion", "sourceSchema"])
        || !object(content.sourceOrdering) || !exact(provenance, ["captureKey", "ordering", "references"])
        || !Array.isArray(provenance.references) || provenance.references.length > 10000
        || !same(content.interpretation, { parserVersion: capture.parserVersion, sourceSchema: capture.sourceSchema })
        || !same(content.sourceOrdering, orderingMeaning(provenance.ordering))) fail("native-retained-provenance-invalid");
    const record = structuredClone(content);
    delete record.interpretation; delete record.sourceOrdering;
    const paths = new Set();
    for (const reference of provenance.references) {
        if (!exact(reference, ["path", "value"]) || !safeKeys(reference.path)
            || !["source", "evidence", "path", "subject"].includes(reference.path.at(-1))) fail("native-retained-reference-invalid");
        const id = JSON.stringify(reference.path);
        if (paths.has(id)) fail("native-retained-reference-invalid");
        paths.add(id);
        let target = record;
        for (const key of reference.path.slice(0, -1)) {
            if (!target || !Object.hasOwn(target, key) || !object(target[key]) && !Array.isArray(target[key])) {
                fail("native-retained-reference-invalid");
            }
            target = target[key];
        }
        const name = reference.path.at(-1);
        if (Object.hasOwn(target, name)) fail("native-retained-reference-invalid");
        Object.defineProperty(target, name, { value: structuredClone(reference.value), enumerable: true, writable: true, configurable: true });
    }
    return { ...record, capture: structuredClone(capture), ordering: structuredClone(provenance.ordering) };
}

export { intrinsicIdentity as nativeRetainedObservationIdentity,
    splitObservation as nativeRetainedObservationParts,
    restoreObservation as restoreNativeRetainedObservation };

export function encodeNativeRetainedCapture(account, envelopes) {
    validateNativeRetainedAccount(account);
    const source = normalizeNativeSourceObservations(envelopes);
    const captures = new Map(), observations = [];
    for (const record of source.records) {
        if (record.scope.account.tenantId !== account.tenantId || record.scope.account.subjectId !== account.subjectId) {
            fail("native-retained-account-conflict");
        }
        const { content, capture, provenance } = splitObservation(record);
        const captureKey = JSON.stringify([record.scope.harness, record.scope.surface, capture.captureId]);
        if (captures.has(captureKey) && !same(captures.get(captureKey), capture)) fail("native-capture-provenance-conflict");
        captures.set(captureKey, capture);
        observations.push({
            key: intrinsicIdentity(record, account), contentHash: nativeRetentionHash(content), content,
            provenance: { captureKey, ...provenance },
        });
    }
    const result = { schemaVersion: 1, contractVersion: NATIVE_RETAINED_CONTRACT, account: structuredClone(account),
        captures: [...captures].map(([key, value]) => ({ key, value })), observations };
    if (nativeValueHasCredentials(result)) fail("credential-bearing-retained-capture");
    return result;
}

export function nativeRetainedMergePlan(previous, capture) {
    if (!exact(capture, ["schemaVersion", "contractVersion", "account", "captures", "observations"])
        || capture.schemaVersion !== 1 || capture.contractVersion !== NATIVE_RETAINED_CONTRACT
        || !Array.isArray(capture.captures) || !Array.isArray(capture.observations)) fail("native-retained-capture-invalid");
    validateNativeRetainedAccount(capture.account);
    if (nativeValueHasCredentials(capture)) fail("credential-bearing-retained-capture");
    if (previous) validateNativeRetainedDocument(previous);
    if (previous && !same(previous.account, capture.account)) fail("native-retained-account-conflict");
    const document = previous ? structuredClone(previous) : {
        schemaVersion: 1, contractVersion: NATIVE_RETAINED_CONTRACT, policy: NATIVE_RETENTION_POLICY,
        account: structuredClone(capture.account), captures: [], observations: [],
    };
    const captures = new Map(document.captures.map(item => [item.key, item.value]));
    let addedCaptures = 0, addedObservations = 0, addedVariants = 0, addedProvenance = 0, reusedObservations = 0;
    for (const item of capture.captures) {
        if (!exact(item, ["key", "value"]) || typeof item.key !== "string") fail("native-retained-capture-invalid");
        if (captures.has(item.key)) {
            if (!same(captures.get(item.key), item.value)) fail("native-capture-provenance-conflict");
        } else {
            captures.set(item.key, structuredClone(item.value));
            document.captures.push(structuredClone(item)); addedCaptures++;
        }
    }
    const observations = new Map(document.observations.map(item => [item.key, item]));
    for (const item of capture.observations) {
        if (!exact(item, ["key", "contentHash", "content", "provenance"]) || !hash(item.contentHash)
            || item.contentHash !== nativeRetentionHash(item.content)) fail("native-retained-content-invalid");
        const sourceCapture = captures.get(item.provenance.captureKey);
        if (!sourceCapture) fail("native-retained-capture-missing");
        const restored = restoreObservation(item.content, item.provenance, sourceCapture);
        if (item.key !== intrinsicIdentity(restored, document.account)) fail("native-retained-identity-conflict");
        if (restored.scope.account.tenantId !== document.account.tenantId
            || restored.scope.account.subjectId !== document.account.subjectId
            || item.provenance.captureKey !== JSON.stringify([restored.scope.harness, restored.scope.surface, sourceCapture.captureId])) {
            fail("native-retained-account-conflict");
        }
        validateNativeRetainedObservation(restored);
        let observation = observations.get(item.key);
        if (!observation) {
            observation = { key: item.key, currentVariant: item.contentHash, variants: [] };
            document.observations.push(observation); observations.set(item.key, observation); addedObservations++;
        }
        let variant = observation.variants.find(value => value.hash === item.contentHash);
        if (variant) {
            if (!same(variant.content, item.content)) fail("native-retained-content-conflict");
            reusedObservations++;
        } else {
            variant = { hash: item.contentHash, content: structuredClone(item.content), provenance: [] };
            observation.variants.push(variant); addedVariants++;
        }
        if (!variant.provenance.some(value => same(value, item.provenance))) {
            variant.provenance.push(structuredClone(item.provenance)); addedProvenance++;
        }
        observation.currentVariant = item.contentHash;
    }
    return { account: document.account, captures: document.captures, observations: document.observations,
        changes: { addedCaptures, addedObservations, addedVariants, addedProvenance, reusedObservations } };
}

export function mergeNativeRetainedCapture(previous, capture) {
    const { changes, ...plan } = nativeRetainedMergePlan(previous, capture);
    const document = { schemaVersion: 1, contractVersion: NATIVE_RETAINED_CONTRACT, policy: NATIVE_RETENTION_POLICY, ...plan };
    validateNativeRetainedDocument(document);
    return { document, changes };
}

export function validateNativeRetainedDocument(document) {
    if (validatedDocuments.has(document)) return validatedDocuments.get(document);
    if (!exact(document, ["schemaVersion", "contractVersion", "policy", "account", "captures", "observations"])
        || document.schemaVersion !== 1 || document.contractVersion !== NATIVE_RETAINED_CONTRACT
        || document.policy !== NATIVE_RETENTION_POLICY || !Array.isArray(document.captures)
        || !Array.isArray(document.observations)) fail("native-retained-document-invalid");
    validateNativeRetainedAccount(document.account);
    if (nativeValueHasCredentials(document)) fail("credential-bearing-retained-document");
    const captures = new Map();
    for (const item of document.captures) {
        if (!exact(item, ["key", "value"]) || typeof item.key !== "string" || captures.has(item.key)) fail("native-retained-capture-invalid");
        captures.set(item.key, item.value);
    }
    const seen = new Set(), usedCaptures = new Set(), records = [];
    for (const observation of document.observations) {
        if (!exact(observation, ["key", "currentVariant", "variants"]) || typeof observation.key !== "string" || seen.has(observation.key)
            || !Array.isArray(observation.variants) || !observation.variants.length
            || !observation.variants.some(variant => variant.hash === observation.currentVariant)) fail("native-retained-observation-invalid");
        seen.add(observation.key);
        const variants = new Set();
        for (const variant of observation.variants) {
            if (!exact(variant, ["hash", "content", "provenance"]) || !hash(variant.hash)
                || variants.has(variant.hash) || variant.hash !== nativeRetentionHash(variant.content)
                || !Array.isArray(variant.provenance) || !variant.provenance.length) fail("native-retained-content-invalid");
            variants.add(variant.hash);
            const provenanceKeys = new Set();
            let record;
            for (const provenance of variant.provenance) {
                const capture = captures.get(provenance.captureKey);
                if (!capture) fail("native-retained-capture-missing");
                usedCaptures.add(provenance.captureKey);
                const key = nativeRetentionHash(provenance);
                if (provenanceKeys.has(key)) fail("native-retained-provenance-invalid");
                provenanceKeys.add(key);
                const restored = restoreObservation(variant.content, provenance, capture);
                if (observation.key !== intrinsicIdentity(restored, document.account)
                    || restored.scope.account.tenantId !== document.account.tenantId
                    || restored.scope.account.subjectId !== document.account.subjectId) fail("native-retained-account-conflict");
                if (provenance.captureKey !== JSON.stringify([restored.scope.harness, restored.scope.surface, capture.captureId])) {
                    fail("native-retained-capture-invalid");
                }
                validateNativeRetainedObservation(restored);
                record ??= restored;
            }
            record.retention = { variant: variant.hash, current: variant.hash === observation.currentVariant,
                captureCount: new Set(variant.provenance.map(value => value.captureKey)).size };
            records.push(record);
        }
    }
    if (usedCaptures.size !== captures.size) fail("native-retained-capture-unreferenced");
    const result = freeze({ contractVersion: NATIVE_RETAINED_CONTRACT, records });
    freeze(document);
    for (const record of records) validatedRecords.add(record);
    validatedDocuments.set(document, result);
    return result;
}

export function nativeRetainedInventory(document) {
    validateNativeRetainedDocument(document);
    return document.observations.map(observation => {
        const scope = observation.variants[0].content.scope;
        const scenarioId = nativeConversationIdentity(scope);
        return { recordKind: "native-retained-observation", nativeObservationKey: observation.key,
            scenarioId, sourceSessionId: scenarioId, capturedAt: null };
    });
}

export function filterNativeRetainedDocument(document, deletion) {
    validateNativeRetainedDocument(document);
    const blocked = new Set(deletion?.identities ?? []);
    const observations = document.observations.filter(item => !nativeObservationDeletionAliases(item.key).some(key => blocked.has(key)));
    if (observations.length === document.observations.length) return document;
    const captures = new Set(observations.flatMap(item => item.variants.flatMap(variant => variant.provenance.map(value => value.captureKey))));
    return { ...document, observations, captures: document.captures.filter(item => captures.has(item.key)) };
}

export function filterNativeRetainedCapture(capture, deletion) {
    const blocked = new Set(deletion?.identities ?? []);
    const retained = capture.observations.filter(item => !nativeObservationDeletionAliases(item.key).some(key => blocked.has(key)));
    const supportedHistories = new Set(retained.filter(item => item.content.identity.nativeType !== "task-snapshot"
        && item.content.fields.observationTime?.availability === "recorded"
        && item.content.coverage.some(row => row.kind === "native-history-window"))
        .map(item => nativeConversationIdentity(item.content.scope)));
    const observations = retained.filter(item => item.content.identity.nativeType !== "task-snapshot"
        || !item.content.coverage.some(row => row.kind === "native-history-snapshot")
        || supportedHistories.has(nativeConversationIdentity(item.content.scope)));
    const retainedKeys = new Set(observations.map(item => item.key));
    const captures = new Set(observations.map(item => item.provenance.captureKey));
    return { capture: { ...capture, observations, captures: capture.captures.filter(item => captures.has(item.key)) },
        suppressedObservations: new Set(capture.observations.filter(item => !retainedKeys.has(item.key))
            .map(item => item.key)).size };
}
