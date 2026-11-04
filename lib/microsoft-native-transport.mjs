import { createHash } from "node:crypto";
import { MicrosoftSessionError } from "./microsoft-session-state.mjs";

const transports = new WeakSet();
const identifier = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const unavailable = () => { throw new MicrosoftSessionError("account-metadata-unavailable"); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fresh = value => typeof value === "string" && Number.isFinite(Date.parse(value))
    && Math.abs(Date.now() - Date.parse(value)) <= 300000;
function canonicalOrigin(value) {
    let url;
    try { url = new URL(value); } catch { unavailable(); }
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) unavailable();
    return url;
}
const gateway = value => /^[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(canonicalOrigin(value).hostname);
const accountPartition = (issuer, proof) => createHash("sha256").update(JSON.stringify([
    ...(proof.evidence.namespace !== undefined || proof.evidence.realm !== undefined
        ? ["microsoft-native-account-v2", issuer, proof.evidence.namespace, proof.evidence.realm]
        : ["microsoft-native-account-v1", issuer]), proof.tenantId, proof.subjectId,
])).digest("hex");

// This witness comes only from verifyAccount's accepted original requests, not
// a stored descriptor. Its source contract binds accountInfo to both native identity headers.
function mappedNativeAccount(proof, ownerId, generation) {
    const mapping = proof.evidence.nativeRouting;
    if (mapping === undefined) return null;
    if (!exact(mapping, ["schemaVersion", "sourceContract", "ownerId", "generation", "observedAt", "issuer",
        "tenantId", "subjectId", "namespace", "realm", "current", "routing", "routed"])
        || mapping.schemaVersion !== 1 || mapping.sourceContract !== "m365-accountInfo-cowork-headers-v1"
        || !Number.isSafeInteger(generation) || generation < 0 || mapping.generation !== generation
        || mapping.ownerId !== ownerId || !fresh(mapping.observedAt)
        || mapping.tenantId !== proof.tenantId || mapping.subjectId !== proof.subjectId
        || mapping.namespace !== "m365.accountInfo.objectId" || mapping.namespace !== proof.evidence.namespace
        || mapping.realm !== "prod" || mapping.realm !== proof.evidence.realm) unavailable();
    const common = ["captureId", "requestId", "networkId", "frameId", "requestOrigin", "method", "responseStatus", "observedAt"];
    if (!exact(mapping.current, [...common, "requestPath"])
        || !exact(mapping.routing, [...common, "responseOrigin", "endpointOrigin"])
        || !exact(mapping.routed, [...common, "responseOrigin", "requestPath"])) unavailable();
    const { current, routing, routed } = mapping;
    for (const observation of [current, routing, routed]) {
        if (!["captureId", "requestId", "networkId", "frameId"].every(key => identifier(observation[key]))
            || observation.responseStatus !== 200 || !fresh(observation.observedAt)) unavailable();
        canonicalOrigin(observation.requestOrigin);
    }
    const principalRequest = ["GET", "POST"].includes(current.method) && /^(?:\/hwav2)?\/_serverFn\/[a-f0-9]{64}$/.test(current.requestPath)
        || current.method === "GET" && ["/chat", "/hwav2/chat", "/", "/home", "/landingv2"].includes(current.requestPath)
        || current.method === "POST" && current.requestPath === "/landingv2";
    if (!["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(current.requestOrigin)
        || current.requestOrigin !== proof.evidence.issuer || current.observedAt !== proof.evidence.observedAt
        || !principalRequest
        || routing.method !== "GET" || routed.method !== "GET" || routed.requestPath !== "/v1/tasks/live"
        || routing.requestOrigin !== routing.responseOrigin || !gateway(routing.requestOrigin)
        || !gateway(mapping.issuer) || mapping.issuer !== routing.endpointOrigin
        || mapping.issuer !== routed.requestOrigin || mapping.issuer !== routed.responseOrigin
        || Date.parse(mapping.observedAt) < Math.max(...[current, routing, routed].map(item => Date.parse(item.observedAt)))
        || new Set([current, routing, routed].map(item => item.requestId)).size !== 3
        || new Set([current, routing, routed].map(item => item.networkId)).size !== 3) unavailable();
    return { issuer: mapping.issuer, tenantId: mapping.tenantId, subjectId: mapping.subjectId };
}

// The native owner supplies supported account metadata, never credentials or
// a caller-chosen partition. Nothing here resolves identity from a deep link.
export function createMicrosoftNativeReadTransport({ open, verifyAccount, stop, background } = {}) {
    if (![open, verifyAccount, stop].every(value => typeof value === "function")) unavailable();
    if (background !== undefined && typeof background !== "function") unavailable();
    let identity = null, ownerId = null, epoch = 0, verifiedGeneration = null;
    const transport = Object.freeze({
        open(operation) {
            if (!identifier(operation?.ownerId) || operation.signal?.aborted) {
                throw new MicrosoftSessionError("cancelled");
            }
            epoch++;
            ownerId = operation.ownerId;
            return open(operation);
        },
        async verify(operation) {
            const verificationEpoch = epoch, verificationOwner = ownerId;
            const verificationGeneration = operation?.generation;
            const assertCurrent = () => {
                if (operation?.signal?.aborted || !verificationOwner || operation?.ownerId !== verificationOwner
                    || operation?.generation !== verificationGeneration
                    || verificationEpoch !== epoch || verificationOwner !== ownerId) {
                    throw new MicrosoftSessionError("cancelled");
                }
            };
            assertCurrent();
            const { expectedPartition, ...sourceOperation } = operation;
            let proofPending = true, proof;
            try {
                proof = await verifyAccount(Object.hasOwn(operation, "expectedPartition") ? {
                    ...sourceOperation,
                    needsNativeRouting(candidate) {
                        assertCurrent();
                        if (!proofPending) throw new MicrosoftSessionError("cancelled");
                        if (expectedPartition === undefined) return false;
                        const issuer = canonicalOrigin(candidate?.evidence?.issuer);
                        return accountPartition(issuer.origin, candidate) !== expectedPartition;
                    },
                } : operation);
            } finally { proofPending = false; }
            assertCurrent();
            if (!proof || proof.knownAccountMatched !== true
                || !identifier(proof.tenantId) || !identifier(proof.subjectId)
                || proof.evidence?.kind !== "native-account-metadata"
                || !Number.isFinite(Date.parse(proof.evidence.observedAt))
                || Math.abs(Date.now() - Date.parse(proof.evidence.observedAt)) > 300000) unavailable();
            let issuer;
            try { issuer = new URL(proof.evidence.issuer); } catch { unavailable(); }
            if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash
                || !["", "/"].includes(issuer.pathname)) unavailable();
            const namespaced = proof.evidence.namespace !== undefined || proof.evidence.realm !== undefined;
            if (namespaced && (!identifier(proof.evidence.namespace) || !identifier(proof.evidence.realm)
                || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(proof.evidence.namespace)
                || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(proof.evidence.realm))) unavailable();
            const account = Object.freeze({ tenantId: proof.tenantId, subjectId: proof.subjectId, verification: "verified" });
            let presentation;
            if (proof.presentation !== undefined) {
                const value = proof.presentation;
                if (!value || Object.keys(value).length !== 2 || !Object.hasOwn(value, "source") || !Object.hasOwn(value, "email")
                    || value.source !== "microsoft-native-principal"
                    || !Number.isSafeInteger(verificationGeneration) || verificationGeneration < 0
                    || typeof value.email !== "string" || value.email.length > 160
                    || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(value.email)
                    || proof.evidence.namespace !== "m365.accountInfo.objectId" || proof.evidence.realm !== "prod") unavailable();
                presentation = Object.freeze({ source: value.source, email: value.email,
                    observedAt: proof.evidence.observedAt, generation: verificationGeneration });
            }
            let partition = accountPartition(issuer.origin, proof);
            let accountIssuer = issuer.origin;
            const mapped = mappedNativeAccount(proof, verificationOwner, verificationGeneration);
            if (mapped && expectedPartition !== undefined && expectedPartition !== partition) {
                const legacyPartition = createHash("sha256").update(JSON.stringify([
                    "microsoft-native-account-v1", mapped.issuer, mapped.tenantId, mapped.subjectId,
                ])).digest("hex");
                if (legacyPartition === expectedPartition) {
                    partition = legacyPartition;
                    accountIssuer = mapped.issuer;
                }
            }
            assertCurrent();
            if (identity && identity.partition !== partition) throw new MicrosoftSessionError("wrong-account");
            identity = Object.freeze({ partition, account, issuer: accountIssuer,
                ...(namespaced ? { namespace: proof.evidence.namespace, realm: proof.evidence.realm } : {}),
                ...(presentation ? { presentation } : {}),
                observedAt: proof.evidence.observedAt });
            verifiedGeneration = verificationGeneration;
            return { partition, accountVerified: true };
        },
        ...(background ? { async background(operation) {
            const currentEpoch = epoch, currentIdentity = identity;
            const assertCurrent = () => {
                operation.assertCurrent();
                if (!currentIdentity || identity !== currentIdentity || currentEpoch !== epoch
                    || operation.signal?.aborted || operation.ownerId !== ownerId
                    || operation.generation !== verifiedGeneration || operation.partition !== identity.partition) {
                    throw new MicrosoftSessionError("cancelled");
                }
            };
            assertCurrent();
            await background({ ...operation, assertCurrent });
            assertCurrent();
        } } : {}),
        accountFor(lease) {
            if (!identity || lease?.partition !== identity.partition
                || !["microsoft-read", "microsoft-retained"].includes(lease.kind)) {
                throw new MicrosoftSessionError("lease-invalid");
            }
            return identity;
        },
        async stop(operation) {
            epoch++;
            ownerId = null;
            identity = null;
            verifiedGeneration = null;
            return stop(operation);
        },
    });
    transports.add(transport);
    return transport;
}

export const isMicrosoftNativeReadTransport = value => transports.has(value);
