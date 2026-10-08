import { randomUUID } from "node:crypto";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export const METADATA_URL = `${GRAPH_ORIGIN}/v1.0/$metadata`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SEGMENTS = new Set(["me", "users", "groups", "teams", "chats", "channels", "messages", "events", "calendarView", "calendars", "drive", "drives", "items", "children", "root", "sites", "lists", "members", "attachments", "planner", "plans", "tasks", "buckets", "mailFolders", "inbox", "sentitems", "manager", "directReports", "joinedTeams", "businessapps", "$metadata", "$batch", "$value", "delta", "content", "search", "query"]);
const QUERY_KEYS = new Set(["$select", "$filter", "$search", "$orderby", "$top", "$skip", "$skiptoken", "$expand", "$count", "startDateTime", "endDateTime"]);
const safeId = (value) => value == null ? null : UUID.test(value) ? value : "[non-UUID identifier withheld]";

export function graphTargetParts(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = graphTargetParts(value.path);
        return { ...nested, query: Array.isArray(value.query) ? value.query.map((q) => q?.key) : nested.query };
    }
    if (typeof value !== "string") return { path: null, query: [], version: null };
    let text = value;
    if (/^https?:\/\//i.test(text)) {
        let url;
        try { url = new URL(text); } catch { return { path: null, query: [], version: null }; }
        if (url.origin !== GRAPH_ORIGIN || url.username || url.password) return { path: null, query: [], version: null };
        text = url.pathname + url.search;
    }
    if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || text.includes("#")) return { path: null, query: [], version: null };
    const [pathname, ...query] = text.split("?");
    const version = /^\/(v1\.0|beta)(?:\/|$)/.exec(pathname)?.[1] ?? null;
    return {
        path: pathname.replace(/^\/(?:v1\.0|beta)(?=\/|$)/, "") || "/",
        query: [...new URLSearchParams(query.join("?")).keys()],
        version,
    };
}

export function isSharedDriveItemPath(value) {
    return typeof value === "string" && /^\/shares\/(?!\.{1,2}\/)[^/\\?#]+\/driveItem\/?$/.test(value);
}

export function routeShape(value) {
    if (typeof value !== "string") return null;
    const target = graphTargetParts(value);
    if (isSharedDriveItemPath(target.path)) return {
        path: `${target.version ? "/" + target.version : ""}/shares/{withheld}/driveItem`,
        query: target.query.map(key => ({
            key: QUERY_KEYS.has(key) ? key : "[withheld key]", value: "[withheld literal]",
        })),
    };
    const queryStart = value.indexOf("?");
    const pathname = queryStart < 0 ? value : value.slice(0, queryStart);
    if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) return { path: "[withheld path]", query: [] };
    return {
        path: pathname.split("/").map((part) => part === "" ? "" : SEGMENTS.has(part) ? part : "{withheld}").join("/"),
        query: queryStart < 0 ? [] : [...new URLSearchParams(value.slice(queryStart + 1))].map(([key]) => ({
            key: QUERY_KEYS.has(key) ? key : "[withheld key]", value: "[withheld literal]",
        })),
    };
}

export function retryAfter(value) {
    if (value == null) return null;
    if (/^\d{1,8}$/.test(value)) return { seconds: Number(value) };
    if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value))) return { date: new Date(value).toISOString() };
    return { unparsed: true };
}

export function parseGraphJsonMetadata(body) {
    if (!body || typeof body !== "object") throw new Error("Parsed JSON object required for metadata inspection.");
    return {
        paginationPresent: typeof body["@odata.nextLink"] === "string",
        batchSubresponses: Array.isArray(body.responses) ? body.responses.slice(0, 100).map((r, index) => {
            const headers = new Headers(r?.headers ?? {});
            return {
                index, status: Number.isInteger(r?.status) ? r.status : null,
                requestId: safeId(headers.get("request-id")), clientRequestId: safeId(headers.get("client-request-id")),
                retryAfter: retryAfter(headers.get("retry-after")),
                paginationPresent: typeof r?.body?.["@odata.nextLink"] === "string",
            };
        }) : [],
        subresponsesTruncated: Array.isArray(body.responses) && body.responses.length > 100,
    };
}

export class GraphRecordingError extends Error {
    constructor(message, record, response = null) {
        super(message);
        this.record = record;
        this.response = response;
        this.requestWasSent = true;
    }
}

