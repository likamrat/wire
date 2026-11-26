import path from "node:path";
import { atomicJson, readJson, acquireCollectorLock } from "./collector-io.mjs";
import { dataDirFor } from "./paths.mjs";
import { validateNativeHistoryObservations } from "./native-backfill-state.mjs";
import { nativePublicOriginLabels, nativePublicRouteLabels } from "./microsoft-native-bootstrap.mjs";

export const SESSION_REASONS = Object.freeze([
    "hooks-unqualified", "browser-unavailable", "browser-policy-blocked", "profile-contention",
    "wrong-account", "access-refused", "window-closed", "cancelled", "timed-out",
    "cleanup-failed", "restart-required", "storage-failed", "state-invalid",
    "transport-failed", "signed-out", "stale-generation", "busy", "invalid-request",
    "receipt-limit", "operation-conflict", "session-closed", "lease-invalid",
    "operation-owner", "reentrant-call", "authorization-listener-failed", "admission-failed",
    "command-unauthorized",
    "account-metadata-unavailable",
    "stale-collection-control",
]);
export const SESSION_ACTIONS = Object.freeze([
    "wire-sign-in", "wire-sign-out", "microsoft-connect", "microsoft-cancel", "microsoft-recover",
]);
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const PARTITION = /^[a-f0-9]{64}$/;
const connections = ["disconnected", "signing-in", "handoff", "connected", "reconnect-required", "unavailable", "recovery-required"];
const outcomes = ["pending", "completed", "cancelled", "failed", "ambiguous"];

export class MicrosoftSessionError extends Error {
    constructor(code) {
        const safe = SESSION_REASONS.includes(code) ? code : "transport-failed";
        super(`Microsoft session: ${safe}.`);
        this.name = "MicrosoftSessionError";
        this.code = safe;
        this.status = ["operation-owner", "command-unauthorized"].includes(safe) ? 403
            : ["invalid-request", "state-invalid"].includes(safe) ? 422 : 409;
    }
}

export function exact(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every(key => keys.includes(key));
}

