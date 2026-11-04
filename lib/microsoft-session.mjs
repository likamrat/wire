import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isMicrosoftNativeReadTransport } from "./microsoft-native-transport.mjs";
import { validateNativeHistoryObservations } from "./native-backfill-state.mjs";
import { copilotStoreRefusal } from "./release-policy.mjs";
import {
    MicrosoftSessionError, SESSION_ACTIONS, UUID, PARTITION, exact,
    sessionStorage, initialSessionState, validNativeFailure, nativeFailureDetails,
} from "./microsoft-session-state.mjs";

export { MicrosoftSessionError } from "./microsoft-session-state.mjs";
const nativeSessions = new WeakMap();
const copilotSessions = new WeakMap();
export const isCopilotSession = (session, context) => copilotSessions.has(session) && copilotSessions.get(session) === context;
export const isNativeMicrosoftSession = (session, context) => nativeSessions.has(session) && nativeSessions.get(session) === context;
export const microsoftConnectionStatus = value => Object.freeze({
    state: value.microsoft.state,
    reason: value.microsoft.reason,
    actions: Object.freeze(value.actions.filter(action => action.startsWith("microsoft-"))),
});

function collectionSettings(value) {
    if (!exact(value, ["paused", "windowDays"]) || typeof value.paused !== "boolean"
        || !Number.isInteger(value.windowDays) || value.windowDays < 1 || value.windowDays > 90) {
        throw new MicrosoftSessionError("invalid-request");
    }
    return { paused: value.paused, windowDays: value.windowDays };
}

function globalCollectionGate(value) {
    if (value === null) return null;
    if (!exact(value, ["revision", "paused"]) || !Number.isSafeInteger(value.revision) || value.revision < 1
        || typeof value.paused !== "boolean") throw new MicrosoftSessionError("invalid-request");
    return Object.freeze({ revision: value.revision, paused: value.paused });
}

function request(value, nativeRead = false) {
    if (!exact(value, ["action", "operationId", "generation", "expectedPartition", "replace"])
        || !SESSION_ACTIONS.includes(value.action) || !UUID.test(value.operationId)
        || !Number.isSafeInteger(value.generation) || value.generation < 0
        || (value.action === "microsoft-connect"
            ? (!(nativeRead && value.expectedPartition === undefined) && !PARTITION.test(value.expectedPartition)) || typeof value.replace !== "boolean"
            : value.expectedPartition !== undefined || value.replace !== undefined)) {
        throw new MicrosoftSessionError("invalid-request");
    }
    return { action: value.action, operationId: value.operationId, generation: value.generation,
        ...(value.action === "microsoft-connect" ? { expectedPartition: value.expectedPartition, replace: value.replace } : {}) };
}

const safeError = error => new MicrosoftSessionError(error instanceof MicrosoftSessionError ? error.code : "transport-failed");
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicReceipt = ({ fingerprint: ignored, ownerHash: privateOwner, nativeEvidence: privateEvidence, ...receipt }) => structuredClone(receipt);
const nativeClock = { set: (work, ms) => setTimeout(work, ms), clear: id => clearTimeout(id) };

function ownerHash(owner) {
    if (typeof owner !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(owner)) {
        throw new MicrosoftSessionError("invalid-request");
    }
    return fingerprint(owner);
}

function assertReceiptOwner(receipt, owner) {
    if (receipt.ownerHash !== owner) throw new MicrosoftSessionError("operation-owner");
}

/**
 * Shared lifecycle. Native read-only transports must carry the in-process
 * constructor brand and supply fresh supported account metadata.
 */