// Explicit owned-client boundary: native Request is forwarded once, unchanged.
// The caller owns auth, permission, retries, response consumption and parsed JSON.
// A supplied test transport is ALWAYS classified synthetic, regardless of URL.
export function createGraphRecorder({ enabled, persist, testTransport }) {
    if (enabled !== true || typeof persist !== "function") throw new Error("Explicit recorder opt-in and a persistence sink are required.");
    const transport = testTransport ?? fetch;
    return async function recordedGraphRequest(input, init, correlation = {}, inspectParsedBody) {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== GRAPH_ORIGIN || !/^\/(v1\.0|beta)\//.test(url.pathname)) throw new Error("Recorder accepts only versioned Microsoft Graph HTTPS requests.");
        const version = url.pathname.split("/")[1];
        const record = {
            schemaVersion: 1, recordId: randomUUID(), classification: testTransport ? "synthetic-http-fixture" : "direct-graph-http",
            synthetic: Boolean(testTransport), observedGraphHttp: false,
            startedAt: new Date().toISOString(), method: request.method,
            requestedMethod: request.method, requestedOrigin: url.origin, requestedApiVersion: version, apiVersion: version,
            requestedPath: routeShape(url.pathname.slice(version.length + 1) + url.search),
            requestShape: { bodyPresent: request.body !== null, authorizationPresent: request.headers.has("authorization"), cookiePresent: request.headers.has("cookie") },
            requestClientRequestId: safeId(request.headers.get("client-request-id")),
            correlation: {
                sessionId: safeId(correlation.sessionId), scenarioId: correlation.scenarioId ?? null,
                toolCallId: correlation.toolCallId ?? null,
                establishedBy: correlation.sessionId ? "explicit-owned-caller" : "unknown",
            },
            status: null, durationMs: null, durationBoundary: "request dispatch to response headers",
            responseOrigin: null, responsePath: null, requestId: null, responseClientRequestId: null,
            retryAfter: null, paginationPresent: null, batchSubresponses: [],
            bodyInspection: "not-requested; no response body logged", transportError: null,
        };
        const started = performance.now();
        let response;
        try {
            response = await transport(request);
        } catch (error) {
            record.durationMs = Math.round(performance.now() - started);
            record.transportError = ["AbortError", "TimeoutError"].includes(error.name) ? error.name : "network-error";
            try { await persist(record); } catch { throw new GraphRecordingError("Transport and metadata persistence failed. No HTTP response observed; do not replay automatically.", record); }
            throw new GraphRecordingError("Graph transport failed. No HTTP response observed; failure metadata was retained.", record);
        }
        record.durationMs = Math.round(performance.now() - started);
        const observed = response.url ? new URL(response.url) : testTransport ? url : null;
        record.status = response.status;
        record.responseOrigin = observed?.origin === GRAPH_ORIGIN ? GRAPH_ORIGIN : observed ? "[non-Graph origin withheld]" : null;
        record.responsePath = observed?.origin === GRAPH_ORIGIN ? routeShape(observed.pathname.replace(/^\/(v1\.0|beta)/, "") + observed.search) : null;
        record.apiVersion = observed?.origin === GRAPH_ORIGIN ? /^\/(v1\.0|beta)\//.exec(observed.pathname)?.[1] ?? null : null;
        if (response.redirected) record.method = null;
        record.methodEvidence = response.redirected ? "Final-hop method unknown after Fetch redirect; requestedMethod retained." : "Observed owned request without redirect.";
        record.observedGraphHttp = !testTransport && observed?.origin === GRAPH_ORIGIN;
        record.requestId = safeId(response.headers.get("request-id"));
        record.responseClientRequestId = safeId(response.headers.get("client-request-id"));
        record.retryAfter = retryAfter(response.headers.get("retry-after"));
        record.redirected = response.redirected;
        if (inspectParsedBody) {
            try {
                Object.assign(record, parseGraphJsonMetadata(await inspectParsedBody(response)));
                record.bodyInspection = "caller-provided parsed JSON inspected for metadata only; values/body not logged";
            } catch {
                record.bodyInspection = "metadata-inspection-failed";
            }
        }
        try { await persist(record); }
        catch { throw new GraphRecordingError("HTTP response received, but recorder persistence failed. Response retained on error.response; do not replay the request.", record, response); }
        if (record.bodyInspection === "metadata-inspection-failed") throw new GraphRecordingError("HTTP response received; metadata inspection failed explicitly. Response retained on error.response.", record, response);
        return { response, record };
    };
}
