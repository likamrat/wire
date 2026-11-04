// Serialized into the page; keep browser dependencies inside this function.
export function createBoardTransport(initialCapability, onSessionChanged = () => {}, accessBootstrap) {
    let capability = initialCapability;
    let connecting;
    const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    const collectionModeKeys = value => value && Object.hasOwn(value, "collectionMode") ? ["collectionMode"] : [];
    const validCollectionMode = value => !Object.hasOwn(value, "collectionMode")
        || value.mode === "enforced" && ["source-aware", "copilot-only"].includes(value.collectionMode);
    function descriptor(value) {
        return exact(value, value?.mode === "enforced"
            ? ["schemaVersion", "mode", "runtimeId", "maxWaitMs", "freshnessMs", ...collectionModeKeys(value)]
            : ["schemaVersion", "mode", "runtimeId"])
            && value.schemaVersion === 1 && uuid(value.runtimeId)
            && validCollectionMode(value)
            && (value.mode === "unbound" || value.mode === "enforced" && value.maxWaitMs === 1000 && value.freshnessMs === 5000);
    }
    let bootstrap = descriptor(accessBootstrap) ? { ...accessBootstrap } : null;
    let controlToken = bootstrap ? Object.freeze({}) : null;
    const controls = new Set(["/api/access/status", "/api/access/receipt", "/api/access/command", "/api/session/release"]);
    function unavailable() {
        const error = new Error("Private activity is unavailable until current WIRE access is confirmed. No action was started.");
        error.reason = "wire_access_unavailable"; error.code = "request_rejected";
        return error;
    }
    let epoch = 0, grant = null, observation = null, lastState = null, watch = null, watching = false, deadlineTimer, retryTimer;
    let clearanceFailed = false, lastReason = bootstrap ? "checking" : "invalid-bootstrap";
    const listeners = new Set(), retired = new Set(), calls = new Set();
    let token = bootstrap?.mode === "unbound" ? Object.freeze({}) : null;
    function accessState() {
        return Object.freeze({ mode: bootstrap?.mode ?? "unavailable", runtimeId: bootstrap?.runtimeId ?? null,
            ...(bootstrap?.collectionMode ? { collectionMode: bootstrap.collectionMode } : {}),
            readable: Boolean(token) && !clearanceFailed, epoch, reason: lastReason,
            state: observation ? Object.freeze({ ...observation }) : null });
    }
    function notify() {
        try { for (const listener of listeners) listener(accessState()); }
        catch (error) {
            clearanceFailed = true; token = null; grant = null; watching = false;
            lastReason = "clearance-failed";
            throw error;
        }
    }
    function withdraw(reason) {
        token = null; grant = null; epoch++; lastReason = clearanceFailed ? "clearance-failed" : reason;
        clearTimeout(deadlineTimer);
        try { notify(); }
        finally { for (const call of calls) if (!call.mutation) call.controller.abort(); }
    }
    function revokeAuthority() {
        if (grant) retired.add(grant.runtimeId + ":" + grant.generation);
        cancelWatch(); observation = null;
        withdraw("access-withdrawn");
        if (watching) queueMicrotask(pump);
    }
    function cancelWatch() {
        const previous = watch;
        watch = null;
        clearTimeout(previous?.timer);
        previous?.controller.abort();
    }
    function fresh() {
        if (grant && performance.now() >= grant.deadline) {
            cancelWatch();
            observation = null;
            withdraw("freshness-expired");
            if (watching) queueMicrotask(pump);
        }
        return Boolean(token) && !clearanceFailed;
    }
    function expireGrant() {
        if (fresh() && grant) deadlineTimer = setTimeout(expireGrant, Math.max(1, Math.ceil(grant.deadline - performance.now())));
    }
    const microsoftReasons = ["hooks-unqualified", "browser-unavailable", "browser-policy-blocked", "profile-contention",
            "wrong-account", "access-refused", "window-closed", "cancelled", "timed-out", "cleanup-failed",
            "restart-required", "storage-failed", "state-invalid", "transport-failed", "signed-out",
            "stale-generation", "busy", "invalid-request", "receipt-limit", "operation-conflict", "session-closed",
            "lease-invalid", "operation-owner", "reentrant-call", "authorization-listener-failed", "admission-failed",
        "command-unauthorized", "account-metadata-unavailable", "stale-collection-control"];
    const microsoftActions = ["microsoft-connect", "microsoft-cancel", "microsoft-recover"];
    function decodeMicrosoftConnection(value) {
        if (!exact(value, ["state", "reason", "actions"])
            || !["unavailable", "disconnected", "signing-in", "handoff", "connected", "reconnect-required", "recovery-required"].includes(value.state)
            || value.reason !== null && !microsoftReasons.includes(value.reason)
            || !Array.isArray(value.actions) || value.actions.length > 3 || new Set(value.actions).size !== value.actions.length
            || value.actions.some(action => !microsoftActions.includes(action))) {
            throw new TypeError("Microsoft connection controls have an invalid status.");
        }
        return Object.freeze({ state: value.state, reason: value.reason, actions: Object.freeze([...value.actions]) });
    }
    function decodeMicrosoftReceipt(value, operation) {
        if (!operation || !microsoftActions.includes(operation.action)
            || !exact(value, ["operationId", "action", "generation", "outcome", "reason", "revocation"])
            || !uuid(value.operationId) || value.operationId !== operation.id || value.action !== operation.action
            || !Number.isSafeInteger(operation.generation) || operation.generation < 0
            || !Number.isSafeInteger(value.generation) || value.generation <= operation.generation
            || !["pending", "completed", "failed", "cancelled", "ambiguous"].includes(value.outcome)
            || value.reason !== null && !microsoftReasons.includes(value.reason) || value.revocation !== null
            || value.outcome === "completed" && value.reason !== null) {
            throw new TypeError("The original Microsoft connection receipt is invalid.");
        }
        return Object.freeze({ ...value });
    }
    function sameMicrosoftConnection(a, b) {
        if (a === undefined || b === undefined) return a === b;
        return a.state === b.state && a.reason === b.reason && a.actions.length === b.actions.length
            && a.actions.every(action => b.actions.includes(action));
    }
    function validState(value) {
        return exact(value, ["schemaVersion", "mode", "runtimeId", "authorizationRevision", "generation", "wire", "retained",
            "collection", "maxWaitMs", "freshnessMs", ...collectionModeKeys(value),
            ...(value && Object.hasOwn(value, "microsoft") ? ["microsoft"] : [])])
            && value.schemaVersion === 1 && value.mode === "enforced"
            && validCollectionMode(value) && value.collectionMode === bootstrap?.collectionMode
            && uuid(value.runtimeId) && Number.isSafeInteger(value.authorizationRevision) && value.authorizationRevision >= 0
            && Number.isSafeInteger(value.generation) && value.generation >= 0 && typeof value.retained === "boolean"
            && ["signed-in", "signed-out"].includes(value.wire) && ["enabled", "paused"].includes(value.collection)
            && value.maxWaitMs === 1000 && value.freshnessMs === 5000
            && (!Object.hasOwn(value, "microsoft") || Boolean(decodeMicrosoftConnection(value.microsoft)));
    }
    async function pump() {
        if (!watching || watch || connecting || clearanceFailed || bootstrap?.mode !== "enforced") return;
        const current = { controller: new AbortController(), startedAt: performance.now(), capability, epoch };
        watch = current;
        current.timer = setTimeout(() => {
            if (watch !== current) return;
            cancelWatch(); observation = null; withdraw("watch-timeout");
            void recoverWatch();
        }, 5000);
        try {
            const response = await fetch("/api/access/watch", {
                method: "POST", credentials: "same-origin",
                headers: { "X-Board-Capability": capability, "Content-Type": "application/json" },
                body: JSON.stringify({ schemaVersion: 1, after: observation
                    ? { runtimeId: observation.runtimeId, authorizationRevision: observation.authorizationRevision } : null }),
                signal: current.controller.signal,
            });
            const value = await response.json();
            if (watch !== current || current.capability !== capability || current.epoch !== epoch || !watching) return;
            fresh();
            if (watch !== current) return;
            if (!response.ok || performance.now() >= current.startedAt + 5000 || !validState(value)
                || value.runtimeId !== bootstrap.runtimeId || lastState && (value.authorizationRevision < lastState.authorizationRevision
                    || value.generation < lastState.generation
                    || value.authorizationRevision === lastState.authorizationRevision
                        && [...new Set([...Object.keys(value), ...Object.keys(lastState)])].some(key => key === "microsoft"
                            ? !sameMicrosoftConnection(value.microsoft, lastState.microsoft) : value[key] !== lastState[key]))) {
                throw new Error("Current WIRE access could not be confirmed.");
            }
            clearTimeout(current.timer);
            watch = null;
            const key = value.runtimeId + ":" + value.generation;
            if (value.retained && retired.has(key)) throw new Error("Retired WIRE access cannot be restored.");
            if (lastState?.retained && (!value.retained || value.generation !== lastState.generation)) {
                retired.add(lastState.runtimeId + ":" + lastState.generation);
            }
            if (grant && (!value.retained || value.generation !== grant.generation)) {
                retired.add(grant.runtimeId + ":" + grant.generation);
                withdraw(value.retained ? "generation-changed" : "access-withdrawn");
            }
            observation = lastState = { ...value, ...(Object.hasOwn(value, "microsoft")
                ? { microsoft: decodeMicrosoftConnection(value.microsoft) } : {}) };
            if (value.retained) {
                grant = { runtimeId: value.runtimeId, generation: value.generation, deadline: current.startedAt + 5000 };
                token ??= Object.freeze({ epoch, runtimeId: value.runtimeId, generation: value.generation });
                lastReason = "ready";
                clearTimeout(deadlineTimer);
                deadlineTimer = setTimeout(expireGrant, Math.max(1, Math.ceil(grant.deadline - performance.now())));
                notify();
            } else {
                lastReason = "access-withdrawn";
                notify();
            }
            queueMicrotask(pump);
        } catch (error) {
            clearTimeout(current.timer);
            if (clearanceFailed) { console.error("WIRE private-content clearance failed.", error); return; }
            if (current.controller.signal.aborted || !watching) return;
            watch = null; observation = null;
            withdraw("watch-unavailable");
            void recoverWatch();
        }
    }
    async function recoverWatch() {
        if (!watching || clearanceFailed) return;
        try { await reconnect(capability); }
        catch (error) {
            if (clearanceFailed) { console.error("WIRE private-content clearance failed.", error); return; }
            lastReason = "connection-unavailable";
            notify();
            scheduleRecovery();
            return;
        }
        if (watching) queueMicrotask(pump);
    }
    function scheduleRecovery() {
        if (!watching || clearanceFailed || bootstrap?.mode !== "enforced") return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; void recoverWatch(); }, 1000);
    }
    const readOnly = new Set(["/api/access/status", "/api/access/receipt", "/api/profile/github", "/api/profile/microsoft", "/api/state", "/api/analytics", "/api/snapshot", "/api/refresh", "/api/collection/status", "/api/record/status", "/api/deletion/status",
        "/api/collection/sources/status", "/api/collection/microsoft/status", "/api/collection/microsoft/enrollment",
        "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent", "/api/assessment/evidence", "/api/assessment/mutation/status",
        "/api/evaluation/setup", "/api/evaluation/status",
        "/api/evaluation/automatic/setup", "/api/evaluation/automatic/summary", "/api/evaluation/automatic/status",
        "/api/report-comparison/inspect", "/api/report-comparison/open", "/api/report/open", "/api/report-original", "/api/artifact-file", "/api/report-artifacts/list", "/api/artifact-deletion/status",
        "/api/recollection/sources", "/api/recollection/status", "/api/period-comparison",
        "/api/search/query", "/api/search/status", "/api/search/open", "/api/search/cancel", "/api/search/close"]);
    const nativeReadPaths = ["/api/retained/microsoft/query", "/api/retained/microsoft/detail", "/api/retained/microsoft/search",
        "/api/retained/microsoft/readback", "/api/retained/microsoft/inventory", "/api/retained/microsoft/drilldown",
        "/api/retained/microsoft/analyze"];
    for (const path of nativeReadPaths) readOnly.add(path);
    readOnly.add("/api/artifact-deletion/eligibility");
    const searchPaths = new Set(["/api/search/query", "/api/search/status", "/api/search/open", "/api/search/cancel", "/api/search/close", "/api/search/events",
        "/api/artifact-deletion/eligibility", ...nativeReadPaths]);
    function stale(call) {
        if (!call.dispatched) return unavailable();
        const error = new Error(call.mutation
            ? "WIRE access changed after this action was sent. Its outcome is unknown. Check the original receipt after access is restored; do not repeat it."
            : "This private read was retired. Read the current view after WIRE access is restored.");
        error.reason = "wire_access_stale";
        if (call.mutation) { error.code = "request_outcome_unknown"; error.outcome = "unknown"; }
        return error;
    }
    function check(call) {
        if (call && (!fresh() || call.token !== token)) throw stale(call);
    }
    function begin(path) {
        if (controls.has(path)) return null;
        if (!fresh()) throw unavailable();
        const call = { token, dispatched: false, mutation: !readOnly.has(path) && path !== "/api/search/events",
            controller: new AbortController() };
        calls.add(call);
        return call;
    }
    function controlFailure(call) {
        const error = new Error(call.dispatched
            ? "The original panel connection was lost. This control operation was not replayed; its original outcome may remain unknown."
            : "The original panel connection no longer owns this control operation. Nothing was sent.");
        error.reason = "wire_control_stale";
        if (call.dispatched && call.mutation) { error.code = "request_outcome_unknown"; error.outcome = "unknown"; }
        else if (!call.dispatched) error.code = "request_rejected";
        return error;
    }
    function checkControl(call) {
        if (call && (!call.token || call.token !== controlToken)) throw controlFailure(call);
    }
    async function request(path, input, currentCapability, options = {}, call = null, control = null) {
        if (options.signal && !searchPaths.has(path)) throw new TypeError("Caller cancellation is limited to owned search requests.");
        const timeout = path === "/api/search/events" ? null : AbortSignal.timeout(path === "/api/search/open" ? 30000
            : ["/api/import", "/api/preview", "/api/collection/configure", "/api/collection/now", "/api/deletion/preview", "/api/deletion/confirm",
                "/api/collection/microsoft/configure", "/api/collection/microsoft/now",
                "/api/assessment/consent/set", "/api/report-comparison/preview", "/api/report-comparison/save", "/api/artifact-deletion/preview", "/api/artifact-deletion/confirm",
                "/api/recollection/preview", "/api/recollection/confirm", "/api/evaluation/automatic/revoke"].includes(path) ? 120000 : 10000);
        const bodyText = input === undefined ? undefined : JSON.stringify(input);
        const signal = AbortSignal.any([options.signal, call?.controller.signal, timeout].filter(Boolean));
        check(call);
        checkControl(control);
        let response;
        if (call) call.dispatched = true;
        if (control) control.dispatched = true;
        try { response = await fetch(path, {
            method: input === undefined ? "GET" : "POST",
            headers: {
                ...(currentCapability ? { "X-Board-Capability": currentCapability } : {}),
                ...(input === undefined ? {} : { "Content-Type": "application/json" }),
                ...(path === "/api/session" ? { "X-Wire-Session-Protocol": "1" } : {}),
            },
            credentials: "same-origin",
            signal,
            ...(input === undefined ? {} : { body: bodyText }),
        }); } catch {
            check(call);
            checkControl(control);
            if (options.signal?.aborted) {
                const error = new Error("Local search was cancelled."); error.reason = "search_cancelled"; throw error;
            }
            const mutation = call?.mutation || path === "/api/access/command";
            const error = new Error(mutation
                ? "WIRE did not respond. The action may have completed; check its result instead of repeating it."
                : "WIRE did not respond. Check that WIRE is running, then read this view again.");
            error.reason = "runtime_unavailable";
            if (mutation) { error.code = "request_outcome_unknown"; error.outcome = "unknown"; }
            throw error;
        }
        check(call);
        checkControl(control);
        if (call && bootstrap?.mode === "enforced" && response.ok
            && (response.headers.get("X-Wire-Runtime") !== call.token.runtimeId
                || response.headers.get("X-Wire-Generation") !== String(call.token.generation))) {
            cancelWatch(); observation = null;
            withdraw("response-authority-changed");
            if (watching) queueMicrotask(pump);
            throw stale(call);
        }
        if (path === "/api/search/events" && response.ok) return { response };
        let body;
        try { body = await response.json(); }
        catch {
            check(call);
            checkControl(control);
            const mutation = call?.mutation || path === "/api/access/command";
            const error = new Error(mutation
                ? "WIRE could not read the response. The action may have completed; check its result instead of repeating it."
                : "WIRE could not read the response. Read this view again; no action was repeated.");
            error.reason = "invalid_response";
            if (mutation) { error.code = "request_outcome_unknown"; error.outcome = "unknown"; }
            throw error;
        }
        check(call);
        checkControl(control);
        return { response, body };
    }
    async function reconnect(previous) {
        if (capability !== previous) return;
        if (!connecting) {
            const legacyToken = bootstrap?.mode === "unbound" ? token : null;
            controlToken = null;
            cancelWatch(); observation = null;
            if (bootstrap?.mode !== "unbound") withdraw("connection-changed");
            connecting = (async () => {
                const { response, body } = await request("/api/session", {}, undefined);
                if (!response.ok && body?.code === "WIRE_CLIENT_UPDATE_REQUIRED") {
                    throw Object.assign(new Error(body.error), { code: body.code, reason: "client-update-required" });
                }
                if (!response.ok || !exact(body, ["capability", "runtimeId", "accessBootstrap"])
                    || typeof body.capability !== "string" || !/^[a-f0-9]{64}$/.test(body.capability)
                    || !descriptor(body.accessBootstrap) || body.runtimeId !== body.accessBootstrap.runtimeId
                    || bootstrap?.mode === "enforced" && body.accessBootstrap.mode !== "enforced"
                    || bootstrap?.collectionMode === "source-aware" && body.accessBootstrap.collectionMode !== "source-aware"
                    || body.runtimeId === bootstrap?.runtimeId && (body.accessBootstrap.mode !== bootstrap.mode
                        || body.accessBootstrap.collectionMode !== bootstrap.collectionMode)) {
                    throw new Error("Local connection could not be renewed. No action was replayed.");
                }
                if (body.runtimeId !== bootstrap?.runtimeId) lastState = null;
                capability = body.capability;
                controlToken = Object.freeze({});
                if (bootstrap?.mode === "unbound") epoch++;
                bootstrap = { ...body.accessBootstrap };
                // Unbound continuity is presentation lifetime only, never an old runtime identity.
                token = bootstrap.mode === "unbound" && legacyToken ? legacyToken : null;
                onSessionChanged();
                notify();
            })().finally(() => { connecting = undefined; });
        }
        try { await connecting; }
        catch (error) { scheduleRecovery(); throw error; }
        if (watching) queueMicrotask(pump);
    }
    const api = async function api(path, input, options = {}) {
        if (Object.hasOwn(options, "controlToken") && !controls.has(path)) throw new TypeError("Original-owner tokens are limited to safe control operations.");
        const control = Object.hasOwn(options, "controlToken")
            ? { token: options.controlToken, dispatched: false, mutation: path === "/api/access/command" } : null;
        checkControl(control);
        const call = begin(path);
        try {
            const previous = capability, legacy = bootstrap?.mode === "unbound";
            let result = await request(path, input, previous, options, call, control);
            if (controls.has(path) && previous !== capability) {
                const error = new Error("The original panel connection changed. This control result cannot be adopted by the replacement connection.");
                error.reason = "wire_access_stale";
                if (path === "/api/access/command") { error.code = "request_outcome_unknown"; error.outcome = "unknown"; }
                throw error;
            }
            if (result.response.status === 403 && result.body?.code === "session_expired") {
                try { await reconnect(previous); }
                catch (error) {
                    if (control) throw controlFailure(control);
                    if (call && !legacy) throw stale(call);
                    throw error;
                }
                if (control) throw controlFailure(control);
                if (call && (!legacy || bootstrap.mode !== "unbound")) throw stale(call);
                if (!readOnly.has(path) || path === "/api/access/receipt") {
                    const error = new Error("The local connection changed. This action was not replayed. Read current state and prepare a new review before trying again.");
                    error.code = "request_rejected";
                    throw error;
                }
                if (call) call.token = token;
                result = await request(path, input, capability, options, call);
            }
            if (call && !legacy && ["wire_access_revoked", "wire_access_outcome_unknown"].includes(result.body?.code)) {
                revokeAuthority();
                throw stale(call);
            }
            if (!result.response.ok) {
                const staleCollectionRead = readOnly.has(path) && result.response.status === 409
                    && result.body?.code === "wire_access_global_collection_stale";
                const error = new Error(staleCollectionRead
                    ? "Collection status changed while it was being read. Read current settings; no connection or collection action will be repeated."
                    : result.body?.error || `Local request failed (${result.response.status}).`);
                error.status = result.response.status;
                error.reason = result.body?.code ?? null;
                const refusal = result.body?.reportSave;
                if (path === "/api/export" && refusal && Object.getPrototypeOf(refusal) === Object.prototype
                    && Object.keys(refusal).sort().join(",") === "bundleId,kind,outcome,previewId"
                    && refusal.outcome === "not-published" && refusal.kind === "report"
                    && refusal.previewId === input?.previewId && typeof refusal.previewId === "string"
                    && /^export-[a-f0-9-]{36}$/.test(refusal.bundleId)
                    && result.body?.outcome !== "unknown") error.reportSave = { ...refusal };
                if (result.body?.outcome === "unknown" || result.body?.code === "wire_access_outcome_unknown") {
                    error.code = "request_outcome_unknown";
                    error.outcome = "unknown";
                } else if ([400, 403, 415, 422].includes(result.response.status)) error.code = "request_rejected";
                throw error;
            }
            return result.body;
        } finally { if (call) calls.delete(call); }
    };
    api.searchEvents = async function (onEvent, { signal, schemaVersion }) {
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new TypeError("Search streaming requires the current contract version.");
        const call = begin("/api/search/events"), previous = capability, legacy = bootstrap?.mode === "unbound";
        try {
            let result = await request("/api/search/events", { schemaVersion }, previous, { signal }, call);
            if (result.response.status === 403 && result.body?.code === "session_expired") {
                try { await reconnect(previous); }
                catch (error) { if (!legacy) throw stale(call); throw error; }
                if (!legacy || bootstrap.mode !== "unbound") throw stale(call);
                if (signal.aborted) return;
                call.token = token;
                result = await request("/api/search/events", { schemaVersion }, capability, { signal }, call);
            }
            if (!result.response.ok) {
                if (!legacy && ["wire_access_revoked", "wire_access_outcome_unknown"].includes(result.body?.code)) {
                    revokeAuthority();
                    throw stale(call);
                }
                const error = new Error(result.body?.error || "Local search could not connect.");
                error.reason = result.body?.code ?? "search_unavailable";
                throw error;
            }
            const reader = result.response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
            let buffer = "";
            try {
                while (!signal.aborted) {
                    const { value, done } = await reader.read();
                    check(call);
                    if (signal.aborted) return;
                    if (done) {
                        decoder.decode();
                        if (buffer.trim()) throw new Error("Local search returned an incomplete event.");
                        const error = new Error("Local search disconnected. Results were cleared.");
                        error.reason = "search-stream-ended";
                        throw error;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    if (buffer.length > 64 * 1024 * 1024) throw new Error("Local search response exceeded its read limit.");
                    let end;
                    while ((end = buffer.indexOf("\n")) !== -1) {
                        check(call);
                        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                        let event;
                        try { event = JSON.parse(line); } catch { throw new Error("Local search returned an unreadable event."); }
                        check(call);
                        if (!signal.aborted) onEvent(event);
                    }
                }
            } finally { buffer = ""; await reader.cancel(); reader.releaseLock(); }
        } finally { calls.delete(call); }
    };
    api.publicationToken = () => fresh() ? token : null;
    api.isCurrent = value => Boolean(value) && fresh() && value === token;
    api.accessState = () => { fresh(); return accessState(); };
    api.decodeMicrosoftConnection = decodeMicrosoftConnection;
    api.decodeMicrosoftReceipt = decodeMicrosoftReceipt;
    api.controlToken = () => controlToken;
    api.isControlCurrent = value => Boolean(value) && value === controlToken;
    api.subscribeAccess = listener => {
        listeners.add(listener);
        try { listener(accessState()); }
        catch (error) {
            clearanceFailed = true; token = null; grant = null; watching = false; lastReason = "clearance-failed";
            cancelWatch(); clearTimeout(deadlineTimer);
            for (const call of calls) if (!call.mutation) call.controller.abort();
            throw error;
        }
        return () => listeners.delete(listener);
    };
    api.startAccess = () => { watching = true; clearTimeout(retryTimer); void pump(); };
    api.suspendAccess = () => {
        watching = false; clearTimeout(retryTimer); cancelWatch(); observation = null;
        if (bootstrap?.mode !== "unbound") withdraw("suspended");
    };
    return api;
}
