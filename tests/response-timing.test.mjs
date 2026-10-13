import test from "node:test";
import assert from "node:assert/strict";
import { retainResponseTimingEvent, recordedResponseTiming } from "../lib/response-timing.mjs";
import { buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { fixture } from "./helpers.mjs";
import { retainEvent, mergedRecords } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { filterDeletedRecords, eventIdentity, recordUnits } from "../lib/deletion-identities.mjs";
import { qualifyRetainedResponseTimings } from "../lib/response-timing-qualification.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

const time = ms => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + ms).toISOString();
function source(duration = 1200) {
    return [
        { id: "prompt", type: "user.message", timestamp: time(0), data: { content: "Private request", messageId: "m" } },
        { id: "answer", type: "assistant.message", timestamp: time(duration), data: { messageId: "a", originatingMessageId: "m",
            phase: "final_answer", turnId: "t", content: "PRIVATE_FINAL_ANSWER", reasoningText: "PRIVATE_REASONING", toolRequests: [] } },
        { id: "end", type: "assistant.turn_end", timestamp: time(duration + 5), data: { turnId: "t" } },
    ];
}
const prompt = { sourceEventId: "prompt", sourceTimestamp: time(0) };

test("timing projection keeps only explicit final/turn/message metadata, never response or reasoning text", () => {
    const [user, answer, end] = source();
    const projected = [user, retainResponseTimingEvent(answer), retainResponseTimingEvent(end)];
    assert.doesNotMatch(JSON.stringify(projected.slice(1)), /PRIVATE|content|reasoningText/);
    const timing = recordedResponseTiming(projected, prompt);
    assert.equal(timing.durationMs, 1200);
    assert.equal(timing.boundary, "recorded-request-to-final-answer");
    assert.equal(timing.finalEventId, "answer");
    assert.equal(timing.completionEventId, "end");
});

test("commentary, another prompt, subagent output, pending tool work and missing turn-end cannot establish a final response", () => {
    for (const change of [
        rows => { rows[1].data.phase = "commentary"; },
        rows => { rows[1].data.originatingMessageId = "other"; },
        rows => { rows[1].agentId = "child"; },
        rows => { rows[1].data.toolRequests = [{ toolCallId: "x" }]; },
        rows => { rows.pop(); },
        rows => { rows.splice(1, 0, { id: "new", type: "user.message", timestamp: time(20), data: { messageId: "new" } }); },
    ]) {
        const rows = source(); change(rows);
        assert.equal(recordedResponseTiming(rows, prompt).status, "unavailable");
    }
});

test("later work invalidates an earlier final marker; a later completed final replaces it", () => {
    const rows = source();
    rows.push({ id: "next", type: "assistant.turn_start", timestamp: time(1500), data: { turnId: "t2" } });
    assert.equal(recordedResponseTiming(rows, prompt).status, "unavailable");
    rows.push({ ...source(1800)[1], id: "a2", data: { ...source(1800)[1].data, turnId: "t2" } },
        { id: "e2", type: "assistant.turn_end", timestamp: time(1801), data: { turnId: "t2" } });
    assert.equal(recordedResponseTiming(rows, prompt).durationMs, 1800);
});

test("duplicate delivery is stable, conflicting events fail closed and subagent work cannot become a root response", () => {
    const rows = source();
    assert.equal(recordedResponseTiming([...rows, structuredClone(rows[1])], prompt).durationMs, 1200);
    assert.equal(recordedResponseTiming([...rows, { ...rows[1], timestamp: time(999) }], prompt).status, "unavailable");
    rows.push({ id: "child-start", type: "tool.execution_start", timestamp: time(1400), agentId: "child",
        data: { toolName: "workiq-fetch", toolCallId: "child-call", arguments: {} } });
    const projected = rows.map(event => event.type === "user.message" ? event : retainEvent(event, { credentialExclusions: 0 })).filter(Boolean);
    assert.equal(recordedResponseTiming(projected, prompt).durationMs, 1200);
});