const nativeComparisonKeys = [
    "previousDestinationQualified", "currentDestinationQualified", "previousClientValid", "currentClientValid", "clientMatches",
    "previousRedirectValid", "currentRedirectValid", "redirectMatches", "redirectMatchesCallback",
    "previousResponseModeValid", "currentResponseModeValid", "responseModeMatches",
];
const recordedTime = value => typeof value === "string" && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const predicateStages = new Set(["network", "protocol", "route", "connect", "acquisition", "commit", "completion", "unobserved"]);
const predicateNames = new Set([
    ...["bootstrap-loader-unavailable", "account-unavailable", "account-rejected", "account-verified"]
        .map(reason => "passive-background-" + reason),
    ...["document-unobserved", "auth-document", "document-origin-unqualified", "document-path-unqualified",
        "document-status-unqualified", "document-cache-unqualified", "document-mime-unqualified",
        "document-loader-unqualified", "document-loading", "document-failed", "document-replaced",
        "frame-inspection-pending", "frame-identity-changed", "frame-origin-changed", "frame-path-changed", "metadata-read-pending",
        "bootstrap-unavailable", "bootstrap-uninitialized", "bootstrap-loader-unavailable", "account-unavailable",
        "bootstrap-invalid", "account-rejected", "account-verified"].map(reason => "passive-" + reason),
    "protocol-stop",
    "native-owner-lost",
    "request-admission", "request-observation-budget", "request-observer-admission",
    "request-observer-closed", "request-observer-no-phase", "request-observer-kind", "request-observer-duplicate",
    "unobserved", "favicon-metadata-capped", "favicon-candidate-unobserved", "favicon-candidate-unique",
    "favicon-request-not-duplicate", "favicon-request-budget",
    "favicon-request-frame", "favicon-request-owned", "favicon-request-original", "favicon-request-initiator",
    "favicon-request-epoch", "favicon-request-network-id", "favicon-request-admission", "favicon-request-not-admitted",
    "favicon-route-main-frame", "favicon-document-present", "favicon-document-epoch",
    "favicon-source-response-acknowledged", "favicon-source-terminal", "favicon-declaration-readable", "favicon-declaration-budget", "favicon-declaration-unique",
    "favicon-binding-scope", "favicon-binding-aborted", "favicon-binding-operation", "favicon-binding-page",
    "favicon-binding-protocol", "favicon-binding-frame", "favicon-binding-url", "favicon-binding-document",
    "favicon-binding-epoch", "favicon-binding-cache",
    "script-required-duplicate", "script-origin-budget",
    "chat-action-binding",
    ...["body-type", "body-budget", "json", "envelope", "root", "data", "action", "last-message",
        "filter", "store", "state", "continuation"].map(reason => "history-request-" + reason),
    ...["auth-return", "auth-continuation"].flatMap(kind => [
        "scope", "aborted", "owner", "custody", "deadline", "destination", "document", "current-document", "epoch",
        "document-ready", "request", "protocol-pairing", "route-pairing", "navigation-association",
        "original-request", "native-navigation", "first-submission", "duplicate-navigation", "duplicate-network",
    ].map(reason => `${kind}-${reason}`)),
]);
const observedPredicates = new WeakMap();
const observedAdmissions = new WeakMap();
const observedProtocolStops = new WeakMap();
export const NATIVE_PROTOCOL_STOP_REASONS = Object.freeze([
    "protocol-coverage", "protocol-cap", "protocol-continuation", "self-preflight-association",
    "capacity-queue-full", "capacity-deadline", "capacity-owner-changed", "capacity-unbound", "capacity-duplicate",
    "chat-action-association", "chat-action-preflight", "chat-action-acknowledgement", "chat-action-owner-changed", "chat-action-limit",
    "auth-telemetry-association", "auth-telemetry-limit", "auth-telemetry-role",
    "auth-telemetry-acknowledgement", "auth-telemetry-owner-changed",
    "app-telemetry-association", "app-telemetry-limit", "app-telemetry-role", "app-telemetry-acknowledgement", "app-telemetry-owner-changed",
    "bootstrap-child-error-correlation", "bootstrap-child-error-limit", "bootstrap-child-limit", "bootstrap-child-association",
    "native-preflight-cap", "idle-block-completed", "network-record-missing", "network-scope-mismatch", "network-frame-mismatch",
    "network-terminal-duplicate", "network-terminal-conflict", "health-ping-terminal-unqualified", "worker-preflight-terminal-unqualified",
    "request-failed", "network-block-completed", "network-completion-state", "operation-closed",
    "fetch-only-denial-duplicate", "fetch-only-denial-limit", "fetch-only-denial-acknowledgement", "fetch-only-denial-owner-changed",
    "network-id-missing", "network-id-invalid", "network-id-reused", "network-redirect-id-mismatch",
    "response-correlation", "response-failed", "bootstrap-transport-response-error", "bootstrap-transport-acknowledgement", "bootstrap-transport-unqualified",
    "token-redirect", "self-response", "self-preflight-response", "request-correlation", "redirect-correlation",
    "request-scope", "unowned-frame", "policy-block-scope", "partner-preload-association", "cached-session-association",
    "blocked-document-association", "blocked-preflight-association", "policy-abort-failed", "unrecognized-stop",
]);
export function validNativeProtocolStop(value) {
    if (!exact(value, ["reason", "phase", "request", "provenance", "terminal", "capacity", "binding", "networkRecord"])
        || !NATIVE_PROTOCOL_STOP_REASONS.includes(value.reason)
        || !["network", "request", "response", "unobserved"].includes(value.phase)
        || Object.hasOwn(value, "terminal") && !["failed", "finished"].includes(value.terminal)) return false;
    if (Object.hasOwn(value, "networkRecord")) {
        const record = value.networkRecord, keys = ["observation", "resourceType", "urlClass", "frame", "document", "loader"];
        if (value.reason !== "network-record-missing" || value.phase !== "network" || !Object.hasOwn(value, "terminal")
            || !exact(record, keys) || Object.keys(record).length !== keys.length
            || !["original", "redirect", "duplicate", "unobserved", "capped"].includes(record.observation)
            || !["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch",
                "eventsource", "websocket", "manifest", "ping", "preflight", "other", "unobserved"].includes(record.resourceType)
            || !["embedded-raster-image", "data-other", "https", "http", "blob", "other", "unobserved"].includes(record.urlClass)
            || !["root", "owned-descendant", "unowned", "unobserved"].includes(record.frame)
            || !["matched-at-request", "different-at-request", "unobserved"].includes(record.document)
            || !["matched-at-request", "different-at-request", "unobserved"].includes(record.loader)
            || ["unobserved", "capped"].includes(record.observation)
                && keys.slice(1).some(key => record[key] !== "unobserved")) return false;
    }
    if (Object.hasOwn(value, "capacity")) {
        const summary = value.capacity;
        const keys = ["active", "reserved", "waiting", "withoutTerminal", "withoutAcknowledgement", "redirecting"];
        if (!exact(summary, keys) || Object.keys(summary).length !== keys.length
            || keys.some(key => !Number.isInteger(summary[key]) || summary[key] < 0)
            || summary.active + summary.reserved > 128
            || summary.active + summary.reserved + summary.waiting > 512
            || ["withoutTerminal", "withoutAcknowledgement", "redirecting"].some(key => summary[key] > summary.active)) return false;
    }
    if (Object.hasOwn(value, "binding")) {
        const binding = value.binding;
        if (!exact(binding, ["reason", "retained", "limit", "capped"]) || Object.keys(binding).length !== 4
            || !["capacity-unbound", "capacity-owner-changed", "capacity-deadline"].includes(value.reason) || value.phase !== "request"
            || !["scope", "custody", "document", "metadata-excluded", "metadata-capped", "metadata-missing",
                "metadata-timeout", "metadata-duplicate", "metadata-mismatch", "metadata-stale", "deadline", "unavailable"].includes(binding.reason)
            || !Number.isInteger(binding.retained) || binding.retained < 0 || binding.retained > 512
            || binding.limit !== 512 || typeof binding.capped !== "boolean"
            || binding.reason === "metadata-capped" && !binding.capped) return false;
    }
    if (Object.hasOwn(value, "request")) {
        const request = value.request;
        if (!exact(request, ["method", "resourceType", "owner", "original", "navigation"]) || Object.keys(request).length !== 5
            || !["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "OTHER"].includes(request.method)
            || !["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch",
                "eventsource", "websocket", "manifest", "other"].includes(request.resourceType)
            || !["owned-frame", "unowned-frame"].includes(request.owner)
            || typeof request.original !== "boolean" || typeof request.navigation !== "boolean") return false;
    }
    if (Object.hasOwn(value, "provenance")) {
        const provenance = value.provenance;
        if (!Object.hasOwn(value, "request") || !exact(provenance, ["request", "frame", "invocation"]) || Object.keys(provenance).length !== 3
            || !["matched", "unobserved"].includes(provenance.request)
            || !["root", "owned-descendant", "unobserved"].includes(provenance.frame)
            || !["preexisting-before-invocation", "preexisting-request-chain", "requested-destination-match", "different-destination", "unobserved"].includes(provenance.invocation)
            || provenance.request === "unobserved" && provenance.invocation !== "unobserved") return false;
    }
    return true;
}
export function withNativeFailureProtocolStop(error, value) {
    if (!(error instanceof Error) || !validNativeProtocolStop(value)) throw new MicrosoftSessionError("invalid-request");
    if (!observedProtocolStops.has(error)) observedProtocolStops.set(error, Object.freeze({ ...value,
        ...(value.request ? { request: Object.freeze({ ...value.request }) } : {}),
        ...(value.capacity ? { capacity: Object.freeze({ ...value.capacity }) } : {}),
        ...(value.binding ? { binding: Object.freeze({ ...value.binding }) } : {}),
        ...(value.networkRecord ? { networkRecord: Object.freeze({ ...value.networkRecord }) } : {}),
        ...(value.provenance ? { provenance: Object.freeze({ ...value.provenance }) } : {}) }));
    return error;
}
const admissionPredicates = new Set([
    "unowned-frame", "url-scope", "token-scope", "shell-document-scope", "business-data", "self-preflight-association",
    "self-scope", "auth-data", "document-scope", "sign-in-return-method", "method-scope", "data-dependency",
    "request-observation-budget", "request-observer-admission", "request-observer-closed", "request-observer-no-phase",
    "request-observer-kind", "request-observer-duplicate",
]);
export function validNativeAdmission(value) {
    return exact(value, ["schemaVersion", "method", "resourceType", "publicRoute", "owner", "original", "navigation", "predicate", "stage", "document"])
        && Object.keys(value).length === 9 + Number(Object.hasOwn(value, "document")) && value.schemaVersion === 1
        && ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "OTHER"].includes(value.method)
        && ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch",
            "eventsource", "websocket", "manifest", "other"].includes(value.resourceType)
        && ["shell", "landingv2", "other-account-page", "token", "self", "protected-data", "static", "other", "unobserved"].includes(value.publicRoute)
        && ["owned-frame", "unowned-frame", "unobserved"].includes(value.owner)
        && [null, true, false].includes(value.original) && [null, true, false].includes(value.navigation)
        && admissionPredicates.has(value.predicate) && ["network", "protocol", "route"].includes(value.stage)
        && (!Object.hasOwn(value, "document") || validDocumentAdmission(value));
}
function validDocumentAdmission(admission) {
    const value = admission.document;
    if (!exact(value, ["originClass", "originLabel", "routeLabel", "clause"]) || Object.keys(value).length !== 4
        || admission.predicate !== "document-scope" || admission.navigation !== true
        || !["unknown", ...Object.values(nativePublicOriginLabels)].includes(value.originLabel)
        || !["unknown", ...Object.values(nativePublicRouteLabels)].includes(value.routeLabel)) return false;
    const originClass = ["m365-app", "copilot-app"].includes(value.originLabel) ? "admitted-app"
        : ["entra-login", "microsoft-login", "entra-sso"].includes(value.originLabel) ? "admitted-auth"
            : value.originLabel === "unknown" ? "outside-known-origin" : "known-unadmitted-origin";
    if (value.originClass !== originClass || originClass === "outside-known-origin" && value.routeLabel !== "unknown") return false;
    return admission.resourceType !== "document" ? value.clause === "non-document-resource"
        : originClass === "admitted-app" ? value.clause === "unlisted-app-path"
            : ["outside-known-origin", "known-unadmitted-origin"].includes(originClass) && value.clause === "outside-admitted-origins";
}
export function withNativeFailureAdmission(error, value) {
    if (!(error instanceof Error) || !validNativeAdmission(value)) throw new MicrosoftSessionError("invalid-request");
    if (!observedAdmissions.has(error)) observedAdmissions.set(error, Object.freeze({ ...value,
        ...(Object.hasOwn(value, "document") ? { document: Object.freeze({ ...value.document }) } : {}) }));
    return error;
}
export function validNativePredicate(value) {
    return exact(value, ["schemaVersion", "stage", "name"]) && Object.keys(value).length === 3
        && value.schemaVersion === 1 && predicateStages.has(value.stage) && predicateNames.has(value.name);
}
export function withNativeFailurePredicate(error, stage, name) {
    const predicate = { schemaVersion: 1, stage, name };
    if (!(error instanceof Error) || !validNativePredicate(predicate)) throw new MicrosoftSessionError("invalid-request");
    if (!observedPredicates.has(error)) observedPredicates.set(error, Object.freeze(predicate));
    return error;
}
export function nativeFailureDetails(error, stage = "unobserved") {
    if (!predicateStages.has(stage)) throw new MicrosoftSessionError("invalid-request");
    const code = error instanceof Error && (SESSION_REASONS.includes(error.code)
        || typeof error.code === "string" && /^NATIVE_[A-Z_]{1,93}$/.test(error.code)) ? error.code : "NATIVE_SOURCE_READ_FAILED";
    return { code, predicate: observedPredicates.get(error)
        ?? Object.freeze({ schemaVersion: 1, stage, name: "unobserved" }),
        ...(observedAdmissions.has(error) ? { admission: observedAdmissions.get(error) } : {}),
        ...(code === "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED" && typeof error?.publicCoworkScript === "string"
            && /^coworker\.[a-f0-9]{8}\.js$/.test(error.publicCoworkScript) ? { publicCoworkScript: error.publicCoworkScript } : {}),
        ...(observedProtocolStops.has(error) ? { protocolStop: observedProtocolStops.get(error) } : {}) };
}
export function validNativeFailure(value) {
    return exact(value, ["code", "recordedAt", "faviconFailure", "applicationComparison", "predicate", "admission", "protocolStop", "publicCoworkScript"])
        && typeof value.code === "string" && value.code.length <= 100
        && (SESSION_REASONS.includes(value.code) || /^NATIVE_[A-Z_]+$/.test(value.code))
        && recordedTime(value.recordedAt)
        && (!Object.hasOwn(value, "publicCoworkScript") || value.code === "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED"
            && typeof value.publicCoworkScript === "string" && /^coworker\.[a-f0-9]{8}\.js$/.test(value.publicCoworkScript))
        && (!Object.hasOwn(value, "predicate") || validNativePredicate(value.predicate))
        && (!Object.hasOwn(value, "admission") || validNativeAdmission(value.admission))
        && (!Object.hasOwn(value, "protocolStop") || validNativeProtocolStop(value.protocolStop))
        && (!Object.hasOwn(value, "faviconFailure") || exact(value.faviconFailure, ["stage", "category"])
            && ["network", "protocol", "route"].includes(value.faviconFailure.stage)
            && ["request-metadata", "request-correlation", "current-binding", "duplicate-request", "request-limit",
                "document-context", "source-readiness", "declaration-read", "declaration-unqualified"].includes(value.faviconFailure.category))
        && (!Object.hasOwn(value, "applicationComparison") || exact(value.applicationComparison, nativeComparisonKeys)
            && nativeComparisonKeys.every(key => typeof value.applicationComparison[key] === "boolean"));
}
function validNativeEvidence(value) {
    const historyValid = () => {
        try { validateNativeHistoryObservations(value.history); return true; }
        catch (error) { if (error.code === "NATIVE_BACKFILL_INVALID") return false; throw error; }
    };
    return exact(value, ["firstFailure", "cleanup", "history"]) && Object.keys(value).length > 0
        && (!Object.hasOwn(value, "history") || historyValid())
        && (!Object.hasOwn(value, "firstFailure") || validNativeFailure(value.firstFailure))
        && (!Object.hasOwn(value, "cleanup") || exact(value.cleanup, ["state", "recordedAt"])
            && ["pending", "failed", "completed"].includes(value.cleanup.state) && recordedTime(value.cleanup.recordedAt));
}

