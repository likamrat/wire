import { retainEvent } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";

export const imageReminder = "\n\n<system_reminder>\nThe user mentioned images and they have been attached to this message in the order they were mentioned.\n</system_reminder>";
export const imageReferences = "\n\nImage input references (select only for requested edits or reference-based generation). IDs use retained bytes; old or oversized attachments may be resized previews. Use an authorized file path when original fidelity is required:\n";

export function fidelityEvents(actor = "user", now = Date.parse("2026-10-01T12:00:00Z")) {
    const content = "Inspect the invented workspace without changing records.";
    const timestamp = new Date(now).toISOString();
    const sender = actor === "agent" ? "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n" : "";
    return [
        { id: "prompt", type: "user.message", timestamp, data: {
            content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle",
            attachments: [{ type: "file", path: "C:\\invented\\screen.png", displayName: "screen.png",
                assetId: "sha256:" + "1".repeat(64), mimeType: "image/png", byteLength: 100 }],
            ...(actor === "unknown" ? {} : {
                transformedContent: `<current_datetime>${timestamp}</current_datetime>\n\n` + sender + content
                    + imageReminder + imageReferences + JSON.stringify([{ attachment: 1, image_id: "sha256:" + "1".repeat(64) }]),
            }),
        } },
        { id: "start", type: "tool.execution_start", timestamp: new Date(now + 1000).toISOString(),
            data: { toolCallId: "invented-call", toolName: "workiq-do_action", arguments: { actionUrl: "/businessapps/me" } } },
        { id: "complete", type: "tool.execution_complete", timestamp: new Date(now + 31547).toISOString(),
            data: { toolCallId: "invented-call", success: false, error: { code: "failure",
                message: "MCP server 'workiq': " + JSON.stringify({ statusCode: 503, data: null, requestId: "EXCLUDED_REQUEST_ID" }) } } },
    ];
}

export function collectFidelity(source, { retained = true, sessionId = "invented-session" } = {}) {
    const events = retained ? source.map(event => retainEvent(event, { credentialExclusions: 0 })) : source;
    return extractScenarios(events, { sessionId, appId: null, appUrl: null, projectId: null,
        name: "Invented source", checkedAt: source[0].timestamp },
    source[0].timestamp, source.at(-1).timestamp).scenarios[0];
}

export function legacyFidelityRecord(source = fidelityEvents()) {
    const record = collectFidelity(source);
    record.userPrompt.authorship = { actor: "unknown", basis: "invalid-source" };
    record.userPrompt.authorshipVersion = 5;
    record.toolCalls[0].failureEvidence.diagnostic = { version: 1, source: "completion-error", status: "unsupported-format", code: "failure" };
    return record;
}
