import { fixture } from "./helpers.mjs";

// Software-test inputs only. These are never used as product evaluation results.
const START = "2026-10-01T12:00:00.000Z";
const paths = ["/me/messages", "/me/calendarView", "/me/drive/items/example-item", "/me/contacts"];
export function matrixRecords(name, outcomes, { durations = [], api = [], groups = 1, batch = false } = {}) {
    return Array.from({ length: groups }, (_, group) => {
        const record = fixture(`${name}-group-${group}`);
        record.userPrompt.sourceEventId = `${name}-prompt-${group}`;
        record.userPrompt.text = `PRIVATE_MATRIX_${name} legitimate fixture wording, not a user record.`;
        record.followUpPrompts = [];
        record.toolCalls = outcomes.flatMap((outcome, index) => {
            if (index % groups !== group) return [];
            const duration = durations[index] ?? null;
            const endpoint = paths[index % paths.length];
            return [{
                tool: "workiq-fetch", toolCallId: `${name}-call-${index}`, startEventId: `${name}-start-${index}`,
                completionEventId: outcome === "unknown" ? null : `${name}-end-${index}`,
                order: index + 1, requestArgs: { entityUrls: batch ? [endpoint, paths[(index + 1) % paths.length]] : [endpoint] },
                requestedApiPath: endpoint,
                toolSucceeded: outcome === "success" ? true : outcome === "failure" ? false : null,
                reportedOutcome: ({ success: "succeeded", failure: "failed", partial: "partial", unknown: "unknown" })[outcome],
                startedAt: START,
                completedAt: duration === null ? null : new Date(Date.parse(START) + duration).toISOString(),
                durationMs: duration,
                parallelGroup: batch ? `${name}-parallel` : null,
                apiResults: api.map((statusCode, resultIndex) => ({ index: resultIndex, statusCode, evidenceLevel: "intermediary-reported" })),
                observedGraphHttp: false,
            }];
        });
        return record;
    });
}

export function graphMatrixRecord(name) {
    const record = fixture(name);
    record.toolCalls = [];
    record.followUpPrompts = [];
    record.graphActivities = [200, 429, null].map((status, index) => ({
        activityId: `${name}-activity-${index}`, sourceSessionId: record.sourceSessionId, scenarioId: record.scenarioId,
        toolCallId: `${name}-shell-${index}`, startEventId: `${name}-start-${index}`, completionEventId: `${name}-end-${index}`,
        startedAt: START, tool: "shell",
        evidenceLevel: status === null ? "requested-direct-graph" : "output-visible-http",
        endpoint: { id: `${name}-endpoint-${index}`, label: "GET v1.0 /me/messages", path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: ["$select"] },
        workload: "Mail", method: "GET", httpStatus: status, statusBasis: status === null ? "none" : "explicit-output-status",
        requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false },
        evidenceRefs: [{ eventId: `${name}-start-${index}`, role: "request" }],
    }));
    return record;
}

export function reportMatrixCases() {
    const original = matrixRecords("alias", ["success", "failure", "partial", "unknown"], { durations: [1000], api: [200] })[0];
    const legacy = { ...structuredClone(original), scenarioId: "alias-legacy-copy", isLegacy: true };
    return [
        { name: "single-zero-duration-success", records: matrixRecords("single", ["success"], { durations: [0], api: [200] }), expected: { calls: 1, success: 1, failure: 0, partial: 0, unknown: 0, api: 1, timed: 1, median: 0 }, pdf: true },
        { name: "single-failure", records: matrixRecords("failed", ["failure"], { durations: [350], api: [503] }), expected: { calls: 1, success: 0, failure: 1, partial: 0, unknown: 0, api: 1, timed: 1, median: 350 } },
        { name: "all-unknown", records: matrixRecords("unknown", Array(8).fill("unknown")), expected: { calls: 8, success: 0, failure: 0, partial: 0, unknown: 8, api: 0, timed: 0, median: null }, pdf: true },
        { name: "all-partial", records: matrixRecords("partial", Array(4).fill("partial"), { durations: [100, null, 500, null] }), expected: { calls: 4, success: 0, failure: 0, partial: 4, unknown: 0, api: 0, timed: 2, median: 100 }, pdf: true },
        {
            name: "mixed-parallel-batches",
            records: matrixRecords("mixed", ["success", "success", "failure", "partial", "unknown", "success", "failure", "unknown", "success", "success", "partial", "success"], {
                durations: [0, 20, 50, 100, null, 200, 300, null, 500, 1000, 2000, 5000],
                api: [200, 429, null], groups: 3, batch: true,
            }),
            expected: { calls: 12, success: 6, failure: 2, partial: 2, unknown: 2, api: 36, timed: 10, median: 200 }, pdf: true,
        },
        {
            name: "successful-wrapper-failed-api",
            records: matrixRecords("wrapper", ["success", "success", "success"], { durations: [30, 60, 90], api: [500, 403] }),
            expected: { calls: 3, success: 3, failure: 0, partial: 0, unknown: 0, api: 6, timed: 3, median: 60 },
        },
        {
            name: "uneven-duration-pooling",
            records: matrixRecords("pool", Array(10).fill("success"), { durations: [1, 100, 2, 200, 3, 300, 4, 400, 5, 10000], groups: 3 }),
            expected: { calls: 10, success: 10, failure: 0, partial: 0, unknown: 0, api: 0, timed: 10, median: 5 },
        },
        {
            name: "high-volume-twelve-interactions",
            records: matrixRecords("volume", Array.from({ length: 240 }, (_, index) => index % 10 < 7 ? "success" : index % 10 < 9 ? "failure" : "unknown"), {
                durations: Array.from({ length: 240 }, (_, index) => index % 10 === 9 ? null : index % 10 * 25),
                groups: 12, api: [200],
            }),
            expected: { calls: 240, success: 168, failure: 48, partial: 0, unknown: 24, api: 240, timed: 216, median: 100 }, pdf: true,
        },
        { name: "graph-only-visible-and-missing-status", records: [graphMatrixRecord("graph")], expected: { calls: 0, success: 0, failure: 0, partial: 0, unknown: 0, api: 0, timed: 0, median: null, graph: 3 }, pdf: true },
        {
            name: "one-failure-among-ninety-nine-successes",
            records: matrixRecords("skewed", [...Array(99).fill("success"), "failure"]).map(record => ({
                ...record,
                toolCalls: record.toolCalls.map((call, index) => ({
                    ...call,
                    requestedApiPath: index === 99 ? "/me/calendarView" : "/me/messages",
                    requestArgs: { entityUrls: [index === 99 ? "/me/calendarView" : "/me/messages"] },
                })),
            })),
            expected: { calls: 100, success: 99, failure: 1, partial: 0, unknown: 0, api: 0, timed: 0, median: null },
        },
        { name: "duplicate-and-legacy-source-copies", records: [original, legacy], expected: { calls: 4, success: 1, failure: 1, partial: 1, unknown: 1, api: 4, timed: 1, median: 1000 }, canonicalSelection: true },
    ];
}
