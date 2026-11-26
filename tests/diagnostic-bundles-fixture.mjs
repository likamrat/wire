import { fixture } from "./helpers.mjs";

// Invented Work IQ activity for diagnostic-bundle tests and screenshots: several tools,
// recorded failure reasons, throttling, server errors, timeouts and unknown outcomes.
const failures = {
    denied: { toolSucceeded: false, reportedOutcome: "failed", resultEvidence: { statusCode: 403 },
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "ErrorAccessDenied", messageStatus: "text-excluded",
            messageSignal: "access-denial", diagnostic: { code: "ErrorAccessDenied", statusCode: 403, message: "Access is denied. Check credentials and try again." } } },
    throttled: { toolSucceeded: false, reportedOutcome: "failed", resultEvidence: { statusCode: 429 },
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "TooManyRequests", messageStatus: "text-excluded",
            diagnostic: { code: "TooManyRequests", statusCode: 429, message: "Application is over its MailboxConcurrency limit." } } },
    unavailable: { toolSucceeded: false, reportedOutcome: "failed", resultEvidence: { statusCode: 503 },
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "ServiceUnavailable", messageStatus: "text-excluded",
            diagnostic: { code: "ServiceUnavailable", statusCode: 503, message: "The service is temporarily unavailable." } } },
    server: { toolSucceeded: false, reportedOutcome: "failed", resultEvidence: { statusCode: 500 },
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "InternalServerError", messageStatus: "text-excluded",
            diagnostic: { code: "InternalServerError", statusCode: 500, message: "An internal server error occurred." } } },
    timeout: { toolSucceeded: false, reportedOutcome: "failed",
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "-32001", messageStatus: "text-excluded",
            diagnostic: { code: "-32001", message: "MCP error -32001: Request timed out" } } },
    unknown: { toolSucceeded: null, reportedOutcome: "unknown" },
};

const plan = [
    ["2026-11-16T09:10:00Z", "workiq-fetch", "/me/messages", ["ok", "ok", "denied", "denied"]],
    ["2026-11-16T14:30:00Z", "workiq-ask", null, ["ok", "timeout", "ok"]],
    ["2026-11-17T08:05:00Z", "workiq-retrieve", null, ["ok", "throttled", "throttled", "ok", "unknown"]],
    ["2026-11-17T16:45:00Z", "workiq-fetch", "/me/calendar/events", ["ok", "server", "ok"]],
    ["2026-11-18T10:20:00Z", "workiq-do_action", "/me/sendMail", ["unavailable", "ok"]],
    ["2026-11-18T11:00:00Z", "workiq-fetch", "/me/messages", ["denied", "ok", "unknown"]],
    ["2026-11-19T09:40:00Z", "workiq-ask", null, ["timeout", "ok", "ok"]],
];

export function diagnosticRecords() {
    return plan.map(([at, tool, apiPath, outcomes], index) => {
        const record = fixture(`diag-${index}`);
        record.capturedAt = at;
        record.sourceSessionId = `diag-chat-${index % 3}`;
        record.sourceSessionName = ["Quarterly planning", "Inbox triage", "Release readiness"][index % 3];
        record.userPrompt = { text: `Invented diagnostic prompt ${index}`, status: "full", sourceTimestamp: at,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = outcomes.map((outcome, call) => ({
            tool, toolCallId: `diag-${index}-${call}`, startEventId: `diag-start-${index}-${call}`,
            startedAt: new Date(Date.parse(at) + call * 60000).toISOString(), durationMs: 800 + call * 450,
            requestArgs: apiPath ? { entityUrls: [apiPath] } : { question: "Invented question" },
            ...(apiPath ? { requestedApiPath: apiPath } : {}),
            apiResults: outcome === "ok" && apiPath ? [{ index: 0, statusCode: 200, evidenceLevel: "intermediary-reported" }] : [],
            observedGraphHttp: false,
            ...(outcome === "ok" ? { toolSucceeded: true, reportedOutcome: "succeeded" } : failures[outcome]),
        }));
        return record;
    });
}
