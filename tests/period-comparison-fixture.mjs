import { fixture } from "./helpers.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";

export const periodQuery = "INVENTED_PERIOD_NEEDLE";
export function periodFixture() {
    const starts = [
        "2026-03-07T05:00:00.000Z", "2026-03-08T04:59:59.999Z",
        "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z",
        "2026-03-09T04:00:00.000Z", "2026-03-10T03:59:59.999Z",
        "2026-03-10T04:00:00.000Z", null,
        "2026-03-07T17:00:00.000Z", "2026-03-07T18:00:00.000Z",
    ];
    const records = starts.map((startedAt, index) => {
        const record = fixture(`period-request-${index}`);
        record.sourceSessionId = `period-chat-${index}`;
        record.sourceSessionName = `Invented period chat ${index}`;
        record.userPrompt = {
            text: `${index === 9 ? "Outside query" : periodQuery} request ${index}`, status: "full",
            sourceEventId: `period-prompt-${index}`, sourceTimestamp: startedAt ?? "2026-03-07T12:00:00.000Z",
            authorship: { actor: index % 2 ? "agent" : "user", basis: index % 2 ? "source-agent" : "source-user" },
        };
        record.followUpPrompts = [];
        const durationMs = [0, 1000, 3000, null, 5000, null, 9000, null, 100, 100][index];
        record.toolCalls = [{
            tool: "workiq-fetch", toolCallId: `period-call-${index}`, startEventId: `period-start-${index}`,
            completionEventId: `period-end-${index}`, startedAt,
            ...(durationMs !== null ? { durationMs, completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString() } : {}),
            requestArgs: { entityUrls: index === 0 ? ["/me/drive/root", "/me/messages"] : ["/me/drive/root"] },
            toolSucceeded: index === 5 ? null : ![0, 2].includes(index),
            reportedOutcome: index === 5 ? "unknown" : [0, 2].includes(index) ? "failed" : "succeeded",
            apiResults: (index === 0 ? ["/me/drive/root", "/me/messages"] : ["/me/drive/root"]).map((path, position) => ({
                index: position, path, statusCode: [0, 2].includes(index) ? 503 : 200,
            })),
            observedGraphHttp: false,
        }];
        if (index === 0) {
            record.toolCalls[0].failureEvidence = { version: 1, origin: "completion.toolError", reason: "tool-error",
                code: null, httpStatus: null, messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" };
            record.toolCalls.push({
                ...structuredClone(record.toolCalls[0]), toolCallId: "period-calendar", startEventId: "period-calendar-start",
                requestArgs: { entityUrl: "/me/calendarView" }, apiResults: [], durationMs: 100,
                toolSucceeded: true, reportedOutcome: "succeeded", failureEvidence: undefined,
                completedAt: "2026-03-07T05:00:00.100Z",
            }, {
                ...structuredClone(record.toolCalls[0]), toolCallId: "period-missing", startEventId: "period-missing-start",
                tool: "workiq-ask", requestArgs: { question: "Invented help request" }, apiResults: [], durationMs: undefined,
                completedAt: undefined, toolSucceeded: null, reportedOutcome: "partial", failureEvidence: undefined,
            });
            record.responseTiming = {
                schemaVersion: 1, status: "measured", boundary: "recorded-request-to-final-answer",
                promptEventId: record.userPrompt.sourceEventId, requestedAt: startedAt,
                respondedAt: "2026-03-07T05:00:08.000Z", completedAt: "2026-03-07T05:00:08.000Z", durationMs: 8000,
                finalEventId: "period-final", completionEventId: "period-turn", association: "single-recorded-message-interval",
            };
        }
        if (index === 8) record.isLegacy = true;
        return record;
    });
    // Exact duplicate source call, not an extra call or an extra interaction.
    records[0].toolCalls.push(structuredClone(records[0].toolCalls[0]));
    const { state } = qualityDisplayFixture({ records, judgments: ["pass", "fail", "pass", "unassessed", "error"], finalDuration: null });
    const input = {
        schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", groupBy: "workload", bucket: "day", limit: 8,
            filters: { scope: "history", services: ["Files"], includeMissingService: true },
            timeContext: { timeZone: "America/New_York", locale: "en-US" } },
        periods: { baseline: { from: "2026-03-07", to: "2026-03-07" }, later: { from: "2026-03-08", to: "2026-03-09" } },
        scenarioIds: records.filter(record => record.userPrompt.text.includes(periodQuery)).map(record => record.scenarioId),
        withinServices: [],
    };
    return { state, input, records };
}