export async function createMicrosoftSession(context, {
    transport, collection, timeoutMs = 120000, cleanupMs = 10000,
    clock = nativeClock, storage = sessionStorage(context), persistCollectionSettings,
    sourceAware = false, globalCollection, nativeSignInMode = "headless", initialWire = "signed-out", copilotOnly = false,
} = {}) {
    let settings = collectionSettings(collection);
    if (![timeoutMs, cleanupMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 300000)) {
        throw new MicrosoftSessionError("invalid-request");
    }
    const nativeRead = isMicrosoftNativeReadTransport(transport);
    if (typeof copilotOnly !== "boolean" || copilotOnly && (transport !== undefined || !sourceAware
        || persistCollectionSettings !== undefined)) throw new MicrosoftSessionError("invalid-request");
    if (!["headless", "visible"].includes(nativeSignInMode) || !nativeRead && nativeSignInMode !== "headless") {
        throw new MicrosoftSessionError("invalid-request");
    }
    if (typeof sourceAware !== "boolean" || sourceAware && !nativeRead && !copilotOnly || !sourceAware && globalCollection !== undefined) {
        throw new MicrosoftSessionError("invalid-request");
    }
    if (!["signed-in", "signed-out"].includes(initialWire) || initialWire === "signed-in" && (!sourceAware || !nativeRead && !copilotOnly)) {
        throw new MicrosoftSessionError("invalid-request");
    }
    let globalGate = sourceAware ? globalCollectionGate(globalCollection) : null;
    if (persistCollectionSettings !== undefined && (!nativeRead || typeof persistCollectionSettings !== "function")) {
        throw new MicrosoftSessionError("invalid-request");
    }
    const qualified = (nativeRead || transport?.qualification === "synthetic-only-v1")
        && ["open", "verify", "stop"].every(key => typeof transport[key] === "function");
    const release = await storage.lock();
    let state;
    try {
        state = await storage.read();
        // An older Microsoft owner/partition cannot be adopted or cleared by the release.
        if (copilotOnly && state && (state.owner || state.partition || state.partitions.length
            || state.receipts.some(receipt => receipt.action.startsWith("microsoft-") && ["pending", "ambiguous"].includes(receipt.outcome)))) {
            throw copilotStoreRefusal();
        }
        if (!state) { state = { ...initialSessionState(), wire: initialWire }; await storage.write(state); }
        else {
            state.generation++;
            for (const receipt of state.receipts) if (receipt.outcome === "pending") {
                receipt.outcome = "ambiguous";
                receipt.reason = "restart-required";
            }
            state.connection = state.owner ? "recovery-required" : state.partition ? "reconnect-required" : "disconnected";
            state.reason = state.owner ? "restart-required" : state.receipts.length >= 1024 ? "receipt-limit" : null;
            await storage.write(state);
        }
    } catch (error) {
        try { await release(); }
        catch { throw new MicrosoftSessionError("storage-failed"); }
        throw error instanceof MicrosoftSessionError || error.code === "WIRE_COPILOT_STORE_INCOMPATIBLE"
            ? error : new MicrosoftSessionError("storage-failed");
    }

    let queue = Promise.resolve(), active = null, closing = false, closed = false, poisoned = false, closeTask = null;
    let acquisitionRevision = 0, authorizationRevision = 0, poisonReason = "storage-failed";
    const leases = new WeakSet(), launches = new Set();
    const collectionSettingsAdmissions = new WeakMap();
    const nativeConfigurationAdmissions = new WeakMap();
    const globalCollectionAdmissions = new WeakMap();
    const subscribers = new Set(), callbackContext = new AsyncLocalStorage();
    function assertNoReentry() {
        if (callbackContext.getStore()) throw new MicrosoftSessionError("reentrant-call");
    }
    const serial = work => {
        assertNoReentry();
        const result = queue.then(work, work);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    function authorizationEvent() {
        const value = snapshot();
        const { authorizationRevision: revision, generation, wire, collection, authorization } = value;
        const { retained, githubAcquisition, microsoftAcquisition } = authorization;
        return Object.freeze({ revision, generation, wire, collection,
            retained, githubAcquisition, microsoftAcquisition,
            ...(sourceAware ? { githubManualAcquisition: authorization.githubManualAcquisition } : {}),
            ...(nativeRead ? { microsoft: microsoftConnectionStatus(value) } : {}) });
    }
    function dispatchAuthorizationChange(listeners, event) {
        let failed = false;
        for (const listener of listeners) {
            try {
                const result = callbackContext.run("authorization-listener", () => listener(event));
                if (result && typeof result.then === "function") {
                    // Report the contract violation now; drain its promise without leaking raw errors.
                    Promise.resolve(result).catch(() => undefined);
                    throw new MicrosoftSessionError("authorization-listener-failed");
                }
            } catch {
                failed = true;
            }
        }
        return failed;
    }
    function listenerFailure() {
        poisoned = true;
        poisonReason = "authorization-listener-failed";
        active?.controller.abort();
        authorizationRevision++;
        dispatchAuthorizationChange([...subscribers], authorizationEvent());
        throw new MicrosoftSessionError(poisonReason);
    }
    function notifyAuthorizationChange() {
        authorizationRevision++;
        if (dispatchAuthorizationChange([...subscribers], authorizationEvent())) listenerFailure();
    }
    function poison(reason) {
        poisoned = true;
        poisonReason = reason;
        active?.controller.abort();
        notifyAuthorizationChange();
    }
    function available() {
        if (closed || closing) throw new MicrosoftSessionError("session-closed");
        if (poisoned) throw new MicrosoftSessionError(poisonReason);
    }
    async function save(next, { authorizationChanged = true } = {}) {
        try { await storage.write(next); }
        catch {
            poison("storage-failed");
            throw new MicrosoftSessionError(poisonReason);
        }
        state = next;
        if (authorizationChanged) notifyAuthorizationChange();
    }
    function snapshot() {
        const blocked = poisoned || closed || closing;
        const connection = poisoned ? "recovery-required"
            : !qualified && !state.owner ? "unavailable" : state.connection;
        const wireReadable = !blocked && state.wire === "signed-in";
        const globalAllows = !sourceAware || globalGate === null || !globalGate.paused;
        return {
            stage: nativeRead ? "native-read-only" : "synthetic-only", authorizationRevision, generation: state.generation, wire: state.wire,
            collection: settings.paused ? "paused" : "enabled",
            microsoft: { state: connection, reason: poisoned ? poisonReason
                : !qualified && !state.owner ? "hooks-unqualified" : state.reason,
                partition: wireReadable ? state.partition : null,
                surfaces: Object.fromEntries(["chat", "cowork"].map(surface => [surface, {
                    access: !blocked && connection === "connected" && !nativeRead ? "verified-synthetic" : "not-verified",
                    qualification: "production-unqualified",
                }])) },
            authorization: { retained: wireReadable,
                githubAcquisition: wireReadable && (sourceAware ? globalAllows : !settings.paused && !nativeRead),
                ...(sourceAware ? { githubManualAcquisition: wireReadable } : {}),
                microsoftAcquisition: wireReadable && qualified && !settings.paused && globalAllows && connection === "connected",
                microsoftPartition: wireReadable ? state.partition : null },
            actions: blocked ? [] : state.receipts.length >= 1024
                ? state.wire === "signed-in" ? ["wire-sign-out"] : [] : [
                state.wire === "signed-out" ? "wire-sign-in" : "wire-sign-out",
                ...(qualified && state.owner && connection === "recovery-required" ? ["microsoft-recover"] : []),
                ...(active && !active.controller.signal.aborted ? ["microsoft-cancel"]
                    : qualified && wireReadable && (!state.owner || connection === "connected") && !active ? ["microsoft-connect"] : []),
            ],
        };
    }
    function current(generation) {
        return !closed && !closing && !poisoned && state.generation === generation && state.wire === "signed-in";
    }
    async function bounded(work, signal, milliseconds, launch = false) {
        if (signal?.aborted) throw new MicrosoftSessionError("cancelled");
        let timer, abort;
        const task = Promise.resolve().then(work);
        if (launch) {
            launches.add(task);
            task.then(() => launches.delete(task), () => launches.delete(task));
        }
        const interrupt = new Promise((resolve, reject) => {
            timer = clock.set(() => reject(new MicrosoftSessionError("timed-out")), milliseconds);
            abort = () => reject(new MicrosoftSessionError("cancelled"));
            signal?.addEventListener("abort", abort, { once: true });
        });
        try { return await Promise.race([task, interrupt]); }
        catch (error) { throw safeError(error); }
        finally { clock.clear(timer); signal?.removeEventListener("abort", abort); }
    }
    let stopping = null;
    function recordCleanup(next, owner, disposition) {
        if (!nativeRead || !owner.operationId) return;
        const receipt = next.receipts.find(row => row.operationId === owner.operationId && row.action === "microsoft-connect");
        if (!receipt) throw new MicrosoftSessionError("state-invalid");
        receipt.nativeEvidence ??= {};
        receipt.nativeEvidence.cleanup = { state: disposition, recordedAt: new Date().toISOString() };
    }
    async function stopOwner() {
        if (stopping) return stopping;
        stopping = (async () => {
            const owner = await serial(async () => {
                if (!state.owner) return null;
                const next = structuredClone(state);
                next.owner.phase = "closing";
                recordCleanup(next, next.owner, "pending");
                if (next.connection === "connected") next.connection = "reconnect-required";
                if (!poisoned) {
                    try { await save(next); }
                    catch (error) {
                        // The durable owner already exists; still attempt its stop after disk failure.
                        if (!poisoned) throw error;
                    }
                }
                return { ...next.owner };
            });
            if (!owner) return true;
            let proof;
            try {
                if (!qualified) throw new MicrosoftSessionError("hooks-unqualified");
                proof = await bounded(() => transport.stop({ ownerId: owner.id }), null, cleanupMs);
                if (!exact(proof, ["processExited", "profileReleased"])
                    || proof.processExited !== true || proof.profileReleased !== true || launches.size) {
                    throw new MicrosoftSessionError("cleanup-failed");
                }
            } catch {
                await serial(async () => {
                    const next = structuredClone(state);
                    next.connection = "recovery-required";
                    next.reason = "cleanup-failed";
                    recordCleanup(next, owner, "failed");
                    if (!poisoned) await save(next);
                });
                return false;
            }
            return serial(async () => {
                if (poisoned) return false;
                if (state.owner?.id !== owner.id) throw new MicrosoftSessionError("cleanup-failed");
                const next = structuredClone(state);
                recordCleanup(next, owner, "completed");
                next.owner = null;
                next.connection = next.partition ? "reconnect-required" : "disconnected";
                await save(next);
                return true;
            });
        })();
        try { return await stopping; }
        finally { stopping = null; }
    }
    async function transition(generation, update) {
        return serial(async () => {
            if (!current(generation)) throw new MicrosoftSessionError("cancelled");
            const next = structuredClone(state);
            update(next);
            await save(next);
        });
    }
    async function mutate(work) {
        try { return await serial(work); }
        catch (error) {
            if (poisoned) await stopOwner();
            throw error;
        }
    }
    function verifyProof(proof, expectedPartition) {
        if (!exact(proof, nativeRead ? ["partition", "accountVerified"] : ["partition", "chat", "cowork"]) || !PARTITION.test(proof.partition)) {
            throw new MicrosoftSessionError("access-refused");
        }
        if (expectedPartition !== undefined && proof.partition !== expectedPartition) throw new MicrosoftSessionError("wrong-account");
        if (nativeRead ? proof.accountVerified !== true : proof.chat !== true || proof.cowork !== true) {
            throw new MicrosoftSessionError("access-refused");
        }
    }
    async function connect(operation, generation, controller, displayMode) {
        const signal = controller.signal;
        try {
            if (state.owner) {
                if (!await stopOwner()) throw new MicrosoftSessionError("cleanup-failed");
            }
            const ownerId = randomUUID();
            await transition(generation, next => {
                next.owner = { id: ownerId, phase: displayMode, ...(nativeRead ? { operationId: operation.operationId } : {}) };
                next.connection = "signing-in";
            });
            const recordFailure = failure => {
                if (!exact(failure, ["code", "faviconFailure", "applicationComparison", "predicate", "admission", "protocolStop", "publicCoworkScript"])) {
                    throw new MicrosoftSessionError("invalid-request");
                }
                const evidence = { predicate: { schemaVersion: 1, stage: "connect", name: "unobserved" },
                    ...structuredClone(failure), recordedAt: new Date().toISOString() };
                if (!validNativeFailure(evidence)) throw new MicrosoftSessionError("invalid-request");
                return serial(async () => {
                    const receipt = state.receipts.find(row => row.operationId === operation.operationId);
                    if (!current(generation) || state.owner?.id !== ownerId || receipt?.outcome !== "pending"
                        || receipt.nativeEvidence?.firstFailure) return false;
                    const next = structuredClone(state), original = next.receipts.find(row => row.operationId === operation.operationId);
                    original.nativeEvidence ??= {};
                    original.nativeEvidence.firstFailure = evidence;
                    await save(next, { authorizationChanged: false });
                    return true;
                });
            };
            const recordHistory = observations => {
                const history = structuredClone(validateNativeHistoryObservations(observations));
                return serial(async () => {
                    const receipt = state.receipts.find(row => row.operationId === operation.operationId);
                    if (!current(generation) || state.owner?.id !== ownerId || receipt?.outcome !== "pending") return false;
                    if (JSON.stringify(receipt.nativeEvidence?.history) === JSON.stringify(history)) return false;
                    const next = structuredClone(state), original = next.receipts.find(row => row.operationId === operation.operationId);
                    original.nativeEvidence ??= {};
                    original.nativeEvidence.history = history;
                    await save(next, { authorizationChanged: false });
                    return true;
                });
            };
            await bounded(() => transport.open({ ownerId, mode: displayMode, signal }), signal, timeoutMs, true);
            const expectedPartition = operation.expectedPartition ?? (nativeRead && !operation.replace ? state.partition ?? undefined : undefined);
            const visible = await bounded(() => transport.verify({ ownerId,
                expectedPartition: nativeRead ? !operation.replace ? state.partition ?? undefined : undefined : expectedPartition,
                ...(nativeRead ? { generation, recordFailure, recordHistory } : {}), signal }), signal, timeoutMs);
            verifyProof(visible, expectedPartition);
            let hidden = visible;
            if (!nativeRead) {
                await transition(generation, next => { next.connection = "handoff"; });
                if (!await stopOwner()) throw new MicrosoftSessionError("cleanup-failed");
                const hiddenOwnerId = randomUUID();
                await transition(generation, next => {
                    next.owner = { id: hiddenOwnerId, phase: "headless" };
                    next.connection = "handoff";
                });
                await bounded(() => transport.open({ ownerId: hiddenOwnerId, mode: "headless", signal }), signal, timeoutMs, true);
                hidden = await bounded(() => transport.verify({ ownerId: hiddenOwnerId, expectedPartition: operation.expectedPartition, signal }), signal, timeoutMs);
                verifyProof(hidden, operation.expectedPartition);
            }
            await serial(async () => {
                if (!current(generation)) throw new MicrosoftSessionError("cancelled");
                let next = structuredClone(state);
                const previousPartition = next.partition;
                next.partition = hidden.partition;
                if (!next.partitions.includes(hidden.partition)) next.partitions.push(hidden.partition);
                next.connection = "connected";
                next.reason = null;
                const receipt = next.receipts.find(row => row.operationId === operation.operationId);
                if (previousPartition && previousPartition !== hidden.partition) {
                    // Revoke leases issued while the old partition was still visible during sign-in.
                    next.generation++;
                    receipt.generation = next.generation;
                    receipt.revocation = { scope: "microsoft-account", partition: previousPartition };
                }
                if (nativeRead && displayMode === "visible" && typeof transport.background === "function") {
                    await save(next, { authorizationChanged: false });
                    const connectedGeneration = next.generation;
                    let backgroundCurrent = true;
                    const assertCurrent = () => {
                        if (!backgroundCurrent || !current(connectedGeneration) || signal.aborted || state.owner?.id !== ownerId
                            || state.connection !== "connected" || state.partition !== hidden.partition) {
                            throw new MicrosoftSessionError("cancelled");
                        }
                    };
                    assertCurrent();
                    try {
                        await bounded(() => callbackContext.run("native-background", () => transport.background({
                            ownerId, generation, partition: hidden.partition, signal, assertCurrent,
                        })), signal, Math.min(1000, timeoutMs));
                        assertCurrent();
                    } catch (error) {
                        backgroundCurrent = false;
                        if (!poisoned) {
                            const failed = structuredClone(state);
                            const original = failed.receipts.find(row => row.operationId === operation.operationId);
                            original.nativeEvidence ??= {};
                            original.nativeEvidence.firstFailure ??= {
                                ...nativeFailureDetails(error, "connect"), recordedAt: new Date().toISOString(),
                            };
                            await save(failed, { authorizationChanged: false });
                        }
                        throw error;
                    } finally { backgroundCurrent = false; }
                    next = structuredClone(state);
                }
                next.receipts.find(row => row.operationId === operation.operationId).outcome = "completed";
                await save(next);
            });
        } catch (error) {
            const reason = safeError(error).code;
            controller.abort();
            try {
                await serial(async () => {
                    if (poisoned) return;
                    const next = structuredClone(state);
                    if (next.generation === generation) next.generation++;
                    const receipt = next.receipts.find(row => row.operationId === operation.operationId);
                    if (nativeRead) {
                        receipt.nativeEvidence ??= {};
                        receipt.nativeEvidence.firstFailure ??= {
                            ...nativeFailureDetails(error, "connect"), recordedAt: new Date().toISOString(),
                        };
                    }
                    if (receipt.outcome === "pending") {
                        receipt.outcome = ["cancelled", "window-closed"].includes(reason) ? "cancelled" : "failed";
                        receipt.reason = reason;
                    }
                    next.connection = next.owner ? "recovery-required" : next.partition ? "reconnect-required" : "disconnected";
                    next.reason = reason;
                    await save(next);
                });
            } finally {
                if (poisoned || reason !== "cleanup-failed") await stopOwner();
            }
        } finally {
            await serial(() => {
                if (active?.operationId === operation.operationId) {
                    active = null;
                    if (nativeRead) notifyAuthorizationChange();
                }
            });
        }
        return serial(() => {
            if (poisoned) throw new MicrosoftSessionError(poisonReason);
            return publicReceipt(state.receipts.find(row => row.operationId === operation.operationId));
        });
    }

    function authorizeCommand(authorize) {
        try {
            if (typeof authorize !== "function") throw new MicrosoftSessionError("command-unauthorized");
            const allowed = callbackContext.run("command-admission", authorize);
            if (allowed && typeof allowed.then === "function") Promise.resolve(allowed).catch(() => undefined);
            if (allowed !== true) throw new MicrosoftSessionError("command-unauthorized");
        } catch {
            throw new MicrosoftSessionError("command-unauthorized");
        }
    }
    async function command(owner, input, authorize) {
        const ownedBy = ownerHash(owner);
        const operation = request(input, nativeRead);
        if (copilotOnly && operation.action.startsWith("microsoft-")) throw new MicrosoftSessionError("hooks-unqualified");
        const plan = await mutate(async () => {
            available();
            authorizeCommand(authorize);
            const digest = fingerprint({ ownerHash: ownedBy, ...operation });
            const prior = state.receipts.find(row => row.operationId === operation.operationId);
            if (prior) {
                assertReceiptOwner(prior, ownedBy);
                if (prior.fingerprint !== digest) throw new MicrosoftSessionError("operation-conflict");
                return { receipt: publicReceipt(prior) };
            }
            if (operation.generation !== state.generation) throw new MicrosoftSessionError("stale-generation");
            if (state.receipts.length >= 1024) {
                const next = structuredClone(state);
                next.generation++;
                next.wire = "signed-out";
                next.connection = next.owner ? "recovery-required" : next.partition ? "reconnect-required" : "disconnected";
                next.reason = "receipt-limit";
                await save(next);
                active?.controller.abort();
                return { limit: true, wait: active?.done };
            }
            if (operation.action === "microsoft-connect") {
                if (state.wire !== "signed-in") throw new MicrosoftSessionError("signed-out");
                if (!qualified) throw new MicrosoftSessionError("hooks-unqualified");
                if (active || state.owner && state.connection !== "connected") throw new MicrosoftSessionError("busy");
                if (state.partition && operation.expectedPartition !== undefined && state.partition !== operation.expectedPartition && !operation.replace) {
                    throw new MicrosoftSessionError("wrong-account");
                }
            }
            if (operation.action === "microsoft-cancel" && !active) throw new MicrosoftSessionError("invalid-request");
            if (operation.action === "microsoft-recover") {
                if (!qualified) throw new MicrosoftSessionError("hooks-unqualified");
                if (active) throw new MicrosoftSessionError("busy");
                if (!state.owner || state.connection !== "recovery-required") throw new MicrosoftSessionError("invalid-request");
            }
            const next = structuredClone(state);
            next.generation++;
            const receipt = { operationId: operation.operationId, action: operation.action,
                fingerprint: digest, ownerHash: ownedBy, generation: next.generation, outcome: "pending", reason: null, revocation: null };
            next.receipts.push(receipt);
            if (operation.action === "wire-sign-in") {
                if (active) throw new MicrosoftSessionError("busy");
                next.wire = "signed-in";
                receipt.outcome = "completed";
            } else if (operation.action === "wire-sign-out") {
                next.wire = "signed-out";
                next.connection = next.owner ? "recovery-required" : next.partition ? "reconnect-required" : "disconnected";
                next.reason = "signed-out";
                receipt.revocation = { scope: "wire", partition: null };
            } else if (operation.action === "microsoft-connect") {
                next.connection = next.owner ? "handoff" : next.partition ? "reconnect-required" : "disconnected";
                next.reason = null;
            }
            await save(next);
            if (operation.action === "microsoft-connect") {
                const controller = new AbortController();
                const displayMode = nativeRead ? nativeSignInMode : "visible";
                active = { operationId: operation.operationId, controller, done: null };
                // Start outside the state queue so cancel/sign-out can fence pending I/O.
                active.done = Promise.resolve().then(() => connect(operation, next.generation, controller, displayMode));
                if (nativeRead) {
                    try { notifyAuthorizationChange(); }
                    catch (error) {
                        void active.done.catch(() => undefined);
                        throw error;
                    }
                }
                return { task: active.done };
            }
            if (operation.action === "wire-sign-in") return { receipt: publicReceipt(receipt) };
            active?.controller.abort();
            return { wait: active?.done };
        });
        if (plan.task) return plan.task;
        if (plan.receipt) return plan.receipt;
        if (plan.wait) await plan.wait;
        const clean = await stopOwner();
        if (plan.limit) throw new MicrosoftSessionError("receipt-limit");
        return mutate(async () => {
            available();
            const next = structuredClone(state);
            const receipt = next.receipts.find(row => row.operationId === operation.operationId);
            receipt.outcome = clean ? "completed" : "failed";
            receipt.reason = clean ? null : "cleanup-failed";
            if (clean && operation.action === "microsoft-recover") next.reason = null;
            await save(next);
            return publicReceipt(receipt);
        });
    }
    function assertLease(lease) {
        available();
        if (!lease || !leases.has(lease) || lease.generation !== state.generation) throw new MicrosoftSessionError("lease-invalid");
        const status = snapshot();
        if (!status.authorization.retained
            || ["github-acquisition", "microsoft-read"].includes(lease.kind) && lease.acquisitionRevision !== acquisitionRevision
            || lease.kind === "github-acquisition" && !status.authorization.githubAcquisition
            || lease.kind === "github-manual-acquisition" && (!sourceAware || !status.authorization.githubManualAcquisition)
            || lease.kind === "microsoft-read" && (!status.authorization.microsoftAcquisition || lease.partition !== state.partition)
            || lease.kind === "microsoft-retained" && lease.partition !== state.partition) {
            throw new MicrosoftSessionError("lease-invalid");
        }
        return true;
    }
    function lease(kind) {
        if (!["retained", "github-acquisition", "microsoft-read", "microsoft-retained",
            ...(sourceAware ? ["github-manual-acquisition"] : [])].includes(kind)) throw new MicrosoftSessionError("invalid-request");
        const value = Object.freeze({ kind, generation: state.generation,
            acquisitionRevision,
            partition: kind.startsWith("microsoft-") ? state.partition : null });
        leases.add(value);
        assertLease(value);
        if (kind === "microsoft-retained" && !value.partition) throw new MicrosoftSessionError("lease-invalid");
        return value;
    }
    function nativeConfigurationCapability() {
        const value = snapshot();
        const partition = value.authorization.microsoftPartition;
        const canSave = nativeRead && value.authorization.retained && PARTITION.test(partition ?? "");
        let account = null;
        if (canSave && state.connection === "connected") {
            try {
                const identity = transport.accountFor(lease("microsoft-retained"));
                account = Object.freeze({ partition: identity.partition, issuer: identity.issuer,
                    tenantId: identity.account.tenantId, subjectId: identity.account.subjectId });
            } catch (error) {
                if (!(error instanceof MicrosoftSessionError) || error.code !== "lease-invalid") throw error;
            }
        }
        return Object.freeze({ generation: state.generation, authorizationRevision,
            partition, settings: Object.freeze({ ...settings }), account,
            ...(sourceAware ? { globalRevision: globalGate?.revision ?? null } : {}),
            canEnable: canSave && account !== null, canSave });
    }
    const api = Object.freeze({
        status: () => serial(() => snapshot()),
        ...(sourceAware ? {
            globalCollectionStatus: () => serial(() => {
                available();
                return Object.freeze({ generation: state.generation, authorizationRevision, globalCollection: globalGate });
            }),
            admitGlobalCollection(input, admission, work) {
                return mutate(async () => {
                    available();
                    if (!exact(input, ["schemaVersion", "enabled", "generation", "authorizationRevision", "expectedRevision"])
                        || input.schemaVersion !== 1 || typeof input.enabled !== "boolean"
                        || !Number.isSafeInteger(input.generation) || input.generation < 0
                        || !Number.isSafeInteger(input.authorizationRevision) || input.authorizationRevision < 0
                        || input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
                        || !admission || typeof admission.check !== "function" || typeof admission.dispatched !== "function"
                        || typeof work !== "function") throw new MicrosoftSessionError("invalid-request");
                    ownerHash(admission.owner);
                    if (state.wire !== "signed-in") throw new MicrosoftSessionError("signed-out");
                    if (input.generation !== state.generation || input.authorizationRevision !== authorizationRevision
                        || input.expectedRevision !== (globalGate?.revision ?? null)) throw new MicrosoftSessionError("stale-collection-control");
                    return callbackContext.run("global-collection-admission", async () => {
                        const check = () => authorizeCommand(() => {
                            const value = admission.check();
                            if (value && typeof value.then === "function") {
                                Promise.resolve(value).catch(() => undefined);
                                return false;
                            }
                            return value === undefined || value === true;
                        });
                        check();
                        const paused = !input.enabled, token = Object.freeze({});
                        const revision = globalGate === null ? 1
                            : globalGate.paused === paused ? globalGate.revision : globalGate.revision + 1;
                        if (!Number.isSafeInteger(revision)) throw new MicrosoftSessionError("invalid-request");
                        globalCollectionAdmissions.set(token, Object.freeze({ owner: admission.owner,
                            generation: state.generation, authorizationRevision, intent: "set-global-collection",
                            expectedRevision: input.expectedRevision, paused }));
                        let dispatched = false;
                        const guarded = Object.freeze({ ...admission, check, dispatched() {
                            dispatched = true;
                            const result = admission.dispatched();
                            if (result && typeof result.then === "function") {
                                Promise.resolve(result).catch(() => undefined);
                                throw new MicrosoftSessionError("invalid-request");
                            }
                        } });
                        try {
                            const committed = globalCollectionGate(await work(token, guarded));
                            if (committed === null || committed.revision !== revision || committed.paused !== paused) {
                                throw new MicrosoftSessionError("invalid-request");
                            }
                            globalGate = committed;
                            acquisitionRevision++;
                            notifyAuthorizationChange();
                            return committed;
                        } catch (error) {
                            if (dispatched && !poisoned) poison("storage-failed");
                            throw error;
                        } finally { globalCollectionAdmissions.delete(token); }
                    });
                });
            },
            assertGlobalCollectionAdmission(token) {
                available();
                const admission = globalCollectionAdmissions.get(token);
                if (!admission || admission.generation !== state.generation || admission.authorizationRevision !== authorizationRevision
                    || admission.expectedRevision !== (globalGate?.revision ?? null)) throw new MicrosoftSessionError("invalid-request");
                return admission;
            },
        } : {}),
        command,
        receipt: (owner, operationId) => serial(() => {
            const ownedBy = ownerHash(owner);
            if (!UUID.test(operationId)) throw new MicrosoftSessionError("invalid-request");
            const receipt = state.receipts.find(row => row.operationId === operationId);
            if (receipt) assertReceiptOwner(receipt, ownedBy);
            return receipt ? publicReceipt(receipt) : null;
        }),
        lease: kind => serial(() => lease(kind)),
        assertLease: value => serial(() => assertLease(value)),
        assertRetainedLeaseCurrent(value) {
            if (!["retained", "microsoft-retained"].includes(value?.kind)) throw new MicrosoftSessionError("invalid-request");
            return assertLease(value);
        },
        admit: (value, work) => serial(async () => {
            assertLease(value);
            if (typeof work !== "function") throw new MicrosoftSessionError("invalid-request");
            try { return await callbackContext.run("admission", work); }
            catch (error) {
                throw new MicrosoftSessionError(error instanceof MicrosoftSessionError ? error.code : "admission-failed");
            }
        }),
        subscribeAuthorizationChange(listener) {
            assertNoReentry();
            available();
            if (typeof listener !== "function") throw new MicrosoftSessionError("invalid-request");
            if (dispatchAuthorizationChange([listener], authorizationEvent())) {
                throw new MicrosoftSessionError("authorization-listener-failed");
            }
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        },
        collectionIntent: () => serial(() => {
            available();
            if (!snapshot().authorization.microsoftAcquisition) return null;
            return { kind: "schedule-microsoft", lease: lease("microsoft-read"),
                surfaces: ["chat", "cowork"], windowDays: settings.windowDays };
        }),
        async updateCollection(value) {
            const readCurrent = typeof value === "function" ? value : null;
            if (readCurrent && !nativeRead) throw new MicrosoftSessionError("invalid-request");
            const nextSettings = readCurrent ? null : collectionSettings(value);
            await mutate(async () => {
                available();
                const committed = readCurrent
                    ? collectionSettings(await callbackContext.run("collection-settings-read", readCurrent)) : nextSettings;
                available();
                acquisitionRevision++;
                settings = committed;
                notifyAuthorizationChange();
            });
        },
        async setNativeCollectionEnabled(enabled, expectedRevision, admission) {
            await mutate(() => {
                available();
                if (!nativeRead || typeof enabled !== "boolean" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
                    || !admission || typeof admission.check !== "function" || typeof admission.dispatched !== "function") {
                    throw new MicrosoftSessionError("invalid-request");
                }
                if (expectedRevision !== authorizationRevision) throw new MicrosoftSessionError("stale-collection-control");
                if (state.wire !== "signed-in") throw new MicrosoftSessionError("signed-out");
                if (sourceAware) ownerHash(admission.owner);
                return callbackContext.run("collection-admission", async () => {
                    admission.check();
                    if (enabled) {
                        if (state.connection !== "connected") throw new MicrosoftSessionError("access-refused");
                        transport.accountFor(lease("microsoft-retained"));
                    }
                    admission.dispatched();
                    let nextSettings = Object.freeze({ ...settings, paused: !enabled });
                    if (persistCollectionSettings) {
                        const token = Object.freeze({});
                        collectionSettingsAdmissions.set(token, Object.freeze({
                            generation: state.generation, partition: state.partition, settings: nextSettings,
                            ...(sourceAware ? { owner: admission.owner, authorizationRevision, globalRevision: globalGate?.revision ?? null } : {}),
                        }));
                        try {
                            const committed = collectionSettings(await persistCollectionSettings(nextSettings, token));
                            if (committed.paused !== nextSettings.paused) throw new MicrosoftSessionError("invalid-request");
                            nextSettings = Object.freeze(committed);
                        }
                        finally { collectionSettingsAdmissions.delete(token); }
                    }
                    acquisitionRevision++;
                    settings = nextSettings;
                    notifyAuthorizationChange();
                });
            });
        },
        assertNativeCollectionSettingsAdmission(token) {
            // The settings hook already owns the lifecycle queue; this is not a data lease.
            available();
            const admission = collectionSettingsAdmissions.get(token);
            if (!admission || admission.generation !== state.generation || admission.partition !== state.partition
                || sourceAware && (admission.authorizationRevision !== authorizationRevision
                    || admission.globalRevision !== (globalGate?.revision ?? null))) {
                throw new MicrosoftSessionError("invalid-request");
            }
            return admission;
        },
        async admitNativeConfiguration(input, admission, work) {
            return mutate(async () => {
                available();
                if (!nativeRead || !exact(input, ["intent", "windowDays", ...(sourceAware ? ["globalRevision"] : [])])
                    || !["enable", "save"].includes(input.intent)
                    || !admission || typeof admission.check !== "function" || typeof admission.dispatched !== "function"
                    || typeof work !== "function") throw new MicrosoftSessionError("invalid-request");
                ownerHash(admission.owner);
                if (sourceAware && input.globalRevision !== (globalGate?.revision ?? null)) {
                    throw new MicrosoftSessionError("stale-collection-control");
                }
                return callbackContext.run("native-configuration-admission", async () => {
                    const check = () => authorizeCommand(() => {
                        const checked = admission.check();
                        if (checked && typeof checked.then === "function") {
                            Promise.resolve(checked).catch(() => undefined);
                            return false;
                        }
                        return checked === undefined || checked === true;
                    });
                    check();
                    const authority = nativeConfigurationCapability();
                    const requested = Object.freeze(collectionSettings({
                        paused: input.intent === "enable" ? false : authority.settings.paused, windowDays: input.windowDays,
                    }));
                    if (state.wire !== "signed-in") throw new MicrosoftSessionError("signed-out");
                    if (!authority.canSave || input.intent === "enable" && !authority.canEnable) throw new MicrosoftSessionError("access-refused");
                    const token = Object.freeze({});
                    nativeConfigurationAdmissions.set(token, Object.freeze({
                        generation: state.generation, authorizationRevision, partition: state.partition,
                        owner: admission.owner, intent: input.intent, settings: requested, account: authority.account,
                        ...(sourceAware ? { globalRevision: globalGate?.revision ?? null } : {}),
                    }));
                    let dispatched = false;
                    const request = Object.freeze({ ...admission, check,
                        dispatched() {
                            dispatched = true;
                            const result = admission.dispatched();
                            if (result && typeof result.then === "function") {
                                Promise.resolve(result).catch(() => undefined);
                                throw new MicrosoftSessionError("invalid-request");
                            }
                        },
                    });
                    try {
                        const result = await work(token, request);
                        const committed = collectionSettings(result?.settings);
                        if (committed.paused !== requested.paused || committed.windowDays !== requested.windowDays) {
                            throw new MicrosoftSessionError("invalid-request");
                        }
                        acquisitionRevision++;
                        settings = Object.freeze(committed);
                        notifyAuthorizationChange();
                        return result;
                    } catch (error) {
                        if (dispatched && !poisoned) poison("storage-failed");
                        throw error;
                    } finally { nativeConfigurationAdmissions.delete(token); }
                });
            });
        },
        assertNativeConfigurationAdmission(token) {
            available();
            const admission = nativeConfigurationAdmissions.get(token);
            if (!admission || admission.generation !== state.generation || admission.partition !== state.partition
                || admission.authorizationRevision !== authorizationRevision
                || sourceAware && admission.globalRevision !== (globalGate?.revision ?? null)) {
                throw new MicrosoftSessionError("invalid-request");
            }
            return admission;
        },
        nativeConfigurationStatus: () => serial(() => {
            const value = nativeConfigurationCapability();
            return Object.freeze({ generation: value.generation, authorizationRevision: value.authorizationRevision,
                partition: value.partition, enable: value.canEnable, save: value.canSave,
                ...(sourceAware ? { globalRevision: value.globalRevision } : {}) });
        }),
        async nativeOwnerLost(value) {
            if (!nativeRead || !exact(value, ["ownerId", "generation", "code", "publicCoworkScript"]) || !UUID.test(value.ownerId)
                || !Number.isSafeInteger(value.generation) || value.generation < 0
                || Object.hasOwn(value, "code") && (typeof value.code !== "string" || !/^NATIVE_[A-Z_]{1,93}$/.test(value.code))
                || Object.hasOwn(value, "publicCoworkScript") && (value.code !== "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED"
                    || typeof value.publicCoworkScript !== "string" || !/^coworker\.[a-f0-9]{8}\.js$/.test(value.publicCoworkScript))) {
                throw new MicrosoftSessionError("invalid-request");
            }
            const lost = await mutate(async () => {
                if (closed || closing || state.owner?.id !== value.ownerId || state.generation !== value.generation
                    || !["connected", "signing-in"].includes(state.connection)) return false;
                available();
                const next = structuredClone(state);
                const receipt = next.receipts.find(row => row.operationId === next.owner.operationId
                    && row.action === "microsoft-connect" && row.generation === value.generation);
                if (!receipt) throw new MicrosoftSessionError("state-invalid");
                receipt.nativeEvidence ??= {};
                receipt.nativeEvidence.firstFailure ??= {
                    code: value.code ?? "NATIVE_BROWSER_OWNER_LOST", recordedAt: new Date().toISOString(),
                    predicate: { schemaVersion: 1, stage: "completion", name: "native-owner-lost" },
                    ...(value.publicCoworkScript ? { publicCoworkScript: value.publicCoworkScript } : {}),
                };
                next.generation++;
                next.connection = next.partition ? "reconnect-required" : "disconnected";
                next.reason = null;
                await save(next);
                active?.controller.abort();
                return true;
            });
            if (lost && !await stopOwner()) throw new MicrosoftSessionError(poisoned ? poisonReason : "cleanup-failed");
            return lost;
        },
        async expire(value) {
            await mutate(async () => {
                assertLease(value);
                if (value.kind !== "microsoft-read") throw new MicrosoftSessionError("invalid-request");
                const next = structuredClone(state);
                next.generation++;
                next.connection = "reconnect-required";
                next.reason = null;
                await save(next);
            });
            if (!await stopOwner()) throw new MicrosoftSessionError(poisoned ? poisonReason : "cleanup-failed");
        },
        close() {
            assertNoReentry();
            if (closed) return Promise.resolve();
            if (closeTask) return closeTask;
            closeTask = (async () => {
                try {
                    await serial(async () => {
                        closing = true;
                        notifyAuthorizationChange();
                        const next = structuredClone(state);
                        next.generation++;
                        if (!poisoned) await save(next);
                        active?.controller.abort();
                    });
                    if (active) await active.done;
                    if (!await stopOwner() || poisoned) throw new MicrosoftSessionError(poisoned ? poisonReason : "cleanup-failed");
                    await serial(async () => {
                        try { await release(); }
                        catch { poison("storage-failed"); throw new MicrosoftSessionError(poisonReason); }
                        closed = true;
                        notifyAuthorizationChange();
                    });
                } catch (error) {
                    if (poisoned) await stopOwner();
                    throw error;
                } finally {
                    try {
                        await serial(() => {
                            closing = false;
                            try { notifyAuthorizationChange(); }
                            finally { if (closed) subscribers.clear(); }
                        });
                    } finally { closeTask = null; }
                }
            })();
            return closeTask;
        },
    });
    if (nativeRead) nativeSessions.set(api, context);
    if (copilotOnly) copilotSessions.set(api, context);
    return api;
}
