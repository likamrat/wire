// Serialized into the page; keep browser dependencies inside this function.
export function createBoardTransport(initialCapability, onSessionChanged = () => {}) {
    let capability = initialCapability;
    let connecting;
    const readOnly = new Set(["/api/state", "/api/analytics", "/api/snapshot", "/api/refresh", "/api/collection/status", "/api/record/status", "/api/deletion/status",
        "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent", "/api/assessment/evidence", "/api/assessment/mutation/status",
        "/api/evaluation/setup", "/api/evaluation/status",
        "/api/evaluation/automatic/setup", "/api/evaluation/automatic/summary", "/api/evaluation/automatic/status",
        "/api/report-comparison/inspect", "/api/report-comparison/open", "/api/report/open", "/api/report-artifacts/list", "/api/artifact-deletion/status",
        "/api/recollection/sources", "/api/recollection/status"]);
    async function request(path, input, currentCapability) {
        let response;
        try { response = await fetch(path, {
            method: input === undefined ? "GET" : "POST",
            headers: {
                ...(currentCapability ? { "X-Board-Capability": currentCapability } : {}),
                ...(input === undefined ? {} : { "Content-Type": "application/json" }),
            },
            credentials: "same-origin",
            signal: AbortSignal.timeout(["/api/import", "/api/preview", "/api/collection/configure", "/api/collection/now", "/api/deletion/preview", "/api/deletion/confirm",
                "/api/assessment/consent/set", "/api/report-comparison/preview", "/api/report-comparison/save", "/api/artifact-deletion/preview", "/api/artifact-deletion/confirm",
                "/api/recollection/preview", "/api/recollection/confirm", "/api/evaluation/automatic/revoke"].includes(path) ? 120000 : 10000),
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        }); } catch {
            const error = new Error("The local runtime could not be reached or timed out. Start WIRE if it is stopped, then retry. No action was replayed.");
            error.reason = "runtime_unavailable";
            throw error;
        }
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
    return async function api(path, input) {
        const previous = capability;
        let result = await request(path, input, previous);
        if (result.response.status === 403 && result.body.code === "session_expired") {
            await reconnect(previous);
            if (!readOnly.has(path)) {
                const error = new Error("The local connection changed. This action was not replayed. Read current state and prepare a new review before trying again.");
                error.code = "request_rejected";
                throw error;
            }
            result = await request(path, input, capability);
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
}
