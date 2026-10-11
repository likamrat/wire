import test from "node:test";
import assert from "node:assert/strict";
import { buildAssessmentModel, buildReportFacts, assertReportCurrent, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { fixture } from "./helpers.mjs";

test("synthetic: canonical real interaction has automatic narrow facts, unavailable quality and no Cost metric", () => {
    const record = fixture("assessment");
    record.userPrompt.sourceEventId = "synthetic-prompt";
    Object.assign(record.toolCalls[0], {
        completionEventId: "synthetic-end", startedAt: "2026-10-06T12:00:00.000Z",
        completedAt: "2026-10-06T12:00:01.000Z", durationMs: 1000,
    });

    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] };
    const model = buildAssessmentModel(state);
    assert.equal(model.catalog[0].status, "retained");
    const view = model.details.get(model.catalog[0].interactionRef);
    assert.equal(view.interaction.message.origin, "recorded-unverified");
    assert.equal(view.interaction.members.length, 2);
    assert.equal(view.metrics.find(m => m.definitionId === "tool-duration").value, 1000);
    for (const dimension of ["accuracy", "answer-trust", "action-trust"]) {
        assert.equal(view.assessments.find(a => a.dimension === dimension).verdict, "unassessed");
    }
    assert.equal(view.metrics.some(m => m.dimension === "cost"), false);
    assert.equal(view.consent.state, "off");
    assert.equal(state.personalEvaluation, undefined, "Reads never migrate consent or mutate stored evidence");
});

test("synthetic: multiple recorded group aliases for one source message retain all distinct calls once", () => {
    const a = fixture("a"), b = fixture("b");
    a.userPrompt.sourceEventId = b.userPrompt.sourceEventId = "same-recorded-message";
    const duplicate = { ...structuredClone(a), scenarioId: "legacy-alias", isLegacy: true };
    const state = { revision: 2, pseudonymKey: "b".repeat(64), evidence: [a, b, duplicate], exports: [] };
    const before = JSON.stringify(state);
    const model = buildAssessmentModel(state);
    assert.equal(model.details.size, 1);
    assert.equal(model.overview.interactionRefs.length, 1);
    assert.equal(model.catalog.length, 3);
    assert.equal(new Set(model.catalog.map(row => row.interactionRef)).size, 1);
    assert.equal([...model.details.values()][0].interaction.members.filter(m => m.kind === "tool-call").length, 2);
    assert.deepEqual(assessmentOverview(state, model, []), { interactionRefs: [], metrics: [], assessmentAttempts: [] });
    assert.equal(JSON.stringify(state), before);
});

test("unsupported check reasons survive interaction, pooled overview and frozen report facts", () => {
    const records = [fixture("reason-a"), fixture("reason-b")];
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] };
    const model = buildAssessmentModel(state);
    const report = buildReportFacts(records, state);
    for (const metrics of [...model.details.values()].map(view => view.metrics).concat([model.overview.metrics, report.facts.metrics])) {
        for (const dimension of ["accuracy", "answer-trust", "action-trust"]) {
            const metric = metrics.find(item => item.dimension === dimension);
            assert.equal(metric.reason, "unsupported-check", `${dimension} must explain the actual missing check`);
            assert.equal(metric.value, null);
            assert.equal(metric.coverage.covered, 0);
        }
    }
});

test("synthetic: report facts preserve exact recorded outcomes and freeze independently of source/feedback changes", () => {
    const a = fixture("report-a"), b = fixture("report-b");
    b.toolCalls[0].reportedOutcome = "partial"; b.toolCalls[0].toolSucceeded = null;
    const state = { revision: 4, pseudonymKey: "c".repeat(64), evidence: [a, b], exports: [] };
    const { facts, dependencies } = buildReportFacts(state.evidence, state, { preparedAt: "2026-10-06T12:00:00.000Z" });
    const bytes = JSON.stringify(facts);
    assert.deepEqual(facts.recordedOutcomes.filter(row => row.kind === "tool-call").map(row => row.outcome).sort(), ["partial", "success"]);
    assert.doesNotMatch(bytes, /SYNTHETIC_PRIVATE|email@example|sourceSessionId|test-session|SYNTHETIC_LITERAL/);
    assertReportCurrent(dependencies, state);
    state.revision++;
    assert.throws(() => assertReportCurrent(dependencies, state), /stale-sourceRevision/);
    assert.equal(JSON.stringify(facts), bytes);
});

test("synthetic: a start-event alias claimed by different calls is not a verified interaction membership", () => {
    const a = fixture("conflict-a"), b = fixture("conflict-b");
    a.toolCalls[0].startEventId = b.toolCalls[0].startEventId = "conflicted-start";
    const model = buildAssessmentModel({ revision: 1, pseudonymKey: "d".repeat(64), evidence: [a, b], exports: [] });
    assert.equal(model.details.size, 0);
    assert.ok(model.catalog.every(row => row.status === "excluded" && row.reason === "conflicting-membership"));
    const projected = buildReportFacts([a], { revision: 1, pseudonymKey: "d".repeat(64), evidence: [a, b], exports: [] });
    assert.equal(projected.facts.memberships.length, 0, "A selected subset cannot erase known alias conflicts");
});

test("synthetic: a verified selected report survives unrelated source growth but not changed selected evidence", () => {
    const selected = fixture("selected");
    const state = { revision: 1, pseudonymKey: "e".repeat(64), evidence: [selected], exports: [] };
    const { dependencies } = buildReportFacts([selected], state);
    state.evidence.push(fixture("unrelated")); state.revision++;
    assert.throws(() => assertReportCurrent(dependencies, state), /stale-sourceRevision/);
    assertReportCurrent(dependencies, state, { sourceContentVerified: true });
    selected.toolCalls[0].apiResults[0].statusCode = 429; state.revision++;
    assert.throws(() => assertReportCurrent(dependencies, state, { sourceContentVerified: true }), /stale-assessment-evidence/);
});

test("synthetic: repeated reported indices remain distinct canonical entries of a start-event-only call", () => {
    const record = fixture("start-only");
    delete record.toolCalls[0].toolCallId;
    record.toolCalls[0].apiResults = [{ ignored: true }, { index: 99, statusCode: 200 }, { index: 99, statusCode: 429 }, { index: 0 }];
    const state = { revision: 1, pseudonymKey: "f".repeat(64), evidence: [record], exports: [] };
    const before = JSON.stringify(record), model = buildAssessmentModel(state), detail = [...model.details.values()][0];
    const members = detail.interaction.members.filter(member => member.kind === "returned-api-entry");
    assert.deepEqual(members.map(member => member.responseIndex), [0, 1, 2], "Canonical eligible-row positions, never repeated source index literals, identify entries");
    assert.equal(new Set(members.map(member => member.ref)).size, 3);
    assert.equal(new Set(members.map(member => member.parentRef)).size, 1);
    assert.deepEqual(detail.observations.filter(row => row.kind === "returned-status").map(row => row.payload.statusCode), [200, 429, null]);
    const report = buildReportFacts([record], state);
    assert.equal(report.facts.recordedOutcomes.filter(row => row.kind === "returned-api-entry").length, 3);
    assert.equal(JSON.stringify(record), before, "Original returned index metadata stays unchanged");
});
