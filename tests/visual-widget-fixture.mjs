import { fixture } from "./helpers.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";

// Invented retained records; no source, model, approval or capture operation runs.
export function visualWidgetFixture() {
    const records = Array.from({ length: 79 }, (_, index) => {
        const record = fixture(`widget-request-${index}`);
        record.sourceSessionId = `widget-chat-${index % 31}`;
        record.sourceSessionName = `Planning archive ${index % 31 + 1}`;
        record.project = "Invented coastal survey";
        record.userPrompt = { text: `Find the coastal survey planning notes for area ${index + 1}.`,
            status: "full", sourceEventId: `widget-prompt-${index}`, provenance: "human-authored",
            sourceTimestamp: new Date(Date.UTC(2026, 8, 3 + index % 37, 10)).toISOString() };
        record.capturedAt = record.userPrompt.sourceTimestamp;
        record.followUpPrompts = [];
        record.toolCalls = [];
        return record;
    });
    const targets = ["/me/messages", "/me/calendarView", "/me/drive/root/children", "/me/chats",
        "/me/people", "/me/drive/root/children", "/me/todo/lists"];
    for (let index = 0; index < 247; index++) {
        const record = records[index % records.length], kind = index % 12;
        const tool = kind < 4 ? "workiq-retrieve" : kind < 6 ? "workiq-search_paths"
            : kind === 6 ? "workiq-get_schema" : kind === 7 ? "workiq-ask"
                : index % 19 === 0 ? "workiq-fetch"
                    : ["workiq-fetch", "workiq-fetch_blob", "workiq-do_action", "workiq-create_entity"][kind - 8];
        const urls = index % 19 === 0 ? ["/me/messages", "/me/drive/root/children", "/unrecognized/resource"]
            : [targets[index % targets.length]];
        const failed = index < 33, unknown = index >= 245;
        const signal = index < 23 ? null : index < 26 ? "workiq-sign-in-required"
            : index < 29 ? "request-timeout" : null;
        record.toolCalls.push({
            tool, toolCallId: `widget-call-${index}`, startEventId: `widget-start-${index}`,
            completionEventId: unknown ? null : `widget-end-${index}`,
            requestArgs: tool === "workiq-fetch" ? { entityUrls: urls }
                : tool === "workiq-fetch_blob" ? { path: urls[0] }
                    : tool === "workiq-do_action" ? { actionUrl: urls[0] }
                        : tool === "workiq-create_entity" ? { parentUrl: urls[0] }
                : tool === "workiq-get_schema" ? { path: "/me/messages", operationType: "fetch" }
                    : tool === "workiq-ask" ? { question: "Find the invented coastal survey notes." }
                        : { query: "Invented coastal survey planning" },
            startedAt: record.capturedAt, completedAt: unknown ? null : new Date(Date.parse(record.capturedAt) + 1200 + index).toISOString(),
            durationMs: unknown ? null : 1200 + index,
            toolSucceeded: unknown ? null : !failed, reportedOutcome: unknown ? "unknown" : failed ? "failed" : "succeeded",
            ...(failed && index >= 23 ? { failureEvidence: {
                version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded",
                ...(signal ? { messageSignal: signal } : {}),
            } } : {}),
            apiResults: [], observedGraphHttp: false,
        });
    }
    const { state } = qualityDisplayFixture({ records, judgments: ["pass", "fail", "unassessed", "error", "error", "error", "error", "error"] });
    const unavailable = state.personalEvaluation.modelEvaluation.runs.at(-1);
    unavailable.phase = "complete"; unavailable.error = null;
    unavailable.results[0].status = "unavailable"; unavailable.results[0].reason = "missing-evidence";
    return state;
}
