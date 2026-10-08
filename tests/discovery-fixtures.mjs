import { fixture } from "./helpers.mjs";

export function discoveryFixture() {
    const record = fixture("discovery-categories");
    record.userPrompt.text = "Invented API discovery and data lookup.";
    record.followUpPrompts = [];
    record.toolCalls = [
        ["search_paths", { query: "Invented paths" }, true], ["get_schema", { path: "/me/messages", operationType: "fetch" }, false],
        ["list_agents", {}, null], ["ask", { question: "Invented request" }, true],
        ["retrieve", { query: "Invented query" }, true], ["fetch", { entityUrls: ["/me/messages"] }, true],
        ["fetch", { entityUrls: ["/unsupported"] }, false],
        ["fetch", { entityUrls: ["/me/messages", "/me/events"] }, true],
    ].map(([operation, requestArgs, success], index) => ({
        tool: `workiq-${operation}`, toolCallId: `invented-call-${index}`, startEventId: `invented-start-${index}`,
        completionEventId: success === null ? null : `invented-end-${index}`,
        startedAt: "2026-10-01T00:00:01.000Z", completedAt: success === null ? null : "2026-10-01T00:00:02.000Z",
        durationMs: success === null ? null : 1000, requestArgs, toolSucceeded: success,
        reportedOutcome: success === null ? "unknown" : success ? "succeeded" : "failed",
        apiResults: [], observedGraphHttp: false,
    }));
    return record;
}