test("new response metric preserves genuine zero and pools exact interaction samples into frozen report facts", () => {
    const records = [0, 1200, 5000].map((duration, index) => {
        const record = fixture(`response-${index}`);
        record.userPrompt = { ...record.userPrompt, sourceEventId: "prompt", sourceTimestamp: time(0) };
        record.sourceSessionId = `source-${index}`;
        record.responseTiming = recordedResponseTiming(source(duration), prompt);
        return record;
    });
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] };
    const model = buildAssessmentModel(state);
    const metric = model.overview.metrics.find(row => row.definitionId === "recorded-response-duration");
    assert.equal(metric.value, 1200);
    assert.deepEqual(metric.coverage, { covered: 3, eligible: 3 });
    assert.equal(metric.boundary, "recorded-request-to-final-answer");
    const facts = buildReportFacts(records, state).facts;
    assert.equal(facts.metrics.find(row => row.definitionId === metric.definitionId).value, 1200);
    assert.equal([...model.details.values()][0].metrics.find(row => row.definitionId === metric.definitionId).value, 0);
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_FINAL_ANSWER|PRIVATE_REASONING/);
});

test("snapshot catalog projects each qualified response duration without borrowing the overview", () => {
    const records = [0, 1200, 5000, null].map((duration, index) => {
        const record = fixture(`row-response-${index}`);
        record.sourceSessionId = `source-${index}`;
        record.userPrompt = { ...record.userPrompt, sourceEventId: "prompt", sourceTimestamp: time(0) };
        if (duration !== null) record.responseTiming = recordedResponseTiming(source(duration), prompt);
        return record;
    });
    const state = { revision: 9, evidenceRevision: 4, pseudonymKey: "a".repeat(64), evidence: records, exports: [] };
    const before = structuredClone(state), model = buildAssessmentModel(state);
    assert.deepEqual(model.catalog.map(row => row.responseTiming?.durationMs), [0, 1200, 5000, null]);
    for (const row of model.catalog) {
        assert.equal(row.responseTiming.schemaVersion, 1);
        assert.equal(row.responseTiming.sourceRevision, model.basis.sourceRevision);
        assert.equal(row.responseTiming.interactionRef, row.interactionRef);
        assert.equal(row.responseTiming.boundary, "recorded-request-to-final-answer");
        assert.equal(row.responseTiming.status, row.responseTiming.durationMs === null ? "unavailable" : "measured");
    }
    assert.equal(model.overview.metrics.find(metric => metric.definitionId === "recorded-response-duration").value, 1200);
    assert.deepEqual(state, before);
});

test("row timing stays unavailable for invalid response bounds, pruned membership and conflicting call identity", () => {
    for (const change of [
        record => { record.responseTiming.durationMs = -1; },
        record => { record.responseTiming.respondedAt = time(500); },
        record => { record.responseTiming.promptEventId = "another-prompt"; },
        record => { record.responseTiming.completedAt = null; },
        record => { record.assessmentMembershipPruned = true; },
    ]) {
        const record = fixture("unqualified-row-response");
        record.userPrompt = { ...record.userPrompt, sourceEventId: "prompt", sourceTimestamp: time(0) };
        record.responseTiming = recordedResponseTiming(source(), prompt);
        change(record);
        const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] });
        assert.equal(model.catalog[0].responseTiming?.status, "unavailable");
        assert.equal(model.catalog[0].responseTiming?.durationMs, null);
    }
    const records = ["a", "b"].map(id => {
        const record = fixture(`conflicted-${id}`);
        record.userPrompt = { ...record.userPrompt, sourceEventId: "prompt", sourceTimestamp: time(0) };
        record.responseTiming = recordedResponseTiming(source(), prompt);
        record.toolCalls[0].startEventId = "shared-start";
        return record;
    });
    const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] });
    assert.ok(model.catalog.every(row => row.status === "excluded"));
    assert.ok(model.catalog.every(row => row.responseTiming.status === "unavailable" && row.responseTiming.durationMs === null));
});

test("a grouped alias cannot borrow response timing from a differently timestamped prompt", () => {
    const first = fixture("timed-alias-a"), second = fixture("timed-alias-b");
    for (const record of [first, second]) {
        record.userPrompt = { ...record.userPrompt, sourceEventId: "prompt", sourceTimestamp: time(0) };
        record.responseTiming = recordedResponseTiming(source(), prompt);
    }
    second.userPrompt.sourceTimestamp = time(10);
    const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: [first, second], exports: [] });
    assert.equal(model.catalog[0].interactionRef, model.catalog[1].interactionRef);
    assert.equal(model.catalog[0].responseTiming.durationMs, 1200);
    assert.equal(model.catalog[1].responseTiming.durationMs, null);
});

