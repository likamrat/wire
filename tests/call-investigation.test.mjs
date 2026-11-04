import test from "node:test";
import assert from "node:assert/strict";
import { createCallInvestigation } from "../web/call-investigation.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { projectNativeReadModel } from "../lib/native-read-model.mjs";
import { multiCallChatFixture } from "./native-read-model-fixtures.mjs";

test("native readers preserve literal call identity without legacy toolCalls or sibling substitution", () => {
    const calls = createCallInvestigation(), native = projectNativeReadModel([multiCallChatFixture()]).conversations[0];
    const record = { recordKind: "native-conversation", scenarioId: native.key, nativeConversation: native };
    const rows = native.calls.map(call => ({ id: call.key, scenarioId: native.key, toolCallId: call.nativeCallId }));
    const route = { view: "request", request: native.key, layer: "tool", call: rows[1].id };
    const resolved = calls.resolve({ tool: rows }, [record], route, 1);
    assert.equal(resolved.source, native.calls[1]);
    assert.equal(resolved.actionId, native.calls[1].key);
    assert.equal(calls.resolve({ tool: rows }, [record], { ...route, call: "1" }, 1).status, "unavailable");
    assert.equal(calls.resolve({ tool: rows }, [{ ...record, nativeConversation: { ...native, calls: native.calls.slice(0, 1) } }], route, 1).status, "unavailable");
    assert.equal(record.toolCalls, undefined);
});

test("homepage failure entry selects the first matching canonical failure in retained log order", () => {
    const calls = createCallInvestigation(createRequestContext().compare);
    const source = { scenarioId: "group", toolCalls: [
        { toolCallId: "later", startedAt: "2026-10-01T12:00:03Z" },
        { toolCallId: "first", startedAt: "2026-10-01T12:00:01Z" },
        { toolCallId: "second", startedAt: "2026-10-01T12:00:02Z" },
    ] };
    const rows = source.toolCalls.map(call => ({ id: call.toolCallId, scenarioId: "group", toolCallId: call.toolCallId, outcome: "failure" }));
    const route = { view: "request", request: "group", layer: "tool" };
    assert.deepEqual(calls.firstFailure({ tool: rows }, [source], [rows[0], rows[2]], route, 1),
        { ...route, call: "second" });
    assert.deepEqual(source.toolCalls.map(call => call.toolCallId), ["later", "first", "second"]);
});

test("failure entry preserves explicit targets and fails closed on missing ownership without promoting a successful parent", () => {
    const calls = createCallInvestigation(createRequestContext().compare);
    const records = [{ scenarioId: "group", toolCalls: [{ toolCallId: "success" }, { toolCallId: "failure" }] }];
    const rows = [
        { id: "success", scenarioId: "group", toolCallId: "success", outcome: "success" },
        { id: "failure", scenarioId: "group", toolCallId: "failure", outcome: "failure" },
    ];
    const activity = { tool: rows, "reported-api": [{ id: "child", scenarioId: "group", parentCallId: "success", outcome: "failure" }] };
    const route = { view: "request", request: "group", layer: "tool" };
    assert.equal(calls.firstFailure(activity, records, rows, { ...route, call: "success" }, 1), null);
    for (const layer of ["reported-api", "http", "code-reference"]) assert.equal(calls.firstFailure(activity, records, rows, { ...route, layer }, 1), null);
    assert.equal(calls.firstFailure(activity, records, [{ ...rows[0], outcome: "failure" }], route, 1), null);
    assert.equal(calls.firstFailure(activity, records, [{ ...rows[0], outcome: "unknown" }], route, 1), null);
    const unavailable = { id: "missing", scenarioId: "group", outcome: "failure" };
    assert.deepEqual(calls.firstFailure(activity, records, [unavailable, rows[1]], route, 1), { ...route, call: "missing" });
});

