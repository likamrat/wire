import { COWORK_SOURCE_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";

// Invented source records, never retained account or provider data.
export function coworkSourceContext() {
    return {
        scope: { harness: "microsoft-365-copilot", surface: "cowork", conversationId: "invented-session",
            account: { tenantId: "invented-tenant", subjectId: "invented-subject", verification: "unqualified" } },
        capture: { captureId: "invented-capture", capturedAt: "2026-01-02T00:00:00.000Z", generation: 4,
            parserVersion: COWORK_SOURCE_ADAPTER_VERSION, sourceSchema: "invented-compact-events",
            operation: "history-read", bodyDigest: "a".repeat(64), origin: "https://invented.invalid" },
    };
}

export function sourceObservation(record, ordinal = 0) {
    return {
        record,
        source: { sourceDocument: "invented-response", pointer: `/messages/${ordinal}` },
        ordering: { pageOrdinal: 0, recordOrdinal: ordinal, completeness: "response-only" },
    };
}

export function coworkSourceFixture() {
    return [
        sourceObservation({ task: { sessionId: "invented-session", taskId: "invented-task", state: "completed",
            ic3ThreadId: "invented-thread" }, snapshot: { activeModel: "invented-model" } }),
        sourceObservation({ id: "seq:3", event: "ts", data: {
            tid: "invented-batch", tn: "mcp__graph__CallGraph", aid: "invented-collision", ts: 1700000000,
            inp: JSON.stringify({ method: "POST", body: { requests: Array.from({ length: 20 }, (_, i) =>
                ({ id: `member-${i}`, method: "GET", url: "/invented" })) } }),
        } }, 1),
        sourceObservation({ id: "seq:4", event: "ta", data: { aid: "invented-collision", tid: "invented-batch",
            params: { neverBorrowThisInput: true } } }, 2),
        sourceObservation({ id: "seq:5", event: "taa", data: { aid: "invented-collision", approved: true,
            tid: "not-a-tool-link" } }, 3),
        sourceObservation({ id: "seq:8", event: "tx", data: { tid: "invented-batch",
            tn: "mcp__graph__CallGraph", ok: true, dur: 12, ts: 1700000012,
            wr: [{ u: "https://invented.invalid/private", t: "PRIVATE_REFERENCE", tp: 2 }, { u: null, s: "PRIVATE_TEXT" }],
        } }, 4),
        sourceObservation({ id: "seq:9", event: "ts", data: { tid: "invented-move",
            tn: "mcp__outlook__MoveMessage" } }, 5),
        sourceObservation({ id: "seq:10", event: "tx", data: { tid: "invented-move",
            tn: "mcp__outlook__MoveMessage", ok: false, err: "PRIVATE_ERROR_PROSE", dur: 3 } }, 6),
        sourceObservation({ id: "seq:11", event: "sa", data: { tid: "invented-collision" } }, 7),
        sourceObservation({ id: "seq:12", event: "future-event", data: { tid: "not-a-call", aid: "not-an-agent",
            payload: "UNKNOWN_PRIVATE_PAYLOAD" } }, 8),
    ];
}
