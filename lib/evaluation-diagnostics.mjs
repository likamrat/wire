const stages = new Set([
    "source-check", "source-read", "packet-build", "reservation", "request-build", "work-directory",
    "executor-load", "authority-check", "executor-call", "client-create", "session-create", "event-subscribe",
    "send", "response-check", "response-parse", "response-shape", "usage-accounting", "result-validation",
    "result-publish", "event-unsubscribe", "transport-observer-restore", "session-abort", "session-disconnect", "sdk-stop", "work-cleanup",
]);
const cleanupStages = new Set(["event-unsubscribe", "transport-observer-restore", "session-abort", "session-disconnect", "sdk-stop", "work-cleanup"]);
const errorCodes = new Set([
    "unknown-error", "ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED",
    "ERR_MODULE_NOT_FOUND", "EVALUATOR_CLEANUP_FAILED", "rpc-invalid-params", "rpc-method-not-found",
    "rpc-internal-error", "evidence-limit", "credential-excluded", "incomplete-tool-evidence",
    "final-answer-boundary-unavailable", "source-changed", "source-not-eligible", "permission-revoked",
    "source-window-unavailable", "outside-approved-window", "original-prompt-mismatch",
    "evaluator-cancelled", "evaluator-response-unavailable", "evaluator-response-not-json",
    "evaluator-response-not-object", "evaluator-tool-execution", "evaluator-model-unverified",
    "evaluator-usage-invalid", "evaluator-usage-conflict", "evaluator-call-limit-exceeded",
    "cli-executable-not-found",
    "copilot-cli-path-invalid", "copilot-cli-unavailable", "copilot-cli-not-file",
    "copilot-sdk-path-invalid", "copilot-sdk-unavailable", "copilot-sdk-not-file", "copilot-provider-unapproved",
    "evaluator-structured-timeout", "evaluator-message-id-unavailable", "evaluator-session-disconnected", "evaluator-structured-aborted",
    "evaluator-transport-observer-unavailable",
]);
const resultValidationCodes = new Set([
    "invalid-model-evaluation", "unexpected-evaluation-field", "evaluation-packet-mismatch", "invalid-evaluation-check-list",
    "invalid-evidence-anchor", "evidence-anchor-kind", "duplicate-evidence-anchor", "invalid-evaluation-verdict",
    "invalid-verdict-reason", "invalid-requirement-identity", "requirement-without-request",
    "positive-accuracy-without-evidence", "contradiction-without-evidence", "incomplete-answer-coverage",
    "invalid-answer-segment-kind", "invalid-answer-applicability", "positive-support-without-reference",
    "incomplete-action-coverage", "action-intent-without-request",
]);
const sdkOutcomes = new Map([
    ["Timeout after 120000ms waiting for the structured response", "evaluator-structured-timeout"],
    ["The runtime did not return a message ID for the structured send.", "evaluator-message-id-unavailable"],
    ["Session is disconnected", "evaluator-session-disconnected"],
    ["Session disconnected while waiting for a structured response", "evaluator-session-disconnected"],
    ["The requested run was aborted before a structured result was completed.", "evaluator-structured-aborted"],
]);
const sessionErrorTypes = new Set(["authentication", "authorization", "quota", "rate_limit", "context_limit", "query", "unknown"]);
const providerErrorCodes = new Set(["user_weekly_rate_limited", "user_global_rate_limited", "rate_limited", "user_model_rate_limited",
    "integration_rate_limited", "quota_exceeded", "session_quota_exceeded", "billing_not_configured"]);
