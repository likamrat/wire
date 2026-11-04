import { createHash, randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BoardError, resolveDataDir, exclusiveBoard } from "./store.mjs";
import { MicrosoftSessionError, isNativeMicrosoftSession, microsoftConnectionStatus, createMicrosoftSession, isCopilotSession } from "./microsoft-session.mjs";
import { assertCollectorLockOwned } from "./collector-io.mjs";
import { assertCopilotStore, assertCopilotState } from "./release-policy.mjs";
import { readGlobalCollectionGate } from "./native-persistence.mjs";
import { createNativeRetainedRead } from "./native-retained-read.mjs";
import { validateStoredSourcePaths } from "./source-discovery.mjs";
import { createNativeRetainedViews } from "./native-retained-views.mjs";
import { nativeFailureDetails } from "./microsoft-session-state.mjs";
import { nativeBackfillFor } from "./native-backfill-state.mjs";

const instances = new WeakSet();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownerPattern = /^[a-zA-Z0-9_-]{16,256}$/;
const acquisitionRoutes = new Set([
    "/api/import", "/api/record", "/api/collection/now", "/api/collection/configure",
    "/api/collection/enabled", "/api/collection/models/qualify", "/api/assessment/response-timing/qualify",
    "/api/recollection/confirm",
]);
const acquisitionActions = new Set([
    "refresh_history", "record_graph_metadata", "collect_now", "configure_collection",
    "set_collection_enabled", "qualify_interaction_models", "qualify_response_timing",
]);
export const ACCESS_PATHS = Object.freeze({
    status: "/api/access/status", command: "/api/access/command", receipt: "/api/access/receipt", watch: "/api/access/watch",
});
export const ACCESS_TIMING = Object.freeze({ maxWaitMs: 1000, freshnessMs: 5000 });

function failure(code, status = 403) {
    const error = new BoardError(`WIRE access: ${code}. No action was replayed.`, status);
    error.code = code;
    return error;
}
function object(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw failure("wire_access_invalid_request", 422);
    }
}
function owner(value) {
    if (typeof value !== "string" || !ownerPattern.test(value)) throw failure("wire_access_invalid_owner", 422);
}
function checkNativeAdmission(admission) {
    const checked = admission.check();
    if (checked && typeof checked.then === "function") {
        Promise.resolve(checked).catch(() => undefined);
        throw failure("wire_access_revoked");
    }
    if (checked !== undefined && checked !== true) throw failure("wire_access_revoked");
    return true;
}
function translate(error) {
    if (!(error instanceof MicrosoftSessionError)) return error;
    if (error.code === "lease-invalid" || error.code === "signed-out") return failure("wire_access_revoked");
    return failure(`wire_access_${error.code.replaceAll("-", "_")}`, error.status);
}
async function invoke(work) {
    try { return await work(); } catch (error) { throw translate(error); }
}
async function admitWork(lifecycle, lease, work) {
    const result = await invoke(() => lifecycle.admit(lease, async () => {
        try { return { value: await work() }; }
        catch (error) {
            if (!(error instanceof BoardError)) throw error;
            return { error };
        }
    }));
    if (result.error) throw result.error;
    return result.value;
}

// This binding is deliberately limited to temporary fixture stores. It is not
// a source/account authorizer and cannot activate a production connector.
export async function createFixtureRuntimeAccess(context, { lifecycle, nativeSource } = {}) {
    return createRuntimeAccess(context, { lifecycle, nativeSource }, false);
}

export async function createCopilotRuntimeAccess(context) {
    const existing = await assertCopilotStore(context);
    let lifecycle;
    try {
        lifecycle = await createMicrosoftSession(context, { copilotOnly: true, sourceAware: true,
            globalCollection: existing ? await readGlobalCollectionGate(context) : null, initialWire: "signed-in",
            collection: { paused: true, windowDays: 30 } });
        return await createRuntimeAccess(context, { lifecycle, copilotOnly: true,
            readCommittedGlobalGate: () => readGlobalCollectionGate(context) }, false);
    } catch (error) {
        await lifecycle?.close();
        throw error;
    }
}

// Explicit native read-only binding; never relax the fixture store gate.
export async function createNativeRuntimeAccess(context, { lifecycle, nativeSource, nativePersistence, acquireNative, completeNative,
    nativeConnection = false, sourceAware = false, nativeAcquisition = true, nativeEnrollment, nativeScheduling = false } = {}) {
    if (!context?.dataDir || !isNativeMicrosoftSession(lifecycle, context) || typeof nativeConnection !== "boolean"
        || typeof sourceAware !== "boolean" || typeof nativeAcquisition !== "boolean"
        || sourceAware && typeof lifecycle.globalCollectionStatus !== "function"
        || typeof nativeScheduling !== "boolean" || nativeScheduling && !sourceAware
        || nativeEnrollment !== undefined && (!sourceAware || nativeConnection
            || typeof nativeEnrollment.available !== "function" || typeof nativeEnrollment.prepare !== "function")) {
        throw failure("wire_access_native_binding_required", 503);
    }
    let readCommittedNativeSettings, readCommittedGlobalGate, nativeReportSourceFor;
    if (nativePersistence !== undefined || acquireNative !== undefined || completeNative !== undefined) {
        const { isNativePersistence, readNativeCollectionSettings, readGlobalCollectionGate,
            isNativeReportSource } = await import("./native-persistence.mjs");
        if (!isNativePersistence(nativePersistence, context, lifecycle) || typeof acquireNative !== "function"
            || completeNative !== undefined && typeof completeNative !== "function"
            || typeof readNativeCollectionSettings !== "function"
            || nativeSource !== undefined && nativeSource !== nativePersistence.readAuthorized) {
            throw failure("wire_access_native_persistence_binding_required", 503);
        }
        nativeSource = nativePersistence.readAuthorized;
        if (sourceAware && nativeAcquisition
            && ["beginSegmented", "commitSegmented"].some(method => typeof nativePersistence[method] !== "function")) {
            throw failure("wire_access_native_segmented_writer_required", 503);
        }
        readCommittedNativeSettings = () => readNativeCollectionSettings(context);
        if (nativePersistence.reportSource !== undefined) {
            const source = nativePersistence.reportSource;
            nativeReportSourceFor = () => {
                if (typeof isNativeReportSource !== "function" || !isNativeReportSource(source, context)) {
                    throw failure("wire_access_native_report_binding_required", 503);
                }
                return source;
            };
            nativeReportSourceFor();
        }
        if (sourceAware && typeof readGlobalCollectionGate === "function") {
            readCommittedGlobalGate = () => readGlobalCollectionGate(context);
        }
    }
    if (typeof nativeSource !== "function") throw failure("wire_access_native_binding_required", 503);
    return createRuntimeAccess(context, { lifecycle, nativeSource, nativePersistence, acquireNative, completeNative,
        readCommittedNativeSettings, readCommittedGlobalGate, nativeConnection, sourceAware, nativeReportSourceFor, nativeAcquisition,
        nativeEnrollment, nativeScheduling }, true);
}

