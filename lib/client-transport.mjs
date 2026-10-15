// Serialized into the page; keep browser dependencies inside this function.
export function createBoardTransport(initialCapability, onSessionChanged = () => {}) {
    let capability = initialCapability;
    let connecting;
    const readOnly = new Set(["/api/state", "/api/analytics", "/api/snapshot", "/api/refresh", "/api/collection/status", "/api/record/status", "/api/deletion/status",
        "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent", "/api/assessment/evidence", "/api/assessment/mutation/status",
        "/api/evaluation/setup", "/api/evaluation/status",
        "/api/evaluation/automatic/setup", "/api/evaluation/automatic/summary", "/api/evaluation/automatic/status",
        "/api/report-comparison/inspect", "/api/report-comparison/open", "/api/report/open", "/api/artifact-file", "/api/report-artifacts/list", "/api/artifact-deletion/status",
        "/api/recollection/sources", "/api/recollection/status", "/api/period-comparison",
        "/api/search/query", "/api/search/status", "/api/search/open", "/api/search/cancel", "/api/search/close"]);
    const searchPaths = new Set(["/api/search/query", "/api/search/status", "/api/search/open", "/api/search/cancel", "/api/search/close", "/api/search/events"]);
    async function request(path, input, currentCapability, options = {}) {
        if (options.signal && !searchPaths.has(path)) throw new TypeError("Caller cancellation is limited to owned search requests.");
        const timeout = path === "/api/search/events" ? null : AbortSignal.timeout(path === "/api/search/open" ? 30000
            : ["/api/import", "/api/preview", "/api/collection/configure", "/api/collection/now", "/api/deletion/preview", "/api/deletion/confirm",
                "/api/assessment/consent/set", "/api/report-comparison/preview", "/api/report-comparison/save", "/api/artifact-deletion/preview", "/api/artifact-deletion/confirm",
                "/api/recollection/preview", "/api/recollection/confirm", "/api/evaluation/automatic/revoke"].includes(path) ? 120000 : 10000);
        let response;
        try { response = await fetch(path, {
            method: input === undefined ? "GET" : "POST",
            headers: {
                ...(currentCapability ? { "X-Board-Capability": currentCapability } : {}),
                ...(input === undefined ? {} : { "Content-Type": "application/json" }),
            },
            credentials: "same-origin",
            signal: AbortSignal.any([options.signal, timeout].filter(Boolean)),
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        }); } catch {
            if (options.signal?.aborted) {
                const error = new Error("Local search was cancelled."); error.reason = "search_cancelled"; throw error;
            }
            const error = new Error("The local runtime could not be reached or timed out. Start WIRE if it is stopped, then retry. No action was replayed.");
            error.reason = "runtime_unavailable";
            throw error;
        }
        if (path === "/api/search/events" && response.ok) return { response };
        let body;
        try { body = await response.json(); }
        catch {
            const error = new Error("The local runtime returned an unreadable response. Retry reading the view; no action was replayed.");
            error.reason = "invalid_response";
            throw error;
        }
        return { response, body };
    }
    async function reconnect(previous) {
        if (capability !== previous) return;
        if (!connecting) {
            connecting = (async () => {
                const { response, body } = await request("/api/session", {}, undefined);
                if (!response.ok || typeof body.capability !== "string" || !/^[a-f0-9]{64}$/.test(body.capability)) {
                    throw new Error("Local connection could not be renewed. No action was replayed.");
                }
                capability = body.capability;
                onSessionChanged();
            })().finally(() => { connecting = undefined; });
        }
        await connecting;
    }
    const api = async function api(path, input, options = {}) {
        const previous = capability;
        let result = await request(path, input, previous, options);
        if (result.response.status === 403 && result.body.code === "session_expired") {
            await reconnect(previous);
            if (!readOnly.has(path)) {
                const error = new Error("The local connection changed. This action was not replayed. Read current state and prepare a new review before trying again.");
                error.code = "request_rejected";
                throw error;
            }
            result = await request(path, input, capability, options);
        }
        if (!result.response.ok) {
            const error = new Error(result.body.error || `Local request failed (${result.response.status}).`);
            error.status = result.response.status;
            error.reason = result.body.code ?? null;
            // Only validation/auth rejections establish that dispatch did not begin.
            if ([400, 403, 415, 422].includes(result.response.status)) error.code = "request_rejected";
            throw error;
        }
        return result.body;
    };
    api.searchEvents = async function (onEvent, { signal, schemaVersion }) {
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new TypeError("Search streaming requires the current contract version.");
        const previous = capability;
        let result = await request("/api/search/events", { schemaVersion }, previous, { signal });
        if (result.response.status === 403 && result.body?.code === "session_expired") {
            await reconnect(previous);
            if (signal.aborted) return;
            result = await request("/api/search/events", { schemaVersion }, capability, { signal });
        }
        if (!result.response.ok) {
            const error = new Error(result.body?.error || "Local search could not connect.");
            error.reason = result.body?.code ?? "search_unavailable";
            throw error;
        }
        const reader = result.response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "";
        try {
            while (!signal.aborted) {
                const { value, done } = await reader.read();
                if (done) throw new Error("Local search disconnected. Results were cleared.");
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 64 * 1024 * 1024) throw new Error("Local search response exceeded its read limit.");
                let end;
                while ((end = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                    let event;
                    try { event = JSON.parse(line); } catch { throw new Error("Local search returned an unreadable event."); }
                    if (!signal.aborted) onEvent(event);
                }
            }
        } finally { buffer = ""; await reader.cancel(); reader.releaseLock(); }
    };
    return api;
}
