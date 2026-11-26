// Invented originals, not retained collector events. Hook success deliberately
// disagrees with a successful completion.
export function withCausalHooks([prompt, assistant, start, completion], sessionId) {
    const { toolCallId, toolName, mcpToolName, arguments: args } = start.data;
    const inputs = [
        { toolCalls: [{ id: toolCallId, name: toolName, args }] },
        { timestamp: Date.parse(start.timestamp), toolCallId, serverName: "workiq", toolName: mcpToolName, arguments: args },
        { timestamp: Date.parse(start.timestamp), toolName, toolArgs: args, toolResult: { content: "Invented private hook result." } },
    ];
    let parentId = start.id;
    const hooks = ["preToolUse", "preMcpToolCall", "postToolUse"].flatMap((hookType, index) => {
        const hookInvocationId = `${start.id}-inv-${index}`;
        const begin = { id: `${hookInvocationId}-begin`, type: "hook.start", parentId, timestamp: start.timestamp,
            data: { hookInvocationId, hookType, input: { sessionId, ...inputs[index] } } };
        parentId = `${hookInvocationId}-end`;
        return [begin, { id: parentId, type: "hook.end", parentId: begin.id, timestamp: start.timestamp,
            data: { hookInvocationId, hookType, success: false } }];
    });
    return [prompt, assistant, start, ...hooks, { ...completion, parentId }];
}
