import { fixture } from "./helpers.mjs";

// Invented retained interactions only; no source collection or provider work.
export function promptWidgetRecords() {
    const records = Array.from({ length: 18 }, (_, index) => {
        const record = fixture(`prompt-widget-${index}`);
        const actor = ["user", "agent", "unknown"][index % 3];
        const at = `2026-10-${String(14 - Math.floor(index / 3)).padStart(2, "0")}T12:00:00.000Z`;
        const basis = actor === "user" ? "source-user" : actor === "agent" ? index === 4 ? "autopilot" : "source-agent"
            : ["missing-source", "system-source", "conflicting-source", "unsupported-source", "invalid-source", "legacy-missing"][Math.floor(index / 3)];
        record.sourceSessionId = `prompt-widget-chat-${Math.floor(index / 3)}`;
        record.sourceSessionName = ["Cedar release review", "Harbor support planning", "Coastal calendar review"][index % 3];
        record.project = "Cedar operations";
        record.title = `Review ${index + 1}`;
        record.capturedAt = at;
        record.userPrompt = { status: index === 3 ? "unavailable" : "full",
            text: index === 3 ? null : index === 4 ? "" : `${index % 2 ? "Harbor" : "Cedar"} review: read the ${index % 2 ? "mail" : "calendar"} updates for planning item ${index + 1}.`,
            sourceEventId: `prompt-widget-origin-${index}`, sourceTimestamp: at,
            ...(basis === "legacy-missing" ? {} : { authorship: { actor, basis } }) };
        record.followUpPrompts = [{ text: "Cedar follow-up: retain the original author.", status: "full",
            authorship: { actor: "agent", basis: "source-agent" } }];
        record.toolCalls = Array.from({ length: 1 + index % 3 }, (_, call) => ({
            ...record.toolCalls[0], toolCallId: `prompt-widget-call-${index}-${call}`,
            startEventId: `prompt-widget-start-${index}-${call}`, startedAt: at,
            tool: index % 4 === 1 ? "workiq-retrieve" : "workiq-fetch",
            requestedApiPath: index % 2 ? "/me/messages" : "/me/calendarView",
            requestArgs: { entityUrls: [index % 2 ? "/me/messages" : "/me/calendarView"] },
            toolSucceeded: index % 2 === 0, reportedOutcome: index % 2 ? "failed" : "succeeded",
            apiResults: [{ index: 0, statusCode: index % 2 ? 403 : 200, evidenceLevel: "intermediary-reported" }],
        }));
        return record;
    });
    const alias = structuredClone(records[0]);
    alias.scenarioId = "prompt-widget-stored-alias";
    alias.isLegacy = true;
    return [...records, alias];
}