test("actual collector projection retains only response metadata and extraction binds the full request", () => {
    const rows = source();
    rows.splice(1, 0, { id: "call-start", type: "tool.execution_start", timestamp: time(100),
        data: { toolCallId: "call", toolName: "workiq-fetch", arguments: { entityUrls: ["/me/messages"] } } },
    { id: "call-end", type: "tool.execution_complete", timestamp: time(300), data: { toolCallId: "call", success: true } });
    const diagnostics = { credentialExclusions: 0 };
    const retained = rows.map(event => retainEvent(event, diagnostics)).filter(Boolean);
    assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_FINAL_ANSWER|PRIVATE_REASONING/);
    const record = extractScenarios(retained, { sessionId: "source", name: "Synthetic" }, time(0), time(10000)).scenarios[0];
    assert.equal(record.responseTiming.durationMs, 1200);
    assert.equal(record.toolCalls[0].durationMs, 200);
    const late = structuredClone(record); late.responseTiming = { schemaVersion: 1, status: "unavailable", reason: "prompt-not-in-window" };
    assert.equal(mergedRecords([record], [late])[0].responseTiming.durationMs, 1200, "An evicted checkpoint cannot erase a completed durable timing.");
    late.responseTiming.reason = "later-work-after-final-response";
    assert.equal(mergedRecords([record], [late])[0].responseTiming.status, "unavailable", "Observed later work invalidates, rather than preserving, an obsolete final marker.");
});

test("source-event or partial membership deletion invalidates dependent response timing", () => {
    const record = fixture("delete-timing");
    record.userPrompt = { ...record.userPrompt, ...prompt };
    record.responseTiming = recordedResponseTiming(source(), prompt);
    const eventRemoved = filterDeletedRecords([record], { identities: [], events: [eventIdentity(record.sourceSessionId, "answer")] })[0];
    assert.equal(eventRemoved.responseTiming.status, "unavailable");
    const extra = { ...record.toolCalls[0], toolCallId: "survivor", startEventId: "survivor-start" };
    record.toolCalls.push(extra);
    const removed = recordUnits(record)[0].aliases;
    const partial = filterDeletedRecords([record], { identities: removed, events: [] })[0];
    assert.equal(partial.responseTiming.status, "unavailable");
    assert.equal(partial.toolCalls.length, 1);
});

test("bounded original metadata qualification respects source window, context limits and content exclusion", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-response-metadata-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessionId = randomUUID(), sessionRoot = path.join(root, "session-state");
    await mkdir(path.join(sessionRoot, sessionId), { recursive: true });
    const rows = source(), start = { id: "startup", type: "session.start", timestamp: time(0), data: { sessionId, version: 1 } };
    await writeFile(path.join(sessionRoot, sessionId, "events.jsonl"), [start, ...rows].map(event => JSON.stringify(event) + "\n").join(""));
    const record = { sourceSessionId: sessionId, userPrompt: prompt };
    const config = { approved: true, sessionRoot }, sourceInfo = { sessionId, eligible: true };
    const bounded = await qualifyRetainedResponseTimings(config, sourceInfo, [record], null, 1024, time(0));
    assert.equal(bounded.bytesRead, 0);
    assert.equal(bounded.checkpoint.status, "pending");
    const complete = await qualifyRetainedResponseTimings(config, sourceInfo, [record], bounded.checkpoint, 8 * 1024 ** 2, time(0));
    assert.equal(complete.checkpoint.timings.prompt.durationMs, 1200);
    assert.doesNotMatch(JSON.stringify(complete), /PRIVATE_FINAL_ANSWER|PRIVATE_REASONING|Private request/);
    const cached = await qualifyRetainedResponseTimings(config, sourceInfo, [record], complete.checkpoint, 8 * 1024 ** 2, time(0));
    assert.equal(cached.bytesRead, 0);
    const outside = await qualifyRetainedResponseTimings(config, sourceInfo, [record], null, 8 * 1024 ** 2, time(100));
    assert.deepEqual(outside.checkpoint.timings, {});
    assert.equal(outside.bytesRead, 0);
});