async function createRuntimeAccess(context, { lifecycle, nativeSource, nativePersistence, acquireNative, completeNative,
    readCommittedNativeSettings, readCommittedGlobalGate, nativeConnection = false, sourceAware = false,
    nativeReportSourceFor, nativeAcquisition = true, nativeEnrollment, nativeScheduling = false, copilotOnly = false }, nativeRead) {
    const directory = await realpath(resolveDataDir(context)), temporary = await realpath(os.tmpdir());
    const relative = path.relative(temporary, directory);
    if (copilotOnly && !isCopilotSession(lifecycle, context)) throw failure("wire_access_untrusted_binding", 422);
    if (!nativeRead && !copilotOnly && (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))) {
        throw failure("wire_access_fixture_store_required", 422);
    }
    if (!lifecycle || ["status", "command", "receipt", "lease", "assertLease", "admit", "updateCollection", "subscribeAuthorizationChange"]
        .some(name => typeof lifecycle[name] !== "function")) throw failure("wire_access_lifecycle_unqualified", 503);
    async function validateCollectionSource(config) {
        if (sourceAware || copilotOnly) {
            if (config === null) return;
            if (config?.approved !== true || typeof config.enabled !== "boolean"
                || ![7, 30, 90].includes(config.windowDays) || ![5, 15, 30, 60].includes(config.pollSeconds)) {
                throw failure("wire_access_collector_configuration_required", 422);
            }
            validateStoredSourcePaths(config);
            return;
        }
        if (nativeRead) throw failure("wire_access_native_read_only", 403);
        const root = path.dirname(directory);
        const contained = target => {
            const relative = path.relative(root, target);
            return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
        };
        if (root === temporary || config?.approved !== true || typeof config.enabled !== "boolean"
            || ![7, 30, 90].includes(config.windowDays) || ![5, 15, 30, 60].includes(config.pollSeconds)) {
            throw failure("wire_access_collector_configuration_required", 422);
        }
        for (const value of [config.appDbPath, config.sessionRoot]) {
            if (typeof value !== "string" || !path.isAbsolute(value) || !contained(value)
                || !contained(await realpath(value))) throw failure("wire_access_fixture_source_required", 422);
        }
    }
    const active = new Set(), listeners = new Set(), collectionListeners = new Set(), controlListeners = new Set(), ownedLeases = new WeakSet();
    const manualRequests = new WeakMap(), guardOwners = new WeakMap();
    function checkManualLease(lease) {
        if (lease?.kind !== "github-manual-acquisition") return;
        const check = (sourceAware || copilotOnly) && manualRequests.get(lease);
        if (!check) throw failure("wire_access_invalid_lease");
        check();
    }
    let control = null;
    let enrolling = false, enrollmentFailed = false;
    let nativeRunning = false, nativeScheduler, nativeCoordinate;
    const coordinateNativeWrite = work => nativeCoordinate ? nativeCoordinate(work) : work();
    let closed = false, collectionAllowed = false, manualCollectionAllowed = false,
        observedGeneration = (await invoke(() => lifecycle.status())).generation;
    const unsubscribe = lifecycle.subscribeAuthorizationChange(event => {
        if (!Number.isSafeInteger(event.revision) || event.revision < 0
            || !Number.isSafeInteger(event.generation) || event.generation < 0
            || !["signed-in", "signed-out"].includes(event.wire)
            || !["enabled", "paused"].includes(event.collection) || typeof event.retained !== "boolean"
            || (sourceAware || copilotOnly) && typeof event.githubManualAcquisition !== "boolean"
            || control && (event.revision < control.authorizationRevision || event.generation < control.generation)) {
            throw failure("wire_access_control_invalid", 503);
        }
        control = Object.freeze({
            authorizationRevision: event.revision, generation: event.generation,
            wire: event.wire, retained: event.retained, collection: event.collection,
            ...(nativeConnection ? { microsoft: event.microsoft } : {}),
        });
        let revoked = false;
        for (const item of active) if (!event.retained || item.generation !== event.generation) {
            revoked = true;
            item.controller.abort(failure("wire_access_revoked"));
            active.delete(item);
        }
        // Even without an active request, old preview owners and avatar tickets
        // must not survive a generation change.
        const changed = event.generation !== observedGeneration || !event.retained;
        const collectionChanged = event.generation !== observedGeneration || collectionAllowed !== event.githubAcquisition;
        collectionAllowed = event.githubAcquisition === true;
        manualCollectionAllowed = (sourceAware || copilotOnly) && event.githubManualAcquisition === true;
        observedGeneration = event.generation;
        if (collectionChanged) for (const listener of collectionListeners) listener();
        if (changed) for (const listener of listeners) listener(Object.freeze({
            generation: event.generation, retained: event.retained, revoked,
        }));
        for (const listener of controlListeners) listener(control);
    });
    async function status() {
        if (closed) throw failure("wire_access_closed", 503);
        const value = await invoke(() => lifecycle.status());
        if (closed) throw failure("wire_access_closed", 503);
        return {
            schemaVersion: 1, stage: copilotOnly ? "copilot-only" : nativeRead ? "native-read-only" : "private-fixture", generation: value.generation,
            authorizationRevision: value.authorizationRevision,
            wire: value.wire, retained: value.authorization.retained && !closed,
            collection: value.collection,
            actions: closed ? [] : value.actions.filter(action => action === "wire-sign-in" || action === "wire-sign-out"),
            ...(nativeConnection ? { microsoft: microsoftConnectionStatus(value) } : {}),
            enforcement: {
                backendReads: "generation-fenced", acquisition: nativePersistence ? "screened-native-persistence" : "writer-integration-pending",
                accountPartitions: copilotOnly ? "protected-native-state-refused" : nativeRead ? "native-account-metadata" : "native-provenance-unqualified",
                clientClearance: "not-integrated",
            },
        };
    }
    async function read(panelOwner) {
        owner(panelOwner);
        if (closed) throw failure("wire_access_closed", 409);
        const lease = await invoke(() => lifecycle.lease("retained"));
        return invoke(() => lifecycle.admit(lease, () => {
            if (closed) throw failure("wire_access_closed", 409);
            const controller = new AbortController();
            const item = { panelOwner, generation: lease.generation, controller };
            active.add(item);
            const guard = Object.freeze({
                generation: lease.generation,
                owner: createHash("sha256").update(`${panelOwner}:${lease.generation}`).digest("hex"),
                signal: controller.signal,
                publish(work) {
                    if (closed || controller.signal.aborted) throw failure("wire_access_revoked");
                    return work();
                },
                async admit(work) {
                    return admitWork(lifecycle, lease, () => {
                        if (closed || controller.signal.aborted) throw failure("wire_access_revoked");
                        return work();
                    });
                },
                release() { active.delete(item); controller.abort(failure("wire_access_revoked")); },
            });
            ownedLeases.add(guard);
            guardOwners.set(guard, panelOwner);
            return guard;
        }));
    }
    const nativeReader = nativeSource === undefined ? null : createNativeRetainedRead(lifecycle, nativeSource);
    const nativeViews = typeof nativePersistence?.withRetainedReader === "function"
        ? createNativeRetainedViews(context, nativePersistence, lifecycle) : null;
    const api = Object.freeze({
        sourceAware, copilotOnly,
        nativeReader,
        ...(typeof nativePersistence?.readAccountPresentation === "function" ? {
            async microsoftProfileFor(guard) {
                if (closed || !ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
                guard.publish(() => {});
                const status = await invoke(() => lifecycle.status());
                guard.publish(() => {});
                if (status.microsoft.state !== "connected") return null;
                const lease = await invoke(() => lifecycle.lease("microsoft-retained"));
                if (lease.generation !== guard.generation) throw failure("wire_access_revoked");
                const value = await invoke(() => nativePersistence.readAccountPresentation(lease));
                return guard.publish(() => value);
            },
        } : {}),
        ...(typeof nativePersistence?.localActivityDeletionAdmission === "function" ? {
            async localActivityDeletionFor(guard, admission) {
                if (closed || !ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
                object(admission, ["check", "dispatched"]);
                if (typeof admission.check !== "function" || typeof admission.dispatched !== "function") {
                    throw failure("wire_access_native_request_admission_required", 503);
                }
                const check = () => guard.publish(() => checkNativeAdmission(admission));
                check();
                const request = Object.freeze({ owner: guard.owner, check,
                    dispatched() {
                        check();
                        const value = admission.dispatched();
                        if (value && typeof value.then === "function") {
                            Promise.resolve(value).catch(() => {});
                            throw failure("wire_access_invalid_request", 422);
                        }
                        if (value !== undefined && value !== true) throw failure("wire_access_revoked");
                    },
                });
                const local = await invoke(() => nativePersistence.localActivityDeletionAdmission(request));
                check();
                return local;
            },
        } : {}),
        ...(nativeViews ? {
            nativeReportViewFor(guard, admission, binding) {
                if (closed || !ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
                object(admission, ["check"]);
                object(binding, ["viewId", "nativeIds"]);
                if (typeof admission.check !== "function" || !Array.isArray(binding.nativeIds)) {
                    throw failure("wire_access_native_request_admission_required", 503);
                }
                const original = Object.freeze({ viewId: binding.viewId, nativeIds: Object.freeze([...binding.nativeIds]) });
                const check = () => guard.publish(() => checkNativeAdmission(admission));
                check();
                const request = Object.freeze({ owner: guard.owner, check,
                    dispatched() { throw failure("wire_access_retained_read_only", 403); } });
                return async scope => {
                    object(scope, scope?.kind === "periods" ? ["kind", "revision", "options", "periods", "datePolicy"] : ["kind", "revision"]);
                    check();
                    if (scope.kind === "periods") {
                        if (original.nativeIds.length) throw failure("wire_access_native_request_admission_required", 503);
                        const result = await invoke(() => nativeViews.resolvePeriods({ schemaVersion: 1,
                            viewId: original.viewId, revision: scope.revision, options: scope.options,
                            periods: scope.periods, datePolicy: scope.datePolicy }, request, { signal: guard.signal }));
                        check();
                        return result;
                    }
                    const result = await invoke(() => nativeViews.resolveSelection({
                        schemaVersion: 1, ...original, kind: scope.kind, revision: scope.revision,
                    }, request, { signal: guard.signal }));
                    check();
                    return result;
                };
            },
            nativeRetainedFor(guard, admission) {
                if (closed || !ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
                object(admission, ["check"]);
                if (typeof admission.check !== "function") throw failure("wire_access_native_request_admission_required", 503);
                const check = () => guard.publish(() => checkNativeAdmission(admission));
                check();
                const request = Object.freeze({ owner: guard.owner, check,
                    dispatched() { throw failure("wire_access_retained_read_only", 403); } });
                return Object.freeze(Object.fromEntries(["query", "detail", "search", "analyze", "inventory", "drilldown", "readback"].map(method => [method,
                    async input => {
                        check();
                        const value = await invoke(() => nativeViews[method](input, request, {
                            signal: guard.signal, receiptOwner: guardOwners.get(guard),
                        }));
                        check();
                        return value;
                    }])));
            },
        } : {}),
        ...(nativeReportSourceFor ? {
            nativeReportPublicationReady() {
                if (closed || !sourceAware || !nativeViews) return false;
                const source = nativeReportSourceFor();
                return ["captureSelection", "iterateSelection", "validate", "commit", "readSaved", "artifactMutationAdmission"]
                    .every(method => typeof source[method] === "function");
            },
            async nativeArtifactMutationFor(guard, admission) {
                if (closed || !ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
                object(admission, ["check", "dispatched"]);
                if (typeof admission.check !== "function" || typeof admission.dispatched !== "function") {
                    throw failure("wire_access_native_request_admission_required", 503);
                }
                const check = () => guard.publish(() => checkNativeAdmission(admission));
                check();
                const source = nativeReportSourceFor();
                if (typeof source.artifactMutationAdmission !== "function") throw failure("wire_access_artifact_mutation_unqualified", 503);
                const request = Object.freeze({ owner: guard.owner, check,
                    dispatched() {
                        check();
                        const value = admission.dispatched();
                        if (value && typeof value.then === "function") {
                            Promise.resolve(value).catch(() => {});
                            throw failure("wire_access_invalid_request", 422);
                        }
                        if (value !== undefined && value !== true) throw failure("wire_access_revoked");
                    },
                });
                const mutation = await invoke(() => source.artifactMutationAdmission(request));
                check();
                return mutation;
            },
            nativeReportsFor(guard, admission) {
                if (closed || !ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
                object(admission, ["check", "dispatched"]);
                if (typeof admission.check !== "function" || typeof admission.dispatched !== "function") {
                    throw failure("wire_access_native_request_admission_required", 503);
                }
                const check = () => guard.publish(() => checkNativeAdmission(admission));
                check();
                return Object.freeze({ nativeReportSource: nativeReportSourceFor(),
                    nativeReportAdmission: Object.freeze({ owner: guard.owner, check,
                        dispatched() {
                            check();
                            const value = admission.dispatched();
                            if (value && typeof value.then === "function") {
                                Promise.resolve(value).catch(() => undefined);
                                throw failure("wire_access_native_report_admission_invalid", 422);
                            }
                        },
                    }),
                });
            },
        } : {}),
        ...(sourceAware ? {
            startNativeCollection(coordinate, onCommitted) {
                if (closed || nativeCoordinate || typeof coordinate !== "function" || typeof onCommitted !== "function") {
                    throw failure("wire_access_native_scheduler_invalid", 503);
                }
                nativeCoordinate = coordinate;
                if (!nativeScheduling) return;
                const timerScope = new AsyncResource("WIRENativeCollectorTimer", { requireManualDestroy: true });
                const schedulerOwner = randomUUID();
                let timer, running, stopped = false, authorization, failedRevision = null;
                const admission = { owner: schedulerOwner,
                    check() {
                        if (stopped || closed || !nativeAcquisition || !authorization?.microsoftAcquisition) throw failure("wire_access_revoked");
                    },
                    dispatched() {},
                };
                const schedule = milliseconds => {
                    clearTimeout(timer);
                    if (stopped || closed || running || !nativeAcquisition || !authorization?.microsoftAcquisition
                        || failedRevision === authorization.revision) return;
                    timer = setTimeout(timerScope.bind(run), milliseconds);
                    timer.unref();
                };
                const run = () => {
                    if (stopped || closed || running) return;
                    running = Promise.resolve().then(async () => {
                        admission.check();
                        const intent = await invoke(() => lifecycle.collectionIntent());
                        if (!intent) return;
                        await invoke(() => lifecycle.assertLease(intent.lease));
                        const status = await api.nativePersistenceStatus({}, admission);
                        if (!status.actions.includes("collect-now") || status.blockers.includes("NATIVE_RETENTION_OPERATION_UNKNOWN")) return;
                        const receipt = await api.collectNativeNow({ operationId: randomUUID() }, admission);
                        if (receipt.status !== "committed") throw failure("wire_access_native_outcome_unknown", 409);
                        await onCommitted(receipt);
                    }).catch(error => {
                        // Revocation is an intentional stop. Other failures require a new deliberate lifecycle action.
                        if (!stopped && !closed && authorization?.microsoftAcquisition) {
                            failedRevision = authorization.revision;
                            console.error("[workiq-runtime] native scheduled collection stopped", {
                                code: /^[A-Za-z_]+$/.test(error?.code ?? "") ? error.code : "NATIVE_SCHEDULE_FAILED",
                            });
                        }
                    }).finally(() => { running = null; schedule(60000); });
                };
                const release = lifecycle.subscribeAuthorizationChange(event => {
                    authorization = event;
                    schedule(0);
                });
                nativeScheduler = {
                    failed: () => failedRevision !== null && failedRevision === authorization?.revision,
                    confirmed() { failedRevision = null; schedule(60000); },
                    async close() {
                        if (!stopped) { stopped = true; clearTimeout(timer); release(); timerScope.emitDestroy(); }
                        await running;
                    },
                };
            },
            stopNativeCollection() { return nativeScheduler?.close(); },
            async nativeEnrollmentStatus(admission) {
                owner(admission?.owner);
                checkNativeAdmission(admission);
                const current = await invoke(() => lifecycle.status());
                checkNativeAdmission(admission);
                if (closed || !current.authorization.retained) throw failure("wire_access_revoked");
                const available = !nativeConnection && !enrolling && !enrollmentFailed && nativeEnrollment?.available() === true;
                return { schemaVersion: 1, phase: nativeConnection ? "prepared" : available ? "available" : "unavailable",
                    generation: current.generation, actions: available ? ["prepare"] : [],
                    reason: nativeConnection ? "source-already-configured" : available ? null : "enrollment-unavailable" };
            },
            async prepareNativeEnrollment(input, admission) {
                object(input, ["schemaVersion", "generation", "operationId", ...(input?.schemaVersion === 2 ? [] : ["expectedAccount"])]);
                owner(admission?.owner);
                if (![1, 2].includes(input.schemaVersion) || !Number.isSafeInteger(input.generation) || input.generation < 0
                    || typeof input.operationId !== "string" || !uuid.test(input.operationId)
                    || input.schemaVersion === 1 && (typeof input.expectedAccount !== "string" || input.expectedAccount.length > 160
                    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expectedAccount)
                    || /[\u0000-\u001f\u007f]/.test(input.expectedAccount))) throw failure("wire_access_invalid_request", 422);
                const check = () => {
                    checkNativeAdmission(admission);
                    if (closed || !control?.retained || control.generation !== input.generation) throw failure("wire_access_enrollment_stale", 409);
                };
                check();
                if (enrolling || enrollmentFailed || nativeConnection || nativeEnrollment?.available() !== true) {
                    throw failure("wire_access_enrollment_unavailable", 409);
                }
                enrolling = true;
                try {
                    await nativeEnrollment.prepare(input.expectedAccount, { ...admission, check });
                    check();
                    nativeConnection = true;
                    nativeAcquisition = true;
                    const saved = await readCommittedNativeSettings();
                    await invoke(() => lifecycle.updateCollection(saved
                        ? { paused: saved.paused, windowDays: saved.windowDays } : { paused: true, windowDays: 30 }));
                    return await api.nativeEnrollmentStatus(admission);
                } catch (error) {
                    enrollmentFailed = true;
                    throw error;
                } finally { enrolling = false; }
            },
        } : {}),
        ...(sourceAware || copilotOnly ? {
            async globalCollectionControl(admission) {
                if (closed) throw failure("wire_access_closed", 409);
                owner(admission?.owner);
                if (typeof admission.check !== "function" || !readCommittedGlobalGate) {
                    throw failure("wire_access_global_collection_store_required", 503);
                }
                checkNativeAdmission(admission);
                const before = await invoke(() => lifecycle.globalCollectionStatus());
                const committed = await readCommittedGlobalGate();
                const current = await invoke(() => lifecycle.globalCollectionStatus());
                checkNativeAdmission(admission);
                if (before.generation !== current.generation || before.authorizationRevision !== current.authorizationRevision
                    || JSON.stringify(current.globalCollection) !== JSON.stringify(committed)) {
                    throw failure("wire_access_global_collection_stale", 409);
                }
                return current;
            },
            async setGlobalCollectionEnabled(input, admission) {
                if (closed) throw failure("wire_access_closed", 409);
                object(input, ["schemaVersion", "enabled", "generation", "authorizationRevision", "expectedRevision"]);
                if (copilotOnly) return invoke(() => lifecycle.admitGlobalCollection(input, admission, (token, guarded) =>
                    exclusiveBoard(context, async (state, _save, saveGlobalCollection) => {
                        assertCopilotState(state);
                        await assertCollectorLockOwned(directory);
                        const check = () => {
                            checkNativeAdmission(guarded);
                            const stamp = lifecycle.assertGlobalCollectionAdmission(token);
                            if (stamp.owner !== admission.owner || stamp.expectedRevision !== input.expectedRevision
                                || stamp.paused !== !input.enabled) throw failure("wire_access_global_collection_stale", 409);
                        };
                        check();
                        guarded.dispatched();
                        return saveGlobalCollection({ expectedRevision: input.expectedRevision, paused: !input.enabled }, check);
                    })));
                if (typeof nativePersistence?.setGlobalCollectionGate !== "function") {
                    throw failure("wire_access_global_collection_store_required", 503);
                }
                return invoke(() => lifecycle.admitGlobalCollection(input, admission, (token, guarded) =>
                    nativePersistence.setGlobalCollectionGate({ expectedRevision: input.expectedRevision, paused: !input.enabled },
                        token, guarded)));
            },
        } : {}),
        ...(nativePersistence ? {
            ...(typeof nativePersistence.configureIntent === "function" ? {
                async nativeConfigurationOffer(admission) {
                    if (closed) throw failure("wire_access_closed", 409);
                    owner(admission?.owner);
                    if (typeof admission.check !== "function" || typeof nativePersistence.configurationOffer !== "function") {
                        throw failure("wire_access_native_request_admission_required", 503);
                    }
                    const check = () => checkNativeAdmission(admission);
                    check();
                    const offer = await invoke(() => nativePersistence.configurationOffer(Object.freeze({ ...admission, check })));
                    check();
                    if (offer.schemaVersion !== (sourceAware ? 2 : 1)) throw failure("wire_access_native_configuration_mode_mismatch", 503);
                    return offer;
                },
                async configureNativeIntent(input, admission) {
                    if (closed) throw failure("wire_access_closed", 409);
                    object(input, ["schemaVersion", "intent", "generation", "authorizationRevision", "expectedRevision", "surfaces", "windowDays",
                        ...(sourceAware ? ["globalRevision"] : [])]);
                    if (input.schemaVersion !== (sourceAware ? 2 : 1) || !["enable", "save"].includes(input.intent)
                        || typeof lifecycle.admitNativeConfiguration !== "function") {
                        throw failure("wire_access_invalid_request", 422);
                    }
                    return invoke(() => lifecycle.admitNativeConfiguration({
                        intent: input.intent, windowDays: input.windowDays,
                        ...(sourceAware ? { globalRevision: input.globalRevision } : {}),
                    }, admission, (token, guardedAdmission) => nativePersistence.configureIntent(input, token, guardedAdmission)));
                },
            } : {}),
            async nativePersistenceStatus(input = {}, admission) {
                if (closed) throw failure("wire_access_closed", 409);
                const hasOperation = input && Object.hasOwn(input, "operationId");
                object(input, hasOperation ? ["operationId"] : []);
                if (hasOperation && (typeof input.operationId !== "string" || !uuid.test(input.operationId))) {
                    throw failure("wire_access_invalid_request", 422);
                }
                owner(admission?.owner);
                if (typeof admission.check !== "function") throw failure("wire_access_native_request_admission_required", 503);
                checkNativeAdmission(admission);
                const status = await invoke(() => nativePersistence.status(input, { owner: admission.owner }));
                checkNativeAdmission(admission);
                if (!nativeAcquisition && status.kind === "native-screened-retention") return {
                    ...status, actions: status.actions.filter(action => action !== "collect-now"),
                    blockers: [...new Set([...status.blockers, "NATIVE_RETENTION_ACQUISITION_UNAVAILABLE"])],
                };
                if (status.kind === "native-screened-retention" && !status.blockers.length && nativeScheduler?.failed()) {
                    return { ...status, blockers: ["NATIVE_RETENTION_AUTOMATIC_STOPPED"] };
                }
                return status;
            },
            async configureNativeCollection(input, admission) {
                if (closed) throw failure("wire_access_closed", 409);
                if (sourceAware) throw failure("wire_access_native_configuration_mode_mismatch", 503);
                const configured = await invoke(() => nativePersistence.configure(input, admission));
                await invoke(() => lifecycle.updateCollection(async () => {
                    const committed = await readCommittedNativeSettings();
                    if (!committed) throw failure("wire_access_native_configuration_missing", 503);
                    return { paused: committed.paused, windowDays: committed.windowDays };
                }));
                return configured;
            },
            async collectNativeNow(input, admission) {
                if (closed) throw failure("wire_access_closed", 409);
                const hasDeadline = input && Object.hasOwn(input, "deadline"), receivedAt = Date.now();
                object(input, ["operationId", ...(input && Object.hasOwn(input, "expectedBasis") ? ["expectedBasis"] : []),
                    ...(hasDeadline ? ["deadline"] : [])]);
                if (typeof input.operationId !== "string" || !uuid.test(input.operationId)
                    || hasDeadline && (!Number.isSafeInteger(input.deadline) || input.deadline <= 0)) {
                    throw failure("wire_access_invalid_request", 422);
                }
                const deadline = Math.min(hasDeadline ? input.deadline : receivedAt + 300000, receivedAt + 300000);
                const { deadline: _deadline, ...registration } = input;
                if (!nativeAcquisition) {
                    owner(admission?.owner);
                    if (typeof admission.check !== "function") throw failure("wire_access_native_request_admission_required", 503);
                    checkNativeAdmission(admission);
                    throw failure("wire_access_native_writer_unqualified", 503);
                }
                if (nativeRunning) throw failure("wire_access_native_operation_pending", 409);
                nativeRunning = true;
                try {
                    const begin = sourceAware ? nativePersistence.beginSegmented : nativePersistence.begin;
                    const commit = sourceAware ? nativePersistence.commitSegmented : nativePersistence.commit;
                    if (typeof begin !== "function" || typeof commit !== "function") {
                        throw failure("wire_access_native_segmented_writer_required", 503);
                    }
                    const attempt = await coordinateNativeWrite(() => invoke(() => begin(registration, admission)));
                    if (["committed", "unresolved"].includes(attempt?.kind)) {
                        if (!attempt.receipt || attempt.receipt.operationId !== input.operationId
                            || (attempt.kind === "committed" ? attempt.receipt.status !== "committed"
                                : !["pending", "unknown"].includes(attempt.receipt.status))) {
                            throw failure("wire_access_native_receipt_required", 503);
                        }
                        return attempt.receipt;
                    }
                    if (attempt?.kind !== "acquire" || attempt.ticket?.lease?.kind !== "microsoft-read") {
                        throw failure("wire_access_native_ticket_required", 503);
                    }
                    let committed, acquired, failed = false;
                    let failureStage = "acquisition";
                    let firstFailure;
                    let firstProgress;
                    const recordFailure = async (error, stage, progress) => {
                        firstFailure ??= Object.freeze(nativeFailureDetails(error, stage));
                        firstProgress ??= progress;
                        try { await nativePersistence.recordFailure(attempt.ticket, firstFailure, firstProgress); }
                        catch (recordingError) {
                            console.error("[workiq-runtime] original native failure evidence unavailable", {
                                code: /^NATIVE_[A-Z_]+$/.test(recordingError?.code ?? "") ? recordingError.code : "NATIVE_FAILURE_RECORD_FAILED",
                            });
                        }
                    };
                    try {
                        await invoke(() => lifecycle.assertLease(attempt.ticket.lease));
                        admission.check();
                        if (Date.now() >= deadline) {
                            await invoke(() => lifecycle.expire(attempt.ticket.lease));
                            throw failure("NATIVE_SOURCE_DEADLINE", 409);
                        }
                        acquired = await acquireNative(attempt.ticket.lease, attempt.ticket.configuration,
                            (error, progress) => recordFailure(error, "acquisition", progress), attempt.ticket.backfill,
                            Object.freeze({ operationId: attempt.ticket.operationId, deadline }));
                        if (closed) throw failure("wire_access_closed", 409);
                        if (Date.now() >= deadline) {
                            await invoke(() => lifecycle.expire(attempt.ticket.lease));
                            throw failure("NATIVE_SOURCE_DEADLINE", 409);
                        }
                        failureStage = "commit";
                        const receipt = await coordinateNativeWrite(() => invoke(() => commit(attempt.ticket, acquired)));
                        if (receipt?.status !== "committed" || receipt.operationId !== input.operationId) {
                            throw failure("wire_access_native_receipt_required", 503);
                        }
                        committed = receipt;
                        if (nativeBackfillFor(acquired) && !completeNative) {
                            const comparison = await nativePersistence.compareCommittedSource(attempt.ticket, acquired);
                            await coordinateNativeWrite(() => nativePersistence.recordBackfill(attempt.ticket, acquired, comparison));
                        }
                        return receipt;
                    } catch (error) {
                        failed = true;
                        await recordFailure(error, failureStage, acquired);
                        throw error;
                    } finally {
                        let completionError, completionFailed = false;
                        try { await completeNative?.(attempt.ticket, committed, acquired,
                            comparison => coordinateNativeWrite(() => nativePersistence.recordBackfill(attempt.ticket, acquired, comparison))); }
                        catch (error) {
                            await recordFailure(error, "completion", acquired);
                            if (failed) console.error("[workiq-runtime] native completion failed", { code: "NATIVE_CAPTURE_COMPLETION_FAILED" });
                            else { completionFailed = true; completionError = error; }
                        }
                        try { await invoke(() => nativePersistence.retire(attempt.ticket)); }
                        catch (error) {
                            if (failed || completionFailed) console.error("[workiq-runtime] native retirement failed", { code: "NATIVE_CAPTURE_RETIREMENT_FAILED" });
                            else throw error;
                        }
                        if (completionFailed) throw completionError;
                        if (committed && !failed) nativeScheduler?.confirmed();
                    }
                } finally { nativeRunning = false; }
            },
        } : {}),
        ...(nativeRead ? {
            async nativeCollectionControl() {
                if (closed) throw failure("wire_access_closed", 409);
                const value = await invoke(() => lifecycle.status());
                const retained = value.authorization.retained;
                const connected = value.microsoft.state === "connected";
                return { kind: "native-read-only", enabled: value.collection === "enabled",
                    revision: value.authorizationRevision, retained, connected,
                    canPause: retained, canResume: retained && connected,
                    scope: "registered-native-read", writerAdmission: "withheld" };
            },
            async setNativeCollectionEnabled(input, admission) {
                if (closed) throw failure("wire_access_closed", 409);
                object(input, ["enabled", "expectedNativeRevision"]);
                await invoke(() => lifecycle.setNativeCollectionEnabled(input.enabled, input.expectedNativeRevision, admission));
            },
        } : {}),
        async assertRuntime(context, options) {
            if (closed || await realpath(resolveDataDir(context)) !== directory) throw failure("wire_access_store_mismatch", 422);
            if (!sourceAware && !copilotOnly && options.collector?.timers !== false) throw failure("wire_access_writer_integration_pending", 503);
            if (copilotOnly) await assertCopilotStore(context);
        },
        status,
        control() {
            if (closed || !control) throw failure("wire_access_control_unavailable", 503);
            return control;
        },
        subscribeControl(listener) {
            if (closed || !control) throw failure("wire_access_control_unavailable", 503);
            if (typeof listener !== "function") throw new TypeError("A control observer must be a function.");
            controlListeners.add(listener);
            try { listener(control); }
            catch (error) { controlListeners.delete(listener); throw error; }
            return () => controlListeners.delete(listener);
        },
        command(panelOwner, input, authorize) {
            owner(panelOwner);
            if (typeof authorize !== "function") throw failure("wire_access_command_unauthorized");
            object(input, ["schemaVersion", "action", "operationId", "generation"]);
            const allowed = ["wire-sign-in", "wire-sign-out", ...(nativeConnection
                ? ["microsoft-connect", "microsoft-cancel", "microsoft-recover"] : [])];
            if (closed || input.schemaVersion !== 1 || !allowed.includes(input.action)
                || typeof input.operationId !== "string" || !uuid.test(input.operationId)
                || !Number.isSafeInteger(input.generation) || input.generation < 0) {
                throw failure("wire_access_invalid_request", 422);
            }
            const { schemaVersion, ...operation } = input;
            return invoke(() => lifecycle.command(panelOwner, operation.action === "microsoft-connect"
                ? { ...operation, replace: false } : operation, authorize));
        },
        receipt(panelOwner, input) {
            owner(panelOwner);
            object(input, ["schemaVersion", "operationId"]);
            if (closed || input.schemaVersion !== 1 || typeof input.operationId !== "string"
                || !uuid.test(input.operationId)) throw failure("wire_access_invalid_request", 422);
            return invoke(() => lifecycle.receipt(panelOwner, input.operationId));
        },
        read,
        validateCollectionSource,
        async initializeCollection(context, config) {
            if (closed || await realpath(resolveDataDir(context)) !== directory) throw failure("wire_access_store_mismatch", 422);
            await validateCollectionSource(config);
            if (sourceAware || copilotOnly) return;
            await invoke(() => lifecycle.updateCollection({ paused: !config.enabled, windowDays: config.windowDays }));
        },
        async synchronizeCollection(config) {
            if (closed) throw failure("wire_access_closed", 409);
            await validateCollectionSource(config);
            if (sourceAware || copilotOnly) return;
            await invoke(() => lifecycle.updateCollection({ paused: !config.enabled, windowDays: config.windowDays }));
        },
        assertRoute(route, input, collectionBound = false) {
            if (collectionBound && (["/api/collection/now", "/api/collection/configure", "/api/collection/enabled"].includes(route)
                || route === "/api/canvas" && ["collect_now", "configure_collection", "set_collection_enabled"].includes(input?.action))) return;
            if (acquisitionRoutes.has(route) || route === "/api/canvas" && acquisitionActions.has(input?.action)) {
                throw failure("wire_access_writer_integration_pending", 503);
            }
        },
        subscribe(listener) {
            if (typeof listener !== "function") throw new TypeError("An access observer must be a function.");
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        collectionAvailable: () => !closed && collectionAllowed,
        manualCollectionAvailable: () => !closed && manualCollectionAllowed,
        subscribeCollection(listener) {
            if (typeof listener !== "function") throw new TypeError("A collection authorization observer must be a function.");
            collectionListeners.add(listener);
            return () => collectionListeners.delete(listener);
        },
        releaseOwner(panelOwner) {
            for (const item of active) if (item.panelOwner === panelOwner) {
                item.controller.abort(failure("wire_access_revoked")); active.delete(item);
            }
        },
        acquireCollectionLease(admission) {
            if (closed) throw failure("wire_access_closed", 409);
            if ((sourceAware || copilotOnly) && admission !== undefined) {
                owner(admission?.owner);
                if (typeof admission.check !== "function") throw failure("wire_access_native_request_admission_required", 503);
                const originalOwner = admission.owner;
                const check = () => {
                    if (closed || admission.owner !== originalOwner) throw failure("wire_access_revoked");
                    checkNativeAdmission(admission);
                };
                check();
                return invoke(async () => {
                    const lease = await lifecycle.lease("github-manual-acquisition");
                    check();
                    manualRequests.set(lease, check);
                    return lease;
                });
            }
            return invoke(() => lifecycle.lease("github-acquisition"));
        },
        assertCollectionLease(lease) {
            if (closed || !["github-acquisition", "github-manual-acquisition"].includes(lease?.kind)) throw failure("wire_access_invalid_lease");
            checkManualLease(lease);
            return invoke(() => lifecycle.assertLease(lease));
        },
        admitCollection(lease, work) {
            if (closed) throw failure("wire_access_closed", 409);
            if (!["github-acquisition", "github-manual-acquisition"].includes(lease?.kind)) throw failure("wire_access_invalid_lease");
            checkManualLease(lease);
            return admitWork(lifecycle, lease, () => {
                if (closed) throw failure("wire_access_closed", 409);
                checkManualLease(lease);
                return work();
            });
        },
        bindResponse(response, guard, runtimeId) {
            if (!ownedLeases.has(guard)) throw failure("wire_access_invalid_lease");
            if (response.destroyed || response.writableEnded) {
                guard.release();
                throw failure("wire_access_revoked");
            }
            const methods = ["writeHead", "flushHeaders", "write", "end"];
            const original = Object.fromEntries(methods.map(name => [name, response[name]]));
            for (const name of methods) response[name] = function (...args) {
                if (response.destroyed) return name === "write" ? false : response;
                return guard.publish(() => original[name].apply(this, args));
            };
            response.setHeader("X-Wire-Generation", String(guard.generation));
            if (runtimeId !== undefined) response.setHeader("X-Wire-Runtime", runtimeId);
            const abort = () => { if (response.headersSent) response.destroy(); };
            guard.signal.addEventListener("abort", abort, { once: true });
            const release = () => { guard.signal.removeEventListener("abort", abort); guard.release(); };
            response.once("close", release);
            response.once("finish", release);
            return () => {
                for (const name of methods) response[name] = original[name];
                response.removeHeader("X-Wire-Generation");
                response.removeHeader("X-Wire-Runtime");
                release();
            };
        },
        close() {
            if (closed) return;
            closed = true;
            void nativeScheduler?.close();
            nativeReader?.close();
            nativeViews?.close();
            unsubscribe();
            for (const listener of collectionListeners) listener();
            for (const item of active) item.controller.abort(failure("wire_access_revoked"));
            control = null;
            for (const listener of controlListeners) listener(null);
            controlListeners.clear();
            active.clear(); listeners.clear(); collectionListeners.clear();
            if (copilotOnly) return lifecycle.close();
        },
    });
    instances.add(api);
    return api;
}

export function assertRuntimeAccess(value) {
    if (!instances.has(value)) throw failure("wire_access_untrusted_binding", 422);
}
