// Sanitized retained shape: the original prose was not saved, but its exact MCP timeout signal was.
export function timeoutRecord(id = "timeout", durationMs = 180024, startedAt = "2026-10-01T12:00:00.000Z") {
    return {
        scenarioId: id, title: "Invented timing request", family: "retrieval",
        sourceSessionId: "invented-timing-source", sourceHost: "copilot-app",
        capturedAt: startedAt, workloadKind: "recorded-history", sample: false,
        userPrompt: { sourceEventId: id + "-prompt", sourceTimestamp: startedAt,
            text: "Inspect the invented " + id + " request.", status: "full",
            authorship: { actor: "user", basis: "source-user" } },
        followUpPrompts: [],
        toolCalls: [{
            tool: "workiq-retrieve", toolCallId: id + "-call", startEventId: id + "-start", completionEventId: id + "-end",
            startedAt, completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), durationMs,
            reportedOutcome: "failed", toolSucceeded: false, requestArgs: { query: "Invented timing request" }, apiResults: [],
            failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: "text-excluded", messageSignal: "request-timeout" },
        }],
    };
}