export function validateSessionState(state) {
    const validPartition = value => typeof value === "string" && PARTITION.test(value);
    const validInteger = value => Number.isSafeInteger(value) && value >= 0;
    if (!exact(state, ["version", "generation", "wire", "connection", "reason", "partition", "partitions", "owner", "receipts"])
        || state.version !== 1 || !validInteger(state.generation)
        || !["signed-in", "signed-out"].includes(state.wire)
        || !connections.includes(state.connection)
        || !(state.reason === null || SESSION_REASONS.includes(state.reason))
        || !(state.partition === null || validPartition(state.partition))
        || !Array.isArray(state.partitions) || !state.partitions.every(validPartition)
        || new Set(state.partitions).size !== state.partitions.length
        || state.partition !== null && !state.partitions.includes(state.partition)
        || !(state.owner === null || exact(state.owner, ["id", "phase", "operationId"])
            && UUID.test(state.owner.id) && ["visible", "headless", "closing"].includes(state.owner.phase)
            && (!Object.hasOwn(state.owner, "operationId") || UUID.test(state.owner.operationId)))
        || !Array.isArray(state.receipts) || state.receipts.length > 1024
        || new Set(state.receipts.map(receipt => receipt?.operationId)).size !== state.receipts.length
        || state.receipts.some(receipt => !exact(receipt, ["operationId", "action", "fingerprint", "ownerHash", "generation", "outcome", "reason", "revocation", "nativeEvidence"])
            || !UUID.test(receipt.operationId) || !SESSION_ACTIONS.includes(receipt.action)
            || !PARTITION.test(receipt.fingerprint) || !validInteger(receipt.generation)
            || Object.hasOwn(receipt, "ownerHash") && !validPartition(receipt.ownerHash)
            || receipt.generation > state.generation || !outcomes.includes(receipt.outcome)
            || !(receipt.reason === null || SESSION_REASONS.includes(receipt.reason))
            || Object.hasOwn(receipt, "nativeEvidence") && (receipt.action !== "microsoft-connect" || !validNativeEvidence(receipt.nativeEvidence))
            || !(receipt.revocation === null || exact(receipt.revocation, ["scope", "partition"])
                && ["wire", "microsoft-account"].includes(receipt.revocation.scope)
                && (receipt.revocation.partition === null || validPartition(receipt.revocation.partition))))
        || state.owner?.operationId && !state.receipts.some(receipt =>
            receipt.operationId === state.owner.operationId && receipt.action === "microsoft-connect")
        || state.connection === "connected" && (state.wire !== "signed-in" || !state.partition
            || !["visible", "headless"].includes(state.owner?.phase))
        || ["signing-in", "handoff"].includes(state.connection) && (!state.owner || state.wire !== "signed-in")) {
        throw new MicrosoftSessionError("state-invalid");
    }
    return state;
}

export function initialSessionState() {
    return { version: 1, generation: 0, wire: "signed-out", connection: "disconnected",
        reason: null, partition: null, partitions: [], owner: null, receipts: [] };
}

// A separate namespace reuses WIRE's private atomic writer, without changing board state.
export function sessionStorage(context) {
    const directory = path.join(dataDirFor(context), "microsoft-session");
    const file = path.join(directory, "session.json");
    return {
        async lock() {
            try { return await acquireCollectorLock(directory); }
            catch (error) { throw new MicrosoftSessionError(error.status === 409 ? "profile-contention" : "storage-failed"); }
        },
        async read() {
            try {
                const missing = Symbol("missing");
                const value = await readJson(file, missing);
                return value === missing ? null : validateSessionState(value);
            } catch (error) {
                throw new MicrosoftSessionError(error instanceof MicrosoftSessionError ? error.code
                    : error instanceof SyntaxError ? "state-invalid" : "storage-failed");
            }
        },
        async write(value) {
            validateSessionState(value);
            try { await atomicJson(file, value); }
            catch { throw new MicrosoftSessionError("storage-failed"); }
        },
    };
}
