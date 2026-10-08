import { fixture } from "./helpers.mjs";

export function serviceEvidenceFixture() {
    const record = fixture("service-evidence");
    record.userPrompt = { text: "Invented service-evidence example.", status: "full", sourceEventId: "invented-prompt",
        sourceTimestamp: "2026-10-01T12:00:00.000Z" };
    record.followUpPrompts = [];
    record.toolCalls = [
        ["ask", { question: "Invented question; do not infer a service from this." }, true],
        ["fetch", { entityUrls: ["/shares/u!INVENTED-PRIVATE-SHARING-TOKEN/driveItem?$select=id,name"] }, true],
        ["fetch", { entityUrls: ["/shares/u!ANOTHER-INVENTED-TOKEN/driveItem?$select=id"] }, false],
        ["fetch", { entityUrls: ["/unsupported/resource"] }, true],
        ["fetch", { entityUrls: [] }, null],
        ["get_schema", { path: "/shares/u!INVENTED-SCHEMA-TOKEN/driveItem", operationType: "fetch" }, true],
    ].map(([operation, requestArgs, success], index) => ({
        tool: `workiq-${operation}`, toolCallId: `service-evidence-call-${index}`, startEventId: `service-evidence-start-${index}`,
        completionEventId: success === null ? null : `service-evidence-end-${index}`,
        startedAt: "2026-10-01T12:00:01.000Z", completedAt: success === null ? null : "2026-10-01T12:00:02.000Z",
        durationMs: success === null ? null : 1000, requestArgs, toolSucceeded: success,
        reportedOutcome: success === null ? "unknown" : success ? "succeeded" : "failed",
        apiResults: index === 1 ? [{ index: 0, statusCode: 200 }] : index === 2 ? [{ index: 0, statusCode: 403 }] : [],
        observedGraphHttp: false,
    }));
    return record;
}
