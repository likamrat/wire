import { isHistoryEngineering } from "./microsoft-history-engineering.mjs";

const kinds = Object.freeze({
    identity: ["cowork-detail"],
    "native-connect": ["principal", "chat-list", "chat-list-next", "routing", "cowork-list", "cowork-list-next"],
    "native-collection-bootstrap": ["principal"],
    "chat-discovery": ["chat-list", "chat-list-next"],
    "cowork-discovery": ["routing", "cowork-list", "cowork-list-next"],
    "cowork-membership": ["routing", "cowork-automations", "cowork-automations-next",
        "cowork-schedule", "cowork-schedule-next", "cowork-trigger", "cowork-trigger-next", "cowork-list", "cowork-list-next"],
    cowork: ["cowork-detail", "cowork-messages", "cowork-messages-next"],
    chat: ["chat"],
    "native-engineering": ["principal", "principal-next", "context", "context-next", "routing", "routing-next", "chat-list", "chat-list-next", "cowork-list", "cowork-list-next"],
});

function failure(code) {
    return Object.assign(new Error(code), { code });
}

// This observes only the owner's original requests. It never fetches, retries,
// reads headers/bodies, chooses a source, or establishes account identity.
export function createMicrosoftNativeRequestObserver({ lifecycle, engineering = null }) {
    if (["assertLease", "admit", "subscribeAuthorizationChange"].some(key => typeof lifecycle?.[key] !== "function")) {
        throw failure("NATIVE_REQUEST_LIFECYCLE_REQUIRED");
    }
    if (engineering !== null && !isHistoryEngineering(engineering)) throw failure("NATIVE_REQUEST_LIFECYCLE_REQUIRED");
    const observed = new WeakMap(), records = new Map(), selections = new Map(), begun = new Map();
    let current = null, epoch = 0, closed = false, authorization;
    const block = () => { current = null; epoch++; };
    const unsubscribe = lifecycle.subscribeAuthorizationChange(event => {
        authorization = event;
        if (current?.lease && (!event.microsoftAcquisition || event.generation !== current.lease.generation)) block();
    });

    function assertPhase(phase) {
        if (closed || !phase || phase !== current || phase.signal?.aborted
            || phase.lease && (!authorization.microsoftAcquisition || authorization.generation !== phase.lease.generation)) {
            throw failure("NATIVE_REQUEST_PHASE_RETIRED");
        }
        if (phase.engineering) engineering.assertCurrent();
    }
    function entryFor(request) {
        const entry = observed.get(request);
        if (!entry?.record) throw failure("NATIVE_REQUEST_NOT_DISPATCHED");
        return entry;
    }
    async function assertCurrent(request) {
        const entry = entryFor(request);
        assertPhase(entry.phase);
        if (entry.record.network === "failed") throw failure("NATIVE_ORIGINAL_REQUEST_FAILED");
        if (entry.phase.lease) await lifecycle.assertLease(entry.phase.lease);
        assertPhase(entry.phase);
        if (entry.record.network === "failed") throw failure("NATIVE_ORIGINAL_REQUEST_FAILED");
        return entry;
    }
    return Object.freeze({
        async beginPhase(name, { lease, signal, iteration = 0, engineering: authority } = {}) {
            const investigation = name === "native-engineering";
            if (closed || !Object.hasOwn(kinds, name) || !Number.isSafeInteger(iteration) || iteration < 0 || iteration >= 32
                || iteration !== (begun.get(name) ?? -1) + 1
                || ["identity", "native-connect", "native-engineering"].includes(name) && iteration !== 0
                || investigation && (!engineering || authority !== engineering)
                || (["identity", "native-connect", "native-engineering"].includes(name) ? lease !== undefined || !signal
                    : lease?.kind !== "microsoft-read")) throw failure("NATIVE_REQUEST_PHASE_INVALID");
            block();
            const started = epoch;
            begun.set(name, iteration);
            if (lease) await lifecycle.assertLease(lease);
            if (closed || started !== epoch || signal?.aborted) throw failure("NATIVE_REQUEST_PHASE_RETIRED");
            const phase = Object.freeze({ name, lease, signal, epoch: started, engineering: investigation });
            current = phase;
            assertPhase(phase);
        },
        block,
        observe(request, kind, onRejected) {
            const reject = reason => { onRejected?.(reason); return false; };
            const paged = /^(chat-list|cowork-list|cowork-messages|cowork-automations|cowork-schedule|cowork-trigger|context|routing)-page-([3-9]|1[0-6])$/.exec(kind);
            const allowed = current?.name === "native-connect" && engineering ? kinds["native-engineering"] : kinds[current?.name];
            if (closed) return reject("request-observer-closed");
            if (!current) return reject("request-observer-no-phase");
            if (!(kinds[current.name].includes(kind) || allowed.includes(kind) || paged && allowed.includes(paged[1]))) {
                return reject("request-observer-kind");
            }
            if (observed.has(request)) return reject("request-observer-duplicate");
            assertPhase(current);
            const key = `${current.name}:${kind}:${current.epoch}`;
            selections.set(key, Math.min(Number.MAX_SAFE_INTEGER, (selections.get(key) ?? 0) + 1));
            observed.set(request, { phase: current, kind, record: null });
            return true;
        },
        async continueOriginal(request, work) {
            const entry = observed.get(request);
            if (!entry || typeof work !== "function") throw failure("NATIVE_REQUEST_NOT_OBSERVED");
            assertPhase(entry.phase);
            const key = `${entry.phase.name}:${entry.kind}:${entry.phase.epoch}`;
            if (records.has(key)) throw failure("NATIVE_ORIGINAL_REQUEST_ALREADY_CONSUMED");
            const record = {
                phase: entry.phase.name, kind: entry.kind,
                continuation: "not-started", responseObserved: false, network: "pending",
                bodyComplete: false, acceptance: "pending", failure: null,
            };
            entry.record = record;
            records.set(key, record);
            entry.continued = (async () => {
                try {
                    await assertCurrent(request);
                    let continuation;
                    const start = () => {
                        assertPhase(entry.phase);
                        if (record.network === "failed") throw failure("NATIVE_ORIGINAL_REQUEST_FAILED");
                        record.continuation = "pending";
                        // Admit only the irreversible start, not its network wait.
                        continuation = (async () => {
                            try { await work(); return null; }
                            catch { return failure("NATIVE_ORIGINAL_CONTINUATION_FAILED"); }
                        })();
                    };
                    if (entry.phase.lease) await lifecycle.admit(entry.phase.lease, start);
                    else start();
                    const continuationError = await continuation;
                    if (continuationError) {
                        record.continuation = "failed";
                        throw continuationError;
                    }
                    record.continuation = "completed";
                    return null;
                } catch (error) {
                    record.failure = record.continuation === "failed" ? "continuation-failed" : "dispatch-denied";
                    return error;
                }
            })();
            const error = await entry.continued;
            if (error) throw error;
        },
        response(request) {
            const entry = observed.get(request);
            if (!entry?.record || entry.record.continuation === "not-started") return null;
            entry.record.responseObserved = true;
            return Object.freeze({ phase: entry.phase.name, kind: entry.kind });
        },
        async assertCurrent(request) {
            await assertCurrent(request);
        },
        bodyComplete(request) {
            const entry = entryFor(request);
            if (!entry.record.responseObserved) throw failure("NATIVE_ORIGINAL_RESPONSE_NOT_OBSERVED");
            entry.record.bodyComplete = true;
            assertPhase(entry.phase);
        },
        async accept(request, publish) {
            const entry = entryFor(request);
            try {
                const continued = await entry.continued;
                if (continued) throw continued;
                await assertCurrent(request);
                if (!entry.record.bodyComplete || entry.record.acceptance !== "pending" || entry.record.failure
                    || entry.record.continuation !== "completed"
                    || typeof publish !== "function") throw failure("NATIVE_ORIGINAL_ACCEPTANCE_INVALID");
                const commit = () => {
                    assertPhase(entry.phase);
                    if (entry.record.network === "failed" || entry.record.failure || entry.record.acceptance !== "pending") {
                        throw failure("NATIVE_ORIGINAL_ACCEPTANCE_INVALID");
                    }
                    const value = publish();
                    if (value && typeof value.then === "function") {
                        Promise.resolve(value).catch(() => {});
                        throw failure("NATIVE_ORIGINAL_PUBLICATION_MUST_BE_SYNCHRONOUS");
                    }
                    entry.record.acceptance = "accepted";
                    return value;
                };
                return entry.phase.lease ? await lifecycle.admit(entry.phase.lease, commit) : commit();
            } catch (error) {
                if (entry.record.acceptance !== "accepted") {
                    entry.record.acceptance = "failed";
                    entry.record.failure ??= "acceptance-failed";
                }
                throw error;
            }
        },
        requestFinished(request) {
            const entry = observed.get(request);
            if (entry?.record && entry.record.network !== "failed") entry.record.network = "finished";
        },
        requestFailed(request) {
            const entry = observed.get(request);
            if (entry?.record) {
                entry.record.network = "failed";
                entry.record.failure = "original-request-failed";
                return true;
            }
            return false;
        },
        readFailed(request) {
            const entry = observed.get(request);
            if (entry?.record) {
                entry.record.acceptance = "failed";
                entry.record.failure ??= "source-read-failed";
            }
        },
        snapshot() {
            return {
                selections: [...selections].map(([key, count]) => {
                    const [phase, kind] = key.split(":");
                    return { phase, kind, count };
                }),
                requests: [...records.values()].map(record => ({ ...record })),
            };
        },
        close() {
            if (closed) return;
            closed = true;
            block();
            unsubscribe();
        },
    });
}
