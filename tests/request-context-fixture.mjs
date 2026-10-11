import { extractScenarios } from "../lib/history.mjs";

export function retainedContextFixture() {
    const at = second => `2026-09-30T12:00:${String(second).padStart(2, "0")}Z`;
    const prompt = (id, second, content) => ({ id, timestamp: at(second), type: "user.message",
        data: { content, source: "user", messageId: id } });
    const call = (id, second, success) => [
        { id: `start-${id}`, timestamp: at(second), type: "tool.execution_start",
            data: { toolName: "workiq-fetch", toolCallId: id, arguments: { entityUrl: "/me/drive/root/children" } } },
        { id: `end-${id}`, timestamp: at(second + 1), type: "tool.execution_complete",
            data: { toolCallId: id, success, ...(success ? {} : { error: { code: "failure",
                message: "Re-authentication required for MCP server 'workiq'. Run /mcp auth workiq." } }) } },
    ];
    const events = [
        prompt("five", 0, "Find five synthetic documents."),
        ...call("failed-lookup", 1, false),
        prompt("three", 4, "Three synthetic documents are enough.\n  Keep these spaces.  \n"),
        ...call("retry-lookup", 5, true),
        { id: "reply-three", timestamp: at(7), type: "assistant.message",
            data: { content: "Here are three synthetic documents:\nResearch / Architecture / Design", phase: "final_answer",
                turnId: "turn-three", originatingMessageId: "three", toolRequests: [] } },
        { id: "turn-end", timestamp: at(8), type: "assistant.turn_end", data: { turnId: "turn-three" } },
        prompt("later", 10, "Separate synthetic topic."),
        ...call("later-call", 11, true),
        prompt("far", 14, "More unrelated synthetic work."),
        ...call("far-call", 15, true),
    ];
    const source = { sessionId: "synthetic-context-chat", name: "Invented document lookup", projectId: "synthetic-project", project: "Invented project" };
    return { events, records: extractScenarios(events, source, at(0), at(59)).scenarios };
}