test("duration ordering is measured, stable by canonical ID, and keeps unavailable values separate", () => {
    const calls = createCallInvestigation();
    const rows = [
        { id: "unknown", durationMs: null }, { id: "b", durationMs: 10 },
        { id: "slow", durationMs: 100 }, { id: "a", durationMs: 10 },
        { id: "zero", durationMs: 0 }, { id: "invalid", durationMs: -1 },
        { id: "missing" }, { id: "infinite", durationMs: Infinity },
    ];
    assert.deepEqual(calls.order(rows).map(row => row.id), ["slow", "a", "b", "zero", "infinite", "invalid", "missing", "unknown"]);
    assert.deepEqual(calls.order([...rows].reverse()).map(row => row.id), calls.order(rows).map(row => row.id));
    assert.deepEqual(calls.order(rows, "fastest").map(row => row.id), ["zero", "a", "b", "slow", "infinite", "invalid", "missing", "unknown"]);
    assert.equal(calls.order(rows)[0], rows[2]);
    assert.equal(rows[0].id, "unknown");
    assert.equal(calls.duration({ durationMs: 20 }, "code-reference"), null);
    assert.equal(calls.duration({ durationMs: 20 }, "direct-request"), null);
});

test("start-event, Graph sites, visible statuses, code references and owned HTTP retain their own identity", () => {
    const calls = createCallInvestigation();
    const scenario = { scenarioId: "group", sourceSessionId: "chat", toolCalls: [{ startEventId: "event" }],
        graphActivities: [{ activityId: "site" }, { activityId: "code" }], httpRecords: [{ recordId: "http" }] };
    const activity = {
        tool: [{ id: 'event:["chat","event"]', scenarioId: "group" }],
        "direct-request": [{ id: "site-id", scenarioId: "group", activityId: "site" }],
        "recorded-http": [{ id: "site-id", scenarioId: "group", activityId: "site" }],
        "code-reference": [{ id: "code-id", scenarioId: "group", activityId: "code" }],
        http: [{ id: "http-id", scenarioId: "group", recordId: "http" }],
    };
    for (const [layer, rows] of Object.entries(activity)) {
        const result = calls.resolve(activity, [scenario], { request: "group", layer, call: rows[0].id });
        assert.equal(result.status, "available");
        assert.equal(result.row, rows[0]);
        assert.equal(result.actionId, rows[0].id);
    }
    scenario.toolCalls.push({ startEventId: "event" });
    assert.equal(calls.resolve(activity, [scenario], { request: "group", call: activity.tool[0].id }).source, scenario.toolCalls[0]);
    activity["reported-api"] = [{ id: "orphan", scenarioId: "group", parentCallId: "absent" }];
    assert.equal(calls.resolve(activity, [scenario], { request: "group", layer: "reported-api", call: "orphan" }).status, "unavailable");
});

test("exact targets use canonical identity and API parent links, never an index or nearby action", () => {
    const calls = createCallInvestigation();
    const scenario = { scenarioId: "group", sourceSessionId: "chat",
        toolCalls: [{ toolCallId: "first" }, { toolCallId: "second" }] };
    const first = { id: "canonical-first", scenarioId: "group", toolCallId: "first" };
    const second = { id: "canonical-second", scenarioId: "group", toolCallId: "second" };
    const api = { id: "canonical-result", scenarioId: "group", parentCallId: second.id };
    const activity = { tool: [first, second], "reported-api": [api] };
    const route = { request: "group", layer: "tool", call: second.id };
    assert.equal(calls.resolve(activity, [scenario], route).row, second);
    assert.equal(calls.resolve(activity, [scenario], route).source, scenario.toolCalls[1]);
    const apiRoute = { ...route, layer: "reported-api", call: api.id, callRevision: "12" };
    const target = calls.resolve(activity, [scenario], apiRoute, 12);
    assert.equal(target.row, api);
    assert.equal(target.actionId, second.id);
    assert.equal(calls.resolve(activity, [scenario], apiRoute, 13).status, "unavailable");
    assert.equal(calls.resolve(activity, [scenario], { ...apiRoute, callRevision: undefined }, 12).status, "unavailable");
    for (const changes of [{ call: "1" }, { call: "removed" }, { request: "elsewhere" }, { layer: "http" }]) {
        assert.equal(calls.resolve(activity, [scenario], { ...route, ...changes }).status, "unavailable");
    }
    scenario.toolCalls.pop();
    assert.equal(calls.resolve(activity, [scenario], route).status, "unavailable");
    assert.equal(calls.resolve(activity, [scenario], { ...route, call: undefined }).status, "none");
});
