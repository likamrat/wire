import { fixture } from "./helpers.mjs";

export const privateQuery = "INVENTED_PARITY_NEEDLE";
export const scopeOptions = { layer: "tool", groupBy: "workload", bucket: "day", limit: 2,
    timeContext: { timeZone: "UTC", locale: "en-US" }, filters: { scope: "history" } };
export function scopeRecords() {
    const records = Array.from({ length: 10 }, (_, i) => {
        const record = fixture(`parity-request-${i}`);
        record.sourceSessionId = `parity-chat-${i}`;
        record.sourceSessionName = `Invented parity chat ${i}`;
        record.userPrompt = { text: `${i < 9 ? privateQuery : "Outside cohort"} request ${i}`, status: "full",
            authorship: { actor: i % 2 ? "agent" : "user", basis: i % 2 ? "source-agent" : "source-user" },
            sourceEventId: `parity-prompt-${i}`, sourceTimestamp: "2026-09-30T12:00:00.000Z" };
        record.followUpPrompts = [];
        const targets = i === 0 ? [["/me/drive/root", "/me/messages"], [], ["/me/events"]] : [["/me/drive/root"]];
        record.toolCalls = targets.map((paths, j) => ({
            tool: paths.length ? "workiq-fetch" : "workiq-ask", toolCallId: `parity-call-${i}-${j}`, startEventId: `parity-start-${i}-${j}`,
            completionEventId: `parity-end-${i}-${j}`, requestArgs: paths.length ? { entityUrls: paths } : { question: "Invented assistance request." },
            startedAt: i === 8 ? "2026-10-01T12:00:00.000Z" : "2026-09-30T12:00:00.000Z",
            durationMs: i === 0 ? [100, 300, 900][j] : i * 1000,
            completedAt: new Date(Date.parse(i === 8 ? "2026-10-01T12:00:00.000Z" : "2026-09-30T12:00:00.000Z")
                + (i === 0 ? [100, 300, 900][j] : i * 1000)).toISOString(),
            toolSucceeded: j === 2 || i % 3 !== 0, reportedOutcome: j === 2 || i % 3 !== 0 ? "succeeded" : "failed",
            apiResults: (paths.length ? paths : [null]).map((path, index) => ({
                index, ...(path ? { path } : {}), statusCode: j === 2 || i % 3 !== 0 ? 200 : 503,
            })), observedGraphHttp: false,
        }));
        return record;
    });
    records[0].toolCalls.push(structuredClone(records[0].toolCalls[0]));
    return [...records, { ...structuredClone(records[0]), scenarioId: "parity-legacy-alias", isLegacy: true }];
}
