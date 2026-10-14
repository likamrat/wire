import { fixture } from "./helpers.mjs";

export const modelNames = ["gpt-5.4", "claude-sonnet-4.6", "deployment/Exact Model", "deployment/Long-Recorded-Model-Name-Without-A-Guessed-Backing-Model"];
export const modelOptions = { layer: "tool", groupBy: "workload", bucket: "week", limit: 8,
    filters: { scope: "history" }, timeContext: { timeZone: "UTC", locale: "en-US" } };

export function modelRecords() {
    const days = ["2026-10-14", "2026-10-14", "2026-10-12", "2026-09-30", "2026-10-01", "2026-10-14", "2026-10-14", "2026-10-13", "2026-10-13"];
    const models = [[modelNames[0], modelNames[0], modelNames[0]], [modelNames[0], modelNames[1], modelNames[0]],
        [modelNames[2], null], [], [modelNames[0]], [], [modelNames[0]], [null], [modelNames[1], modelNames[3]]];
    const records = days.map((day, index) => {
        const record = fixture(`model-request-${index}`);
        record.sourceSessionId = `model-chat-${index}`;
        record.sourceSessionName = "Invented model chart history";
        record.title = `Invented model instruction ${index}`;
        record.capturedAt = `${day}T12:00:00.000Z`;
        record.userPrompt = { text: `Invented model instruction ${index}`, status: "full",
            provenance: index === 2 ? "agent-authored" : "human-authored",
            authorship: index === 2 ? { actor: "agent", basis: "source-agent" } : { actor: "user", basis: "source-user" },
            sourceEventId: `model-prompt-${index}`, sourceTimestamp: record.capturedAt };
        const call = record.toolCalls[0];
        call.startedAt = record.capturedAt;
        call.requestArgs = { entityUrls: [index % 2 ? "/me/drive/root/children" : "/me/messages"] };
        call.requestedApiPath = call.requestArgs.entityUrls[0];
        call.toolSucceeded = index !== 1; call.reportedOutcome = index === 1 ? "failed" : "succeeded";
        if (index === 5) { call.tool = "workiq-get_schema"; call.model = "not-an-original-model"; }
        if (index === 0) record.toolCalls.push(...[1, 2].map(offset => ({ ...call,
            toolCallId: `model-extra-${offset}`, startEventId: `model-extra-start-${offset}`,
            toolSucceeded: offset !== 1, reportedOutcome: offset === 1 ? "failed" : "succeeded" })));
        if (models[index].length) record.originalModelEvidence = {
            version: 1, sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt.sourceEventId,
            promptMessageId: `model-message-${index}`, partial: false, ambiguous: false,
            responses: models[index].map((model, offset) => ({
                eventId: `model-response-${index}-${offset}`, apiCallId: `model-api-${index}-${offset}`,
                at: `${day}T12:00:0${offset + 1}.000Z`, turnId: `model-turn-${index}-${offset}`,
                model, modelStatus: model ? "recorded" : "missing",
            })),
        };
        if (index === 4) record.originalModelEvidence.responses.push({
            ...record.originalModelEvidence.responses[0], model: "conflicting-model",
        });
        if (index === 6) record.originalModelEvidence.version = 99;
        record.model = "current-default-not-original";
        return record;
    });
    records.push({ ...structuredClone(records[0]), scenarioId: "model-alias" });
    return records;
}
