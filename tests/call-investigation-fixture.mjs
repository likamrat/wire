import { retainedContextFixture } from "./request-context-fixture.mjs";
import { graphMatrixRecord } from "./report-evidence-matrix-fixtures.mjs";
import { fixture } from "./helpers.mjs";

export function callInvestigationRecords() {
    const records = retainedContextFixture().records.slice(0, 2);
    const retry = records[1], original = retry.toolCalls[0];
    // Same start, independent durations: concurrent calls are not task latency.
    retry.toolCalls = [0, 10, 10, 30, 50, 70, 90, 110, 150, 900, null, null].map((durationMs, i) => ({
        ...structuredClone(original), toolCallId: "investigate-" + String(i).padStart(2, "0"), startEventId: "investigate-start-" + i,
        durationMs, completedAt: durationMs === null ? null : new Date(Date.parse(original.startedAt) + durationMs).toISOString(),
        toolSucceeded: i === 8 ? false : i === 11 ? null : true,
        reportedOutcome: i === 8 ? "failed" : i === 11 ? "unknown" : "succeeded",
        requestArgs: i === 10 ? {} : { entityUrls: ["/me/drive/root", ...(i === 9 ? ["/me/messages"] : [])] },
        apiResults: i === 9 ? Array.from({ length: 9 }, (_, index) => ({
            index: 7, ...(index === 0 ? {} : { path: index === 8 ? "/me/messages" : "/me/drive/items/invented-" + index }),
            statusCode: index === 8 ? 429 : 200, durationMs: index === 8 ? 800 : index === 1 ? 0 : null,
        })) : [],
    }));
    retry.followUpPrompts = [];
    retry.graphActivities = graphMatrixRecord("call-graph").graphActivities.map(row => ({
        ...row, scenarioId: retry.scenarioId, sourceSessionId: retry.sourceSessionId,
    }));
    retry.graphActivities.push({ ...structuredClone(retry.graphActivities[0]), activityId: "code-reference",
        evidenceLevel: "code-reference", httpStatus: null, statusBasis: "none" });
    retry.httpRecords = [200, 503, null].map((status, index) => ({
        recordId: "owned-" + index, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: status !== null, responseOrigin: status === null ? null : "https://graph.microsoft.com",
        method: "GET", apiVersion: "v1.0", responsePath: { path: "/me/drive/root", query: [] },
        startedAt: original.startedAt, durationMs: [20, 5, null][index], status,
        transportError: status === null ? "TimeoutError" : null,
    }));
    const unrelated = fixture("unrelated-call-group");
    unrelated.sourceSessionId = "unrelated-chat";
    unrelated.followUpPrompts = [];
    unrelated.userPrompt.text = "UNRELATED_CALL_CONTEXT";
    return [...records, unrelated];
}
