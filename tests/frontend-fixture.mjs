import { searchRecords } from "./live-search-fixture.mjs";

export function frontendRecords() {
    const prompts = [
        "Find the decisions from the Cedar launch review.",
        "What changed in the Cedar release checklist?",
        "Find the latest planning notes for the Atlas project.",
        "Which project reviews are scheduled this week?",
        "Find the document that lists the Cedar release owners.",
        "Find the messages about the Atlas handover.",
    ];
    return searchRecords(240).map((record, index) => {
        const stamp = `2026-11-${String(10 + index % 7).padStart(2, "0")}T${String(10 + index % 8).padStart(2, "0")}:15:00.000Z`;
        const actor = index % 4 ? "user" : "agent";
        record.title = prompts[index % prompts.length];
        record.sourceSessionId = `invented-frontend-chat-${index % 4}`;
        record.sourceSessionName = index % 2 ? "Cedar launch" : "Atlas planning";
        record.project = index % 2 ? "Cedar launch" : "Atlas planning";
        record.capturedAt = stamp;
        record.userPrompt = { text: `${prompts[index % prompts.length]} Keep the original dates and identify each source.`,
            status: "full", sourceEventId: `frontend-prompt-${index}`, sourceTimestamp: stamp,
            authorship: { actor, basis: `source-${actor}` } };
        record.followUpPrompts = []; record.httpRecords = [];
        const failure = index % 7 === 0;
        Object.assign(record.toolCalls[0], {
            tool: index % 3 ? "workiq-fetch" : "workiq-retrieve",
            startedAt: stamp, completedAt: new Date(Date.parse(stamp) + 600 + index * 31).toISOString(),
            durationMs: 600 + index * 31, completionEventId: `frontend-end-${index}`,
            requestArgs: { entityUrls: [failure ? "/me/messages" : "/me/drive/root/children"] },
            requestedApiPath: failure ? "/me/messages" : "/me/drive/root/children",
            toolSucceeded: !failure, reportedOutcome: failure ? "failed" : "succeeded",
            apiResults: [{ index: 0, path: failure ? "/me/messages" : "/me/drive/root/children",
                statusCode: failure ? 403 : 200, evidenceLevel: "intermediary-reported" }],
            ...(failure ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "AccessDenied",
                messageStatus: "text-excluded", messageSignal: "access-denial" } } : {}),
        });
        if (!failure && index % 11 === 5) {
            delete record.toolCalls[0].toolSucceeded;
            delete record.toolCalls[0].completionEventId;
            Object.assign(record.toolCalls[0], { reportedOutcome: "unknown", completedAt: null, durationMs: null, apiResults: [] });
        }
        return record;
    });
}