const kinds = new Set(["prompt", "answer", "arguments", "reference-content", "reference-structured", "references", "packet"]);
const diagnostics = new WeakMap();
function requireThat(value) { if (!value) throw new TypeError("Invalid safe evaluation diagnostic."); }
function fields(value, names) {
    requireThat(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
}
export function boundedNumericErrorCode(value) {
    return Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null;
}
export function projectSessionError(event) {
    if (event?.type !== "session.error" || event.agentId || !event.data || Object.getPrototypeOf(event.data) !== Object.prototype) return null;
    const data = event.data;
    const own = name => Object.getOwnPropertyDescriptor(data, name)?.value;
    return {
        origin: "sdk-session-error", statusBasis: "provider-reported",
        errorType: sessionErrorTypes.has(own("errorType")) ? own("errorType") : "unknown",
        errorCode: providerErrorCodes.has(own("errorCode")) ? own("errorCode") : null,
        statusCode: Number.isSafeInteger(own("statusCode")) && own("statusCode") >= 100 && own("statusCode") <= 599 ? own("statusCode") : null,
        providerCallIdPresent: typeof own("providerCallId") === "string" && own("providerCallId").length > 0,
        serviceRequestIdPresent: typeof own("serviceRequestId") === "string" && own("serviceRequestId").length > 0,
    };
}
function validateSessionError(value) {
    fields(value, ["origin", "statusBasis", "errorType", "errorCode", "statusCode", "providerCallIdPresent", "serviceRequestIdPresent"]);
    requireThat(value.origin === "sdk-session-error" && value.statusBasis === "provider-reported" && sessionErrorTypes.has(value.errorType)
        && (value.errorCode === null || providerErrorCodes.has(value.errorCode))
        && (value.statusCode === null || Number.isSafeInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599)
        && typeof value.providerCallIdPresent === "boolean" && typeof value.serviceRequestIdPresent === "boolean");
}
function validateSendRpc(value) {
    fields(value, ["origin", "method", "calls", "state", "messageIdReturned", "numericErrorCode", "elapsedMs"]);
    requireThat(value.origin === "sdk-rpc-call" && value.method === "session.send"
        && Number.isSafeInteger(value.calls) && value.calls >= 0
        && ["not-observed", "pending", "resolved", "rejected"].includes(value.state)
        && (value.calls === 0 ? value.state === "not-observed" && value.elapsedMs === null : value.state !== "not-observed"
            && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0)
        && typeof value.messageIdReturned === "boolean" && (!value.messageIdReturned || value.state === "resolved")
        && (value.numericErrorCode === null || value.state === "rejected" && boundedNumericErrorCode(value.numericErrorCode) === value.numericErrorCode));
}
export function validateEvaluationDiagnostic(value) {
    fields(value, ["schemaVersion", "stage", "errorCode", "sendInvoked", "responseObserved", "transportEffect", "transportEffectKnown", "size", "cleanupStages",
        ...["numericErrorCode", "sessionError", "sendRpc"].filter(name => Object.hasOwn(value, name))]);
    requireThat(value.schemaVersion === 1 && stages.has(value.stage)
        && (errorCodes.has(value.errorCode) || value.stage === "result-validation" && resultValidationCodes.has(value.errorCode))
        && (value.sendInvoked === null || typeof value.sendInvoked === "boolean")
        && typeof value.responseObserved === "boolean" && (!value.responseObserved || value.sendInvoked === true)
        && value.transportEffect === (value.responseObserved ? "response-observed" : value.sendInvoked === false ? "not-invoked" : "unknown")
        && value.transportEffectKnown === (value.transportEffect !== "unknown")
        && Array.isArray(value.cleanupStages) && value.cleanupStages.every(stage => cleanupStages.has(stage))
        && new Set(value.cleanupStages).size === value.cleanupStages.length);
    if (value.size !== null) {
        fields(value.size, ["kind", "measured", "limit", "unit"]);
        requireThat(kinds.has(value.size.kind) && Number.isSafeInteger(value.size.measured) && value.size.measured >= 0
            && Number.isSafeInteger(value.size.limit) && value.size.limit > 0
            && value.size.unit === (value.size.kind === "references" ? "items" : "bytes"));
    }
    if (Object.hasOwn(value, "numericErrorCode")) requireThat(boundedNumericErrorCode(value.numericErrorCode) === value.numericErrorCode && value.numericErrorCode !== null);
    if (Object.hasOwn(value, "sessionError")) validateSessionError(value.sessionError);
    if (Object.hasOwn(value, "sendRpc")) validateSendRpc(value.sendRpc);
    return value;
}
export function createEvaluationDiagnostic(error, { stage, sendInvoked = null, responseObserved = false, size = null, cleanupStages = [],
    sessionError = null, sendRpc = null, numericErrorCode = boundedNumericErrorCode(error?.code) }) {
    const rpcCode = new Map([[-32602, "rpc-invalid-params"], [-32601, "rpc-method-not-found"], [-32603, "rpc-internal-error"]]);
    const resultCode = stage === "result-validation" && error instanceof TypeError && resultValidationCodes.has(error.message) ? error.message : null;
    const errorCode = resultCode ?? rpcCode.get(error?.code) ?? (errorCodes.has(error?.code) ? error.code : errorCodes.has(error?.message) ? error.message
        : sdkOutcomes.get(error?.message) ?? (typeof error?.message === "string" && error.message.startsWith("Copilot CLI not found at ") ? "cli-executable-not-found" : "unknown-error"));
    const transportEffect = responseObserved ? "response-observed" : sendInvoked === false ? "not-invoked" : "unknown";
    return validateEvaluationDiagnostic({
        schemaVersion: 1, stage, errorCode, sendInvoked, responseObserved, transportEffect,
        transportEffectKnown: transportEffect !== "unknown", size: size ? { ...size } : null, cleanupStages: [...cleanupStages],
        ...(numericErrorCode !== null ? { numericErrorCode } : {}),
        ...(sessionError ? { sessionError: { ...sessionError } } : {}),
        ...(sendRpc ? { sendRpc: { ...sendRpc } } : {}),
    });
}
export function withEvaluationDiagnostic(error, diagnostic) {
    const failure = error instanceof Error ? error : new Error("Evaluation failed without a typed error.");
    diagnostics.set(failure, structuredClone(validateEvaluationDiagnostic(diagnostic)));
    return failure;
}
export function readEvaluationDiagnostic(error) {
    const diagnostic = diagnostics.get(error);
    return diagnostic ? structuredClone(diagnostic) : null;
}
