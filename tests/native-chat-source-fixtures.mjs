import { envelope } from "./native-read-model-fixtures.mjs";

// Invented observations only; these are not captured Microsoft messages.
export function chatSource(record, ordinal = 0) {
    const { scope, capture, ordering } = envelope("chat", {}, {}, {}, ordinal);
    ordering.frameOrdinal = 2;
    return { scope, capture, ordering, source: {
        sourceDocument: "invented-chat-response", pointer: `/frames/2/messages/${ordinal}`, responsePointer: "/frames/2",
    }, responseRequestId: "invented-envelope-request", record };
}

export function nativeCallsSource() {
    return chatSource({
        messageId: "invented-message", storageMessageId: "invented-storage",
        requestId: "invented-message-request", author: "bot", messageType: "Progress",
        invocation: JSON.stringify([
            JSON.stringify({ id: "invented-call-one", type: "function",
                function: { name: "invented_lookup", arguments: { query: "First invented query" } } }),
            { id: "invented-call-two", type: "function", function: { name: "invented_second", arguments: "" } },
        ]),
        metadata: { ignored: "RAW_METADATA_NOT_RETAINED" }, error: "RAW_ERROR_PROSE_NOT_RETAINED",
    }, 4);
}
