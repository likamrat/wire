import { NATIVE_READ_CONTRACT } from "../lib/native-read-model.mjs";

// Invented records only; no native sample, account, cursor or conversation data.
const account = { tenantId: "invented-tenant", subjectId: "invented-subject", verification: "verified" };
export const recorded = value => ({ availability: "recorded", value });
export const absent = reason => ({ availability: "absent-in-response", reason });
export function envelope(surface, record, fields = {}, outcomes = {}, ordinal = 0) {
    const pointers = { message: surface === "chat" ? "/text" : "/data/t", input: surface === "chat" ? "/invocation" : "/data/inp",
        toolName: surface === "chat" ? "/invocation" : "/data/tn", approval: "/data/approved", failure: "/data/err",
        model: "/snapshot/activeModel", callElapsed: "/data/dur", resultReferences: "/data/wr",
        taskOutcome: "/task/state", toolOutcome: surface === "chat" ? "/messageType" : "/data/ok", returnedResults: "/data/out" };
    if (fields.message?.value?.representation === "card-text") pointers.message = "/adaptiveCards/0/body/0/text";
    const evidenceReferences = Object.fromEntries([...Object.keys(fields),
        ...Object.keys(outcomes).map(name => ({ task: "taskOutcome", tool: "toolOutcome", nestedApi: "returnedResults" })[name])]
        .map(name => [name, { sourceDocument: "invented-native-response", pointer: pointers[name] }]));
    return {
        contractVersion: NATIVE_READ_CONTRACT,
        scope: { harness: "microsoft-365-copilot", surface, account: { ...account }, conversationId: `invented-${surface}-conversation` },
        capture: { captureId: "invented-capture", capturedAt: "2026-01-01T00:00:00.000Z", generation: 7,
            parserVersion: "invented-fixture", sourceSchema: "invented-native-schema", operation: "history-read",
            origin: "https://invented.invalid", bodyDigest: "a".repeat(64) },
        record, ordering: { pageOrdinal: 0, recordOrdinal: ordinal, completeness: "response-only" },
        qualifiedFields: fields, evidenceReferences, outcomes, coverage: [],
    };
}
export function chatFixture() {
    const user = { messageId: "invented-user", storageMessageId: "invented-user-store", requestId: "invented-turn", author: "user" };
    const reply = { messageId: "invented-reply", storageMessageId: "invented-reply-store", requestId: "invented-turn", author: "bot" };
    return [
        envelope("chat", user, { message: recorded({ author: "user", representation: "plain-text", text: "An invented question." }) }, {}, 0),
        envelope("chat", reply, { message: recorded({ author: "assistant", representation: "plain-text", text: "First invented reply." }) }, {}, 1),
        envelope("chat", reply, { message: recorded({ author: "assistant", representation: "card-text", text: "An invented card representation." }) }, {}, 1),
    ];
}
export function coworkFixture() {
    const input = { method: "POST", body: { requests: [{ id: "invented-member-a" }, { id: "invented-member-b" }] } };
    const rows = [
        envelope("cowork", { task: { sessionId: "invented-cowork-conversation", state: "completed" } }, {}, {
            task: { unit: "native-task", state: "completed", basis: "task.state", aggregateToolSuccess: false },
        }),
        envelope("cowork", { id: "seq:1", event: "u", data: { id: "invented-human" } }, {
            message: recorded({ author: "user", representation: "follow-up", text: "Read the invented records." }),
        }, {}, 1),
        envelope("cowork", { id: "seq:3", event: "ts", data: { tid: "invented-batch", tn: "mcp__graph__CallGraph",
            inp: JSON.stringify(input), aid: "invented-agent" } }, {
            toolName: recorded("mcp__graph__CallGraph"), input: recorded(input),
        }, {}, 2),
        envelope("cowork", { id: "seq:4", event: "ta", data: { aid: "invented-approval", tid: "invented-batch" } }, {}, {}, 3),
        envelope("cowork", { id: "seq:5", event: "taa", data: { aid: "invented-approval", approved: true } }, { approval: recorded(true) }, {}, 4),
        envelope("cowork", { id: "seq:8", event: "tx", data: { tid: "invented-batch", tn: "mcp__graph__CallGraph", ok: true, dur: 12 } }, {
            toolName: recorded("mcp__graph__CallGraph"),
            callElapsed: { ...recorded(12), unit: "ms", basis: "tx.data.dur", boundary: "provider-tool-duration", comparableToUserResponseLatency: false },
            model: { availability: "unqualified", reason: "snapshot-model-is-not-per-call-model" },
        }, {
            tool: { unit: "native-tool", state: "succeeded", basis: "tx.data.ok" },
            nestedApi: { unit: "nested-api-result", availability: "absent-in-response", observed: [],
                declaredRequestCount: 2, declaredRequestCountIsSuccessDenominator: false },
        }, 5),
        envelope("cowork", { id: "seq:9", event: "tx", data: { tid: "invented-search", tn: "mcp__m365_search__SearchM365", ok: true } }, {
            toolName: recorded("mcp__m365_search__SearchM365"),
            resultReferences: recorded({ nativeField: "wr", cardinality: 2, itemFieldTypes: { u: { string: 2 }, t: { string: 2 } } }),
        }, { tool: { unit: "native-tool", state: "succeeded", basis: "tx.data.ok" } }, 6),
        envelope("cowork", { id: "seq:10", event: "sa", data: { tid: "invented-agent", sat: "invented-agent-type" } }, {}, {}, 7),
        envelope("cowork", { id: "seq:11", event: "invented_future_event", data: { aid: "not-qualified-as-agent", payload: "UNRELATED_RAW_PAYLOAD" } }, {}, {}, 8),
        envelope("cowork", { id: "seq:12", event: "ts", data: { tid: "invented-missing-input", tn: "mcp__outlook__MoveMessage" } }, {
            toolName: recorded("mcp__outlook__MoveMessage"), input: absent("field-absent-from-read-response"),
        }, {}, 9),
        envelope("cowork", { id: "seq:13", event: "tx", data: { tid: "invented-missing-input", tn: "mcp__outlook__MoveMessage", ok: false,
            err: "RAW_ERROR_PROSE_NOT_FOR_READ_MODEL" } }, {
            failure: recorded({ code: null, messageStatus: "text-excluded", messageSignal: null }),
        }, { tool: { unit: "native-tool", state: "failed", basis: "tx.data.ok" } }, 10),
    ];
    rows[2].coverage.push({ kind: "sequence-domain-unqualified", meaning: "Unrepresented sequence values are not a count of lost tool calls.",
        observedMissingIntegers: 1, inferredLostEvents: null });
    return rows;
}
export function imageFixture() {
    const call = { type: "function", id: "invented-image-call", function: { name: "image_gen", arguments: { prompt: "An invented square." } } };
    return ["Progress", "InternalContentDescription", "ImageGenerationComplete"].map((messageType, ordinal) => envelope("chat", {
        messageId: `invented-image-${ordinal}`, ...(ordinal === 1 ? {} : { storageMessageId: `invented-image-store-${ordinal}` }),
        author: ordinal === 1 ? "tool" : "bot", requestId: "invented-image-turn", messageType,
        invocation: JSON.stringify([ordinal === 2 ? call : JSON.stringify(call)]),
    }, { toolName: recorded("image_gen"), input: recorded(call.function.arguments) }, {
        tool: { unit: "native-tool", state: "unknown", basis: "no-qualified-native-outcome-field" },
    }, ordinal));
}

export function multiCallChatFixture() {
    const calls = [
        { id: "invented-image-call", type: "function", function: { name: "image_gen", arguments: { prompt: "First invented input." } } },
        { id: "invented-lookup-call", type: "function", function: { name: "invented_native_lookup", arguments: { query: "Second invented input.", limit: 2 } } },
    ];
    const row = envelope("chat", {
        messageId: "invented-multi-message", storageMessageId: "invented-multi-storage",
        requestId: "invented-multi-turn", author: "bot",
        invocation: JSON.stringify([JSON.stringify(calls[0]), calls[1]]),
    }, { message: recorded({ author: "assistant", representation: "plain-text", text: "An invented multi-call observation." }) }, {}, 4);
    row.ordering.pageOrdinal = 2;
    row.ordering.frameOrdinal = 1;
    row.callFacts = calls.map(call => ({
        nativeCallId: call.id,
        qualifiedFields: { toolName: recorded(call.function.name), input: recorded(call.function.arguments) },
        evidenceReferences: Object.fromEntries(["toolName", "input"].map(name => [
            name, { sourceDocument: "invented-native-response", pointer: "/invocation" },
        ])),
    }));
    return row;
}
